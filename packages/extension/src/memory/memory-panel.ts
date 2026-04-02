/**
 * 记忆管理面板
 *
 * 使用 VS Code TreeView 展示和管理 AI 记忆系统：
 * - 查看项目记忆（.openaide.md）
 * - 查看全局记忆（~/.openaide/memory/）
 * - 搜索记忆
 * - 编辑/删除记忆条目
 * - 查看记忆统计
 */

import * as vscode from 'vscode';
import type { AgentBridge } from '../bridge/agent-bridge.js';

// ─── 类型定义 ───

/** 记忆条目 */
interface MemoryEntry {
  id: string;
  content: string;
  source: 'project' | 'global' | 'session';
  category: string;
  createdAt: string;
  updatedAt: string;
}

/** 记忆分类 */
interface MemoryCategory {
  name: string;
  displayName: string;
  icon: string;
  count: number;
}

/** TreeView 节点 */
type MemoryTreeItem = CategoryNode | EntryNode | ActionNode;

interface CategoryNode {
  kind: 'category';
  category: MemoryCategory;
  source: 'project' | 'global' | 'session';
}

interface EntryNode {
  kind: 'entry';
  entry: MemoryEntry;
}

interface ActionNode {
  kind: 'action';
  label: string;
  command: string;
}

// ─── 预定义分类 ───

const CATEGORIES: Record<string, { displayName: string; icon: string }> = {
  preference: { displayName: '用户偏好', icon: 'settings-gear' },
  codeStyle: { displayName: '编码风格', icon: 'symbol-color' },
  projectInfo: { displayName: '项目信息', icon: 'folder' },
  techStack: { displayName: '技术栈', icon: 'layers' },
  decision: { displayName: '技术决策', icon: 'lightbulb' },
  pattern: { displayName: '常用模式', icon: 'symbol-snippet' },
  constraint: { displayName: '约束条件', icon: 'shield' },
  other: { displayName: '其他', icon: 'note' },
};

// ─── MemoryPanel ───

export class MemoryPanel implements vscode.Disposable {
  private treeDataProvider: MemoryTreeDataProvider;
  private treeView: vscode.TreeView<MemoryTreeItem>;
  private disposables: vscode.Disposable[] = [];

  private memories: MemoryEntry[] = [];

  constructor(private readonly bridge: AgentBridge) {
    this.treeDataProvider = new MemoryTreeDataProvider(this);

    this.treeView = vscode.window.createTreeView('openaide.memoryPanel', {
      treeDataProvider: this.treeDataProvider,
      showCollapseAll: true,
    });

    this.disposables.push(
      this.treeView,
      vscode.commands.registerCommand('openaide.memory.refresh', () => this.refresh()),
      vscode.commands.registerCommand('openaide.memory.search', () => this.searchMemory()),
      vscode.commands.registerCommand('openaide.memory.add', () => this.addMemory()),
      vscode.commands.registerCommand('openaide.memory.edit', (node: EntryNode) => this.editMemory(node)),
      vscode.commands.registerCommand('openaide.memory.delete', (node: EntryNode) => this.deleteMemory(node)),
      vscode.commands.registerCommand('openaide.memory.openProjectFile', () => this.openProjectMemoryFile()),
      vscode.commands.registerCommand('openaide.memory.viewEntry', (node: EntryNode) => this.viewEntry(node)),
    );

    this.refresh();
  }

  /** 获取记忆列表 */
  getMemories(): MemoryEntry[] {
    return this.memories;
  }

  /** 获取分类统计 */
  getCategoryStats(): MemoryCategory[] {
    const stats = new Map<string, number>();

    for (const entry of this.memories) {
      const cat = entry.category || 'other';
      stats.set(cat, (stats.get(cat) || 0) + 1);
    }

    return Array.from(stats.entries()).map(([name, count]) => ({
      name,
      displayName: CATEGORIES[name]?.displayName || name,
      icon: CATEGORIES[name]?.icon || 'note',
      count,
    }));
  }

  /** 刷新面板 */
  async refresh(): Promise<void> {
    try {
      const result = await this.bridge.request('memory/list', {}) as {
        memories?: MemoryEntry[];
      };
      this.memories = result?.memories || [];
    } catch {
      this.memories = [];
    }

    this.treeDataProvider.refresh();
    this.updateTitle();
  }

