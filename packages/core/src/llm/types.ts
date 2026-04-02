/**
 * LLM Provider 统一接口定义（增强版）
 *
 * 所有 LLM 提供者（Claude, OpenAI, DeepSeek, Qwen, GLM, Ollama）
 * 都必须实现此接口
 *
 * 增强功能：
 * - 错误分类（可重试 vs 不可重试）
 * - Token 估算接口
 * - 模型能力检测
 * - 成本计算
 * - 推理力度控制
 */

/** 聊天消息角色 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** 消息内容块类型 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64' | 'url'; data: string; media_type?: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

/** 聊天消息 */
export interface ChatMessage {
  role: MessageRole;
  content: string | ContentBlock[];
}

/** 工具定义（兼容 OpenAI / Anthropic 格式） */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** 推理力度 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

/** 聊天请求参数 */
export interface ChatParams {
  messages: ChatMessage[];
  systemPrompt?: string;
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  /** 是否启用思考/推理模式 */
  thinking?: boolean;
  /** 思考 token 预算 */
  thinkingBudget?: number;
  /** 推理力度控制 */
  reasoningEffort?: ReasoningEffort;
}

/** 流式事件类型 */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; input: string }
  | { type: 'tool_use_end'; id: string; name?: string; input: Record<string, unknown> }
  | { type: 'message_start'; messageId: string }
  | { type: 'message_end'; usage: TokenUsage }
  | { type: 'error'; error: Error };

/** Token 用量 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  totalCostUSD?: number;
}

/** 非流式响应 */
export interface ChatResponse {
  id: string;
  content: ContentBlock[];
  usage: TokenUsage;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  model: string;
}

// ─── 错误分类 ───

/** API 错误类型 */
export type APIErrorType =
  | 'rate_limit'       // 速率限制（可重试）
  | 'overloaded'       // 服务过载（可重试）
  | 'timeout'          // 超时（可重试）
  | 'network'          // 网络错误（可重试）
  | 'auth'             // 认证错误（不可重试）
  | 'invalid_request'  // 请求无效（不可重试）
  | 'context_length'   // 上下文超长（不可重试，需压缩）
  | 'content_filter'   // 内容过滤（不可重试）
  | 'billing'          // 计费问题（不可重试）
  | 'unknown';         // 未知错误

/** API 错误 */
export class APIError extends Error {
  readonly errorType: APIErrorType;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    errorType: APIErrorType,
    statusCode?: number,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'APIError';
    this.errorType = errorType;
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
    this.retryable = ['rate_limit', 'overloaded', 'timeout', 'network'].includes(errorType);
  }

  /** 从 HTTP 响应创建 APIError */
  static fromResponse(status: number, body: string): APIError {
    if (status === 429) {
      return new APIError(`Rate limited: ${body}`, 'rate_limit', status, 5000);
    }
    if (status === 529 || status === 503) {
      return new APIError(`Service overloaded: ${body}`, 'overloaded', status, 10000);
    }
    if (status === 401 || status === 403) {
      return new APIError(`Authentication error: ${body}`, 'auth', status);
    }
    if (status === 400) {
      if (body.includes('context_length') || body.includes('too many tokens') || body.includes('maximum context')) {
        return new APIError(`Context too long: ${body}`, 'context_length', status);
      }
      return new APIError(`Invalid request: ${body}`, 'invalid_request', status);
    }
    if (status >= 500) {
      return new APIError(`Server error: ${body}`, 'overloaded', status, 5000);
    }
    return new APIError(`API error ${status}: ${body}`, 'unknown', status);
  }
}

// ─── 模型能力 ───

/** 模型能力描述 */
export interface ModelCapabilities {
  /** 模型标识符 */
  model: string;
  /** 提供者名称 */
  provider: string;
  /** 最大上下文窗口（token 数） */
  maxContextWindow: number;
  /** 最大输出 token 数 */
  maxOutputTokens: number;
  /** 是否支持工具调用 */
  supportsTool: boolean;
  /** 是否支持思考/推理模式 */
  supportsThinking: boolean;
  /** 是否支持图片输入 */
  supportsVision: boolean;
  /** 是否支持 prompt cache */
  supportsPromptCache: boolean;
  /** 是否支持流式输出 */
  supportsStreaming: boolean;
  /** 是否支持并行工具调用 */
  supportsParallelToolCalls: boolean;
  /** 每百万 input token 价格（美元） */
  inputPricePerMillion: number;
  /** 每百万 output token 价格（美元） */
  outputPricePerMillion: number;
}

/** LLM Provider 接口 — 所有模型提供者必须实现 */
export interface LLMProvider {
  /** 提供者名称 */
  readonly name: string;

  /** 模型标识符 */
  readonly model: string;

  /** 最大上下文窗口（token 数） */
  readonly maxContextWindow: number;

  /** 最大输出 token 数 */
  readonly maxOutputTokens: number;

  /** 是否支持工具调用 */
  readonly supportsTool: boolean;

  /** 是否支持思考/推理模式 */
  readonly supportsThinking: boolean;

  /** 是否支持图片输入 */
  readonly supportsVision: boolean;

  /** 是否支持 prompt cache */
  readonly supportsPromptCache: boolean;

  /** 流式聊天 — 返回异步迭代器 */
  chatStream(params: ChatParams): AsyncGenerator<StreamEvent, void, unknown>;

  /** 非流式聊天 */
  chat(params: ChatParams): Promise<ChatResponse>;

  /** 估算 token 数（用于上下文管理） */
  estimateTokens(text: string): number;

  /** 计算费用（美元） */
  calculateCost(usage: TokenUsage): number;

  /** 获取模型能力（可选） */
  getCapabilities?(): ModelCapabilities;
}

/** Provider 配置 */
export interface ProviderConfig {
  provider: 'anthropic' | 'openai' | 'deepseek' | 'qwen' | 'glm' | 'ollama' | 'custom';
  apiKey?: string;
  baseUrl?: string;
  model: string;
  /** 自定义 headers */
  headers?: Record<string, string>;
  /** 超时（毫秒） */
  timeout?: number;
  /** 重试次数 */
  maxRetries?: number;
}
