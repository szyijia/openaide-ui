/**
 * OpenAIDE IDE — 自动更新服务
 *
 * 功能：
 * - 检查 GitHub Releases 获取最新版本
 * - 比较版本号判断是否需要更新
 * - 下载安装包到本地临时目录
 * - 通知用户并引导安装
 * - 支持自动检查（可配置间隔）
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';

// ─── 类型定义 ───

/** 更新检查结果 */
export interface UpdateInfo {
  /** 最新版本号 */
  version: string;
  /** 发布日期 */
  releaseDate: string;
  /** 更新说明 */
  releaseNotes: string;
  /** 下载链接（当前平台） */
  downloadUrl: string;
  /** 文件大小（字节） */
  fileSize: number;
  /** 文件名 */
  fileName: string;
  /** 是否为预发布版本 */
  prerelease: boolean;
}

/** 下载进度 */
export interface DownloadProgress {
  /** 已下载字节数 */
  downloaded: number;
  /** 总字节数 */
  total: number;
  /** 百分比 (0-100) */
  percent: number;
}

/** 更新配置 */
export interface UpdateConfig {
  /** GitHub 仓库 owner/repo */
  repo: string;
  /** 当前版本号 */
  currentVersion: string;
  /** 自动检查间隔（毫秒），0 表示禁用 */
  checkInterval: number;
  /** 是否包含预发布版本 */
  includePrerelease: boolean;
  /** 下载目录 */
  downloadDir: string;
  /** GitHub API 基础 URL（支持自定义 mirror） */
  apiBaseUrl: string;
}

/** 更新事件 */
export interface UpdateEvents {
  'checking': () => void;
  'update-available': (info: UpdateInfo) => void;
  'update-not-available': (currentVersion: string) => void;
  'download-progress': (progress: DownloadProgress) => void;
  'download-complete': (filePath: string) => void;
  'error': (error: Error) => void;
}

// ─── GitHub API 类型 ───

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  prerelease: boolean;
  assets: GitHubAsset[];
}

interface GitHubAsset {
  name: string;
  size: number;
  browser_download_url: string;
  content_type: string;
}

// ─── 版本比较工具 ───

/**
 * 语义化版本比较
 * @returns 正数表示 a > b，负数表示 a < b，0 表示相等
 */
function compareVersions(a: string, b: string): number {
  const normalize = (v: string) => v.replace(/^v/, '');
  const partsA = normalize(a).split('.').map(Number);
  const partsB = normalize(b).split('.').map(Number);

  const maxLen = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < maxLen; i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA !== numB) return numA - numB;
  }
  return 0;
}

/**
 * 获取当前平台的安装包文件扩展名模式
 */
function getPlatformAssetPatterns(): string[] {
  const platform = os.platform();
  const arch = os.arch();

  switch (platform) {
    case 'darwin':
      return ['.dmg', 'darwin-universal.zip', 'darwin-arm64.zip', 'darwin-x64.zip'];
    case 'win32':
      return arch === 'arm64'
        ? ['-arm64.exe', '-arm64-setup.exe']
        : ['-x64.exe', '-x64-setup.exe', '.exe'];
    case 'linux':
      if (arch === 'arm64') {
        return ['-arm64.deb', '-arm64.AppImage', '-aarch64.rpm'];
      }
      return ['-amd64.deb', '-x86_64.AppImage', '-x86_64.rpm', '.deb'];
    default:
      return ['.zip', '.tar.gz'];
  }
}

/**
 * 从 Release assets 中找到当前平台的下载链接
 */
function findPlatformAsset(assets: GitHubAsset[]): GitHubAsset | null {
  const patterns = getPlatformAssetPatterns();

  for (const pattern of patterns) {
    const asset = assets.find(a =>
      a.name.toLowerCase().includes(pattern.toLowerCase()) ||
      a.name.toLowerCase().endsWith(pattern.toLowerCase())
    );
    if (asset) return asset;
  }

  return null;
}

// ─── 自动更新服务 ───

export class AutoUpdateService extends EventEmitter {
  private config: UpdateConfig;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private isChecking = false;
  private isDownloading = false;
  private latestUpdate: UpdateInfo | null = null;

