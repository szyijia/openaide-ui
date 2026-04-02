/**
 * OpenAIDE — VS Code Extension 入口
 *
 * Phase 2 完整实现：
 * 1. 启动 Agent Core 子进程（通过 Bridge）
 * 2. 注册 Chat Panel (Webview Provider)
 * 3. 注册 Inline Diff 管理器
 * 4. 注册代码补全 Provider
 * 5. 注册命令和快捷键
 * 6. 注册状态栏
 */

import * as vscode from 'vscode';
import { AgentBridge } from './bridge/agent-bridge.js';
import { ChatViewProvider } from './chat/chat-view-provider.js';
import { InlineDiffManager } from './diff/inline-diff-manager.js';
import { MultiFileDiffPanel } from './diff/multi-file-diff-panel.js';
import { OpenAIDECompletionProvider } from './completion/completion-provider.js';
import { MCPPanel } from './mcp/mcp-panel.js';
import { MemoryPanel } from './memory/memory-panel.js';
import { UpdateManager } from './updater/update-manager.js';
import { MCPMarketplacePanel } from './mcp/marketplace-panel.js';
import { SettingsPanel } from './chat/settings-panel.js';
import type { FileEditNotification, FileCreateNotification, StatusUpdateNotification, ToolApprovalRequestNotification } from './bridge/protocol.js';

