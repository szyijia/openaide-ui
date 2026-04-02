# 工具系统 API

工具系统是openAIDE Agent 与开发环境交互的核心机制。

## 概述

openAIDE内置 9 个核心工具，通过 `ToolRegistry` 统一管理。每个工具实现 `Tool` 接口，支持参数校验、权限检查和结果格式化。

## Tool 接口

```typescript
interface Tool {
  /** 工具名称（唯一标识） */
  name: string;
  /** 工具描述（供 LLM 理解） */
  description: string;
  /** 参数 JSON Schema */
  inputSchema: JSONSchema;
  /** 执行工具 */
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

interface ToolContext {
  /** 当前工作目录 */
  cwd: string;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 权限检查回调 */
  checkPermission?: (action: string) => Promise<boolean>;
}

interface ToolResult {
  /** 结果内容 */
  content: string;
  /** 是否为错误 */
  isError: boolean;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}
```

## ToolRegistry

工具注册表，管理所有可用工具。

### 创建和注册

```typescript
import { ToolRegistry } from '@openaide/core';

const registry = new ToolRegistry();

// 注册内置工具
registry.registerDefaults();

// 或手动注册
import { FileReadTool, BashTool } from '@openaide/core';
registry.register(new FileReadTool());
registry.register(new BashTool());
```

### 方法

#### `register(tool)`

注册一个工具。

```typescript
registry.register(myCustomTool);
```

#### `get(name): Tool | undefined`

获取指定名称的工具。

```typescript
const tool = registry.get('file-read');
```

#### `list(): Tool[]`

列出所有已注册的工具。

```typescript
const tools = registry.list();
console.log(tools.map(t => t.name));
// ['file-read', 'file-write', 'file-edit', 'bash', 'glob', 'grep', ...]
```

#### `execute(name, input, context): Promise<ToolResult>`

执行指定工具。

```typescript
const result = await registry.execute('file-read', {
  path: '/path/to/file.ts',
}, { cwd: process.cwd() });

console.log(result.content);
```

#### `getToolDefinitions(): ToolDefinition[]`

获取所有工具的 LLM 工具定义（用于传给 LLM API）。

```typescript
const definitions = registry.getToolDefinitions();
// 可直接传给 provider.chat({ tools: definitions })
```

## 内置工具详情

### FileRead

读取文件内容。

```typescript
// 参数
interface FileReadInput {
  /** 文件绝对路径 */
  path: string;
  /** 起始行号 */
  offset?: number;
  /** 读取行数 */
  limit?: number;
}

// 示例
const result = await registry.execute('file-read', {
  path: '/src/index.ts',
  offset: 1,
  limit: 50,
}, ctx);
```

### FileWrite

创建或覆写文件。

```typescript
interface FileWriteInput {
  /** 文件路径 */
  path: string;
  /** 文件内容 */
  content: string;
}
```

### FileEdit

搜索替换编辑文件。

```typescript
interface FileEditInput {
  /** 文件路径 */
  path: string;
  /** 要替换的旧文本 */
  old_string: string;
  /** 替换后的新文本 */
  new_string: string;
}
```

### Bash

执行 Shell 命令。

```typescript
interface BashInput {
  /** 要执行的命令 */
  command: string;
  /** 超时时间 (ms) */
  timeout?: number;
}
```

### Glob

文件模式匹配搜索。

```typescript
interface GlobInput {
  /** Glob 模式 */
  pattern: string;
  /** 搜索根目录 */
  cwd?: string;
}
```

### Grep

文本内容搜索。

```typescript
interface GrepInput {
  /** 搜索模式（正则表达式） */
  pattern: string;
  /** 搜索路径 */
  path?: string;
  /** 文件类型过滤 */
  include?: string;
}
```

### WebFetch

抓取网页内容。

```typescript
interface WebFetchInput {
  /** URL */
  url: string;
  /** 输出格式 */
  format?: 'text' | 'markdown' | 'html';
}
```

### WebSearch

搜索引擎查询。

```typescript
interface WebSearchInput {
  /** 搜索关键词 */
  query: string;
  /** 结果数量 */
  limit?: number;
}
```

### Agent

创建子 Agent 执行任务。

```typescript
interface AgentInput {
  /** 任务描述 */
  task: string;
  /** 允许使用的工具 */
  tools?: string[];
}
```

## 自定义工具

### 实现 Tool 接口

```typescript
import type { Tool, ToolContext, ToolResult } from '@openaide/core';

const myTool: Tool = {
  name: 'my-tool',
  description: '我的自定义工具',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: '输入消息' },
    },
    required: ['message'],
  },
  async execute(input, context): Promise<ToolResult> {
    const { message } = input as { message: string };
    return {
      content: `处理结果: ${message}`,
      isError: false,
    };
  },
};

registry.register(myTool);
```

### 通过 MCP 添加工具

更推荐的方式是通过 MCP 协议添加工具，详见 [MCP 客户端 API](/api/mcp-client)。
