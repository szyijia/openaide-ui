# LLM Provider API

LLM Provider 是openAIDE与各大语言模型服务商之间的抽象层，提供统一的接口调用不同模型。

## 概述

openAIDE通过 Provider 模式封装不同 LLM 服务商的 API 差异，让上层代码无需关心底层实现细节。

```typescript
import { createProvider } from '@openaide/core';

const provider = createProvider({
  name: 'anthropic',
  apiKey: 'sk-ant-xxx',
  model: 'claude-sonnet-4-20250514',
});
```

## 支持的 Provider

| Provider | 模型 | 特点 | 环境变量 |
|----------|------|------|---------|
| `anthropic` | Claude 3.5 Haiku / Sonnet 4 | 最强综合能力，支持思考模式 | `ANTHROPIC_API_KEY` |
| `openai` | GPT-4o / GPT-4.1 | 广泛兼容，生态丰富 | `OPENAI_API_KEY` |
| `deepseek` | DeepSeek V3 / R1 | 高性价比，中文优化 | `DEEPSEEK_API_KEY` |
| `glm` | GLM-4 / GLM-4-Flash | 中文场景优化，免费额度 | `GLM_API_KEY` |
| `qwen` | 通义千问 | 阿里云，多模态 | `DASHSCOPE_API_KEY` |
| `ollama` | Llama / Mistral / 本地模型 | 离线可用，隐私安全 | — |

## Provider 接口

### `createProvider(config)`

创建 LLM Provider 实例。

```typescript
interface ProviderConfig {
  /** Provider 名称 */
  name: 'anthropic' | 'openai' | 'deepseek' | 'glm' | 'qwen' | 'ollama';
  /** API Key */
  apiKey?: string;
  /** 模型名称 */
  model: string;
  /** 自定义 API 基础 URL */
  baseUrl?: string;
  /** 请求超时 (ms) */
  timeout?: number;
  /** 最大重试次数 */
  maxRetries?: number;
}

const provider = createProvider({
  name: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-sonnet-4-20250514',
  timeout: 60000,
  maxRetries: 3,
});
```

### `createProviderFromEnv(name)`

从环境变量自动创建 Provider。

```typescript
// 自动读取 ANTHROPIC_API_KEY 环境变量
const provider = createProviderFromEnv('anthropic');
```

### Provider 方法

#### `chat(params): AsyncGenerator<StreamEvent>`

发送对话请求，返回流式事件生成器。

```typescript
interface ChatParams {
  /** 消息列表 */
  messages: ChatMessage[];
  /** 系统提示词 */
  systemPrompt?: string;
  /** 可用工具定义 */
  tools?: ToolDefinition[];
  /** 最大输出 Token */
  maxTokens?: number;
  /** 温度参数 (0-1) */
  temperature?: number;
  /** 是否启用思考模式 */
  thinking?: boolean;
  /** 取消信号 */
  signal?: AbortSignal;
}

// 流式调用
for await (const event of provider.chat({
  messages: [{ role: 'user', content: '你好' }],
  maxTokens: 4096,
})) {
  switch (event.type) {
    case 'text':
      process.stdout.write(event.content);
      break;
    case 'tool_use':
      console.log(`工具调用: ${event.name}`, event.input);
      break;
    case 'usage':
      console.log(`Token: ${event.inputTokens} / ${event.outputTokens}`);
      break;
  }
}
```

#### `countTokens(text): number`

估算文本的 Token 数量。

```typescript
const tokens = provider.countTokens('Hello, world!');
console.log(tokens); // ~4
```

### Provider 属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | Provider 名称 |
| `maxContextWindow` | `number` | 最大上下文窗口 (Token) |
| `supportsTool` | `boolean` | 是否支持工具调用 |
| `supportsThinking` | `boolean` | 是否支持思考模式 |
| `supportsVision` | `boolean` | 是否支持图片输入 |

## 流式事件类型

```typescript
type StreamEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheRead?: number }
  | { type: 'error'; error: string }
  | { type: 'done' };
```

## 消息格式

```typescript
interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
```

## 自定义 Provider

你可以实现自定义 Provider 来接入其他 LLM 服务：

```typescript
import type { LLMProvider, ChatParams, StreamEvent } from '@openaide/core';

class MyProvider implements LLMProvider {
  name = 'my-provider';
  maxContextWindow = 128000;
  supportsTool = true;
  supportsThinking = false;
  supportsVision = false;

  async *chat(params: ChatParams): AsyncGenerator<StreamEvent> {
    // 实现你的 API 调用逻辑
    const response = await fetch('https://my-api.com/chat', {
      method: 'POST',
      body: JSON.stringify(params),
    });

    // 解析流式响应并 yield 事件
    yield { type: 'text', content: 'Hello from my provider!' };
    yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
    yield { type: 'done' };
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
```

## 模型路由

详见 [核心引擎 — ModelRouter](/api/core-engine#modelrouter) 章节。