/** Extension 全局状态 */
let bridge: AgentBridge;
let chatProvider: ChatViewProvider;
let diffManager: InlineDiffManager;
let multiFileDiffPanel: MultiFileDiffPanel;
let completionProvider: OpenAIDECompletionProvider;
let mcpPanel: MCPPanel;
let memoryPanel: MemoryPanel;
let updateManager: UpdateManager;
let mcpMarketplacePanel: MCPMarketplacePanel;
let statusBarItem: vscode.StatusBarItem;
let statusBarModel: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext) {
  console.log('OpenAIDE Extension 已激活');

  // ─── 1. 初始化 Bridge 通信 ───
  bridge = new AgentBridge({
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    env: getApiKeyEnv(),
  });

  // ─── 2. 初始化 Chat Panel ───
  chatProvider = new ChatViewProvider(context.extensionUri, bridge);
  const chatViewRegistration = vscode.window.registerWebviewViewProvider(
    ChatViewProvider.viewType,
    chatProvider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );

  // ─── 3. 初始化 Inline Diff ───
  diffManager = new InlineDiffManager();
  multiFileDiffPanel = new MultiFileDiffPanel(diffManager);

  // ─── 3.5 初始化 MCP 面板和记忆面板 ───
  mcpPanel = new MCPPanel(bridge);
  memoryPanel = new MemoryPanel(bridge);

  // 监听 Bridge 的文件编辑事件
  bridge.on('file:edit', async (data: FileEditNotification) => {
    await diffManager.showDiff({
      path: data.path,
      originalContent: data.originalContent,
      newContent: data.newContent,
      description: data.description,
    });
    // 通知聊天界面显示变更面板
    const stats = diffManager.computeStats(data.originalContent, data.newContent);
    chatProvider.addPendingChange({
      path: data.path,
      fileName: data.path.split('/').pop() || data.path,
      additions: stats.additions,
      deletions: stats.deletions,
      description: data.description,
    });
  });

  // 监听聊天界面变更面板的操作，转发给 diffManager
  chatProvider.onPendingChangeAction(async (action) => {
    switch (action.type) {
      case 'accept':
        if (action.path) await diffManager.accept(action.path);
        break;
      case 'reject':
        if (action.path) diffManager.reject(action.path);
        break;
      case 'acceptAll':
        await diffManager.acceptAll();
        break;
      case 'rejectAll':
        diffManager.rejectAll();
        break;
    }
  });

  bridge.on('file:create', async (data: FileCreateNotification) => {
    // 创建文件
    const uri = vscode.Uri.file(data.path);
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(uri, encoder.encode(data.content));
    const doc = await vscode.workspace.openTextDocument(uri);
    vscode.window.showTextDocument(doc);
  });

  // 工具权限持久化 Key
  const APPROVED_TOOLS_KEY = 'openaide.approvedTools';

  /** 获取已授权的工具列表 */
  function getApprovedTools(): string[] {
    return context.globalState.get<string[]>(APPROVED_TOOLS_KEY, []);
  }

  /** 将工具添加到"始终允许"列表 */
  async function addApprovedTool(toolName: string): Promise<void> {
    const approved = getApprovedTools();
    if (!approved.includes(toolName)) {
      approved.push(toolName);
      await context.globalState.update(APPROVED_TOOLS_KEY, approved);
    }
  }

  // 监听工具审批请求
  bridge.on('tool:approvalRequest', async (data: ToolApprovalRequestNotification) => {
    // 如果该工具已被"始终允许"，直接批准，不弹窗
    if (getApprovedTools().includes(data.toolName)) {
      await bridge.toolApprove({ toolCallId: data.toolCallId });
      return;
    }

    const action = await vscode.window.showWarningMessage(
      `🔧 工具 "${data.toolName}" 请求执行权限`,
      { modal: false, detail: data.description },
      '✅ 允许',
      '❌ 拒绝',
      '✅ 始终允许',
    );

    switch (action) {
      case '✅ 允许':
        await bridge.toolApprove({ toolCallId: data.toolCallId });
        break;
      case '✅ 始终允许':
        await addApprovedTool(data.toolName);
        await bridge.toolApprove({ toolCallId: data.toolCallId });
        break;
      case '❌ 拒绝':
      default:
        await bridge.toolDeny({ toolCallId: data.toolCallId, reason: '用户拒绝' });
        break;
    }
  });

  // ─── 4. 初始化代码补全 ───
  completionProvider = new OpenAIDECompletionProvider(bridge, {
    enabled: vscode.workspace.getConfiguration('openaide').get('completion.enabled', true),
    debounceMs: vscode.workspace.getConfiguration('openaide').get('completion.debounceMs', 300),
  });

  const completionRegistration = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: '**' }, // 所有文件类型
    completionProvider,
  );

  // 补全状态栏指示器
  const completionStatusBar = completionProvider.initStatusBar();

  // 切换补全启用/禁用
  const cmdToggleCompletion = vscode.commands.registerCommand('openaide.toggleCompletion', () => {
    completionProvider.toggle();
  });

  // ─── 5. 注册命令 ───

  // 新建对话
  const cmdNewChat = vscode.commands.registerCommand('openaide.newChat', async () => {
    try {
      await bridge.sessionCreate();
      chatProvider.clearMessages();
      vscode.commands.executeCommand('openaide.chatView.focus');
    } catch {
      // 回退到简单清空
      await bridge.chatClear();
      chatProvider.clearMessages();
      vscode.commands.executeCommand('openaide.chatView.focus');
    }
  });

  // 会话历史
  const cmdSessionHistory = vscode.commands.registerCommand('openaide.sessionHistory', async () => {
    try {
      const result = await bridge.sessionList();
      if (!result.sessions || result.sessions.length === 0) {
        vscode.window.showInformationMessage('暂无历史会话');
        return;
      }

      const items = result.sessions.map((s) => ({
        label: s.title || '未命名对话',
        description: `${s.messageCount} 条消息`,
        detail: `最后更新: ${new Date(s.updatedAt).toLocaleString('zh-CN')}`,
        sessionId: s.id,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: '选择要恢复的会话',
      });

      if (picked) {
        const switchResult = await bridge.sessionSwitch(picked.sessionId);
        if (switchResult.ok) {
          // 用返回的消息历史恢复 Chat Panel
          if (switchResult.messages && switchResult.messages.length > 0) {
            chatProvider.restoreFromCoreMessages(switchResult.messages);
          } else {
            chatProvider.clearMessages();
          }
          vscode.commands.executeCommand('openaide.chatView.focus');
          vscode.window.showInformationMessage(`已切换到: ${picked.label}`);
        }
      }
    } catch (error) {
      vscode.window.showErrorMessage('加载会话历史失败');
    }
  });

  // 询问选中代码
  const cmdAskAbout = vscode.commands.registerCommand('openaide.askAboutSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const selection = editor.document.getText(editor.selection);
    if (!selection) {
      vscode.window.showWarningMessage('请先选中代码');
      return;
    }

    const language = editor.document.languageId;
    const fileName = editor.document.fileName.split('/').pop();
    const message = `请分析以下来自 \`${fileName}\` 的 ${language} 代码：\n\n\`\`\`${language}\n${selection}\n\`\`\``;

    // 聚焦 Chat Panel 并发送
    vscode.commands.executeCommand('openaide.chatView.focus');
    await bridge.chatSend({ message });
  });

  // 解释代码
  const cmdExplain = vscode.commands.registerCommand('openaide.explainCode', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const selection = editor.document.getText(editor.selection);
    if (!selection) {
      vscode.window.showWarningMessage('请先选中代码');
      return;
    }

    const language = editor.document.languageId;
    const message = `请详细解释以下 ${language} 代码的功能和实现逻辑：\n\n\`\`\`${language}\n${selection}\n\`\`\``;

    vscode.commands.executeCommand('openaide.chatView.focus');
    await bridge.chatSend({ message });
  });

  // 重构代码
  const cmdRefactor = vscode.commands.registerCommand('openaide.refactorCode', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const selection = editor.document.getText(editor.selection);
    if (!selection) {
      vscode.window.showWarningMessage('请先选中代码');
      return;
    }

    const language = editor.document.languageId;
    const message = `请重构以下 ${language} 代码，提升可读性和性能：\n\n\`\`\`${language}\n${selection}\n\`\`\``;

    vscode.commands.executeCommand('openaide.chatView.focus');
    await bridge.chatSend({ message });
  });

  // 生成测试
  const cmdGenerateTests = vscode.commands.registerCommand('openaide.generateTests', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const selection = editor.document.getText(editor.selection);
    const language = editor.document.languageId;
    const fileName = editor.document.fileName;

    const code = selection || editor.document.getText();
    const message = `请为以下 ${language} 代码生成完整的单元测试：\n\n文件: ${fileName}\n\n\`\`\`${language}\n${code}\n\`\`\``;

    vscode.commands.executeCommand('openaide.chatView.focus');
    await bridge.chatSend({ message });
  });

  // 修复错误
  const cmdFixError = vscode.commands.registerCommand('openaide.fixError', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    // 获取当前文件的诊断信息
    const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
    const errors = diagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Error);

    if (errors.length === 0) {
      vscode.window.showInformationMessage('当前文件没有错误');
      return;
    }

    const errorMessages = errors
      .map((e) => `行 ${e.range.start.line + 1}: ${e.message}`)
      .join('\n');

    const language = editor.document.languageId;
    const content = editor.document.getText();
    const fileName = editor.document.fileName.split('/').pop();

    const message = `请修复 \`${fileName}\` 中的以下错误：\n\n错误列表:\n${errorMessages}\n\n文件内容:\n\`\`\`${language}\n${content}\n\`\`\``;

    vscode.commands.executeCommand('openaide.chatView.focus');
    await bridge.chatSend({ message });
  });

  // 切换模型
  const cmdSelectModel = vscode.commands.registerCommand('openaide.selectModel', async () => {
    const config = vscode.workspace.getConfiguration('openaide');
    const customBaseUrl = config.get<string>('custom.baseUrl', '');
    const customModel = config.get<string>('custom.model', '');
    const customApiKey = config.get<string>('custom.apiKey', '');

    // 模型与 API Key 配置的映射
    const providerKeyMap: Record<string, string> = {
      anthropic: 'anthropicApiKey',
      openai: 'openaiApiKey',
      deepseek: 'deepseekApiKey',
      qwen: 'qwenApiKey',
      glm: 'glmApiKey',
    };

    const allModels = [
      { label: 'Claude Sonnet 4', icon: '$(sparkle)', description: 'anthropic/claude-sonnet-4-20250514', detail: '最佳综合能力', provider: 'anthropic' },
      { label: 'Claude Opus 4', icon: '$(sparkle)', description: 'anthropic/claude-opus-4-20250514', detail: '最强推理能力', provider: 'anthropic' },
      { label: 'GPT-4o', icon: '$(zap)', description: 'openai/gpt-4o', detail: '快速响应', provider: 'openai' },
      { label: 'DeepSeek V3', icon: '$(rocket)', description: 'deepseek/deepseek-chat', detail: '高性价比', provider: 'deepseek' },
      { label: 'Qwen Max', icon: '$(globe)', description: 'qwen/qwen-max', detail: '中文优化', provider: 'qwen' },
      { label: 'GLM 5.1', icon: '$(beaker)', description: 'glm/glm-5.1', detail: '智谱 Coding Plan', provider: 'glm' },
      { label: 'GLM-4-Flash', icon: '$(beaker)', description: 'glm/glm-4-flash', detail: '智谱免费模型', provider: 'glm' },
      { label: 'Ollama 本地', icon: '$(server)', description: 'ollama/qwen2.5-coder', detail: '离线可用（无需 Key）', provider: 'ollama' },
    ];

    const models: vscode.QuickPickItem[] = allModels.map(m => {
      const keyConfig = providerKeyMap[m.provider];
      const hasKey = !keyConfig || !!config.get<string>(keyConfig, ''); // ollama 无需 key
      return {
        label: `${m.icon} ${m.label}` + (hasKey ? '' : ' $(warning)'),
        description: m.description,
        detail: m.detail + (hasKey ? '' : '  ⚠️ 未配置 API Key'),
      };
    });

    // 如果配置了自定义模型，添加到列表
    if (customBaseUrl && customModel) {
      const hasCustomKey = !!customApiKey;
      models.push({
        label: `$(plug) 自定义: ${customModel}` + (hasCustomKey ? '' : ' $(warning)'),
        description: `custom/${customModel}`,
        detail: `端点: ${customBaseUrl}` + (hasCustomKey ? '' : '  ⚠️ 未配置 API Key'),
      });
    }

    models.push({
      label: '$(gear) 配置 API Key...',
      description: '__configure__',
      detail: '前往设置页面配置各模型提供者的 API Key',
    });

    const picked = await vscode.window.showQuickPick(models, {
      placeHolder: '选择 AI 模型（带 ⚠️ 标记的需要先配置 API Key）',
    });

    if (picked) {
      if (picked.description === '__configure__') {
        vscode.commands.executeCommand('openaide.openSettings');
        return;
      }
      // 检查选中的模型是否已配置 key
      const providerName = picked.description?.split('/')[0] || '';
      const keyConfig = providerKeyMap[providerName];
      if (keyConfig && !config.get<string>(keyConfig, '')) {
        const action = await vscode.window.showWarningMessage(
          `${providerName} 的 API Key 尚未配置，请先在设置中配置。`,
          '前往设置',
        );
        if (action === '前往设置') {
          vscode.commands.executeCommand('openaide.openSettings');
        }
        return;
      }
      // 持久化模型选择到 VSCode 配置
      await config.update('model', picked.description, vscode.ConfigurationTarget.Global);
      const modelName = picked.label.replace(/\$\([^)]+\)\s*/g, '').trim();
      updateStatusBar(modelName);
      chatProvider.updateModelName(modelName);
      // 用新的环境变量重启 bridge，确保 Rust 侧能拿到正确的 API Key
      await restartBridgeWithNewEnv();
      vscode.window.showInformationMessage(`已切换到 ${modelName}`);
    }
  });

  // 配置 API Key
  const cmdConfigureApiKeys = vscode.commands.registerCommand('openaide.configureApiKeys', async () => {
    const providers = [
      { label: '$(sparkle) Anthropic (Claude)', configKey: 'anthropicApiKey', envKey: 'ANTHROPIC_API_KEY', placeholder: 'sk-ant-...' },
      { label: '$(zap) OpenAI (GPT)', configKey: 'openaiApiKey', envKey: 'OPENAI_API_KEY', placeholder: 'sk-...' },
      { label: '$(rocket) DeepSeek', configKey: 'deepseekApiKey', envKey: 'DEEPSEEK_API_KEY', placeholder: 'sk-...' },
      { label: '$(globe) 通义千问 (Qwen)', configKey: 'qwenApiKey', envKey: 'DASHSCOPE_API_KEY', placeholder: 'sk-...' },
      { label: '$(beaker) 智谱 GLM', configKey: 'glmApiKey', envKey: 'GLM_API_KEY', placeholder: '...' },
      { label: '$(plug) 自定义模型', configKey: '__custom__', envKey: '', placeholder: '' },
    ];

    const config = vscode.workspace.getConfiguration('openaide');

    // 显示各 Provider 的配置状态
    const items = providers.map((p) => {
      let currentKey = '';
      if (p.configKey === '__custom__') {
        const customUrl = config.get<string>('custom.baseUrl', '');
        const customModel = config.get<string>('custom.model', '');
        return {
          ...p,
          description: customUrl ? `${customModel} @ ${customUrl}` : '未配置',
          detail: '配置自定义 API 端点、模型名和 Key',
        };
      }
      currentKey = config.get<string>(p.configKey, '');
      return {
        ...p,
        description: currentKey ? `已配置 (${maskKey(currentKey)})` : '未配置',
        detail: `环境变量: ${p.envKey}`,
      };
    });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: '选择要配置的模型提供者',
    });

    if (!picked) return;

    if (picked.configKey === '__custom__') {
      // 自定义模型配置流程
      const baseUrl = await vscode.window.showInputBox({
        prompt: '输入 API 端点 URL',
        placeHolder: 'https://api.example.com/v1',
        value: config.get<string>('custom.baseUrl', ''),
      });
      if (baseUrl === undefined) return;

      const modelName = await vscode.window.showInputBox({
        prompt: '输入模型名称',
        placeHolder: 'gpt-4o / glm-5.1 / ...',
        value: config.get<string>('custom.model', ''),
      });
      if (modelName === undefined) return;

      const apiKey = await vscode.window.showInputBox({
        prompt: '输入 API Key',
        placeHolder: 'sk-...',
        password: true,
        value: config.get<string>('custom.apiKey', ''),
      });
      if (apiKey === undefined) return;

      await config.update('custom.baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
      await config.update('custom.model', modelName, vscode.ConfigurationTarget.Global);
      await config.update('custom.apiKey', apiKey, vscode.ConfigurationTarget.Global);

      // 同步到 Bridge
      if (apiKey) {
        await bridge.configSet({ key: 'CUSTOM_API_KEY', value: apiKey });
        await bridge.configSet({ key: 'CUSTOM_BASE_URL', value: baseUrl });
        await bridge.configSet({ key: 'CUSTOM_MODEL', value: modelName });
      }

      vscode.window.showInformationMessage(
        `自定义模型已配置: ${modelName} @ ${baseUrl}`,
      );
      return;
    }

    // 标准 Provider 配置
    const apiKey = await vscode.window.showInputBox({
      prompt: `输入 ${picked.label.replace(/\$\([^)]+\)\s*/, '')} 的 API Key`,
      placeHolder: picked.placeholder,
      password: true,
      value: config.get<string>(picked.configKey, ''),
    });

    if (apiKey === undefined) return;

    await config.update(picked.configKey, apiKey, vscode.ConfigurationTarget.Global);

    // 用新的环境变量重启 bridge，确保 Rust 侧能拿到最新的 API Key
    await restartBridgeWithNewEnv();

    vscode.window.showInformationMessage(
      apiKey
        ? `${picked.label.replace(/\$\([^)]+\)\s*/, '')} API Key 已保存`
        : `${picked.label.replace(/\$\([^)]+\)\s*/, '')} API Key 已清除`,
    );
  });

  // 清空对话
  const cmdClearChat = vscode.commands.registerCommand('openaide.clearChat', async () => {
    try {
      await bridge.chatClear();
      chatProvider.clearMessages();
    } catch {
      chatProvider.clearMessages();
    }
  });

  // 接受所有 Diff
  const cmdAcceptAllDiffs = vscode.commands.registerCommand('openaide.acceptAllDiffs', () => {
    diffManager.acceptAll();
  });

  // 拒绝所有 Diff
  const cmdRejectAllDiffs = vscode.commands.registerCommand('openaide.rejectAllDiffs', () => {
    diffManager.rejectAll();
  });

  // 打开设置页面（在编辑器区域 Tab 中）
  const cmdOpenSettings = vscode.commands.registerCommand('openaide.openSettings', () => {
    SettingsPanel.createOrShow(context.extensionUri, bridge);
  });

  // ─── 6. 状态栏 ───

  // 主状态栏项 — 显示 Agent 状态
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(sparkle) OpenAIDE';
  statusBarItem.tooltip = 'OpenAIDE — 就绪';
  statusBarItem.command = 'openaide.newChat';
  statusBarItem.show();

  // 模型状态栏项
  statusBarModel = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  statusBarModel.text = `$(hubot) ${getInitialModelDisplayName()}`;
  statusBarModel.tooltip = '点击切换模型';
  statusBarModel.command = 'openaide.selectModel';
  statusBarModel.show();

  // 监听配置变化，当 API Key 改变时通知聊天界面刷新
  const configChangeDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('openaide')) {
      // 刷新设置面板中的模型列表
      if (SettingsPanel.currentPanel) {
        // 设置面板会自行处理刷新（通过 loadModelConfigs）
      }
    }
  });

  // 监听状态更新
  bridge.on('status:update', (data: StatusUpdateNotification) => {
    updateAgentStatus(data.state, data.message);
  });

  // ─── 7. 编辑器上下文追踪 ───

  // 当活动编辑器变化时，更新上下文
  const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) {
      bridge.contextUpdate({
        activeFile: editor.document.uri.fsPath,
        openFiles: vscode.window.visibleTextEditors.map((e) => e.document.uri.fsPath),
        workspaceFolders: vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [],
      });
    }
  });

  // 当选中内容变化时，更新上下文
  const selectionChangeDisposable = vscode.window.onDidChangeTextEditorSelection((event) => {
    const editor = event.textEditor;
    const selection = editor.selection;
    if (!selection.isEmpty) {
      bridge.contextUpdate({
        activeFile: editor.document.uri.fsPath,
        selection: {
          start: { line: selection.start.line, character: selection.start.character },
          end: { line: selection.end.line, character: selection.end.character },
          text: editor.document.getText(selection),
        },
        openFiles: vscode.window.visibleTextEditors.map((e) => e.document.uri.fsPath),
        workspaceFolders: vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [],
      });
    }
  });

  // 当文件保存时，更新上下文
  const saveDisposable = vscode.workspace.onDidSaveTextDocument((document) => {
    bridge.contextUpdate({
      activeFile: document.uri.fsPath,
      openFiles: vscode.window.visibleTextEditors.map((e) => e.document.uri.fsPath),
      workspaceFolders: vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [],
    });
  });

  // 当诊断信息变化时（错误/警告），可用于自动修复建议
  const diagnosticDisposable = vscode.languages.onDidChangeDiagnostics((event) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    // 只关注当前活动文件的诊断变化
    const affectsActive = event.uris.some(
      (uri) => uri.toString() === editor.document.uri.toString(),
    );
    if (!affectsActive) return;

    const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
    const errors = diagnostics.filter((d) => d.severity === vscode.DiagnosticSeverity.Error);

    if (errors.length > 0) {
      // 更新状态栏显示错误数
      statusBarItem.text = `$(sparkle) OpenAIDE (${errors.length} 错误)`;
    } else {
      statusBarItem.text = '$(sparkle) OpenAIDE';
    }
  });

  // ─── 8. 初始化自动更新 ───
  updateManager = new UpdateManager(context);

  // ─── 8.5 初始化 MCP Marketplace ───
  mcpMarketplacePanel = new MCPMarketplacePanel(context);

  // ─── 9. 启动 Bridge（异步，不阻塞激活） ───
  startBridge();

  // ─── 注册所有 disposables ───
  context.subscriptions.push(
    chatViewRegistration,
    completionRegistration,
    cmdNewChat,
    cmdSessionHistory,
    cmdAskAbout,
    cmdExplain,
    cmdRefactor,
    cmdGenerateTests,
    cmdFixError,
    cmdSelectModel,
    cmdConfigureApiKeys,
    cmdClearChat,
    cmdAcceptAllDiffs,
    cmdRejectAllDiffs,
    cmdOpenSettings,
    cmdToggleCompletion,
    statusBarItem,
    completionStatusBar,
    statusBarModel,
    configChangeDisposable,
    editorChangeDisposable,
    selectionChangeDisposable,
    saveDisposable,
    diagnosticDisposable,
    { dispose: () => bridge.dispose() },
    { dispose: () => mcpPanel.dispose() },
    { dispose: () => memoryPanel.dispose() },
    { dispose: () => multiFileDiffPanel.dispose() },
    { dispose: () => diffManager.dispose() },
    { dispose: () => completionProvider.dispose() },
    { dispose: () => updateManager.dispose() },
    { dispose: () => mcpMarketplacePanel.dispose() },
  );
}

