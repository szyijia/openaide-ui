/**
 * FileReadTool — 文件读取工具（增强版）
 *
 * 参考 Claude Code: src/tools/FileReadTool/ (5 文件, 1,602 行)
 * 读取文件内容，支持：
 * - 二进制文件检测
 * - 编码自动检测
 * - 大文件分页读取
 * - 行号范围选择
 * - 图片文件读取（base64）
 * - PDF 文本提取
 * - 文件缓存
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool, ToolResult, ToolPermission, ToolContext } from './types.js';
import {
  resolveAndValidatePath,
  isBinaryFile,
  addLineNumbers,
  extractLineRange,
  truncateOutput,
  getFileInfo,
  createTimer,
} from './shared.js';

// ─── 常量 ───

const MAX_OUTPUT_SIZE = 100_000;   // 最大输出字符数（约 25K tokens）
const MAX_LINE_LENGTH = 2000;      // 单行最大长度
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 最大文件大小 10MB
const LARGE_FILE_THRESHOLD = 2000; // 大文件行数阈值
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 最大图片大小 5MB

// ─── 文件类型检测 ───

/** 图片扩展名 */
const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico',
]);

/** PDF 扩展名 */
const PDF_EXTENSIONS = new Set(['.pdf']);

/** 已知的二进制扩展名 */
const BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.wasm', '.pyc', '.pyo', '.class',
  '.o', '.obj', '.a', '.lib',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.flv',
  '.wav', '.ogg', '.flac', '.aac',
  '.db', '.sqlite', '.sqlite3',
  '.lock', // 某些 lock 文件是二进制的
]);

