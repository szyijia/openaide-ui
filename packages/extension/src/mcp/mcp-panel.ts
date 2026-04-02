/**
 * MCP 服务器管理面板
 *
 * 使用 VS Code TreeView 展示和管理 MCP 服务器：
 * - 查看已连接/断开的服务器列表
 * - 查看每个服务器提供的工具和资源
 * - 连接/断开服务器
 * - 添加新服务器
 * - 查看服务器状态和错误信息
 */

import * as vscode from 'vscode';
import type { AgentBridge } from '../bridge/agent-bridge.js';

// ─── 类型定义 ───

/** MCP 服务器信息（从 Bridge 获取） */
interface MCPServerInfo {
  name: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'failed';
  toolCount: number;
  resourceCount: number;
  serverVersion?: string;
  error?: string;
}

/** MCP 工具信息 */
interface MCPToolItem {
  name: string;
  description: string;
  serverName: string;
}

/** TreeView 节点类型 */
type MCPTreeItem = ServerNode | ToolGroupNode | ToolNode | ResourceGroupNode | ResourceNode | ActionNode;

interface ServerNode {
  kind: 'server';
  server: MCPServerInfo;
}

interface ToolGroupNode {
  kind: 'toolGroup';
  serverName: string;
  count: number;
}

interface ToolNode {
  kind: 'tool';
  tool: MCPToolItem;
}

interface ResourceGroupNode {
  kind: 'resourceGroup';
  serverName: string;
  count: number;
}

interface ResourceNode {
  kind: 'resource';
  name: string;
  uri: string;
  serverName: string;
}

interface ActionNode {
  kind: 'action';
  label: string;
  command: string;
}

// ─── MCPPanel ───

export class MCPPanel implements vscode.Disposable {
  private treeDataProvider: MCPTreeDataProvider;
  private treeView: vscode.TreeView<MCPTreeItem>;
  private disposables: vscode.Disposable[] = [];

  // 模拟的服务器数据（实际应从 Bridge 获取）
  private servers: MCPServerInfo[] = [];

  constructor(private readonly bridge: AgentBridge) {
    this.treeDataProvider = new MCPTreeDataProvider(this);

    this.treeView = vscode.window.createTreeView('openaide.mcpPanel', {
      treeDataProvider: this.treeDataProvider,
      showCollapseAll: true,
    });

    this.disposables.push(
      this.treeView,
      vscode.commands.registerCommand('openaide.mcp.refresh', () => this.refresh()),
      vscode.commands.registerCommand('openaide.mcp.addServer', () => this.addServer()),
      vscode.commands.registerCommand('openaide.mcp.connectServer', (node: ServerNode) => this.connectServer(node)),
      vscode.commands.registerCommand('openaide.mcp.disconnectServer', (node: ServerNode) => this.disconnectServer(node)),
      vscode.commands.registerCommand('openaide.mcp.removeServer', (node: ServerNode) => this.removeServer(node)),
      vscode.commands.registerCommand('openaide.mcp.viewTool', (node: ToolNode) => this.viewTool(node)),
    );

    // 初始加载
    this.refresh();
  }

  /** 获取服务器列表 */
  getServers(): MCPServerInfo[] {
    return this.servers;
  }

  /** 刷新面板 */
  async refresh(): Promise<void> {
    try {
      // 通过 Bridge 获取 MCP 服务器状态
      const result = await this.bridge.request('mcp/list', {}) as {
        servers?: MCPServerInfo[];
      };
      this.servers = result?.servers || [];
    } catch {
      // Bridge 可能未启动，使用空列表
      this.servers = [];
    }

    this.treeDataProvider.refresh();
    this.updateTitle();
  }

  private updateTitle(): void {
    const connected = this.servers.filter((s) => s.status === 'connected').length;
    const total = this.servers.length;
    this.treeView.title = total > 0
      ? `MCP 服务器 (${connected}/${total})`
      : 'MCP 服务器';
  }

