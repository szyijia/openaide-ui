/**
 * Anthropic Provider
 *
 * 支持 Claude 系列模型：
 * - Claude Sonnet 4 (claude-sonnet-4-20250514)
 * - Claude Opus 4 (claude-opus-4-20250514)
 * - Claude 3.5 Sonnet (claude-3-5-sonnet-20241022)
 * - Claude 3.5 Haiku (claude-3-5-haiku-20241022)
 *
 * 使用原生 Anthropic Messages API（非 OpenAI 兼容）
 * 支持 Prompt Cache、Extended Thinking、Vision
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

/** Anthropic 模型能力配置 */
interface AnthropicModelCapabilities {
  maxContextWindow: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
  supportsVision: boolean;
  supportsPromptCache: boolean;
  inputPricePer1M: number;
  outputPricePer1M: number;
  cacheWritePricePer1M: number;
  cacheReadPricePer1M: number;
}

const ANTHROPIC_MODELS: Record<string, AnthropicModelCapabilities> = {
  'claude-sonnet-4-20250514': {
    maxContextWindow: 200000, maxOutputTokens: 16384,
    supportsThinking: true, supportsVision: true, supportsPromptCache: true,
    inputPricePer1M: 3, outputPricePer1M: 15,
    cacheWritePricePer1M: 3.75, cacheReadPricePer1M: 0.3,
  },
  'claude-opus-4-20250514': {
    maxContextWindow: 200000, maxOutputTokens: 32000,
    supportsThinking: true, supportsVision: true, supportsPromptCache: true,
    inputPricePer1M: 15, outputPricePer1M: 75,
    cacheWritePricePer1M: 18.75, cacheReadPricePer1M: 1.5,
  },
  'claude-3-5-sonnet-20241022': {
    maxContextWindow: 200000, maxOutputTokens: 8192,
    supportsThinking: false, supportsVision: true, supportsPromptCache: true,
    inputPricePer1M: 3, outputPricePer1M: 15,
    cacheWritePricePer1M: 3.75, cacheReadPricePer1M: 0.3,
  },
  'claude-3-5-haiku-20241022': {
    maxContextWindow: 200000, maxOutputTokens: 8192,
    supportsThinking: false, supportsVision: true, supportsPromptCache: true,
    inputPricePer1M: 0.8, outputPricePer1M: 4,
    cacheWritePricePer1M: 1, cacheReadPricePer1M: 0.08,
  },
};

/** 获取模型能力 */
function getCapabilities(model: string): AnthropicModelCapabilities {
  return ANTHROPIC_MODELS[model] ?? {
    maxContextWindow: 200000, maxOutputTokens: 8192,
    supportsThinking: false, supportsVision: true, supportsPromptCache: true,
    inputPricePer1M: 3, outputPricePer1M: 15,
    cacheWritePricePer1M: 3.75, cacheReadPricePer1M: 0.3,
  };
}

/** 将内部消息格式转换为 Anthropic API 格式 */
function toAnthropicMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue; // system prompt 单独处理

    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const blocks: Array<Record<string, unknown>> = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            blocks.push({ type: 'text', text: block.text });
          } else if (block.type === 'image') {
            blocks.push({
              type: 'image',
              source: {
                type: block.source.type === 'url' ? 'url' : 'base64',
                media_type: block.source.media_type || 'image/png',
                data: block.source.data,
              },
            });
          }
        }
        result.push({ role: 'user', content: blocks });
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'assistant', content: [{ type: 'text', text: msg.content }] });
      } else if (Array.isArray(msg.content)) {
        const blocks: Array<Record<string, unknown>> = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            blocks.push({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            blocks.push({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input,
            });
          }
        }
        result.push({ role: 'assistant', content: blocks });
      }
    } else if (msg.role === 'tool') {
      // 工具结果
      if (Array.isArray(msg.content)) {
        const blocks: Array<Record<string, unknown>> = [];
        for (const block of msg.content) {
          if (typeof block === 'object' && 'type' in block && block.type === 'tool_result') {
            const toolResult = block as ContentBlock & { type: 'tool_result' };
            blocks.push({
              type: 'tool_result',
              tool_use_id: toolResult.tool_use_id,
              content: toolResult.content,
              is_error: toolResult.is_error || false,
            });
          }
        }
        result.push({ role: 'user', content: blocks });
      }
    }
  }

  return result;
}