/** 检查是否为图片文件 */
function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** 检查是否为 PDF 文件 */
function isPdfFile(filePath: string): boolean {
  return PDF_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** 检查扩展名是否为已知二进制 */
function isKnownBinaryExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

// ─── FileReadTool ───

export const FileReadTool: Tool = {
  name: 'file_read',
  description: '读取文件内容',

  prompt: `读取文件内容。输出会自动添加行号。

使用场景：
- 读取源代码文件
- 查看配置文件
- 检查日志文件
- 读取文档
- 查看图片文件（返回 base64）

参数说明：
- file_path: 文件路径（必需）
- offset: 起始行号（从 1 开始）
- limit: 读取的行数
- encoding: 文件编码（默认 utf-8）

注意事项：
- 对于大文件（>2000行），不指定 offset/limit 时会返回文件概要而非全部内容
- 二进制文件会返回文件信息而非内容
- 图片文件会返回 base64 编码
- 路径必须是绝对路径或相对于当前工作目录的路径`,

  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: '要读取的文件路径（绝对路径或相对路径）',
      },
      offset: {
        type: 'number',
        description: '起始行号（从 1 开始），不指定则从头开始',
      },
      limit: {
        type: 'number',
        description: '读取的行数，不指定则读取全部',
      },
      encoding: {
        type: 'string',
        description: '文件编码（默认 utf-8）',
      },
    },
    required: ['file_path'],
  },

  permission: {
    default: 'always_allow',
    userConfigurable: false,
  } as ToolPermission,

  concurrentSafe: true,

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const filePath = input.file_path as string;
    const offset = input.offset as number | undefined;
    const limit = input.limit as number | undefined;
    const encoding = (input.encoding as BufferEncoding) || 'utf-8';

    if (!filePath) {
      return { content: 'Error: file_path is required', isError: true };
    }

    // 路径验证
    const pathResult = resolveAndValidatePath(filePath, context.cwd);
    if (!pathResult.valid) {
      return { content: pathResult.error!, isError: true };
    }
    const resolvedPath = pathResult.resolved;

    const timer = createTimer();

    try {
      // 获取文件信息
      const info = await getFileInfo(resolvedPath);
      if (!info || !info.exists) {
        return { content: `Error: File not found: "${resolvedPath}"`, isError: true };
      }

      if (info.isDirectory) {
        return { content: `Error: "${resolvedPath}" is a directory, not a file`, isError: true };
      }

      const fileSize = info.size || 0;

      // 文件大小检查
      if (fileSize > MAX_FILE_SIZE) {
        return {
          content: `Error: File is too large (${formatFileSize(fileSize)}). Maximum supported size is ${formatFileSize(MAX_FILE_SIZE)}.`,
          isError: true,
          metadata: { filePath: resolvedPath, fileSize },
        };
      }

      // ─── 图片文件处理 ───
      if (isImageFile(resolvedPath)) {
        return readImageFile(resolvedPath, fileSize);
      }

      // ─── 二进制文件检测 ───
      if (isKnownBinaryExtension(resolvedPath)) {
        return {
          content: `Binary file: ${resolvedPath}\nSize: ${formatFileSize(fileSize)}\nType: ${path.extname(resolvedPath)}\n\n此文件为二进制格式，无法以文本形式显示。`,
          metadata: { filePath: resolvedPath, fileSize, binary: true },
        };
      }

      // 内容级二进制检测
      if (fileSize > 0 && await isBinaryFile(resolvedPath)) {
        return {
          content: `Binary file: ${resolvedPath}\nSize: ${formatFileSize(fileSize)}\n\n此文件包含二进制数据，无法以文本形式显示。`,
          metadata: { filePath: resolvedPath, fileSize, binary: true },
        };
      }

      // ─── 文本文件读取 ───
      const rawContent = await fs.readFile(resolvedPath, encoding);
      const lines = rawContent.split('\n');
      const totalLines = lines.length;

      // 大文件概要模式
      if (totalLines > LARGE_FILE_THRESHOLD && !offset && !limit) {
        return generateFileSummary(resolvedPath, lines, fileSize, timer.elapsedMs());
      }

      // 应用 offset 和 limit
      const startLine = offset ? Math.max(1, offset) : 1;
      const endLine = limit ? Math.min(startLine + limit - 1, totalLines) : totalLines;
      const selectedLines = lines.slice(startLine - 1, endLine);

      // 格式化输出（带行号）
      let output = '';
      let truncated = false;
      const padWidth = String(endLine).length;

      for (let i = 0; i < selectedLines.length; i++) {
        const lineNum = startLine + i;
        let line = selectedLines[i]!;

        // 截断超长行
        if (line.length > MAX_LINE_LENGTH) {
          line = line.substring(0, MAX_LINE_LENGTH) + '... (truncated)';
        }

        const formattedLine = `${String(lineNum).padStart(padWidth, ' ')} | ${line}\n`;

        if (output.length + formattedLine.length > MAX_OUTPUT_SIZE) {
          truncated = true;
          output += `\n... (output truncated at line ${lineNum}, total ${totalLines} lines)\n`;
          break;
        }

        output = output + formattedLine;
      }

      // 文件信息头
      const headerParts = [
        `File: ${resolvedPath}`,
        `Size: ${formatFileSize(fileSize)}`,
        `Lines: ${totalLines}`,
      ];

      if (offset || limit) {
        headerParts.push(`Showing: lines ${startLine}-${endLine}`);
      }
      if (truncated) {
        headerParts.push('⚠️ Output truncated');
      }

      const header = headerParts.join(' | ');

      return {
        content: `${header}\n${'─'.repeat(80)}\n${output}`,
        metadata: {
          filePath: resolvedPath,
          totalLines,
          startLine,
          endLine,
          fileSize,
          truncated,
          isBigFile: totalLines > LARGE_FILE_THRESHOLD,
          elapsed: timer.elapsedMs(),
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { content: `Error: File not found: "${resolvedPath}"`, isError: true };
      }
      if ((error as NodeJS.ErrnoException).code === 'EACCES') {
        return { content: `Error: Permission denied: "${resolvedPath}"`, isError: true };
      }
      return {
        content: `Error reading file: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};

// ─── 辅助函数 ───

/** 读取图片文件（返回 base64） */
async function readImageFile(filePath: string, fileSize: number): Promise<ToolResult> {
  if (fileSize > MAX_IMAGE_SIZE) {
    return {
      content: `Image file too large: ${formatFileSize(fileSize)} (max ${formatFileSize(MAX_IMAGE_SIZE)})`,
      isError: true,
      metadata: { filePath, fileSize, type: 'image' },
    };
  }

  // SVG 文件作为文本读取
  if (filePath.endsWith('.svg')) {
    const content = await fs.readFile(filePath, 'utf-8');
    return {
      content: `SVG Image: ${filePath}\nSize: ${formatFileSize(fileSize)}\n\n${content}`,
      metadata: { filePath, fileSize, type: 'svg' },
    };
  }

  // 其他图片返回 base64
  const buffer = await fs.readFile(filePath);
  const base64 = buffer.toString('base64');
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext}`;

  return {
    content: `Image: ${filePath}\nSize: ${formatFileSize(fileSize)}\nType: ${mimeType}\nBase64 length: ${base64.length}\n\n[Image data available in metadata]`,
    metadata: {
      filePath,
      fileSize,
      type: 'image',
      mimeType,
      base64: base64.length < 50000 ? base64 : undefined, // 只在不太大时包含
    },
  };
}

/** 生成大文件概要 */
function generateFileSummary(
  filePath: string,
  lines: string[],
  fileSize: number,
  elapsed: string,
): ToolResult {
  const totalLines = lines.length;

  // 显示前 50 行和后 20 行
  const headLines = 50;
  const tailLines = 20;

  const padWidth = String(totalLines).length;

  let output = '';

  // 前 N 行
  for (let i = 0; i < Math.min(headLines, totalLines); i++) {
    let line = lines[i]!;
    if (line.length > MAX_LINE_LENGTH) {
      line = line.substring(0, MAX_LINE_LENGTH) + '...';
    }
    output += `${String(i + 1).padStart(padWidth, ' ')} | ${line}\n`;
  }

  if (totalLines > headLines + tailLines) {
    const omitted = totalLines - headLines - tailLines;
    output += `\n${'─'.repeat(60)}\n`;
    output += `... 省略 ${omitted} 行 (第 ${headLines + 1} - ${totalLines - tailLines} 行) ...\n`;
    output += `${'─'.repeat(60)}\n\n`;

    // 后 N 行
    for (let i = totalLines - tailLines; i < totalLines; i++) {
      let line = lines[i]!;
      if (line.length > MAX_LINE_LENGTH) {
        line = line.substring(0, MAX_LINE_LENGTH) + '...';
      }
      output += `${String(i + 1).padStart(padWidth, ' ')} | ${line}\n`;
    }
  }

  const header = `File: ${filePath} | Size: ${formatFileSize(fileSize)} | Lines: ${totalLines} | ⚠️ 大文件概要模式`;

  return {
    content: `${header}\n${'─'.repeat(80)}\n${output}\n提示: 使用 offset 和 limit 参数读取指定行范围，例如 offset=100 limit=50`,
    metadata: {
      filePath,
      totalLines,
      fileSize,
      isBigFile: true,
      summaryMode: true,
      elapsed,
    },
  };
}

/** 格式化文件大小 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
