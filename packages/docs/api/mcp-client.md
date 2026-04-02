# MCP 客户端 API

MCP（Model Context Protocol）客户端实现了完整的 MCP 协议，支持连接多个 MCP 服务器并统一管理。

## 概述

```typescript
import { MCPClient } from '@openaide/core';

const mcp = new MCPClient();

// 连接服务器
await mcp.connect({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/dir'],
}, 'filesystem');

// 列出工具
const tools = mcp.listTools();
console.log(tools);

// 调用工具
const result = await mcp.callTool('read_file', { path: '/path/to/file.txt' });
console.log(result.content);

// 断开连接
await mcp.disconnect();
```

## MCPClient

### 构造函数

```typescript
const mcp = new MCPClient();
```

### 方法

#### `connect(config, name?)`

连接到 MCP 服务器。

```typescript
interface MCPServerConfig {
  /** 传输方式 */
  transport: 'stdio' | 'sse' | 'streamable-http';
  /** 命令（stdio 模式） */
  command?: string;
  /** 命令参数（stdio 模式） */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
  /** URL（SSE / HTTP 模式） */
  url?: string;
  /** 自动重连 */
  autoReconnect?: boolean;
  /** 重连间隔 (ms) */
  reconnectInterval?: number;
}

// stdio 模式（最常用）
await mcp.connect({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/user'],
}, 'filesystem');

// SSE 模式
await mcp.connect({
  transport: 'sse',
  url: 'http://localhost:3000/sse',
}, 'my-server');
```

#### `loadFromConfig(configPath?)`

从配置文件加载并连接所有服务器。

```typescript
// 默认读取 .openaide/mcp.json
await mcp.loadFromConfig();

// 或指定路径
await mcp.loadFromConfig('/path/to/mcp.json');
```

配置文件格式：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"],
      "env": {}
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_xxx"
      }
    }
  }
}
```

#### `listTools(): MCPToolInfo[]`

获取所有服务器提供的工具列表。

```typescript
interface MCPToolInfo {
  /** 工具名称 */
  name: string;
  /** 工具描述 */
  description: string;
  /** 参数 Schema */
  inputSchema: Record<string, unknown>;
  /** 所属服务器名称 */
  serverName: string;
}

const tools = mcp.listTools();
for (const tool of tools) {
  console.log(`${tool.serverName}/${tool.name}: ${tool.description}`);
}
```

#### `callTool(name, input, signal?)`

调用 MCP 工具（自动路由到正确的服务器）。

```typescript
interface MCPToolCallResult {
  /** 结果内容 */
  content: string;
  /** 是否为错误 */
  isError: boolean;
}

const result = await mcp.callTool('read_file', {
  path: '/path/to/file.txt',
});

if (result.isError) {
  console.error('工具调用失败:', result.content);
} else {
  console.log(result.content);
}
```

#### `listResources(): MCPResourceInfo[]`

获取所有服务器提供的资源列表。

```typescript
interface MCPResourceInfo {
  /** 资源 URI */
  uri: string;
  /** 资源名称 */
  name: string;
  /** 资源描述 */
  description?: string;
  /** MIME 类型 */
  mimeType?: string;
  /** 所属服务器 */
  serverName: string;
}

const resources = mcp.listResources();
```

#### `readResource(uri)`

读取指定资源。

```typescript
const resource = await mcp.readResource('file:///path/to/file.txt');
if (resource) {
  console.log(resource.content);
  console.log(resource.mimeType); // 'text/plain'
}
```

#### `getInstructions(): string[]`

获取所有服务器的 instructions（服务器自定义的提示词）。

```typescript
const instructions = mcp.getInstructions();
// 可以拼接到 System Prompt 中
```

#### `disconnect()`

断开所有服务器连接。

```typescript
await mcp.disconnect();
```

### 属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `connectedCount` | `number` | 已连接的服务器数量 |
| `totalToolCount` | `number` | 所有服务器提供的工具总数 |

## MCPConnectionManager

底层连接管理器，提供更细粒度的控制。

```typescript
const manager = mcp.getManager();

// 连接单个服务器
await manager.connect('my-server', config);

// 断开单个服务器
await manager.disconnect('my-server');

// 获取服务器状态
const status = manager.getServerStatus('my-server');
// { connected: true, tools: 5, resources: 2 }

// 获取所有服务器状态
const allStatus = manager.getAllServerStatus();
```

## MCP Marketplace

MCP 服务器市场，提供一键安装和管理。

```typescript
import { MCPMarketplace } from '@openaide/core';

const marketplace = new MCPMarketplace();

// 搜索服务器
const results = marketplace.searchServers('database');

// 按分类浏览
const dbServers = marketplace.getServersByCategory('database');

// 安装服务器
await marketplace.installServer('sqlite');

// 带环境变量安装
await marketplace.installServer('postgres', {
  POSTGRES_URL: 'postgresql://localhost/mydb',
});

// 获取启动配置
const config = marketplace.getServerLaunchConfig('sqlite');

// 导出/导入配置
const exported = marketplace.exportConfig();
await marketplace.importConfig(exported);
```

详见 [MCP 协议指南](/guide/mcp)。
