/**
 * OpenAI 兼容 Provider
 *
 * 支持所有 OpenAI 兼容 API：
 * - OpenAI (GPT-4o, GPT-4-turbo, o1, o3)
 * - DeepSeek (deepseek-chat, deepseek-reasoner)
 * - Qwen (qwen-max, qwen-plus)
 * - GLM (glm-5.1, glm-4-plus, glm-4-flash, glm-4-long)
 * - 任何 OpenAI 兼容的自定义端点
 */

import type {
  LLMProvider,
  ProviderConfig,
  ChatParams,
  ChatMessage,
  ChatResponse,
  StreamEvent,
  TokenUsage,
  ContentBlock,
  ToolDefinition,
} from '../types.js';

/** 模型能力配置 */
interface ModelCapabilities {
  maxContextWindow: number;
  maxOutputTokens: number;
  supportsTool: boolean;
  supportsThinking: boolean;
  supportsVision: boolean;
  supportsPromptCache: boolean;
  inputPricePer1M: number;   // 美元 / 百万 input tokens
  outputPricePer1M: number;  // 美元 / 百万 output tokens
}

/** 已知模型的能力配置 */
const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  // OpenAI
  'gpt-4o': {
    maxContextWindow: 128000, maxOutputTokens: 16384,
    supportsTool: true, supportsThinking: false, supportsVision: true, supportsPromptCache: false,
    inputPricePer1M: 2.5, outputPricePer1M: 10,
  },
  'gpt-4o-mini': {
    maxContextWindow: 128000, maxOutputTokens: 16384,
    supportsTool: true, supportsThinking: false, supportsVision: true, supportsPromptCache: false,
    inputPricePer1M: 0.15, outputPricePer1M: 0.6,
  },
  'o1': {
    maxContextWindow: 200000, maxOutputTokens: 100000,
    supportsTool: true, supportsThinking: true, supportsVision: true, supportsPromptCache: false,
    inputPricePer1M: 15, outputPricePer1M: 60,
  },
  'o3-mini': {
    maxContextWindow: 200000, maxOutputTokens: 100000,
    supportsTool: true, supportsThinking: true, supportsVision: false, supportsPromptCache: false,
    inputPricePer1M: 1.1, outputPricePer1M: 4.4,
  },
  // DeepSeek
  'deepseek-chat': {
    maxContextWindow: 64000, maxOutputTokens: 8192,
    supportsTool: true, supportsThinking: false, supportsVision: false, supportsPromptCache: true,
    inputPricePer1M: 0.27, outputPricePer1M: 1.1,
  },
  'deepseek-reasoner': {
    maxContextWindow: 64000, maxOutputTokens: 8192,
    supportsTool: true, supportsThinking: true, supportsVision: false, supportsPromptCache: true,
    inputPricePer1M: 0.55, outputPricePer1M: 2.19,
  },
  // Qwen
  'qwen-max': {
    maxContextWindow: 32000, maxOutputTokens: 8192,
    supportsTool: true, supportsThinking: false, supportsVision: false, supportsPromptCache: false,
    inputPricePer1M: 2.4, outputPricePer1M: 9.6,
  },
  'qwen-plus': {
    maxContextWindow: 131072, maxOutputTokens: 8192,
    supportsTool: true, supportsThinking: false, supportsVision: false, supportsPromptCache: false,
    inputPricePer1M: 0.8, outputPricePer1M: 2,
  },
  // GLM（智谱 AI）
  'glm-5.1': {
    maxContextWindow: 128000, maxOutputTokens: 16384,
    supportsTool: true, supportsThinking: false, supportsVision: false, supportsPromptCache: false,
    inputPricePer1M: 0, outputPricePer1M: 0, // Coding Plan 免费
  },
  'glm-4-plus': {
    maxContextWindow: 128000, maxOutputTokens: 4096,
    supportsTool: true, supportsThinking: false, supportsVision: false, supportsPromptCache: false,
    inputPricePer1M: 0.5, outputPricePer1M: 0.5,
  },
  'glm-4-flash': {
    maxContextWindow: 128000, maxOutputTokens: 4096,
    supportsTool: true, supportsThinking: false, supportsVision: false, supportsPromptCache: false,
    inputPricePer1M: 0, outputPricePer1M: 0, // 免费模型
  },
  'glm-4-long': {
    maxContextWindow: 1000000, maxOutputTokens: 4096,
    supportsTool: true, supportsThinking: false, supportsVision: false, supportsPromptCache: false,
    inputPricePer1M: 0.1, outputPricePer1M: 0.1,
  },
  'glm-4': {
    maxContextWindow: 128000, maxOutputTokens: 4096,
    supportsTool: true, supportsThinking: false, supportsVision: false, supportsPromptCache: false,
    inputPricePer1M: 1, outputPricePer1M: 1,
  },
};

