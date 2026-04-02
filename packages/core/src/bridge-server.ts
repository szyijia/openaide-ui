/**
 * Bridge Server — Agent Core 侧的通信服务端
 *
 * 当 Agent Core 作为 Extension 的子进程运行时，
 * 通过 stdio (stdin/stdout) 接收 JSON-RPC 2.0 请求，
 * 并将 Agent 事件作为通知推送给 Extension。
 *
 * 传输层设计：
 * - Extension → Core: 通过 stdin 逐行读取 JSON
 * - Core → Extension: 通过 stdout 写入 JSON + '\n'
 * - Core 日志: 通过 stderr 输出，不干扰协议通信
 *
 * 同时保留 IPC 模式向后兼容（当通过 fork() 启动时自动检测）。
 */

import { createInterface, type Interface as ReadlineInterface } from 'readline';
import type { AgentEngine, AgentEvent } from './agent/engine.js';
import { createProviderFromEnv } from './llm/factory.js';
import { ToolRegistry } from './tools/registry.js';
import { FileReadTool } from './tools/file-read.js';
import { FileWriteTool } from './tools/file-write.js';
import { FileEditTool } from './tools/file-edit.js';
import { GlobTool } from './tools/glob.js';
import { GrepTool } from './tools/grep.js';
import { BashTool } from './tools/bash.js';
import { WebFetchTool } from './tools/web-fetch.js';
import { WebSearchTool } from './tools/web-search.js';
import { createAgentTool } from './tools/agent.js';
import { buildSystemPrompt } from './prompts/system.js';
import { ContextManager } from './context/manager.js';
import { MemoryManager } from './memory/manager.js';
import { SessionManager } from './session/manager.js';
import { CompactService } from './context/compact.js';
import type { LLMProvider, ChatParams } from './llm/types.js';
import {
  Methods,
  PROTOCOL_VERSION,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type PingParams,
  type PongResult,
} from '@openaide/protocol';

// ─── 工具审批队列 ───

interface PendingApproval {
  toolCallId: string;
  toolName: string;
  description: string;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * ToolApprovalQueue — 管理工具调用的用户审批
 *
 * 当工具需要用户确认时，将请求放入队列，
 * 通过 Bridge 通知 Extension 显示审批 UI，
 * 等待用户批准或拒绝。
 */
class ToolApprovalQueue {
  private pending = new Map<string, PendingApproval>();
  private approvalTimeout: number;

  constructor(approvalTimeout = 60000) {
    this.approvalTimeout = approvalTimeout;
  }

  /**
   * 请求用户审批
   * 返回 Promise，在用户批准/拒绝/超时后 resolve
   */
  requestApproval(toolCallId: string, toolName: string, description: string): Promise<boolean> {
    return new Promise((resolve) => {
      // 设置超时自动拒绝
      const timer = setTimeout(() => {
        this.pending.delete(toolCallId);
        resolve(false);
      }, this.approvalTimeout);

      this.pending.set(toolCallId, {
        toolCallId,
        toolName,
        description,
        resolve,
        timer,
      });
    });
  }

  /** 批准工具调用 */
  approve(toolCallId: string): boolean {
    const entry = this.pending.get(toolCallId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(toolCallId);
    entry.resolve(true);
    return true;
  }

  /** 拒绝工具调用 */
  deny(toolCallId: string): boolean {
    const entry = this.pending.get(toolCallId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(toolCallId);
    entry.resolve(false);
    return true;
  }

  /** 清空所有待审批项（全部拒绝） */
  clear(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve(false);
    }
    this.pending.clear();
  }

  /** 获取待审批数量 */
  get size(): number {
    return this.pending.size;
  }
}

// ─── 配置管理 ───

/**
 * ConfigStore — 运行时配置管理
 *
 * 管理 Agent Core 的运行时配置，支持从 Extension 动态修改。
 */
class ConfigStore {
  private config = new Map<string, unknown>();

  constructor(defaults?: Record<string, unknown>) {
    if (defaults) {
      for (const [key, value] of Object.entries(defaults)) {
        this.config.set(key, value);
      }
    }
  }

  get<T = unknown>(key: string): T | undefined {
    return this.config.get(key) as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.config.set(key, value);
  }

