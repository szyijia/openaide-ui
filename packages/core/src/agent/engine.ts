/**
 * Agent 核心引擎（增强版）
 *
 * 参考 Claude Code: src/QueryEngine.ts + src/tasks/
 * 核心的 LLM 对话循环 —— 发送消息、处理工具调用、管理上下文
 *
 * 增强功能：
 * 1. 任务管理（TaskManager）— 跟踪 Agent 任务状态
 * 2. 生命周期钩子 — onStart, onToolCall, onToolResult, onComplete, onError
 * 3. 停止逻辑 — 优雅停止、强制停止、清理
 * 4. 上下文压缩 — 对话过长时自动压缩
 * 5. 工具调用重试 — 工具失败时可配置重试
 * 6. 消息历史管理 — 插入、删除、截断
 * 7. 流式进度报告
 */

import type { LLMProvider, ChatMessage, StreamEvent, ToolDefinition, TokenUsage, ContentBlock } from '../llm/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';
import type { MCPConnectionManager } from '../mcp/client.js';
import type { ContextManager } from '../context/manager.js';
import type { MemoryManager } from '../memory/manager.js';

// ─── 生命周期钩子类型 ───

/** 工具调用信息 */
export interface ToolCallInfo {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** 工具结果信息 */
export interface ToolResultInfo {
  id: string;
  name: string;
  content: string;
  isError: boolean;
  durationMs: number;
}

/** 生命周期钩子 */
export interface AgentLifecycleHooks {
  /** Agent 开始处理消息 */
  onStart?: (message: string) => void | Promise<void>;
  /** 工具调用前 */
  onToolCall?: (info: ToolCallInfo) => void | Promise<void>;
  /** 工具调用后 */
  onToolResult?: (info: ToolResultInfo) => void | Promise<void>;
  /** Agent 完成 */
  onComplete?: (usage: TokenUsage, messageCount: number) => void | Promise<void>;
  /** Agent 出错 */
  onError?: (error: Error) => void | Promise<void>;
  /** 每轮对话结束 */
  onRoundEnd?: (round: number, hasToolCalls: boolean) => void | Promise<void>;
  /** 上下文压缩触发 */
  onContextCompact?: (beforeCount: number, afterCount: number) => void | Promise<void>;
}

// ─── 任务管理 ───

/** 任务状态 */
export type TaskStatus = 'idle' | 'running' | 'paused' | 'stopping' | 'completed' | 'failed' | 'cancelled';

/** 任务信息 */
export interface TaskInfo {
  id: string;
  status: TaskStatus;
  startedAt?: Date;
  endedAt?: Date;
  currentRound: number;
  totalToolCalls: number;
  usage: TokenUsage;
  lastError?: string;
}

/**
 * 任务管理器
 * 跟踪 Agent 当前任务的状态
 */
export class TaskManager {
  private currentTask: TaskInfo | null = null;
  private taskHistory: TaskInfo[] = [];
  private nextId = 1;

