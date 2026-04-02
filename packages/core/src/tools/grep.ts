/**
 * GrepTool — 文本搜索工具（增强版）
 *
 * 参考 Claude Code: src/tools/GrepTool/ (3 文件, 795 行)
 * 在文件中搜索文本内容（支持正则表达式）
 *
 * 增强功能：
 * - ripgrep 集成优化（上下文行、排除模式、文件类型过滤）
 * - 固定字符串搜索（非正则）
 * - 多模式排除（目录、文件、glob）
 * - 搜索结果分组与格式化
 * - 搜索统计信息
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool, ToolResult, ToolPermission, ToolContext } from './types.js';
import { createTimer, truncateOutput } from './shared.js';

const execFileAsync = promisify(execFile);
const MAX_RESULTS = 300;
const MAX_OUTPUT_SIZE = 80_000;

/** 默认排除的目录 */
const DEFAULT_EXCLUDE_DIRS = [
  'node_modules', '.git', 'dist', 'build', '.turbo', '.next',
  '__pycache__', '.pytest_cache', '.mypy_cache',
  'coverage', '.nyc_output',
  'vendor', '.bundle',
  'target', // Rust/Java
  '.gradle', '.idea', '.vscode',
];

/** 默认排除的文件模式 */
const DEFAULT_EXCLUDE_FILES = [
  '*.min.js', '*.min.css', '*.map',
  '*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  '*.pyc', '*.pyo',
  '*.so', '*.dylib', '*.dll',
  '*.wasm',
];

export const GrepTool: Tool = {
  name: 'grep',
  description: '在文件中搜索文本内容',

  prompt: `在文件中搜索文本内容，支持正则表达式和固定字符串搜索。

使用场景：
- 查找函数/类/变量的定义和使用
- 搜索特定的错误信息
- 查找配置项
- 代码审查

参数说明：
- pattern: 搜索模式（默认为正则表达式）
- directory: 搜索目录（默认为当前工作目录）
- include: 文件过滤模式（如 "*.ts"、"*.{js,jsx}"）
- exclude: 额外排除的目录或文件模式
- case_sensitive: 是否区分大小写（默认 true）
- fixed_string: 是否为固定字符串搜索（非正则，默认 false）
- context_lines: 显示匹配行前后的上下文行数（默认 0）
- max_results: 最大结果数（默认 ${MAX_RESULTS}）

结果会显示匹配的文件路径、行号和内容，按文件分组。`,

  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: '搜索模式（正则表达式或固定字符串）',
      },
      directory: {
        type: 'string',
        description: '搜索目录（默认为当前工作目录）',
      },
      include: {
        type: 'string',
        description: '文件过滤模式（如 "*.ts"、"*.{js,jsx}"）',
      },
      exclude: {
        type: 'array',
        items: { type: 'string' },
        description: '额外排除的目录或文件模式',
      },
      case_sensitive: {
        type: 'boolean',
        description: '是否区分大小写（默认 true）',
      },
      fixed_string: {
        type: 'boolean',
        description: '是否为固定字符串搜索（非正则，默认 false）',
      },
      context_lines: {
        type: 'number',
        description: '显示匹配行前后的上下文行数（默认 0）',
      },
      max_results: {
        type: 'number',
        description: `最大结果数（默认 ${MAX_RESULTS}）`,
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
    const include = input.include as string | undefined;
    const exclude = input.exclude as string[] | undefined;
    const caseSensitive = input.case_sensitive !== false; // 默认 true
    const fixedString = (input.fixed_string as boolean) ?? false;
    const contextLines = (input.context_lines as number) ?? 0;
    const maxResults = Math.min((input.max_results as number) ?? MAX_RESULTS, MAX_RESULTS);

    if (!pattern) {
      return { content: 'Error: pattern is required', isError: true };
    }

    const searchDir = directory
      ? (path.isAbsolute(directory) ? directory : path.resolve(context.cwd, directory))
      : context.cwd;

    const timer = createTimer();

    // 优先使用 ripgrep（rg），其次使用 grep，最后使用纯 Node.js
    try {
      return await tryRipgrep(pattern, searchDir, {
        include, exclude, caseSensitive, fixedString, contextLines, maxResults,
      }, timer);
    } catch {
      try {
        return await tryGrep(pattern, searchDir, {
          include, exclude, caseSensitive, fixedString, contextLines, maxResults,
        }, timer);
      } catch {
        return await nodeGrep(pattern, searchDir, {
          include, caseSensitive, maxResults,
        }, timer);
      }
    }
  },
};