/** 将工具定义转换为 Anthropic 格式 */
function toAnthropicTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

/**
 * Anthropic Provider 实现
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly model: string;
  readonly maxContextWindow: number;
  readonly maxOutputTokens: number;
  readonly supportsTool = true;
  readonly supportsThinking: boolean;
  readonly supportsVision: boolean;
  readonly supportsPromptCache: boolean;

  private baseUrl: string;
  private apiKey: string;
  private headers: Record<string, string>;
  private timeout: number;
  private maxRetries: number;
  private capabilities: AnthropicModelCapabilities;

  constructor(config: ProviderConfig) {
    this.model = config.model;
    this.apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY || '';
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com';
    this.headers = config.headers || {};
    this.timeout = config.timeout || 120000;
    this.maxRetries = config.maxRetries || 3;

    this.capabilities = getCapabilities(config.model);
    this.maxContextWindow = this.capabilities.maxContextWindow;
    this.maxOutputTokens = this.capabilities.maxOutputTokens;
    this.supportsThinking = this.capabilities.supportsThinking;
    this.supportsVision = this.capabilities.supportsVision;
    this.supportsPromptCache = this.capabilities.supportsPromptCache;
  }

  /**
   * 流式聊天
   */
  async *chatStream(params: ChatParams): AsyncGenerator<StreamEvent, void, unknown> {
    const body = this.buildRequestBody(params);

    const response = await this.fetchWithRetry(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        ...this.headers,
      },
      body: JSON.stringify({ ...body, stream: true }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      yield { type: 'error', error: new Error(`Anthropic API error ${response.status}: ${errorText}`) };
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
    let messageId = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;

    // 当前工具调用状态
    let currentToolId = '';
    let currentToolName = '';
    let currentToolInput = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();

          if (trimmed.startsWith('event: ')) {
            // 事件类型行，下一行是 data
            continue;
          }

          if (!trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (!data) continue;

          try {
            const event = JSON.parse(data);

            switch (event.type) {
              case 'message_start': {
                messageId = event.message?.id || `msg_${Date.now()}`;
                const usage = event.message?.usage;
                if (usage) {
                  inputTokens = usage.input_tokens || 0;
                  cacheReadTokens = usage.cache_read_input_tokens || 0;
                  cacheCreationTokens = usage.cache_creation_input_tokens || 0;
                }
                yield { type: 'message_start', messageId };
                break;
              }

              case 'content_block_start': {
                const block = event.content_block;
                if (block?.type === 'tool_use') {
                  currentToolId = block.id;
                  currentToolName = block.name;
                  currentToolInput = '';
                  yield { type: 'tool_use_start', id: block.id, name: block.name };
                }
                break;
              }

              case 'content_block_delta': {
                const delta = event.delta;
                if (delta?.type === 'text_delta') {
                  yield { type: 'text_delta', text: delta.text };
                } else if (delta?.type === 'thinking_delta') {
                  yield { type: 'thinking_delta', text: delta.thinking };
                } else if (delta?.type === 'input_json_delta') {
                  currentToolInput += delta.partial_json || '';
                  yield { type: 'tool_use_delta', id: currentToolId, input: delta.partial_json || '' };
                }
                break;
              }

              case 'content_block_stop': {
                if (currentToolId) {
                  let parsedInput: Record<string, unknown> = {};
                  try {
                    parsedInput = JSON.parse(currentToolInput || '{}');
                  } catch {
                    parsedInput = { _raw: currentToolInput };
                  }
                  yield {
                    type: 'tool_use_end',
                    id: currentToolId,
                    name: currentToolName,
                    input: parsedInput,
                  };
                  currentToolId = '';
                  currentToolName = '';
                  currentToolInput = '';
                }
                break;
              }

              case 'message_delta': {
                const usage = event.usage;
                if (usage) {
                  outputTokens = usage.output_tokens || 0;
                }
                break;
              }

              case 'message_stop': {
                const finalUsage: TokenUsage = {
                  inputTokens,
                  outputTokens,
                  cacheReadTokens: cacheReadTokens || undefined,
                  cacheCreationTokens: cacheCreationTokens || undefined,
                };
                finalUsage.totalCostUSD = this.calculateCost(finalUsage);
                yield { type: 'message_end', usage: finalUsage };
                break;
              }

              case 'error': {
                yield { type: 'error', error: new Error(event.error?.message || 'Unknown Anthropic error') };
                return;
              }
            }
          } catch {
            // 忽略解析错误
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * 非流式聊天
   */
  async chat(params: ChatParams): Promise<ChatResponse> {
    const body = this.buildRequestBody(params);

    const response = await this.fetchWithRetry(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        ...this.headers,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as Record<string, unknown>;
    return this.parseResponse(data);
  }

  /**
   * 估算 token 数
   */
  estimateTokens(text: string): number {
    // Claude 的 tokenizer 与 GPT 类似但略有不同
    let tokens = 0;
    for (const char of text) {
      if (char.charCodeAt(0) > 127) {
        tokens += 0.67;
      } else {
        tokens += 0.25;
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
    const cacheWriteCost = ((usage.cacheCreationTokens || 0) / 1_000_000) * this.capabilities.cacheWritePricePer1M;
    const cacheReadCost = ((usage.cacheReadTokens || 0) / 1_000_000) * this.capabilities.cacheReadPricePer1M;
    return inputCost + outputCost + cacheWriteCost + cacheReadCost;
  }

  /** 构建请求体 */
  private buildRequestBody(params: ChatParams): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toAnthropicMessages(params.messages),
      max_tokens: params.maxTokens || this.maxOutputTokens,
    };

    // System prompt（支持 Prompt Cache）
    if (params.systemPrompt) {
      if (this.supportsPromptCache) {
        body.system = [
          {
            type: 'text',
            text: params.systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ];
      } else {
        body.system = params.systemPrompt;
      }
    }

    // 工具定义
    if (params.tools && params.tools.length > 0) {
      body.tools = toAnthropicTools(params.tools);
    }

    // Extended Thinking
    if (params.thinking && this.supportsThinking) {
      body.thinking = {
        type: 'enabled',
        budget_tokens: params.thinkingBudget || 10000,
      };
    }

    if (params.temperature !== undefined) {
      body.temperature = params.temperature;
    }

    if (params.topP !== undefined) {
      body.top_p = params.topP;
    }

    if (params.stop) {
      body.stop_sequences = params.stop;
    }

    return body;
  }

  /** 解析非流式响应 */
  private parseResponse(data: Record<string, unknown>): ChatResponse {
    const contentBlocks = data.content as Array<Record<string, unknown>>;
    const usage = data.usage as Record<string, number>;

    const content: ContentBlock[] = [];
    for (const block of contentBlocks || []) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text as string });
      } else if (block.type === 'tool_use') {
        content.push({
          type: 'tool_use',
          id: block.id as string,
          name: block.name as string,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    const tokenUsage: TokenUsage = {
      inputTokens: usage?.input_tokens || 0,
      outputTokens: usage?.output_tokens || 0,
      cacheReadTokens: usage?.cache_read_input_tokens || undefined,
      cacheCreationTokens: usage?.cache_creation_input_tokens || undefined,
    };
    tokenUsage.totalCostUSD = this.calculateCost(tokenUsage);

    const stopReason = (data.stop_reason as string) === 'tool_use' ? 'tool_use' as const
      : (data.stop_reason as string) === 'max_tokens' ? 'max_tokens' as const
      : 'end_turn' as const;

    return {
      id: data.id as string || `msg_${Date.now()}`,
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
