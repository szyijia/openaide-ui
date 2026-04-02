/**
 * 代码补全 Provider — InlineCompletionProvider（增强版）
 *
 * 使用 VS Code InlineCompletionProvider API 提供 AI 代码补全：
 * - Ghost Text 预览（灰色文本）
 * - Tab 接受 / Esc 取消
 * - 自然打字触发（debounce）
 * - 手动触发（快捷键）
 * - 缓存层（相同前缀命中缓存）
 * - 智能上下文收集（import 链分析、最近编辑文件）
 * - 状态栏补全指示器
 */

import * as vscode from 'vscode';
import type { AgentBridge } from '../bridge/agent-bridge.js';

/** 补全缓存项 */
interface CacheEntry {
  prefix: string;
  completions: vscode.InlineCompletionItem[];
  timestamp: number;
}

/** 补全配置 */
export interface CompletionConfig {
  /** 是否启用自动补全 */
  enabled: boolean;
  /** 触发延迟（毫秒） */
  debounceMs: number;
  /** 缓存过期时间（毫秒） */
  cacheTtlMs: number;
  /** 最大补全长度（字符） */
  maxCompletionLength: number;
  /** 上下文窗口大小（行数） */
  contextLines: number;
  /** 是否收集 import 上下文 */
  collectImports: boolean;
}

const DEFAULT_CONFIG: CompletionConfig = {
  enabled: true,
  debounceMs: 300,
  cacheTtlMs: 30000,
  maxCompletionLength: 2000,
  contextLines: 50,
  collectImports: true,
};

/** 补全状态 */
type CompletionStatus = 'idle' | 'loading' | 'done' | 'error';

/**
 * OpenAIDECompletionProvider — AI 代码补全
 */
export class OpenAIDECompletionProvider implements vscode.InlineCompletionItemProvider {
  private config: CompletionConfig;
  private cache = new Map<string, CacheEntry>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRequestId = 0;
  private isRequesting = false;
  private statusBarItem: vscode.StatusBarItem | null = null;
  private completionCount = 0;
  private acceptedCount = 0;

  constructor(
    private readonly bridge: AgentBridge,
    config?: Partial<CompletionConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 初始化状态栏指示器
   */
  initStatusBar(): vscode.StatusBarItem {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    this.statusBarItem.command = 'openaide.toggleCompletion';
    this.updateStatusBar('idle');
    this.statusBarItem.show();
    return this.statusBarItem;
  }

  /**
   * 更新状态栏显示
   */
  private updateStatusBar(status: CompletionStatus): void {
    if (!this.statusBarItem) return;

    switch (status) {
      case 'idle':
        this.statusBarItem.text = this.config.enabled
          ? '$(lightbulb) 补全'
          : '$(lightbulb) 补全 (关)';
        this.statusBarItem.tooltip = this.config.enabled
          ? `OpenAIDE 补全 — 已启用\n已生成 ${this.completionCount} 次 | 已采纳 ${this.acceptedCount} 次`
          : 'OpenAIDE 补全 — 已禁用（点击切换）';
        this.statusBarItem.backgroundColor = undefined;
        break;
      case 'loading':
        this.statusBarItem.text = '$(loading~spin) 补全中...';
        this.statusBarItem.tooltip = '正在生成补全...';
        break;
      case 'done':
        this.statusBarItem.text = '$(lightbulb) 补全';
        this.completionCount++;
        this.statusBarItem.tooltip = `OpenAIDE 补全 — 已启用\n已生成 ${this.completionCount} 次 | 已采纳 ${this.acceptedCount} 次`;
        break;
      case 'error':
        this.statusBarItem.text = '$(warning) 补全';
        this.statusBarItem.tooltip = '补全请求失败';
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        // 3 秒后恢复
        setTimeout(() => this.updateStatusBar('idle'), 3000);
        break;
    }
  }

  /**
   * 切换补全启用/禁用
   */
  toggle(): void {
    this.config.enabled = !this.config.enabled;
    this.updateStatusBar('idle');
    vscode.window.showInformationMessage(
      `OpenAIDE 补全已${this.config.enabled ? '启用' : '禁用'}`,
    );
  }

  /**
   * VS Code 调用此方法获取补全建议
   */
  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (!this.config.enabled) return undefined;

    // 获取当前行的前缀
    const linePrefix = document.lineAt(position.line).text.substring(0, position.character);

    // 跳过空行
    if (linePrefix.trim().length === 0 && position.character === 0) {
      return undefined;
    }

    // 跳过注释行的开头（但允许注释后补全实现）
    // 这里不跳过，让 AI 决定是否补全

    // 构建上下文
    const { prefix, suffix } = this.getContext(document, position);
    const cacheKey = this.getCacheKey(document.uri.toString(), prefix);

    // 检查缓存
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.config.cacheTtlMs) {
      return cached.completions;
    }

