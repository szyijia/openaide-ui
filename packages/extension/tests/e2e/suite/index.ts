/**
 * E2E 测试套件入口
 */

import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    timeout: 60_000, // E2E 测试需要更长超时
  });

  const testsRoot = path.resolve(__dirname);

  // 查找所有测试文件
  const files = await glob('**/*.test.js', { cwd: testsRoot });

  for (const file of files) {
    mocha.addFile(path.resolve(testsRoot, file));
  }

  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} 个测试失败`));
      } else {
        resolve();
      }
    });
  });
}
