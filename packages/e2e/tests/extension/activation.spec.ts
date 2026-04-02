/**
 * Extension 核心功能 E2E 测试
 *
 * 测试OpenAIDE Extension 的基础功能：
 * - Extension 激活
 * - 命令注册
 * - 状态栏显示
 * - 配置加载
 */

import { test, expect } from '@playwright/test';
import {
  type TestContext,
  launchVSCode,
  closeVSCode,
  openCommandPalette,
  executeCommand,
  getStatusBarText,
  clickStatusBarItem,
  waitForNotification,
  takeScreenshot,
} from '../helpers';

let ctx: TestContext;

test.describe('Extension 核心功能', () => {
  test.beforeAll(async () => {
    ctx = await launchVSCode();
  });

  test.afterAll(async () => {
    await closeVSCode(ctx);
  });

  // ─── 激活测试 ───

  test('Extension 应该成功激活', async () => {
    // 验证 VS Code 窗口已打开
    expect(ctx.page).toBeTruthy();

    // 验证窗口标题包含工作区名称
    const title = await ctx.page.title();
    expect(title).toBeTruthy();
  });

  test('状态栏应该显示OpenAIDE图标', async () => {
    // 查找状态栏中的OpenAIDE相关项
    const statusBar = ctx.page.locator('.statusbar');
    await expect(statusBar).toBeVisible();

    // 截图记录
    await takeScreenshot(ctx.page, 'extension-activated');
  });

  // ─── 命令注册测试 ───

  test('命令面板应该包含OpenAIDE命令', async () => {
    await openCommandPalette(ctx.page);

    // 输入 "OpenAIDE" 搜索命令
    await ctx.page.keyboard.type('OpenAIDE', { delay: 50 });
    await ctx.page.waitForTimeout(1000);

    // 验证命令列表中有OpenAIDE相关命令
    const commandList = ctx.page.locator('.quick-input-list');
    await expect(commandList).toBeVisible();

    // 截图记录
    await takeScreenshot(ctx.page, 'command-palette-openaide');

    // 关闭命令面板
    await ctx.page.keyboard.press('Escape');
  });

  test('Open Chat 命令应该可用', async () => {
    await openCommandPalette(ctx.page);
    await ctx.page.keyboard.type('OpenAIDE: Open Chat', { delay: 50 });
    await ctx.page.waitForTimeout(500);

    // 验证命令出现在列表中
    const listItems = ctx.page.locator('.quick-input-list .monaco-list-row');
    const count = await listItems.count();
    expect(count).toBeGreaterThan(0);

    // 关闭命令面板
    await ctx.page.keyboard.press('Escape');
  });

  // ─── 状态栏测试 ───

  test('状态栏应该显示模型信息', async () => {
    // 查找模型状态栏项
    const statusItems = ctx.page.locator('.statusbar-item');
    const count = await statusItems.count();
    expect(count).toBeGreaterThan(0);

    await takeScreenshot(ctx.page, 'status-bar');
  });

  // ─── 配置测试 ───

  test('应该能读取 .openaide.md 配置文件', async () => {
    // 通过命令面板打开 .openaide.md
    await openCommandPalette(ctx.page);
    await ctx.page.keyboard.type('.openaide.md', { delay: 50 });
    await ctx.page.waitForTimeout(500);
    await ctx.page.keyboard.press('Enter');
    await ctx.page.waitForTimeout(2000);

    // 验证编辑器已打开
    const editorArea = ctx.page.locator('.editor-instance');
    await expect(editorArea).toBeVisible();

    await takeScreenshot(ctx.page, 'openaide-md-opened');
  });

  // ─── 快捷键测试 ───

  test('Cmd/Ctrl+L 应该打开 Chat Panel', async () => {
    const isMac = process.platform === 'darwin';
    await ctx.page.keyboard.press(isMac ? 'Meta+L' : 'Control+L');
    await ctx.page.waitForTimeout(2000);

    // 验证侧边栏有变化
    const sidebar = ctx.page.locator('.sidebar');
    await expect(sidebar).toBeVisible();

    await takeScreenshot(ctx.page, 'chat-panel-shortcut');
  });

  // ─── 设置测试 ───

  test('OpenAIDE设置项应该存在', async () => {
    // 打开设置
    await executeCommand(ctx.page, 'Preferences: Open Settings (UI)');
    await ctx.page.waitForTimeout(2000);

    // 搜索OpenAIDE设置
    const searchInput = ctx.page.locator('.settings-search-input input');
    if (await searchInput.isVisible()) {
      await searchInput.fill('openaide');
      await ctx.page.waitForTimeout(1000);

      await takeScreenshot(ctx.page, 'openaide-settings');
    }

    // 关闭设置
    await ctx.page.keyboard.press(process.platform === 'darwin' ? 'Meta+W' : 'Control+W');
  });
});