export function deactivate() {
  console.log('OpenAIDE Extension 已停用');
  bridge?.dispose();
  diffManager?.dispose();
  completionProvider?.dispose();
}

// ─── 辅助函数 ───

/** 异步启动 Bridge */
async function startBridge(): Promise<void> {
  try {
    await bridge.start();
    updateAgentStatus('idle');
  } catch (error) {
    console.error('[OpenAIDE] Bridge 启动失败:', error);
    updateAgentStatus('error', 'Agent Core 启动失败');
    // 不阻塞 Extension 激活，用户可以稍后重试
    vscode.window.showWarningMessage(
      'OpenAIDE: Agent Core 启动失败，部分功能不可用',
      '重试',
    ).then((action) => {
      if (action === '重试') {
        startBridge();
      }
    });
  }
}

/** 用最新的环境变量重启 Bridge（模型切换或 API Key 变更时调用） */
async function restartBridgeWithNewEnv(): Promise<void> {
  try {
    updateAgentStatus('thinking', '正在重启 Agent Core...');
    bridge.updateEnv(getApiKeyEnv());
    await bridge.restart();
    updateAgentStatus('idle');
    console.log('[OpenAIDE] Bridge 已用新环境变量重启');
  } catch (error) {
    console.error('[OpenAIDE] Bridge 重启失败:', error);
    updateAgentStatus('error', 'Agent Core 重启失败');
  }
}

