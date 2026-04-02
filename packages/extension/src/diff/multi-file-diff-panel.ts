/**
 * 多文件 Diff 面板
 *
 * 使用 VS Code TreeView 展示 Agent 提出的多文件变更：
 * - 文件列表（带变更统计 +N -M）
 * - 逐文件 Diff 预览
 * - Accept / Reject 单个文件
 * - Accept All / Reject All 批量操作
 * - 变更分组（新建 / 修改 / 删除）
 */

import * as vscode from 'vscode';
import type { FileDiff, DiffStats } from './inline-diff-manager.js';
import { InlineDiffManager } from './inline-diff-manager.js';

// ─── 类型定义 ───

/** 变更文件类型 */
type ChangeType = 'added' | 'modified' | 'deleted';

/** TreeView 节点 */
type DiffTreeItem = GroupNode | FileNode;

/** 分组节点 */
interface GroupNode {
  kind: 'group';
  changeType: ChangeType;
  label: string;
  files: FileNode[];
}

/** 文件节点 */
interface FileNode {
  kind: 'file';
  path: string;
  fileName: string;
  changeType: ChangeType;
  stats: DiffStats;
  description?: string;
}

// ─── MultiFileDiffPanel ───

export class MultiFileDiffPanel implements vscode.Disposable {
  private treeDataProvider: DiffTreeDataProvider;
  private treeView: vscode.TreeView<DiffTreeItem>;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly diffManager: InlineDiffManager) {
    this.treeDataProvider = new DiffTreeDataProvider(diffManager);

    this.treeView = vscode.window.createTreeView('openaide.diffPanel', {
      treeDataProvider: this.treeDataProvider,
      showCollapseAll: true,
    });

    // 注册命令
    this.disposables.push(
      this.treeView,
      vscode.commands.registerCommand('openaide.diff.acceptAll', () => this.acceptAll()),
      vscode.commands.registerCommand('openaide.diff.rejectAll', () => this.rejectAll()),
      vscode.commands.registerCommand('openaide.diff.openFile', (node: FileNode) => this.openFileDiff(node)),
      vscode.commands.registerCommand('openaide.diff.acceptSingle', (node: FileNode) => this.acceptSingle(node)),
      vscode.commands.registerCommand('openaide.diff.rejectSingle', (node: FileNode) => this.rejectSingle(node)),
    );

    // 监听 Diff 操作事件，自动刷新 TreeView
    this.disposables.push(
      diffManager.onAction(() => {
        this.refresh();
      }),
    );
  }

  /**
   * 刷新 TreeView
   */
  refresh(): void {
    this.treeDataProvider.refresh();
    this.updateTitle();
  }

  /**
   * 更新面板标题
   */
  private updateTitle(): void {
    const pending = this.diffManager.getPendingDiffs();
    const count = pending.size;
    this.treeView.title = count > 0
      ? `OpenAIDE 变更 (${count} 个文件)`
      : 'OpenAIDE 变更';

    // 更新 badge
    this.treeView.badge = count > 0
      ? { tooltip: `${count} 个待审查变更`, value: count }
      : undefined;
  }

  /**
   * 打开文件的 Diff 预览
   */
  private async openFileDiff(node: FileNode): Promise<void> {
    const diff = this.diffManager.getPendingDiffs().get(node.path);
    if (diff) {
      await this.diffManager.showDiff(diff);
    }
  }

  /**
   * 接受单个文件变更
   */
  private async acceptSingle(node: FileNode): Promise<void> {
    await this.diffManager.accept(node.path);
    this.refresh();
  }

  /**
   * 拒绝单个文件变更
   */
  private rejectSingle(node: FileNode): void {
    this.diffManager.reject(node.path);
    this.refresh();
  }

  /**
   * 接受所有变更
   */
  private async acceptAll(): Promise<void> {
    const count = this.diffManager.getPendingDiffs().size;
    if (count === 0) {
      vscode.window.showInformationMessage('没有待审查的变更');
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `确定要接受所有 ${count} 个文件的变更吗？`,
      { modal: true },
      '接受所有',
    );

    if (confirm === '接受所有') {
      await this.diffManager.acceptAll();
      this.refresh();
    }
  }

  /**
   * 拒绝所有变更
   */
  private async rejectAll(): Promise<void> {
    const count = this.diffManager.getPendingDiffs().size;
    if (count === 0) {
      vscode.window.showInformationMessage('没有待审查的变更');
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `确定要拒绝所有 ${count} 个文件的变更吗？`,
      { modal: true },
      '拒绝所有',
    );

    if (confirm === '拒绝所有') {
      this.diffManager.rejectAll();
      this.refresh();
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

// ─── TreeDataProvider ───

class DiffTreeDataProvider implements vscode.TreeDataProvider<DiffTreeItem> {
  private onDidChangeEmitter = new vscode.EventEmitter<DiffTreeItem | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

  constructor(private readonly diffManager: InlineDiffManager) {}

  refresh(): void {
    this.onDidChangeEmitter.fire(undefined);
  }

  getTreeItem(element: DiffTreeItem): vscode.TreeItem {
    if (element.kind === 'group') {
      return this.createGroupItem(element);
    }
    return this.createFileItem(element);
  }

  getChildren(element?: DiffTreeItem): DiffTreeItem[] {
    if (!element) {
      return this.getRootItems();
    }
    if (element.kind === 'group') {
      return element.files;
    }
    return [];
  }

  /**
   * 构建根节点（按变更类型分组）
   */
  private getRootItems(): DiffTreeItem[] {
    const pending = this.diffManager.getPendingDiffs();
    if (pending.size === 0) {
      return [];
    }

    const groups: Record<ChangeType, FileNode[]> = {
      added: [],
      modified: [],
      deleted: [],
    };

    for (const [path, diff] of pending) {
      if (diff.status !== 'pending') continue;

      const stats = this.diffManager.computeStats(diff.originalContent, diff.newContent);
      const changeType = this.detectChangeType(diff);
      const fileName = path.split('/').pop() || path;

      groups[changeType].push({
        kind: 'file',
        path,
        fileName,
        changeType,
        stats,
        description: diff.description,
      });
    }

    const result: DiffTreeItem[] = [];

    // 如果只有一种类型，不分组
    const nonEmptyGroups = Object.entries(groups).filter(([, files]) => files.length > 0);
    if (nonEmptyGroups.length === 1) {
      return nonEmptyGroups[0]![1];
    }

    // 多种类型，按分组展示
    if (groups.added.length > 0) {
      result.push({
        kind: 'group',
        changeType: 'added',
        label: `新建文件 (${groups.added.length})`,
        files: groups.added,
      });
    }
    if (groups.modified.length > 0) {
      result.push({
        kind: 'group',
        changeType: 'modified',
        label: `修改文件 (${groups.modified.length})`,
        files: groups.modified,
      });
    }
    if (groups.deleted.length > 0) {
      result.push({
        kind: 'group',
        changeType: 'deleted',
        label: `删除文件 (${groups.deleted.length})`,
        files: groups.deleted,
      });
    }

    return result;
  }

  /**
   * 检测变更类型
   */
  private detectChangeType(diff: FileDiff): ChangeType {
    if (!diff.originalContent || diff.originalContent.length === 0) {
      return 'added';
    }
    if (!diff.newContent || diff.newContent.length === 0) {
      return 'deleted';
    }
    return 'modified';
  }

  /**
   * 创建分组节点的 TreeItem
   */
  private createGroupItem(group: GroupNode): vscode.TreeItem {
    const item = new vscode.TreeItem(group.label, vscode.TreeItemCollapsibleState.Expanded);

    const iconMap: Record<ChangeType, vscode.ThemeIcon> = {
      added: new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.addedResourceForeground')),
      modified: new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')),
      deleted: new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('gitDecoration.deletedResourceForeground')),
    };

    item.iconPath = iconMap[group.changeType];
    item.contextValue = 'diffGroup';

    return item;
  }

  /**
   * 创建文件节点的 TreeItem
   */
  private createFileItem(file: FileNode): vscode.TreeItem {
    const item = new vscode.TreeItem(file.fileName, vscode.TreeItemCollapsibleState.None);

    // 描述：变更统计
    item.description = `+${file.stats.additions} -${file.stats.deletions}`;

    // 工具提示
    item.tooltip = new vscode.MarkdownString(
      `**${file.fileName}**\n\n` +
      `路径: \`${file.path}\`\n\n` +
      `新增: ${file.stats.additions} 行 | 删除: ${file.stats.deletions} 行\n\n` +
      (file.description ? `说明: ${file.description}` : ''),
    );

    // 图标
    const iconMap: Record<ChangeType, vscode.ThemeIcon> = {
      added: new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.addedResourceForeground')),
      modified: new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')),
      deleted: new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('gitDecoration.deletedResourceForeground')),
    };
    item.iconPath = iconMap[file.changeType];

    // 点击打开 Diff
    item.command = {
      command: 'openaide.diff.openFile',
      title: '查看变更',
      arguments: [file],
    };

    // 上下文菜单
    item.contextValue = 'diffFile';

    return item;
  }
}
