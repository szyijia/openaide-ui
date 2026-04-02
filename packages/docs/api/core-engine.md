# 核心引擎 API

openAIDE的核心引擎（`@openaide/core`）提供了完整的 AI Agent 能力。

## AgentEngine

Agent 引擎是openAIDE的核心，负责管理 LLM 对话循环、工具调用和上下文管理。

### 创建实例

```typescript
import { AgentEngine } from '@openaide/core';

const engine = new AgentEngine({
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  tools: ['file-read', 'file-write', 'file-edit', 'bash', 'glob', 'grep'],
  systemPrompt: '你是一个专业的编程助手。',
  maxTokens: 8192,
  temperature: 0.7,
});
```

### 配置选项

```typescript
interface AgentConfig {
  /** LLM Provider 名称 */
  provider: string;
  /** 模型名称 */
  model: string;
  /** 启用的工具列表 */
  tools?: string[];
  /** 系统提示词 */
  systemPrompt?: string;
  /** 最大输出 Token 数 */
  maxTokens?: number;
  /** 温度参数 (0-1) */
  temperature?: number;
  /** 工作目录 */
  cwd?: string;
  /** 是否启用流式输出 */
  stream?: boolean;
}
```

### 方法

#### `chat(message, options?)`

发送消息并获取 AI 回复。

```typescript
// 简单对话
const response = await engine.chat('帮我写一个 React 登录组件');

// 流式输出
for await (const event of engine.chatStream('重构这个函数')) {
  switch (event.type) {
    case 'text':
      process.stdout.write(event.content);
      break;
    case 'tool_use':
      console.log(`调用工具: ${event.toolName}`);
      break;
    case 'tool_result':
      console.log(`工具结果: ${event.result}`);
      break;
  }
}
```

#### `cancel()`

取消当前正在进行的请求。

```typescript
engine.cancel();
```

#### `reset()`

重置对话历史和上下文。

```typescript
engine.reset();
```

### 事件

```typescript
type AgentEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolName: string; result: string; isError: boolean }
  | { type: 'thinking'; content: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'error'; error: string }
  | { type: 'done' };
```

## LLM Provider

### 创建 Provider

```typescript
import { createProvider } from '@openaide/core';

// 通过配置创建
const provider = createProvider({
  name: 'anthropic',
  apiKey: 'sk-ant-xxx',
  model: 'claude-sonnet-4-20250514',
});

// 从环境变量创建
import { createProviderFromEnv } from '@openaide/core';
const provider = createProviderFromEnv('anthropic');
```

### Provider 接口

```typescript
interface LLMProvider {
  /** Provider 名称 */
  name: string;
  /** 发送对话请求（流式） */
  chat(params: ChatParams): AsyncGenerator<StreamEvent>;
  /** 计算 Token 数 */
  countTokens(text: string): number;
  /** 最大上下文窗口 */
  maxContextWindow: number;
  /** 是否支持工具调用 */
  supportsTool: boolean;
  /** 是否支持思考模式 */
  supportsThinking: boolean;
}
```

### 支持的 Provider

| Provider | 模型 | 说明 |
|----------|------|------|
| `anthropic` | Claude 3.5/4 系列 | 最强综合能力 |
| `openai` | GPT-4o/4.1 系列 | 广泛兼容 |
| `deepseek` | DeepSeek V3/R1 | 高性价比 |
| `glm` | GLM-4 系列 | 中文优化 |
| `ollama` | 本地模型 | 离线可用 |

## ModelRouter

智能模型路由器，根据任务类型自动选择最优模型。

```typescript
import { ModelRouter } from '@openaide/core';

const router = new ModelRouter({
  budget: { dailyLimitUSD: 10 },
  models: [
    { provider: 'anthropic', model: 'claude-sonnet-4-20250514', tier: 'primary' },
    { provider: 'deepseek', model: 'deepseek-chat', tier: 'fast' },
    { provider: 'glm', model: 'glm-4-flash', tier: 'economy' },
  ],
});

// 自动路由
const decision = router.route('帮我重构这个复杂的类');
console.log(decision.model);    // 'claude-sonnet-4-20250514'
console.log(decision.reason);   // '复杂重构任务，使用主力模型'
```

### 任务分类

路由器支持 12 种任务类型：

| 任务类型 | 推荐模型层级 | 示例 |
|----------|-------------|------|
| `code-generation` | primary | 生成新代码 |
| `code-review` | primary | 代码审查 |
| `refactoring` | primary | 重构 |
| `debugging` | primary | 调试 |
| `explanation` | standard | 解释代码 |
| `documentation` | standard | 写文档 |
| `testing` | standard | 写测试 |
| `simple-edit` | fast | 简单修改 |
| `formatting` | economy | 格式化 |
| `translation` | fast | 翻译 |
| `chat` | fast | 闲聊 |
| `unknown` | standard | 未知 |

## ToolRegistry

工具注册表，管理所有可用工具。

```typescript
import { ToolRegistry, FileReadTool, BashTool } from '@openaide/core';

const registry = new ToolRegistry();

// 注册工具
registry.register(new FileReadTool());
registry.register(new BashTool());

// 查找工具
const tool = registry.get('file-read');

// 列出所有工具
const tools = registry.list();

// 执行工具
const result = await registry.execute('file-read', {
  path: '/path/to/file.ts',
});
```

## 更多 API

- [LLM Provider 详细文档](/api/llm-provider)
- [工具系统](/api/tool-system)
- [MCP 客户端](/api/mcp-client)
- [记忆管理](/api/memory-manager)
- [会话管理](/api/session-manager)
- [认证服务](/api/auth-service)
- [云同步](/api/cloud-sync)