  /** 创建新任务 */
  create(): TaskInfo {
    const task: TaskInfo = {
      id: `task_${this.nextId++}`,
      status: 'idle',
      currentRound: 0,
      totalToolCalls: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
    this.currentTask = task;
    return task;
  }

  /** 开始任务 */
  start(): void {
    if (this.currentTask) {
      this.currentTask.status = 'running';
      this.currentTask.startedAt = new Date();
    }
  }

  /** 更新轮次 */
  advanceRound(): void {
    if (this.currentTask) this.currentTask.currentRound++;
  }

  /** 记录工具调用 */
  recordToolCall(): void {
    if (this.currentTask) this.currentTask.totalToolCalls++;
  }

  /** 累加 token 用量 */
  addUsage(usage: TokenUsage): void {
    if (this.currentTask) {
      this.currentTask.usage.inputTokens += usage.inputTokens;
      this.currentTask.usage.outputTokens += usage.outputTokens;
    }
  }

  /** 完成任务 */
  complete(): void {
    if (this.currentTask) {
      this.currentTask.status = 'completed';
      this.currentTask.endedAt = new Date();
      this.taskHistory.push(this.currentTask);
      this.currentTask = null;
    }
  }

  /** 任务失败 */
  fail(error: string): void {
    if (this.currentTask) {
      this.currentTask.status = 'failed';
      this.currentTask.endedAt = new Date();
      this.currentTask.lastError = error;
      this.taskHistory.push(this.currentTask);
      this.currentTask = null;
    }
  }

  /** 取消任务 */
  cancel(): void {
    if (this.currentTask) {
      this.currentTask.status = 'cancelled';
      this.currentTask.endedAt = new Date();
      this.taskHistory.push(this.currentTask);
      this.currentTask = null;
    }
  }

  /** 获取当前任务 */
  getCurrent(): TaskInfo | null {
    return this.currentTask;
  }

  /** 获取任务历史 */
  getHistory(): ReadonlyArray<TaskInfo> {
    return this.taskHistory;
  }

  /** 是否正在运行 */
  get isRunning(): boolean {
    return this.currentTask?.status === 'running';
  }

  /** 是否正在停止 */
  get isStopping(): boolean {
    return this.currentTask?.status === 'stopping';
  }

  /** 请求停止 */
  requestStop(): void {
    if (this.currentTask?.status === 'running') {
      this.currentTask.status = 'stopping';
    }
  }
}

// ─── Agent 配置 ───

/** Agent 配置 */
export interface AgentConfig {
  /** LLM Provider 实例 */
  provider: LLMProvider;
  /** 工具注册表 */
  tools: ToolRegistry;
  /** System Prompt */
  systemPrompt: string;
  /** 最大工具调用轮数（防止无限循环） */
  maxToolRounds?: number;
  /** 工作目录 */
  cwd?: string;
  /** MCP 连接管理器（可选） */
  mcpManager?: MCPConnectionManager;
  /** 上下文管理器（可选） */
  contextManager?: ContextManager;
  /** 记忆管理器（可选） */
  memoryManager?: MemoryManager;
  /** 是否启用并行工具调用 */
  parallelToolCalls?: boolean;
  /** 工具权限审批回调（由 BridgeServer 注入） */
  askPermission?: (toolName: string, description: string) => Promise<boolean>;
  /** 生命周期钩子 */
  hooks?: AgentLifecycleHooks;
  /** 工具调用失败重试次数（默认 0） */
  toolRetries?: number;
  /** 上下文自动压缩阈值（消息数，默认不压缩） */
  autoCompactThreshold?: number;
}

// ─── Agent 事件 ───

/** Agent 事件 */
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; result: string; isError: boolean }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; totalUsage: TokenUsage }
  | { type: 'error'; error: Error }
  | { type: 'status'; status: TaskStatus; message?: string };

// ─── Agent Engine ───

/**
 * Agent 核心引擎（增强版）
 *
 * 实现 LLM 对话的核心循环：
 * 1. 构建 System Prompt（包含上下文、记忆、MCP 指令）
 * 2. 发送用户消息和上下文给 LLM
 * 3. 接收 LLM 回复（文本 + 工具调用）
 * 4. 如果有工具调用 → 执行工具 → 将结果反馈给 LLM → 回到步骤 3
 * 5. 如果没有工具调用 → 返回最终回复
 */
export class AgentEngine {
  private config: AgentConfig;
  private conversationHistory: ChatMessage[] = [];
  private totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  private taskManager = new TaskManager();
  private stopRequested = false;

  constructor(config: AgentConfig) {
    this.config = {
      maxToolRounds: 25,
      cwd: process.cwd(),
      parallelToolCalls: true,
      toolRetries: 0,
      ...config,
    };
  }

