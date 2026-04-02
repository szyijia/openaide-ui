/**
 * Settings Panel — 在编辑器区域（Editor Tab）中打开设置页面
 *
 * 包含：模型管理、MCP 服务器、记忆管理
 */

import * as vscode from 'vscode';
import type { AgentBridge } from '../bridge/agent-bridge.js';

export class SettingsPanel {
  public static currentPanel: SettingsPanel | undefined;
  private static readonly viewType = 'openaide.settings';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly bridge: AgentBridge;
  private disposables: vscode.Disposable[] = [];

  /** 模型配置映射 */
  private static readonly PROVIDER_CONFIG_MAP: Record<string, { configKey: string; envKey: string; placeholder: string }> = {
    anthropic: { configKey: 'anthropicApiKey', envKey: 'ANTHROPIC_API_KEY', placeholder: 'sk-ant-...' },
    openai: { configKey: 'openaiApiKey', envKey: 'OPENAI_API_KEY', placeholder: 'sk-...' },
    deepseek: { configKey: 'deepseekApiKey', envKey: 'DEEPSEEK_API_KEY', placeholder: 'sk-...' },
    qwen: { configKey: 'qwenApiKey', envKey: 'DASHSCOPE_API_KEY', placeholder: 'sk-...' },
    glm: { configKey: 'glmApiKey', envKey: 'GLM_API_KEY', placeholder: '...' },
  };

  public static createOrShow(extensionUri: vscode.Uri, bridge: AgentBridge): void {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // 如果已存在，直接显示
    if (SettingsPanel.currentPanel) {
      SettingsPanel.currentPanel.panel.reveal(column);
      return;
    }

    // 创建新面板
    const panel = vscode.window.createWebviewPanel(
      SettingsPanel.viewType,
      '⚙️ OpenAIDE设置',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );

    SettingsPanel.currentPanel = new SettingsPanel(panel, extensionUri, bridge);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, bridge: AgentBridge) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.bridge = bridge;

    // 设置 HTML
    this.panel.webview.html = this.getHtmlContent(this.panel.webview);

