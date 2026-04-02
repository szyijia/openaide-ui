/**
 * AutoUpdateService 单元测试
 *
 * 测试覆盖：
 * - 构造函数和配置
 * - 启动/停止自动检查
 * - 版本检查逻辑
 * - 下载更新
 * - 安装指引
 * - 缓存清理
 * - 事件发射
 * - createAutoUpdater 工厂函数
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AutoUpdateService,
  createAutoUpdater,
  type UpdateInfo,
  type UpdateConfig,
} from '../src/updater/auto-update.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import { EventEmitter } from 'events';

// ─── Mock 设置 ───

// Mock https 模块
vi.mock('https', () => ({
  default: { get: vi.fn() },
  get: vi.fn(),
}));

// Mock fs.promises
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockRejectedValue(new Error('ENOENT')),
      rm: vi.fn().mockResolvedValue(undefined),
    },
    createWriteStream: vi.fn().mockReturnValue({
      on: vi.fn(),
      close: vi.fn(),
    }),
    unlink: vi.fn(),
  };
});

// ─── 辅助函数 ───

function createService(config?: Partial<UpdateConfig>): AutoUpdateService {
  return new AutoUpdateService({
    repo: 'nicepkg/openaide',
    currentVersion: '0.1.0',
    checkInterval: 0, // 禁用自动检查
    downloadDir: path.join(os.tmpdir(), 'openaide-test-updates'),
    ...config,
  });
}

/** 模拟 GitHub API 返回有新版本的 Release */
function mockGitHubRelease(version: string, prerelease = false) {
  const platform = os.platform();
  let assetName: string;
  if (platform === 'darwin') {
    assetName = `openaide-${version}-darwin-${os.arch()}.dmg`;
  } else if (platform === 'win32') {
    assetName = `openaide-${version}-win32-x64-setup.exe`;
  } else {
    assetName = `openaide-${version}-linux-${os.arch()}.deb`;
  }

  return {
    tag_name: `v${version}`,
    name: `v${version}`,
    body: `## 更新内容\n- 新功能 A\n- 修复 Bug B`,
    published_at: '2026-04-01T00:00:00Z',
    prerelease,
    assets: [
      {
        name: assetName,
        size: 85_000_000,
        browser_download_url: `https://github.com/nicepkg/openaide/releases/download/v${version}/${assetName}`,
        content_type: 'application/octet-stream',
      },
    ],
  };
}

/** 模拟 https.get 返回成功响应 */
function mockHttpsGet(responseData: unknown, statusCode = 200) {
  const mockResponse = new EventEmitter() as any;
  mockResponse.statusCode = statusCode;
  mockResponse.headers = {};

  vi.mocked(https.get).mockImplementation((_url: any, _opts: any, callback?: any) => {
    const cb = typeof _opts === 'function' ? _opts : callback;
    if (cb) {
      process.nextTick(() => {
        cb(mockResponse);
        process.nextTick(() => {
          mockResponse.emit('data', Buffer.from(JSON.stringify(responseData)));
          mockResponse.emit('end');
        });
      });
    }
    const req = new EventEmitter() as any;
    req.destroy = vi.fn();
    return req;
  });
}

/** 模拟 https.get 返回 404 */
function mockHttpsGet404() {
  const mockResponse = new EventEmitter() as any;
  mockResponse.statusCode = 404;
  mockResponse.headers = {};

  vi.mocked(https.get).mockImplementation((_url: any, _opts: any, callback?: any) => {
    const cb = typeof _opts === 'function' ? _opts : callback;
    if (cb) {
      process.nextTick(() => cb(mockResponse));
    }
    const req = new EventEmitter() as any;
    req.destroy = vi.fn();
    return req;
  });
}

/** 模拟 https.get 网络错误 */
function mockHttpsGetError(errorMessage: string) {
  vi.mocked(https.get).mockImplementation((_url: any, _opts: any, _callback?: any) => {
    const req = new EventEmitter() as any;
    req.destroy = vi.fn();
    process.nextTick(() => req.emit('error', new Error(errorMessage)));
    return req;
  });
}

