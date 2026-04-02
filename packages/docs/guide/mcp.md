# MCP 协议

MCP（Model Context Protocol）是一种标准协议，允许 AI 模型与外部工具和数据源交互。openAIDE完整实现了 MCP 协议。

## 什么是 MCP

MCP 定义了三种能力：
- **工具（Tools）** — AI 可以调用的函数
- **资源（Resources）** — AI 可以读取的数据
- **Prompt（提示词）** — 预定义的提示词模板

## 使用 MCP 服务器

### 从 Marketplace 安装

1. 打开 MCP 管理面板（侧边栏 MCP 图标）
2. 点击「浏览市场」
3. 搜索并安装需要的服务器
4. 安装后自动连接

### 手动配置

在项目根目录创建 `.openaide/mcp.json`：

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
      "env": {}
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_xxx"
      }
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": {
        "DATABASE_URL": "postgresql://user:pass@localhost/db"
      }
    }
  }
}
```

## MCP 管理面板

在侧边栏的 MCP 面板中可以：
- 查看所有已配置的服务器
- 连接/断开服务器
- 查看服务器提供的工具列表
- 查看连接状态和日志

## MCP Marketplace

openAIDE内置 MCP 服务器市场，提供：
- 🔍 搜索和发现 MCP 服务器
- 📦 一键安装和配置
- ⭐ 社区评分和评论
- 🏷️ 分类浏览（数据库、API、文件系统、开发工具等）

### 热门 MCP 服务器

| 服务器 | 功能 | 分类 |
|--------|------|------|
| filesystem | 文件系统操作 | 文件系统 |
| github | GitHub API | 开发工具 |
| postgres | PostgreSQL 查询 | 数据库 |
| puppeteer | 浏览器自动化 | 网络 |
| slack | Slack 消息 | 通信 |

## 开发自定义 MCP 服务器

使用 MCP SDK 开发自己的服务器：

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server({
  name: 'my-server',
  version: '1.0.0',
}, {
  capabilities: { tools: {} },
});

server.setRequestHandler('tools/list', async () => ({
  tools: [{
    name: 'my-tool',
    description: '我的自定义工具',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '查询内容' },
      },
      required: ['query'],
    },
  }],
}));

server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args } = request.params;
  if (name === 'my-tool') {
    return { content: [{ type: 'text', text: `结果: ${args.query}` }] };
  }
  throw new Error(`未知工具: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

## 故障排除

### 服务器无法连接

1. 检查命令路径是否正确
2. 检查环境变量是否设置
3. 查看 MCP 面板中的错误日志
4. 尝试在终端中手动运行命令

### 工具调用失败

1. 检查工具参数是否正确
2. 查看服务器日志
3. 确认服务器版本兼容
