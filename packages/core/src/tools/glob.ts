/**
 * GlobTool — 文件搜索工具
 *
 * 参考 Claude Code: src/tools/GlobTool/GlobTool.ts
 * 使用 glob 模式搜索文件
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool, ToolResult, ToolPermission, ToolContext } from './types.js';

const MAX_RESULTS = 500;

export const GlobTool: Tool = {
  name: 'glob',
  description: '使用 glob 模式搜索文件路径',

  prompt: `使用 glob 模式搜索匹配的文件路径。

常用模式：
- \`**/*.ts\` — 所有 TypeScript 文件
- \`src/**/*.{ts,tsx}\` — src 下所有 TS/TSX 文件
- \`**/package.json\` — 所有 package.json
- \`*.md\` — 当前目录下的 Markdown 文件

使用场景：
- 了解项目结构
- 查找特定类型的文件
- 在执行其他操作前定位文件

注意：结果最多返回 ${MAX_RESULTS} 个文件。`,

  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob 模式（如 **/*.ts）',
      },
      directory: {
        type: 'string',
        description: '搜索的根目录（默认为当前工作目录）',
      },
    },
    required: ['pattern'],
  },

  permission: {
    default: 'always_allow',
    userConfigurable: false,
  } as ToolPermission,

  concurrentSafe: true,

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const pattern = input.pattern as string;
    const directory = input.directory as string | undefined;

    if (!pattern) {
      return { content: 'Error: pattern is required', isError: true };
    }

    const searchDir = directory
      ? (path.isAbsolute(directory) ? directory : path.resolve(context.cwd, directory))
      : context.cwd;

    try {
      // 使用 Node.js 内置的 glob（Node 22+）或手动递归
      const matches = await globSearch(searchDir, pattern);

      if (matches.length === 0) {
        return {
          content: `No files found matching pattern "${pattern}" in ${searchDir}`,
          metadata: { count: 0 },
        };
      }

      // 限制结果数量
      const truncated = matches.length > MAX_RESULTS;
      const displayMatches = truncated ? matches.slice(0, MAX_RESULTS) : matches;

      // 按路径排序
      displayMatches.sort();

      const header = truncated
        ? `Found ${matches.length} files (showing first ${MAX_RESULTS}):`
        : `Found ${displayMatches.length} files:`;

      const output = displayMatches.map((f) => `  ${path.relative(searchDir, f)}`).join('\n');

      return {
        content: `${header}\n${output}`,
        metadata: {
          count: matches.length,
          truncated,
          files: displayMatches,
        },
      };
    } catch (error) {
      return {
        content: `Error searching files: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};

/**
 * 简单的 glob 搜索实现
 * 支持 *, **, ? 通配符和 {a,b} 选择
 */
async function globSearch(rootDir: string, pattern: string): Promise<string[]> {
  const results: string[] = [];

  // 将 glob 模式转换为正则表达式
  const regex = globToRegex(pattern);

  // 递归遍历目录
  await walkDir(rootDir, rootDir, regex, results);

  return results;
}

function globToRegex(pattern: string): RegExp {
  // 展开 {a,b} 模式 — 简化处理，转为正则的 (a|b)
  let regexStr = pattern
    .replace(/\{([^}]+)\}/g, (_match, group: string) => {
      return `(${group.split(',').map((s: string) => escapeRegex(s.trim())).join('|')})`;
    });

  // 转换 glob 通配符
  regexStr = regexStr
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*')
    .replace(/\./g, '\\.');

  return new RegExp(`^${regexStr}$`);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function walkDir(
  rootDir: string,
  currentDir: string,
  pattern: RegExp,
  results: string[],
): Promise<void> {
  if (results.length >= MAX_RESULTS * 2) return; // 提前终止

  try {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      // 跳过隐藏目录和 node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);

      if (entry.isDirectory()) {
        await walkDir(rootDir, fullPath, pattern, results);
      } else if (entry.isFile()) {
        if (pattern.test(relativePath)) {
          results.push(fullPath);
        }
      }
    }
  } catch {
    // 忽略无法访问的目录
  }
}
