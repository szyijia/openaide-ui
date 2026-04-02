/**
 * 工具共享层 — 工具间共享的通用功能
 *
 * 参考 Claude Code: src/tools/shared/shared.ts + src/services/tools/
 * 提供权限检查、结果格式化、路径安全验证、输出截断等通用功能
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ToolResult, ToolContext } from './types.js';

// ─── 路径安全 ───

/** 不允许访问的路径模式 */
const BLOCKED_PATHS = [
  /^\/etc\/shadow$/,
  /^\/etc\/passwd$/,
  /^\/etc\/sudoers/,
  /^\/proc\//,
  /^\/sys\//,
  /^\/dev\//,
  /\.ssh\/id_/,
  /\.ssh\/authorized_keys$/,
  /\.gnupg\//,
  /\.aws\/credentials$/,
  /\.env\.local$/,
  /\.env\.production$/,
];

/** 检查路径是否安全（不在黑名单中） */
export function isPathSafe(filePath: string): boolean {
  const normalized = path.resolve(filePath);
  return !BLOCKED_PATHS.some(pattern => pattern.test(normalized));
}

/** 解析并验证文件路径 */
export function resolveAndValidatePath(
  filePath: string,
  cwd: string,
): { resolved: string; valid: true } | { resolved: string; valid: false; error: string } {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);

  if (!isPathSafe(resolved)) {
    return {
      resolved,
      valid: false,
      error: `Access denied: "${resolved}" is a protected system path`,
    };
  }

  return { resolved, valid: true };
}

/**
 * 检查路径是否在允许的工作目录范围内
 * 防止工具访问工作目录之外的文件（可选的安全策略）
 */
export function isWithinWorkspace(filePath: string, cwd: string): boolean {
  const resolved = path.resolve(filePath);
  const resolvedCwd = path.resolve(cwd);
  return resolved.startsWith(resolvedCwd + path.sep) || resolved === resolvedCwd;
}

// ─── 输出处理 ───

/** 默认最大输出长度 */
const DEFAULT_MAX_OUTPUT = 100_000;

/** 截断过长的输出 */
export function truncateOutput(
  output: string,
  maxLength: number = DEFAULT_MAX_OUTPUT,
): string {
  if (output.length <= maxLength) return output;

  const halfLen = Math.floor(maxLength / 2) - 50;
  const truncatedLines = output.substring(halfLen, output.length - halfLen).split('\n').length;

  return (
    output.substring(0, halfLen) +
    `\n\n... [已截断 ${truncatedLines} 行，共 ${output.length} 字符] ...\n\n` +
    output.substring(output.length - halfLen)
  );
}

/** 截断输出行数 */
export function truncateLines(
  output: string,
  maxLines: number = 500,
): string {
  const lines = output.split('\n');
  if (lines.length <= maxLines) return output;

  const halfLines = Math.floor(maxLines / 2);
  const omitted = lines.length - maxLines;

  return [
    ...lines.slice(0, halfLines),
    `\n... [已省略 ${omitted} 行] ...\n`,
    ...lines.slice(lines.length - halfLines),
  ].join('\n');
}

// ─── 文件操作辅助 ───

/** 检查文件是否存在 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 获取文件信息（安全版本，不抛异常） */
export async function getFileInfo(filePath: string): Promise<{
  exists: boolean;
  isFile?: boolean;
  isDirectory?: boolean;
  size?: number;
  modifiedAt?: Date;
} | null> {
  try {
    const stat = await fs.stat(filePath);
    return {
      exists: true,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      size: stat.size,
      modifiedAt: stat.mtime,
    };
  } catch {
    return { exists: false };
  }
}

/**
 * 检测文件是否为二进制文件
 * 通过读取前 8KB 检查是否包含 null 字节
 */
export async function isBinaryFile(filePath: string): Promise<boolean> {
  try {
    const fd = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(8192);
      const { bytesRead } = await fd.read(buffer, 0, 8192, 0);

      // 检查是否包含 null 字节（二进制文件的典型特征）
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0) return true;
      }

      return false;
    } finally {
      await fd.close();
    }
  } catch {
    return false;
  }
}

/**
 * 原子写入文件
 * 先写入临时文件，再重命名，确保写入的原子性
 */
