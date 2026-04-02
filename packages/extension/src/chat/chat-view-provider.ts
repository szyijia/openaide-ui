/**
 * Chat Panel — Webview Provider
 *
 * 在 VS Code 侧边栏中提供 AI 对话界面
 * 使用 Webview 渲染 React Chat UI
 */

import * as vscode from 'vscode';
import type { AgentBridge } from '../bridge/agent-bridge.js';
import type {
  ChatTextNotification,
  ChatThinkingNotification,
  ToolCallNotification,
  ToolResultNotification,
  ChatDoneNotification,
  ChatErrorNotification,
} from '../bridge/protocol.js';

/** Chat 消息类型 */
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  thinking?: string;
  toolCalls?: ToolCallInfo[];
  usage?: { inputTokens: number; outputTokens: number; totalCostUSD?: number };
  isStreaming?: boolean;
}

/** 工具调用信息 */
interface ToolCallInfo {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  isComplete: boolean;
}

/** 待处理的文件变更信息 */
interface PendingChangeInfo {
  path: string;
  fileName: string;
  additions: number;
  deletions: number;
  description?: string;
}

/** Webview 接收的消息类型 */
type WebviewMessage =
  | { type: 'sendMessage'; message: string }
  | { type: 'cancelRequest' }
  | { type: 'clearChat' }
  | { type: 'approveToolCall'; toolCallId: string }
  | { type: 'denyToolCall'; toolCallId: string; reason?: string }
  | { type: 'selectModel' }
  | { type: 'copyCode'; code: string }
  | { type: 'insertCode'; code: string }
  | { type: 'openFile'; path: string }
  | { type: 'requestFiles'; query: string }
  | { type: 'openSettings' }
  | { type: 'openHistory' }
  | { type: 'acceptChange'; path: string }
  | { type: 'rejectChange'; path: string }
  | { type: 'acceptAllChanges' }
  | { type: 'rejectAllChanges' }
  | { type: 'viewChangeDiff'; path: string }
  | { type: 'webviewReady' };