  /**
   * 构建完整的 System Prompt
   * 整合基础 prompt + 上下文 + 记忆 + MCP 指令
   */
  private async buildSystemPrompt(): Promise<string> {
    const parts: string[] = [this.config.systemPrompt];

    // 添加记忆摘要
    if (this.config.memoryManager) {
      try {
        const memorySummary = await this.config.memoryManager.getMemorySummary();
        if (memorySummary) {
          parts.push(`\n<memory>\n${memorySummary}\n</memory>`);
        }
      } catch {
        // 记忆加载失败不影响主流程
      }
    }

    // 添加上下文信息
    if (this.config.contextManager) {
      try {
        const contextInfo = await this.config.contextManager.buildContextPrompt();
        if (contextInfo) {
          parts.push(`\n<context>\n${contextInfo}\n</context>`);
        }
      } catch {
        // 上下文加载失败不影响主流程
      }
    }

    // 添加 MCP 服务器指令
    if (this.config.mcpManager) {
      const instructions = this.config.mcpManager.getInstructions();
      if (instructions.length > 0) {
        parts.push(`\n<mcp_instructions>\n${instructions.join('\n\n')}\n</mcp_instructions>`);
      }
    }

    return parts.join('\n');
  }

  /**
   * 获取所有可用的工具定义（内置工具 + MCP 工具）
   */
  private getAllToolDefinitions(): ToolDefinition[] {
    const defs: ToolDefinition[] = [...this.config.tools.getToolDefinitions()];

    // 添加 MCP 工具
    if (this.config.mcpManager) {
      const mcpTools = this.config.mcpManager.getAllTools();
      for (const tool of mcpTools) {
        defs.push({
          name: `mcp__${tool.serverName}__${tool.name}`,
          description: tool.description,
          inputSchema: tool.inputSchema as ToolDefinition['inputSchema'],
        });
      }
    }

    return defs;
  }

  /**
   * 解析 MCP 工具名称
   * 格式: mcp__<serverName>__<toolName>
   */
  private parseMCPToolName(name: string): { serverName: string; toolName: string } | null {
    if (!name.startsWith('mcp__')) return null;
    const parts = name.split('__');
    if (parts.length < 3) return null;
    return {
      serverName: parts[1]!,
      toolName: parts.slice(2).join('__'),
    };
  }