  constructor(config: Partial<UpdateConfig> = {}) {
    super();
    this.config = {
      repo: config.repo || 'user/openaide',
      currentVersion: config.currentVersion || '0.1.0',
      checkInterval: config.checkInterval ?? 4 * 60 * 60 * 1000, // 默认 4 小时
      includePrerelease: config.includePrerelease ?? false,
      downloadDir: config.downloadDir || path.join(os.tmpdir(), 'openaide-updates'),
      apiBaseUrl: config.apiBaseUrl || 'https://api.github.com',
    };
  }

  /**
   * 启动自动更新检查
   */
  start(): void {
    if (this.config.checkInterval <= 0) return;

    // 启动后延迟 30 秒进行首次检查（避免影响启动速度）
    setTimeout(() => {
      this.checkForUpdates().catch(() => {});
    }, 30_000);

    // 定期检查
    this.checkTimer = setInterval(() => {
      this.checkForUpdates().catch(() => {});
    }, this.config.checkInterval);
  }

  /**
   * 停止自动更新检查
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * 手动检查更新
   */
  async checkForUpdates(): Promise<UpdateInfo | null> {
    if (this.isChecking) return null;

    this.isChecking = true;
    this.emit('checking');

    try {
      const release = await this.fetchLatestRelease();
      if (!release) {
        this.emit('update-not-available', this.config.currentVersion);
        return null;
      }

      const remoteVersion = release.tag_name.replace(/^v/, '');
      const currentVersion = this.config.currentVersion.replace(/^v/, '');

      // 版本比较
      if (compareVersions(remoteVersion, currentVersion) <= 0) {
        this.emit('update-not-available', this.config.currentVersion);
        return null;
      }

      // 跳过预发布版本（除非配置允许）
      if (release.prerelease && !this.config.includePrerelease) {
        this.emit('update-not-available', this.config.currentVersion);
        return null;
      }

      // 查找当前平台的安装包
      const asset = findPlatformAsset(release.assets);
      if (!asset) {
        this.emit('error', new Error(`未找到当前平台 (${os.platform()}-${os.arch()}) 的安装包`));
        return null;
      }

      const updateInfo: UpdateInfo = {
        version: remoteVersion,
        releaseDate: release.published_at,
        releaseNotes: release.body || '无更新说明',
        downloadUrl: asset.browser_download_url,
        fileSize: asset.size,
        fileName: asset.name,
        prerelease: release.prerelease,
      };

      this.latestUpdate = updateInfo;
      this.emit('update-available', updateInfo);
      return updateInfo;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit('error', err);
      return null;
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * 下载更新
   */
  async downloadUpdate(info?: UpdateInfo): Promise<string> {
    const updateInfo = info || this.latestUpdate;
    if (!updateInfo) {
      throw new Error('没有可用的更新信息，请先调用 checkForUpdates()');
    }

    if (this.isDownloading) {
      throw new Error('已有下载任务正在进行');
    }

    this.isDownloading = true;

    try {
      // 确保下载目录存在
      await fs.promises.mkdir(this.config.downloadDir, { recursive: true });

      const filePath = path.join(this.config.downloadDir, updateInfo.fileName);

      // 如果文件已存在且大小匹配，跳过下载
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.size === updateInfo.fileSize) {
          this.emit('download-complete', filePath);
          return filePath;
        }
      } catch {
        // 文件不存在，继续下载
      }

      // 下载文件
      await this.downloadFile(updateInfo.downloadUrl, filePath, updateInfo.fileSize);

      this.emit('download-complete', filePath);
      return filePath;
    } finally {
      this.isDownloading = false;
    }
  }

  /**
   * 获取安装指引
   */
  getInstallInstructions(filePath: string): string {
    const platform = os.platform();
    const fileName = path.basename(filePath);

    switch (platform) {
      case 'darwin':
        if (fileName.endsWith('.dmg')) {
return `请打开 ${fileName}，将"OpenAIDE"拖入"应用程序"文件夹，然后重启 IDE。`;
        }
return `请解压 ${fileName}，将"OpenAIDE.app"移动到"应用程序"文件夹，然后重启 IDE。`;

      case 'win32':
        return `请运行 ${fileName} 安装程序，安装完成后 IDE 将自动重启。`;

      case 'linux':
        if (fileName.endsWith('.deb')) {
          return `请运行: sudo dpkg -i ${fileName}\n然后重启 IDE。`;
        }
        if (fileName.endsWith('.rpm')) {
          return `请运行: sudo rpm -U ${fileName}\n然后重启 IDE。`;
        }
        if (fileName.endsWith('.AppImage')) {
          return `请替换旧的 AppImage 文件为 ${fileName}，添加执行权限后重启。`;
        }
        return `请安装 ${fileName} 后重启 IDE。`;

      default:
        return `请安装 ${fileName} 后重启 IDE。`;
    }
  }