  private updateTitle(): void {
    const count = this.memories.length;
    this.treeView.title = count > 0
      ? `AI 记忆 (${count})`
      : 'AI 记忆';
  }

  /** 搜索记忆 */
  private async searchMemory(): Promise<void> {
    const query = await vscode.window.showInputBox({
      prompt: '搜索记忆',
      placeHolder: '输入关键词搜索...',
    });

    if (!query) return;

    try {
      const result = await this.bridge.request('memory/search', { query }) as {
        memories?: MemoryEntry[];
      };

      if (!result?.memories || result.memories.length === 0) {
        vscode.window.showInformationMessage(`未找到与 "${query}" 相关的记忆`);
        return;
      }

      // 用 QuickPick 展示搜索结果
      const items = result.memories.map((m) => ({
        label: m.content.substring(0, 80),
        description: `${CATEGORIES[m.category]?.displayName || m.category} | ${m.source}`,
        detail: m.content,
        memory: m,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `找到 ${items.length} 条记忆`,
        matchOnDetail: true,
      });

      if (picked) {
        this.viewEntry({ kind: 'entry', entry: picked.memory });
      }
    } catch {
      vscode.window.showErrorMessage('搜索记忆失败');
    }
  }

  /** 添加记忆 */
  private async addMemory(): Promise<void> {
    const content = await vscode.window.showInputBox({
      prompt: '添加新记忆',
      placeHolder: '输入要记住的内容...',
    });

    if (!content) return;

    const categoryItems = Object.entries(CATEGORIES).map(([key, val]) => ({
      label: `$(${val.icon}) ${val.displayName}`,
      value: key,
    }));

    const category = await vscode.window.showQuickPick(categoryItems, {
      placeHolder: '选择分类',
    });

    if (!category) return;

    const source = await vscode.window.showQuickPick(
      [
        { label: '$(folder) 项目记忆', description: '仅在当前项目中生效', value: 'project' as const },
        { label: '$(globe) 全局记忆', description: '在所有项目中生效', value: 'global' as const },
      ],
      { placeHolder: '选择记忆范围' },
    );

    if (!source) return;

    try {
      await this.bridge.request('memory/add', {
        content,
        category: category.value,
        source: source.value,
      });
      vscode.window.showInformationMessage('记忆已添加');
      this.refresh();
    } catch {
      vscode.window.showErrorMessage('添加记忆失败');
    }
  }

  /** 编辑记忆 */
  private async editMemory(node: EntryNode): Promise<void> {
    const newContent = await vscode.window.showInputBox({
      prompt: '编辑记忆',
      value: node.entry.content,
    });

    if (!newContent || newContent === node.entry.content) return;

    try {
      await this.bridge.request('memory/update', {
        id: node.entry.id,
        content: newContent,
      });
      vscode.window.showInformationMessage('记忆已更新');
      this.refresh();
    } catch {
      vscode.window.showErrorMessage('更新记忆失败');
    }
  }

  /** 删除记忆 */
  private async deleteMemory(node: EntryNode): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `确定要删除这条记忆吗？\n\n"${node.entry.content.substring(0, 100)}"`,
      { modal: true },
      '删除',
    );

