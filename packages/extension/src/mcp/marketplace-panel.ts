/**
 * OpenAIDE IDE — MCP Marketplace 面板
 *
 * 在 VS Code Extension 中提供 MCP 服务器市场 Webview：
 * - 浏览和搜索 MCP 服务器
 * - 一键安装/卸载
 * - 配置环境变量
 * - 查看已安装服务器
 */

import * as vscode from 'vscode';

// 内联类型（避免 ESM/CJS 导入问题）
interface MCPServerEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  author: string;
  version: string;
  tools: string[];
  rating: number;
  downloads: number;
  featured: boolean;
  installConfig: {
    requiredEnv?: { name: string; description: string; required: boolean; default?: string; secret?: boolean }[];
  };
}

interface MCPMarketplaceService {
  getAllServers(): MCPServerEntry[];
  getFeaturedServers(): MCPServerEntry[];
  searchServers(query: string): MCPServerEntry[];
  getCategories(): { category: string; label: string; count: number }[];
  isInstalled(id: string): boolean;
  installServer(id: string, env: Record<string, string>): Promise<void>;
  uninstallServer(id: string): Promise<void>;
  getInstalledServers(): (MCPServerEntry & { installed: { enabled: boolean } })[];
  toggleServer(id: string, enabled?: boolean): Promise<void>;
}

export class MCPMarketplacePanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private marketplace: MCPMarketplaceService | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor(private context: vscode.ExtensionContext) {
    // 注册命令
    const openCmd = vscode.commands.registerCommand('openaide.mcp.marketplace', () => {
      this.show();
    });
    this.disposables.push(openCmd);
    context.subscriptions.push(openCmd);

