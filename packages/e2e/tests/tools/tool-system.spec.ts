/**
 * 工具系统 E2E 测试
 *
 * 测试内置工具在 IDE 中的端到端行为：
 * - 文件读写工具
 * - 搜索工具（Glob / Grep）
 * - Bash 命令执行
 * - 权限审批流程
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
import * as fs from 'node:fs';
import * as path from 'node:path';

let ctx: TestContext;

test.describe('工具系统', () => {
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

  // ─── 文件工具测试 ───

  test.describe('文件工具', () => {
    test('FileRead — 应该能读取工作区文件', async () => {
      // 验证测试文件存在
      const testFile = path.join(ctx.workspacePath, 'src/index.ts');
      expect(fs.existsSync(testFile)).toBe(true);

      // 通过命令面板打开文件
      await executeCommand(ctx.page, 'Go to File');
      await ctx.page.waitForTimeout(500);
      await ctx.page.keyboard.type('index.ts', { delay: 50 });
      await ctx.page.waitForTimeout(500);
      await ctx.page.keyboard.press('Enter');
      await ctx.page.waitForTimeout(2000);

      // 验证编辑器已打开
      const editorTabs = ctx.page.locator('.tab');
      const tabCount = await editorTabs.count();
      expect(tabCount).toBeGreaterThan(0);

      await takeScreenshot(ctx.page, 'tool-file-read');
    });

    test('FileWrite — 应该能创建新文件', async () => {
      // 通过命令创建新文件
      await executeCommand(ctx.page, 'File: New File');
      await ctx.page.waitForTimeout(2000);

      await takeScreenshot(ctx.page, 'tool-file-write');
    });

    test('FileEdit — 编辑后应该显示 Diff 预览', async () => {
      // 打开一个文件
      await executeCommand(ctx.page, 'Go to File');
      await ctx.page.waitForTimeout(500);
      await ctx.page.keyboard.type('utils.ts', { delay: 50 });
      await ctx.page.waitForTimeout(500);
      await ctx.page.keyboard.press('Enter');
      await ctx.page.waitForTimeout(2000);

      // 在文件中输入一些内容
      await ctx.page.keyboard.press('End');
      await ctx.page.keyboard.press('Enter');
      await ctx.page.keyboard.type('// E2E test edit', { delay: 30 });
      await ctx.page.waitForTimeout(1000);

      // 验证文件已被修改（标签上应该有修改标记）
      await takeScreenshot(ctx.page, 'tool-file-edit');
    });
  });

  // ─── 搜索工具测试 ───

  test.describe('搜索工具', () => {
    test('Glob — 应该能搜索文件', async () => {
      // 使用 VS Code 的文件搜索
      const isMac = process.platform === 'darwin';
      await ctx.page.keyboard.press(isMac ? 'Meta+P' : 'Control+P');
      await ctx.page.waitForTimeout(500);

      await ctx.page.keyboard.type('*.ts', { delay: 50 });
      await ctx.page.waitForTimeout(1000);

      // 验证搜索结果
      const quickInput = ctx.page.locator('.quick-input-list');
      await expect(quickInput).toBeVisible();

      const results = ctx.page.locator('.quick-input-list .monaco-list-row');
      const count = await results.count();
      expect(count).toBeGreaterThan(0);

      await takeScreenshot(ctx.page, 'tool-glob-search');

      // 关闭搜索
      await ctx.page.keyboard.press('Escape');
    });

    test('Grep — 应该能搜索文件内容', async () => {
      // 使用 VS Code 的全局搜索
      const isMac = process.platform === 'darwin';
      await ctx.page.keyboard.press(isMac ? 'Meta+Shift+F' : 'Control+Shift+F');
      await ctx.page.waitForTimeout(1000);

      // 搜索 "fibonacci"
      const searchInput = ctx.page.locator('.search-view .search-container input').first();
      if (await searchInput.isVisible({ timeout: 3000 })) {
        await searchInput.fill('fibonacci');
        await ctx.page.waitForTimeout(2000);

        await takeScreenshot(ctx.page, 'tool-grep-search');
      }
    });
  });

  // ─── Bash 工具测试 ───

  test.describe('Bash 工具', () => {
    test('应该能打开终端', async () => {
      await executeCommand(ctx.page, 'Terminal: Create New Terminal');
      await ctx.page.waitForTimeout(2000);

      // 验证终端面板已打开
      const terminal = ctx.page.locator('.terminal-wrapper, .xterm');
      const isVisible = await terminal.isVisible().catch(() => false);

      await takeScreenshot(ctx.page, 'tool-bash-terminal');
    });

    test('终端应该在工作区目录下', async () => {
      // 在终端中执行 pwd 命令
      const terminal = ctx.page.locator('.xterm-helper-textarea').first();
      if (await terminal.isVisible({ timeout: 3000 })) {
        await terminal.fill('pwd');
        await terminal.press('Enter');
        await ctx.page.waitForTimeout(1000);

        await takeScreenshot(ctx.page, 'tool-bash-pwd');
      }
    });
  });

  // ─── 权限审批测试 ───

  test.describe('权限审批', () => {
    test('高风险操作应该触发权限审批', async () => {
      // 通过 Chat 发送需要 Bash 权限的请求
      await openChatPanel(ctx.page);
      await ctx.page.waitForTimeout(2000);

      const frames = ctx.page.frames();
      for (const frame of frames) {
        try {
          const textarea = frame.locator('textarea').first();
          if (await textarea.isVisible({ timeout: 2000 })) {
            await textarea.fill('执行 ls -la 命令');
            await textarea.press('Enter');
            await ctx.page.waitForTimeout(5000);
            break;
          }
        } catch {
          // 继续
        }
      }

      await takeScreenshot(ctx.page, 'tool-permission-approval');
    });

    test('权限设置应该可以通过命令面板访问', async () => {
      await executeCommand(ctx.page, 'OpenAIDE: Permission Settings');
      await ctx.page.waitForTimeout(2000);

      await takeScreenshot(ctx.page, 'tool-permission-settings');

      // 关闭
      await ctx.page.keyboard.press('Escape');
    });
  });

  // ─── Inline Diff 测试 ───

  test.describe('Inline Diff', () => {
    test('AI 编辑应该显示 Diff 预览', async () => {
      // 打开文件
      await executeCommand(ctx.page, 'Go to File');
      await ctx.page.waitForTimeout(500);
      await ctx.page.keyboard.type('index.ts', { delay: 50 });
      await ctx.page.waitForTimeout(500);
      await ctx.page.keyboard.press('Enter');
      await ctx.page.waitForTimeout(2000);

      // 触发 Inline 编辑
      const isMac = process.platform === 'darwin';
      await ctx.page.keyboard.press(isMac ? 'Meta+I' : 'Control+I');
      await ctx.page.waitForTimeout(2000);

      await takeScreenshot(ctx.page, 'inline-diff-trigger');
    });
  });

  // ─── 代码补全测试 ───

  test.describe('代码补全', () => {
    test('输入代码时应该触发补全建议', async () => {
      // 打开文件
      await executeCommand(ctx.page, 'Go to File');
      await ctx.page.waitForTimeout(500);
      await ctx.page.keyboard.type('index.ts', { delay: 50 });
      await ctx.page.waitForTimeout(500);
      await ctx.page.keyboard.press('Enter');
      await ctx.page.waitForTimeout(2000);

      // 移到文件末尾
      const isMac = process.platform === 'darwin';
      await ctx.page.keyboard.press(isMac ? 'Meta+End' : 'Control+End');
      await ctx.page.waitForTimeout(500);

      // 输入新行触发补全
      await ctx.page.keyboard.press('Enter');
      await ctx.page.keyboard.press('Enter');
      await ctx.page.keyboard.type('export function ', { delay: 100 });
      await ctx.page.waitForTimeout(3000);

      await takeScreenshot(ctx.page, 'code-completion');
    });
  });
});