/**
 * ChatViewProvider — VS Code Webview View Provider
 *
 * 注册为侧边栏视图，提供 AI 对话界面
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'openaide.chatView';

  private webviewView?: vscode.WebviewView;
  private messages: ChatMessage[] = [];
  private currentAssistantMessage: ChatMessage | null = null;
  private messageIdCounter = 0;
  private pendingChanges: PendingChangeInfo[] = [];
  private onChangeAction = new vscode.EventEmitter<{ type: 'accept' | 'reject' | 'acceptAll' | 'rejectAll'; path?: string }>();
  readonly onPendingChangeAction = this.onChangeAction.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly bridge: AgentBridge,
  ) {
    this.setupBridgeListeners();
  }

  /**
   * VS Code 调用此方法来初始化 Webview
   */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    console.log('[OpenAIDE] resolveWebviewView called');
    this.webviewView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // 监听 Webview 消息
    webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      this.handleWebviewMessage(msg);
    });

    // 视图可见时同步消息
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.syncMessages();
      }
    });

  }

  /**
   * 设置 Bridge 事件监听
   */
  private setupBridgeListeners(): void {
    this.bridge.on('chat:text', (data: ChatTextNotification) => {
      this.handleStreamText(data.text);
    });

    this.bridge.on('chat:thinking', (data: ChatThinkingNotification) => {
      this.handleStreamThinking(data.text);
    });

    this.bridge.on('chat:toolCall', (data: ToolCallNotification) => {
      this.handleToolCall(data);
    });

    this.bridge.on('chat:toolResult', (data: ToolResultNotification) => {
      this.handleToolResult(data);
    });

    this.bridge.on('chat:done', (data: ChatDoneNotification) => {
      this.handleDone(data);
    });

    this.bridge.on('chat:error', (data: ChatErrorNotification) => {
      this.handleError(data);
    });
  }

  /**
   * 处理 Webview 发来的消息
   */
  private async handleWebviewMessage(msg: WebviewMessage): Promise<void> {
    console.log('[OpenAIDE] Received webview message:', msg.type);
    switch (msg.type) {
      case 'sendMessage':
        console.log('[OpenAIDE] sendMessage:', msg.message);
        await this.sendUserMessage(msg.message);
        break;

      case 'cancelRequest':
        await this.bridge.chatCancel();
        if (this.currentAssistantMessage) {
          this.currentAssistantMessage.isStreaming = false;
          this.currentAssistantMessage = null;
        }
        this.postToWebview({ type: 'streamEnd' });
        break;

      case 'clearChat':
        await this.bridge.chatClear();
        this.messages = [];
        this.currentAssistantMessage = null;
        this.postToWebview({ type: 'clearMessages' });
        break;

      case 'approveToolCall':
        await this.bridge.toolApprove({ toolCallId: msg.toolCallId });
        break;

      case 'denyToolCall':
        await this.bridge.toolDeny({ toolCallId: msg.toolCallId, reason: msg.reason });
        break;

      case 'selectModel':
        vscode.commands.executeCommand('openaide.selectModel');
        break;

      case 'openSettings':
        vscode.commands.executeCommand('openaide.openSettings');
        break;

      case 'openHistory':
        vscode.commands.executeCommand('openaide.sessionHistory');
        break;

      case 'copyCode':
        vscode.env.clipboard.writeText(msg.code);
        vscode.window.showInformationMessage('代码已复制到剪贴板');
        break;

      case 'insertCode':
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          editor.edit((editBuilder) => {
            editBuilder.insert(editor.selection.active, msg.code);
          });
        }
        break;

      case 'openFile':
        const doc = await vscode.workspace.openTextDocument(msg.path);
        vscode.window.showTextDocument(doc);
        break;

      case 'requestFiles':
        await this.handleFileSearch(msg.query);
        break;

      case 'acceptChange':
        this.onChangeAction.fire({ type: 'accept', path: msg.path });
        this.removePendingChange(msg.path);
        break;

      case 'rejectChange':
        this.onChangeAction.fire({ type: 'reject', path: msg.path });
        this.removePendingChange(msg.path);
        break;

      case 'acceptAllChanges':
        this.onChangeAction.fire({ type: 'acceptAll' });
        this.clearPendingChanges();
        break;

      case 'rejectAllChanges':
        this.onChangeAction.fire({ type: 'rejectAll' });
        this.clearPendingChanges();
        break;

      case 'viewChangeDiff':
        vscode.commands.executeCommand('openaide.diff.openFile', { kind: 'file', path: msg.path, fileName: msg.path.split('/').pop() || msg.path, changeType: 'modified', stats: { additions: 0, deletions: 0, modifications: 0 } });
        break;

      case 'webviewReady':
        console.log('[OpenAIDE] Webview is ready, sending initial model name');
        this.sendInitialModelName();
        // 如果有待处理的变更，同步到 Webview
        if (this.pendingChanges.length > 0) {
          this.postToWebview({ type: 'pendingChanges', changes: this.pendingChanges });
        }
        break;
    }
  }

  /**
   * 检查是否有任何 API Key 已配置
   */
  private hasAnyApiKeyConfigured(): boolean {
    const config = vscode.workspace.getConfiguration('openaide');
    const keys = [
      'apiKey',
      'anthropicApiKey',
      'openaiApiKey',
      'deepseekApiKey',
      'qwenApiKey',
      'glmApiKey',
      'custom.apiKey',
    ];
    return keys.some(k => !!config.get<string>(k, ''));
  }

  /**
   * 发送用户消息
   */
  private async sendUserMessage(text: string): Promise<void> {
    if (!text.trim()) return;

    // 检查是否有 API Key 配置
    if (!this.hasAnyApiKeyConfigured()) {
      const action = await vscode.window.showWarningMessage(
        '尚未配置任何大模型 API Key，请先在设置中配置后再使用。',
        '前往设置',
      );
      if (action === '前往设置') {
        vscode.commands.executeCommand('openaide.openSettings');
      }
      return;
    }

    // 添加用户消息
    const userMsg: ChatMessage = {
      id: `msg-${++this.messageIdCounter}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    this.messages.push(userMsg);
    this.postToWebview({ type: 'addMessage', message: userMsg });

    // 创建 assistant 消息占位
    this.currentAssistantMessage = {
      id: `msg-${++this.messageIdCounter}`,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [],
      isStreaming: true,
    };
    this.messages.push(this.currentAssistantMessage);
    this.postToWebview({ type: 'addMessage', message: this.currentAssistantMessage });

    // 发送到 Agent Core（不 await，流式事件通过 bridge 通知返回）
    console.log('[OpenAIDE] chatSend 发送消息到 Agent Core:', text.slice(0, 100));
    this.bridge.chatSend({ message: text }).catch((error) => {
      console.error('[OpenAIDE] chatSend 错误:', error);
      this.handleError({
        conversationId: 'default',
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  // ─── 流式事件处理 ───

  /** 跟踪上一个事件类型，用于判断是否需要创建新的 content 区块 */
  private lastStreamEventType: 'text' | 'thinking' | 'toolCall' | 'toolResult' | null = null;
  /** 当前 content 区块的序号 */
  private contentBlockIndex = 0;

  private handleStreamText(text: string): void {
    if (!this.currentAssistantMessage) {
      console.warn('[OpenAIDE] 收到 chat:text 但没有当前 assistant 消息');
      return;
    }
    console.log('[OpenAIDE] chat:text delta:', text.slice(0, 50));
    this.currentAssistantMessage.content += text;

    // 如果上一个事件是工具结果，说明 AI 在工具调用后继续输出文字
    // 需要通知 Webview 创建新的 content 区块，实现自然的对话流
    if (this.lastStreamEventType === 'toolResult') {
      this.contentBlockIndex++;
      this.postToWebview({
        type: 'newContentBlock',
        messageId: this.currentAssistantMessage.id,
        blockIndex: this.contentBlockIndex,
      });
    }

    this.lastStreamEventType = 'text';
    this.postToWebview({
      type: 'streamDelta',
      messageId: this.currentAssistantMessage.id,
      delta: text,
    });
  }

  private handleStreamThinking(text: string): void {
    if (!this.currentAssistantMessage) return;
    this.currentAssistantMessage.thinking =
      (this.currentAssistantMessage.thinking || '') + text;
    this.lastStreamEventType = 'thinking';
    this.postToWebview({
      type: 'thinkingDelta',
      messageId: this.currentAssistantMessage.id,
      delta: text,
    });
  }

  private handleToolCall(data: ToolCallNotification): void {
    if (!this.currentAssistantMessage) return;
    const toolCall: ToolCallInfo = {
      id: data.id,
      name: data.name,
      input: data.input,
      isComplete: false,
    };
    this.currentAssistantMessage.toolCalls!.push(toolCall);
    this.lastStreamEventType = 'toolCall';
    this.postToWebview({
      type: 'toolCall',
      messageId: this.currentAssistantMessage.id,
      toolCall,
    });
  }

  private handleToolResult(data: ToolResultNotification): void {
    if (!this.currentAssistantMessage) return;
    const toolCall = this.currentAssistantMessage.toolCalls!.find((t) => t.id === data.id);
    if (toolCall) {
      toolCall.result = data.content;
      toolCall.isError = data.isError;
      toolCall.isComplete = true;
    }
    this.lastStreamEventType = 'toolResult';
    this.postToWebview({
      type: 'toolResult',
      messageId: this.currentAssistantMessage.id,
      toolCallId: data.id,
      result: data.content,
      isError: data.isError,
    });
  }

  private handleDone(data: ChatDoneNotification): void {
    console.log('[OpenAIDE] chat:done, usage:', JSON.stringify(data.usage));
    if (this.currentAssistantMessage) {
      this.currentAssistantMessage.isStreaming = false;
      this.currentAssistantMessage.usage = data.usage;
      this.currentAssistantMessage = null;
    }
    this.lastStreamEventType = null;
    this.contentBlockIndex = 0;
    this.postToWebview({ type: 'streamEnd', usage: data.usage });
  }

  private handleError(data: ChatErrorNotification): void {
    console.error('[OpenAIDE] chat:error:', data.error);
    if (this.currentAssistantMessage) {
      this.currentAssistantMessage.isStreaming = false;
      this.currentAssistantMessage.content += `\n\n❌ 错误: ${data.error}`;
      this.currentAssistantMessage = null;
    }
    this.postToWebview({ type: 'error', error: data.error });
  }

  // ─── Webview 通信 ───

  private postToWebview(message: unknown): void {
    this.webviewView?.webview.postMessage(message);
  }

  private syncMessages(): void {
    this.postToWebview({ type: 'syncMessages', messages: this.messages });
  }

  /**
   * 清空消息（由 Extension 命令调用）
   */
  clearMessages(): void {
    this.messages = [];
    this.currentAssistantMessage = null;
    this.postToWebview({ type: 'clearMessages' });
  }

  /**
   * 请求同步消息（切换会话后调用）
   */
  requestSync(): void {
    this.syncMessages();
  }

  /**
   * 从 Core 侧的消息历史恢复 UI 消息（切换会话时使用）
   *
   * Core 侧的 ChatMessage 格式: { role, content: string | ContentBlock[] }
   * 需要转换为 Extension 侧的 ChatMessage 格式
   */
  restoreFromCoreMessages(coreMessages: Array<{ role: string; content: unknown }>): void {
    this.messages = [];
    this.currentAssistantMessage = null;

    // 用于关联 tool_result 到对应的 toolCall
    let lastAssistantMsg: ChatMessage | null = null;

    for (const msg of coreMessages) {
      if (msg.role === 'user') {
        // 用户消息
        const content = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? (msg.content as Array<{ type: string; text?: string }>)
                .filter((b) => b.type === 'text')
                .map((b) => b.text || '')
                .join('')
            : '';
        const userMsg: ChatMessage = {
          id: `restored-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: 'user',
          content,
          timestamp: Date.now(),
          toolCalls: [],
        };
        this.messages.push(userMsg);
        lastAssistantMsg = null;
      } else if (msg.role === 'assistant') {
        // 助手消息 — 可能包含文本和工具调用
        let textContent = '';
        const toolCalls: ToolCallInfo[] = [];

        if (typeof msg.content === 'string') {
          textContent = msg.content;
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>) {
            if (block.type === 'text' && block.text) {
              textContent += block.text;
            } else if (block.type === 'tool_use') {
              toolCalls.push({
                id: block.id || '',
                name: block.name || '',
                input: block.input || {},
                isComplete: true,
              });
            }
          }
        }

        const assistantMsg: ChatMessage = {
          id: `restored-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: 'assistant',
          content: textContent,
          timestamp: Date.now(),
          toolCalls,
        };
        this.messages.push(assistantMsg);
        lastAssistantMsg = assistantMsg;
      } else if (msg.role === 'tool' && lastAssistantMsg) {
        // tool 角色消息 — 将结果关联回 assistant 消息的 toolCalls
        if (Array.isArray(msg.content)) {
          for (const block of msg.content as Array<{ type: string; tool_use_id?: string; content?: string; is_error?: boolean }>) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const tc = lastAssistantMsg.toolCalls?.find((t) => t.id === block.tool_use_id);
              if (tc) {
                tc.result = block.content || '';
                tc.isError = block.is_error || false;
              }
            }
          }
        } else if (typeof msg.content === 'string') {
          // 简单字符串格式的 tool result
          const lastToolCall = lastAssistantMsg.toolCalls?.[lastAssistantMsg.toolCalls.length - 1];
          if (lastToolCall && !lastToolCall.result) {
            lastToolCall.result = msg.content;
          }
        }
      }
    }

    this.syncMessages();
  }

  // ─── 变更面板方法 ───

  /**
   * 添加一个待处理的文件变更（通知 Webview 显示变更面板）
   */
  addPendingChange(change: PendingChangeInfo): void {
    // 如果已存在同路径的变更，更新它
    const existingIdx = this.pendingChanges.findIndex(c => c.path === change.path);
    if (existingIdx >= 0) {
      this.pendingChanges[existingIdx] = change;
    } else {
      this.pendingChanges.push(change);
    }
    this.postToWebview({ type: 'pendingChanges', changes: this.pendingChanges });
  }

  /**
   * 移除一个待处理的文件变更
   */
  private removePendingChange(path: string): void {
    this.pendingChanges = this.pendingChanges.filter(c => c.path !== path);
    this.postToWebview({ type: 'pendingChanges', changes: this.pendingChanges });
  }

  /**
   * 清空所有待处理的变更
   */
  private clearPendingChanges(): void {
    this.pendingChanges = [];
    this.postToWebview({ type: 'pendingChanges', changes: [] });
  }

  /**
   * 更新聊天界面的模型名称（由 Extension 命令调用）
   */
  updateModelName(name: string): void {
    this.postToWebview({ type: 'updateModelName', name });
  }

  /**
   * 初始化时读取当前配置的模型名称并发送给 Webview
   */
  private sendInitialModelName(): void {
    const config = vscode.workspace.getConfiguration('openaide');
    const model = config.get<string>('model', '');
    if (model) {
      // modelMap 同时支持带 provider/ 前缀和不带前缀的格式
      const modelMap: Record<string, string> = {
        'anthropic/claude-sonnet-4-20250514': 'Claude Sonnet 4',
        'claude-sonnet-4-20250514': 'Claude Sonnet 4',
        'anthropic/claude-opus-4-20250514': 'Claude Opus 4',
        'claude-opus-4-20250514': 'Claude Opus 4',
        'openai/gpt-4o': 'GPT-4o',
        'gpt-4o': 'GPT-4o',
        'openai/gpt-4o-mini': 'GPT-4o Mini',
        'gpt-4o-mini': 'GPT-4o Mini',
        'deepseek/deepseek-chat': 'DeepSeek V3',
        'deepseek-chat': 'DeepSeek V3',
        'deepseek/deepseek-reasoner': 'DeepSeek Reasoner',
        'deepseek-reasoner': 'DeepSeek Reasoner',
        'qwen/qwen-max': 'Qwen Max',
        'qwen-max': 'Qwen Max',
        'qwen/qwen-plus': 'Qwen Plus',
        'qwen-plus': 'Qwen Plus',
        'glm/glm-5.1': 'GLM 5.1',
        'glm-5.1': 'GLM 5.1',
        'glm/glm-4-flash': 'GLM-4-Flash',
        'glm-4-flash': 'GLM-4-Flash',
        'ollama/qwen2.5-coder': 'Ollama 本地',
        'qwen2.5-coder': 'Ollama 本地',
      };
      const displayName = modelMap[model] || model.split('/').pop() || model;
      this.postToWebview({ type: 'updateModelName', name: displayName });
    } else {
      // 检查哪个 provider 已配置了 API Key，优先展示该 provider 的模型
      const providerKeyMap: { provider: string; configKey: string; displayName: string }[] = [
        { provider: 'anthropic', configKey: 'anthropicApiKey', displayName: 'Claude Sonnet 4' },
        { provider: 'openai', configKey: 'openaiApiKey', displayName: 'GPT-4o' },
        { provider: 'deepseek', configKey: 'deepseekApiKey', displayName: 'DeepSeek V3' },
        { provider: 'qwen', configKey: 'qwenApiKey', displayName: 'Qwen Max' },
        { provider: 'glm', configKey: 'glmApiKey', displayName: 'GLM 5.1' },
      ];

      // 优先使用已配置 API Key 的 provider
      let resolvedName = '';
      for (const entry of providerKeyMap) {
        if (config.get<string>(entry.configKey, '')) {
          resolvedName = entry.displayName;
          break;
        }
      }

      // 如果没有任何 provider 配置了 Key，回退到 provider 配置或默认值
      if (!resolvedName) {
        const provider = config.get<string>('provider', 'anthropic');
        const defaultNames: Record<string, string> = {
          anthropic: 'Claude Sonnet 4',
          openai: 'GPT-4o',
          deepseek: 'DeepSeek V3',
          qwen: 'Qwen Max',
          glm: 'GLM 5.1',
          ollama: 'Ollama 本地',
        };
        resolvedName = defaultNames[provider] || 'Claude Sonnet 4';
      }

      this.postToWebview({ type: 'updateModelName', name: resolvedName });
    }
  }

  /**
   * 处理 @文件引用搜索
   * 在工作区中搜索匹配的文件，返回给 Webview
   */
  private async handleFileSearch(query: string): Promise<void> {
    try {
      const pattern = query ? `**/*${query}*` : '**/*';
      const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 20);

      const files = uris.map((uri) => {
        const relativePath = vscode.workspace.asRelativePath(uri);
        const name = uri.path.split('/').pop() || relativePath;
        return { name, path: relativePath };
      });

      this.postToWebview({ type: 'fileList', files });
    } catch {
      this.postToWebview({ type: 'fileList', files: [] });
    }
  }

  /**
   * 生成 Webview HTML 内容（参照 CodeBuddy 风格）
   */
  private getHtmlContent(webview: vscode.Webview): string {
    const nonce = getNonce();

    return /*html*/ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
  <title>OpenAIDE Chat</title>
  <style>
    /* ─── CodeBuddy 100% 还原样式 ─── */
    /* 使用 CodeBuddy 原始 CSS 变量名 --gongfeng-* 映射到 VS Code 变量 */
    :root {
      --gongfeng-sideBar-background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      --gongfeng-input-background: var(--vscode-input-background);
      --gongfeng-input-foreground: var(--vscode-input-foreground);
      --gongfeng-foreground: var(--vscode-foreground);
      --gongfeng-focusBorder: var(--vscode-focusBorder);
      --gongfeng-errorForeground: var(--vscode-errorForeground);
      --gongfeng-chat-text-primary-foreground: var(--vscode-editor-foreground);
      --gongfeng-chat-text-secondary-foreground: var(--vscode-descriptionForeground);
      --gongfeng-chat-primary-avatar-foreground: #fff;
      --gongfeng-list-activeSelectionBackground: var(--vscode-list-activeSelectionBackground);
      --gongfeng-list-activeSelectionForeground: var(--vscode-list-activeSelectionForeground);
      --gongfeng-chat-action-btn-background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31));
      --gongfeng-chat-action-btn-background-hover: var(--vscode-toolbar-activeBackground, rgba(99,102,103,0.31));
      --gongfeng-blink-cursor-color: var(--vscode-editorCursor-foreground, var(--vscode-editor-foreground));
      --gongfeng-chat-menu-background: var(--vscode-list-hoverBackground);
      --gongfeng-chat-menu-main-text: var(--vscode-editor-foreground);
      --gongfeng-chat-menu-desc-text: var(--vscode-descriptionForeground);
      --input-background: var(--vscode-input-background);
      --input-placeholder-foreground: var(--vscode-input-placeholderForeground);
      --dropdown-border: var(--vscode-editorWidget-border, var(--vscode-widget-border, transparent));
      --focus-border: var(--vscode-focusBorder);
      --font-family: var(--vscode-font-family);
      --corner-radius: 4;
      --design-unit: 4;
      --border-width: 1;
      --scrollbar-width: 4px;
      --scrollbar-height: 4px;
      --scrollbar-slider-background: var(--vscode-scrollbarSlider-background);
      --scrollbar-slider-hover-background: var(--vscode-scrollbarSlider-hoverBackground);
      --scrollbar-slider-active-background: var(--vscode-scrollbarSlider-activeBackground);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--font-family);
      font-size: var(--vscode-font-size);
      color: var(--gongfeng-chat-text-primary-foreground);
      background: var(--gongfeng-sideBar-background);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ─── chat-wrap（CodeBuddy 最外层） ─── */
    .chat-wrap {
      background: var(--gongfeng-sideBar-background);
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      position: relative;
    }



    /* 兼容旧的 tab-action-btn 用于卡片内的小按钮 */
    .tab-action-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--gongfeng-chat-text-secondary-foreground);
      cursor: pointer;
      transition: background 0.15s;
    }

    .tab-action-btn:hover {
      background: var(--vscode-list-hoverBackground);
      color: var(--gongfeng-chat-text-primary-foreground);
    }

    .tab-action-btn svg {
      width: 14px;
      height: 14px;
    }

    /* ─── chat-panels-view（CodeBuddy 聊天面板视图） ─── */
    .chat-panels-view {
      height: 100%;
      padding: 10px 0 0;
      overflow: hidden;
    }

    /* ─── chat-container（CodeBuddy 聊天容器） ─── */
    .chat-container {
      box-sizing: border-box;
      height: 100%;
      width: 100%;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }

    .chat-container.no-message {
      justify-content: unset !important;
      overflow-y: auto;
    }

    .chat-container.no-message .message-list {
      flex-grow: 0 !important;
      flex-shrink: 0 !important;
    }

    .chat-container.no-message .chat-form {
      border-top: none !important;
    }

    /* ─── message-list（CodeBuddy 消息列表） ─── */
    .message-list {
      box-sizing: border-box;
      flex-grow: 1;
      margin-bottom: 0;
      overflow-y: auto;
      position: relative;
      width: 100%;
    }

    .message-list::-webkit-scrollbar { width: 6px; }
    .message-list::-webkit-scrollbar-track {
      background: var(--scrollbar-slider-background, hsla(0,0%,100%,0.1));
      border-radius: 4px;
    }
    .message-list::-webkit-scrollbar-thumb {
      background: var(--scrollbar-slider-active-background, hsla(0,0%,100%,0.3));
      border-radius: 4px;
    }
    .message-list::-webkit-scrollbar-thumb:hover {
      background: var(--scrollbar-slider-hover-background, hsla(0,0%,100%,0.4));
    }

    /* ─── inner-welcome-view（CodeBuddy 欢迎页） ─── */
    .inner-welcome-view {
      color: inherit;
      display: flex;
      flex-direction: column;
      padding: 120px 24px 24px;
      text-align: center;
      align-items: center;
    }

    .welcome-logo {
      border-radius: 50%;
      height: 64px;
      width: 64px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .welcome-logo svg {
      height: 40px;
      width: 40px;
    }

    .inner-welcome-view h2 {
      font-size: 16px;
      font-weight: 600;
      margin-top: 12px;
    }

    .welcome-hint {
      line-height: 20px;
      margin: 8px auto 0;
      width: 300px;
      color: var(--gongfeng-chat-text-secondary-foreground);
      font-size: 13px;
    }

    /* ─── welcome-history-list（CodeBuddy 历史会话列表） ─── */
    .welcome-history-list {
      display: flex;
      flex-direction: column;
      margin-top: 24px;
      padding: 12px;
      width: 100%;
    }

    .welcome-history-list__title {
      align-items: center;
      display: flex;
      font-weight: 500;
      margin-bottom: 12px;
      opacity: 0.6;
      font-size: 12px;
    }

    .welcome-history-list__content {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .welcome-history-list__item {
      background-color: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, var(--dropdown-border));
      border-radius: 6px;
      cursor: pointer;
      outline: none;
      padding: 12px;
      transition: all 0.2s ease;
    }

    .welcome-history-list__item:hover {
      background-color: var(--vscode-list-hoverBackground);
      border-color: var(--gongfeng-focusBorder);
    }

    .welcome-history-list__item-content {
      align-items: center;
      display: flex;
      gap: 12px;
    }

    .welcome-history-list__item-icon {
      align-items: center;
      color: var(--gongfeng-foreground);
      display: flex;
      flex-shrink: 0;
      height: 24px;
      justify-content: center;
      opacity: 0.6;
      width: 24px;
    }

    .welcome-history-list__item-icon svg {
      width: 16px;
      height: 16px;
    }

    .welcome-history-list__item-main {
      flex: 1;
      min-width: 0;
    }

    .welcome-history-list__item-title {
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ─── 消息样式 ─── */
    .message {
      padding: 12px 16px;
      animation: fadeIn 0.2s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .message-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }

    .message-avatar {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .message-avatar.user {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .message-avatar.assistant {
      background: linear-gradient(135deg, #40c8ae, #4178ff);
      color: white;
    }

    .message-avatar svg {
      width: 14px;
      height: 14px;
    }

    .message-role {
      font-weight: 600;
      font-size: 12px;
    }

    .message-time {
      font-size: 11px;
      color: var(--gongfeng-chat-text-secondary-foreground);
      margin-left: auto;
    }

    .message-content {
      line-height: 1.6;
      word-wrap: break-word;
      white-space: pre-wrap;
      font-size: 13px;
    }

    .message-content code {
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 5px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
    }

    .message-content pre {
      background: var(--vscode-editor-background);
      padding: 10px 12px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 8px 0;
    }

    .message-content pre code {
      background: none;
      padding: 0;
    }

    /* ─── 代码块（CodeBuddy raw-enhanced-code-block 风格） ─── */
    .code-block-wrapper {
      border: 1px solid var(--vscode-editorWidget-border, transparent);
      border-radius: 6px;
      display: flex;
      flex-direction: column;
      overflow: clip;
      margin: 8px 0;
    }

    .code-block-wrapper:hover .code-actions .action.hover-action {
      visibility: visible;
    }

    .code-metadata {
      align-content: center;
      align-items: center;
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-editorWidget-border, transparent);
      display: flex;
      font-family: var(--font-family);
      font-size: 12px;
      font-weight: 600;
      padding: 4px 6px;
      position: sticky;
      top: 0;
      user-select: none;
    }

    .code-metadata .language-tag {
      flex: 1;
      text-transform: capitalize;
    }

    .code-metadata .code-actions {
      align-items: center;
      display: flex;
      font-weight: 400;
      margin: 0 6px;
    }

    .code-metadata .code-actions .action {
      border-radius: 4px;
      color: var(--gongfeng-chat-text-secondary-foreground);
      display: inline-flex;
      align-items: center;
      padding: 4px;
      text-decoration: none;
      cursor: pointer;
      gap: 4px;
      font-size: 12px;
      transition: all 0.2s;
      background: transparent;
      border: none;
    }

    .code-metadata .code-actions .action + .action {
      margin-left: 8px;
    }

    .code-metadata .code-actions .action:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31));
    }

    .code-metadata .code-actions .action .action-label {
      color: var(--gongfeng-chat-text-secondary-foreground);
      display: inline-block;
      font-size: 12px;
      margin-left: 4px;
    }

    .code-block-wrapper pre {
      margin: 0;
      border-radius: 0;
      border: none;
    }

    .code-block-wrapper code.hljs {
      background: var(--vscode-editor-background) !important;
      border-radius: 0;
      display: block;
      font-size: 12px;
      overflow-x: auto;
      padding: 6px;
      white-space: pre;
    }

    /* ─── Markdown 增强样式 ─── */
    .message-content h2, .message-content h3, .message-content h4 {
      margin: 12px 0 6px;
      font-weight: 600;
    }

    .message-content h2 { font-size: 1.2em; }
    .message-content h3 { font-size: 1.1em; }
    .message-content h4 { font-size: 1em; }

    .message-content ul, .message-content ol {
      padding-left: 20px;
      margin: 4px 0;
    }

    .message-content li { margin: 2px 0; }

    .message-content a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }

    .message-content a:hover { text-decoration: underline; }

    .message-content hr {
      border: none;
      border-top: 1px solid var(--vscode-editorWidget-border, transparent);
      margin: 12px 0;
    }

    /* ─── 思考过程 ─── */
    .thinking-block {
      border-left: 2px solid var(--gongfeng-chat-text-secondary-foreground);
      padding: 6px 10px;
      margin: 6px 0;
      color: var(--gongfeng-chat-text-secondary-foreground);
      font-size: 12px;
      font-style: italic;
      max-height: 120px;
      overflow-y: auto;
      transition: max-height 0.3s;
    }

    .thinking-block.collapsed {
      max-height: 24px;
      overflow: hidden;
      cursor: pointer;
    }

    /* ─── 工具调用（CodeBuddy status-wrapper 风格） ─── */
    .tool-call {
      border: 1px solid var(--vscode-chat-requestBorder, var(--vscode-editorWidget-border, transparent));
      border-radius: 4px;
      margin: 1em 0;
      padding: 0;
      overflow: hidden;
    }

    .tool-call-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 6px;
      cursor: pointer;
      font-size: 12px;
      transition: background 0.15s;
    }

    .tool-call-header:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .tool-call-name {
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--gongfeng-chat-text-primary-foreground);
    }

    .tool-call-name .tool-icon {
      width: 14px;
      height: 14px;
      opacity: 0.7;
    }

    .tool-call-status { font-size: 11px; }
    .tool-call-status.running { color: var(--vscode-button-background); }
    .tool-call-status.success { color: #40c8ae; }
    .tool-call-status.error { color: var(--gongfeng-errorForeground); }

    .tool-call-body {
      padding: 8px 10px;
      font-size: 12px;
      display: none;
      border-top: 1px solid var(--vscode-editorWidget-border, transparent);
    }

    .tool-call.expanded .tool-call-body { display: block; }

    .tool-call-input, .tool-call-output {
      background: var(--vscode-editor-background);
      padding: 6px 8px;
      border-radius: 4px;
      margin: 4px 0;
      font-family: var(--vscode-editor-font-family);
      font-size: 11px;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 200px;
      overflow-y: auto;
    }

    /* ─── 工具审批按钮 ─── */
    .tool-approval-actions {
      display: flex;
      gap: 6px;
      padding: 6px 10px;
      border-top: 1px solid var(--vscode-editorWidget-border, transparent);
    }

    .approval-btn {
      padding: 4px 12px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
    }

    .approval-btn.approve { background: #40c8ae; color: white; }
    .approval-btn.deny { background: var(--gongfeng-errorForeground); color: white; }
    .approval-btn:hover { opacity: 0.85; }

    /* ─── 流式光标（CodeBuddy blink-cursor 风格） ─── */
    .blink-cursor {
      animation: blink 1s infinite;
      border: 1px solid var(--gongfeng-blink-cursor-color);
      content: "";
      display: inline-block;
      height: 1em;
      vertical-align: text-bottom;
      width: 0.5em;
    }

    @keyframes blink {
      0% { background-color: var(--gongfeng-blink-cursor-color); }
      33% { background-color: transparent; }
      100% { background-color: transparent; }
    }

    /* ─── dots-cursor（CodeBuddy 三点动画光标） ─── */
    .dots-cursor {
      align-items: center;
      display: inline-flex;
      gap: 2px;
      margin-left: 1px;
    }

    .dots-cursor .dot {
      animation: dots-bounce 1.4s ease-in-out infinite;
      background-color: var(--gongfeng-blink-cursor-color);
      border-radius: 50%;
      height: 2px;
      width: 2px;
    }

    .dots-cursor .dot:first-child { animation-delay: -0.32s; }
    .dots-cursor .dot:nth-child(2) { animation-delay: -0.16s; }
    .dots-cursor .dot:nth-child(3) { animation-delay: 0s; }

    @keyframes dots-bounce {
      0%, 80%, 100% { opacity: 0.5; transform: scale(0.6); }
      40% { opacity: 1; transform: scale(1); }
    }

    /* ─── chat-form（CodeBuddy 底部输入区域） ─── */
    .chat-form {
      background-color: transparent;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      padding: 12px;
      position: relative;
      width: 100%;
      flex-shrink: 0;
    }

    /* ─── div.host（CodeBuddy 输入框容器） ─── */
    .input-host {
      background: var(--input-background);
      border: calc(var(--border-width) * 1px) solid var(--dropdown-border);
      border-radius: calc(var(--corner-radius) * 1px + 8px);
      display: flex;
      flex-direction: column;
      flex-grow: 1;
      font-family: var(--font-family);
      font-size: 0;
      outline: none;
      overflow: hidden;
      user-select: none;
    }

    .input-host:focus-within {
      border-color: var(--focus-border);
    }

    /* ─── textarea.control（CodeBuddy 输入框） ─── */
    .input-box {
      background: var(--input-background);
      border: none;
      color: var(--gongfeng-chat-text-primary-foreground);
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-font-size, 13px);
      line-height: var(--vscode-editor-line-height, 1.4);
      max-height: 50vh;
      min-height: 37px;
      min-width: 0;
      outline: none;
      padding: calc(var(--design-unit) * 2px + 1px);
      padding-right: 0;
      position: relative;
      resize: none;
      width: 100%;
      box-sizing: border-box;
    }

    .input-box::placeholder {
      color: var(--input-placeholder-foreground);
      font-size: 0.9em;
      font-style: italic;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .input-box::-webkit-scrollbar { width: 4px; }
    .input-box::-webkit-scrollbar-corner { background: var(--input-background); }
    .input-box::-webkit-scrollbar-thumb {
      background: var(--scrollbar-slider-background);
      border-radius: 2px;
    }
    .input-box::-webkit-scrollbar-thumb:hover {
      background: var(--scrollbar-slider-hover-background);
    }

    /* ─── addition-wrapper（CodeBuddy 输入框底部操作栏） ─── */
    .addition-wrapper {
      align-items: center;
      display: flex;
      font-family: var(--font-family);
      justify-content: space-between;
      outline: none;
      user-select: none;
      width: 100%;
    }

    .addition-btns {
      align-items: center;
      display: flex;
      flex: 1;
      gap: 2px;
      min-width: 20px;
      overflow: hidden;
      padding: calc(var(--design-unit) * 1px + 1px);
      text-overflow: ellipsis;
    }

    .btn-sm {
      background: transparent;
      border: none;
      color: var(--gongfeng-chat-text-primary-foreground);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      gap: 3px;
      font-size: 12px;
      transition: background 0.15s;
    }

    .btn-sm:hover {
      background: var(--vscode-chat-requestBorder, var(--vscode-list-hoverBackground));
    }

    .btn-sm.active {
      background-color: var(--vscode-inputOption-hoverBackground);
    }

    .btn-sm svg {
      width: 14px;
      height: 14px;
    }

    /* ─── model-label（CodeBuddy 模型标签） ─── */
    .model-label {
      align-items: center;
      color: var(--gongfeng-chat-text-primary-foreground);
      cursor: pointer;
      display: flex;
      gap: 2px;
      text-decoration: none;
    }

    .model-label .model-simple-name {
      color: var(--gongfeng-blink-cursor-color);
      font-size: 12px;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .model-label .model-label-icon {
      flex-shrink: 0;
      font-size: 11px;
      margin-left: auto;
      opacity: 0.6;
    }

    /* ─── control-group__send-op（CodeBuddy 发送按钮区域） ─── */
    .send-op {
      align-items: center;
      display: flex;
      height: 32px;
    }

    .send-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      color: var(--gongfeng-chat-text-primary-foreground);
      cursor: pointer;
      padding: 8px;
      border-radius: 4px;
      transition: all 0.15s;
    }

    .send-btn:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .send-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .send-btn.abort {
      color: var(--gongfeng-errorForeground);
    }

    .send-btn svg {
      width: 16px;
      height: 16px;
    }

    /* ─── bottom-wrapper（CodeBuddy 底部操作栏） ─── */
    .bottom-wrapper {
      align-items: center;
      display: flex;
      justify-content: space-between;
      padding: 0 6px;
      min-height: 24px;
    }

    /* ─── float-actions（CodeBuddy 浮动操作按钮） ─── */
    .float-actions {
      background: transparent;
      border-radius: 4px;
      bottom: calc(100% + 24px);
      display: flex;
      position: absolute;
      right: 20px;
      transition: opacity 0.2s;
      z-index: 10;
    }

    .float-actions:hover { opacity: 1; }

    .scroll-to-bottom-btn {
      display: none;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background-color: var(--gongfeng-chat-action-btn-background);
      border: none;
      color: var(--gongfeng-chat-text-primary-foreground);
      cursor: pointer;
      transition: background 0.15s;
    }

    .scroll-to-bottom-btn:hover {
      background-color: var(--gongfeng-chat-action-btn-background-hover);
    }

    .scroll-to-bottom-btn.visible { display: flex; }

    .scroll-to-bottom-btn svg {
      width: 14px;
      height: 14px;
    }

    /* ─── @文件引用弹出框（CodeBuddy mentionable-popper 风格） ─── */
    .mention-popup {
      position: absolute;
      bottom: calc(100% + 2px);
      left: 0;
      right: 0;
      max-height: 500px;
      overflow-y: auto;
      background: var(--vscode-menu-background);
      border: calc(var(--border-width) * 1px) solid var(--vscode-menu-border, var(--dropdown-border));
      border-radius: 4px;
      display: none;
      z-index: 100;
      box-shadow: 0 0 9px var(--vscode-widget-shadow, rgba(0,0,0,0.16));
      padding: 8px;
      font-size: 12px;
      color: var(--vscode-menu-foreground);
    }

    .mention-popup.visible { display: block; }

    .mention-type-label {
      color: var(--gongfeng-chat-menu-desc-text);
      font-size: 12px;
      line-height: 16px;
      padding: 8px;
      pointer-events: none;
    }

    .mention-item {
      align-items: center;
      color: var(--gongfeng-chat-menu-main-text);
      cursor: pointer;
      display: flex;
      font-size: 14px;
      gap: 1.5em;
      justify-content: space-between;
      line-height: 22px;
      padding: 4px 8px;
      border-radius: 2px;
    }

    .mention-item:hover, .mention-item.selected {
      background: var(--gongfeng-chat-menu-background);
    }

    .mention-item-icon {
      opacity: 0.6;
      font-size: 14px;
      width: 18px;
      text-align: center;
      flex-shrink: 0;
    }

    .mention-item-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .mention-item-path {
      color: var(--gongfeng-chat-menu-desc-text);
      flex: 1;
      font-size: 12px;
      overflow: hidden;
      text-align: right;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ─── 用量显示 ─── */
    .usage-info {
      font-size: 11px;
      color: var(--gongfeng-chat-text-secondary-foreground);
      text-align: right;
      margin-top: 4px;
      padding-right: 4px;
    }

    /* ─── 进度条（tab-progress-dot 风格） ─── */
    .tab-progress-dot {
      animation: tab-progress-pulse 1.5s ease-in-out infinite;
      background-color: #e37318;
      border-radius: 50%;
      display: none;
      height: 6px;
      min-width: 6px;
      width: 6px;
    }

    .tab-progress-dot.active { display: inline-block; }

    @keyframes tab-progress-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    /* ─── 变更面板（CodeBuddy diff-panel 风格） ─── */
    .changes-panel {
      background: var(--vscode-editor-background);
      border-top: 1px solid var(--vscode-editorWidget-border, var(--dropdown-border));
      border-bottom: 1px solid var(--vscode-editorWidget-border, var(--dropdown-border));
      display: none;
      flex-shrink: 0;
      max-height: 200px;
      overflow: hidden;
      flex-direction: column;
    }

    .changes-panel.visible {
      display: flex;
    }

    .changes-panel__header {
      align-items: center;
      display: flex;
      justify-content: space-between;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 600;
      user-select: none;
      flex-shrink: 0;
    }

    .changes-panel__header-left {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .changes-panel__badge {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 10px;
      padding: 1px 6px;
      font-size: 11px;
      font-weight: 600;
      min-width: 18px;
      text-align: center;
    }

    .changes-panel__actions {
      display: flex;
      gap: 4px;
    }

    .changes-panel__btn {
      padding: 3px 10px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
      transition: all 0.15s;
    }

    .changes-panel__btn.accept {
      background: #40c8ae;
      color: white;
    }

    .changes-panel__btn.reject {
      background: var(--vscode-button-secondaryBackground, rgba(90,93,94,0.31));
      color: var(--vscode-button-secondaryForeground, var(--gongfeng-foreground));
    }

    .changes-panel__btn:hover {
      opacity: 0.85;
    }

    .changes-panel__body {
      overflow-y: auto;
      flex: 1;
    }

    .changes-panel__body::-webkit-scrollbar { width: 4px; }
    .changes-panel__body::-webkit-scrollbar-thumb {
      background: var(--scrollbar-slider-background);
      border-radius: 2px;
    }

    .changes-file-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 12px;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.1s;
    }

    .changes-file-item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .changes-file-item__info {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1;
      min-width: 0;
    }

    .changes-file-item__icon {
      flex-shrink: 0;
      opacity: 0.7;
      font-size: 13px;
    }

    .changes-file-item__name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .changes-file-item__stats {
      flex-shrink: 0;
      font-size: 11px;
      margin-left: 8px;
    }

    .changes-file-item__stats .green-text {
      color: #40c8ae;
    }

    .changes-file-item__stats .red-text {
      color: var(--gongfeng-errorForeground, #f44336);
    }

    .changes-file-item__actions {
      display: flex;
      gap: 2px;
      margin-left: 6px;
      flex-shrink: 0;
      opacity: 0;
      transition: opacity 0.15s;
    }

    .changes-file-item:hover .changes-file-item__actions {
      opacity: 1;
    }

    .changes-file-item__btn {
      width: 20px;
      height: 20px;
      border: none;
      border-radius: 3px;
      background: transparent;
      color: var(--gongfeng-chat-text-secondary-foreground);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      transition: all 0.1s;
    }

    .changes-file-item__btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31));
    }

    .changes-file-item__btn.accept-single:hover {
      color: #40c8ae;
    }

    .changes-file-item__btn.reject-single:hover {
      color: var(--gongfeng-errorForeground, #f44336);
    }
  </style>
</head>
<body>
  <div class="chat-wrap">
    <!-- 聊天面板视图 -->
    <div class="chat-panels-view">
      <div class="chat-container no-message" id="chat-container">
        <!-- 消息列表 -->
        <div class="message-list" id="messages">
          <!-- 欢迎页（CodeBuddy inner-welcome-view 风格） -->
          <div class="inner-welcome-view" id="welcome-screen">
            <div>
              <div class="welcome-logo">
                <svg viewBox="0 0 512 512" fill="currentColor" style="opacity:0.85">
                  <!-- 左尖括号 < -->
                  <path d="M 100 256 L 210 146 L 226 166 L 132 256 L 226 346 L 210 366 Z" opacity="0.95"/>
                  <!-- 右尖括号 > -->
                  <path d="M 412 256 L 302 146 L 286 166 L 380 256 L 286 346 L 302 366 Z" opacity="0.95"/>
                  <!-- 神经网络连接线 -->
                  <line x1="256" y1="256" x2="190" y2="200" stroke="currentColor" stroke-width="2" opacity="0.4" />
                  <line x1="256" y1="256" x2="322" y2="200" stroke="currentColor" stroke-width="2" opacity="0.4" />
                  <line x1="256" y1="256" x2="190" y2="312" stroke="currentColor" stroke-width="2" opacity="0.4" />
                  <line x1="256" y1="256" x2="322" y2="312" stroke="currentColor" stroke-width="2" opacity="0.4" />
                  <line x1="256" y1="256" x2="256" y2="180" stroke="currentColor" stroke-width="2" opacity="0.4" />
                  <line x1="256" y1="256" x2="256" y2="332" stroke="currentColor" stroke-width="2" opacity="0.4" />
                  <line x1="190" y1="200" x2="256" y2="180" stroke="currentColor" stroke-width="2" opacity="0.4" />
                  <line x1="256" y1="180" x2="322" y2="200" stroke="currentColor" stroke-width="2" opacity="0.4" />
                  <line x1="322" y1="200" x2="322" y2="312" stroke="currentColor" stroke-width="2" opacity="0.4" />
                  <line x1="322" y1="312" x2="256" y2="332" stroke="currentColor" stroke-width="2" opacity="0.4" />
                  <line x1="256" y1="332" x2="190" y2="312" stroke="currentColor" stroke-width="2" opacity="0.4" />
                  <line x1="190" y1="312" x2="190" y2="200" stroke="currentColor" stroke-width="2" opacity="0.4" />
                  <!-- 神经网络节点 -->
                  <circle cx="190" cy="200" r="5" opacity="0.6" />
                  <circle cx="322" cy="200" r="5" opacity="0.6" />
                  <circle cx="190" cy="312" r="5" opacity="0.6" />
                  <circle cx="322" cy="312" r="5" opacity="0.6" />
                  <circle cx="256" cy="180" r="5" opacity="0.6" />
                  <circle cx="256" cy="332" r="5" opacity="0.6" />
                  <!-- AI 核心 -->
                  <circle cx="256" cy="256" r="36" opacity="0.15" />
                  <circle cx="256" cy="256" r="22" opacity="0.3" />
                  <circle cx="256" cy="256" r="10" opacity="0.8" />
                  <!-- 轨道环 -->
                  <ellipse cx="256" cy="256" rx="70" ry="26" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.25" transform="rotate(-30 256 256)" />
                  <ellipse cx="256" cy="256" rx="70" ry="26" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.25" transform="rotate(30 256 256)" />
                </svg>
              </div>
            </div>
            <h2>OpenAIDE</h2>
            <div class="welcome-hint">
              AI 原生编程助手，帮你写代码、解答问题、审查代码
            </div>

            <!-- 历史会话列表（CodeBuddy welcome-history-list 风格） -->
            <div class="welcome-history-list">
              <div class="welcome-history-list__content">
                <div class="welcome-history-list__item" data-action="解释当前选中的代码">
                  <div class="welcome-history-list__item-content">
                    <div class="welcome-history-list__item-icon">
                      <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 12.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11zM8.5 4h-1v4.5l3.15 1.89.5-.86L8.5 7.88V4z"/></svg>
                    </div>
                    <div class="welcome-history-list__item-main">
                      <div class="welcome-history-list__item-title">💡 解释选中代码</div>
                    </div>
                  </div>
                </div>
                <div class="welcome-history-list__item" data-action="帮我优化当前文件的代码">
                  <div class="welcome-history-list__item-content">
                    <div class="welcome-history-list__item-icon">
                      <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 12.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11zM8.5 4h-1v4.5l3.15 1.89.5-.86L8.5 7.88V4z"/></svg>
                    </div>
                    <div class="welcome-history-list__item-main">
                      <div class="welcome-history-list__item-title">⚡ 优化当前代码</div>
                    </div>
                  </div>
                </div>
                <div class="welcome-history-list__item" data-action="帮我写单元测试">
                  <div class="welcome-history-list__item-content">
                    <div class="welcome-history-list__item-icon">
                      <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 12.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11zM8.5 4h-1v4.5l3.15 1.89.5-.86L8.5 7.88V4z"/></svg>
                    </div>
                    <div class="welcome-history-list__item-main">
                      <div class="welcome-history-list__item-title">🧪 生成单元测试</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 变更面板（CodeBuddy diff-panel 风格） -->
        <div class="changes-panel" id="changes-panel">
          <div class="changes-panel__header">
            <div class="changes-panel__header-left">
              <span>📝 文件变更</span>
              <span class="changes-panel__badge" id="changes-count">0</span>
            </div>
            <div class="changes-panel__actions">
              <button class="changes-panel__btn reject" id="btn-reject-all" title="全部拒绝">全部拒绝</button>
              <button class="changes-panel__btn accept" id="btn-accept-all" title="全部接受">全部接受</button>
            </div>
          </div>
          <div class="changes-panel__body" id="changes-list"></div>
        </div>

        <!-- 底部输入区域（CodeBuddy chat-form 风格） -->
        <div class="chat-form" id="chat-form">
          <div class="mention-popup" id="mention-popup"></div>

          <!-- 浮动操作按钮 -->
          <div class="float-actions">
            <button class="scroll-to-bottom-btn" id="scroll-to-bottom" title="滚动到底部">
              <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 11L3 6h10l-5 5z"/></svg>
            </button>
          </div>

          <!-- 输入框容器（CodeBuddy div.host 风格） -->
          <div class="input-host" id="input-host">
            <textarea
              class="input-box"
              id="input"
              placeholder="输入你的问题，@ 引用文件..."
              rows="1"
            ></textarea>
            <div class="addition-wrapper">
              <div class="addition-btns">
                <button class="btn-sm" id="btn-at-file" title="引用文件 (@)">
                  <svg viewBox="0 0 16 16" fill="currentColor"><path d="M12.5 8a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zM8 12.5a4.5 4.5 0 0 0 3.536-1.721l1.857 1.857a.5.5 0 0 0 .707-.707l-1.857-1.857A4.5 4.5 0 1 0 8 12.5z"/></svg>
                  <span>@</span>
                </button>
                <div class="model-label" id="model-selector" title="选择模型">
                  <span class="model-simple-name" id="model-name">默认模型</span>
                  <span class="model-label-icon">
                    <svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10"><path d="M4.5 5.5L8 9l3.5-3.5"/></svg>
                  </span>
                </div>
              </div>
              <div class="send-op">
                <span style="font-size:11px;color:var(--gongfeng-chat-text-secondary-foreground);margin-right:4px" id="token-info"></span>
                <button class="send-btn" id="btn-send" title="发送 (Enter)">
                  <svg viewBox="0 0 16 16" fill="currentColor"><path d="M1 1.91L1.78 1.5 15 8 1.78 14.5 1 14.09 4.74 8 1 1.91zM3.72 8.5L1.5 13.1 13.5 8 1.5 2.9 3.72 7.5H8v1H3.72z"/></svg>
                </button>
              </div>
            </div>
          </div>

          <!-- 底部操作栏（CodeBuddy bottom-wrapper 风格） -->
          <div class="bottom-wrapper">
            <span style="font-size:11px;color:var(--gongfeng-chat-text-secondary-foreground)">Enter 发送 · Shift+Enter 换行</span>
          </div>
        </div>
      </div>
    </div>

    </div>
  </div>

  <script nonce="${nonce}">
    console.log('[OpenAIDE] Script tag executing - first line');
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const welcomeScreen = document.getElementById('welcome-screen');
    const chatContainer = document.getElementById('chat-container');
    const inputEl = document.getElementById('input');
    const sendBtn = document.getElementById('btn-send');
    const tokenInfo = document.getElementById('token-info');

    const scrollToBottomBtn = document.getElementById('scroll-to-bottom');

    let isStreaming = false;
    let currentStreamEl = null;
    let messages = [];

    // ─── 快捷操作 ───
    function quickAction(text) {
      inputEl.value = text;
      sendMessage();
    }

    // ─── 发送消息 ───
    function sendMessage() {
      const text = inputEl.value.trim();
      if (!text || isStreaming) return;
      autoScrollEnabled = true; // 发送新消息时重置自动滚动
      vscode.postMessage({ type: 'sendMessage', message: text });
      inputEl.value = '';
      inputEl.style.height = 'auto';
    }

    // ─── 取消请求 ───
    function cancelRequest() {
      vscode.postMessage({ type: 'cancelRequest' });
    }

    // ─── 设置流式状态（CodeBuddy 风格） ───
    function setStreamingState(streaming) {
      isStreaming = streaming;
      if (streaming) {
        sendBtn.classList.add('abort');
        sendBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1"/></svg>';
        sendBtn.title = '停止生成';
        // 流式状态中
      } else {
        sendBtn.classList.remove('abort');
        sendBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1 1.91L1.78 1.5 15 8 1.78 14.5 1 14.09 4.74 8 1 1.91zM3.72 8.5L1.5 13.1 13.5 8 1.5 2.9 3.72 7.5H8v1H3.72z"/></svg>';
        sendBtn.title = '发送 (Enter)';
        // 流式结束
        currentStreamEl = null;
        // 移除所有光标
        document.querySelectorAll('.blink-cursor').forEach(c => c.remove());
        document.querySelectorAll('.dots-cursor').forEach(c => c.remove());
      }
    }

    // ─── 切换 no-message 状态 ───
    function updateNoMessageState() {
      const hasMessages = messagesEl.querySelectorAll('.message').length > 0;
      if (hasMessages) {
        chatContainer.classList.remove('no-message');
      } else {
        chatContainer.classList.add('no-message');
      }
    }

    // ─── 渲染消息 ───
    function renderMessage(msg) {
      welcomeScreen.style.display = 'none';
      chatContainer.classList.remove('no-message');

      const el = document.createElement('div');
      el.className = 'message';
      el.id = 'msg-' + msg.id;

      // 消息头部（头像 + 角色名）
      const header = document.createElement('div');
      header.className = 'message-header';

      const avatar = document.createElement('div');
      avatar.className = 'message-avatar ' + msg.role;
      if (msg.role === 'user') {
        avatar.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 1c-3.31 0-6 1.79-6 4v1h12v-1c0-2.21-2.69-4-6-4z"/></svg>';
      } else {
        avatar.innerHTML = '<svg viewBox="0 0 755 755" fill="currentColor" style="width:14px;height:14px"><path d="M538.785 285.014C597.201 265.323 661.727 282.62 702.467 328.884C712.524 340.308 721.521 355.862 739.471 386.947C744.941 396.424 749.446 404.557 753.387 411.554C753.889 405.94 754.261 400.279 754.539 394.596L754.493 396.946C744.372 596.396 579.465 755 377.5 755C337.828 755 299.599 748.836 263.679 737.489C254.395 726.272 245.389 710.849 228.657 681.869C210.712 650.789 201.727 635.23 196.86 620.811C177.162 562.391 194.461 497.826 240.73 457.083C252.153 447.027 267.713 438.069 298.793 420.125L477.681 316.811C508.78 298.855 524.359 289.878 538.785 285.014Z"/></svg>';
      }
      header.appendChild(avatar);

      const roleEl = document.createElement('span');
      roleEl.className = 'message-role';
      roleEl.textContent = msg.role === 'user' ? '你' : 'OpenAIDE';
      header.appendChild(roleEl);

      const timeEl = document.createElement('span');
      timeEl.className = 'message-time';
      timeEl.textContent = formatTime(msg.timestamp);
      header.appendChild(timeEl);

      el.appendChild(header);

      // 思考过程
      if (msg.thinking) {
        const thinkEl = document.createElement('div');
        thinkEl.className = 'thinking-block';
        thinkEl.id = 'thinking-' + msg.id;
        thinkEl.textContent = msg.thinking;
        el.appendChild(thinkEl);
      }

      // 消息内容
      const content = document.createElement('div');
      content.className = 'message-content';
      content.id = 'content-' + msg.id;
      content.innerHTML = renderMarkdown(msg.content);
      if (msg.isStreaming) {
        // CodeBuddy 风格的三点动画光标
        const cursor = document.createElement('span');
        cursor.className = 'dots-cursor';
        cursor.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
        content.appendChild(cursor);
        currentStreamEl = content;
      }
      el.appendChild(content);

      // 工具调用
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        msg.toolCalls.forEach(tc => {
          el.appendChild(renderToolCall(tc));
        });
      }

      // 用量信息
      if (msg.usage) {
        const usageEl = document.createElement('div');
        usageEl.className = 'usage-info';
        usageEl.textContent = formatUsage(msg.usage);
        el.appendChild(usageEl);
      }

      messagesEl.appendChild(el);
      scrollToBottom();
    }

    // ─── 渲染工具调用 ───
    function renderToolCall(tc) {
      const el = document.createElement('div');
      el.className = 'tool-call';
      el.id = 'tool-' + tc.id;

      const header = document.createElement('div');
      header.className = 'tool-call-header';
      header.onclick = () => el.classList.toggle('expanded');

      const name = document.createElement('span');
      name.className = 'tool-call-name';
      name.innerHTML = '<svg class="tool-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M14.773 3.485l-.984-.984a.5.5 0 0 0-.707 0l-1.06 1.06-2.122-2.12a.5.5 0 0 0-.707 0L7.44 3.193a.5.5 0 0 0 0 .707l.354.354-4.95 4.95a.5.5 0 0 0-.146.353v2.122a.5.5 0 0 0 .5.5h2.12a.5.5 0 0 0 .354-.146l4.95-4.95.354.354a.5.5 0 0 0 .707 0l1.753-1.753a.5.5 0 0 0 0-.707l-2.12-2.122 1.06-1.06a.5.5 0 0 0 0-.707z"/></svg> ' + tc.name;

      const status = document.createElement('span');
      status.className = 'tool-call-status ' + (tc.isComplete ? (tc.isError ? 'error' : 'success') : 'running');
      status.textContent = tc.isComplete ? (tc.isError ? '✕ 失败' : '✓ 完成') : '运行中...';

      header.appendChild(name);
      header.appendChild(status);
      el.appendChild(header);

      const body = document.createElement('div');
      body.className = 'tool-call-body';

      const inputLabel = document.createElement('div');
      inputLabel.textContent = '输入:';
      inputLabel.style.fontWeight = '600';
      inputLabel.style.marginBottom = '4px';
      body.appendChild(inputLabel);

      const inputContent = document.createElement('div');
      inputContent.className = 'tool-call-input';
      inputContent.textContent = JSON.stringify(tc.input, null, 2);
      body.appendChild(inputContent);

      if (tc.result) {
        const outputLabel = document.createElement('div');
        outputLabel.textContent = '输出:';
        outputLabel.style.fontWeight = '600';
        outputLabel.style.margin = '8px 0 4px';
        body.appendChild(outputLabel);

        const outputEl = document.createElement('div');
        outputEl.className = 'tool-call-output';
        outputEl.textContent = tc.result.substring(0, 2000) + (tc.result.length > 2000 ? '...' : '');
        body.appendChild(outputEl);
      }

      el.appendChild(body);
      return el;
    }

    // ─── Markdown 渲染器（CodeBuddy raw-enhanced-code-block 风格） ───
    function renderMarkdown(text) {
      if (!text) return '';
      
      const codeBlocks = [];
      let processed = text.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, (match, lang, code) => {
        const idx = codeBlocks.length;
        codeBlocks.push({ lang: lang || '', code: code });
        return '%%CODEBLOCK_' + idx + '%%';
      });

      processed = processed
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      processed = processed.replace(/^### (.+)$/gm, '<h4>$1</h4>');
      processed = processed.replace(/^## (.+)$/gm, '<h3>$1</h3>');
      processed = processed.replace(/^# (.+)$/gm, '<h2>$1</h2>');

      processed = processed.replace(/^\\s*[-*] (.+)$/gm, '<li>$1</li>');
      processed = processed.replace(/(<li>.*<\\/li>\\n?)+/g, '<ul>$&</ul>');
      processed = processed.replace(/^\\s*(\\d+)\\. (.+)$/gm, '<li>$2</li>');

      processed = processed.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" title="$2">$1</a>');
      processed = processed.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      processed = processed.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      processed = processed.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
      processed = processed.replace(/^---$/gm, '<hr>');
      processed = processed.replace(/\\n/g, '<br>');

      // CodeBuddy 风格代码块
      processed = processed.replace(/%%CODEBLOCK_(\\d+)%%/g, (match, idx) => {
        const block = codeBlocks[parseInt(idx)];
        const escapedCode = block.code
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        const langLabel = block.lang || 'code';
        return '<div class="code-block-wrapper">' +
          '<div class="code-metadata">' +
            '<span class="language-tag">' + langLabel + '</span>' +
            '<div class="code-actions">' +
              '<button class="action code-copy-btn" title="复制">' +
                '<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M4 4h8v8H4z" fill="none" stroke="currentColor"/><path d="M2 2h8v2H4v6H2z"/></svg>' +
                '<span class="action-label">复制</span>' +
              '</button>' +
              '<button class="action code-insert-btn" title="插入">' +
                '<svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M8 3v10M4 9l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' +
                '<span class="action-label">插入</span>' +
              '</button>' +
            '</div>' +
          '</div>' +
          '<pre><code class="hljs language-' + block.lang + '">' + escapedCode + '</code></pre>' +
        '</div>';
      });

      return processed;
    }

    function copyCode(btn) {
      const wrapper = btn.closest('.code-block-wrapper');
      const code = wrapper.querySelector('code').textContent;
      vscode.postMessage({ type: 'copyCode', code: code });
      const label = btn.querySelector('.action-label');
      if (label) { label.textContent = '已复制'; setTimeout(() => { label.textContent = '复制'; }, 2000); }
    }

    function insertCode(btn) {
      const wrapper = btn.closest('.code-block-wrapper');
      const code = wrapper.querySelector('code').textContent;
      vscode.postMessage({ type: 'insertCode', code: code });
      const label = btn.querySelector('.action-label');
      if (label) { label.textContent = '已插入'; setTimeout(() => { label.textContent = '插入'; }, 2000); }
    }

    // ─── 格式化 ───
    function formatUsage(usage) {
      let text = '↑' + usage.inputTokens + ' ↓' + usage.outputTokens;
      if (usage.totalCostUSD) {
        text += ' · $' + usage.totalCostUSD.toFixed(4);
      }
      return text;
    }

    function formatTime(ts) {
      const d = new Date(ts);
      return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    }

    function scrollToBottom() {
      // 智能滚动：只有当用户没有主动向上滚动时才自动滚动
      // 判断标准：当前滚动位置距离底部不超过 150px 则认为在底部附近
      var isNearBottom = (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) < 150;
      if (isNearBottom || autoScrollEnabled) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }

    // 自动滚动控制
    var autoScrollEnabled = true;
    messagesEl.addEventListener('scroll', function() {
      var isNearBottom = (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) < 150;
      autoScrollEnabled = isNearBottom;
    });

    // ─── 滚动检测 ───
    messagesEl.addEventListener('scroll', () => {
      const threshold = 100;
      const isNearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
      scrollToBottomBtn.classList.toggle('visible', !isNearBottom && messagesEl.scrollHeight > messagesEl.clientHeight + 200);
    });

    scrollToBottomBtn.addEventListener('click', scrollToBottom);

    // ─── 事件监听 ───
    inputEl.addEventListener('keydown', (e) => {
      // 忽略 IME 输入法的组合状态（如中文输入法确认）
      if (e.isComposing) return;

      // 优先处理 @文件引用弹窗的键盘导航
      if (mentionActive && mentionItems.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          mentionSelectedIdx = Math.min(mentionSelectedIdx + 1, mentionItems.length - 1);
          updateMentionSelection();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          mentionSelectedIdx = Math.max(mentionSelectedIdx - 1, 0);
          updateMentionSelection();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          selectMentionItem(mentionItems[mentionSelectedIdx]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          hideMentionPopup();
          return;
        }
      }

      // Enter 发送消息
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (isStreaming) return;
        sendMessage();
      }
    });

    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, window.innerHeight * 0.5) + 'px';
      handleMentionInput();
    });

    // ─── @文件引用逻辑 ───
    const mentionPopup = document.getElementById('mention-popup');
    let mentionActive = false;
    let mentionStart = -1;
    let mentionSelectedIdx = 0;
    let mentionItems = [];

    // @ 按钮点击
    document.getElementById('btn-at-file').addEventListener('click', () => {
      const pos = inputEl.selectionStart || inputEl.value.length;
      const before = inputEl.value.substring(0, pos);
      const after = inputEl.value.substring(pos);
      inputEl.value = before + '@' + after;
      inputEl.selectionStart = inputEl.selectionEnd = pos + 1;
      inputEl.focus();
      handleMentionInput();
    });

    function handleMentionInput() {
      const text = inputEl.value;
      const cursorPos = inputEl.selectionStart;
      const beforeCursor = text.substring(0, cursorPos);
      const atIdx = beforeCursor.lastIndexOf('@');

      if (atIdx >= 0 && (atIdx === 0 || beforeCursor[atIdx - 1] === ' ' || beforeCursor[atIdx - 1] === '\\n')) {
        const query = beforeCursor.substring(atIdx + 1);
        if (query.length <= 50 && !query.includes(' ')) {
          mentionActive = true;
          mentionStart = atIdx;
          vscode.postMessage({ type: 'requestFiles', query: query });
          return;
        }
      }
      hideMentionPopup();
    }

    function hideMentionPopup() {
      mentionActive = false;
      mentionStart = -1;
      mentionPopup.classList.remove('visible');
      mentionItems = [];
    }

    function selectMentionItem(item) {
      const text = inputEl.value;
      const before = text.substring(0, mentionStart);
      const after = text.substring(inputEl.selectionStart);
      inputEl.value = before + '@' + item.path + ' ' + after;
      inputEl.selectionStart = inputEl.selectionEnd = mentionStart + item.path.length + 2;
      hideMentionPopup();
      inputEl.focus();
    }

    // ─── 工具栏按钮 ───
    sendBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isStreaming) { cancelRequest(); } else { sendMessage(); }
    });

    document.getElementById('model-selector').addEventListener('click', () => {
      vscode.postMessage({ type: 'selectModel' });
    });



    // ─── 接收 Extension 消息 ───
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'addMessage':
          renderMessage(msg.message);
          if (msg.message.role === 'assistant' && msg.message.isStreaming) {
            setStreamingState(true);
          }
          break;

        case 'streamDelta':
          if (currentStreamEl) {
            // 移除光标
            currentStreamEl.querySelectorAll('.dots-cursor, .blink-cursor').forEach(c => c.remove());
            currentStreamEl.innerHTML = renderMarkdown(
              getAllTextContent(msg.messageId) + msg.delta
            );
            // 添加 CodeBuddy 风格的闪烁光标
            const newCursor = document.createElement('span');
            newCursor.className = 'blink-cursor';
            currentStreamEl.appendChild(newCursor);
            updateTextContent(msg.messageId, msg.delta);
            scrollToBottom();
          }
          break;

        case 'thinkingDelta': {
          let thinkEl = document.getElementById('thinking-' + msg.messageId);
          if (!thinkEl) {
            const msgEl = document.getElementById('msg-' + msg.messageId);
            if (msgEl) {
              thinkEl = document.createElement('div');
              thinkEl.className = 'thinking-block';
              thinkEl.id = 'thinking-' + msg.messageId;
              const contentEl = msgEl.querySelector('.message-content');
              msgEl.insertBefore(thinkEl, contentEl);
            }
          }
          if (thinkEl) {
            thinkEl.textContent += msg.delta;
            scrollToBottom();
          }
          break;
        }

        case 'toolCall': {
          const msgEl = document.getElementById('msg-' + msg.messageId);
          if (msgEl) {
            // 将工具调用追加到消息气泡的最后面（自然的对话流）
            msgEl.appendChild(renderToolCall(msg.toolCall));
            scrollToBottom();
          }
          break;
        }

        case 'toolResult': {
          const toolEl = document.getElementById('tool-' + msg.toolCallId);
          if (toolEl) {
            const status = toolEl.querySelector('.tool-call-status');
            status.className = 'tool-call-status ' + (msg.isError ? 'error' : 'success');
            status.textContent = msg.isError ? '✕ 失败' : '✓ 完成';

            const body = toolEl.querySelector('.tool-call-body');
            const outputLabel = document.createElement('div');
            outputLabel.textContent = '输出:';
            outputLabel.style.fontWeight = '600';
            outputLabel.style.margin = '8px 0 4px';
            body.appendChild(outputLabel);

            const outputEl = document.createElement('div');
            outputEl.className = 'tool-call-output';
            outputEl.textContent = msg.result.substring(0, 2000) + (msg.result.length > 2000 ? '...' : '');
            body.appendChild(outputEl);
          }
          break;
        }

        case 'streamEnd':
          setStreamingState(false);
          if (msg.usage) {
            tokenInfo.textContent = formatUsage(msg.usage);
          }
          break;

        case 'error':
          setStreamingState(false);
          break;

        case 'clearMessages':
          messagesEl.innerHTML = '';
          welcomeScreen.style.display = 'flex';
          messagesEl.appendChild(welcomeScreen);
          chatContainer.classList.add('no-message');
          tokenInfo.textContent = '';
          textContentMap = {};
          break;

        case 'syncMessages':
          messagesEl.innerHTML = '';
          if (msg.messages.length === 0) {
            welcomeScreen.style.display = 'flex';
            messagesEl.appendChild(welcomeScreen);
            chatContainer.classList.add('no-message');
          } else {
            welcomeScreen.style.display = 'none';
            chatContainer.classList.remove('no-message');
            msg.messages.forEach(m => renderMessage(m));
          }
          break;

        case 'fileList':
          if (mentionActive) {
            mentionItems = msg.files || [];
            mentionSelectedIdx = 0;
            renderMentionPopup(mentionItems);
          }
          break;

        case 'updateModelName':
          document.getElementById('model-name').textContent = msg.name || '默认模型';
          break;

        case 'pendingChanges':
          renderChangesPanel(msg.changes || []);
          break;

        case 'newContentBlock': {
          // AI 在工具调用后继续输出文字，创建新的 content 区块
          const msgEl2 = document.getElementById('msg-' + msg.messageId);
          if (msgEl2) {
            createNewContentBlock(msg.messageId, msg.blockIndex);
            const newContent = document.createElement('div');
            newContent.className = 'message-content';
            newContent.id = 'content-' + msg.messageId + '-' + msg.blockIndex;
            // 追加到消息气泡的最后面
            msgEl2.appendChild(newContent);
            // 更新 currentStreamEl 指向新的 content 区块
            currentStreamEl = newContent;
            scrollToBottom();
          }
          break;
        }
      }
    });

    // ─── @文件引用 — 渲染弹出框 ───
    function renderMentionPopup(items) {
      if (items.length === 0) {
        mentionPopup.classList.remove('visible');
        return;
      }
      mentionPopup.innerHTML = '';
      const label = document.createElement('div');
      label.className = 'mention-type-label';
      label.textContent = '文件';
      mentionPopup.appendChild(label);

      items.slice(0, 10).forEach((item, idx) => {
        const el = document.createElement('div');
        el.className = 'mention-item' + (idx === mentionSelectedIdx ? ' selected' : '');
        el.innerHTML = '<span class="mention-item-icon">📄</span>' +
          '<span class="mention-item-name">' + item.name + '</span>' +
          '<span class="mention-item-path">' + item.path + '</span>';
        el.onclick = () => selectMentionItem(item);
        mentionPopup.appendChild(el);
      });
      mentionPopup.classList.add('visible');
    }

    function updateMentionSelection() {
      const items = mentionPopup.querySelectorAll('.mention-item');
      items.forEach((el, idx) => {
        el.classList.toggle('selected', idx === mentionSelectedIdx);
      });
    }

    // ─── 文本内容追踪（用于流式更新） ───
    // 文本内容映射：messageId -> blockIndex -> text
    var textContentMap = {};

    function getAllTextContent(messageId) {
      var blocks = textContentMap[messageId];
      if (!blocks) return '';
      // 返回当前活跃区块的文本
      var keys = Object.keys(blocks);
      var lastKey = keys[keys.length - 1];
      return blocks[lastKey] || '';
    }

    function updateTextContent(messageId, delta) {
      if (!textContentMap[messageId]) textContentMap[messageId] = { '0': '' };
      var blocks = textContentMap[messageId];
      var keys = Object.keys(blocks);
      var lastKey = keys[keys.length - 1];
      blocks[lastKey] = (blocks[lastKey] || '') + delta;
    }

    function createNewContentBlock(messageId, blockIndex) {
      if (!textContentMap[messageId]) textContentMap[messageId] = {};
      textContentMap[messageId][String(blockIndex)] = '';
    }
    // ─── 欢迎页快捷操作（事件委托，避免内联 onclick 被 CSP 阻止） ───
    document.querySelectorAll('.welcome-history-list__item[data-action]').forEach(el => {
      el.addEventListener('click', () => {
        const action = el.getAttribute('data-action');
        if (action) quickAction(action);
      });
    });

    // ─── 代码块复制/插入（事件委托，避免内联 onclick 被 CSP 阻止） ───
    document.addEventListener('click', (e) => {
      const copyBtn = e.target.closest('.code-copy-btn');
      if (copyBtn) {
        copyCode(copyBtn);
        return;
      }
      const insertBtn = e.target.closest('.code-insert-btn');
      if (insertBtn) {
        insertCode(insertBtn);
        return;
      }
    });

    // 通知 Extension Webview 已准备好接收消息
    console.log('[OpenAIDE] Webview JS initialized, sending webviewReady');
    vscode.postMessage({ type: 'webviewReady' });

    // ─── 变更面板逻辑 ───
    const changesPanel = document.getElementById('changes-panel');
    const changesList = document.getElementById('changes-list');
    const changesCount = document.getElementById('changes-count');
    let currentChanges = [];

    document.getElementById('btn-accept-all').addEventListener('click', () => {
      vscode.postMessage({ type: 'acceptAllChanges' });
    });

    document.getElementById('btn-reject-all').addEventListener('click', () => {
      vscode.postMessage({ type: 'rejectAllChanges' });
    });

    function renderChangesPanel(changes) {
      currentChanges = changes;
      if (changes.length === 0) {
        changesPanel.classList.remove('visible');
        return;
      }

      changesPanel.classList.add('visible');
      changesCount.textContent = changes.length;
      changesList.innerHTML = '';

      changes.forEach(function(change) {
        var item = document.createElement('div');
        item.className = 'changes-file-item';

        var info = document.createElement('div');
        info.className = 'changes-file-item__info';
        info.innerHTML = '<span class="changes-file-item__icon">📄</span>' +
          '<span class="changes-file-item__name" title="' + change.path + '">' + change.fileName + '</span>';
        info.addEventListener('click', function() {
          vscode.postMessage({ type: 'viewChangeDiff', path: change.path });
        });

        var stats = document.createElement('span');
        stats.className = 'changes-file-item__stats';
        var statsHtml = '';
        if (change.additions > 0) statsHtml += '<span class="green-text">+' + change.additions + '</span> ';
        if (change.deletions > 0) statsHtml += '<span class="red-text">-' + change.deletions + '</span>';
        stats.innerHTML = statsHtml;

        var actions = document.createElement('div');
        actions.className = 'changes-file-item__actions';

        var acceptBtn = document.createElement('button');
        acceptBtn.className = 'changes-file-item__btn accept-single';
        acceptBtn.title = '接受';
        acceptBtn.innerHTML = '✓';
        acceptBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          vscode.postMessage({ type: 'acceptChange', path: change.path });
        });

        var rejectBtn = document.createElement('button');
        rejectBtn.className = 'changes-file-item__btn reject-single';
        rejectBtn.title = '拒绝';
        rejectBtn.innerHTML = '✕';
        rejectBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          vscode.postMessage({ type: 'rejectChange', path: change.path });
        });

        actions.appendChild(acceptBtn);
        actions.appendChild(rejectBtn);

        item.appendChild(info);
        item.appendChild(stats);
        item.appendChild(actions);
        changesList.appendChild(item);
      });
    }
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