  getAll(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of this.config) {
      result[key] = value;
    }
    return result;
  }
}

// ─── 编辑器上下文 ───

interface EditorContext {
  activeFile?: string;
  selection?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
    text: string;
  };
  openFiles: string[];
  workspaceFolders: string[];
}

/** 传输模式：IPC (fork) 或 stdio (spawn) */
type TransportMode = 'ipc' | 'stdio';

/**
 * BridgeServer — Core 侧的通信服务
 *
 * 自动检测传输模式：
 * - 如果 process.send 存在（通过 fork() 启动），使用 IPC 模式
 * - 否则使用 stdio 模式（stdin/stdout），兼容任意语言的 Extension
 */
class BridgeServer {
  private engine: AgentEngine | null = null;
  private abortController: AbortController | null = null;
  private cwd: string;
  private conversationId = 'default';
  private approvalQueue = new ToolApprovalQueue();
  private configStore: ConfigStore;
  private editorContext: EditorContext = { openFiles: [], workspaceFolders: [] };
  private contextManager: ContextManager | null = null;
  private memoryManager: MemoryManager | null = null;
  private provider: LLMProvider | null = null;
  private tools: ToolRegistry | null = null;
  private completionRequestId = 0;
  private sessionManager: SessionManager;
  private compactService: CompactService | null = null;
  private transport: TransportMode;
  private readline: ReadlineInterface | null = null;

  constructor() {
    this.cwd = process.cwd();
    this.configStore = new ConfigStore({
      model: process.env.OPENAIDE_MODEL || 'claude-sonnet-4-20250514',
      provider: process.env.OPENAIDE_PROVIDER || 'anthropic',
      maxToolRounds: 25,
      parallelToolCalls: true,
      'completion.enabled': true,
      'completion.model': process.env.OPENAIDE_COMPLETION_MODEL || '',
    });
    this.sessionManager = new SessionManager({ projectCwd: this.cwd });

    // 自动检测传输模式：process.send 存在说明是 fork() 启动的
    this.transport = typeof process.send === 'function' ? 'ipc' : 'stdio';
  }

  /**
   * 启动 Bridge Server
   */
  async start(): Promise<void> {
    // 根据传输模式监听来自 Extension 的消息
    if (this.transport === 'ipc') {
      // IPC 模式：通过 process.on('message') 接收
      process.on('message', (msg: unknown) => {
        this.handleMessage(msg as JsonRpcRequest | JsonRpcNotification);
      });
    } else {
      // stdio 模式：通过 readline 逐行读取 stdin
      this.readline = createInterface({
        input: process.stdin,
        crlfDelay: Infinity,
      });

      this.readline.on('line', (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const msg = JSON.parse(trimmed) as JsonRpcRequest | JsonRpcNotification;
          this.handleMessage(msg);
        } catch (err) {
          this.log('warn', `忽略非 JSON 输入: ${trimmed.slice(0, 100)}`);
        }
      });

      this.readline.on('close', () => {
        this.log('info', 'stdin 已关闭，准备退出...');
        process.exit(0);
      });
    }

    // 尝试初始化 Agent Engine
    try {
      await this.initEngine();
      // 通知 Extension 已就绪
      this.notify(Methods.STATUS_UPDATE, { state: 'idle', message: 'Agent Core 已就绪' });
      this.log('info', `Agent Core 已启动 (${this.transport} 模式)，等待 Extension 消息...`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.log('warn', `Engine 初始化失败（等待配置）: ${errMsg}`);
      // 通知 Extension 需要配置，但不退出进程
      this.notify(Methods.STATUS_UPDATE, {
        state: 'error',
        message: `需要配置 API Key: ${errMsg}`,
      });
    }
  }

