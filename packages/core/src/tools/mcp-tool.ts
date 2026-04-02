/**
 * MCPTool — MCP 工具调用代理
 *
 * 参考 Claude Code: src/tools/MCPTool/
 * 作为 Agent 直接调用 MCP 服务器工具的代理层
 *
 * 与 AgentEngine 中内置的 mcp__ 前缀工具不同，MCPTool 提供了一个
 * 通用的 "use_mcp_tool" 工具，让 Agent 可以动态发现和调用 MCP 工具，
 * 而不需要预先注册所有 MCP 工具到工具列表中。
 *
 * 使用场景：
 * - 动态发现 MCP 服务器提供的工具
 * - 调用 MCP 工具并获取结果
 * - 列出可用的 MCP 服务器和工具
 */

import type { Tool, ToolResult, ToolPermission, ToolContext } from './types.js';
import type { MCPConnectionManager, MCPToolInfo } from '../mcp/client.js';

/**
 * 创建 MCPTool
 *
 * @param mcpManager - MCP 连接管理器实例
 */
export function createMCPTool(mcpManager: MCPConnectionManager): Tool {
  return {
    name: 'use_mcp_tool',
    description: '调用 MCP 服务器提供的工具',

    prompt: `调用已连接的 MCP (Model Context Protocol) 服务器提供的工具。

使用方法：
1. 指定 server_name（MCP 服务器名称）
2. 指定 tool_name（要调用的工具名称）
3. 提供 arguments（工具所需的参数，JSON 对象）

如果不确定可用的服务器和工具，可以使用 action: "list" 来列出。

操作类型：
- call（默认）: 调用指定的 MCP 工具
- list: 列出所有可用的 MCP 服务器和工具
- list_tools: 列出指定服务器的所有工具

注意事项：
- 确保 MCP 服务器已连接
- 参数必须符合工具的输入 Schema
- 工具调用可能需要一些时间，请耐心等待`,

    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['call', 'list', 'list_tools'],
          description: '操作类型（默认 call）',
        },
        server_name: {
          type: 'string',
          description: 'MCP 服务器名称（call 和 list_tools 时必需）',
        },
        tool_name: {
          type: 'string',
          description: '要调用的工具名称（call 时必需）',
        },
        arguments: {
          type: 'object',
          description: '工具参数（JSON 对象）',
        },
      },
      required: [],
    },

    permission: {
      default: 'ask_user',
      userConfigurable: true,
      riskWarning: '将调用外部 MCP 服务器工具',
    } as ToolPermission,

    concurrentSafe: true, // MCP 工具调用可以并行

    async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const action = (input.action as string) || 'call';
      const serverName = input.server_name as string | undefined;
      const toolName = input.tool_name as string | undefined;
      const args = (input.arguments as Record<string, unknown>) || {};

      switch (action) {
        case 'list': {
          return listAllServersAndTools(mcpManager);
        }

        case 'list_tools': {
          if (!serverName) {
            return { content: 'Error: server_name is required for list_tools action', isError: true };
          }
          return listServerTools(mcpManager, serverName);
        }

        case 'call': {
          if (!serverName) {
            return { content: 'Error: server_name is required for call action', isError: true };
          }
          if (!toolName) {
            return { content: 'Error: tool_name is required for call action', isError: true };
          }
          return callMCPTool(mcpManager, serverName, toolName, args, context.abortSignal);
        }

        default:
          return {
            content: `Error: Unknown action "${action}". Valid actions: call, list, list_tools`,
            isError: true,
          };
      }
    },
  };
}

// ─── 辅助函数 ───

