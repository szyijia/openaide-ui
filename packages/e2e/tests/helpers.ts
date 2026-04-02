/**
 * E2E 测试辅助工具
 *
 * 提供 VS Code Extension 测试的通用工具函数：
 * - 启动 VS Code 实例
 * - 等待 Extension 激活
 * - 操作 Webview / TreeView
 * - 模拟用户交互
 */

import { type ElectronApplication, type Page, _electron as electron } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

// ─── 常量 ───

/** 测试工作区目录 */
const TEST_WORKSPACE = path.join(os.tmpdir(), 'openaide-e2e-workspace');

/** Extension 路径 */
const EXTENSION_PATH = path.resolve(__dirname, '../../extension');

/** 等待超时 */
const DEFAULT_TIMEOUT = 30_000;

// ─── 类型 ───

export interface TestContext {
  /** Electron 应用实例 */
  app: ElectronApplication;
  /** 主窗口 Page */
  page: Page;
  /** 测试工作区路径 */
  workspacePath: string;
}

export interface LaunchOptions {
  /** 自定义工作区路径 */
  workspacePath?: string;
  /** 额外的 VS Code 启动参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
  /** 是否禁用其他扩展 */
  disableOtherExtensions?: boolean;
}

// ─── 启动和关闭 ───

/**
 * 启动 VS Code 测试实例
 */
export async function launchVSCode(options?: LaunchOptions): Promise<TestContext> {
  const workspacePath = options?.workspacePath || TEST_WORKSPACE;

  // 确保测试工作区存在
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true });
  }

  // 创建测试文件
  createTestFiles(workspacePath);

  // VS Code 可执行文件路径（根据平台）
  const vscodePath = getVSCodePath();

  const args = [
    workspacePath,
    `--extensionDevelopmentPath=${EXTENSION_PATH}`,
    '--disable-gpu',
    '--no-sandbox',
    ...(options?.disableOtherExtensions !== false ? ['--disable-extensions'] : []),
    ...(options?.args || []),
  ];

  const app = await electron.launch({
    executablePath: vscodePath,
    args,
    env: {
      ...process.env,
      OPENAIDE_E2E_TEST: '1',
      // 使用 Mock LLM Provider
      OPENAIDE_MOCK_LLM: '1',
      ...options?.env,
    },
  });

  const page = await app.firstWindow();

  // 等待 VS Code 完全加载
  await page.waitForLoadState('domcontentloaded');
  await waitForExtensionReady(page);

  return { app, page, workspacePath };
}

/**
 * 关闭 VS Code 测试实例
 */
export async function closeVSCode(ctx: TestContext): Promise<void> {
  await ctx.app.close();

  // 清理测试工作区
  try {
    fs.rmSync(ctx.workspacePath, { recursive: true, force: true });
  } catch {
    // 忽略清理错误
  }
}

// ─── 等待辅助 ───

/**
 * 等待 Extension 激活完成
 */
async function waitForExtensionReady(page: Page): Promise<void> {
  // 等待状态栏出现OpenAIDE图标
  await page.waitForSelector('[id*="openaide"]', {
    timeout: DEFAULT_TIMEOUT,
    state: 'visible',
  }).catch(() => {
    // 如果找不到特定选择器，等待一段时间
  });

  // 额外等待确保 Extension Host 完全初始化
  await page.waitForTimeout(2000);
}

/**
 * 等待 Webview 加载完成
 */
export async function waitForWebview(page: Page, title: string): Promise<Page> {
  // VS Code 的 Webview 在 iframe 中
  const frames = page.frames();
  for (const frame of frames) {
    const frameTitle = await frame.title().catch(() => '');
    if (frameTitle.includes(title)) {
      return frame as unknown as Page;
    }
  }

  // 等待 Webview iframe 出现
  await page.waitForTimeout(3000);

  const framesAfterWait = page.frames();
  for (const frame of framesAfterWait) {
    const frameTitle = await frame.title().catch(() => '');
    if (frameTitle.includes(title)) {
      return frame as unknown as Page;
    }
  }

  throw new Error(`Webview "${title}" 未找到`);
}

// ─── 命令面板操作 ───

/**
 * 打开命令面板
 */
export async function openCommandPalette(page: Page): Promise<void> {
  const isMac = process.platform === 'darwin';
  await page.keyboard.press(isMac ? 'Meta+Shift+P' : 'Control+Shift+P');
  await page.waitForSelector('.quick-input-widget', { state: 'visible', timeout: 5000 });
}

/**
 * 执行命令面板命令
 */
