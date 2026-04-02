/**
 * MCP (Model Context Protocol) 客户端
 *
 * 参考 Claude Code: src/services/mcp/ (20+ 文件)
 * 基于 @modelcontextprotocol/sdk 实现完整的 MCP 客户端
 *
 * 支持的传输方式：
 * - stdio: 通过子进程的 stdin/stdout 通信（最常用）
 * - SSE: 通过 Server-Sent Events 通信
 * - Streamable HTTP: 通过 HTTP 流式通信
 *
 * 功能：
 * - 连接/断开 MCP 服务器
 * - 列出服务器提供的工具
 * - 调用 MCP 工具
 * - 列出/读取服务器资源
 * - 自动重连
 * - 多服务器管理
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  ServerCapabilities,
  Tool as McpToolSchema,
  Resource,
  CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// ─── 类型定义 ───

/** MCP 服务器传输类型 */
export type MCPTransportType = 'stdio' | 'sse' | 'http';

/** stdio 传输配置 */
export interface MCPStdioConfig {
  type: 'stdio';
  /** 要执行的命令 */
  command: string;
  /** 命令参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
  /** 工作目录 */
  cwd?: string;
}

/** SSE 传输配置 */
export interface MCPSSEConfig {
  type: 'sse';
  /** SSE 服务器 URL */
  url: string;
  /** 自定义请求头 */
  headers?: Record<string, string>;
}

/** HTTP 传输配置 */
export interface MCPHTTPConfig {
  type: 'http';
  /** HTTP 服务器 URL */
  url: string;
  /** 自定义请求头 */
  headers?: Record<string, string>;
}

/** MCP 服务器配置 */
export type MCPServerConfig = MCPStdioConfig | MCPSSEConfig | MCPHTTPConfig;

/** MCP 服务器连接状态 */
export type MCPConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'failed';

/** MCP 工具信息 */
export interface MCPToolInfo {
  /** 工具名称（服务器原始名称） */
  name: string;
  /** 工具描述 */
  description: string;
  /** 输入参数 JSON Schema */
  inputSchema: Record<string, unknown>;
  /** 所属服务器名称 */
  serverName: string;
}

/** MCP 资源信息 */
export interface MCPResourceInfo {
  /** 资源 URI */
  uri: string;
  /** 资源名称 */
  name: string;
  /** 资源描述 */
  description?: string;
  /** MIME 类型 */
  mimeType?: string;
  /** 所属服务器名称 */
  serverName: string;
}

/** MCP 服务器连接信息 */
export interface MCPServerConnection {
  /** 服务器名称 */
  name: string;
  /** 连接状态 */
  status: MCPConnectionStatus;
  /** 服务器配置 */
  config: MCPServerConfig;
  /** 服务器能力 */
  capabilities?: ServerCapabilities;
  /** 服务器信息 */
  serverInfo?: { name: string; version: string };
  /** 服务器指令（instructions） */
  instructions?: string;
  /** 错误信息（如果连接失败） */
  error?: string;
}

/** MCP 工具调用结果 */
export interface MCPToolCallResult {
  /** 结果内容（文本） */
  content: string;
  /** 是否出错 */
  isError: boolean;
  /** 原始结果 */
  raw?: CallToolResult;
}

/** MCP 配置文件格式（.mcp.json） */
export interface MCPJsonConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

// ─── MCP 连接管理器 ───

/**
 * MCP 连接管理器
 *
 * 管理多个 MCP 服务器的连接、工具列表和工具调用。
 * 参考 Claude Code 的 MCPConnectionManager，但简化了认证和 OAuth 部分。
 */
export class MCPConnectionManager {
  /** 活跃的服务器连接 */
  private connections = new Map<string, {
    client: Client;
    transport: Transport;
    config: MCPServerConfig;
    status: MCPConnectionStatus;
    capabilities?: ServerCapabilities;
    serverInfo?: { name: string; version: string };
    instructions?: string;
    error?: string;
    tools: McpToolSchema[];
    resources: Resource[];
  }>();

  /** 事件回调 */
  private onStatusChange?: (serverName: string, status: MCPConnectionStatus, error?: string) => void;
  private onToolsChanged?: (serverName: string, tools: MCPToolInfo[]) => void;

  constructor(options?: {
    onStatusChange?: (serverName: string, status: MCPConnectionStatus, error?: string) => void;
    onToolsChanged?: (serverName: string, tools: MCPToolInfo[]) => void;
  }) {
    this.onStatusChange = options?.onStatusChange;
    this.onToolsChanged = options?.onToolsChanged;
  }