export async function atomicWriteFile(
  filePath: string,
  content: string,
  encoding: BufferEncoding = 'utf-8',
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  // 创建临时文件（同目录下，确保在同一文件系统）
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;

  try {
    await fs.writeFile(tmpPath, content, encoding);
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    // 清理临时文件
    try {
      await fs.unlink(tmpPath);
    } catch {
      // 忽略清理错误
    }
    throw error;
  }
}

/**
 * 创建文件备份
 * 在同目录下创建 .bak 备份
 */
export async function createBackup(filePath: string): Promise<string | null> {
  try {
    const backupPath = `${filePath}.bak.${Date.now()}`;
    await fs.copyFile(filePath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}

// ─── 结果格式化 ───

/** 格式化成功结果 */
export function formatSuccess(message: string, metadata?: Record<string, unknown>): ToolResult {
  return {
    content: message,
    isError: false,
    metadata,
  };
}

/** 格式化错误结果 */
export function formatError(message: string, metadata?: Record<string, unknown>): ToolResult {
  return {
    content: `Error: ${message}`,
    isError: true,
    metadata,
  };
}

/** 格式化文件操作结果 */
export function formatFileResult(
  action: string,
  filePath: string,
  details?: Record<string, unknown>,
): ToolResult {
  const parts = [`✅ ${action}: ${filePath}`];

  if (details) {
    for (const [key, value] of Object.entries(details)) {
      if (value !== undefined && value !== null) {
        parts.push(`${key}: ${value}`);
      }
    }
  }

  return {
    content: parts.join(' | '),
    metadata: { filePath, action, ...details },
  };
}

// ─── 行号处理 ───

/** 为文本添加行号 */
export function addLineNumbers(text: string, startLine: number = 1): string {
  const lines = text.split('\n');
  const maxLineNum = startLine + lines.length - 1;
  const padWidth = String(maxLineNum).length;

  return lines
    .map((line, i) => {
      const lineNum = String(startLine + i).padStart(padWidth, ' ');
      return `${lineNum} | ${line}`;
    })
    .join('\n');
}

/** 提取指定行范围的内容 */
export function extractLineRange(
  text: string,
  startLine: number,
  endLine: number,
): { content: string; actualStart: number; actualEnd: number } {
  const lines = text.split('\n');
  const totalLines = lines.length;

  const actualStart = Math.max(1, Math.min(startLine, totalLines));
  const actualEnd = Math.max(actualStart, Math.min(endLine, totalLines));

  const selectedLines = lines.slice(actualStart - 1, actualEnd);

  return {
    content: selectedLines.join('\n'),
    actualStart,
    actualEnd,
  };
}

// ─── Diff 生成 ───

/**
 * 生成简单的 unified diff
 * 用于显示文件编辑的变更内容
 */
export function generateSimpleDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const lines: string[] = [
    `--- a/${path.basename(filePath)}`,
    `+++ b/${path.basename(filePath)}`,
  ];

  // 简单的逐行比较（不是完整的 diff 算法，但足够用于显示变更）
  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      // 相同行
      lines.push(` ${oldLines[i]}`);
      i++;
      j++;
    } else if (i < oldLines.length && (j >= newLines.length || !newLines.includes(oldLines[i]!))) {
      // 删除行
      lines.push(`-${oldLines[i]}`);
      i++;
    } else if (j < newLines.length) {
      // 新增行
      lines.push(`+${newLines[j]}`);
      j++;
    }
  }

  return lines.join('\n');
}

// ─── 环境检测 ───

/** 获取当前平台信息 */
export function getPlatformInfo(): {
  os: string;
  arch: string;
  shell: string;
  homeDir: string;
  tmpDir: string;
} {
  return {
    os: process.platform,
    arch: process.arch,
    shell: process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'),
    homeDir: os.homedir(),
    tmpDir: os.tmpdir(),
  };
}

/** 检查命令是否可用 */
export async function isCommandAvailable(command: string): Promise<boolean> {
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    await execAsync(`${whichCmd} ${command}`);
    return true;
  } catch {
    return false;
  }
}

// ─── 计时工具 ───

/** 创建计时器 */
export function createTimer(): { elapsed: () => number; elapsedMs: () => string } {
  const start = performance.now();
  return {
    elapsed: () => performance.now() - start,
    elapsedMs: () => `${(performance.now() - start).toFixed(0)}ms`,
  };
}
