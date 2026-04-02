/**
 * Agent Bridge — Extension 与 Agent Core 之间的通信桥接
 *
 * 通过 child_process (spawn) 启动 Agent Core 进程，
 * 使用 JSON-RPC 2.0 over stdio (stdin/stdout) 进行双向通信。
 *
 * 传输层设计：
 * - Extension → Core: 通过 stdin 写入 JSON + '\n'
 * - Core → Extension: 通过 stdout 逐行读取 JSON
 * - Core 日志: 通过 stderr 输出，不干扰协议通信
 *
 * 这种设计使得 Core 可以用任意语言实现（TypeScript/Go/Rust/Python），
 * 只要遵循 JSON-RPC 2.0 over stdio 协议即可。
 */

import { ChildProcess, spawn } from 'child_process';
import { createInterface, Interface as ReadlineInterface } from 'readline';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as vscode from 'vscode';
import type {
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcMessage,
  ChatSendParams,
  ChatCancelParams,
  ToolApproveParams,
  ToolDenyParams,
  ContextUpdateParams,
  ConfigSetParams,
  CompletionRequestParams,
  ChatTextNotification,
  ChatThinkingNotification,
  ToolCallNotification,
  ToolResultNotification,
  ChatDoneNotification,
  ChatErrorNotification,
  FileEditNotification,
  FileCreateNotification,
  StatusUpdateNotification,
  CompletionResultNotification,
  ToolApprovalRequestNotification,
  PingParams,
  PongResult,
} from './protocol.js';
import { Methods } from './protocol.js';

/** Bridge 事件类型 */
export interface BridgeEvents {
  'chat:text': (data: ChatTextNotification) => void;
  'chat:thinking': (data: ChatThinkingNotification) => void;
  'chat:toolCall': (data: ToolCallNotification) => void;
  'chat:toolResult': (data: ToolResultNotification) => void;
  'chat:done': (data: ChatDoneNotification) => void;
  'chat:error': (data: ChatErrorNotification) => void;
  'file:edit': (data: FileEditNotification) => void;
  'file:create': (data: FileCreateNotification) => void;
  'status:update': (data: StatusUpdateNotification) => void;
  'completion:result': (data: CompletionResultNotification) => void;
  'tool:approvalRequest': (data: ToolApprovalRequestNotification) => void;
  'connected': () => void;
  'disconnected': (code: number | null) => void;
  'error': (error: Error) => void;
}

/** Bridge 配置 */
export interface BridgeConfig {
  /** Agent Core 可执行文件路径（可以是 JS 脚本、Go/Rust 二进制等） */
  corePath?: string;
  /** 启动 Core 的命令（如 'node'、'python'、自定义二进制路径）。为空时自动检测 */
  coreCommand?: string;
  /** 传递给 Core 进程的额外参数 */
  coreArgs?: string[];
  /** 工作目录 */
  cwd?: string;
  /** 环境变量 */
  env?: Record<string, string>;
  /** 请求超时（毫秒） */
  requestTimeout?: number;
}

/**
 * AgentBridge — Extension 侧的通信桥接
 *
 * 职责：
 * 1. 管理 Agent Core 子进程的生命周期
 * 2. 通过 stdio 发送 JSON-RPC 请求到 Core
 * 3. 通过 stdio 接收 Core 的通知并分发事件
 * 4. 处理请求/响应的匹配和超时
 */
export class AgentBridge extends EventEmitter {
  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private requestId = 0;
  private pendingRequests = new Map<
    number | string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private config: Required<BridgeConfig>;
  private _isConnected = false;
  private outputChannel: vscode.OutputChannel;

  constructor(config: BridgeConfig = {}) {
    super();
    this.config = {
      corePath: config.corePath || '',
      coreCommand: config.coreCommand || '',
      coreArgs: config.coreArgs || [],
      cwd: config.cwd || process.cwd(),
      env: config.env || {},
      requestTimeout: config.requestTimeout || 30000,
    };
    // 创建 Output Channel，用户可在 VSCode Output 面板中查看 Bridge 日志
    this.outputChannel = vscode.window.createOutputChannel('OpenAIDE Bridge');
  }