export async function executeCommand(page: Page, command: string): Promise<void> {
  await openCommandPalette(page);
  await page.keyboard.type(command, { delay: 50 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
}

/**
 * 打开 Chat Panel
 */
export async function openChatPanel(page: Page): Promise<void> {
  await executeCommand(page, 'OpenAIDE: Open Chat');
}

// ─── 编辑器操作 ───

/**
 * 打开文件
 */
export async function openFile(page: Page, relativePath: string): Promise<void> {
  await executeCommand(page, relativePath);
}

/**
 * 获取编辑器内容
 */
export async function getEditorContent(page: Page): Promise<string> {
  // 通过 VS Code API 获取编辑器内容
  return page.evaluate(() => {
    // @ts-expect-error VS Code API
    const editor = window.activeTextEditor;
    return editor?.document?.getText() || '';
  });
}

/**
 * 在编辑器中输入文本
 */
export async function typeInEditor(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 30 });
}

// ─── 侧边栏操作 ───

/**
 * 打开侧边栏视图
 */
export async function openSidebarView(page: Page, viewId: string): Promise<void> {
  await executeCommand(page, `workbench.view.extension.${viewId}`);
  await page.waitForTimeout(1000);
}

/**
 * 点击 TreeView 项
 */
export async function clickTreeItem(page: Page, label: string): Promise<void> {
  const item = page.locator(`.monaco-list-row:has-text("${label}")`).first();
  await item.click();
}

// ─── 状态栏操作 ───

/**
 * 获取状态栏文本
 */
export async function getStatusBarText(page: Page, itemId: string): Promise<string> {
  const item = page.locator(`[id*="${itemId}"]`).first();
  return item.textContent() || '';
}

/**
 * 点击状态栏项
 */
export async function clickStatusBarItem(page: Page, itemId: string): Promise<void> {
  const item = page.locator(`[id*="${itemId}"]`).first();
  await item.click();
}

// ─── 通知操作 ───

/**
 * 等待通知出现
 */
export async function waitForNotification(page: Page, text: string): Promise<void> {
  await page.waitForSelector(`.notification-toast:has-text("${text}")`, {
    timeout: DEFAULT_TIMEOUT,
  });
}

/**
 * 关闭所有通知
 */
export async function dismissNotifications(page: Page): Promise<void> {
  await executeCommand(page, 'Notifications: Clear All Notifications');
}

// ─── 对话框操作 ───

/**
 * 处理确认对话框
 */
export async function handleDialog(page: Page, action: 'accept' | 'dismiss'): Promise<void> {
  page.on('dialog', async (dialog) => {
    if (action === 'accept') {
      await dialog.accept();
    } else {
      await dialog.dismiss();
    }
  });
}

// ─── 截图 ───

/**
 * 截取当前页面截图
 */
export async function takeScreenshot(page: Page, name: string): Promise<void> {
  const screenshotDir = path.join(__dirname, '..', 'screenshots');
  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  await page.screenshot({
    path: path.join(screenshotDir, `${name}.png`),
    fullPage: true,
  });
}

// ─── 内部辅助 ───

/**
 * 获取 VS Code 可执行文件路径
 */
function getVSCodePath(): string {
  // 优先使用环境变量指定的路径
  if (process.env.VSCODE_PATH) {
    return process.env.VSCODE_PATH;
  }

  // 根据平台查找默认路径
  switch (process.platform) {
    case 'darwin':
      return '/Applications/OpenAIDE.app/Contents/MacOS/Electron';
    case 'win32':
      return path.join(process.env.LOCALAPPDATA || '', 'Programs', 'OpenAIDE', 'OpenAIDE.exe');
    case 'linux':
      return '/usr/bin/openaide';
    default:
      throw new Error(`不支持的平台: ${process.platform}`);
  }
}

/**
 * 创建测试工作区文件
 */
function createTestFiles(workspacePath: string): void {
  // 创建一个简单的 TypeScript 项目
  const files: Record<string, string> = {
    'src/index.ts': `
/**
 * 测试入口文件
 */
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

export function add(a: number, b: number): number {
  return a + b;
}

export function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}
`.trimStart(),

    'src/utils.ts': `
/**
 * 工具函数
 */
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
`.trimStart(),

    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        outDir: 'dist',
      },
      include: ['src'],
    }, null, 2),

    'package.json': JSON.stringify({
      name: 'e2e-test-project',
      version: '1.0.0',
      type: 'module',
    }, null, 2),

    '.openaide.md': `# 测试项目

这是一个用于 E2E 测试的 TypeScript 项目。

## 代码规范
- 使用 TypeScript 严格模式
- 函数需要 JSDoc 注释
`,
  };

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(workspacePath, filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content, 'utf-8');
  }
}
