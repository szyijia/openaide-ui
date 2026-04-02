/**
 * OpenAIDE IDE — VS Code Extension E2E 测试
 *
 * 使用 @vscode/test-electron 运行端到端测试
 * 测试 Extension 在真实 VS Code 环境中的行为
 */

import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
  try {
    // Extension 开发路径
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');

    // 测试脚本路径
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    // 测试工作区
    const testWorkspacePath = path.resolve(__dirname, '../../test-workspace');

    // 运行测试
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        testWorkspacePath,
        '--disable-extensions',  // 禁用其他扩展
        '--disable-gpu',         // CI 环境无 GPU
      ],
    });
  } catch (err) {
    console.error('E2E 测试运行失败:', err);
    process.exit(1);
  }
}

main();