  /** 添加新 MCP 服务器 */
  private async addServer(): Promise<void> {
    const type = await vscode.window.showQuickPick(
      [
        { label: '$(terminal) stdio', description: '通过命令行启动', value: 'stdio' },
        { label: '$(globe) SSE', description: '连接到 SSE 服务器', value: 'sse' },
        { label: '$(cloud) HTTP', description: '连接到 HTTP 服务器', value: 'http' },
      ],
      { placeHolder: '选择 MCP 服务器类型' },
    );

    if (!type) return;

    const name = await vscode.window.showInputBox({
      prompt: '服务器名称',
      placeHolder: '例如: filesystem, github, database',
    });

    if (!name) return;

    if (type.value === 'stdio') {
      const command = await vscode.window.showInputBox({
        prompt: '启动命令',
        placeHolder: '例如: npx -y @modelcontextprotocol/server-filesystem /path/to/dir',
      });

      if (!command) return;

      const parts = command.split(' ');
      try {
        await this.bridge.request('mcp/connect', {
          name,
          config: {
            type: 'stdio',
            command: parts[0],
            args: parts.slice(1),
          },
        });
        vscode.window.showInformationMessage(`MCP 服务器 "${name}" 已连接`);
        this.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(`连接失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      const url = await vscode.window.showInputBox({
        prompt: '服务器 URL',
        placeHolder: '例如: http://localhost:3000/mcp',
      });

      if (!url) return;

      try {
        await this.bridge.request('mcp/connect', {
          name,
          config: { type: type.value, url },
        });
        vscode.window.showInformationMessage(`MCP 服务器 "${name}" 已连接`);
        this.refresh();
      } catch (error) {
        vscode.window.showErrorMessage(`连接失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** 连接服务器 */
  private async connectServer(node: ServerNode): Promise<void> {
    try {
      await this.bridge.request('mcp/connect', { name: node.server.name });
      this.refresh();
    } catch (error) {
      vscode.window.showErrorMessage(`连接失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 断开服务器 */
  private async disconnectServer(node: ServerNode): Promise<void> {
    try {
      await this.bridge.request('mcp/disconnect', { name: node.server.name });
      this.refresh();
    } catch (error) {
      vscode.window.showErrorMessage(`断开失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 移除服务器 */
  private async removeServer(node: ServerNode): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `确定要移除 MCP 服务器 "${node.server.name}" 吗？`,
      { modal: true },
      '移除',
    );

    if (confirm === '移除') {
      try {
        await this.bridge.request('mcp/disconnect', { name: node.server.name });
        this.refresh();
      } catch {
        // 忽略
      }
    }
  }

  /** 查看工具详情 */
  private viewTool(node: ToolNode): void {
    const panel = vscode.window.createWebviewPanel(
      'mcpToolDetail',
      `MCP 工具: ${node.tool.name}`,
      vscode.ViewColumn.Beside,
      {},
    );

    panel.webview.html = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); }
    h1 { font-size: 1.4em; margin-bottom: 8px; }
    .meta { color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
    .description { line-height: 1.6; }
  </style>
</head>
<body>
  <h1>${node.tool.name}</h1>
  <div class="meta">来自: ${node.tool.serverName}</div>
  <div class="description">${node.tool.description}</div>
</body>
</html>`;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

// ─── TreeDataProvider ───

class MCPTreeDataProvider implements vscode.TreeDataProvider<MCPTreeItem> {
  private onDidChangeEmitter = new vscode.EventEmitter<MCPTreeItem | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

  constructor(private readonly panel: MCPPanel) {}

  refresh(): void {
    this.onDidChangeEmitter.fire(undefined);
  }

  getTreeItem(element: MCPTreeItem): vscode.TreeItem {
    switch (element.kind) {
      case 'server': return this.createServerItem(element);
      case 'toolGroup': return this.createToolGroupItem(element);
      case 'tool': return this.createToolItem(element);
      case 'resourceGroup': return this.createResourceGroupItem(element);
      case 'resource': return this.createResourceItem(element);
      case 'action': return this.createActionItem(element);
    }
  }

  getChildren(element?: MCPTreeItem): MCPTreeItem[] {
    if (!element) {
      return this.getRootItems();
    }

    switch (element.kind) {
      case 'server':
        return this.getServerChildren(element);
      case 'toolGroup':
        return []; // TODO: 从 Bridge 获取工具列表
      case 'resourceGroup':
        return []; // TODO: 从 Bridge 获取资源列表
      default:
        return [];
    }
  }

  private getRootItems(): MCPTreeItem[] {
    const servers = this.panel.getServers();

    if (servers.length === 0) {
      return [{
        kind: 'action',
        label: '$(add) 添加 MCP 服务器...',
        command: 'openaide.mcp.addServer',
      }];
    }

    return servers.map((server) => ({
      kind: 'server' as const,
      server,
    }));
  }

  private getServerChildren(node: ServerNode): MCPTreeItem[] {
    const children: MCPTreeItem[] = [];

    if (node.server.toolCount > 0) {
      children.push({
        kind: 'toolGroup',
        serverName: node.server.name,
        count: node.server.toolCount,
      });
    }

    if (node.server.resourceCount > 0) {
      children.push({
        kind: 'resourceGroup',
        serverName: node.server.name,
        count: node.server.resourceCount,
      });
    }

    return children;
  }

  private createServerItem(node: ServerNode): vscode.TreeItem {
    const s = node.server;
    const hasChildren = s.toolCount > 0 || s.resourceCount > 0;
    const item = new vscode.TreeItem(
      s.name,
      hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );

    // 状态图标
    const statusIcons: Record<string, vscode.ThemeIcon> = {
      connected: new vscode.ThemeIcon('plug', new vscode.ThemeColor('testing.iconPassed')),
      connecting: new vscode.ThemeIcon('loading~spin'),
      disconnected: new vscode.ThemeIcon('debug-disconnect', new vscode.ThemeColor('testing.iconSkipped')),
      failed: new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed')),
    };

    item.iconPath = statusIcons[s.status] || statusIcons.disconnected;
    item.description = s.status === 'connected'
      ? `${s.toolCount} 工具`
      : s.status === 'failed'
        ? `错误: ${s.error?.substring(0, 50)}`
        : s.status;

    item.tooltip = new vscode.MarkdownString(
      `**${s.name}**\n\n` +
      `状态: ${s.status}\n\n` +
      (s.serverVersion ? `版本: ${s.serverVersion}\n\n` : '') +
      `工具: ${s.toolCount} | 资源: ${s.resourceCount}` +
      (s.error ? `\n\n❌ ${s.error}` : ''),
    );

    item.contextValue = s.status === 'connected' ? 'mcpServerConnected' : 'mcpServerDisconnected';

    return item;
  }

  private createToolGroupItem(node: ToolGroupNode): vscode.TreeItem {
    const item = new vscode.TreeItem(`工具 (${node.count})`, vscode.TreeItemCollapsibleState.Collapsed);
    item.iconPath = new vscode.ThemeIcon('tools');
    return item;
  }

  private createToolItem(node: ToolNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.tool.name, vscode.TreeItemCollapsibleState.None);
    item.description = node.tool.description.substring(0, 60);
    item.iconPath = new vscode.ThemeIcon('symbol-method');
    item.command = {
      command: 'openaide.mcp.viewTool',
      title: '查看工具',
      arguments: [node],
    };
    item.contextValue = 'mcpTool';
    return item;
  }

  private createResourceGroupItem(node: ResourceGroupNode): vscode.TreeItem {
    const item = new vscode.TreeItem(`资源 (${node.count})`, vscode.TreeItemCollapsibleState.Collapsed);
    item.iconPath = new vscode.ThemeIcon('database');
    return item;
  }

  private createResourceItem(node: ResourceNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    item.description = node.uri;
    item.iconPath = new vscode.ThemeIcon('file');
    return item;
  }

  private createActionItem(node: ActionNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.command = {
      command: node.command,
      title: node.label,
    };
    return item;
  }
}
