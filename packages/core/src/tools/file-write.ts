/**
 * FileWriteTool — 文件写入工具（增强版）
 *
 * 参考 Claude Code: src/tools/FileWriteTool/ (3 文件, 856 行)
 * 创建新文件或完全覆盖已有文件
 *
 * 增强功能：
 * - 目录自动创建
 * - 路径安全验证
 * - 原子写入（防止写入中断导致文件损坏）
 * - 覆盖前自动备份
 * - 文件权限检查
 * - 编码支持
 * - 写入确认（新建 vs 覆盖）
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool, ToolResult, ToolPermission, ToolContext } from './types.js';
import {
  resolveAndValidatePath,
  atomicWriteFile,
  createBackup,
  getFileInfo,
  isBinaryFile,
  createTimer,
} from './shared.js';

/** 最大写入文件大小 */
const MAX_WRITE_SIZE = 10 * 1024 * 1024; // 10MB

export const FileWriteTool: Tool = {
  name: 'file_write',
  description: '创建新文件或覆盖已有文件的全部内容',

  prompt: `创建新文件或完全覆盖已有文件的内容。

使用场景：
- 创建新的源代码文件
- 创建配置文件
- 写入生成的内容
- 完全重写文件

高级选项：
- encoding: 文件编码（默认 utf-8）
- create_backup: 覆盖已有文件时是否创建备份（默认 true）
- create_directories: 是否自动创建不存在的目录（默认 true）

注意事项：
- 如果文件已存在，会完全覆盖原有内容（默认会创建备份）
- 如果目录不存在，会自动创建
- 对于已有文件的局部修改，请使用 file_edit 工具而非此工具
- 路径必须是绝对路径或相对于当前工作目录的路径
- 不能写入受保护的系统路径`,

  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: '要写入的文件路径（绝对路径或相对路径）',
      },
      content: {
        type: 'string',
        description: '要写入的文件内容',
      },
      encoding: {
        type: 'string',
        description: '文件编码（默认 utf-8）',
      },
      create_backup: {
        type: 'boolean',
        description: '覆盖已有文件时是否创建备份（默认 true）',
      },
      create_directories: {
        type: 'boolean',
        description: '是否自动创建不存在的目录（默认 true）',
      },
    },
    required: ['file_path', 'content'],
  },

  permission: {
    default: 'ask_user',
    userConfigurable: true,
    riskWarning: '将创建或覆盖文件',
  } as ToolPermission,

  concurrentSafe: false,

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const filePath = input.file_path as string;
    const content = input.content as string;
    const encoding = (input.encoding as BufferEncoding) || 'utf-8';
    const shouldBackup = (input.create_backup as boolean) ?? true;
    const createDirs = (input.create_directories as boolean) ?? true;

    if (!filePath) {
      return { content: 'Error: file_path is required', isError: true };
    }
    if (content === undefined || content === null) {
      return { content: 'Error: content is required', isError: true };
    }

    // 路径验证
    const pathResult = resolveAndValidatePath(filePath, context.cwd);
    if (!pathResult.valid) {
      return { content: pathResult.error!, isError: true };
    }
    const resolvedPath = pathResult.resolved;

    // 内容大小检查
    const contentSize = Buffer.byteLength(content, encoding);
    if (contentSize > MAX_WRITE_SIZE) {
      return {
        content: `Error: Content too large (${formatFileSize(contentSize)}). Maximum: ${formatFileSize(MAX_WRITE_SIZE)}`,
        isError: true,
      };
    }

    const timer = createTimer();

    try {
      // 检查文件是否已存在
      const existingInfo = await getFileInfo(resolvedPath);
      const isNew = !existingInfo?.exists || !existingInfo.isFile;
      const oldSize = existingInfo?.size || 0;

      // 如果是目录，拒绝写入
      if (existingInfo?.exists && existingInfo.isDirectory) {
        return {
          content: `Error: "${resolvedPath}" is a directory, cannot write as file`,
          isError: true,
        };
      }

      // 检查父目录
      const dir = path.dirname(resolvedPath);
      const dirInfo = await getFileInfo(dir);

      if (!dirInfo?.exists) {
        if (!createDirs) {
          return {
            content: `Error: Directory does not exist: "${dir}". Set create_directories=true to auto-create.`,
            isError: true,
          };
        }
        await fs.mkdir(dir, { recursive: true });
      }

      // 覆盖前备份
      let backupPath: string | null = null;
      if (!isNew && shouldBackup) {
        backupPath = await createBackup(resolvedPath);
      }

      // 检查写入权限
      if (!isNew) {
        try {
          await fs.access(resolvedPath, fs.constants.W_OK);
        } catch {
          return {
            content: `Error: No write permission for "${resolvedPath}"`,
            isError: true,
          };
        }
      }

      // 原子写入
      await atomicWriteFile(resolvedPath, content, encoding);

      // 计算统计信息
      const lines = content.split('\n').length;
      const size = contentSize;

      const action = isNew ? '✅ 已创建新文件' : '✅ 已覆盖文件';
      const infoParts = [
        `${action}: ${resolvedPath}`,
        `行数: ${lines}`,
        `大小: ${formatFileSize(size)}`,
        !isNew ? `原大小: ${formatFileSize(oldSize)}` : '',
        encoding !== 'utf-8' ? `编码: ${encoding}` : '',
        `耗时: ${timer.elapsedMs()}`,
      ].filter(Boolean);

      let result = infoParts.join(' | ');

      if (backupPath) {
        result += `\n备份: ${backupPath}`;
      }

      return {
        content: result,
        metadata: {
          filePath: resolvedPath,
          isNew,
          lines,
          size,
          oldSize: isNew ? undefined : oldSize,
          backupPath,
          encoding,
          elapsed: timer.elapsedMs(),
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EACCES') {
        return { content: `Error: Permission denied: "${resolvedPath}"`, isError: true };
      }
      return {
        content: `Error writing file: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};

/** 格式化文件大小 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