    // 收集额外上下文（import 链）
    const importContext = this.config.collectImports
      ? await this.collectImportContext(document)
      : '';

    // 如果是自动触发，应用 debounce
    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
      return new Promise((resolve) => {
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(async () => {
          if (token.isCancellationRequested) {
            resolve(undefined);
            return;
          }
          const items = await this.fetchCompletions(document, position, prefix, suffix, importContext, token);
          resolve(items);
        }, this.config.debounceMs);
      });
    }

    // 手动触发，立即请求
    return this.fetchCompletions(document, position, prefix, suffix, importContext, token);
  }

  /**
   * 从 Agent Core 获取补全
   */
  private async fetchCompletions(
    document: vscode.TextDocument,
    position: vscode.Position,
    prefix: string,
    suffix: string,
    importContext: string,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (this.isRequesting) return undefined;
    this.isRequesting = true;
    this.updateStatusBar('loading');

    const requestId = ++this.lastRequestId;

    try {
      // 构建增强的补全请求（包含 import 上下文）
      const enhancedPrefix = importContext
        ? `// 相关文件上下文:\n${importContext}\n// ---\n${prefix}`
        : prefix;

      // 通过 Bridge 请求补全
      await this.bridge.completionRequest({
        file: document.uri.fsPath,
        position: { line: position.line, character: position.character },
        prefix: enhancedPrefix,
        suffix,
        language: document.languageId,
      });

      // 等待补全结果（通过事件）
      const result = await this.waitForCompletion(requestId, token);
      if (!result || token.isCancellationRequested) {
        this.updateStatusBar('idle');
        return undefined;
      }

      // 转换为 VS Code InlineCompletionItem
      const items = result.map((completion) => {
        const insertText = completion.text;
        const range = completion.range
          ? new vscode.Range(
              completion.range.start.line,
              completion.range.start.character,
              completion.range.end.line,
              completion.range.end.character,
            )
          : new vscode.Range(position, position);

        return new vscode.InlineCompletionItem(insertText, range);
      });

      // 缓存结果
      const cacheKey = this.getCacheKey(document.uri.toString(), prefix);
      this.cache.set(cacheKey, {
        prefix,
        completions: items,
        timestamp: Date.now(),
      });

      // 清理过期缓存
      this.cleanCache();

      this.updateStatusBar('done');
      return items;
    } catch (error) {
      console.error('[Completion] 获取补全失败:', error);
      this.updateStatusBar('error');
      return undefined;
    } finally {
      this.isRequesting = false;
    }
  }

  /**
   * 收集 import 上下文
   *
   * 分析当前文件的 import/require 语句，
   * 从导入的文件中提取类型签名和导出信息
   */
  private async collectImportContext(document: vscode.TextDocument): Promise<string> {
    const text = document.getText();
    const importPaths: string[] = [];

    // 匹配 ES6 import
    const importRegex = /import\s+(?:(?:\{[^}]*\}|[\w*]+)\s+from\s+)?['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(text)) !== null) {
      if (match[1] && !match[1].startsWith('.') === false) {
        importPaths.push(match[1]);
      }
    }

    // 匹配 require
    const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = requireRegex.exec(text)) !== null) {
      if (match[1] && match[1].startsWith('.')) {
        importPaths.push(match[1]);
      }
    }

    if (importPaths.length === 0) return '';

    // 尝试解析相对路径的文件，提取导出签名
    const contextParts: string[] = [];
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) return '';

    for (const importPath of importPaths.slice(0, 5)) { // 最多 5 个文件
      if (!importPath.startsWith('.')) continue;

      try {
        // 尝试解析文件路径
        const dir = document.uri.fsPath.replace(/[/\\][^/\\]+$/, '');
        const extensions = ['.ts', '.tsx', '.js', '.jsx', ''];
        let resolvedUri: vscode.Uri | null = null;

        for (const ext of extensions) {
          const candidate = vscode.Uri.file(`${dir}/${importPath}${ext}`);
          try {
            await vscode.workspace.fs.stat(candidate);
            resolvedUri = candidate;
            break;
          } catch {
            // 文件不存在，尝试下一个扩展名
          }
        }

        if (!resolvedUri) continue;

        const importDoc = await vscode.workspace.openTextDocument(resolvedUri);
        const importText = importDoc.getText();

        // 提取导出签名（简化版：只取 export 行）
        const exportLines = importText
          .split('\n')
          .filter((line) =>
            line.startsWith('export ') ||
            line.startsWith('export default ') ||
            line.match(/^\s*export\s+(interface|type|class|function|const|let|var|enum)\s/),
          )
          .slice(0, 10) // 最多 10 行
          .join('\n');

        if (exportLines) {
          const relativePath = vscode.workspace.asRelativePath(resolvedUri);
          contextParts.push(`// ${relativePath}\n${exportLines}`);
        }
      } catch {
        // 忽略解析失败的文件
      }
    }

    return contextParts.join('\n\n');
  }

  /**
   * 等待补全结果
   */
  private waitForCompletion(
    requestId: number,
    token: vscode.CancellationToken,
  ): Promise<Array<{ text: string; range?: { start: { line: number; character: number }; end: { line: number; character: number } } }> | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve(null);
      }, 5000); // 5 秒超时

      const handler = (data: { requestId: string; completions: Array<{ text: string; range?: unknown }> }) => {
        if (data.requestId === String(requestId)) {
          cleanup();
          resolve(data.completions as Array<{ text: string; range?: { start: { line: number; character: number }; end: { line: number; character: number } } }>);
        }
      };

      const cancelHandler = () => {
        cleanup();
        resolve(null);
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.bridge.removeListener('completion:result', handler);
        token.onCancellationRequested(cancelHandler);
      };

      this.bridge.on('completion:result', handler);
      token.onCancellationRequested(cancelHandler);
    });
  }

  /**
   * 获取光标周围的上下文
   */
  private getContext(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): { prefix: string; suffix: string } {
    const startLine = Math.max(0, position.line - this.config.contextLines);
    const endLine = Math.min(document.lineCount - 1, position.line + this.config.contextLines);

    // 前缀：光标之前的内容
    const prefixRange = new vscode.Range(startLine, 0, position.line, position.character);
    const prefix = document.getText(prefixRange);

    // 后缀：光标之后的内容
    const suffixRange = new vscode.Range(
      position.line,
      position.character,
      endLine,
      document.lineAt(endLine).text.length,
    );
    const suffix = document.getText(suffixRange);

    return { prefix, suffix };
  }

  /**
   * 生成缓存 key
   */
  private getCacheKey(uri: string, prefix: string): string {
    const shortPrefix = prefix.slice(-100);
    return `${uri}:${shortPrefix}`;
  }

  /**
   * 清理过期缓存
   */
  private cleanCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > this.config.cacheTtlMs) {
        this.cache.delete(key);
      }
    }

    // 限制缓存大小
    if (this.cache.size > 100) {
      const entries = [...this.cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = entries.slice(0, entries.length - 50);
      toRemove.forEach(([key]) => this.cache.delete(key));
    }
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<CompletionConfig>): void {
    this.config = { ...this.config, ...config };
    this.updateStatusBar('idle');
  }

  /**
   * 清空缓存
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * 释放资源
   */
  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.cache.clear();
    this.statusBarItem?.dispose();
  }
}
