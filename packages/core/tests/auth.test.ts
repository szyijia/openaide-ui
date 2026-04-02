/**
 * AuthService 单元测试
 *
 * 测试覆盖：
 * - API Key 加密存储和解密读取
 * - API Key CRUD 操作
 * - 用量记录和统计
 * - 配额检查和重置
 * - 认证状态管理
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuthService } from '../src/auth/service.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// AuthService 使用 ~/.openaide/auth/ 目录存储数据
const AUTH_DIR = path.join(os.homedir(), '.openaide', 'auth');

describe('AuthService', () => {
  let auth: AuthService;

  beforeEach(async () => {
    // 清理 auth 目录，确保每个测试从干净状态开始
    try {
      await fs.rm(AUTH_DIR, { recursive: true, force: true });
    } catch {
      // 目录不存在，忽略
    }
    auth = new AuthService();
    // init 会创建目录并加载状态（首次为空）
    await auth.init();
  });

  afterEach(async () => {
    try {
      await fs.rm(AUTH_DIR, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  });

  // ─── API Key 管理 ───

  describe('API Key 管理', () => {
    it('应该成功添加 API Key', async () => {
      const entry = await auth.addApiKey('anthropic', 'sk-ant-test-key-12345678', 'My Claude Key');

      expect(entry.id).toBeTruthy();
      expect(entry.provider).toBe('anthropic');
      expect(entry.label).toBe('My Claude Key');
      expect(entry.maskedKey).toContain('****');
      expect(entry.maskedKey).toContain('sk-a');
      expect(entry.encryptedKey).not.toBe('sk-ant-test-key-12345678');
      expect(entry.isDefault).toBe(true);
    });

    it('第一个 Key 应该自动设为默认', async () => {
      const entry1 = await auth.addApiKey('openai', 'sk-openai-key-1');
      expect(entry1.isDefault).toBe(true);
    });

    it('同 Provider 的第二个 Key 不应该是默认', async () => {
      await auth.addApiKey('openai', 'sk-openai-key-1');
      const entry2 = await auth.addApiKey('openai', 'sk-openai-key-2', 'Backup Key');
      expect(entry2.isDefault).toBe(false);
    });

    it('应该能解密读取 API Key', async () => {
      await auth.addApiKey('deepseek', 'sk-deepseek-test-key');
      const key = auth.getApiKey('deepseek');
      expect(key).toBe('sk-deepseek-test-key');
    });

    it('获取不存在的 Provider Key 应返回 null', () => {
      const key = auth.getApiKey('nonexistent');
      expect(key).toBeNull();
    });

    it('应该能列出指定 Provider 的所有 Key', async () => {
      await auth.addApiKey('openai', 'sk-key-1', 'Key 1');
      await auth.addApiKey('openai', 'sk-key-2', 'Key 2');
      await auth.addApiKey('anthropic', 'sk-ant-key', 'Claude Key');

      const openaiKeys = auth.getApiKeys('openai');
      expect(openaiKeys).toHaveLength(2);

      const allKeys = auth.getApiKeys();
      expect(allKeys).toHaveLength(3);
    });

    it('应该能删除 API Key', async () => {
      const entry = await auth.addApiKey('openai', 'sk-to-delete');
      expect(auth.getApiKeys('openai')).toHaveLength(1);

      const deleted = await auth.removeApiKey(entry.id);
      expect(deleted).toBe(true);
      expect(auth.getApiKeys('openai')).toHaveLength(0);
    });

    it('删除不存在的 Key 应返回 false', async () => {
      const deleted = await auth.removeApiKey('nonexistent-id');
      expect(deleted).toBe(false);
    });

    it('应该能切换默认 API Key', async () => {
      const entry1 = await auth.addApiKey('openai', 'sk-key-1');
      const entry2 = await auth.addApiKey('openai', 'sk-key-2');

      expect(entry1.isDefault).toBe(true);
      expect(entry2.isDefault).toBe(false);

      await auth.setDefaultApiKey(entry2.id);

      const keys = auth.getApiKeys('openai');
      const key1 = keys.find(k => k.id === entry1.id);
      const key2 = keys.find(k => k.id === entry2.id);
      expect(key1!.isDefault).toBe(false);
      expect(key2!.isDefault).toBe(true);
    });

    it('设置不存在的 Key 为默认应返回 false', async () => {
      const result = await auth.setDefaultApiKey('nonexistent');
      expect(result).toBe(false);
    });

    it('应该正确生成环境变量映射', async () => {
      await auth.addApiKey('anthropic', 'sk-ant-xxx');
      await auth.addApiKey('openai', 'sk-openai-xxx');

      const envMap = auth.getApiKeyEnvMap();
      expect(envMap.ANTHROPIC_API_KEY).toBe('sk-ant-xxx');
      expect(envMap.OPENAI_API_KEY).toBe('sk-openai-xxx');
    });

    it('API Key 掩码应该正确显示', async () => {
      const entry = await auth.addApiKey('anthropic', 'sk-ant-api03-abcdefghijklmnop');
      // 前 4 位 + **** + 后 4 位
      expect(entry.maskedKey).toBe('sk-a****mnop');
    });
  });

  // ─── 用量统计 ───

  describe('用量统计', () => {
    it('应该记录 API 调用用量', async () => {
      await auth.recordUsage('claude-sonnet-4', 1000, 500, 0.015);

      const today = auth.getTodayUsage();
      expect(today.requests).toBe(1);
      expect(today.tokens).toBe(1500);
      expect(today.costUSD).toBeCloseTo(0.015);
    });

    it('同一天同一模型的用量应该累加', async () => {
      await auth.recordUsage('gpt-4o', 500, 200, 0.01);
      await auth.recordUsage('gpt-4o', 800, 300, 0.02);

      const today = auth.getTodayUsage();
      expect(today.requests).toBe(2);
      expect(today.tokens).toBe(1800);
      expect(today.costUSD).toBeCloseTo(0.03);
    });

    it('不同模型的用量应该分别记录', async () => {
      await auth.recordUsage('claude-sonnet-4', 1000, 500, 0.015);
      await auth.recordUsage('gpt-4o', 800, 300, 0.02);

      const history = auth.getUsageHistory(1);
      expect(history).toHaveLength(2);
    });

    it('应该能获取历史用量', async () => {
      await auth.recordUsage('claude-sonnet-4', 1000, 500, 0.015);

      const history = auth.getUsageHistory(30);
      expect(history.length).toBeGreaterThan(0);
      expect(history[0]!.model).toBe('claude-sonnet-4');
    });
  });

  // ─── 配额管理 ───

  describe('配额管理', () => {
    it('默认配额应该不限制', () => {
      const quota = auth.getQuota();
      expect(quota.dailyRequestLimit).toBe(0);
      expect(quota.dailyTokenLimit).toBe(0);
      expect(quota.monthlyBudgetUSD).toBe(0);
    });

    it('未设置限制时不应超出配额', () => {
      const result = auth.isOverQuota();
      expect(result.exceeded).toBe(false);
    });

    it('应该能更新配额设置', async () => {
      await auth.updateQuota({
        dailyRequestLimit: 100,
        dailyTokenLimit: 1000000,
        monthlyBudgetUSD: 50,
      });

      const quota = auth.getQuota();
      expect(quota.dailyRequestLimit).toBe(100);
      expect(quota.dailyTokenLimit).toBe(1000000);
      expect(quota.monthlyBudgetUSD).toBe(50);
    });

    it('超出请求限制时应该报告', async () => {
      await auth.updateQuota({ dailyRequestLimit: 2 });

      await auth.recordUsage('test', 100, 50, 0.01);
      expect(auth.isOverQuota().exceeded).toBe(false);

      await auth.recordUsage('test', 100, 50, 0.01);
      expect(auth.isOverQuota().exceeded).toBe(true);
      expect(auth.isOverQuota().reason).toContain('请求上限');
    });

    it('超出 Token 限制时应该报告', async () => {
      await auth.updateQuota({ dailyTokenLimit: 200 });

      await auth.recordUsage('test', 100, 50, 0.01);
      expect(auth.isOverQuota().exceeded).toBe(false);

      await auth.recordUsage('test', 100, 50, 0.01);
      expect(auth.isOverQuota().exceeded).toBe(true);
      expect(auth.isOverQuota().reason).toContain('Token 上限');
    });

    it('超出月度预算时应该报告', async () => {
      await auth.updateQuota({ monthlyBudgetUSD: 0.02 });

      await auth.recordUsage('test', 100, 50, 0.015);
      expect(auth.isOverQuota().exceeded).toBe(false);

      await auth.recordUsage('test', 100, 50, 0.01);
      expect(auth.isOverQuota().exceeded).toBe(true);
      expect(auth.isOverQuota().reason).toContain('预算上限');
    });
  });

  // ─── 认证状态 ───

  describe('认证状态', () => {
    it('初始状态应该未认证', () => {
      expect(auth.isAuthenticated()).toBe(false);
      expect(auth.getUser()).toBeNull();
    });

    it('认证状态应该包含完整信息', () => {
      const state = auth.getAuthState();
      expect(state.isAuthenticated).toBe(false);
      expect(state.user).toBeUndefined();
    });

    it('登出应该清除认证状态', async () => {
      await auth.logout();
      expect(auth.isAuthenticated()).toBe(false);
      expect(auth.getUser()).toBeNull();
    });
  });
});
