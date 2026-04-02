/**
 * Inline Diff Manager — 文件变更预览和应用（增强版）
 *
 * 当 Agent 提出文件修改时，在编辑器中以 Inline Diff 形式展示：
 * - 绿色高亮新增行
 * - 红色高亮删除行
 * - CodeLens Accept / Reject 按钮（直接在编辑器中操作）
 * - 支持多文件批量操作
 * - Undo 支持（接受后可撤销）
 * - 改进的 Diff 算法（基于 LCS）
 */

import * as vscode from 'vscode';

// ─── 类型定义 ───

/** 单个文件的 Diff 信息 */
export interface FileDiff {
  /** 文件路径 */
  path: string;
  /** 原始内容 */
  originalContent: string;
  /** 新内容 */
  newContent: string;
  /** 变更描述 */
  description?: string;
  /** 状态 */
  status: 'pending' | 'accepted' | 'rejected';
}

/** Diff 操作事件 */
export type DiffAction =
  | { type: 'accept'; path: string }
  | { type: 'reject'; path: string }
  | { type: 'acceptAll' }
  | { type: 'rejectAll' };

/** Diff 统计 */
export interface DiffStats {
  additions: number;
  deletions: number;
  modifications: number;
}

/** Diff 行类型 */
type DiffLineType = 'added' | 'removed' | 'unchanged';

interface DiffLine {
  type: DiffLineType;
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

// ─── Undo 记录 ───

interface UndoEntry {
  path: string;
  originalContent: string;
  timestamp: number;
}

// ─── InlineDiffManager ───

/**
 * InlineDiffManager — 管理文件变更的预览和应用
 */
export class InlineDiffManager {
  private pendingDiffs = new Map<string, FileDiff>();
  private undoStack: UndoEntry[] = [];
  private maxUndoEntries = 20;
  private decorationTypes: {
    added: vscode.TextEditorDecorationType;
    removed: vscode.TextEditorDecorationType;
    modified: vscode.TextEditorDecorationType;
  };
  private disposables: vscode.Disposable[] = [];
  private onDidAction = new vscode.EventEmitter<DiffAction>();
  private codeLensProvider: DiffCodeLensProvider;

  /** 当用户执行 Accept/Reject 操作时触发 */
  readonly onAction = this.onDidAction.event;