  /**
   * 连接到一个 MCP 服务器
   */
  async connect(name: string, config: MCPServerConfig): Promise<void> {
    // 如果已连接，先断开
    if (this.connections.has(name)) {
      await this.disconnect(name);
    }

    const connInfo = {
      client: null as unknown as Client,
      transport: null as unknown as Transport,
      config,
      status: 'connecting' as MCPConnectionStatus,
      capabilities: undefined as ServerCapabilities | undefined,
      serverInfo: undefined as { name: string; version: string } | undefined,
      instructions: undefined as string | undefined,
      error: undefined as string | undefined,
      tools: [] as McpToolSchema[],
      resources: [] as Resource[],
    };

    this.connections.set(name, connInfo);
    this.onStatusChange?.(name, 'connecting');

    try {
      // 创建传输层
      const transport = this.createTransport(config);
      connInfo.transport = transport;

      // 创建 MCP Client
      const client = new Client(
        { name: 'openaide-ide', version: '0.1.0' },
        {
          capabilities: {},
        },
      );
      connInfo.client = client;

      // 连接
      await client.connect(transport);

      // 获取服务器信息
      connInfo.capabilities = client.getServerCapabilities();
      const serverVersion = client.getServerVersion();
      if (serverVersion) {
        connInfo.serverInfo = {
          name: serverVersion.name,
          version: serverVersion.version,
        };
      }
      connInfo.instructions = client.getInstructions();

      // 获取工具列表
      if (connInfo.capabilities?.tools) {
        try {
          const toolsResult = await client.listTools();
          connInfo.tools = toolsResult.tools;
        } catch (e) {
          console.warn(`[MCP] 获取 ${name} 工具列表失败:`, e);
        }
      }

      // 获取资源列表
      if (connInfo.capabilities?.resources) {
        try {
          const resourcesResult = await client.listResources();
          connInfo.resources = resourcesResult.resources;
        } catch (e) {
          console.warn(`[MCP] 获取 ${name} 资源列表失败:`, e);
        }
      }

      connInfo.status = 'connected';
      this.onStatusChange?.(name, 'connected');

      // 通知工具变更
      if (connInfo.tools.length > 0) {
        this.onToolsChanged?.(name, this.getToolsForServer(name));
      }

      console.log(
        `[MCP] 已连接到 ${name}` +
        (connInfo.serverInfo ? ` (${connInfo.serverInfo.name} v${connInfo.serverInfo.version})` : '') +
        ` — ${connInfo.tools.length} 个工具, ${connInfo.resources.length} 个资源`,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      connInfo.status = 'failed';
      connInfo.error = errorMsg;
      this.onStatusChange?.(name, 'failed', errorMsg);
      console.error(`[MCP] 连接 ${name} 失败:`, errorMsg);
      throw error;
    }
  }

  /**
   * 断开一个 MCP 服务器
   */
  async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;

    try {
      await conn.client?.close();
    } catch (e) {
      // 忽略关闭错误
    }

    try {
      await conn.transport?.close();
    } catch (e) {
      // 忽略关闭错误
    }

    this.connections.delete(name);
    this.onStatusChange?.(name, 'disconnected');
    console.log(`[MCP] 已断开 ${name}`);
  }

  /**
   * 断开所有服务器
   */
  async disconnectAll(): Promise<void> {
    const names = Array.from(this.connections.keys());
    await Promise.allSettled(names.map((name) => this.disconnect(name)));
  }

  /**
   * 从配置文件加载并连接所有服务器
   */
  async loadFromConfig(configPath?: string): Promise<void> {
    const config = await loadMCPConfig(configPath);
    if (!config) return;

    const entries = Object.entries(config.mcpServers);
    console.log(`[MCP] 从配置加载 ${entries.length} 个服务器...`);

    // 并行连接所有服务器
    await Promise.allSettled(
      entries.map(([name, serverConfig]) => this.connect(name, serverConfig)),
    );
  }

