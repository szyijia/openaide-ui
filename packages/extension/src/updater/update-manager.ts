/**
 * OpenAIDE IDE — Extension 自动更新集成
 *
 * 在 VS Code Extension 中集成自动更新功能：
 * - 状态栏显示更新状态
 * - 弹窗通知新版本
 * - 下载进度展示
 * - 安装引导
 */

import * as vscode from 'vscode';

// 内联类型定义（避免跨模块 ESM/CJS 导入问题，esbuild 打包时会正确处理）
interface UpdateInfo {
  version: string;
  releaseDate: string;
  releaseNotes: string;
  downloadUrl: string;
  fileSize: number;
  fileName: string;
  prerelease: boolean;
}

interface DownloadProgress {
  downloaded: number;
  total: number;
  percent: number;
}

interface IAutoUpdateService {
  start(): void;
  stop(): void;
  checkForUpdates(): Promise<UpdateInfo | null>;
  downloadUpdate(info?: UpdateInfo): Promise<string>;
  getInstallInstructions(filePath: string): string;
  getCurrentVersion(): string;
  getLatestUpdate(): UpdateInfo | null;
  on(event: string, listener: (...args: any[]) => void): void;
  removeListener(event: string, listener: (...args: any[]) => void): void;
}

/**
 * 动态加载 AutoUpdateService（解决 ESM/CJS 兼容问题）
 */
async function loadAutoUpdater(config: Record<string, any>): Promise<IAutoUpdateService> {
  const mod = await import('@openaide/core/src/updater/auto-update.js');
  return mod.createAutoUpdater(config) as IAutoUpdateService;
}

export class UpdateManager implements vscode.Disposable {
  private updater: IAutoUpdateService | null = null;
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private outputChannel: vscode.OutputChannel;

  constructor(context: vscode.ExtensionContext) {
    // 创建状态栏项
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      50
    );
    this.statusBarItem.command = 'openaide.checkUpdate';

    // 创建输出通道
    this.outputChannel = vscode.window.createOutputChannel('OpenAIDE更新');

    // 注册命令
    this.registerCommands(context);