/** 更新 Agent 状态显示 */
function updateAgentStatus(state: string, message?: string): void {
  switch (state) {
    case 'idle':
      statusBarItem.text = '$(sparkle) OpenAIDE';
      statusBarItem.tooltip = 'OpenAIDE — 就绪';
      statusBarItem.backgroundColor = undefined;
      break;
    case 'thinking':
      statusBarItem.text = '$(loading~spin) 思考中...';
      statusBarItem.tooltip = 'OpenAIDE — 正在思考';
      break;
    case 'streaming':
      statusBarItem.text = '$(edit) 生成中...';
      statusBarItem.tooltip = 'OpenAIDE — 正在生成回复';
      break;
    case 'tool_calling':
      statusBarItem.text = '$(tools) 执行工具...';
      statusBarItem.tooltip = `OpenAIDE — ${message || '正在执行工具'}`;
      break;
    case 'error':
      statusBarItem.text = '$(error) OpenAIDE';
      statusBarItem.tooltip = `OpenAIDE — 错误: ${message || '未知错误'}`;
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      break;
  }
}

/** 更新模型显示 */
function updateStatusBar(modelName: string): void {
  statusBarModel.text = `$(hubot) ${modelName}`;
}

/** API Key 掩码显示 */
function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

/** 根据已配置的 API Key 获取初始模型显示名称 */
function getInitialModelDisplayName(): string {
  const config = vscode.workspace.getConfiguration('openaide');

  // 如果已显式配置了 model，使用该模型
  const model = config.get<string>('model', '');
  if (model) {
    const modelMap: Record<string, string> = {
      'anthropic/claude-sonnet-4-20250514': 'Claude Sonnet 4',
      'anthropic/claude-opus-4-20250514': 'Claude Opus 4',
      'openai/gpt-4o': 'GPT-4o',
      'deepseek/deepseek-chat': 'DeepSeek V3',
      'qwen/qwen-max': 'Qwen Max',
      'glm/glm-5.1': 'GLM 5.1',
    };
    return modelMap[model] || model.split('/').pop() || model;
  }

  // 检查哪个 provider 已配置了 API Key，优先展示该 provider 的模型
  const providerKeyMap: { configKey: string; displayName: string }[] = [
    { configKey: 'anthropicApiKey', displayName: 'Claude Sonnet 4' },
    { configKey: 'openaiApiKey', displayName: 'GPT-4o' },
    { configKey: 'deepseekApiKey', displayName: 'DeepSeek V3' },
    { configKey: 'qwenApiKey', displayName: 'Qwen Max' },
    { configKey: 'glmApiKey', displayName: 'GLM 5.1' },
  ];

  for (const entry of providerKeyMap) {
    if (config.get<string>(entry.configKey, '')) {
      return entry.displayName;
    }
  }

  // 默认回退
  return 'Claude Sonnet 4';
}

