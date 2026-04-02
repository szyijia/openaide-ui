# Core 引擎 API

## LLM Provider

### `LLMProvider` 接口

所有 LLM 提供者必须实现的统一接口。

```typescript
interface LLMProvider {
  name: string;
  chat(params: ChatParams): AsyncGenerator<StreamEvent>;
  countTokens(text: string): number;
  maxContextWindow: number;
  supportsTool: boolean;
  supportsThinking: boolean;
}
```

### `createProvider(config)`

创建 LLM Provider 实例。

```typescript
import { createProvider } from '@openaide/core';

const provider = createProvider({
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  apiKey: process.env.ANTHROPIC_API_KEY,
});
```

**参数：**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `provider` | `string` | ✅ | 提供者名称：`anthropic` / `openai` / `deepseek` / `glm` / `ollama` |
| `model` | `string` | ✅ | 模型名称 |
| `apiKey` | `string` | ❌ | API Key（也可通过环境变量） |
| `baseUrl` | `string` | ❌ | 自定义 API 端点 |

## Agent Engine

### `AgentEngine`

核心 Agent 引擎，管理对话循环。

```typescript
import { AgentEngine } from '@openaide/core';

const engine = new AgentEngine({
  provider,
  tools: registry,
  systemPrompt: 'You are a helpful assistant.',
  maxTurns: 20,
});

for await (const event of engine.chat('帮我写一个排序算法')) {
  switch (event.type) {
    case 'text':
      process.stdout.write(event.content);
      break;
    case 'tool_use':
      console.log(`调用工具: ${event.name}`);
      break;
    case 'done':
      console.log('完成');
      break;
  }
}
```

## Tool System

### `ToolRegistry`

工具注册表，管理所有可用工具。

```typescript
import { ToolRegistry, FileReadTool, BashTool } from '@openaide/core';

const registry = new ToolRegistry();
registry.register(new FileReadTool());
registry.register(new BashTool());

// 获取工具
const tool = registry.get('file_read');

// 列出所有工具
const tools = registry.list();

// 执行工具
const result = await registry.execute('file_read', {
  path: '/path/to/file.ts',
});
```

### 内置工具列表

| 工具 | 名称 | 说明 |
|------|------|------|
| `FileReadTool` | `file_read` | 读取文件内容 |
| `FileWriteTool` | `file_write` | 写入文件 |
| `FileEditTool` | `file_edit` | 编辑文件（搜索替换） |
| `GlobTool` | `glob` | 文件模式匹配搜索 |
| `GrepTool` | `grep` | 正则表达式搜索 |
| `BashTool` | `bash` | 执行 Bash 命令 |
| `WebFetchTool` | `web_fetch` | 获取网页内容 |
| `WebSearchTool` | `web_search` | 网络搜索 |
| `AgentTool` | `agent` | 创建子 Agent |

## Memory Manager

### `MemoryManager`

记忆管理器，支持 8 种记忆分类。

```typescript
import { MemoryManager } from '@openaide/core';

const memory = new MemoryManager({ projectDir: '/path/to/project' });

// 添加记忆
await memory.add({
  content: '项目使用 React + TypeScript',
  type: 'tech_stack',
  source: 'user',
});

// 搜索记忆
const results = await memory.search('React');

// 获取所有记忆
const all = await memory.getAll();
```

## MCP Client

### `MCPClient`

MCP 协议客户端，连接 MCP 服务器。

```typescript
import { MCPClient } from '@openaide/core';

const client = new MCPClient();

// 连接服务器
await client.connect({
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
});

// 列出工具
const tools = await client.listTools();

// 调用工具
const result = await client.callTool('read_file', {
  path: '/workspace/package.json',
});

// 断开连接
await client.disconnect();
```

## Model Router

### `ModelRouter`

智能模型路由器，根据任务自动选择最佳模型。

```typescript
import { ModelRouter } from '@openaide/core';

const router = new ModelRouter({
  budget: { maxCostPerTask: 0.1 },
});

// 注册模型
router.registerModel({
  id: 'claude-sonnet',
  provider: 'anthropic',
  tier: 'balanced',
  costPer1kTokens: 0.003,
});

// 路由决策
const decision = router.route('帮我重构这个函数');
console.log(decision.model);  // 'claude-sonnet'
console.log(decision.reason); // '代码重构任务，选择 balanced 级别模型'
```