    // 异步加载 marketplace 服务
    this.initMarketplace();
  }

  private async initMarketplace(): Promise<void> {
    try {
      const mod = await import('@openaide/core/src/mcp/marketplace.js');
      this.marketplace = new mod.MCPMarketplace() as unknown as MCPMarketplaceService;
    } catch (err) {
      console.error('[OpenAIDE] MCP Marketplace 初始化失败:', err);
    }
  }

  /**
   * 显示 Marketplace 面板
   */
  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'openaideMCPMarketplace',
      'MCP 服务器市场',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );

    this.panel.webview.html = this.getWebviewContent();

    // 处理 Webview 消息
    this.panel.webview.onDidReceiveMessage(async (message) => {
      await this.handleMessage(message);
    }, null, this.disposables);

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    }, null, this.disposables);

    // 发送初始数据
    await this.sendInitialData();
  }

  /**
   * 处理 Webview 消息
   */
  private async handleMessage(message: { type: string; [key: string]: any }): Promise<void> {
    if (!this.marketplace) {
      this.panel?.webview.postMessage({ type: 'error', message: 'Marketplace 服务未就绪' });
      return;
    }

    switch (message.type) {
      case 'search': {
        const results = message.query
          ? this.marketplace.searchServers(message.query)
          : this.marketplace.getAllServers();
        this.panel?.webview.postMessage({
          type: 'searchResults',
          servers: results.map(s => ({ ...s, installed: this.marketplace!.isInstalled(s.id) })),
        });
        break;
      }

      case 'getCategory': {
        const servers = message.category === 'installed'
          ? this.marketplace.getInstalledServers()
          : message.category === 'featured'
            ? this.marketplace.getFeaturedServers()
            : this.marketplace.searchServers(message.category);
        this.panel?.webview.postMessage({
          type: 'searchResults',
          servers: servers.map(s => ({ ...s, installed: this.marketplace!.isInstalled(s.id) })),
        });
        break;
      }

      case 'install': {
        try {
          await this.marketplace.installServer(message.serverId, message.env || {});
          vscode.window.showInformationMessage(`MCP 服务器 "${message.serverName}" 安装成功`);
          this.panel?.webview.postMessage({ type: 'installSuccess', serverId: message.serverId });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(`安装失败: ${msg}`);
          this.panel?.webview.postMessage({ type: 'installError', serverId: message.serverId, error: msg });
        }
        break;
      }

      case 'uninstall': {
        try {
          await this.marketplace.uninstallServer(message.serverId);
          vscode.window.showInformationMessage(`MCP 服务器 "${message.serverName}" 已卸载`);
          this.panel?.webview.postMessage({ type: 'uninstallSuccess', serverId: message.serverId });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(`卸载失败: ${msg}`);
        }
        break;
      }

      case 'toggle': {
        try {
          await this.marketplace.toggleServer(message.serverId, message.enabled);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(`操作失败: ${msg}`);
        }
        break;
      }

      case 'configureEnv': {
        // 弹出输入框让用户配置环境变量
        await this.configureServerEnv(message.serverId, message.serverName, message.requiredEnv);
        break;
      }
    }
  }

  /**
   * 配置服务器环境变量
   */
  private async configureServerEnv(
    serverId: string,
    serverName: string,
    requiredEnv: { name: string; description: string; required: boolean; default?: string; secret?: boolean }[]
  ): Promise<void> {
    const env: Record<string, string> = {};

    for (const envVar of requiredEnv) {
      const value = await vscode.window.showInputBox({
        title: `配置 ${serverName}`,
        prompt: `${envVar.description} (${envVar.name})`,
        value: envVar.default || '',
        password: envVar.secret,
        placeHolder: envVar.required ? '必填' : '可选',
        validateInput: (v) => {
          if (envVar.required && !v && !envVar.default) {
            return '此项为必填';
          }
          return null;
        },
      });

      if (value === undefined) {
        // 用户取消
        return;
      }

      if (value) {
        env[envVar.name] = value;
      } else if (envVar.default) {
        env[envVar.name] = envVar.default;
      }
    }

    // 安装服务器
    this.panel?.webview.postMessage({
      type: 'doInstall',
      serverId,
      env,
    });
  }

  /**
   * 发送初始数据
   */
  private async sendInitialData(): Promise<void> {
    if (!this.marketplace || !this.panel) return;

    const servers = this.marketplace.getAllServers();
    const categories = this.marketplace.getCategories();

    this.panel.webview.postMessage({
      type: 'init',
      servers: servers.map(s => ({ ...s, installed: this.marketplace!.isInstalled(s.id) })),
      categories,
    });
  }

  /**
   * 生成 Webview HTML
   */
  private getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MCP 服务器市场</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 0;
    }

    /* 头部 */
    .header {
      padding: 20px 24px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    .header h1 {
      font-size: 20px;
      margin-bottom: 12px;
      color: var(--vscode-foreground);
    }
    .header p {
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
      margin-bottom: 16px;
    }

    /* 搜索栏 */
    .search-bar {
      display: flex;
      gap: 8px;
    }
    .search-bar input {
      flex: 1;
      padding: 8px 12px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      font-size: 13px;
      outline: none;
    }
    .search-bar input:focus {
      border-color: var(--vscode-focusBorder);
    }

    /* 分类标签 */
    .categories {
      display: flex;
      gap: 6px;
      padding: 12px 24px;
      overflow-x: auto;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    .category-tag {
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
      border: 1px solid var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      background: transparent;
      transition: all 0.2s;
    }
    .category-tag:hover, .category-tag.active {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    /* 服务器列表 */
    .server-list {
      padding: 16px 24px;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
      gap: 12px;
    }

    /* 服务器卡片 */
    .server-card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 16px;
      background: var(--vscode-sideBar-background);
      transition: border-color 0.2s;
    }
    .server-card:hover {
      border-color: var(--vscode-focusBorder);
    }
    .server-card.featured {
      border-left: 3px solid var(--vscode-textLink-foreground);
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 8px;
    }
    .card-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .card-version {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 1px 6px;
      border-radius: 8px;
    }

    .card-desc {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 10px;
      line-height: 1.5;
    }

    .card-meta {
      display: flex;
      gap: 12px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 10px;
    }
    .card-meta span { display: flex; align-items: center; gap: 3px; }

    .card-tools {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 12px;
    }
    .tool-tag {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      background: var(--vscode-textCodeBlock-background);
      color: var(--vscode-foreground);
    }

    .card-actions {
      display: flex;
      gap: 8px;
    }
    .btn {
      padding: 6px 14px;
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
      border: none;
      transition: opacity 0.2s;
    }
    .btn:hover { opacity: 0.85; }
    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn-danger {
      background: var(--vscode-errorForeground);
      color: white;
    }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .installed-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 8px;
      font-size: 11px;
      background: #28a745;
      color: white;
    }

    .empty-state {
      text-align: center;
      padding: 40px;
      color: var(--vscode-descriptionForeground);
    }

    .stars { color: #f5a623; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🔌 MCP 服务器市场</h1>
    <p>发现、安装和管理 MCP (Model Context Protocol) 服务器，扩展 AI 的能力边界</p>
    <div class="search-bar">
      <input type="text" id="searchInput" placeholder="搜索 MCP 服务器（名称、描述、工具...）" />
    </div>
  </div>

  <div class="categories" id="categories"></div>

  <div class="server-list" id="serverList">
    <div class="empty-state">加载中...</div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let allServers = [];
    let activeCategory = 'all';

    // 搜索
    const searchInput = document.getElementById('searchInput');
    let searchTimeout;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        vscode.postMessage({ type: 'search', query: searchInput.value });
      }, 300);
    });

    // 渲染分类标签
    function renderCategories(categories) {
      const container = document.getElementById('categories');
      const tags = [
        { category: 'all', label: '全部', count: allServers.length },
        { category: 'featured', label: '⭐ 推荐', count: allServers.filter(s => s.featured).length },
        { category: 'installed', label: '✅ 已安装', count: allServers.filter(s => s.installed).length },
        ...categories,
      ];

      container.innerHTML = tags.map(t =>
        '<button class="category-tag' + (t.category === activeCategory ? ' active' : '') + '" data-category="' + t.category + '">'
        + t.label + ' (' + t.count + ')</button>'
      ).join('');

      container.querySelectorAll('.category-tag').forEach(btn => {
        btn.addEventListener('click', () => {
          activeCategory = btn.dataset.category;
          container.querySelectorAll('.category-tag').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');

          if (activeCategory === 'all') {
            renderServers(allServers);
          } else {
            vscode.postMessage({ type: 'getCategory', category: activeCategory });
          }
        });
      });
    }

    // 渲染服务器列表
    function renderServers(servers) {
      const container = document.getElementById('serverList');

      if (servers.length === 0) {
        container.innerHTML = '<div class="empty-state">没有找到匹配的 MCP 服务器</div>';
        return;
      }

      container.innerHTML = servers.map(s => {
        const stars = '★'.repeat(Math.round(s.rating)) + '☆'.repeat(5 - Math.round(s.rating));
        const toolsHtml = s.tools.slice(0, 5).map(t => '<span class="tool-tag">' + t + '</span>').join('')
          + (s.tools.length > 5 ? '<span class="tool-tag">+' + (s.tools.length - 5) + '</span>' : '');

        const actionsHtml = s.installed
          ? '<span class="installed-badge">已安装</span> <button class="btn btn-danger" onclick="uninstallServer(\\''+s.id+'\\', \\''+s.name+'\\')">卸载</button>'
          : '<button class="btn btn-primary" onclick="installServer(\\''+s.id+'\\', \\''+s.name+'\\')">安装</button>';

        return '<div class="server-card' + (s.featured ? ' featured' : '') + '">'
          + '<div class="card-header">'
          + '  <span class="card-title">' + s.name + '</span>'
          + '  <span class="card-version">v' + s.version + '</span>'
          + '</div>'
          + '<div class="card-desc">' + s.description + '</div>'
          + '<div class="card-meta">'
          + '  <span class="stars">' + stars + '</span>'
          + '  <span>👤 ' + s.author + '</span>'
          + '  <span>⬇ ' + formatNumber(s.downloads) + '</span>'
          + '</div>'
          + '<div class="card-tools">' + toolsHtml + '</div>'
          + '<div class="card-actions">' + actionsHtml + '</div>'
          + '</div>';
      }).join('');
    }

    function formatNumber(n) {
      if (n >= 10000) return (n / 10000).toFixed(1) + '万';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return n.toString();
    }

    // 安装服务器
    function installServer(id, name) {
      const server = allServers.find(s => s.id === id);
      if (server && server.installConfig.requiredEnv && server.installConfig.requiredEnv.length > 0) {
        // 需要配置环境变量
        vscode.postMessage({
          type: 'configureEnv',
          serverId: id,
          serverName: name,
          requiredEnv: server.installConfig.requiredEnv,
        });
      } else {
        // 直接安装
        vscode.postMessage({ type: 'install', serverId: id, serverName: name, env: {} });
      }
    }

    // 卸载服务器
    function uninstallServer(id, name) {
      vscode.postMessage({ type: 'uninstall', serverId: id, serverName: name });
    }

    // 接收消息
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'init':
          allServers = msg.servers;
          renderCategories(msg.categories);
          renderServers(allServers);
          break;
        case 'searchResults':
          renderServers(msg.servers);
          break;
        case 'installSuccess':
          allServers = allServers.map(s => s.id === msg.serverId ? { ...s, installed: true } : s);
          renderServers(allServers);
          break;
        case 'uninstallSuccess':
          allServers = allServers.map(s => s.id === msg.serverId ? { ...s, installed: false } : s);
          renderServers(allServers);
          break;
        case 'doInstall':
          vscode.postMessage({ type: 'install', serverId: msg.serverId, env: msg.env, serverName: msg.serverId });
          break;
      }
    });
  </script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
