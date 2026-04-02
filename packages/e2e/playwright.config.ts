import { defineConfig } from '@playwright/test';

/**
 * Playwright 配置
 *
 * OpenAIDE IDE 的 E2E 测试使用 Playwright + @vscode/test-electron
 * 测试 VS Code Extension 的完整用户交互流程
 */
export default defineConfig({
  // 测试目录
  testDir: './tests',

  // 测试文件匹配模式
  testMatch: '**/*.spec.ts',

  // 超时设置
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },

  // 并行执行（E2E 测试通常串行更稳定）
  fullyParallel: false,
  workers: 1,

  // 重试次数（CI 环境多重试）
  retries: process.env.CI ? 2 : 0,

  // 报告器
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ...(process.env.CI ? [['github' as const]] : []),
  ],

  // 全局设置
  use: {
    // 截图策略
    screenshot: 'only-on-failure',
    // 视频录制
    video: process.env.CI ? 'on-first-retry' : 'off',
    // 追踪
    trace: 'on-first-retry',
  },

  // 测试项目（不同场景）
  projects: [
    {
      name: 'extension-core',
      testMatch: '**/extension/*.spec.ts',
    },
    {
      name: 'chat-panel',
      testMatch: '**/chat/*.spec.ts',
    },
    {
      name: 'tools',
      testMatch: '**/tools/*.spec.ts',
    },
    {
      name: 'mcp',
      testMatch: '**/mcp/*.spec.ts',
    },
  ],
});
