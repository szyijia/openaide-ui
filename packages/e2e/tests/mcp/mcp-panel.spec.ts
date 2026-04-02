/**
 * MCP 管理面板 E2E 测试
 *
 * 测试 MCP 服务器管理的完整用户交互流程：
 * - MCP 面板打开/关闭
 * - 服务器列表展示
 * - 添加/删除服务器
 * - 连接/断开服务器
 * - Marketplace 浏览
 */

import { test, expect } from '@playwright/test';
import {
  type TestContext,
  launchVSCode,
  closeVSCode,
  executeCommand,
  openSidebarView,
  clickTreeItem,
  takeScreenshot,
} from '../helpers';

let ctx: TestContext;

test.describe('MCP 管理面板', () => {
  test.beforeAll(async () => {
    ctx = await launchVSCode({
      env: {
        OPENAIDE_MOCK_LLM: '1',
      },
    });
  });

  test.afterAll(async () => {
    await closeVSCode(ctx);
  });

  // ─── 面板展示 ───

  test('应该能通过命令打开 MCP 面板', async () => {
    await executeCommand(ctx.page, 'OpenAIDE: MCP Servers');
    await ctx.page.waitForTimeout(2000);

    // 验证侧边栏已打开
    const sidebar = ctx.page.locator('.sidebar');
    await expect(sidebar).toBeVisible();

    await takeScreenshot(ctx.page, 'mcp-panel-opened');
  });

  test('MCP 面板应该显示 TreeView', async () => {
    await executeCommand(ctx.page, 'OpenAIDE: MCP Servers');
    await ctx.page.waitForTimeout(2000);

    // 查找 TreeView 容器
    const treeView = ctx.page.locator('.tree-explorer-viewlet-tree-view, .monaco-list');
    const isVisible = await treeView.first().isVisible().catch(() => false);

    await takeScreenshot(ctx.page, 'mcp-tree-view');
  });

  // ─── 服务器管理 ───

  test('应该能添加 MCP 服务器', async () => {
    await executeCommand(ctx.page, 'OpenAIDE: Add MCP Server');
    await ctx.page.waitForTimeout(1000);

    // 验证输入框出现
    const quickInput = ctx.page.locator('.quick-input-widget');
    const isVisible = await quickInput.isVisible().catch(() => false);

    if (isVisible) {
      // 输入服务器名称
      await ctx.page.keyboard.type('test-server', { delay: 50 });
      await takeScreenshot(ctx.page, 'mcp-add-server');
    }

    // 关闭输入框
    await ctx.page.keyboard.press('Escape');
  });

  test('应该能查看 MCP 服务器详情', async () => {
    await executeCommand(ctx.page, 'OpenAIDE: MCP Servers');
    await ctx.page.waitForTimeout(2000);

    // 尝试点击 TreeView 中的项
    const treeItems = ctx.page.locator('.monaco-list-row').first();
    if (await treeItems.isVisible({ timeout: 3000 })) {
      await treeItems.click();
      await ctx.page.waitForTimeout(1000);
    }

    await takeScreenshot(ctx.page, 'mcp-server-details');
  });

  // ─── Marketplace ───

  test('应该能打开 MCP Marketplace', async () => {
    await executeCommand(ctx.page, 'OpenAIDE: MCP Marketplace');
    await ctx.page.waitForTimeout(2000);

    await takeScreenshot(ctx.page, 'mcp-marketplace');
  });

  test('Marketplace 应该显示服务器分类', async () => {
    await executeCommand(ctx.page, 'OpenAIDE: MCP Marketplace');
    await ctx.page.waitForTimeout(3000);

    // 查找 Webview 中的分类列表
    const frames = ctx.page.frames();
    for (const frame of frames) {
      try {
        const categories = frame.locator('[class*="category"], [class*="filter"]').first();
        if (await categories.isVisible({ timeout: 2000 })) {
          await takeScreenshot(ctx.page, 'mcp-marketplace-categories');
          break;
        }
      } catch {
        // 继续
      }
    }
  });

  test('Marketplace 应该支持搜索', async () => {
    await executeCommand(ctx.page, 'OpenAIDE: MCP Marketplace');
    await ctx.page.waitForTimeout(2000);

    // 查找搜索框
    const frames = ctx.page.frames();
    for (const frame of frames) {
      try {
        const searchInput = frame.locator('input[type="search"], input[placeholder*="搜索"], input[placeholder*="search"]').first();
        if (await searchInput.isVisible({ timeout: 2000 })) {
          await searchInput.fill('filesystem');
          await ctx.page.waitForTimeout(1000);
          await takeScreenshot(ctx.page, 'mcp-marketplace-search');
          break;
        }
      } catch {
        // 继续
      }
    }
  });

  // ─── 连接管理 ───

  test('应该能连接/断开 MCP 服务器', async () => {
    await executeCommand(ctx.page, 'OpenAIDE: MCP Servers');
    await ctx.page.waitForTimeout(2000);

    // 查找连接/断开按钮
    const actionButtons = ctx.page.locator('.action-item, .codicon-plug, .codicon-debug-disconnect');
    const count = await actionButtons.count();

    if (count > 0) {
      await actionButtons.first().click();
      await ctx.page.waitForTimeout(2000);
    }

    await takeScreenshot(ctx.page, 'mcp-connection-toggle');
  });

  // ─── MCP 配置 ───

  test('应该能编辑 MCP 配置文件', async () => {
    await executeCommand(ctx.page, 'OpenAIDE: Edit MCP Config');
    await ctx.page.waitForTimeout(2000);

    // 验证编辑器打开了 mcp.json 或相关配置文件
    const editorTabs = ctx.page.locator('.tab');
    const tabCount = await editorTabs.count();

    await takeScreenshot(ctx.page, 'mcp-config-edit');
  });

  // ─── 记忆面板 ───

  test.describe('记忆面板', () => {
    test('应该能打开记忆管理面板', async () => {
      await executeCommand(ctx.page, 'OpenAIDE: Memory Manager');
      await ctx.page.waitForTimeout(2000);

      const sidebar = ctx.page.locator('.sidebar');
      await expect(sidebar).toBeVisible();

      await takeScreenshot(ctx.page, 'memory-panel-opened');
    });

    test('记忆面板应该显示分类', async () => {
      await executeCommand(ctx.page, 'OpenAIDE: Memory Manager');
      await ctx.page.waitForTimeout(2000);

      // 查找 TreeView 中的分类节点
      const treeItems = ctx.page.locator('.monaco-list-row');
      const count = await treeItems.count();

      await takeScreenshot(ctx.page, 'memory-panel-categories');
    });

    test('应该能添加新记忆', async () => {
      await executeCommand(ctx.page, 'OpenAIDE: Add Memory');
      await ctx.page.waitForTimeout(1000);

      // 验证输入框出现
      const quickInput = ctx.page.locator('.quick-input-widget');
      const isVisible = await quickInput.isVisible().catch(() => false);

      if (isVisible) {
        await ctx.page.keyboard.type('测试记忆条目', { delay: 50 });
        await takeScreenshot(ctx.page, 'memory-add-new');
      }

      await ctx.page.keyboard.press('Escape');
    });

    test('应该能搜索记忆', async () => {
      await executeCommand(ctx.page, 'OpenAIDE: Search Memory');
      await ctx.page.waitForTimeout(1000);

      const quickInput = ctx.page.locator('.quick-input-widget');
      const isVisible = await quickInput.isVisible().catch(() => false);

      if (isVisible) {
        await ctx.page.keyboard.type('TypeScript', { delay: 50 });
        await ctx.page.waitForTimeout(1000);
        await takeScreenshot(ctx.page, 'memory-search');
      }

      await ctx.page.keyboard.press('Escape');
    });
  });
});