// ─── 测试 ───

describe('AutoUpdateService', () => {
  let service: AutoUpdateService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    service = createService();
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
  });

  // ─── 构造函数 ───

  describe('构造函数', () => {
    it('应该使用默认配置创建实例', () => {
      const defaultService = new AutoUpdateService();
      expect(defaultService).toBeDefined();
      expect(defaultService).toBeInstanceOf(EventEmitter);
      expect(defaultService.getCurrentVersion()).toBe('0.1.0');
      defaultService.stop();
    });

    it('应该使用自定义配置创建实例', () => {
      const customService = createService({
        currentVersion: '1.2.3',
        includePrerelease: true,
      });
      expect(customService.getCurrentVersion()).toBe('1.2.3');
      customService.stop();
    });

    it('getLatestUpdate() 初始应该为 null', () => {
      expect(service.getLatestUpdate()).toBeNull();
    });
  });

  // ─── 启动/停止 ───

  describe('启动和停止', () => {
    it('start() 应该设置定时器', () => {
      const timerService = createService({ checkInterval: 60000 });
      timerService.start();

      // 验证定时器已设置（通过 stop 不报错来间接验证）
      timerService.stop();
    });

    it('start() checkInterval 为 0 时不应设置定时器', () => {
      service.start();
      service.stop();
      // 不报错即通过
    });

    it('stop() 应该清除定时器', () => {
      const timerService = createService({ checkInterval: 60000 });
      timerService.start();
      timerService.stop();
      // 不报错即通过
    });

    it('stop() 多次调用不应报错', () => {
      service.stop();
      service.stop();
      service.stop();
    });
  });

  // ─── 版本检查 ───

  describe('版本检查', () => {
    it('有新版本时应该返回 UpdateInfo', async () => {
      const release = mockGitHubRelease('0.2.0');
      mockHttpsGet(release);

      const result = await service.checkForUpdates();

      expect(result).not.toBeNull();
      expect(result!.version).toBe('0.2.0');
      expect(result!.releaseNotes).toContain('新功能 A');
      expect(result!.prerelease).toBe(false);
    });

    it('有新版本时应该发射 update-available 事件', async () => {
      const release = mockGitHubRelease('0.2.0');
      mockHttpsGet(release);

      const listener = vi.fn();
      service.on('update-available', listener);

      await service.checkForUpdates();

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ version: '0.2.0' }),
      );
    });

    it('没有新版本时应该返回 null', async () => {
      const release = mockGitHubRelease('0.1.0'); // 同版本
      mockHttpsGet(release);

      const result = await service.checkForUpdates();

      expect(result).toBeNull();
    });

    it('没有新版本时应该发射 update-not-available 事件', async () => {
      const release = mockGitHubRelease('0.0.9'); // 旧版本
      mockHttpsGet(release);

      const listener = vi.fn();
      service.on('update-not-available', listener);

      await service.checkForUpdates();

      expect(listener).toHaveBeenCalledWith('0.1.0');
    });

    it('远端版本低于当前版本时应该返回 null', async () => {
      const release = mockGitHubRelease('0.0.5');
      mockHttpsGet(release);

      const result = await service.checkForUpdates();

      expect(result).toBeNull();
    });

    it('预发布版本默认应该被跳过', async () => {
      const release = mockGitHubRelease('0.2.0-beta.1', true);
      mockHttpsGet(release);

      const result = await service.checkForUpdates();

      expect(result).toBeNull();
    });

    it('启用 includePrerelease 时应该包含预发布版本', async () => {
      const prereleaseService = createService({ includePrerelease: true });
      const release = mockGitHubRelease('0.2.0-beta.1', true);
      mockHttpsGet(release);

      const result = await prereleaseService.checkForUpdates();

      expect(result).not.toBeNull();
      expect(result!.version).toBe('0.2.0-beta.1');
      expect(result!.prerelease).toBe(true);

      prereleaseService.stop();
    });

    it('GitHub API 返回 404 时应该返回 null', async () => {
      mockHttpsGet404();

      const result = await service.checkForUpdates();

      expect(result).toBeNull();
    });

    it('网络错误时应该发射 error 事件', async () => {
      mockHttpsGetError('Network unreachable');

      const errorListener = vi.fn();
      service.on('error', errorListener);

      const result = await service.checkForUpdates();

      expect(result).toBeNull();
      expect(errorListener).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Network unreachable' }),
      );
    });

    it('检查时应该发射 checking 事件', async () => {
      mockHttpsGet404();

      const listener = vi.fn();
      service.on('checking', listener);

      await service.checkForUpdates();

      expect(listener).toHaveBeenCalled();
    });

    it('并发检查应该被忽略', async () => {
      // 模拟一个慢响应
      vi.mocked(https.get).mockImplementation((_url: any, _opts: any, callback?: any) => {
        const cb = typeof _opts === 'function' ? _opts : callback;
        // 不立即回调，模拟慢响应
        const req = new EventEmitter() as any;
        req.destroy = vi.fn();
        return req;
      });

      // 启动第一次检查（不会完成）
      const firstCheck = service.checkForUpdates();

      // 第二次检查应该立即返回 null
      const secondResult = await service.checkForUpdates();
      expect(secondResult).toBeNull();

      // 清理：让第一次检查超时
      service.stop();
    });

    it('checkForUpdates() 应该保存最新更新信息', async () => {
      const release = mockGitHubRelease('0.3.0');
      mockHttpsGet(release);

      await service.checkForUpdates();

      const latest = service.getLatestUpdate();
      expect(latest).not.toBeNull();
      expect(latest!.version).toBe('0.3.0');
    });
  });

  // ─── 下载更新 ───

  describe('下载更新', () => {
    it('没有更新信息时应该抛出错误', async () => {
      await expect(service.downloadUpdate()).rejects.toThrow('没有可用的更新信息');
    });

    it('传入 UpdateInfo 时应该使用传入的信息', async () => {
      const updateInfo: UpdateInfo = {
        version: '0.2.0',
        releaseDate: '2026-04-01T00:00:00Z',
        releaseNotes: '测试更新',
        downloadUrl: 'https://example.com/openaide-0.2.0.dmg',
        fileSize: 1000,
        fileName: 'openaide-0.2.0.dmg',
        prerelease: false,
      };

      // Mock 文件已存在且大小匹配
      vi.mocked(fs.promises.stat).mockResolvedValueOnce({ size: 1000 } as any);

      const filePath = await service.downloadUpdate(updateInfo);

      expect(filePath).toContain('openaide-0.2.0.dmg');
    });

    it('文件已存在且大小匹配时应该跳过下载', async () => {
      const updateInfo: UpdateInfo = {
        version: '0.2.0',
        releaseDate: '2026-04-01T00:00:00Z',
        releaseNotes: '测试更新',
        downloadUrl: 'https://example.com/openaide-0.2.0.dmg',
        fileSize: 85_000_000,
        fileName: 'openaide-0.2.0.dmg',
        prerelease: false,
      };

      // Mock 文件已存在且大小匹配
      vi.mocked(fs.promises.stat).mockResolvedValueOnce({ size: 85_000_000 } as any);

      const downloadCompleteListener = vi.fn();
      service.on('download-complete', downloadCompleteListener);

      const filePath = await service.downloadUpdate(updateInfo);

      expect(filePath).toContain('openaide-0.2.0.dmg');
      expect(downloadCompleteListener).toHaveBeenCalled();
      // https.get 不应被调用（跳过了下载）
      expect(https.get).not.toHaveBeenCalled();
    });
  });

  // ─── 安装指引 ───

  describe('安装指引', () => {
    it('macOS DMG 应该返回正确指引', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });

      const instructions = service.getInstallInstructions('/tmp/openaide-0.2.0.dmg');

      expect(instructions).toContain('dmg');
      expect(instructions).toContain('应用程序');

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('Windows EXE 应该返回正确指引', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });

      const instructions = service.getInstallInstructions('C:\\temp\\openaide-0.2.0-setup.exe');

      expect(instructions).toContain('安装程序');

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('Linux DEB 应该返回正确指引', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux' });

      const instructions = service.getInstallInstructions('/tmp/openaide-0.2.0.deb');

      expect(instructions).toContain('dpkg');

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('Linux RPM 应该返回正确指引', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux' });

      const instructions = service.getInstallInstructions('/tmp/openaide-0.2.0.rpm');

      expect(instructions).toContain('rpm');

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('Linux AppImage 应该返回正确指引', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux' });

      const instructions = service.getInstallInstructions('/tmp/openaide-0.2.0.AppImage');

      expect(instructions).toContain('AppImage');

      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });
  });

  // ─── 缓存清理 ───

  describe('缓存清理', () => {
    it('cleanDownloadCache() 应该删除下载目录', async () => {
      await service.cleanDownloadCache();

      expect(fs.promises.rm).toHaveBeenCalledWith(
        expect.stringContaining('openaide-test-updates'),
        { recursive: true, force: true },
      );
    });

    it('cleanDownloadCache() 目录不存在时不应报错', async () => {
      vi.mocked(fs.promises.rm).mockRejectedValueOnce(new Error('ENOENT'));

      // 不应抛出错误
      await service.cleanDownloadCache();
    });
  });

  // ─── 版本信息 ───

  describe('版本信息', () => {
    it('getCurrentVersion() 应该返回当前版本', () => {
      expect(service.getCurrentVersion()).toBe('0.1.0');
    });

    it('自定义版本号应该正确返回', () => {
      const customService = createService({ currentVersion: '2.5.3' });
      expect(customService.getCurrentVersion()).toBe('2.5.3');
      customService.stop();
    });
  });

  // ─── createAutoUpdater 工厂函数 ───

  describe('createAutoUpdater', () => {
    it('应该创建 AutoUpdateService 实例', () => {
      const updater = createAutoUpdater({ checkInterval: 0 });

      expect(updater).toBeInstanceOf(AutoUpdateService);
      expect(updater).toBeInstanceOf(EventEmitter);

      updater.stop();
    });

    it('无参数调用应该使用默认配置', () => {
      const updater = createAutoUpdater();

      expect(updater.getCurrentVersion()).toBe('0.1.0');

      updater.stop();
    });
  });

  // ─── 版本比较（通过 checkForUpdates 间接测试） ───

  describe('版本比较', () => {
    it('主版本号更高应该检测到更新', async () => {
      mockHttpsGet(mockGitHubRelease('1.0.0'));
      const result = await service.checkForUpdates();
      expect(result).not.toBeNull();
      expect(result!.version).toBe('1.0.0');
    });

    it('次版本号更高应该检测到更新', async () => {
      mockHttpsGet(mockGitHubRelease('0.2.0'));
      const result = await service.checkForUpdates();
      expect(result).not.toBeNull();
    });

    it('补丁版本号更高应该检测到更新', async () => {
      mockHttpsGet(mockGitHubRelease('0.1.1'));
      const result = await service.checkForUpdates();
      expect(result).not.toBeNull();
    });

    it('相同版本不应检测到更新', async () => {
      mockHttpsGet(mockGitHubRelease('0.1.0'));
      const result = await service.checkForUpdates();
      expect(result).toBeNull();
    });

    it('带 v 前缀的版本号应该正确比较', async () => {
      const release = mockGitHubRelease('0.2.0');
      release.tag_name = 'v0.2.0'; // 带 v 前缀
      mockHttpsGet(release);

      const result = await service.checkForUpdates();
      expect(result).not.toBeNull();
      expect(result!.version).toBe('0.2.0');
    });
  });

  // ─── 事件系统 ───

  describe('事件系统', () => {
    it('应该支持 on/off 事件监听', () => {
      const listener = vi.fn();
      service.on('checking', listener);
      service.off('checking', listener);
      // 不报错即通过
    });

    it('应该支持 once 事件监听', async () => {
      mockHttpsGet404();

      const listener = vi.fn();
      service.once('checking', listener);

      await service.checkForUpdates();
      await service.checkForUpdates();

      // once 只触发一次
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});