/** 已知 Provider 的默认 Base URL */
const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  glm: 'https://open.bigmodel.cn/api/paas/v4',
};

/** GLM Coding Plan 专属模型列表（使用 Coding API 端点） */
const GLM_CODING_MODELS = new Set(['glm-5.1']);

/** GLM Coding API 端点 */
const GLM_CODING_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';

/** 获取模型能力（未知模型使用保守默认值） */
function getModelCapabilities(model: string): ModelCapabilities {
  return MODEL_CAPABILITIES[model] ?? {
    maxContextWindow: 32000,
    maxOutputTokens: 4096,
    supportsTool: true,
    supportsThinking: false,
    supportsVision: false,
    supportsPromptCache: false,
    inputPricePer1M: 1,
    outputPricePer1M: 3,
  };
}

/** 将内部消息格式转换为 OpenAI API 格式 */
function toOpenAIMessages(
  messages: ChatMessage[],
  systemPrompt?: string,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  // System prompt 作为第一条消息
  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    if (msg.role === 'tool') {
      // 工具结果消息
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const block of blocks) {
        if (typeof block === 'object' && 'type' in block && block.type === 'tool_result') {
          const toolResult = block as ContentBlock & { type: 'tool_result' };
          result.push({
            role: 'tool',
            tool_call_id: toolResult.tool_use_id,
            content: toolResult.content,
          });
        }
      }
    } else if (msg.role === 'assistant') {
      // Assistant 消息可能包含工具调用
      if (typeof msg.content === 'string') {
        result.push({ role: 'assistant', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        const toolCalls: Array<Record<string, unknown>> = [];

        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          }
        }

        const assistantMsg: Record<string, unknown> = {
          role: 'assistant',
          content: textParts.join('\n') || null,
        };
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
        result.push(assistantMsg);
      }
    } else if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // 多模态内容（文本 + 图片）
        const parts: Array<Record<string, unknown>> = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text });
          } else if (block.type === 'image') {
            if (block.source.type === 'url') {
              parts.push({
                type: 'image_url',
                image_url: { url: block.source.data },
              });
            } else {
              parts.push({
                type: 'image_url',
                image_url: {
                  url: `data:${block.source.media_type || 'image/png'};base64,${block.source.data}`,
                },
              });
            }
          }
        }
        result.push({ role: 'user', content: parts });
      }
    }
  }

  return result;
}