    if (confirm === '删除') {
      try {
        await this.bridge.request('memory/delete', { id: node.entry.id });
        vscode.window.showInformationMessage('记忆已删除');
        this.refresh();
      } catch {
        vscode.window.showErrorMessage('删除记忆失败');
      }
    }
  }

  /** 打开项目记忆文件 (.openaide.md) */
  private async openProjectMemoryFile(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showWarningMessage('请先打开一个工作区');
      return;
    }

    const filePath = vscode.Uri.joinPath(workspaceFolder.uri, '.openaide.md');

    try {
      await vscode.workspace.fs.stat(filePath);
    } catch {
      // 文件不存在，创建模板
const template = `# OpenAIDE 项目配置

## 项目信息

- 项目名称：${workspaceFolder.name}
- 技术栈：

## 编码规范

## 注意事项

## 自定义指令
`;
      const encoder = new TextEncoder();
      await vscode.workspace.fs.writeFile(filePath, encoder.encode(template));
    }

    const doc = await vscode.workspace.openTextDocument(filePath);
    vscode.window.showTextDocument(doc);
  }

  /** 查看记忆详情 */
  private viewEntry(node: EntryNode): void {
    const entry = node.entry;
    const panel = vscode.window.createWebviewPanel(
      'memoryDetail',
      `记忆: ${entry.content.substring(0, 30)}...`,
      vscode.ViewColumn.Beside,
      {},
    );

    const categoryInfo = CATEGORIES[entry.category] || { displayName: entry.category, icon: 'note' };
    const sourceLabel = entry.source === 'project' ? '项目' : entry.source === 'global' ? '全局' : '会话';

    panel.webview.html = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    h1 { font-size: 1.3em; margin-bottom: 16px; }
    .meta { display: flex; gap: 16px; margin-bottom: 16px; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    .meta-item { display: flex; align-items: center; gap: 4px; }
    .content { background: var(--vscode-textBlockQuote-background); padding: 16px; border-radius: 6px; line-height: 1.6; white-space: pre-wrap; }
    .dates { margin-top: 16px; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <h1>📝 记忆详情</h1>
  <div class="meta">
    <span class="meta-item">📂 ${categoryInfo.displayName}</span>
    <span class="meta-item">🌐 ${sourceLabel}记忆</span>
  </div>
  <div class="content">${entry.content}</div>
  <div class="dates">
    <div>创建时间: ${new Date(entry.createdAt).toLocaleString('zh-CN')}</div>
    <div>更新时间: ${new Date(entry.updatedAt).toLocaleString('zh-CN')}</div>
  </div>
</body>
</html>`;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

// ─── TreeDataProvider ───

class MemoryTreeDataProvider implements vscode.TreeDataProvider<MemoryTreeItem> {
  private onDidChangeEmitter = new vscode.EventEmitter<MemoryTreeItem | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

  constructor(private readonly panel: MemoryPanel) {}

  refresh(): void {
    this.onDidChangeEmitter.fire(undefined);
  }

  getTreeItem(element: MemoryTreeItem): vscode.TreeItem {
    switch (element.kind) {
      case 'category': return this.createCategoryItem(element);
      case 'entry': return this.createEntryItem(element);
      case 'action': return this.createActionItem(element);
    }
  }

  getChildren(element?: MemoryTreeItem): MemoryTreeItem[] {
    if (!element) {
      return this.getRootItems();
    }

    if (element.kind === 'category') {
      return this.getCategoryChildren(element);
    }

    return [];
  }

  private getRootItems(): MemoryTreeItem[] {
    const categories = this.panel.getCategoryStats();

    if (categories.length === 0) {
      return [
        { kind: 'action', label: '$(add) 添加记忆...', command: 'openaide.memory.add' },
        { kind: 'action', label: '$(file) 打开 .openaide.md', command: 'openaide.memory.openProjectFile' },
      ];
    }

    const items: MemoryTreeItem[] = categories.map((cat) => ({
      kind: 'category' as const,
      category: cat,
      source: 'project' as const,
    }));

    return items;
  }

  private getCategoryChildren(node: CategoryNode): MemoryTreeItem[] {
    return this.panel.getMemories()
      .filter((m) => (m.category || 'other') === node.category.name)
      .map((entry) => ({
        kind: 'entry' as const,
        entry,
      }));
  }

  private createCategoryItem(node: CategoryNode): vscode.TreeItem {
    const cat = node.category;
    const item = new vscode.TreeItem(
      `${cat.displayName} (${cat.count})`,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.iconPath = new vscode.ThemeIcon(cat.icon);
    item.contextValue = 'memoryCategory';
    return item;
  }

  private createEntryItem(node: EntryNode): vscode.TreeItem {
    const entry = node.entry;
    const firstLine = entry.content.split('\n')[0] || entry.content;
    const item = new vscode.TreeItem(
      firstLine.substring(0, 60),
      vscode.TreeItemCollapsibleState.None,
    );

    const sourceIcon = entry.source === 'project' ? '📁' : entry.source === 'global' ? '🌐' : '💬';
    item.description = `${sourceIcon} ${new Date(entry.updatedAt).toLocaleDateString('zh-CN')}`;

    item.tooltip = new vscode.MarkdownString(
      `**${firstLine}**\n\n` +
      (entry.content.length > firstLine.length ? `${entry.content}\n\n` : '') +
      `来源: ${entry.source} | 分类: ${CATEGORIES[entry.category]?.displayName || entry.category}`,
    );

    item.iconPath = new vscode.ThemeIcon('note');

    item.command = {
      command: 'openaide.memory.viewEntry',
      title: '查看记忆',
      arguments: [node],
    };

    item.contextValue = 'memoryEntry';

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