/** 从 VS Code 配置获取 API Key 环境变量 */
function getApiKeyEnv(): Record<string, string> {
  const config = vscode.workspace.getConfiguration('openaide');
  const env: Record<string, string> = {};

  // 各 Provider 独立的 API Key（优先级最高）
  const anthropicKey = config.get<string>('anthropicApiKey', '');
  const openaiKey = config.get<string>('openaiApiKey', '');
  const deepseekKey = config.get<string>('deepseekApiKey', '');
  const qwenKey = config.get<string>('qwenApiKey', '');
  const glmKey = config.get<string>('glmApiKey', '');

  if (anthropicKey) env.ANTHROPIC_API_KEY = anthropicKey;
  if (openaiKey) env.OPENAI_API_KEY = openaiKey;
  if (deepseekKey) env.DEEPSEEK_API_KEY = deepseekKey;
  if (qwenKey) env.DASHSCOPE_API_KEY = qwenKey;
  if (glmKey) env.GLM_API_KEY = glmKey;

  // 通用 apiKey 作为后备（按 provider 映射）
  const apiKey = config.get<string>('apiKey', '');
  const provider = config.get<string>('provider', 'anthropic');
  if (apiKey) {
    const providerEnvMap: Record<string, string> = {
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      deepseek: 'DEEPSEEK_API_KEY',
      qwen: 'DASHSCOPE_API_KEY',
      glm: 'GLM_API_KEY',
    };
    const envKey = providerEnvMap[provider];
    if (envKey && !env[envKey]) {
      env[envKey] = apiKey;
    }
  }

  // 自定义模型配置
  const customApiKey = config.get<string>('custom.apiKey', '');
  const customBaseUrl = config.get<string>('custom.baseUrl', '');
  const customModel = config.get<string>('custom.model', '');
  if (customApiKey) env.CUSTOM_API_KEY = customApiKey;
  if (customBaseUrl) env.CUSTOM_BASE_URL = customBaseUrl;
  if (customModel) env.CUSTOM_MODEL = customModel;

  const model = config.get<string>('model');
  if (model) {
    env.OPENAIDE_MODEL = model;

    // 根据当前选择的模型，设置通用的 OPENAIDE_API_KEY 和 OPENAIDE_BASE_URL
    // 这样 Rust bridge 层可以统一使用这两个环境变量构造 OpenAI 兼容客户端
    const providerName = model.split('/')[0] || '';
    const providerApiKeyMap: Record<string, string> = {
      anthropic: anthropicKey,
      openai: openaiKey,
      deepseek: deepseekKey,
      qwen: qwenKey,
      glm: glmKey,
      ollama: 'ollama', // Ollama 不需要真实 API Key
      custom: config.get<string>('custom.apiKey', ''),
    };
    const providerBaseUrlMap: Record<string, string> = {
      glm: 'https://open.bigmodel.cn/api/coding/paas/v4',
      custom: config.get<string>('custom.baseUrl', ''),
    };

    const resolvedApiKey = providerApiKeyMap[providerName] || '';
    if (resolvedApiKey) {
      env.OPENAIDE_API_KEY = resolvedApiKey;
    }
    const resolvedBaseUrl = providerBaseUrlMap[providerName] || '';
    if (resolvedBaseUrl) {
      env.OPENAIDE_BASE_URL = resolvedBaseUrl;
    }
  }

  return env;
}