/** 搜索选项 */
interface SearchOptions {
  include?: string;
  exclude?: string[];
  caseSensitive: boolean;
  fixedString?: boolean;
  contextLines?: number;
  maxResults: number;
}

/** 使用 ripgrep 搜索 */
async function tryRipgrep(
  pattern: string,
  directory: string,
  opts: SearchOptions,
  timer: ReturnType<typeof createTimer>,
): Promise<ToolResult> {
  const args = [
    '--line-number',
    '--no-heading',
    '--color=never',
    `--max-count=${opts.maxResults}`,
    '--max-columns=300',
    '--max-columns-preview',
    '--with-filename',
  ];

  // 大小写
  if (!opts.caseSensitive) args.push('--ignore-case');

  // 固定字符串
  if (opts.fixedString) args.push('--fixed-strings');

  // 上下文行
  if (opts.contextLines && opts.contextLines > 0) {
    args.push(`--context=${Math.min(opts.contextLines, 10)}`);
  }

  // 文件包含模式
  if (opts.include) {
    const globs = parseIncludePattern(opts.include);
    for (const glob of globs) {
      args.push('--glob', glob);
    }
  }

  // 默认排除
  for (const dir of DEFAULT_EXCLUDE_DIRS) {
    args.push('--glob', `!${dir}/`);
  }
  for (const file of DEFAULT_EXCLUDE_FILES) {
    args.push('--glob', `!${file}`);
  }

  // 额外排除
  if (opts.exclude) {
    for (const pattern of opts.exclude) {
      args.push('--glob', pattern.startsWith('!') ? pattern : `!${pattern}`);
    }
  }

  args.push('--', pattern, directory);

  try {
    const { stdout } = await execFileAsync('rg', args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });

    return formatSearchOutput(stdout, directory, timer, 'ripgrep');
  } catch (error: unknown) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    // ripgrep 返回 1 表示没有匹配
    if (err.code === 1) {
      return {
        content: `No matches found for "${pattern}" in ${directory} (${timer.elapsedMs()})`,
        metadata: { count: 0, elapsed: timer.elapsedMs(), engine: 'ripgrep' },
      };
    }
    // 其他错误，抛出让后备方案处理
    throw error;
  }
}

/** 使用系统 grep 搜索 */
async function tryGrep(
  pattern: string,
  directory: string,
  opts: SearchOptions,
  timer: ReturnType<typeof createTimer>,
): Promise<ToolResult> {
  const args = [
    '-r',
    '-n',
    '--color=never',
    `-m${opts.maxResults}`,
  ];

  if (!opts.caseSensitive) args.push('-i');
  if (opts.fixedString) args.push('-F');
  if (opts.contextLines && opts.contextLines > 0) {
    args.push(`-C${Math.min(opts.contextLines, 10)}`);
  }
  if (opts.include) {
    args.push(`--include=${opts.include}`);
  }

  // 排除目录
  for (const dir of DEFAULT_EXCLUDE_DIRS) {
    args.push(`--exclude-dir=${dir}`);
  }

  args.push('-E', pattern, directory);

  try {
    const { stdout } = await execFileAsync('grep', args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });

    return formatSearchOutput(stdout, directory, timer, 'grep');
  } catch (error: unknown) {
    const err = error as { code?: number; stdout?: string };
    if (err.code === 1) {
      return {
        content: `No matches found for "${pattern}" in ${directory} (${timer.elapsedMs()})`,
        metadata: { count: 0, elapsed: timer.elapsedMs(), engine: 'grep' },
      };
    }
    throw error;
  }
}

/** 纯 Node.js 搜索实现（后备方案） */
async function nodeGrep(
  pattern: string,
  directory: string,
  opts: { include?: string; caseSensitive: boolean; maxResults: number },
  timer: ReturnType<typeof createTimer>,
): Promise<ToolResult> {
  const regex = new RegExp(pattern, opts.caseSensitive ? 'g' : 'gi');
  const results: string[] = [];

  const includeExts = opts.include
    ? opts.include.replace(/\*\./g, '.').replace(/\{([^}]+)\}/g, '$1').split(',').map((e: string) => e.trim())
    : null;

  await searchDir(directory, regex, results, includeExts, opts.maxResults);

  if (results.length === 0) {
    return {
      content: `No matches found for "${pattern}" in ${directory} (${timer.elapsedMs()})`,
      metadata: { count: 0, elapsed: timer.elapsedMs(), engine: 'node' },
    };
  }

  const truncated = results.length > opts.maxResults;
  const displayResults = truncated ? results.slice(0, opts.maxResults) : results;

  // 按文件分组
  const grouped = groupByFile(displayResults, directory);
  const output = formatGroupedResults(grouped);

  const header = truncated
    ? `Found ${results.length}+ matches (showing first ${opts.maxResults}) in ${timer.elapsedMs()}:`
    : `Found ${displayResults.length} matches in ${timer.elapsedMs()}:`;

  return {
    content: truncateOutput(`${header}\n${output}`, MAX_OUTPUT_SIZE),
    metadata: {
      count: displayResults.length,
      fileCount: grouped.size,
      truncated,
      elapsed: timer.elapsedMs(),
      engine: 'node',
    },
  };
}