  /**
   * 获取当前版本
   */
  getCurrentVersion(): string {
    return this.config.currentVersion;
  }

  /**
   * 获取最新的更新信息
   */
  getLatestUpdate(): UpdateInfo | null {
    return this.latestUpdate;
  }

  /**
   * 清理下载缓存
   */
  async cleanDownloadCache(): Promise<void> {
    try {
      await fs.promises.rm(this.config.downloadDir, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
  }

  // ─── 私有方法 ───

  /**
   * 从 GitHub API 获取最新 Release
   */
  private fetchLatestRelease(): Promise<GitHubRelease | null> {
    const url = `${this.config.apiBaseUrl}/repos/${this.config.repo}/releases/latest`;

    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': `OpenAIDE-IDE/${this.config.currentVersion}`,
          'Accept': 'application/vnd.github.v3+json',
        },
        timeout: 15_000,
      }, (res) => {
        if (res.statusCode === 404) {
          resolve(null);
          return;
        }

        if (res.statusCode === 301 || res.statusCode === 302) {
          // 跟随重定向
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            https.get(redirectUrl, {
              headers: {
                'User-Agent': `OpenAIDE-IDE/${this.config.currentVersion}`,
                'Accept': 'application/vnd.github.v3+json',
              },
            }, (redirectRes) => {
              this.readResponse(redirectRes).then(resolve).catch(reject);
            }).on('error', reject);
            return;
          }
        }

        if (res.statusCode !== 200) {
          reject(new Error(`GitHub API 返回 ${res.statusCode}`));
          return;
        }

        this.readResponse(res).then(resolve).catch(reject);
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('请求超时'));
      });
    });
  }

  /**
   * 读取 HTTP 响应体
   */
  private readResponse(res: import('http').IncomingMessage): Promise<GitHubRelease | null> {
    return new Promise((resolve, reject) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          const json = JSON.parse(data) as GitHubRelease;
          resolve(json);
        } catch {
          reject(new Error('解析 GitHub API 响应失败'));
        }
      });
      res.on('error', reject);
    });
  }

  /**
   * 下载文件（支持进度回调和重定向）
   */
  private downloadFile(url: string, destPath: string, totalSize: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const doDownload = (downloadUrl: string, redirectCount = 0) => {
        if (redirectCount > 5) {
          reject(new Error('重定向次数过多'));
          return;
        }

        const protocol = downloadUrl.startsWith('https') ? https : require('http');
        const req = protocol.get(downloadUrl, {
          headers: {
            'User-Agent': `OpenAIDE-IDE/${this.config.currentVersion}`,
          },
          timeout: 300_000, // 5 分钟超时
        }, (res: import('http').IncomingMessage) => {
          // 处理重定向
          if (res.statusCode === 301 || res.statusCode === 302) {
            const redirectUrl = res.headers.location;
            if (redirectUrl) {
              doDownload(redirectUrl, redirectCount + 1);
              return;
            }
          }

          if (res.statusCode !== 200) {
            reject(new Error(`下载失败: HTTP ${res.statusCode}`));
            return;
          }

          const fileStream = fs.createWriteStream(destPath);
          let downloaded = 0;
          const actualTotal = parseInt(res.headers['content-length'] || '0', 10) || totalSize;

          res.on('data', (chunk: Buffer) => {
            downloaded += chunk.length;
            const percent = actualTotal > 0 ? Math.round((downloaded / actualTotal) * 100) : 0;
            this.emit('download-progress', {
              downloaded,
              total: actualTotal,
              percent,
            } as DownloadProgress);
          });

          res.pipe(fileStream);

          fileStream.on('finish', () => {
            fileStream.close();
            resolve();
          });

          fileStream.on('error', (err) => {
            // 清理不完整的文件
            fs.unlink(destPath, () => {});
            reject(err);
          });
        });

        req.on('error', (err: Error) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });

        req.on('timeout', () => {
          req.destroy();
          fs.unlink(destPath, () => {});
          reject(new Error('下载超时'));
        });
      };

      doDownload(url);
    });
  }
}

// ─── 导出便捷函数 ───

/**
 * 创建自动更新服务实例
 */
export function createAutoUpdater(config?: Partial<UpdateConfig>): AutoUpdateService {
  return new AutoUpdateService(config);
}