/** 列出所有 MCP 服务器和工具 */
function listAllServersAndTools(mcpManager: MCPConnectionManager): ToolResult {
  const servers = mcpManager.getServers();

  if (servers.length === 0) {
    return {
      content: '当前没有已连接的 MCP 服务器。\n\n请先在 .mcp.json 中配置 MCP 服务器，或通过 MCP 面板添加。',
    };
  }

  const lines: string[] = [`已连接 ${mcpManager.connectedCount} 个 MCP 服务器 (共 ${mcpManager.totalToolCount} 个工具):\n`];

  for (const server of servers) {
    const statusIcon = server.status === 'connected' ? '🟢' : server.status === 'connecting' ? '🟡' : '🔴';
    lines.push(`${statusIcon} **${server.name}** [${server.status}]`);

    if (server.serverInfo) {
      lines.push(`   服务器: ${server.serverInfo.name} v${server.serverInfo.version}`);
    }

    if (server.error) {
      lines.push(`   错误: ${server.error}`);
    }

    if (server.status === 'connected') {
      const tools = mcpManager.getToolsForServer(server.name);
      if (tools.length > 0) {
        lines.push(`   工具 (${tools.length}):`);
        for (const tool of tools) {
          lines.push(`     - ${tool.name}: ${tool.description || '(无描述)'}`);
        }
      }
    }

    lines.push('');
  }

  return {
    content: lines.join('\n'),
    metadata: {
      serverCount: servers.length,
      connectedCount: mcpManager.connectedCount,
      totalToolCount: mcpManager.totalToolCount,
    },
  };
}

/** 列出指定服务器的工具 */
function listServerTools(mcpManager: MCPConnectionManager, serverName: string): ToolResult {
  const tools = mcpManager.getToolsForServer(serverName);

  if (tools.length === 0) {
    const servers = mcpManager.getServers();
    const server = servers.find(s => s.name === serverName);

    if (!server) {
      return {
        content: `Error: MCP 服务器 "${serverName}" 不存在。\n可用的服务器: ${servers.map(s => s.name).join(', ') || '(无)'}`,
        isError: true,
      };
    }

    if (server.status !== 'connected') {
      return {
        content: `MCP 服务器 "${serverName}" 当前状态: ${server.status}${server.error ? ` (${server.error})` : ''}`,
        isError: true,
      };
    }

    return { content: `MCP 服务器 "${serverName}" 没有提供任何工具。` };
  }

  const lines: string[] = [`MCP 服务器 "${serverName}" 提供 ${tools.length} 个工具:\n`];

  for (const tool of tools) {
    lines.push(`### ${tool.name}`);
    lines.push(tool.description || '(无描述)');

    // 显示参数 Schema
    const schema = tool.inputSchema;
    if (schema && typeof schema === 'object' && 'properties' in schema) {
      const props = schema.properties as Record<string, { type?: string; description?: string }>;
      const required = (schema as { required?: string[] }).required || [];
      const paramLines: string[] = [];

      for (const [name, prop] of Object.entries(props)) {
        const isRequired = required.includes(name);
        const typeStr = prop.type || 'any';
        const desc = prop.description || '';
        paramLines.push(`  - ${name} (${typeStr}${isRequired ? ', 必需' : ''}): ${desc}`);
      }

      if (paramLines.length > 0) {
        lines.push('参数:');
        lines.push(...paramLines);
      }
    }

    lines.push('');
  }

  return {
    content: lines.join('\n'),
    metadata: { serverName, toolCount: tools.length },
  };
}

/** 调用 MCP 工具 */
async function callMCPTool(
  mcpManager: MCPConnectionManager,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  abortSignal: AbortSignal,
): Promise<ToolResult> {
  // 验证服务器存在且已连接
  const servers = mcpManager.getServers();
  const server = servers.find(s => s.name === serverName);

  if (!server) {
    return {
      content: `Error: MCP 服务器 "${serverName}" 不存在。\n可用的服务器: ${servers.map(s => s.name).join(', ') || '(无)'}`,
      isError: true,
    };
  }

  if (server.status !== 'connected') {
    return {
      content: `Error: MCP 服务器 "${serverName}" 未连接 (当前状态: ${server.status})`,
      isError: true,
    };
  }

  // 验证工具存在
  const tools = mcpManager.getToolsForServer(serverName);
  const tool = tools.find(t => t.name === toolName);

  if (!tool) {
    return {
      content: `Error: MCP 服务器 "${serverName}" 没有名为 "${toolName}" 的工具。\n可用的工具: ${tools.map(t => t.name).join(', ') || '(无)'}`,
      isError: true,
    };
  }

  // 调用工具
  const result = await mcpManager.callTool(serverName, toolName, args, abortSignal);

  return {
    content: result.content,
    isError: result.isError,
    metadata: {
      serverName,
      toolName,
      arguments: args,
    },
  };
}