  /** 写入日志到 Output Channel 和 console */
  private log(message: string): void {
    const timestamp = new Date().toISOString().slice(11, 23);
    const line = `[${timestamp}] ${message}`;
    this.outputChannel.appendLine(line);
    console.log(`[Bridge] ${message}`);
  }

  /** 写入错误日志 */
  private logError(message: string): void {
    const timestamp = new Date().toISOString().slice(11, 23);
    const line = `[${timestamp}] ❌ ${message}`;
    this.outputChannel.appendLine(line);
    console.error(`[Bridge] ${message}`);
  }

  /** 是否已连接 */
  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * 启动 Agent Core 子进程并建立 stdio 通信
   */
  async start(): Promise<void> {
    if (this.process) {
      throw new Error('Agent Core 进程已在运行');
    }

    return new Promise((resolve, reject) => {
      try {
        // 解析启动命令和参数
        const { command, args } = this.resolveCoreCommand();

        this.log(`启动 Agent Core: ${command} ${args.join(' ')}`);
        this.log(`工作目录: ${this.config.cwd}`);
        // 记录环境变量（隐藏 API Key 值）
        const envKeys = Object.keys(this.config.env).filter(k => this.config.env[k]);
        if (envKeys.length > 0) {
          this.log(`环境变量: ${envKeys.map(k => k.includes('KEY') || k.includes('TOKEN') ? `${k}=***` : `${k}=${this.config.env[k]}`).join(', ')}`);
        }

        this.process = spawn(command, args, {
          cwd: this.config.cwd,
          env: { ...process.env, ...this.config.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        // 通过 readline 逐行读取 stdout（每行一个 JSON-RPC 消息）
        this.readline = createInterface({
          input: this.process.stdout!,
          crlfDelay: Infinity,
        });

        this.readline.on('line', (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          try {
            const msg = JSON.parse(trimmed) as JsonRpcMessage;
            // 记录收到的消息（截断长内容）
            const preview = trimmed.length > 200 ? trimmed.slice(0, 200) + '...' : trimmed;
            this.log(`← 收到: ${preview}`);
            this.handleMessage(msg);
          } catch (err) {
            // 非 JSON 行忽略（可能是 Core 的调试输出误入 stdout）
            this.log(`忽略非 JSON 输出: ${trimmed.slice(0, 100)}`);
          }
        });

        // 将 stderr 转发到 Output Channel（不参与协议通信）
        this.process.stderr?.on('data', (data: Buffer) => {
          const text = data.toString().trim();
          if (text) {
            // 逐行输出到 Output Channel
            for (const line of text.split('\n')) {
              if (line.trim()) {
                this.log(`[Core] ${line}`);
              }
            }
          }
        });

        // 监听进程退出
        this.process.on('exit', (code) => {
          this.log(`Agent Core 进程退出 (code: ${code})`);
          this._isConnected = false;
          this.readline?.close();
          this.readline = null;
          this.rejectAllPending(new Error(`Agent Core 进程退出 (code: ${code})`));
          this.emit('disconnected', code);
        });

        // 监听错误
        this.process.on('error', (err) => {
          this.logError(`Agent Core 进程错误: ${err.message}`);
          this._isConnected = false;
          this.emit('error', err);
          reject(err);
        });

        // 标记连接成功
        this._isConnected = true;
        this.log('Agent Core 已连接');
        this.emit('connected');
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 停止 Agent Core 子进程
   */
  async stop(): Promise<void> {
    if (!this.process) return;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // 超时强制杀死
        this.process?.kill('SIGKILL');
        resolve();
      }, 5000);

      this.process!.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });

      // 关闭 readline
      this.readline?.close();
      this.readline = null;

      // 优雅关闭
      this.process!.kill('SIGTERM');
      this.process = null;
      this._isConnected = false;
      this.rejectAllPending(new Error('Bridge 已关闭'));
    });
  }

  /**
   * 重启 Agent Core 进程
   */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /**
   * 更新环境变量（在 restart 之前调用，确保新进程使用最新的配置）
   */
  updateEnv(env: Record<string, string>): void {
    this.config.env = env;
    this.log('环境变量已更新');
  }

  // ─── Extension → Core 方法 ───

  /**
   * 发送用户消息
   *
   * chat/send 是长时间运行的操作（可能持续数分钟），所有流式事件
   * （chat:text、chat:done 等）通过 JSON-RPC 通知实时返回。
   *
   * 注意：调用方通常不应 await 此方法，而是监听 bridge 事件来处理响应。
   * 如果 await，请注意超时设置（默认 5 分钟）。
   */
  async chatSend(params: ChatSendParams): Promise<void> {
    // 使用较长的超时（5 分钟），因为 AI 对话可能需要较长时间
    return new Promise((resolve, reject) => {
      if (!this.process || !this._isConnected) {
        reject(new Error('Agent Core 未连接'));
        return;
      }

      const id = ++this.requestId;
      const message: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method: Methods.CHAT_SEND,
        params,
      };

      // chat/send 使用 5 分钟超时
      const chatTimeout = 5 * 60 * 1000;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`chat/send 超时 (${chatTimeout / 1000}s)`));
      }, chatTimeout);

      this.pendingRequests.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });

      const data = JSON.stringify(message) + '\n';
      this.log(`→ 发送 chat/send: ${params.message?.slice(0, 100) || '(empty)'}`);
      this.process.stdin!.write(data, (error) => {
        if (error) {
          this.logError(`chat/send 写入失败: ${error.message}`);
          this.pendingRequests.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  /** 取消当前对话 */
  async chatCancel(params?: ChatCancelParams): Promise<void> {
    await this.request(Methods.CHAT_CANCEL, params || {});
  }

  /** 清空对话历史 */
  async chatClear(): Promise<void> {
    await this.request(Methods.CHAT_CLEAR, {});
  }

  /** 批准工具调用 */
  async toolApprove(params: ToolApproveParams): Promise<void> {
    await this.request(Methods.TOOL_APPROVE, params);
  }

  /** 拒绝工具调用 */
  async toolDeny(params: ToolDenyParams): Promise<void> {
    await this.request(Methods.TOOL_DENY, params);
  }

  /** 更新编辑器上下文 */
  async contextUpdate(params: ContextUpdateParams): Promise<void> {
    // 上下文更新使用通知（不需要响应）
    this.notify(Methods.CONTEXT_UPDATE, params);
  }

  /** 修改配置 */
  async configSet(params: ConfigSetParams): Promise<void> {
    await this.request(Methods.CONFIG_SET, params);
  }

  /** 获取配置 */
  async configGet(key: string): Promise<unknown> {
    return this.request(Methods.CONFIG_GET, { key });
  }

  /** 请求代码补全 */
  async completionRequest(params: CompletionRequestParams): Promise<void> {
    await this.request(Methods.COMPLETION_REQUEST, params);
  }

  /** 创建新会话 */
  async sessionCreate(): Promise<{ sessionId: string; title: string }> {
    return this.request(Methods.SESSION_CREATE, {}) as Promise<{ sessionId: string; title: string }>;
  }

  /** 列出所有会话 */
  async sessionList(): Promise<{ sessions: Array<{ id: string; title: string; updatedAt: string; messageCount: number }> }> {
    return this.request(Methods.SESSION_LIST, {}) as Promise<{ sessions: Array<{ id: string; title: string; updatedAt: string; messageCount: number }> }>;
  }

  /** 切换到指定会话 */
  async sessionSwitch(sessionId: string): Promise<{ ok: boolean; title?: string; messages?: Array<{ role: string; content: unknown }> }> {
    return this.request(Methods.SESSION_SWITCH, { sessionId }) as Promise<{ ok: boolean; title?: string; messages?: Array<{ role: string; content: unknown }> }>;
  }

  /** 删除会话 */
  async sessionDelete(sessionId: string): Promise<{ ok: boolean }> {
    return this.request(Methods.SESSION_DELETE, { sessionId }) as Promise<{ ok: boolean }>;
  }

  // ─── 健康检查 ───

  /**
   * 发送 ping 请求，检查 Core 是否就绪
   *
   * 返回 PongResult 包含 Core 的版本、运行时语言和状态。
   * 如果超时或 Core 未响应，Promise 会被 reject。
   */
  async ping(params?: PingParams): Promise<PongResult> {
    return this.request(Methods.PING, params || { timestamp: Date.now() }) as Promise<PongResult>;
  }

  /**
   * 等待 Core 就绪（带重试）
   *
   * @param maxRetries 最大重试次数（默认 10）
   * @param intervalMs 重试间隔毫秒（默认 500）
   */
  async waitForReady(maxRetries = 10, intervalMs = 500): Promise<PongResult> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const pong = await this.ping({ timestamp: Date.now() });
        if (pong.status === 'ready') {
          return pong;
        }
        // Core 还在初始化中，等待后重试
      } catch {
        // ping 失败（超时或连接断开），等待后重试
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`Agent Core 在 ${maxRetries * intervalMs}ms 内未就绪`);
  }

  // ─── 内部方法 ───

  /**
   * 发送 JSON-RPC 请求（等待响应）
   */
  public request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this._isConnected) {
        reject(new Error('Agent Core 未连接'));
        return;
      }

      const id = ++this.requestId;
      const message: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      // 设置超时
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`请求超时: ${method} (${this.config.requestTimeout}ms)`));
      }, this.config.requestTimeout);

      this.pendingRequests.set(id, { resolve, reject, timer });

      // 通过 stdin 发送 JSON-RPC 消息（每条消息一行）
      const data = JSON.stringify(message) + '\n';
      this.process.stdin!.write(data, (error) => {
        if (error) {
          this.pendingRequests.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  /**
   * 发送 JSON-RPC 通知（不等待响应）
   */
  private notify(method: string, params: unknown): void {
    if (!this.process || !this._isConnected) return;

    const message: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    // 通过 stdin 发送
    this.process.stdin!.write(JSON.stringify(message) + '\n');
  }

  /**
   * 处理收到的 JSON-RPC 消息
   */
  private handleMessage(msg: JsonRpcMessage): void {
    // 响应消息 — 匹配 pending request
    if ('id' in msg && msg.id !== undefined && !('method' in msg)) {
      const response = msg as JsonRpcResponse;
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        clearTimeout(pending.timer);
        if (response.error) {
          pending.reject(new Error(response.error.message));
        } else {
          pending.resolve(response.result);
        }
      }
      return;
    }

    // 通知消息 — 分发事件
    if ('method' in msg) {
      const notification = msg as JsonRpcNotification;
      this.dispatchNotification(notification.method, notification.params);
    }
  }

  /**
   * 分发通知到对应的事件
   */
  private dispatchNotification(method: string, params: unknown): void {
    switch (method) {
      case Methods.CHAT_TEXT:
        this.emit('chat:text', params as ChatTextNotification);
        break;
      case Methods.CHAT_THINKING:
        this.emit('chat:thinking', params as ChatThinkingNotification);
        break;
      case Methods.CHAT_TOOL_CALL:
        this.emit('chat:toolCall', params as ToolCallNotification);
        break;
      case Methods.CHAT_TOOL_RESULT:
        this.emit('chat:toolResult', params as ToolResultNotification);
        break;
      case Methods.CHAT_DONE:
        this.emit('chat:done', params as ChatDoneNotification);
        break;
      case Methods.CHAT_ERROR:
        this.emit('chat:error', params as ChatErrorNotification);
        break;
      case Methods.FILE_EDIT:
        this.emit('file:edit', params as FileEditNotification);
        break;
      case Methods.FILE_CREATE:
        this.emit('file:create', params as FileCreateNotification);
        break;
      case Methods.STATUS_UPDATE:
        this.emit('status:update', params as StatusUpdateNotification);
        break;
      case Methods.COMPLETION_RESULT:
        this.emit('completion:result', params as CompletionResultNotification);
        break;
      case Methods.TOOL_APPROVAL_REQUEST:
        this.emit('tool:approvalRequest', params as ToolApprovalRequestNotification);
        break;
      default:
        this.log(`未知通知方法: ${method}`);
    }
  }

  /**
   * 拒绝所有 pending 请求
   */
  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  /**
   * 解析 Core 启动命令和参数
   *
   * 支持多种 Core 实现：
   * - TypeScript/JS Core: node bridge-server.bundle.cjs --bridge
   * - Go Core: ./openaide-core --bridge
   * - Rust Core: ./openaide-core --bridge
   * - Python Core: python bridge-server.py --bridge
   */
  private resolveCoreCommand(): { command: string; args: string[] } {
    // 如果用户显式指定了命令
    if (this.config.coreCommand) {
      const corePath = this.config.corePath || '';
      const baseArgs = corePath ? [corePath] : [];
      return {
        command: this.config.coreCommand,
        args: [...baseArgs, '--bridge', ...this.config.coreArgs],
      };
    }

    // 自动检测 Core 路径和类型
    const corePath = this.config.corePath || this.findCorePath();
    const ext = path.extname(corePath).toLowerCase();

    switch (ext) {
      case '.js':
      case '.cjs':
      case '.mjs':
        // Node.js 脚本
        return {
          command: process.execPath, // 使用当前 Node.js 可执行文件
          args: [corePath, '--bridge', ...this.config.coreArgs],
        };

      case '.py':
        // Python 脚本
        return {
          command: 'python3',
          args: [corePath, '--bridge', ...this.config.coreArgs],
        };

      case '':
        // 无扩展名 — 视为原生二进制（Go/Rust 编译产物）
        return {
          command: corePath,
          args: ['--bridge', ...this.config.coreArgs],
        };

      default:
        // 其他情况尝试直接执行
        return {
          command: corePath,
          args: ['--bridge', ...this.config.coreArgs],
        };
    }
  }

  /**
   * 查找 Agent Core 入口路径
   *
   * 查找顺序：
   * 1. 同目录下的 bridge-server.bundle.cjs（IDE 内置扩展模式）
   * 2. 同目录下的 openaide-core 原生二进制（Go/Rust Core）
   * 3. @openaide/core 包的 bridge-server.js（开发模式 - npm workspace）
   * 4. 相对路径回退（开发模式 - 直接引用）
   */
  private findCorePath(): string {
    const fs = require('fs');

    // 0. claw-code Rust bridge 二进制（开发模式 — 从 openAIDE 项目中查找）
    // 查找顺序：release → debug
    const clawCodePaths = [
      // 相对于 openaide-ui 项目的 claw-code 路径
      path.resolve(__dirname, '../../../../claw-code/rust/target/release/claw'),
      path.resolve(__dirname, '../../../../claw-code/rust/target/debug/claw'),
    ];
    for (const clawPath of clawCodePaths) {
      if (fs.existsSync(clawPath)) {
        console.log(`[Bridge] 使用 claw-code Rust Core: ${clawPath}`);
        return clawPath;
      }
    }

    // 1. IDE 内置扩展模式：bundle 文件与 extension.js 在同一 dist/ 目录
    const bundlePath = path.resolve(__dirname, 'bridge-server.bundle.cjs');
    if (fs.existsSync(bundlePath)) {
      return bundlePath;
    }

    // 2. 原生二进制 Core（Go/Rust 编译产物）
    const binaryName = process.platform === 'win32' ? 'openaide-core.exe' : 'openaide-core';
    const binaryPath = path.resolve(__dirname, binaryName);
    if (fs.existsSync(binaryPath)) {
      return binaryPath;
    }

    // 3. 开发模式：通过 npm workspace 依赖解析
    try {
      return require.resolve('@openaide/core/dist/bridge-server.js');
    } catch {
      // 4. 开发模式回退：相对路径
      return path.resolve(__dirname, '../../core/dist/bridge-server.js');
    }
  }

  /** 释放资源 */
  dispose(): void {
    this.stop().catch(() => {});
    this.removeAllListeners();
    this.outputChannel.dispose();
  }
}