  constructor() {
    // 创建装饰类型
    this.decorationTypes = {
      added: vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(40, 167, 69, 0.15)',
        isWholeLine: true,
        overviewRulerColor: '#28a745',
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        before: {
          contentText: '+',
          color: '#28a745',
          fontWeight: 'bold',
          width: '1em',
          textDecoration: 'none',
        },
      }),
      removed: vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(220, 53, 69, 0.15)',
        isWholeLine: true,
        overviewRulerColor: '#dc3545',
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        textDecoration: 'line-through',
        before: {
          contentText: '-',
          color: '#dc3545',
          fontWeight: 'bold',
          width: '1em',
          textDecoration: 'none',
        },
      }),
      modified: vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255, 193, 7, 0.1)',
        isWholeLine: true,
        overviewRulerColor: '#ffc107',
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        before: {
          contentText: '~',
          color: '#ffc107',
          fontWeight: 'bold',
          width: '1em',
          textDecoration: 'none',
        },
      }),
    };

    // 创建 CodeLens Provider
    this.codeLensProvider = new DiffCodeLensProvider(this);
    const codeLensRegistration = vscode.languages.registerCodeLensProvider(
      { pattern: '**' },
      this.codeLensProvider,
    );
    this.disposables.push(codeLensRegistration);

    // 注册 Accept/Reject 命令
    this.disposables.push(
      vscode.commands.registerCommand('openaide.diff.acceptFile', (path: string) => {
        this.accept(path);
      }),
      vscode.commands.registerCommand('openaide.diff.rejectFile', (path: string) => {
        this.reject(path);
      }),
      vscode.commands.registerCommand('openaide.diff.undoLast', () => {
        this.undoLast();
      }),
    );
  }

  /**
   * 显示文件变更的 Diff 预览
   *
   * 使用 VS Code 内置的 Diff Editor 展示变更
   */
  async showDiff(diff: Omit<FileDiff, 'status'>): Promise<void> {
    const fileDiff: FileDiff = { ...diff, status: 'pending' };
    this.pendingDiffs.set(diff.path, fileDiff);

    // 使用 VS Code 的 Diff Editor
    const originalUri = vscode.Uri.parse(`openaide-diff-original:${diff.path}`);
    const modifiedUri = vscode.Uri.parse(`openaide-diff-modified:${diff.path}`);

    // 注册内容提供者
    const originalProvider = new DiffContentProvider(diff.originalContent);
    const modifiedProvider = new DiffContentProvider(diff.newContent);

    const reg1 = vscode.workspace.registerTextDocumentContentProvider('openaide-diff-original', originalProvider);
    const reg2 = vscode.workspace.registerTextDocumentContentProvider('openaide-diff-modified', modifiedProvider);
    this.disposables.push(reg1, reg2);

    // 计算 Diff 统计
    const stats = this.computeStats(diff.originalContent, diff.newContent);

    // 打开 Diff Editor
    const title = `${getFileName(diff.path)} — OpenAIDE 变更 (+${stats.additions} -${stats.deletions})`;
    await vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri, title, {
      preview: true,
    });

    // 不再弹窗，变更操作通过聊天界面的变更面板统一处理

    // 刷新 CodeLens
    this.codeLensProvider.refresh();
  }

  /**
   * 显示多文件变更摘要
   */
  async showMultiFileDiff(diffs: Array<Omit<FileDiff, 'status'>>): Promise<void> {
    for (const diff of diffs) {
      this.pendingDiffs.set(diff.path, { ...diff, status: 'pending' });
    }

    // 计算总统计
    let totalAdded = 0;
    let totalRemoved = 0;

    const items: (vscode.QuickPickItem & { _path?: string })[] = [];

    for (const d of diffs) {
      const stats = this.computeStats(d.originalContent, d.newContent);
      totalAdded += stats.additions;
      totalRemoved += stats.deletions;

      items.push({
        label: `$(diff) ${getFileName(d.path)}`,
        description: `+${stats.additions} -${stats.deletions}`,
        detail: d.description || d.path,
        _path: d.path,
      });
    }

    // 添加批量操作选项
    items.unshift(
      {
        label: '$(check-all) 接受所有变更',
        description: `+${totalAdded} -${totalRemoved}`,
        detail: `共 ${diffs.length} 个文件`,
      },
      {
        label: '$(close-all) 拒绝所有变更',
        description: '',
        detail: `共 ${diffs.length} 个文件`,
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, description: '' },
    );

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `OpenAIDE 提出了 ${diffs.length} 个文件变更 (+${totalAdded} -${totalRemoved})`,
      canPickMany: false,
    });

    if (!picked) return;

    if (picked.label.includes('接受所有')) {
      await this.acceptAll();
    } else if (picked.label.includes('拒绝所有')) {
      await this.rejectAll();
    } else if ((picked as { _path?: string })._path) {
      const diff = this.pendingDiffs.get((picked as { _path?: string })._path!);
      if (diff) {
        await this.showDiff(diff);
      }
    }
  }

  /**
   * 接受单个文件的变更
   */
  async accept(filePath: string): Promise<boolean> {
    const diff = this.pendingDiffs.get(filePath);
    if (!diff) return false;

    try {
      const uri = vscode.Uri.file(filePath);

      // 保存 Undo 记录
      this.pushUndo({
        path: filePath,
        originalContent: diff.originalContent,
        timestamp: Date.now(),
      });

      // 写入新内容
      const encoder = new TextEncoder();
      await vscode.workspace.fs.writeFile(uri, encoder.encode(diff.newContent));

      diff.status = 'accepted';
      this.pendingDiffs.delete(filePath);
      this.onDidAction.fire({ type: 'accept', path: filePath });

      // 刷新 CodeLens
      this.codeLensProvider.refresh();

      vscode.window.showInformationMessage(
        `✅ 已应用变更: ${getFileName(filePath)}`,
        '撤销',
      ).then((action) => {
        if (action === '撤销') {
          this.undoLast();
        }
      });

      return true;
    } catch (error) {
      vscode.window.showErrorMessage(`应用变更失败: ${error}`);
      return false;
    }
  }

  /**
   * 拒绝单个文件的变更
   */
  reject(filePath: string): void {
    const diff = this.pendingDiffs.get(filePath);
    if (!diff) return;

    diff.status = 'rejected';
    this.pendingDiffs.delete(filePath);
    this.onDidAction.fire({ type: 'reject', path: filePath });

    // 刷新 CodeLens
    this.codeLensProvider.refresh();

    vscode.window.showInformationMessage(`❌ 已拒绝变更: ${getFileName(filePath)}`);
  }

  /**
   * 接受所有变更
   */
  async acceptAll(): Promise<void> {
    const paths = [...this.pendingDiffs.keys()];
    for (const path of paths) {
      await this.accept(path);
    }
    this.onDidAction.fire({ type: 'acceptAll' });
  }

  /**
   * 拒绝所有变更
   */
  rejectAll(): void {
    const paths = [...this.pendingDiffs.keys()];
    for (const path of paths) {
      this.reject(path);
    }
    this.onDidAction.fire({ type: 'rejectAll' });
  }

  /**
   * 撤销最后一次接受操作
   */
  async undoLast(): Promise<boolean> {
    const entry = this.undoStack.pop();
    if (!entry) {
      vscode.window.showInformationMessage('没有可撤销的操作');
      return false;
    }

    try {
      const uri = vscode.Uri.file(entry.path);
      const encoder = new TextEncoder();
      await vscode.workspace.fs.writeFile(uri, encoder.encode(entry.originalContent));

      vscode.window.showInformationMessage(`↩️ 已撤销: ${getFileName(entry.path)}`);
      return true;
    } catch (error) {
      vscode.window.showErrorMessage(`撤销失败: ${error}`);
      return false;
    }
  }

  /**
   * 获取所有 pending 的 Diff
   */
  getPendingDiffs(): ReadonlyMap<string, FileDiff> {
    return this.pendingDiffs;
  }

  /**
   * 获取 pending Diff 的文件路径列表
   */
  getPendingPaths(): string[] {
    return [...this.pendingDiffs.keys()];
  }

  /**
   * 计算 Diff 统计
   */
  computeStats(originalContent: string, newContent: string): DiffStats {
    const diffLines = this.computeDiffLines(originalContent, newContent);
    let additions = 0;
    let deletions = 0;

    for (const line of diffLines) {
      if (line.type === 'added') additions++;
      if (line.type === 'removed') deletions++;
    }

    return { additions, deletions, modifications: 0 };
  }

  /**
   * 计算 Diff 行（基于 LCS 算法）
   */
  private computeDiffLines(originalContent: string, newContent: string): DiffLine[] {
    const oldLines = originalContent.split('\n');
    const newLines = newContent.split('\n');

    // LCS（最长公共子序列）算法
    const m = oldLines.length;
    const n = newLines.length;

    // 优化：对于大文件使用简单逐行比较
    if (m + n > 5000) {
      return this.simpleDiff(oldLines, newLines);
    }

    // 构建 LCS 表
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (oldLines[i - 1] === newLines[j - 1]) {
          dp[i]![j] = dp[i - 1]![j - 1]! + 1;
        } else {
          dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
        }
      }
    }

    // 回溯生成 Diff
    const result: DiffLine[] = [];
    let i = m;
    let j = n;

    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
        result.unshift({
          type: 'unchanged',
          content: oldLines[i - 1]!,
          oldLineNumber: i,
          newLineNumber: j,
        });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
        result.unshift({
          type: 'added',
          content: newLines[j - 1]!,
          newLineNumber: j,
        });
        j--;
      } else if (i > 0) {
        result.unshift({
          type: 'removed',
          content: oldLines[i - 1]!,
          oldLineNumber: i,
        });
        i--;
      }
    }

    return result;
  }

  /**
   * 简单逐行 Diff（用于大文件）
   */
  private simpleDiff(oldLines: string[], newLines: string[]): DiffLine[] {
    const result: DiffLine[] = [];
    const maxLines = Math.max(oldLines.length, newLines.length);

    for (let i = 0; i < maxLines; i++) {
      if (i >= oldLines.length) {
        result.push({ type: 'added', content: newLines[i]!, newLineNumber: i + 1 });
      } else if (i >= newLines.length) {
        result.push({ type: 'removed', content: oldLines[i]!, oldLineNumber: i + 1 });
      } else if (oldLines[i] !== newLines[i]) {
        result.push({ type: 'removed', content: oldLines[i]!, oldLineNumber: i + 1 });
        result.push({ type: 'added', content: newLines[i]!, newLineNumber: i + 1 });
      } else {
        result.push({ type: 'unchanged', content: oldLines[i]!, oldLineNumber: i + 1, newLineNumber: i + 1 });
      }
    }

    return result;
  }

  /**
   * 在编辑器中高亮显示变更行
   */
  async highlightChanges(editor: vscode.TextEditor, diff: FileDiff): Promise<void> {
    const diffLines = this.computeDiffLines(diff.originalContent, diff.newContent);

    const addedRanges: vscode.DecorationOptions[] = [];
    const removedRanges: vscode.DecorationOptions[] = [];

    let lineIndex = 0;
    for (const dl of diffLines) {
      if (dl.type === 'added') {
        if (lineIndex < editor.document.lineCount) {
          addedRanges.push({
            range: new vscode.Range(lineIndex, 0, lineIndex, editor.document.lineAt(lineIndex).text.length),
            hoverMessage: new vscode.MarkdownString(`**新增行** — OpenAIDE`),
          });
        }
        lineIndex++;
      } else if (dl.type === 'removed') {
        // 删除行在 Diff Editor 中展示更好，这里用 hover 提示
        if (lineIndex < editor.document.lineCount) {
          removedRanges.push({
            range: new vscode.Range(lineIndex, 0, lineIndex, 0),
            hoverMessage: new vscode.MarkdownString(`**已删除**: \`${dl.content}\``),
          });
        }
      } else {
        lineIndex++;
      }
    }

    editor.setDecorations(this.decorationTypes.added, addedRanges);
    editor.setDecorations(this.decorationTypes.removed, removedRanges);
  }

  /**
   * 显示 Accept/Reject 操作按钮
   */
  private showDiffActions(filePath: string, stats: DiffStats): void {
    const fileName = getFileName(filePath);

    vscode.window
      .showInformationMessage(
        `OpenAIDE 建议修改 ${fileName} (+${stats.additions} -${stats.deletions})`,
        { modal: false },
        '✅ 接受',
        '❌ 拒绝',
        '📄 查看完整文件',
      )
      .then((action) => {
        switch (action) {
          case '✅ 接受':
            this.accept(filePath);
            break;
          case '❌ 拒绝':
            this.reject(filePath);
            break;
          case '📄 查看完整文件':
            vscode.workspace.openTextDocument(filePath).then((doc) => {
              vscode.window.showTextDocument(doc);
            });
            break;
        }
      });
  }

  /**
   * 保存 Undo 记录
   */
  private pushUndo(entry: UndoEntry): void {
    this.undoStack.push(entry);
    // 限制 Undo 栈大小
    if (this.undoStack.length > this.maxUndoEntries) {
      this.undoStack.shift();
    }
  }

  /**
   * 清理所有装饰和资源
   */
  dispose(): void {
    this.decorationTypes.added.dispose();
    this.decorationTypes.removed.dispose();
    this.decorationTypes.modified.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.onDidAction.dispose();
    this.pendingDiffs.clear();
    this.undoStack = [];
  }
}

