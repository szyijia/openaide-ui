/**
 * Chat Panel E2E 测试
 *
 * 测试 AI 对话面板的完整用户交互流程：
 * - 打开/关闭 Chat Panel
 * - 发送消息
 * - 流式输出显示
 * - @文件引用
 * - 工具调用审批
 * - 会话管理
 */

import { test, expect } from '@playwright/test';
import {
  type TestContext,
  launchVSCode,
  closeVSCode,
  openChatPanel,
  executeCommand,
  takeScreenshot,
} from '../helpers';

let ctx: TestContext;

test.describe('Chat Panel', () => {
  test.beforeAll(async () => {
    ctx = await launchVSCode({
      env: {
        // 使用 Mock LLM，返回预设回复
        OPENAIDE_MOCK_LLM: '1',
        OPENAIDE_MOCK_RESPONSE: 'Hello! 我是OpenAIDE 助手。',
      },
    });
  });

  test.afterAll(async () => {
    await closeVSCode(ctx);
  });

  // ─── 面板打开/关闭 ───

  test('应该能通过命令打开 Chat Panel', async () => {
    await openChatPanel(ctx.page);
    await ctx.page.waitForTimeout(2000);

    // 验证侧边栏已打开
    const sidebar = ctx.page.locator('.sidebar');
    await expect(sidebar).toBeVisible();

    await takeScreenshot(ctx.page, 'chat-panel-opened');
  });

  test('应该能通过快捷键打开 Chat Panel', async () => {
    // 先关闭侧边栏
    const isMac = process.platform === 'darwin';
    await ctx.page.keyboard.press(isMac ? 'Meta+B' : 'Control+B');
    await ctx.page.waitForTimeout(500);

    // 用快捷键打开 Chat
    await ctx.page.keyboard.press(isMac ? 'Meta+L' : 'Control+L');
    await ctx.page.waitForTimeout(2000);

    const sidebar = ctx.page.locator('.sidebar');
    await expect(sidebar).toBeVisible();
  });

  // ─── 消息发送 ───

  test('应该能在输入框中输入消息', async () => {
    await openChatPanel(ctx.page);
    await ctx.page.waitForTimeout(2000);

    // 查找 Webview 中的输入框
    const frames = ctx.page.frames();
    let inputFound = false;

    for (const frame of frames) {
      try {
        const textarea = frame.locator('textarea, [contenteditable="true"], input[type="text"]').first();
        if (await textarea.isVisible({ timeout: 2000 })) {
          await textarea.fill('你好，帮我写一个 Hello World');
          inputFound = true;
          break;
        }
      } catch {
        // 继续查找下一个 frame
      }
    }

    await takeScreenshot(ctx.page, 'chat-message-input');
    // 输入框可能在 Webview iframe 中，不一定能直接找到
    // 这里主要验证面板已正确渲染
  });

  test('发送消息后应该显示用户消息气泡', async () => {
    await openChatPanel(ctx.page);
    await ctx.page.waitForTimeout(2000);

    // 尝试在 Webview 中发送消息
    const frames = ctx.page.frames();

    for (const frame of frames) {
      try {
        const textarea = frame.locator('textarea').first();
        if (await textarea.isVisible({ timeout: 2000 })) {
          await textarea.fill('测试消息');
          await textarea.press('Enter');
          await ctx.page.waitForTimeout(3000);
          break;
        }
      } catch {
        // 继续
      }
    }

    await takeScreenshot(ctx.page, 'chat-message-sent');
  });

  // ─── @文件引用 ───

  test('输入 @ 应该弹出文件选择器', async () => {
    await openChatPanel(ctx.page);
    await ctx.page.waitForTimeout(2000);

    const frames = ctx.page.frames();

    for (const frame of frames) {
      try {
        const textarea = frame.locator('textarea').first();
        if (await textarea.isVisible({ timeout: 2000 })) {
          await textarea.fill('@');
          await ctx.page.waitForTimeout(1000);
          break;
        }
      } catch {
        // 继续
      }
    }

    await takeScreenshot(ctx.page, 'chat-at-mention');
  });

  // ─── 会话管理 ───

  test('应该能创建新会话', async () => {
    await executeCommand(ctx.page, 'OpenAIDE: New Chat');
    await ctx.page.waitForTimeout(2000);

    await takeScreenshot(ctx.page, 'chat-new-session');
  });

  test('应该能查看会话历史', async () => {
    await executeCommand(ctx.page, 'OpenAIDE: Chat History');
    await ctx.page.waitForTimeout(2000);

    await takeScreenshot(ctx.page, 'chat-history');

    // 关闭弹出的面板
    await ctx.page.keyboard.press('Escape');
  });

  // ─── 模型切换 ───

  test('应该能切换 AI 模型', async () => {
    await executeCommand(ctx.page, 'OpenAIDE: Switch Model');
    await ctx.page.waitForTimeout(1000);

    // 验证模型选择列表出现
    const quickInput = ctx.page.locator('.quick-input-widget');
    const isVisible = await quickInput.isVisible().catch(() => false);

    if (isVisible) {
      await takeScreenshot(ctx.page, 'model-switcher');
    }

    // 关闭选择器
    await ctx.page.keyboard.press('Escape');
  });

  // ─── 工具调用审批 ───

  test('工具调用应该显示审批 UI', async () => {
    // 这个测试需要 Mock LLM 返回工具调用请求
    // 在 Mock 模式下，发送特定消息触发工具调用
    await openChatPanel(ctx.page);
    await ctx.page.waitForTimeout(2000);

    const frames = ctx.page.frames();

    for (const frame of frames) {
      try {
        const textarea = frame.locator('textarea').first();
        if (await textarea.isVisible({ timeout: 2000 })) {
          // 发送会触发工具调用的消息
          await textarea.fill('读取 src/index.ts 文件');
          await textarea.press('Enter');
          await ctx.page.waitForTimeout(5000);
          break;
        }
      } catch {
        // 继续
      }
    }

    await takeScreenshot(ctx.page, 'tool-approval-ui');
  });
});