    // 异步初始化更新服务
    this.initUpdater(context).catch(err => {
      this.log(`更新服务初始化失败: ${err.message}`);
    });
  }

  /**
   * 异步初始化更新服务
   */
  private async initUpdater(_context: vscode.ExtensionContext): Promise<void> {
    // 从 package.json 获取当前版本
    const extension = vscode.extensions.getExtension('openaide.openaide-ai');
    const currentVersion = extension?.packageJSON?.version || '0.1.0';

    // 读取配置
    const config = vscode.workspace.getConfiguration('openaide.update');
    const checkInterval = config.get<number>('checkInterval', 4) * 60 * 60 * 1000;
    const includePrerelease = config.get<boolean>('includePrerelease', false);
    const repo = config.get<string>('repo', 'user/openaide');

    // 动态加载更新服务
    this.updater = await loadAutoUpdater({
      repo,
      currentVersion,
      checkInterval,
      includePrerelease,
    });

    // 绑定事件
    this.bindEvents();

    // 启动自动检查
    if (checkInterval > 0) {
      this.updater.start();
      this.log(`自动更新已启动，检查间隔: ${checkInterval / 3600000} 小时`);
    }
  }

  /**
   * 注册更新相关命令
   */
  private registerCommands(context: vscode.ExtensionContext): void {
    // 手动检查更新
    const checkCmd = vscode.commands.registerCommand('openaide.checkUpdate', async () => {
      await this.manualCheckUpdate();
    });

    // 下载更新
    const downloadCmd = vscode.commands.registerCommand('openaide.downloadUpdate', async () => {
      await this.downloadUpdate();
    });

    // 查看更新日志
    const changelogCmd = vscode.commands.registerCommand('openaide.viewChangelog', () => {
      const update = this.updater?.getLatestUpdate();
      if (update) {
        this.showChangelog(update);
      } else {
        vscode.window.showInformationMessage('暂无更新信息');
      }
    });

    this.disposables.push(checkCmd, downloadCmd, changelogCmd);
    context.subscriptions.push(checkCmd, downloadCmd, changelogCmd);
  }

  /**
   * 绑定更新服务事件
   */
  private bindEvents(): void {
    if (!this.updater) return;

    this.updater.on('checking', () => {
      this.statusBarItem.text = '$(sync~spin) 检查更新...';
      this.statusBarItem.tooltip = '正在检查OpenAIDE IDE 更新';
      this.statusBarItem.show();
      this.log('正在检查更新...');
    });

    this.updater.on('update-available', (info: UpdateInfo) => {
      this.statusBarItem.text = `$(cloud-download) OpenAIDE v${info.version} 可用`;
      this.statusBarItem.tooltip = `点击下载OpenAIDE IDE v${info.version}`;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.statusBarItem.show();

      this.log(`发现新版本: v${info.version} (${info.releaseDate})`);
      this.showUpdateNotification(info);
    });

    this.updater.on('update-not-available', (currentVersion: string) => {
      this.statusBarItem.text = `$(check) OpenAIDE v${currentVersion}`;
      this.statusBarItem.tooltip = 'OpenAIDE IDE 已是最新版本';
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.show();

      // 3 秒后隐藏状态栏
      setTimeout(() => {
        this.statusBarItem.hide();
      }, 3000);

      this.log(`当前已是最新版本: v${currentVersion}`);
    });

    this.updater.on('download-progress', (progress: DownloadProgress) => {
      this.statusBarItem.text = `$(cloud-download) 下载中 ${progress.percent}%`;
      this.statusBarItem.tooltip = `已下载 ${this.formatBytes(progress.downloaded)} / ${this.formatBytes(progress.total)}`;
    });

    this.updater.on('download-complete', (filePath: string) => {
      this.statusBarItem.text = '$(check) 下载完成';
      this.statusBarItem.tooltip = '点击安装更新';
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

      this.log(`下载完成: ${filePath}`);
      this.showInstallPrompt(filePath);
    });

    this.updater.on('error', (error: Error) => {
      this.statusBarItem.text = '$(warning) 更新检查失败';
      this.statusBarItem.tooltip = error.message;
      this.statusBarItem.backgroundColor = undefined;

      this.log(`错误: ${error.message}`);

      // 5 秒后隐藏
      setTimeout(() => {
        this.statusBarItem.hide();
      }, 5000);
    });
  }

  /**
   * 手动检查更新
   */
  private async manualCheckUpdate(): Promise<void> {
    if (!this.updater) {
      vscode.window.showWarningMessage('更新服务尚未初始化，请稍后重试');
      return;
    }
    const result = await this.updater.checkForUpdates();
    if (!result) {
      vscode.window.showInformationMessage(
        `OpenAIDE IDE v${this.updater.getCurrentVersion()} 已是最新版本 ✓`
      );
    }
  }

  /**
   * 下载更新
   */
  private async downloadUpdate(): Promise<void> {
    if (!this.updater) {
      vscode.window.showWarningMessage('更新服务尚未初始化，请稍后重试');
      return;
    }
    const update = this.updater.getLatestUpdate();
    if (!update) {
      vscode.window.showWarningMessage('没有可用的更新');
      return;
    }

    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `正在下载OpenAIDE IDE v${update.version}`,
        cancellable: false,
      }, async (progress) => {
        // 监听下载进度
        const progressHandler = (p: DownloadProgress) => {
          progress.report({
            increment: p.percent,
            message: `${this.formatBytes(p.downloaded)} / ${this.formatBytes(p.total)}`,
          });
        };
        this.updater!.on('download-progress', progressHandler);

        try {
          await this.updater!.downloadUpdate(update);
        } finally {
          this.updater!.removeListener('download-progress', progressHandler);
        }
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`下载失败: ${msg}`);
    }
  }

  /**
   * 显示更新通知
   */
  private showUpdateNotification(info: UpdateInfo): void {
    const message = `OpenAIDE IDE v${info.version} 已发布！(${this.formatBytes(info.fileSize)})`;

    vscode.window.showInformationMessage(
      message,
      '下载更新',
      '查看更新日志',
      '稍后提醒'
    ).then(selection => {
      switch (selection) {
        case '下载更新':
          vscode.commands.executeCommand('openaide.downloadUpdate');
          break;
        case '查看更新日志':
          this.showChangelog(info);
          break;
        case '稍后提醒':
          // 不做任何操作，下次检查时会再次提醒
          break;
      }
    });
  }

  /**
   * 显示安装提示
   */
  private showInstallPrompt(filePath: string): void {
    const instructions = this.updater?.getInstallInstructions(filePath) || '请安装下载的更新包后重启 IDE。';

    vscode.window.showInformationMessage(
      `更新已下载完成！\n${instructions}`,
      '打开下载目录',
      '关闭'
    ).then(selection => {
      if (selection === '打开下载目录') {
        const dirPath = require('path').dirname(filePath);
        vscode.env.openExternal(vscode.Uri.file(dirPath));
      }
    });
  }

  /**
   * 显示更新日志
   */
  private showChangelog(info: UpdateInfo): void {
    const panel = vscode.window.createWebviewPanel(
      'openaideChangelog',
      `OpenAIDE IDE v${info.version} 更新日志`,
      vscode.ViewColumn.One,
      { enableScripts: false }
    );

    panel.webview.html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px;
      line-height: 1.6;
    }
    h1 { color: var(--vscode-textLink-foreground); border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 10px; }
    h2 { color: var(--vscode-textLink-activeForeground); }
    .meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-bottom: 20px; }
    code { background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 3px; }
    pre { background: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 6px; overflow-x: auto; }
    ul { padding-left: 20px; }
    li { margin: 4px 0; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.8em; }
    .badge-stable { background: #28a745; color: white; }
    .badge-pre { background: #ffc107; color: black; }
  </style>
</head>
<body>
  <h1>OpenAIDE IDE v${info.version}
    <span class="badge ${info.prerelease ? 'badge-pre' : 'badge-stable'}">
      ${info.prerelease ? '预发布' : '稳定版'}
    </span>
  </h1>
  <div class="meta">
    发布日期: ${new Date(info.releaseDate).toLocaleDateString('zh-CN')} |
    文件大小: ${this.formatBytes(info.fileSize)}
  </div>
  <div>${this.markdownToHtml(info.releaseNotes)}</div>
</body>
</html>`;
  }

  /**
   * 简单的 Markdown 转 HTML
   */
  private markdownToHtml(md: string): string {
    return md
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
      .replace(/\n\n/g, '<br><br>')
      .replace(/\n/g, '<br>');
  }

  /**
   * 格式化字节数
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  }

  /**
   * 写入日志
   */
  private log(message: string): void {
    const timestamp = new Date().toLocaleTimeString('zh-CN');
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
  }

  dispose(): void {
    this.updater?.stop();
    this.statusBarItem.dispose();
    this.outputChannel.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