  /**
   * 执行单个工具调用（带重试）
   */
  private async executeToolCall(
    toolCall: { id: string; name: string; input: Record<string, unknown> },
    context: ToolContext,
  ): Promise<{ content: string; isError: boolean; durationMs: number }> {
    const startTime = performance.now();
    const maxRetries = this.config.toolRetries || 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // 检查是否是 MCP 工具
        const mcpInfo = this.parseMCPToolName(toolCall.name);
        if (mcpInfo && this.config.mcpManager) {
          const result = await this.config.mcpManager.callTool(
            mcpInfo.serverName,
            mcpInfo.toolName,
            toolCall.input,
            context.abortSignal,
          );
          return {
            content: result.content,
            isError: result.isError,
            durationMs: performance.now() - startTime,
          };
        }

        // 内置工具
        const result = await this.config.tools.execute(
          toolCall.name,
          toolCall.input,
          context,
        );
        return {
          content: result.content,
          isError: result.isError || false,
          durationMs: performance.now() - startTime,
        };
      } catch (error) {
        if (attempt < maxRetries) {
          // 指数退避重试
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
          continue;
        }
        return {
          content: `Error: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
          durationMs: performance.now() - startTime,
        };
      }
    }

    // 不应该到达这里
    return { content: 'Error: unexpected retry exhaustion', isError: true, durationMs: performance.now() - startTime };
  }

  /**
   * 请求停止当前任务
   * 会在下一个工具调用完成后优雅停止
   */
  requestStop(): void {
    this.stopRequested = true;
    this.taskManager.requestStop();
  }

  /**
   * 检查是否应该停止
   */
  private shouldStop(abortSignal?: AbortSignal): boolean {
    return this.stopRequested || (abortSignal?.aborted ?? false) || this.taskManager.isStopping;
  }

  /**
   * 安全调用钩子（钩子错误不影响主流程）
   */
  private async safeHook<T>(fn: (() => T | Promise<T>) | undefined): Promise<void> {
    if (!fn) return;
    try { await fn(); } catch { /* 钩子错误不影响主流程 */ }
  }

  /**
   * 处理用户消息 — 流式返回 Agent 事件
   */
  async *processMessage(
    userMessage: string,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    // 重置停止标志
    this.stopRequested = false;

    // 创建并启动任务
    const task = this.taskManager.create();
    this.taskManager.start();

    // 触发 onStart 钩子
    await this.safeHook(() => this.config.hooks?.onStart?.(userMessage));

    yield { type: 'status', status: 'running', message: `任务 ${task.id} 开始` };

    // 添加用户消息到历史
    this.conversationHistory.push({
      role: 'user',
      content: userMessage,
    });

    let toolRounds = 0;
    const maxRounds = this.config.maxToolRounds!;

    // 构建 System Prompt（包含上下文和记忆）
    let systemPrompt: string;
    try {
      systemPrompt = await this.buildSystemPrompt();
    } catch {
      systemPrompt = this.config.systemPrompt;
    }

    while (toolRounds < maxRounds) {
      // 检查是否应该停止
      if (this.shouldStop(abortSignal)) {
        this.taskManager.cancel();
        yield { type: 'status', status: 'cancelled', message: '任务被取消' };
        yield { type: 'done', totalUsage: this.totalUsage };
        return;
      }

      this.taskManager.advanceRound();

      // 自动上下文压缩
      if (this.config.autoCompactThreshold && this.conversationHistory.length > this.config.autoCompactThreshold) {
        await this.tryCompactContext();
      }

      // 获取所有工具定义（内置 + MCP）
      const toolDefs = this.getAllToolDefinitions();

      // 收集当前轮次的 LLM 输出
      const currentTextParts: string[] = [];
      const pendingToolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

      try {
        const stream = this.config.provider.chatStream({
          messages: this.conversationHistory,
          systemPrompt,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
        });

        const toolNameMap = new Map<string, string>();

        for await (const event of stream) {
          if (this.shouldStop(abortSignal)) break;

          switch (event.type) {
            case 'text_delta':
              currentTextParts.push(event.text);
              yield { type: 'text', text: event.text };
              break;

            case 'thinking_delta':
              yield { type: 'thinking', text: event.text };
              break;

            case 'tool_use_start':
              toolNameMap.set(event.id, event.name);
              break;

            case 'tool_use_end':
              pendingToolCalls.push({
                id: event.id,
                name: event.name ?? toolNameMap.get(event.id) ?? '',
                input: event.input,
              });
              break;

            case 'message_end':
              this.accumulateUsage(event.usage);
              this.taskManager.addUsage(event.usage);
              yield { type: 'usage', usage: event.usage };
              break;

            case 'error':
              yield { type: 'error', error: event.error };
              this.taskManager.fail(event.error.message);
              await this.safeHook(() => this.config.hooks?.onError?.(event.error));
              return;
          }
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        yield { type: 'error', error: err };
        this.taskManager.fail(err.message);
        await this.safeHook(() => this.config.hooks?.onError?.(err));
        return;
      }

      // ─── 构建 assistant 消息 ───
      // Anthropic API 要求 assistant 消息包含所有 content blocks（文本 + 工具调用）
      const assistantContentBlocks: ContentBlock[] = [];

      const fullText = currentTextParts.join('');
      if (fullText) {
        assistantContentBlocks.push({ type: 'text', text: fullText });
      }

      for (const tc of pendingToolCalls) {
        assistantContentBlocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.input,
        });
      }

      if (assistantContentBlocks.length > 0) {
        this.conversationHistory.push({
          role: 'assistant',
          content: assistantContentBlocks,
        });
      }

      // 触发 onRoundEnd 钩子
      await this.safeHook(() => this.config.hooks?.onRoundEnd?.(toolRounds, pendingToolCalls.length > 0));

      // 如果没有工具调用，对话结束
      if (pendingToolCalls.length === 0) {
        this.taskManager.complete();
        await this.safeHook(() => this.config.hooks?.onComplete?.(this.totalUsage, this.conversationHistory.length));
        yield { type: 'status', status: 'completed' };
        yield { type: 'done', totalUsage: this.totalUsage };
        return;
      }

      // 检查停止请求（在执行工具前）
      if (this.shouldStop(abortSignal)) {
        this.taskManager.cancel();
        yield { type: 'status', status: 'cancelled', message: '任务在工具执行前被取消' };
        yield { type: 'done', totalUsage: this.totalUsage };
        return;
      }

      // ─── 执行工具调用 ───
      toolRounds++;
      const toolContext: ToolContext = {
        cwd: this.config.cwd!,
        askPermission: this.config.askPermission || (async () => true),
        abortSignal: abortSignal || new AbortController().signal,
        log: (level, msg) => console.log(`[${level}] ${msg}`),
      };

      const canParallel = this.config.parallelToolCalls && pendingToolCalls.length > 1;

      if (canParallel) {
        // 并行执行：先发出所有 tool_call 事件
        for (const tc of pendingToolCalls) {
          yield { type: 'tool_call', id: tc.id, name: tc.name, input: tc.input };
          await this.safeHook(() => this.config.hooks?.onToolCall?.({ id: tc.id, name: tc.name, input: tc.input }));
          this.taskManager.recordToolCall();
        }

        // 并行执行所有工具
        const results = await Promise.allSettled(
          pendingToolCalls.map((tc) => this.executeToolCall(tc, toolContext)),
        );

        // 收集结果
        for (let i = 0; i < pendingToolCalls.length; i++) {
          const tc = pendingToolCalls[i]!;
          const settledResult = results[i]!;

          let content: string;
          let isError: boolean;
          let durationMs = 0;

          if (settledResult.status === 'fulfilled') {
            content = settledResult.value.content;
            isError = settledResult.value.isError;
            durationMs = settledResult.value.durationMs;
          } else {
            content = `Error: ${settledResult.reason instanceof Error ? settledResult.reason.message : String(settledResult.reason)}`;
            isError = true;
          }

          yield { type: 'tool_result', id: tc.id, name: tc.name, result: content, isError };
          await this.safeHook(() => this.config.hooks?.onToolResult?.({ id: tc.id, name: tc.name, content, isError, durationMs }));

          this.conversationHistory.push({
            role: 'tool',
            content: [{ type: 'tool_result', tool_use_id: tc.id, content, is_error: isError }],
          });
        }
      } else {
        // 串行执行工具调用
        for (const tc of pendingToolCalls) {
          // 每个工具调用前检查停止
          if (this.shouldStop(abortSignal)) {
            this.taskManager.cancel();
            yield { type: 'status', status: 'cancelled', message: '任务在工具执行中被取消' };
            yield { type: 'done', totalUsage: this.totalUsage };
            return;
          }

          yield { type: 'tool_call', id: tc.id, name: tc.name, input: tc.input };
          await this.safeHook(() => this.config.hooks?.onToolCall?.({ id: tc.id, name: tc.name, input: tc.input }));
          this.taskManager.recordToolCall();

          const { content, isError, durationMs } = await this.executeToolCall(tc, toolContext);

          yield { type: 'tool_result', id: tc.id, name: tc.name, result: content, isError };
          await this.safeHook(() => this.config.hooks?.onToolResult?.({ id: tc.id, name: tc.name, content, isError, durationMs }));

          this.conversationHistory.push({
            role: 'tool',
            content: [{ type: 'tool_result', tool_use_id: tc.id, content, is_error: isError }],
          });
        }
      }

      // 继续循环 —— 将工具结果反馈给 LLM
    }

    // 超过最大轮数
    const err = new Error(`Exceeded maximum tool rounds (${maxRounds})`);
    this.taskManager.fail(err.message);
    await this.safeHook(() => this.config.hooks?.onError?.(err));
    yield { type: 'error', error: err };
  }

  /**
   * 尝试压缩上下文
   * 当对话历史过长时，保留最近的消息，压缩较早的消息为摘要
   */
  private async tryCompactContext(): Promise<void> {
    if (!this.config.contextManager) return;

    try {
      const beforeCount = this.conversationHistory.length;
      const keepRecent = Math.min(10, Math.floor(beforeCount / 3));
      const toCompact = this.conversationHistory.slice(0, beforeCount - keepRecent);
      const kept = this.conversationHistory.slice(beforeCount - keepRecent);

      // 将需要压缩的消息转为文本摘要
      const compactText = toCompact.map(m => {
        if (typeof m.content === 'string') return `[${m.role}] ${m.content}`;
        return `[${m.role}] ${JSON.stringify(m.content).substring(0, 500)}`;
      }).join('\n');

      // 创建压缩摘要消息
      const summaryMessage: ChatMessage = {
        role: 'user',
        content: `[上下文摘要 — 以下是之前 ${toCompact.length} 条消息的压缩摘要]\n${compactText.substring(0, 2000)}`,
      };

      this.conversationHistory = [summaryMessage, ...kept];

      const afterCount = this.conversationHistory.length;
      await this.safeHook(() => this.config.hooks?.onContextCompact?.(beforeCount, afterCount));
    } catch {
      // 压缩失败不影响主流程
    }
  }

  // ─── 公共 API ───

  /** 获取对话历史 */
  getHistory(): ReadonlyArray<ChatMessage> {
    return this.conversationHistory;
  }

  /** 设置对话历史（用于恢复会话） */
  setHistory(history: ChatMessage[]): void {
    this.conversationHistory = [...history];
  }

  /** 清空对话历史 */
  clearHistory(): void {
    this.conversationHistory = [];
    this.totalUsage = { inputTokens: 0, outputTokens: 0 };
  }

  /** 获取总 token 用量 */
  getTotalUsage(): TokenUsage {
    return { ...this.totalUsage };
  }

  /** 获取对话消息数量 */
  getMessageCount(): number {
    return this.conversationHistory.length;
  }

  /** 更新 System Prompt */
  updateSystemPrompt(prompt: string): void {
    this.config.systemPrompt = prompt;
  }

  /** 更新配置 */
  updateConfig(updates: Partial<AgentConfig>): void {
    Object.assign(this.config, updates);
  }

  /** 获取任务管理器 */
  getTaskManager(): TaskManager {
    return this.taskManager;
  }

  /** 获取当前任务信息 */
  getCurrentTask(): TaskInfo | null {
    return this.taskManager.getCurrent();
  }

  /** 是否正在运行 */
  get isRunning(): boolean {
    return this.taskManager.isRunning;
  }

  /** 插入系统消息到对话历史 */
  insertSystemMessage(content: string): void {
    this.conversationHistory.push({
      role: 'user',
      content: `[系统消息] ${content}`,
    });
  }

  /** 截断对话历史到指定长度，返回被移除的消息数 */
  truncateHistory(maxMessages: number): number {
    if (this.conversationHistory.length <= maxMessages) return 0;
    const removed = this.conversationHistory.length - maxMessages;
    this.conversationHistory = this.conversationHistory.slice(-maxMessages);
    return removed;
  }

  private accumulateUsage(usage: TokenUsage): void {
    this.totalUsage.inputTokens += usage.inputTokens;
    this.totalUsage.outputTokens += usage.outputTokens;
    if (usage.cacheReadTokens) {
      this.totalUsage.cacheReadTokens = (this.totalUsage.cacheReadTokens || 0) + usage.cacheReadTokens;
    }
    if (usage.cacheCreationTokens) {
      this.totalUsage.cacheCreationTokens = (this.totalUsage.cacheCreationTokens || 0) + usage.cacheCreationTokens;
    }
    if (usage.totalCostUSD) {
      this.totalUsage.totalCostUSD = (this.totalUsage.totalCostUSD || 0) + usage.totalCostUSD;
    }
  }
}
