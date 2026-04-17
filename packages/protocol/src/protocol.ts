/**
 * OpenAIDE Protocol — 语言无关的通信协议定义
 *
 * Extension ↔ Agent Core 之间使用 JSON-RPC 2.0 over stdio (stdin/stdout)
 *
 * 传输层：Extension 通过 spawn 启动 Core 子进程，
 * 使用 stdin/stdout 进行双向 JSON 行协议通信，
 * Core 可以是任意语言实现（TypeScript / Go / Rust / Python）。
 *
 * 本包为纯类型+常量定义，不包含任何运行时逻辑，
 * 可被 Extension 和 Core（TS 版本）共同引用。
 * 其他语言的 Core 实现应参照此文件生成对应的类型定义。
 */

// ─── JSON-RPC 2.0 基础类型 ───

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ─── 健康检查 ───

/** ping 请求参数（可选携带时间戳） */
export interface PingParams {
  timestamp?: number;
}

/** ping 响应 */
export interface PongResult {
  /** 回显请求中的 timestamp */
  timestamp?: number;
  /** Core 版本号 */
  version: string;
  /** Core 实现语言 */
  runtime: 'typescript' | 'go' | 'rust' | 'python' | string;
  /** Core 当前状态 */
  status: 'ready' | 'initializing' | 'error';
  /** 附加信息（如错误描述） */
  message?: string;
}

// ─── Extension → Core 方法参数 ───

/** 发送用户消息 */
export interface ChatSendParams {
  message: string;
  conversationId?: string;
  attachments?: AttachmentInfo[];
}

/** 取消当前请求 */
export interface ChatCancelParams {
  conversationId?: string;
}

/** 批准工具调用 */
export interface ToolApproveParams {
  toolCallId: string;
}

/** 拒绝工具调用 */
export interface ToolDenyParams {
  toolCallId: string;
  reason?: string;
}

/** 更新编辑器上下文 */
export interface ContextUpdateParams {
  activeFile?: string;
  selection?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
    text: string;
  };
  openFiles: string[];
  workspaceFolders: string[];
}

/** 修改配置 */
export interface ConfigSetParams {
  key: string;
  value: unknown;
}

/** 请求代码补全 */
export interface CompletionRequestParams {
  file: string;
  position: { line: number; character: number };
  prefix: string;
  suffix: string;
  language: string;
}

/** 附件信息 */
export interface AttachmentInfo {
  type: 'file' | 'image' | 'selection' | 'diagnostic';
  path?: string;
  content?: string;
  language?: string;
  mimeType?: string;
}

// ─── Core → Extension 通知参数 ───

/** 流式文本 */
export interface ChatTextNotification {
  text: string;
  conversationId: string;
}

/** 思考过程 */
export interface ChatThinkingNotification {
  text: string;
  conversationId: string;
}

/** 工具调用开始 */
export interface ToolCallNotification {
  id: string;
  name: string;
  input: Record<string, unknown>;
  conversationId: string;
}

/** 工具调用结果 */
export interface ToolResultNotification {
  id: string;
  name: string;
  content: string;
  isError: boolean;
  conversationId: string;
}

/** 对话完成 */
export interface ChatDoneNotification {
  conversationId: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalCostUSD?: number;
  };
}

/** 对话错误 */
export interface ChatErrorNotification {
  conversationId: string;
  error: string;
}

/** 文件编辑请求 */
export interface FileEditNotification {
  path: string;
  originalContent: string;
  newContent: string;
  description?: string;
}

/** 文件创建请求 */
export interface FileCreateNotification {
  path: string;
  content: string;
}

/** 状态更新 */
export interface StatusUpdateNotification {
  state: AgentState;
  message?: string;
}

/** 工具轮次达到上限通知 */
export interface ToolLimitReachedNotification {
  conversationId: string;
  currentRounds: number;
  maxRounds: number;
  message: string;
}

/** 代码补全结果 */
export interface CompletionResultNotification {
  requestId: string;
  completions: Array<{
    text: string;
    range?: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
  }>;
}

/** 工具审批请求（Core → Extension） */
export interface ToolApprovalRequestNotification {
  toolCallId: string;
  toolName: string;
  description: string;
  conversationId: string;
}

// ─── 共享类型 ───

/** Agent 状态 */
export type AgentState = 'idle' | 'thinking' | 'tool_calling' | 'streaming' | 'error' | 'waiting_for_continue';

/** Token 用量 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalCostUSD?: number;
}

// ─── 方法名常量 ───

export const Methods = {
  // ── 健康检查 ──
  PING: 'ping',

  // ── Extension → Core ──
  CHAT_SEND: 'chat/send',
  CHAT_CANCEL: 'chat/cancel',
  CHAT_CONTINUE: 'chat/continue',
  CHAT_CLEAR: 'chat/clear',
  TOOL_APPROVE: 'tool/approve',
  TOOL_DENY: 'tool/deny',
  CONTEXT_UPDATE: 'context/update',
  CONFIG_SET: 'config/set',
  CONFIG_GET: 'config/get',
  COMPLETION_REQUEST: 'completion/request',

  // ── 会话管理 ──
  SESSION_CREATE: 'session/create',
  SESSION_LIST: 'session/list',
  SESSION_SWITCH: 'session/switch',
  SESSION_DELETE: 'session/delete',

  // ── Core → Extension (通知，无需响应) ──
  CHAT_TEXT: 'chat/text',
  CHAT_THINKING: 'chat/thinking',
  CHAT_TOOL_CALL: 'chat/toolCall',
  CHAT_TOOL_RESULT: 'chat/toolResult',
  CHAT_DONE: 'chat/done',
  CHAT_ERROR: 'chat/error',
  FILE_EDIT: 'file/edit',
  FILE_CREATE: 'file/create',
  STATUS_UPDATE: 'status/update',
  CHAT_TOOL_LIMIT: 'chat/toolLimitReached',
  COMPLETION_RESULT: 'completion/result',
  TOOL_APPROVAL_REQUEST: 'tool/requestApproval',
} as const;

/** 协议版本号 — 用于 Core 与 Extension 的兼容性检查 */
export const PROTOCOL_VERSION = '0.1.0';