// ─── CodeLens Provider ───

/**
 * DiffCodeLensProvider — 在有 pending Diff 的文件上方显示 Accept/Reject 按钮
 */
class DiffCodeLensProvider implements vscode.CodeLensProvider {
  private onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeEmitter.event;

  constructor(private readonly diffManager: InlineDiffManager) {}

  /** 通知 VS Code 刷新 CodeLens */
  refresh(): void {
    this.onDidChangeEmitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const filePath = document.uri.fsPath;
    const pendingDiffs = this.diffManager.getPendingDiffs();
    const diff = pendingDiffs.get(filePath);

    if (!diff || diff.status !== 'pending') {
      return [];
    }

    const stats = this.diffManager.computeStats(diff.originalContent, diff.newContent);
    const range = new vscode.Range(0, 0, 0, 0);

    return [
      new vscode.CodeLens(range, {
        title: `✅ 接受变更 (+${stats.additions} -${stats.deletions})`,
        command: 'openaide.diff.acceptFile',
        arguments: [filePath],
      }),
      new vscode.CodeLens(range, {
        title: '❌ 拒绝变更',
        command: 'openaide.diff.rejectFile',
        arguments: [filePath],
      }),
      new vscode.CodeLens(range, {
        title: `📊 ${diff.description || 'OpenAIDE 建议的变更'}`,
        command: '',
        arguments: [],
      }),
    ];
  }
}

// ─── 辅助类 ───

/**
 * Diff 内容提供者 — 为 Diff Editor 提供虚拟文档内容
 */
class DiffContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private content: string) {}

  provideTextDocumentContent(_uri: vscode.Uri): string {
    return this.content;
  }
}

/** 从路径中提取文件名 */
function getFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}