async function searchDir(
  dir: string,
  regex: RegExp,
  results: string[],
  includeExts: string[] | null,
  maxResults: number,
): Promise<void> {
  if (results.length >= maxResults * 2) return;

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (DEFAULT_EXCLUDE_DIRS.includes(entry.name) || entry.name.startsWith('.')) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await searchDir(fullPath, regex, results, includeExts, maxResults);
      } else if (entry.isFile()) {
        if (includeExts) {
          const ext = path.extname(entry.name);
          if (!includeExts.some((e) => ext === e || entry.name.endsWith(e))) continue;
        }

        try {
          const content = await fs.readFile(fullPath, 'utf-8');
          const lines = content.split('\n');

          for (let i = 0; i < lines.length; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i]!)) {
              const lineContent = lines[i]!.length > 300
                ? lines[i]!.substring(0, 300) + '...'
                : lines[i];
              results.push(`${fullPath}:${i + 1}: ${lineContent}`);
              if (results.length >= maxResults * 2) return;
            }
          }
        } catch {
          // 跳过无法读取的文件
        }
      }
    }
  } catch {
    // 忽略无法访问的目录
  }
}

// ─── 格式化辅助 ───

/** 解析 include 模式 */
function parseIncludePattern(include: string): string[] {
  // 支持 "*.ts"、"*.{js,jsx}"、"*.ts,*.js" 等格式
  if (include.includes('{')) {
    // 展开 {a,b} 格式
    const match = include.match(/\*\.?\{([^}]+)\}/);
    if (match) {
      return match[1]!.split(',').map(ext => `*.${ext.trim()}`);
    }
  }

  if (include.includes(',')) {
    return include.split(',').map(g => g.trim());
  }

  return [include];
}

/** 按文件分组搜索结果 */
function groupByFile(lines: string[], baseDir: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const filePart = line.substring(0, colonIdx);
    const rest = line.substring(colonIdx + 1);

    const relativePath = path.isAbsolute(filePart)
      ? path.relative(baseDir, filePart)
      : filePart;

    if (!groups.has(relativePath)) {
      groups.set(relativePath, []);
    }
    groups.get(relativePath)!.push(rest);
  }

  return groups;
}

/** 格式化分组结果 */
function formatGroupedResults(groups: Map<string, string[]>): string {
  const output: string[] = [];

  for (const [file, matches] of groups) {
    output.push(`\n📄 ${file} (${matches.length} matches)`);
    for (const match of matches) {
      output.push(`  ${match}`);
    }
  }

  return output.join('\n');
}

/** 格式化搜索输出（来自 rg/grep） */
function formatSearchOutput(
  stdout: string,
  baseDir: string,
  timer: ReturnType<typeof createTimer>,
  engine: string,
): ToolResult {
  const lines = stdout.trim().split('\n').filter(Boolean);

  if (lines.length === 0) {
    return {
      content: `No matches found in ${baseDir} (${timer.elapsedMs()})`,
      metadata: { count: 0, elapsed: timer.elapsedMs(), engine },
    };
  }

  // 按文件分组
  const groups = groupByFile(lines, baseDir);
  const output = formatGroupedResults(groups);

  let totalMatches = 0;
  for (const matches of groups.values()) {
    totalMatches += matches.length;
  }

  const header = `Found ${totalMatches} matches in ${groups.size} files (${timer.elapsedMs()}, ${engine}):`;

  return {
    content: truncateOutput(`${header}${output}`, MAX_OUTPUT_SIZE),
    metadata: {
      count: totalMatches,
      fileCount: groups.size,
      elapsed: timer.elapsedMs(),
      engine,
    },
  };
}