  /**
   * 初始化 Agent Engine
   */
  private async initEngine(): Promise<void> {
    const { AgentEngine } = await import('./agent/engine.js');

    // 创建 LLM Provider
    this.provider = createProviderFromEnv();

    // 初始化上下文压缩服务
    this.compactService = new CompactService(this.provider);

    // 注册工具
    this.tools = new ToolRegistry();
    this.tools.register(FileReadTool);
    this.tools.register(FileWriteTool);
    this.tools.register(FileEditTool);
    this.tools.register(GlobTool);
    this.tools.register(GrepTool);
    this.tools.register(BashTool);
    this.tools.register(WebFetchTool);
    this.tools.register(WebSearchTool);

    // AgentTool 需要延迟初始化（依赖 provider 和 tools）
    // 在 Engine 创建后注册

    // 初始化上下文管理器
    this.contextManager = new ContextManager({ cwd: this.cwd });

    // 初始化记忆管理器
    this.memoryManager = new MemoryManager({ projectCwd: this.cwd });
    // 确保记忆目录存在（loadAll 会自动处理）

    // 构建 System Prompt
    const systemPrompt = buildSystemPrompt({
      cwd: this.cwd,
      model: this.provider.model,
      toolNames: this.tools.getAll().map((t) => t.name),
    });

    // 创建 Agent Engine（集成上下文、记忆和权限审批）
    this.engine = new AgentEngine({
      provider: this.provider,
      tools: this.tools,
      systemPrompt,
      cwd: this.cwd,
      contextManager: this.contextManager,
      memoryManager: this.memoryManager,
      parallelToolCalls: this.configStore.get<boolean>('parallelToolCalls') ?? true,
      maxToolRounds: this.configStore.get<number>('maxToolRounds') ?? 25,
      askPermission: async (toolName: string, description: string) => {
        // 生成唯一的审批 ID
        const approvalId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        // 通知 Extension 显示审批 UI
        this.notify('tool/requestApproval', {
          toolCallId: approvalId,
          toolName,
          description,
          conversationId: this.conversationId,
        });

        // 等待用户审批（通过审批队列）
        return this.approvalQueue.requestApproval(approvalId, toolName, description);
      },
    });

    // 注册 AgentTool（需要在 Engine 创建后，因为依赖 provider 和 tools）
    const agentTool = createAgentTool(() => ({
      provider: this.provider!,
      tools: this.tools!,
      systemPrompt,
      cwd: this.cwd,
      maxToolRounds: 15,
    }));
    this.tools.register(agentTool);
  }