/** 将工具定义转换为 OpenAI 格式 */
function toOpenAITools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/**
 * OpenAI 兼容 Provider 实现
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly maxContextWindow: number;
  readonly maxOutputTokens: number;
  readonly supportsTool: boolean;
  readonly supportsThinking: boolean;
  readonly supportsVision: boolean;
  readonly supportsPromptCache: boolean;

  private baseUrl: string;
  private apiKey: string;
  private headers: Record<string, string>;
  private timeout: number;
  private maxRetries: number;
  private capabilities: ModelCapabilities;

  constructor(config: ProviderConfig) {
    this.name = config.provider;
    this.model = config.model;
    this.apiKey = config.apiKey || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.QWEN_API_KEY || process.env.GLM_API_KEY || '';
    this.timeout = config.timeout || 120000;
    this.maxRetries = config.maxRetries || 3;

    // 确定 Base URL：显式配置 > GLM Coding 模型特殊处理 > Provider 默认值
    if (config.baseUrl) {
      this.baseUrl = config.baseUrl;
    } else if (config.provider === 'glm' && GLM_CODING_MODELS.has(config.model)) {
      this.baseUrl = GLM_CODING_BASE_URL;
    } else if (config.provider === 'custom') {
      this.baseUrl = process.env.CUSTOM_BASE_URL || 'https://api.openai.com/v1';
    } else {
      this.baseUrl = PROVIDER_BASE_URLS[config.provider] || 'https://api.openai.com/v1';
    }

    // 自定义 Provider 从环境变量读取 API Key
    if (config.provider === 'custom' && !this.apiKey) {
      this.apiKey = process.env.CUSTOM_API_KEY || '';
    }

    this.headers = config.headers || {};

    this.capabilities = getModelCapabilities(config.model);
    this.maxContextWindow = this.capabilities.maxContextWindow;
    this.maxOutputTokens = this.capabilities.maxOutputTokens;
    this.supportsTool = this.capabilities.supportsTool;
    this.supportsThinking = this.capabilities.supportsThinking;
    this.supportsVision = this.capabilities.supportsVision;
    this.supportsPromptCache = this.capabilities.supportsPromptCache;
  }

  /**
   * 流式聊天
   */
  async *chatStream(params: ChatParams): AsyncGenerator<StreamEvent, void, unknown> {
    const body = this.buildRequestBody(params, true);

    yield { type: 'message_start', messageId: `msg_${Date.now()}` };

    const response = await this.fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        ...this.headers,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      yield { type: 'error', error: new Error(`API error ${response.status}: ${errorText}`) };
      return;
    }

    if (!response.body) {
      yield { type: 'error', error: new Error('No response body') };
      return;
    }

    // 解析 SSE 流
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // 跟踪工具调用状态
    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

          try {
            const chunk = JSON.parse(data);
            const choice = chunk.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;
            if (!delta) continue;

            // 文本内容
            if (delta.content) {
              yield { type: 'text_delta', text: delta.content };
            }

            // 推理内容（DeepSeek reasoner / OpenAI o1）
            if (delta.reasoning_content) {
              yield { type: 'thinking_delta', text: delta.reasoning_content };
            }

            // 工具调用
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;

                if (tc.id) {
                  // 新的工具调用开始
                  toolCallBuffers.set(idx, {
                    id: tc.id,
                    name: tc.function?.name || '',
                    arguments: tc.function?.arguments || '',
                  });
                  yield { type: 'tool_use_start', id: tc.id, name: tc.function?.name || '' };
                } else if (tc.function?.arguments) {
                  // 工具调用参数增量
                  const buf = toolCallBuffers.get(idx);
                  if (buf) {
                    buf.arguments += tc.function.arguments;
                    yield { type: 'tool_use_delta', id: buf.id, input: tc.function.arguments };
                  }
                }
                if (tc.function?.name) {
                  const buf = toolCallBuffers.get(idx);
                  if (buf && !buf.name) {
                    buf.name = tc.function.name;
                  }
                }
              }
            }

            // 结束原因
            if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
              // 发送所有待完成的工具调用结束事件
              for (const [, buf] of toolCallBuffers) {
                let parsedInput: Record<string, unknown> = {};
                try {
                  parsedInput = JSON.parse(buf.arguments || '{}');
                } catch {
                  parsedInput = { _raw: buf.arguments };
                }
                yield {
                  type: 'tool_use_end',
                  id: buf.id,
                  name: buf.name,
                  input: parsedInput,
                };
              }
              toolCallBuffers.clear();
            }

            // Token 用量（部分 API 在流中返回）
            if (chunk.usage) {
              totalInputTokens = chunk.usage.prompt_tokens || 0;
              totalOutputTokens = chunk.usage.completion_tokens || 0;
            }
          } catch {
            // 忽略解析错误的行
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // 发送消息结束事件
    const usage: TokenUsage = {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      totalCostUSD: this.calculateCost({ inputTokens: totalInputTokens, outputTokens: totalOutputTokens }),
    };
    yield { type: 'message_end', usage };
  }

  /**
   * 非流式聊天
   */
  async chat(params: ChatParams): Promise<ChatResponse> {
    const body = this.buildRequestBody(params, false);

    const response = await this.fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        ...this.headers,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as Record<string, unknown>;
    return this.parseNonStreamResponse(data);
  }

  /**
   * 估算 token 数（简单估算：1 token ≈ 4 字符英文 / 2 字符中文）
   */
  estimateTokens(text: string): number {
    // 简单估算：英文约 4 字符/token，中文约 1.5 字符/token
    let tokens = 0;
    for (const char of text) {
      if (char.charCodeAt(0) > 127) {
        tokens += 0.67; // 中文/CJK 字符
      } else {
        tokens += 0.25; // ASCII 字符
      }
    }
    return Math.ceil(tokens);
  }

  /**
   * 计算费用
   */
  calculateCost(usage: TokenUsage): number {
    const inputCost = (usage.inputTokens / 1_000_000) * this.capabilities.inputPricePer1M;
    const outputCost = (usage.outputTokens / 1_000_000) * this.capabilities.outputPricePer1M;
    return inputCost + outputCost;
  }

  /** 构建请求体 */
  private buildRequestBody(params: ChatParams, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAIMessages(params.messages, params.systemPrompt),
      stream,
    };

    if (stream) {
      body.stream_options = { include_usage: true };
    }

    if (params.tools && params.tools.length > 0 && this.supportsTool) {
      body.tools = toOpenAITools(params.tools);
      body.tool_choice = 'auto';
    }

    if (params.temperature !== undefined) {
      body.temperature = params.temperature;
    }

    if (params.maxTokens) {
      body.max_tokens = params.maxTokens;
    } else {
      body.max_tokens = this.maxOutputTokens;
    }

    if (params.topP !== undefined) {
      body.top_p = params.topP;
    }

    if (params.stop) {
      body.stop = params.stop;
    }

    return body;
  }

  /** 解析非流式响应 */
  private parseNonStreamResponse(data: Record<string, unknown>): ChatResponse {
    const choices = data.choices as Array<Record<string, unknown>>;
    const choice = choices?.[0];
    const message = choice?.message as Record<string, unknown>;
    const usage = data.usage as Record<string, number>;

    const content: ContentBlock[] = [];

    // 文本内容
    if (message?.content) {
      content.push({ type: 'text', text: message.content as string });
    }

    // 工具调用
    if (message?.tool_calls) {
      const toolCalls = message.tool_calls as Array<Record<string, unknown>>;
      for (const tc of toolCalls) {
        const fn = tc.function as Record<string, string>;
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(fn.arguments || '{}');
        } catch {
          parsedArgs = { _raw: fn.arguments };
        }
        content.push({
          type: 'tool_use',
          id: tc.id as string,
          name: fn.name,
          input: parsedArgs,
        });
      }
    }

    const tokenUsage: TokenUsage = {
      inputTokens: usage?.prompt_tokens || 0,
      outputTokens: usage?.completion_tokens || 0,
    };
    tokenUsage.totalCostUSD = this.calculateCost(tokenUsage);

    const stopReason = (choice?.finish_reason as string) === 'tool_calls' ? 'tool_use' as const
      : (choice?.finish_reason as string) === 'length' ? 'max_tokens' as const
      : 'end_turn' as const;

    return {
      id: data.id as string || `chatcmpl-${Date.now()}`,
      content,
      usage: tokenUsage,
      stopReason,
      model: data.model as string || this.model,
    };
  }

  /** 带重试的 fetch */
  private async fetchWithRetry(url: string, init: RequestInit, retries = 0): Promise<Response> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // 429 或 5xx 可重试
      if ((response.status === 429 || response.status >= 500) && retries < this.maxRetries) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '1', 10);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        return this.fetchWithRetry(url, init, retries + 1);
      }

      return response;
    } catch (error) {
      if (retries < this.maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, retries), 10000);
        await new Promise((r) => setTimeout(r, delay));
        return this.fetchWithRetry(url, init, retries + 1);
      }
      throw error;
    }
  }
}
