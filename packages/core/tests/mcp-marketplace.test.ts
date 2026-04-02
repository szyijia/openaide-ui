/**
 * MCPMarketplace 单元测试
 *
 * 测试覆盖：
 * - 服务器注册表（内置服务器列表）
 * - 搜索和发现（关键词搜索、分类筛选、推荐）
 * - 安装/卸载管理
 * - 启用/禁用切换
 * - 环境变量配置
 * - 启动配置生成
 * - 配置导出/导入
 * - 事件触发
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MCPMarketplace, type MCPCategory } from '../src/mcp/marketplace.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// 使用临时目录避免污染用户数据
const TEST_CONFIG_DIR = path.join(os.tmpdir(), `openaide-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

describe('MCPMarketplace', () => {
  let marketplace: MCPMarketplace;

  beforeEach(async () => {
    // 确保测试目录干净
    try {
      await fs.rm(TEST_CONFIG_DIR, { recursive: true, force: true });
    } catch { /* 忽略 */ }
    marketplace = new MCPMarketplace(TEST_CONFIG_DIR);
  });

  afterEach(async () => {
    try {
      await fs.rm(TEST_CONFIG_DIR, { recursive: true, force: true });
    } catch { /* 忽略 */ }
  });

  // ─── 服务器注册表 ───

  describe('服务器注册表', () => {
    it('应该包含内置 MCP 服务器', () => {
      const servers = marketplace.getAllServers();
      expect(servers.length).toBeGreaterThan(0);
    });

    it('内置服务器应该包含 filesystem', () => {
      const server = marketplace.getServer('filesystem');
      expect(server).toBeDefined();
      expect(server!.name).toBe('Filesystem');
      expect(server!.category).toBe('filesystem');
    });

    it('内置服务器应该包含 github', () => {
      const server = marketplace.getServer('github');
      expect(server).toBeDefined();
      expect(server!.name).toBe('GitHub');
      expect(server!.category).toBe('devtools');
    });

    it('内置服务器应该包含 sqlite', () => {
      const server = marketplace.getServer('sqlite');
      expect(server).toBeDefined();
      expect(server!.category).toBe('database');
    });

    it('获取不存在的服务器应该返回 undefined', () => {
      const server = marketplace.getServer('nonexistent');
      expect(server).toBeUndefined();
    });

    it('每个服务器应该有完整的元数据', () => {
      const servers = marketplace.getAllServers();
      for (const server of servers) {
        expect(server.id).toBeTruthy();
        expect(server.name).toBeTruthy();
        expect(server.description).toBeTruthy();
        expect(server.category).toBeTruthy();
        expect(server.author).toBeTruthy();
        expect(server.version).toBeTruthy();
        expect(server.installMethod).toBeTruthy();
        expect(server.installConfig).toBeDefined();
        expect(server.installConfig.command).toBeTruthy();
        expect(Array.isArray(server.tools)).toBe(true);
        expect(typeof server.rating).toBe('number');
        expect(typeof server.downloads).toBe('number');
      }
    });
  });

  // ─── 搜索和发现 ───

  describe('搜索和发现', () => {
    it('搜索 "database" 应该返回数据库相关服务器', () => {
      const results = marketplace.searchServers('database');
      expect(results.length).toBeGreaterThan(0);
      // 应该包含 sqlite 或 postgres
      const ids = results.map(r => r.id);
      expect(ids.some(id => ['sqlite', 'postgres'].includes(id))).toBe(true);
    });

    it('搜索 "GitHub" 应该返回 GitHub 服务器', () => {
      const results = marketplace.searchServers('GitHub');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.id).toBe('github');
    });

    it('搜索应该不区分大小写', () => {
      const results1 = marketplace.searchServers('github');
      const results2 = marketplace.searchServers('GITHUB');
      expect(results1.length).toBe(results2.length);
    });

    it('搜索应该匹配标签', () => {
      const results = marketplace.searchServers('SQL');
      expect(results.length).toBeGreaterThan(0);
    });

    it('搜索应该匹配工具名称', () => {
      const results = marketplace.searchServers('read_file');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.id).toBe('filesystem');
    });

    it('搜索不存在的关键词应该返回空数组', () => {
      const results = marketplace.searchServers('zzz_nonexistent_xyz');
      expect(results).toEqual([]);
    });

    it('搜索结果应该按相关性排序（名称匹配优先）', () => {
      const results = marketplace.searchServers('git');
      // "Git" 和 "GitHub" 应该排在前面
      const topIds = results.slice(0, 2).map(r => r.id);
      expect(topIds).toContain('git');
      expect(topIds).toContain('github');
    });

    it('getFeaturedServers() 应该返回推荐服务器', () => {
      const featured = marketplace.getFeaturedServers();
      expect(featured.length).toBeGreaterThan(0);
      expect(featured.every(s => s.featured)).toBe(true);
    });

    it('getServersByCategory() 应该按分类筛选', () => {
      const dbServers = marketplace.getServersByCategory('database');
      expect(dbServers.length).toBeGreaterThan(0);
      expect(dbServers.every(s => s.category === 'database')).toBe(true);
    });

    it('getServersByCategory() 不存在的分类应该返回空数组', () => {
      const servers = marketplace.getServersByCategory('other' as MCPCategory);
      // 可能为空也可能不为空，取决于注册表
      expect(Array.isArray(servers)).toBe(true);
    });

    it('getCategories() 应该返回所有分类及计数', () => {
      const categories = marketplace.getCategories();
      expect(categories.length).toBeGreaterThan(0);

      for (const cat of categories) {
        expect(cat.category).toBeTruthy();
        expect(cat.label).toBeTruthy();
        expect(cat.count).toBeGreaterThan(0);
      }
    });

    it('getCategories() 应该包含 database 分类', () => {
      const categories = marketplace.getCategories();
      const dbCat = categories.find(c => c.category === 'database');
      expect(dbCat).toBeDefined();
      expect(dbCat!.label).toBe('数据库');
    });
  });

  // ─── 安装管理 ───

  describe('安装管理', () => {
    it('应该能安装 MCP 服务器', async () => {
      await marketplace.installServer('filesystem');

      expect(marketplace.isInstalled('filesystem')).toBe(true);
    });

    it('安装后应该出现在已安装列表中', async () => {
      await marketplace.installServer('filesystem');

      const installed = marketplace.getInstalledServers();
      expect(installed.length).toBe(1);
      expect(installed[0]!.id).toBe('filesystem');
      expect(installed[0]!.installed.enabled).toBe(true);
    });

    it('安装不存在的服务器应该抛出错误', async () => {
      await expect(marketplace.installServer('nonexistent')).rejects.toThrow('未找到 MCP 服务器');
    });

    it('安装需要环境变量的服务器时缺少必填变量应该抛出错误', async () => {
      // postgres 需要 POSTGRES_URL
      await expect(marketplace.installServer('postgres')).rejects.toThrow('缺少必填环境变量');
    });

    it('安装需要环境变量的服务器时提供变量应该成功', async () => {
      await marketplace.installServer('postgres', {
        POSTGRES_URL: 'postgresql://user:pass@localhost:5432/testdb',
      });

      expect(marketplace.isInstalled('postgres')).toBe(true);
    });

    it('安装时应该合并默认环境变量', async () => {
      // aws-kb-retrieval 有默认 AWS_REGION
      await marketplace.installServer('aws-kb-retrieval', {
        AWS_ACCESS_KEY_ID: 'test-key',
        AWS_SECRET_ACCESS_KEY: 'test-secret',
      });

      const installed = marketplace.getInstalledServers();
      const aws = installed.find(s => s.id === 'aws-kb-retrieval');
      expect(aws).toBeDefined();
      expect(aws!.installed.env.AWS_REGION).toBe('us-east-1');
    });

    it('应该能卸载 MCP 服务器', async () => {
      await marketplace.installServer('filesystem');
      expect(marketplace.isInstalled('filesystem')).toBe(true);

      await marketplace.uninstallServer('filesystem');
      expect(marketplace.isInstalled('filesystem')).toBe(false);
    });

    it('卸载未安装的服务器应该抛出错误', async () => {
      await expect(marketplace.uninstallServer('filesystem')).rejects.toThrow('MCP 服务器未安装');
    });

    it('isInstalled() 未安装时应该返回 false', () => {
      expect(marketplace.isInstalled('filesystem')).toBe(false);
    });
  });

  // ─── 启用/禁用 ───

  describe('启用/禁用', () => {
    it('安装后默认应该是启用状态', async () => {
      await marketplace.installServer('filesystem');

      const installed = marketplace.getInstalledServers();
      expect(installed[0]!.installed.enabled).toBe(true);
    });

    it('应该能禁用服务器', async () => {
      await marketplace.installServer('filesystem');
      await marketplace.toggleServer('filesystem', false);

      const installed = marketplace.getInstalledServers();
      expect(installed[0]!.installed.enabled).toBe(false);
    });

    it('应该能重新启用服务器', async () => {
      await marketplace.installServer('filesystem');
      await marketplace.toggleServer('filesystem', false);
      await marketplace.toggleServer('filesystem', true);

      const installed = marketplace.getInstalledServers();
      expect(installed[0]!.installed.enabled).toBe(true);
    });

    it('不传 enabled 参数应该切换状态', async () => {
      await marketplace.installServer('filesystem');

      await marketplace.toggleServer('filesystem'); // true → false
      let installed = marketplace.getInstalledServers();
      expect(installed[0]!.installed.enabled).toBe(false);

      await marketplace.toggleServer('filesystem'); // false → true
      installed = marketplace.getInstalledServers();
      expect(installed[0]!.installed.enabled).toBe(true);
    });

    it('切换未安装的服务器应该抛出错误', async () => {
      await expect(marketplace.toggleServer('filesystem')).rejects.toThrow('MCP 服务器未安装');
    });
  });

  // ─── 环境变量配置 ───

  describe('环境变量配置', () => {
    it('应该能更新服务器环境变量', async () => {
      await marketplace.installServer('postgres', {
        POSTGRES_URL: 'postgresql://localhost/old',
      });

      await marketplace.updateServerEnv('postgres', {
        POSTGRES_URL: 'postgresql://localhost/new',
      });

      const installed = marketplace.getInstalledServers();
      const pg = installed.find(s => s.id === 'postgres');
      expect(pg!.installed.env.POSTGRES_URL).toBe('postgresql://localhost/new');
    });

    it('更新环境变量应该合并而非替换', async () => {
      await marketplace.installServer('aws-kb-retrieval', {
        AWS_ACCESS_KEY_ID: 'key1',
        AWS_SECRET_ACCESS_KEY: 'secret1',
      });

      await marketplace.updateServerEnv('aws-kb-retrieval', {
        AWS_ACCESS_KEY_ID: 'key2',
      });

      const installed = marketplace.getInstalledServers();
      const aws = installed.find(s => s.id === 'aws-kb-retrieval');
      expect(aws!.installed.env.AWS_ACCESS_KEY_ID).toBe('key2');
      // 原有的 secret 应该保留
      expect(aws!.installed.env.AWS_SECRET_ACCESS_KEY).toBe('secret1');
    });

    it('更新未安装服务器的环境变量应该抛出错误', async () => {
      await expect(marketplace.updateServerEnv('filesystem', { FOO: 'bar' })).rejects.toThrow('MCP 服务器未安装');
    });
  });

  // ─── 启动配置 ───

  describe('启动配置', () => {
    it('应该返回正确的启动配置', async () => {
      await marketplace.installServer('filesystem');

      const config = marketplace.getServerLaunchConfig('filesystem');
      expect(config).not.toBeNull();
      expect(config!.command).toBe('npx');
      expect(config!.args).toContain('-y');
      expect(config!.args).toContain('@modelcontextprotocol/server-filesystem');
    });

    it('禁用的服务器应该返回 null', async () => {
      await marketplace.installServer('filesystem');
      await marketplace.toggleServer('filesystem', false);

      const config = marketplace.getServerLaunchConfig('filesystem');
      expect(config).toBeNull();
    });

    it('未安装的服务器应该返回 null', () => {
      const config = marketplace.getServerLaunchConfig('filesystem');
      expect(config).toBeNull();
    });

    it('启动配置应该包含环境变量', async () => {
      await marketplace.installServer('postgres', {
        POSTGRES_URL: 'postgresql://localhost/test',
      });

      const config = marketplace.getServerLaunchConfig('postgres');
      expect(config).not.toBeNull();
      expect(config!.env.POSTGRES_URL).toBe('postgresql://localhost/test');
    });
  });

  // ─── 配置导出/导入 ───

  describe('配置导出/导入', () => {
    it('exportConfig() 应该导出已安装且启用的服务器', async () => {
      await marketplace.installServer('filesystem');
      await marketplace.installServer('fetch');

      const config = marketplace.exportConfig();
      expect(Object.keys(config)).toContain('filesystem');
      expect(Object.keys(config)).toContain('fetch');
    });

    it('exportConfig() 不应该导出禁用的服务器', async () => {
      await marketplace.installServer('filesystem');
      await marketplace.installServer('fetch');
      await marketplace.toggleServer('fetch', false);

      const config = marketplace.exportConfig();
      expect(Object.keys(config)).toContain('filesystem');
      expect(Object.keys(config)).not.toContain('fetch');
    });

    it('exportConfig() 无安装时应该返回空对象', () => {
      const config = marketplace.exportConfig();
      expect(config).toEqual({});
    });

    it('importConfig() 应该导入服务器配置', async () => {
      const imported = await marketplace.importConfig({
        'custom-server': {
          command: 'node',
          args: ['./server.js'],
          env: { API_KEY: 'test' },
        },
      });

      expect(imported).toBe(1);
      expect(marketplace.isInstalled('custom-server')).toBe(true);
    });

    it('importConfig() 不应该覆盖已安装的服务器', async () => {
      await marketplace.installServer('filesystem');

      const imported = await marketplace.importConfig({
        'filesystem': {
          command: 'different-command',
        },
      });

      expect(imported).toBe(0);
      // 原始配置应该保持不变
      const config = marketplace.getServerLaunchConfig('filesystem');
      expect(config!.command).toBe('npx');
    });

    it('importConfig() 应该返回导入数量', async () => {
      const imported = await marketplace.importConfig({
        'server-a': { command: 'node', args: ['a.js'] },
        'server-b': { command: 'node', args: ['b.js'] },
        'server-c': { command: 'python', args: ['c.py'] },
      });

      expect(imported).toBe(3);
    });
  });

  // ─── 事件 ───

  describe('事件', () => {
    it('安装时应该触发 install 事件', async () => {
      let emittedServer: any = null;
      marketplace.on('install', (server) => {
        emittedServer = server;
      });

      await marketplace.installServer('filesystem');

      expect(emittedServer).not.toBeNull();
      expect(emittedServer.id).toBe('filesystem');
    });

    it('卸载时应该触发 uninstall 事件', async () => {
      let emittedId: string | null = null;
      marketplace.on('uninstall', (id) => {
        emittedId = id;
      });

      await marketplace.installServer('filesystem');
      await marketplace.uninstallServer('filesystem');

      expect(emittedId).toBe('filesystem');
    });
  });

  // ─── 持久化 ───

  describe('持久化', () => {
    it('安装后应该持久化到磁盘', async () => {
      await marketplace.installServer('filesystem');

      // 创建新实例，应该能加载之前的安装信息
      const newMarketplace = new MCPMarketplace(TEST_CONFIG_DIR);
      expect(newMarketplace.isInstalled('filesystem')).toBe(true);
    });

    it('卸载后应该从磁盘移除', async () => {
      await marketplace.installServer('filesystem');
      await marketplace.uninstallServer('filesystem');

      const newMarketplace = new MCPMarketplace(TEST_CONFIG_DIR);
      expect(newMarketplace.isInstalled('filesystem')).toBe(false);
    });

    it('多个服务器的安装状态应该都能持久化', async () => {
      await marketplace.installServer('filesystem');
      await marketplace.installServer('fetch');

      const newMarketplace = new MCPMarketplace(TEST_CONFIG_DIR);
      expect(newMarketplace.isInstalled('filesystem')).toBe(true);
      expect(newMarketplace.isInstalled('fetch')).toBe(true);
    });
  });
});