  /**
   * 处理来自 Extension 的消息
   */
  private async handleMessage(msg: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    // 通知消息（无 id）
    if (!('id' in msg) || msg.id === undefined) {
      this.handleNotification(msg as JsonRpcNotification);
      return;
    }

    // 请求消息（有 id，需要响应）
    const request = msg as JsonRpcRequest;
    try {
      const result = await this.handleRequest(request.method, request.params);
      this.respond(request.id, result);
    } catch (error) {
      this.respondError(request.id, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 处理请求
   */
  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case Methods.PING:
        return this.handlePing(params as PingParams | undefined);

      case Methods.CHAT_SEND:
        return this.handleChatSend(params as { message: string; conversationId?: string });

      case Methods.CHAT_CANCEL:
        return this.handleChatCancel();

      case Methods.CHAT_CLEAR:
        return this.handleChatClear();

      case Methods.TOOL_APPROVE:
        return this.handleToolApprove(params as { toolCallId: string });

      case Methods.TOOL_DENY:
        return this.handleToolDeny(params as { toolCallId: string; reason?: string });

      case Methods.CONFIG_SET:
        return this.handleConfigSet(params as { key: string; value: unknown });

      case Methods.CONFIG_GET:
        return this.handleConfigGet(params as { key: string });

      case Methods.COMPLETION_REQUEST:
        return this.handleCompletionRequest(params as {
          file: string;
          position: { line: number; character: number };
          prefix: string;
          suffix: string;
          language: string;
        });

      case Methods.SESSION_CREATE:
        return this.handleSessionCreate();

      case Methods.SESSION_LIST:
        return this.handleSessionList();

      case Methods.SESSION_SWITCH:
        return this.handleSessionSwitch(params as { sessionId: string });

      case Methods.SESSION_DELETE:
        return this.handleSessionDelete(params as { sessionId: string });

      default:
        throw new Error(`未知方法: ${method}`);
    }
  }

  /**
   * 处理通知
   */
  private handleNotification(msg: JsonRpcNotification): void {
    switch (msg.method) {
      case Methods.CONTEXT_UPDATE:
        this.handleContextUpdate(msg.params as EditorContext);
        break;

      default:
      this.log('warn', `未知通知: ${msg.method}`);
    }
  }

  // ─── 健康检查 ───

  /**
   * 处理 ping 请求 — 返回 Core 的版本、运行时和状态
   */
  private handlePing(params?: PingParams): PongResult {
    return {
      timestamp: params?.timestamp,
      version: PROTOCOL_VERSION,
      runtime: 'typescript',
      status: this.engine ? 'ready' : 'initializing',
      message: this.engine ? undefined : 'Engine 尚未初始化，等待 API Key 配置',
    };
  }

  // ─── 工具审批处理 ───

  /**
   * 批准工具调用
   */
  private handleToolApprove(params: { toolCallId: string }): { ok: boolean } {
    const found = this.approvalQueue.approve(params.toolCallId);
    return { ok: found };
  }

  /**
   * 拒绝工具调用
   */
  private handleToolDeny(params: { toolCallId: string; reason?: string }): { ok: boolean } {
    const found = this.approvalQueue.deny(params.toolCallId);
    return { ok: found };
  }

  // ─── 配置管理 ───

  /**
   * 设置配置项
   */
  private handleConfigSet(params: { key: string; value: unknown }): { ok: true } {
    this.configStore.set(params.key, params.value);

    // 处理 API Key 配置 — 设置环境变量并尝试初始化 Engine
    if (params.key.endsWith('_API_KEY') || params.key === 'apiKey') {
      // 将 API Key 设置到环境变量
      const envKey = params.key.endsWith('_API_KEY') ? params.key : 'ANTHROPIC_API_KEY';
      process.env[envKey] = params.value as string;

      // 如果 Engine 尚未初始化，尝试重新初始化
      if (!this.engine) {
        this.initEngine().then(() => {
          this.notify(Methods.STATUS_UPDATE, { state: 'idle', message: 'Agent Core 已就绪' });
          this.log('info', 'API Key 已配置，Engine 初始化成功');
        }).catch((err) => {
          this.log('warn', `Engine 重新初始化失败: ${err}`);
        });
      }
    }

    // 处理自定义模型配置
    if (params.key === 'CUSTOM_BASE_URL') {
      process.env.CUSTOM_BASE_URL = params.value as string;
    }
    if (params.key === 'CUSTOM_MODEL') {
      process.env.CUSTOM_MODEL = params.value as string;
    }

    // 处理特殊配置变更
    if (params.key === 'model' && this.engine) {
      // 模型切换需要重新创建 Provider
      this.handleModelSwitch(params.value as string);
    }

    if (params.key === 'maxToolRounds' && this.engine) {
      this.engine.updateConfig({ maxToolRounds: params.value as number });
    }

    if (params.key === 'parallelToolCalls' && this.engine) {
      this.engine.updateConfig({ parallelToolCalls: params.value as boolean });
    }

    return { ok: true };
  }

  /**
   * 获取配置项
   */
  private handleConfigGet(params: { key: string }): unknown {
    return this.configStore.get(params.key) ?? null;
  }

  /**
   * 处理模型切换
   */
  private async handleModelSwitch(modelId: string): Promise<void> {
    try {
      // 解析 provider/model 格式
      const [providerName, ...modelParts] = modelId.split('/');
      const modelName = modelParts.join('/') || modelId;

      // 设置环境变量以便 factory 使用
      if (providerName) {
        process.env.OPENAIDE_PROVIDER = providerName;
      }
      process.env.OPENAIDE_MODEL = modelName;

      // 重新创建 Provider
      const newProvider = createProviderFromEnv();
      this.provider = newProvider;

      // 更新 Engine
      if (this.engine) {
        this.engine.updateConfig({ provider: newProvider });

        // 重新构建 System Prompt
        const systemPrompt = buildSystemPrompt({
          cwd: this.cwd,
          model: newProvider.model,
          toolNames: this.tools?.getAll().map((t) => t.name) || [],
        });
        this.engine.updateSystemPrompt(systemPrompt);
      }

      this.log('info', `模型已切换到: ${modelId}`);
    } catch (error) {
      this.log('error', `模型切换失败: ${error}`);
    }
  }

  // ─── 上下文管理 ───

  /**
   * 处理编辑器上下文更新
   */
  private handleContextUpdate(context: EditorContext): void {
    this.editorContext = context;

    // 将编辑器上下文传递给 ContextManager
    if (this.contextManager) {
      this.contextManager.updateEditorState({
        activeFile: context.activeFile,
        openFiles: context.openFiles,
        selection: context.selection,
        workspaceFolders: context.workspaceFolders,
      });
    }
  }

  // ─── 代码补全 ───

  /**
   * 处理代码补全请求
   */
  private async handleCompletionRequest(params: {
    file: string;
    position: { line: number; character: number };
    prefix: string;
    suffix: string;
    language: string;
  }): Promise<{ ok: true }> {
    const requestId = String(++this.completionRequestId);

    // 异步处理补全（不阻塞响应）
    this.processCompletionAsync(requestId, params);

    return { ok: true };
  }

  /**
   * 异步处理代码补全
   */
  private async processCompletionAsync(
    requestId: string,
    params: {
      file: string;
      position: { line: number; character: number };
      prefix: string;
      suffix: string;
      language: string;
    },
  ): Promise<void> {
    try {
      if (!this.provider) {
        this.notify(Methods.COMPLETION_RESULT, { requestId, completions: [] });
        return;
      }

      // 构建补全 prompt
      const completionPrompt = this.buildCompletionPrompt(params);

      // 使用 LLM 生成补全
      const response = await this.provider.chat({
        messages: [{ role: 'user', content: completionPrompt }],
        systemPrompt: `你是一个代码补全助手。根据给定的代码上下文，生成最可能的代码补全。
只输出补全的代码，不要包含任何解释、注释或 Markdown 格式。
如果无法确定合适的补全，返回空字符串。`,
        maxTokens: 256,
        temperature: 0.1,
      });

      // 提取补全文本
      const completionText = response.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('');

      if (completionText.trim()) {
        this.notify(Methods.COMPLETION_RESULT, {
          requestId,
          completions: [
            {
              text: completionText,
              range: {
                start: params.position,
                end: params.position,
              },
            },
          ],
        });
      } else {
        this.notify(Methods.COMPLETION_RESULT, { requestId, completions: [] });
      }
    } catch (error) {
      this.log('error', `补全请求失败: ${error}`);
      this.notify(Methods.COMPLETION_RESULT, { requestId, completions: [] });
    }
  }

  /**
   * 构建代码补全 prompt
   */
  private buildCompletionPrompt(params: {
    file: string;
    position: { line: number; character: number };
    prefix: string;
    suffix: string;
    language: string;
  }): string {
    return `请补全以下 ${params.language} 代码。光标位置用 <CURSOR> 标记。

文件: ${params.file}

\`\`\`${params.language}
${params.prefix}<CURSOR>${params.suffix}
\`\`\`

请只输出光标处应该补全的代码（不要重复已有的代码）:`;
  }

  /**
   * 处理用户消息 — 启动 Agent 对话循环
   */
  private async handleChatSend(params: { message: string; conversationId?: string }): Promise<{ ok: true }> {
    if (!this.engine) {
      throw new Error('Agent Engine 未初始化');
    }

    // 如果显式传入了 conversationId，使用它；否则保留当前会话 ID
    if (params.conversationId) {
      this.conversationId = params.conversationId;
    }

    // 如果还没有有效的会话（首次对话），自动创建一个
    if (!this.conversationId || this.conversationId === 'default') {
      const session = await this.sessionManager.create(this.provider?.model);
      this.conversationId = session.id;
    }

    // 取消之前的请求
    this.abortController?.abort();
    this.approvalQueue.clear();
    this.abortController = new AbortController();

    // 通知状态变更
    this.notify(Methods.STATUS_UPDATE, { state: 'thinking' });

    // 异步处理（不阻塞响应）
    this.processMessageAsync(params.message, this.abortController.signal);

    return { ok: true };
  }

  /**
   * 异步处理用户消息
   */
  private async processMessageAsync(message: string, signal: AbortSignal): Promise<void> {
    try {
      // 对话前检查是否需要上下文压缩
      if (this.compactService && this.engine) {
        const history = this.engine.getHistory();
        if (this.compactService.shouldCompact(history)) {
          this.notify(Methods.STATUS_UPDATE, { state: 'thinking', message: '正在压缩上下文...' });
          const result = await this.compactService.autoCompact(history);
          if (result.compacted) {
            this.engine.setHistory(result.messages);
          }
        }
      }

      for await (const event of this.engine!.processMessage(message, signal)) {
        if (signal.aborted) break;
        this.forwardAgentEvent(event);
      }

      // 对话完成后自动保存会话
      await this.saveCurrentSession();
    } catch (error) {
      this.notify(Methods.CHAT_ERROR, {
        conversationId: this.conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * 将 Agent 事件转发为 JSON-RPC 通知
   */
  private forwardAgentEvent(event: AgentEvent): void {
    const cid = this.conversationId;

    switch (event.type) {
      case 'text':
        this.notify(Methods.STATUS_UPDATE, { state: 'streaming' });
        this.notify(Methods.CHAT_TEXT, { text: event.text, conversationId: cid });
        break;

      case 'thinking':
        this.notify(Methods.CHAT_THINKING, { text: event.text, conversationId: cid });
        break;

      case 'tool_call':
        this.notify(Methods.STATUS_UPDATE, { state: 'tool_calling', message: event.name });
        this.notify(Methods.CHAT_TOOL_CALL, {
          id: event.id,
          name: event.name,
          input: event.input,
          conversationId: cid,
        });

        // 检测文件操作，提前通知 Extension 准备 Diff 预览
        this.detectFileOperation(event.name, event.input);
        break;

      case 'tool_result':
        this.notify(Methods.CHAT_TOOL_RESULT, {
          id: event.id,
          name: event.name,
          content: event.result,
          isError: event.isError,
          conversationId: cid,
        });
        break;

      case 'usage':
        // Token 用量更新
        break;

      case 'done':
        this.notify(Methods.CHAT_DONE, {
          conversationId: cid,
          usage: event.totalUsage,
        });
        this.notify(Methods.STATUS_UPDATE, { state: 'idle' });
        break;

      case 'error':
        this.notify(Methods.CHAT_ERROR, {
          conversationId: cid,
          error: event.error.message,
        });
        this.notify(Methods.STATUS_UPDATE, { state: 'error', message: event.error.message });
        break;
    }
  }

  /**
   * 检测文件操作，通知 Extension 进行 Diff 预览
   *
   * 当工具执行文件编辑/写入时，读取原始内容并发送给 Extension，
   * 以便 Extension 在 Diff Editor 中展示变更预览。
   */
  private async detectFileOperation(toolName: string, input: Record<string, unknown>): Promise<void> {
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');

      if (toolName === 'file_edit') {
        // 文件编辑 — 发送原始内容和预期新内容
        const filePath = input.file_path as string;
        const oldString = input.old_string as string;
        const newString = input.new_string as string;

        if (!filePath || !oldString) return;

        const resolvedPath = path.default.isAbsolute(filePath)
          ? filePath
          : path.default.resolve(this.cwd, filePath);

        const originalContent = await fs.default.readFile(resolvedPath, 'utf-8');
        const newContent = originalContent.replace(oldString, newString);

        if (originalContent !== newContent) {
          this.notify(Methods.FILE_EDIT, {
            path: resolvedPath,
            originalContent,
            newContent,
            description: `file_edit: 替换 ${oldString.split('\n').length} 行`,
          });
        }
      } else if (toolName === 'file_write') {
        // 文件写入 — 检查是新建还是覆盖
        const filePath = input.file_path as string;
        const content = input.content as string;

        if (!filePath || !content) return;

        const resolvedPath = path.default.isAbsolute(filePath)
          ? filePath
          : path.default.resolve(this.cwd, filePath);

        try {
          const originalContent = await fs.default.readFile(resolvedPath, 'utf-8');
          // 文件已存在 — 发送 Diff
          if (originalContent !== content) {
            this.notify(Methods.FILE_EDIT, {
              path: resolvedPath,
              originalContent,
              newContent: content,
              description: `file_write: 覆盖文件`,
            });
          }
        } catch {
          // 文件不存在 — 发送创建通知
          this.notify(Methods.FILE_CREATE, {
            path: resolvedPath,
            content,
          });
        }
      }
    } catch (error) {
      // 文件操作检测失败不影响主流程
      this.log('warn', `文件操作检测失败: ${error}`);
    }
  }

  /**
   * 取消当前对话
   */
  private handleChatCancel(): { ok: true } {
    this.abortController?.abort();
    this.approvalQueue.clear();
    this.notify(Methods.STATUS_UPDATE, { state: 'idle' });
    return { ok: true };
  }

  /**
   * 清空对话历史
   */
  private handleChatClear(): { ok: true } {
    this.engine?.clearHistory();
    this.approvalQueue.clear();
    return { ok: true };
  }

  // ─── 会话管理 ───

  /**
   * 创建新会话
   */
  private async handleSessionCreate(): Promise<{ sessionId: string; title: string }> {
    // 保存当前会话
    await this.saveCurrentSession();

    // 创建新会话
    const session = await this.sessionManager.create(this.provider?.model);
    this.conversationId = session.id;

    // 清空 Engine 历史
    this.engine?.clearHistory();

    return { sessionId: session.id, title: session.title };
  }

  /**
   * 列出所有会话
   */
  private async handleSessionList(): Promise<{ sessions: unknown[] }> {
    const sessions = await this.sessionManager.list();
    return { sessions };
  }

  /**
   * 切换到指定会话
   */
  private async handleSessionSwitch(params: { sessionId: string }): Promise<{ ok: boolean; title?: string; messages?: unknown[] }> {
    // 保存当前会话
    await this.saveCurrentSession();

    // 加载目标会话
    const session = await this.sessionManager.switchTo(params.sessionId);
    if (!session) {
      return { ok: false };
    }

    this.conversationId = session.id;

    // 恢复 Engine 历史
    if (this.engine) {
      this.engine.clearHistory();
      this.engine.setHistory(session.messages);
    }

    return { ok: true, title: session.title, messages: session.messages };
  }

  /**
   * 删除会话
   */
  private async handleSessionDelete(params: { sessionId: string }): Promise<{ ok: boolean }> {
    const ok = await this.sessionManager.delete(params.sessionId);
    return { ok };
  }

  /**
   * 保存当前会话到磁盘
   */
  private async saveCurrentSession(): Promise<void> {
    if (!this.engine || !this.conversationId) return;

    const history = this.engine.getHistory();
    if (history.length === 0) return;

    // 确保会话存在
    let session = await this.sessionManager.load(this.conversationId);
    if (!session) {
      session = await this.sessionManager.create(this.provider?.model);
      this.conversationId = session.id;
    }

    await this.sessionManager.updateMessages(this.conversationId, [...history]);

    const usage = this.engine.getTotalUsage();
    await this.sessionManager.updateUsage(this.conversationId, {
      totalTokens: usage.inputTokens + usage.outputTokens,
      totalCostUSD: usage.totalCostUSD,
      model: this.provider?.model,
    });
  }

  // ─── 通信方法（自动适配 IPC / stdio） ───

  /**
   * 发送消息到 Extension
   *
   * - IPC 模式: process.send(obj)
   * - stdio 模式: process.stdout.write(JSON + '\n')
   */
  private send(msg: object): void {
    if (this.transport === 'ipc') {
      process.send?.(msg);
    } else {
      process.stdout.write(JSON.stringify(msg) + '\n');
    }
  }

  /** 发送 JSON-RPC 响应 */
  private respond(id: number | string, result: unknown): void {
    this.send({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  /** 发送 JSON-RPC 错误响应 */
  private respondError(id: number | string, message: string, code = -32000): void {
    this.send({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
  }

  /** 发送 JSON-RPC 通知 */
  private notify(method: string, params: unknown): void {
    this.send({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  /**
   * 日志输出（始终写入 stderr，避免污染 stdout 协议通道）
   */
  private log(level: 'info' | 'warn' | 'error', message: string): void {
    const prefix = `[BridgeServer]`;
    process.stderr.write(`${prefix} ${level.toUpperCase()}: ${message}\n`);
  }
}

// ─── 入口 ───

// 仅在作为子进程运行时启动（通过 --bridge 参数判断）
if (process.argv.includes('--bridge')) {
  const server = new BridgeServer();
  server.start().catch((err) => {
    process.stderr.write(`[BridgeServer] 启动失败: ${err}\n`);
    process.exit(1);
  });
}

export { BridgeServer, ToolApprovalQueue, ConfigStore };