  /**
   * 调用 MCP 工具
   */
  async callTool(
    serverName: string,
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MCPToolCallResult> {
    const conn = this.connections.get(serverName);
    if (!conn || conn.status !== 'connected') {
      return {
        content: `Error: MCP 服务器 "${serverName}" 未连接`,
        isError: true,
      };
    }

    try {
      const result = await conn.client.callTool(
        { name: toolName, arguments: input },
        undefined,
        signal ? { signal } : undefined,
      );

      // 提取文本内容
      const textParts: string[] = [];
      if (Array.isArray(result.content)) {
        for (const block of result.content) {
          if (typeof block === 'object' && block !== null) {
            if ('text' in block && typeof block.text === 'string') {
              textParts.push(block.text);
            } else if ('type' in block && block.type === 'text' && 'text' in block) {
              textParts.push(String(block.text));
            } else if ('type' in block && block.type === 'image') {
              textParts.push('[图片内容]');
            } else if ('type' in block && block.type === 'resource') {
              textParts.push(`[资源: ${('resource' in block && typeof block.resource === 'object' && block.resource !== null && 'uri' in block.resource) ? block.resource.uri : 'unknown'}]`);
            }
          }
        }
      }

      const content = textParts.join('\n') || '(无输出)';

      return {
        content,
        isError: result.isError === true,
        raw: result as CallToolResult,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        content: `Error calling MCP tool "${toolName}" on "${serverName}": ${errorMsg}`,
        isError: true,
      };
    }
  }

  /**
   * 读取 MCP 资源
   */
  async readResource(
    serverName: string,
    uri: string,
  ): Promise<{ content: string; mimeType?: string } | null> {
    const conn = this.connections.get(serverName);
    if (!conn || conn.status !== 'connected') return null;

    try {
      const result = await conn.client.readResource({ uri });
      const textParts: string[] = [];
      let mimeType: string | undefined;

      if (Array.isArray(result.contents)) {
        for (const content of result.contents) {
          if ('text' in content && typeof content.text === 'string') {
            textParts.push(content.text);
          }
          if ('mimeType' in content && typeof content.mimeType === 'string') {
            mimeType = content.mimeType;
          }
        }
      }

      return { content: textParts.join('\n'), mimeType };
    } catch (error) {
      console.error(`[MCP] 读取资源失败 (${serverName}/${uri}):`, error);
      return null;
    }
  }

  // ─── 查询方法 ───

  /** 获取所有已连接服务器的信息 */
  getServers(): MCPServerConnection[] {
    return Array.from(this.connections.entries()).map(([name, conn]) => ({
      name,
      status: conn.status,
      config: conn.config,
      capabilities: conn.capabilities,
      serverInfo: conn.serverInfo,
      instructions: conn.instructions,
      error: conn.error,
    }));
  }

  /** 获取所有可用工具（跨所有已连接服务器） */
  getAllTools(): MCPToolInfo[] {
    const tools: MCPToolInfo[] = [];
    for (const [name, conn] of this.connections) {
      if (conn.status === 'connected') {
        tools.push(...this.getToolsForServer(name));
      }
    }
    return tools;
  }

  /** 获取指定服务器的工具列表 */
  getToolsForServer(serverName: string): MCPToolInfo[] {
    const conn = this.connections.get(serverName);
    if (!conn) return [];

    return conn.tools.map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: (tool.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
      serverName,
    }));
  }

  /** 获取所有可用资源（跨所有已连接服务器） */
  getAllResources(): MCPResourceInfo[] {
    const resources: MCPResourceInfo[] = [];
    for (const [name, conn] of this.connections) {
      if (conn.status === 'connected') {
        for (const res of conn.resources) {
          resources.push({
            uri: res.uri,
            name: res.name,
            description: res.description,
            mimeType: res.mimeType,
            serverName: name,
          });
        }
      }
    }
    return resources;
  }

  /** 获取所有服务器的 instructions（用于注入 System Prompt） */
  getInstructions(): string[] {
    const instructions: string[] = [];
    for (const [, conn] of this.connections) {
      if (conn.status === 'connected' && conn.instructions) {
        instructions.push(conn.instructions);
      }
    }
    return instructions;
  }

  /** 查找工具所属的服务器 */
  findToolServer(toolName: string): string | null {
    for (const [name, conn] of this.connections) {
      if (conn.status === 'connected') {
        if (conn.tools.some((t) => t.name === toolName)) {
          return name;
        }
      }
    }
    return null;
  }

  /** 已连接的服务器数量 */
  get connectedCount(): number {
    let count = 0;
    for (const conn of this.connections.values()) {
      if (conn.status === 'connected') count++;
    }
    return count;
  }

  /** 总工具数量 */
  get totalToolCount(): number {
    let count = 0;
    for (const conn of this.connections.values()) {
      if (conn.status === 'connected') count += conn.tools.length;
    }
    return count;
  }

  // ─── 私有方法 ───

  /**
   * 根据配置创建传输层
   */
  private createTransport(config: MCPServerConfig): Transport {
    switch (config.type) {
      case 'stdio':
        return new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          env: {
            ...process.env,
            ...config.env,
          } as Record<string, string>,
          cwd: config.cwd,
        });

      case 'sse':
        return new SSEClientTransport(
          new URL(config.url),
          {
            requestInit: config.headers
              ? { headers: config.headers }
              : undefined,
          },
        );

      case 'http':
        return new StreamableHTTPClientTransport(
          new URL(config.url),
          {
            requestInit: config.headers
              ? { headers: config.headers }
              : undefined,
          },
        );

      default:
        throw new Error(`不支持的 MCP 传输类型: ${(config as MCPServerConfig).type}`);
    }
  }
}