    // 监听消息
    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables,
    );

    // 面板关闭时清理
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // 初始加载数据
    this.loadModelConfigs();
    this.loadMcpServers();
    this.loadMemories();
  }

  private dispose(): void {
    SettingsPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }

  private postMessage(message: unknown): void {
    this.panel.webview.postMessage(message);
  }

  // ─── 消息处理 ───

  private async handleMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'requestModelConfigs':
        await this.loadModelConfigs();
        break;
      case 'configureModelKey':
        await this.handleConfigureModelKey(msg.providerId);
        break;
      case 'clearModelKey':
        await this.handleClearModelKey(msg.providerId);
        break;
      case 'saveCustomModel':
        await this.handleSaveCustomModel(msg.name, msg.url, msg.key);
        break;
      case 'removeCustomModel':
        await this.handleRemoveCustomModel(msg.index);
        break;
      case 'requestMcpServers':
        await this.loadMcpServers();
        break;
      case 'mcpAddServer':
        vscode.commands.executeCommand('openaide.mcp.addServer');
        break;
      case 'mcpEditConfig':
        vscode.commands.executeCommand('openaide.mcpEditConfig');
        break;
      case 'requestMemories':
        await this.loadMemories();
        break;
      case 'memoryAdd':
        vscode.commands.executeCommand('openaide.memory.add');
        break;
      case 'memoryDelete':
        await this.handleDeleteMemory(msg.id);
        break;
      case 'memoryRefresh':
        await this.loadMemories();
        break;
    }
  }

  // ─── 模型管理 ───

  private async loadModelConfigs(): Promise<void> {
    const config = vscode.workspace.getConfiguration('openaide');
    const configs: Record<string, { configured: boolean; maskedKey: string }> = {};

    for (const [id, mapping] of Object.entries(SettingsPanel.PROVIDER_CONFIG_MAP)) {
      const key = config.get<string>(mapping.configKey, '');
      configs[id] = {
        configured: !!key,
        maskedKey: key ? this.maskKey(key) : '',
      };
    }

    const customUrl = config.get<string>('custom.baseUrl', '');
    const customModel = config.get<string>('custom.model', '');
    const customKey = config.get<string>('custom.apiKey', '');
    const customModels = customUrl && customModel ? [{
      name: customModel,
      url: customUrl,
      configured: !!customKey,
      maskedKey: customKey ? this.maskKey(customKey) : '',
    }] : [];

    this.postMessage({ type: 'modelConfigs', configs, customModels });
  }

  private async handleConfigureModelKey(providerId: string): Promise<void> {
    const mapping = SettingsPanel.PROVIDER_CONFIG_MAP[providerId];
    if (!mapping) return;

    const config = vscode.workspace.getConfiguration('openaide');
    const currentKey = config.get<string>(mapping.configKey, '');

    const apiKey = await vscode.window.showInputBox({
      prompt: `输入 API Key`,
      placeHolder: mapping.placeholder,
      password: true,
      value: currentKey,
    });

    if (apiKey === undefined) return;

    await config.update(mapping.configKey, apiKey, vscode.ConfigurationTarget.Global);
    if (apiKey) {
      await this.bridge.configSet({ key: mapping.envKey, value: apiKey });
    }

    vscode.window.showInformationMessage(apiKey ? 'API Key 已保存' : 'API Key 已清除');
    await this.loadModelConfigs();
  }

  private async handleClearModelKey(providerId: string): Promise<void> {
    const mapping = SettingsPanel.PROVIDER_CONFIG_MAP[providerId];
    if (!mapping) return;

    const config = vscode.workspace.getConfiguration('openaide');
    await config.update(mapping.configKey, '', vscode.ConfigurationTarget.Global);
    await this.bridge.configSet({ key: mapping.envKey, value: '' });

    vscode.window.showInformationMessage('API Key 已清除');
    await this.loadModelConfigs();
  }

  private async handleSaveCustomModel(name: string, url: string, key: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('openaide');
    await config.update('custom.model', name, vscode.ConfigurationTarget.Global);
    await config.update('custom.baseUrl', url, vscode.ConfigurationTarget.Global);
    if (key) {
      await config.update('custom.apiKey', key, vscode.ConfigurationTarget.Global);
      await this.bridge.configSet({ key: 'CUSTOM_API_KEY', value: key });
      await this.bridge.configSet({ key: 'CUSTOM_BASE_URL', value: url });
      await this.bridge.configSet({ key: 'CUSTOM_MODEL', value: name });
    }

    vscode.window.showInformationMessage(`自定义模型已保存: ${name}`);
    await this.loadModelConfigs();
  }

  private async handleRemoveCustomModel(_index: number): Promise<void> {
    const config = vscode.workspace.getConfiguration('openaide');
    await config.update('custom.model', '', vscode.ConfigurationTarget.Global);
    await config.update('custom.baseUrl', '', vscode.ConfigurationTarget.Global);
    await config.update('custom.apiKey', '', vscode.ConfigurationTarget.Global);

    vscode.window.showInformationMessage('自定义模型已删除');
    await this.loadModelConfigs();
  }

  // ─── MCP 管理 ───

  private async loadMcpServers(): Promise<void> {
    try {
      const result = await this.bridge.request('mcp/list', {}) as any;
      this.postMessage({ type: 'mcpServers', servers: result?.servers || [] });
    } catch (err) {
      console.warn('[SettingsPanel] MCP 列表获取失败:', err);
      this.postMessage({ type: 'mcpServers', servers: [] });
    }
  }

  // ─── 记忆管理 ───

  private async loadMemories(): Promise<void> {
    try {
      const result = await this.bridge.request('memory/list', {}) as any;
      this.postMessage({ type: 'memories', memories: result?.memories || [] });
    } catch (err) {
      console.warn('[SettingsPanel] 记忆列表获取失败:', err);
      this.postMessage({ type: 'memories', memories: [] });
    }
  }

  private async handleDeleteMemory(id: string): Promise<void> {
    try {
      await this.bridge.request('memory/delete', { id });
      vscode.window.showInformationMessage('记忆已删除');
      await this.loadMemories();
    } catch (err) {
      console.warn('[SettingsPanel] 删除记忆失败:', err);
      vscode.window.showErrorMessage('删除记忆失败');
    }
  }

  private maskKey(key: string): string {
    if (key.length <= 8) return '****';
    return key.slice(0, 4) + '****' + key.slice(-4);
  }

  // ─── HTML 内容 ───

  private getHtmlContent(webview: vscode.Webview): string {
    const nonce = getNonce();

    return /*html*/ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>OpenAIDE设置</title>
  <style>
    :root {
      --gongfeng-foreground: var(--vscode-foreground);
      --gongfeng-focusBorder: var(--vscode-focusBorder);
      --gongfeng-errorForeground: var(--vscode-errorForeground);
      --gongfeng-chat-text-secondary-foreground: var(--vscode-descriptionForeground);
      --input-background: var(--vscode-input-background);
      --input-placeholder-foreground: var(--vscode-input-placeholderForeground);
      --dropdown-border: var(--vscode-editorWidget-border, var(--vscode-widget-border, transparent));
      --focus-border: var(--vscode-focusBorder);
      --font-family: var(--vscode-font-family);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--font-family);
      font-size: var(--vscode-font-size);
      color: var(--gongfeng-foreground);
      background: var(--vscode-editor-background);
      height: 100vh;
      overflow: hidden;
    }

    .settings-root {
      display: flex;
      height: 100%;
    }

    /* ─── 左侧菜单 ─── */
    .side-menu {
      box-sizing: border-box;
      min-width: 140px;
      width: 180px;
      padding: 20px 12px;
      flex-shrink: 0;
      border-right: 1px solid var(--dropdown-border);
      overflow-y: auto;
    }

    .side-menu-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--gongfeng-chat-text-secondary-foreground);
      padding: 0 12px;
      margin-bottom: 12px;
    }

    .menu-item {
      border-radius: 6px;
      color: var(--gongfeng-foreground);
      cursor: pointer;
      font-size: 13px;
      margin-bottom: 4px;
      padding: 8px 12px;
      display: flex;
      align-items: center;
      gap: 10px;
      user-select: none;
      transition: background 0.15s;
    }

    .menu-item:hover { background-color: var(--vscode-list-hoverBackground); }
    .menu-item.active {
      background-color: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
      color: var(--vscode-list-activeSelectionForeground, var(--gongfeng-foreground));
      font-weight: 600;
    }

    .menu-item svg {
      width: 16px;
      height: 16px;
      opacity: 0.7;
      flex-shrink: 0;
    }

    /* ─── 右侧内容 ─── */
    .content-area {
      flex: 1;
      min-width: 300px;
      overflow-y: auto;
      padding: 24px 32px;
    }

    .content-area::-webkit-scrollbar { width: 6px; }
    .content-area::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background);
      border-radius: 4px;
    }

    .settings-panel { display: none; }
    .settings-panel.active { display: block; }

    .section-title {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 8px;
    }

    .section-desc {
      color: var(--gongfeng-chat-text-secondary-foreground);
      font-size: 13px;
      margin-bottom: 20px;
      line-height: 1.5;
    }

    /* ─── 模型卡片 ─── */
    .model-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--dropdown-border);
      border-radius: 8px;
      margin-bottom: 12px;
      padding: 16px 20px;
      transition: border-color 0.2s ease;
    }

    .model-card:hover { border-color: var(--gongfeng-focusBorder); }

    .model-card-header {
      align-items: center;
      display: flex;
      justify-content: space-between;
      margin-bottom: 10px;
    }

    .model-card-status {
      align-items: center;
      display: flex;
      gap: 10px;
    }

    .status-dot {
      border-radius: 50%;
      flex-shrink: 0;
      height: 8px;
      width: 8px;
    }

    .status-dot.configured { background-color: var(--vscode-charts-green, #40c8ae); }
    .status-dot.unconfigured { background-color: var(--gongfeng-chat-text-secondary-foreground); }

    .model-card-name {
      font-size: 14px;
      font-weight: 600;
    }

    .model-card-actions { display: flex; gap: 6px; }

    .icon-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border: none;
      border-radius: 5px;
      background: transparent;
      color: var(--gongfeng-chat-text-secondary-foreground);
      cursor: pointer;
      transition: background 0.15s;
    }

    .icon-btn:hover {
      background: var(--vscode-list-hoverBackground);
      color: var(--gongfeng-foreground);
    }

    .icon-btn svg { width: 14px; height: 14px; }

    .model-card-details {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .detail-row {
      align-items: center;
      display: flex;
      font-size: 12px;
      gap: 10px;
    }

    .detail-label {
      color: var(--gongfeng-chat-text-secondary-foreground);
      flex-shrink: 0;
      width: 60px;
    }

    .detail-value {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .detail-value.masked {
      font-family: var(--vscode-editor-font-family);
    }

    .detail-value.unconfigured { opacity: 0.5; }

    /* ─── 按钮 ─── */
    .btn {
      align-items: center;
      background: var(--vscode-button-background);
      border: none;
      border-radius: 5px;
      color: var(--vscode-button-foreground);
      cursor: pointer;
      display: inline-flex;
      font-size: 13px;
      gap: 6px;
      padding: 7px 16px;
      transition: background 0.15s;
    }

    .btn:hover { background: var(--vscode-button-hoverBackground); }

    .btn.secondary {
      background: transparent;
      border: 1px solid var(--dropdown-border);
      color: var(--gongfeng-foreground);
    }

    .btn.secondary:hover { background: var(--vscode-list-hoverBackground); }

    .btn svg { width: 14px; height: 14px; }

    /* ─── 对话框 ─── */
    .dialog-overlay {
      align-items: center;
      background: rgba(0,0,0,0.5);
      bottom: 0;
      display: none;
      justify-content: center;
      left: 0;
      position: fixed;
      right: 0;
      top: 0;
      z-index: 1000;
    }

    .dialog-overlay.visible { display: flex; }

    .dialog-box {
      background: var(--vscode-editor-background);
      border: 1px solid var(--dropdown-border);
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
      max-width: 440px;
      min-width: 340px;
      padding: 20px;
      position: relative;
      width: 90%;
    }

    .dialog-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 16px;
    }

    .dialog-close {
      position: absolute;
      right: 12px;
      top: 12px;
      background: transparent;
      border: none;
      color: var(--gongfeng-chat-text-secondary-foreground);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      font-size: 16px;
    }

    .dialog-close:hover {
      background: var(--vscode-list-hoverBackground);
      color: var(--gongfeng-foreground);
    }

    .form-row {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 14px;
    }

    .form-label {
      font-size: 13px;
      font-weight: 500;
    }

    .form-input {
      background: var(--input-background);
      border: 1px solid var(--dropdown-border);
      border-radius: 5px;
      color: var(--gongfeng-foreground);
      font-family: var(--font-family);
      font-size: 13px;
      outline: none;
      padding: 7px 10px;
      width: 100%;
      box-sizing: border-box;
    }

    .form-input:focus { border-color: var(--focus-border); }
    .form-input::placeholder { color: var(--input-placeholder-foreground); }

    .form-hint {
      color: var(--gongfeng-chat-text-secondary-foreground);
      font-size: 11px;
    }

    .form-actions {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }

    /* ─── MCP 卡片 ─── */
    .server-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--dropdown-border);
      border-radius: 8px;
      margin-bottom: 12px;
      padding: 16px 20px;
      transition: border-color 0.2s;
    }

    .server-card:hover { border-color: var(--gongfeng-focusBorder); }

    .server-header {
      align-items: center;
      display: flex;
      justify-content: space-between;
      margin-bottom: 10px;
    }

    .server-info {
      align-items: center;
      display: flex;
      gap: 10px;
    }

    .server-name { font-size: 14px; font-weight: 600; }

    .tool-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }

    .tool-tag {
      background: var(--vscode-list-hoverBackground);
      border-radius: 4px;
      font-size: 11px;
      padding: 2px 8px;
    }

    .server-cmd {
      margin-top: 8px;
      font-size: 12px;
    }

    .server-cmd code {
      background: var(--vscode-textCodeBlock-background);
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family);
      padding: 2px 8px;
    }

    /* ─── 记忆卡片 ─── */
    .memory-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--dropdown-border);
      border-radius: 8px;
      margin-bottom: 10px;
      padding: 14px 18px;
      transition: border-color 0.2s;
    }

    .memory-card:hover { border-color: var(--gongfeng-focusBorder); }

    .memory-header {
      align-items: center;
      display: flex;
      justify-content: space-between;
      margin-bottom: 6px;
    }

    .memory-type {
      font-size: 11px;
      padding: 1px 8px;
      border-radius: 4px;
      background: var(--vscode-list-hoverBackground);
    }

    .memory-content {
      font-size: 13px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .memory-meta {
      color: var(--gongfeng-chat-text-secondary-foreground);
      font-size: 11px;
      margin-top: 6px;
    }

    /* ─── 空状态 ─── */
    .empty-state {
      color: var(--gongfeng-chat-text-secondary-foreground);
      padding: 60px 24px;
      text-align: center;
    }

    .empty-state-icon { font-size: 48px; margin-bottom: 16px; opacity: 0.5; }
    .empty-state-title { font-size: 15px; font-weight: 500; color: var(--gongfeng-foreground); margin-bottom: 8px; }
    .empty-state-desc { font-size: 13px; opacity: 0.8; }
  </style>
</head>
<body>
  <div class="settings-root">
    <!-- 左侧菜单 -->
    <div class="side-menu">
      <div class="side-menu-title">设置</div>
      <div class="menu-item active" data-panel="models" onclick="switchPanel('models')">
        <svg viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 2A1.5 1.5 0 0 0 1 3.5v9A1.5 1.5 0 0 0 2.5 14h11a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 13.5 2h-11zM2 3.5a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-9zM4 5h8v1H4V5zm0 3h5v1H4V8z"/></svg>
        模型
      </div>
      <div class="menu-item" data-panel="mcp" onclick="switchPanel('mcp')">
        <svg viewBox="0 0 16 16" fill="currentColor"><path d="M14.773 3.485l-.984-.984a.5.5 0 0 0-.707 0l-1.06 1.06-2.122-2.12a.5.5 0 0 0-.707 0L7.44 3.193a.5.5 0 0 0 0 .707l.354.354-4.95 4.95a.5.5 0 0 0-.146.353v2.122a.5.5 0 0 0 .5.5h2.12a.5.5 0 0 0 .354-.146l4.95-4.95.354.354a.5.5 0 0 0 .707 0l1.753-1.753a.5.5 0 0 0 0-.707l-2.12-2.122 1.06-1.06a.5.5 0 0 0 0-.707z"/></svg>
        MCP
      </div>
      <div class="menu-item" data-panel="memory" onclick="switchPanel('memory')">
        <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1C4.13 1 1 3.58 1 6.75c0 1.77 1.06 3.35 2.72 4.38L3 15l3.03-2.02c.64.13 1.3.2 1.97.2 3.87 0 7-2.58 7-5.43S11.87 1 8 1zm0 9.86c-.55 0-1.08-.07-1.59-.19l-.34-.08-1.56 1.04.37-1.85-.3-.2C3.58 8.87 2.75 7.85 2.75 6.75 2.75 4.54 5.1 2.75 8 2.75s5.25 1.79 5.25 4c0 2.21-2.35 4.11-5.25 4.11z"/></svg>
        记忆
      </div>
    </div>

    <!-- 右侧内容 -->
    <div class="content-area">
      <!-- 模型管理 -->
      <div class="settings-panel active" id="panel-models">
        <h1 class="section-title">模型管理</h1>
        <p class="section-desc">配置 AI 模型的 API Key。已配置的模型会出现在对话框的模型选择器中。</p>
        <div id="models-list"></div>
        <div style="margin-top:16px">
          <button class="btn secondary" onclick="showAddModelDialog()">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>
            添加自定义模型
          </button>
        </div>
      </div>

      <!-- MCP -->
      <div class="settings-panel" id="panel-mcp">
        <h1 class="section-title">MCP 服务器</h1>
        <p class="section-desc">MCP（Model Context Protocol）服务器为 AI 提供额外的工具和资源能力。</p>
        <div style="margin-bottom:16px;display:flex;gap:8px">
          <button class="btn" onclick="vscode.postMessage({type:'mcpAddServer'})">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>
            添加服务器
          </button>
          <button class="btn secondary" onclick="vscode.postMessage({type:'mcpEditConfig'})">编辑配置文件</button>
        </div>
        <div id="mcp-list"></div>
      </div>

      <!-- 记忆 -->
      <div class="settings-panel" id="panel-memory">
        <h1 class="section-title">记忆管理</h1>
        <p class="section-desc">AI 的记忆系统，跨会话保持上下文，记住你的偏好和项目规范。</p>
        <div style="margin-bottom:16px;display:flex;gap:8px">
          <button class="btn" onclick="vscode.postMessage({type:'memoryAdd'})">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></svg>
            添加记忆
          </button>
          <button class="btn secondary" onclick="vscode.postMessage({type:'memoryRefresh'})">刷新</button>
        </div>
        <div id="memory-list"></div>
      </div>
    </div>
  </div>

  <!-- 添加自定义模型对话框 -->
  <div class="dialog-overlay" id="add-model-dialog">
    <div class="dialog-box">
      <button class="dialog-close" onclick="hideAddModelDialog()">✕</button>
      <div class="dialog-title">添加自定义模型</div>
      <div class="form-row">
        <label class="form-label">模型名称</label>
        <input class="form-input" id="custom-model-name" placeholder="例如: gpt-4o / deepseek-v3" />
      </div>
      <div class="form-row">
        <label class="form-label">API 端点</label>
        <input class="form-input" id="custom-model-url" placeholder="https://api.example.com/v1" />
        <span class="form-hint">兼容 OpenAI API 格式的端点</span>
      </div>
      <div class="form-row">
        <label class="form-label">API Key</label>
        <input class="form-input" id="custom-model-key" type="password" placeholder="sk-..." />
      </div>
      <div class="form-actions">
        <button class="btn" onclick="saveCustomModel()">保存</button>
        <button class="btn secondary" onclick="hideAddModelDialog()">取消</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const PRESET_MODELS = [
      { id: 'anthropic', name: 'Anthropic (Claude)', models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514'] },
      { id: 'openai', name: 'OpenAI (GPT)', models: ['gpt-4o', 'gpt-4o-mini'] },
      { id: 'deepseek', name: 'DeepSeek', models: ['deepseek-chat', 'deepseek-reasoner'] },
      { id: 'qwen', name: '通义千问 (Qwen)', models: ['qwen-max', 'qwen-plus'] },
      { id: 'glm', name: '智谱 GLM', models: ['glm-5.1', 'glm-4-flash'] },
    ];

    let modelConfigs = {};
    let customModels = [];

    // ─── 面板切换 ───
    function switchPanel(name) {
      document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
      document.querySelector('.menu-item[data-panel="' + name + '"]').classList.add('active');
      document.querySelectorAll('.settings-panel').forEach(el => el.classList.remove('active'));
      document.getElementById('panel-' + name).classList.add('active');
    }

    // ─── 模型渲染 ───
    function renderModels() {
      const container = document.getElementById('models-list');
      container.innerHTML = '';

      const editSvg = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.23 1h-1.46L3.52 9.25l-.16.22L1 13.59 2.41 15l4.12-2.36.22-.16L15 4.23V2.77L13.23 1zM2.41 13.59l1.51-3 1.45 1.45-2.96 1.55zm3.83-2.06L4.47 9.76l8-8 1.77 1.77-8 8z"/></svg>';
      const deleteSvg = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M10 3h3v1h-1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4H3V3h3V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1zM9 2H7v1h2V2zM5 4v9h6V4H5z"/></svg>';

      PRESET_MODELS.forEach(p => {
        const cfg = modelConfigs[p.id] || {};
        const ok = cfg.configured || false;
        const masked = cfg.maskedKey || '';

        const card = document.createElement('div');
        card.className = 'model-card';
        card.innerHTML =
          '<div class="model-card-header">' +
            '<div class="model-card-status">' +
              '<span class="status-dot ' + (ok ? 'configured' : 'unconfigured') + '"></span>' +
              '<span class="model-card-name">' + p.name + '</span>' +
            '</div>' +
            '<div class="model-card-actions">' +
              '<button class="icon-btn btn-configure" title="' + (ok ? '修改 Key' : '设置 Key') + '" data-provider="' + p.id + '">' + editSvg + '</button>' +
              (ok ? '<button class="icon-btn btn-clear" title="清除 Key" data-provider="' + p.id + '">' + deleteSvg + '</button>' : '') +
            '</div>' +
          '</div>' +
          '<div class="model-card-details">' +
            '<div class="detail-row"><span class="detail-label">模型</span><span class="detail-value">' + p.models.join(', ') + '</span></div>' +
            '<div class="detail-row"><span class="detail-label">API Key</span><span class="detail-value masked' + (ok ? '' : ' unconfigured') + '">' + (ok ? masked : '未配置') + '</span></div>' +
          '</div>';
        container.appendChild(card);

        // 绑定事件
        card.querySelector('.btn-configure').addEventListener('click', () => {
          vscode.postMessage({ type: 'configureModelKey', providerId: p.id });
        });
        const clearBtn = card.querySelector('.btn-clear');
        if (clearBtn) {
          clearBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'clearModelKey', providerId: p.id });
          });
        }
      });

      customModels.forEach((m, idx) => {
        const card = document.createElement('div');
        card.className = 'model-card';
        card.innerHTML =
          '<div class="model-card-header">' +
            '<div class="model-card-status">' +
              '<span class="status-dot ' + (m.configured ? 'configured' : 'unconfigured') + '"></span>' +
              '<span class="model-card-name">自定义: ' + m.name + '</span>' +
            '</div>' +
            '<div class="model-card-actions">' +
              '<button class="icon-btn btn-remove-custom" title="删除" data-index="' + idx + '">' + deleteSvg + '</button>' +
            '</div>' +
          '</div>' +
          '<div class="model-card-details">' +
            '<div class="detail-row"><span class="detail-label">端点</span><span class="detail-value">' + (m.url || '未设置') + '</span></div>' +
            '<div class="detail-row"><span class="detail-label">API Key</span><span class="detail-value masked' + (m.configured ? '' : ' unconfigured') + '">' + (m.configured ? m.maskedKey || '已配置' : '未配置') + '</span></div>' +
          '</div>';
        container.appendChild(card);

        // 绑定事件
        card.querySelector('.btn-remove-custom').addEventListener('click', () => {
          vscode.postMessage({ type: 'removeCustomModel', index: idx });
        });
      });
    }

    // ─── MCP 渲染 ───
    function renderMcpServers(servers) {
      const container = document.getElementById('mcp-list');
      const deleteSvg = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M10 3h3v1h-1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4H3V3h3V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1zM9 2H7v1h2V2zM5 4v9h6V4H5z"/></svg>';
      if (!servers || servers.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🔌</div><div class="empty-state-title">暂无 MCP 服务器</div><div class="empty-state-desc">点击"添加服务器"或编辑 .mcp.json 配置文件</div></div>';
        return;
      }
      container.innerHTML = '';
      servers.forEach(s => {
        const card = document.createElement('div');
        card.className = 'server-card';
        const statusClass = s.status === 'connected' ? 'configured' : 'unconfigured';
        card.innerHTML =
          '<div class="server-header">' +
            '<div class="server-info"><span class="status-dot ' + statusClass + '"></span><span class="server-name">' + s.name + '</span></div>' +
            '<div class="model-card-actions">' +
              '<button class="icon-btn btn-mcp-remove" title="删除" data-name="' + s.name + '">' + deleteSvg + '</button>' +
            '</div>' +
          '</div>' +
          (s.tools && s.tools.length > 0 ? '<div class="tool-tags">' + s.tools.map(t => '<span class="tool-tag">' + t + '</span>').join('') + '</div>' : '') +
          (s.command ? '<div class="server-cmd"><span style="color:var(--gongfeng-chat-text-secondary-foreground)">命令: </span><code>' + s.command + '</code></div>' : '') +
          (s.error ? '<div style="color:var(--gongfeng-errorForeground);font-size:12px;margin-top:6px">❌ ' + s.error + '</div>' : '');
        container.appendChild(card);

        card.querySelector('.btn-mcp-remove').addEventListener('click', () => {
          vscode.postMessage({ type: 'mcpRemoveServer', name: s.name });
        });
      });
    }
    // ─── 记忆渲染 ───
    function renderMemories(memories) {
      const container = document.getElementById('memory-list');
      const deleteSvg = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M10 3h3v1h-1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4H3V3h3V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1zM9 2H7v1h2V2zM5 4v9h6V4H5z"/></svg>';
      if (!memories || memories.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🧠</div><div class="empty-state-title">暂无记忆</div><div class="empty-state-desc">AI 会在对话中自动提取记忆，你也可以手动添加</div></div>';
        return;
      }
      container.innerHTML = '';
      memories.forEach(m => {
        const card = document.createElement('div');
        card.className = 'memory-card';
        card.innerHTML =
          '<div class="memory-header">' +
            '<span class="memory-type">' + (m.category || m.type || 'other') + '</span>' +
            '<button class="icon-btn btn-memory-delete" title="删除" data-id="' + m.id + '">' + deleteSvg + '</button>' +
          '</div>' +
          '<div class="memory-content">' + (m.content || m.title || '') + '</div>' +
          '<div class="memory-meta">' + (m.source || '') + (m.updatedAt || m.createdAt ? ' · ' + (m.updatedAt || m.createdAt) : '') + '</div>';
        container.appendChild(card);

        card.querySelector('.btn-memory-delete').addEventListener('click', () => {
          vscode.postMessage({ type: 'memoryDelete', id: m.id });
        });
      });
    }
    // ─── 对话框 ───
    function showAddModelDialog() {
      document.getElementById('add-model-dialog').classList.add('visible');
      document.getElementById('custom-model-name').value = '';
      document.getElementById('custom-model-url').value = '';
      document.getElementById('custom-model-key').value = '';
      document.getElementById('custom-model-name').focus();
    }

    function hideAddModelDialog() {
      document.getElementById('add-model-dialog').classList.remove('visible');
    }

    function saveCustomModel() {
      const name = document.getElementById('custom-model-name').value.trim();
      const url = document.getElementById('custom-model-url').value.trim();
      const key = document.getElementById('custom-model-key').value.trim();
      if (!name) return;
      vscode.postMessage({ type: 'saveCustomModel', name, url, key });
      hideAddModelDialog();
    }

    // ─── 消息监听 ───
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'modelConfigs':
          modelConfigs = msg.configs || {};
          customModels = msg.customModels || [];
          renderModels();
          break;
        case 'mcpServers':
          renderMcpServers(msg.servers || []);
          break;
        case 'memories':
          renderMemories(msg.memories || []);
          break;
      }
    });
  </script>
</body>
</html>`;
  }
}

/** 生成随机 nonce */
function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