// ─── 配置文件加载 ───

/**
 * 加载 MCP 配置
 *
 * 搜索顺序：
 * 1. 指定路径
 * 2. 当前目录的 .mcp.json
 * 3. ~/.openaide/mcp.json（全局配置）
 */
export async function loadMCPConfig(configPath?: string): Promise<MCPJsonConfig | null> {
  const paths: string[] = [];

  if (configPath) {
    paths.push(configPath);
  } else {
    // 当前目录
    paths.push(path.join(process.cwd(), '.mcp.json'));
    // 全局配置
    paths.push(path.join(os.homedir(), '.openaide', 'mcp.json'));
  }

  for (const p of paths) {
    try {
      const content = await fs.readFile(p, 'utf-8');
      const config = JSON.parse(content) as MCPJsonConfig;

      if (config.mcpServers && typeof config.mcpServers === 'object') {
        console.log(`[MCP] 加载配置: ${p} (${Object.keys(config.mcpServers).length} 个服务器)`);
        return config;
      }
    } catch {
      // 文件不存在或解析失败，继续尝试下一个
    }
  }

  return null;
}

/**
 * 保存 MCP 配置到项目目录
 */
export async function saveMCPConfig(
  config: MCPJsonConfig,
  configPath?: string,
): Promise<void> {
  const targetPath = configPath || path.join(process.cwd(), '.mcp.json');
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

// ─── 向后兼容的简单 MCPClient 类 ───

/**
 * 简单的 MCP 客户端（向后兼容）
 *
 * 封装 MCPConnectionManager，提供简单的单服务器 API。
 * 对于多服务器场景，请直接使用 MCPConnectionManager。
 */
export class MCPClient {
  private manager: MCPConnectionManager;

  constructor() {
    this.manager = new MCPConnectionManager();
  }

  /** 获取底层的连接管理器 */
  getManager(): MCPConnectionManager {
    return this.manager;
  }

  /** 连接到 MCP 服务器 */
  async connect(serverConfig: MCPServerConfig, name = 'default'): Promise<void> {
    await this.manager.connect(name, serverConfig);
  }

  /** 从配置文件加载并连接所有服务器 */
  async loadFromConfig(configPath?: string): Promise<void> {
    await this.manager.loadFromConfig(configPath);
  }

  /** 获取所有服务器提供的工具列表 */
  listTools(): MCPToolInfo[] {
    return this.manager.getAllTools();
  }

  /** 调用 MCP 工具 */
  async callTool(
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MCPToolCallResult> {
    // 自动查找工具所属的服务器
    const serverName = this.manager.findToolServer(name);
    if (!serverName) {
      return {
        content: `Error: MCP 工具 "${name}" 未找到`,
        isError: true,
      };
    }
    return this.manager.callTool(serverName, name, input, signal);
  }

  /** 获取所有资源 */
  listResources(): MCPResourceInfo[] {
    return this.manager.getAllResources();
  }

  /** 读取资源 */
  async readResource(uri: string): Promise<{ content: string; mimeType?: string } | null> {
    // 查找拥有该资源的服务器
    const resources = this.manager.getAllResources();
    const resource = resources.find((r) => r.uri === uri);
    if (!resource) return null;
    return this.manager.readResource(resource.serverName, uri);
  }

  /** 断开所有连接 */
  async disconnect(): Promise<void> {
    await this.manager.disconnectAll();
  }

  /** 获取所有服务器的 instructions */
  getInstructions(): string[] {
    return this.manager.getInstructions();
  }

  /** 已连接的服务器数量 */
  get connectedCount(): number {
    return this.manager.connectedCount;
  }

  /** 总工具数量 */
  get totalToolCount(): number {
    return this.manager.totalToolCount;
  }
}
