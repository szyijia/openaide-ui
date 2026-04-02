/**
 * FileEditTool — 文件编辑工具（增强版）
 *
 * 参考 Claude Code: src/tools/FileEditTool/ (6 文件, 1,812 行)
 * 通过搜索替换的方式精确编辑文件的局部内容
 *
 * 增强功能：
 * - diff 生成（显示变更内容）
 * - 冲突检测（文件在编辑期间被外部修改）
 * - 原子写入（防止写入中断导致文件损坏）
 * - 备份恢复（编辑前自动备份）
 * - 多处替换支持
 * - 编辑上下文验证
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Tool, ToolResult, ToolPermission, ToolContext } from './types.js';
import {
  resolveAndValidatePath,
  atomicWriteFile,
  createBackup,
  generateSimpleDiff,
  addLineNumbers,
  createTimer,
} from './shared.js';

/** 文件内容哈希缓存（用于冲突检测） */
const fileHashCache = new Map<string, { hash: string; mtime: number }>();

/** 计算内容哈希 */
function contentHash(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

/** 更新文件哈希缓存 */
function updateHashCache(filePath: string, content: string, mtime: number): void {
  fileHashCache.set(filePath, { hash: contentHash(content), mtime });
}

/** 检查文件是否被外部修改（冲突检测） */
async function checkConflict(filePath: string, currentContent: string): Promise<boolean> {
  const cached = fileHashCache.get(filePath);
  if (!cached) return false; // 首次编辑，无冲突

  const currentHash = contentHash(currentContent);
  if (cached.hash === currentHash) return false; // 内容未变

  // 检查 mtime
  try {
    const stat = await fs.stat(filePath);
    if (stat.mtimeMs > cached.mtime) {
      // 文件在我们上次读取后被修改了
      return cached.hash !== currentHash;
    }
  } catch {
    // 文件不存在等情况
  }

  return false;
}

export const FileEditTool: Tool = {
  name: 'file_edit',
  description: '通过搜索替换编辑文件的局部内容',

  prompt: `通过搜索替换的方式精确编辑文件的局部内容。

使用方法：
1. 提供 file_path 指定要编辑的文件
2. 提供 old_string 指定要替换的原始文本（必须精确匹配）
3. 提供 new_string 指定替换后的新文本

高级选项：
- replace_all: 替换所有匹配项（默认 false，只替换第一个）
- create_backup: 编辑前创建备份（默认 true）
- show_diff: 显示变更 diff（默认 true）

注意事项：
- old_string 必须与文件中的内容完全匹配（包括空格、缩进、换行）
- 包含足够的上下文（至少 3 行前后文）以确保唯一匹配
- 如果 old_string 匹配到多处且未设置 replace_all，操作会失败
- 如果 old_string 未匹配到任何位置，操作会失败
- 对于创建新文件，请使用 file_write 工具
- 对于大范围修改，考虑使用 file_write 完全重写
- 如果文件在编辑期间被外部修改，会收到冲突警告`,

  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: '要编辑的文件路径',
      },
      old_string: {
        type: 'string',
        description: '要被替换的原始文本（必须精确匹配文件中的内容）',
      },
      new_string: {
        type: 'string',
        description: '替换后的新文本',
      },
      replace_all: {
        type: 'boolean',
        description: '是否替换所有匹配项（默认 false）',
      },
      create_backup: {
        type: 'boolean',
        description: '是否在编辑前创建备份（默认 true）',
      },
      show_diff: {
        type: 'boolean',
        description: '是否显示变更 diff（默认 true）',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },

  permission: {
    default: 'ask_user',
    userConfigurable: true,
    riskWarning: '将修改文件内容',
  } as ToolPermission,

  concurrentSafe: false,

  validate(input: Record<string, unknown>) {
    const oldStr = input.old_string as string;
    const newStr = input.new_string as string;

    if (oldStr === newStr) {
      return { valid: false, message: 'old_string and new_string are identical — no change would be made' };
    }

    if (!oldStr && oldStr !== '') {
      return { valid: false, message: 'old_string is required' };
    }

    return { valid: true };
  },

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const filePath = input.file_path as string;
    const oldString = input.old_string as string;
    const newString = input.new_string as string;
    const replaceAll = (input.replace_all as boolean) ?? false;
    const shouldBackup = (input.create_backup as boolean) ?? true;
    const showDiff = (input.show_diff as boolean) ?? true;

    if (!filePath) {
      return { content: 'Error: file_path is required', isError: true };
    }
    if (oldString === undefined) {
      return { content: 'Error: old_string is required', isError: true };
    }
    if (newString === undefined) {
      return { content: 'Error: new_string is required', isError: true };
    }

    // 路径验证
    const pathResult = resolveAndValidatePath(filePath, context.cwd);
    if (!pathResult.valid) {
      return { content: pathResult.error!, isError: true };
    }
    const resolvedPath = pathResult.resolved;

    const timer = createTimer();

    try {
      // 读取文件
      const content = await fs.readFile(resolvedPath, 'utf-8');
      const stat = await fs.stat(resolvedPath);

      // 冲突检测
      const hasConflict = await checkConflict(resolvedPath, content);
      let conflictWarning = '';
      if (hasConflict) {
        conflictWarning = '\n⚠️ 警告: 文件在上次读取后被外部修改，请确认变更是否正确。';
      }

      // 查找匹配
      const matchCount = countOccurrences(content, oldString);

      if (matchCount === 0) {
        // 尝试给出有用的错误信息
        const hint = generateMatchHint(content, oldString);
        return {
          content: `Error: old_string not found in file "${resolvedPath}".${hint}`,
          isError: true,
        };
      }

      if (matchCount > 1 && !replaceAll) {
        // 显示所有匹配位置
        const positions = findAllPositions(content, oldString);
        const posInfo = positions.map(p => `  第 ${p.line} 行`).join('\n');

        return {
          content: `Error: old_string matches ${matchCount} locations in the file:\n${posInfo}\n\nPlease include more context to make the match unique, or set replace_all=true to replace all occurrences.`,
          isError: true,
        };
      }

      // 创建备份
      let backupPath: string | null = null;
      if (shouldBackup) {
        backupPath = await createBackup(resolvedPath);
      }

      // 执行替换
      let newContent: string;
      let actualReplacements: number;

      if (replaceAll) {
        newContent = content.split(oldString).join(newString);
        actualReplacements = matchCount;
      } else {
        newContent = content.replace(oldString, newString);
        actualReplacements = 1;
      }

      // 原子写入
      await atomicWriteFile(resolvedPath, newContent);

      // 更新哈希缓存
      const newStat = await fs.stat(resolvedPath);
      updateHashCache(resolvedPath, newContent, newStat.mtimeMs);

      // 计算变更统计
      const oldLines = oldString.split('\n').length;
      const newLines = newString.split('\n').length;
      const addedLines = Math.max(0, newLines - oldLines) * actualReplacements;
      const removedLines = Math.max(0, oldLines - newLines) * actualReplacements;

      // 找到变更位置
      const firstMatchPos = content.indexOf(oldString);
      const beforeMatch = content.substring(0, firstMatchPos);
      const matchLineNum = beforeMatch.split('\n').length;

      // 构建结果
      const infoParts = [
        `✅ 已编辑文件: ${resolvedPath}`,
        `位置: 第 ${matchLineNum} 行`,
        actualReplacements > 1 ? `替换: ${actualReplacements} 处` : '',
        removedLines > 0 ? `删除: ${removedLines} 行` : '',
        addedLines > 0 ? `新增: ${addedLines} 行` : '',
        addedLines === 0 && removedLines === 0 ? `修改: ${oldLines} 行` : '',
        `耗时: ${timer.elapsedMs()}`,
      ].filter(Boolean).join(' | ');

      let result = infoParts;

      if (conflictWarning) {
        result += conflictWarning;
      }

      if (backupPath) {
        result += `\n备份: ${backupPath}`;
      }

      // 生成 diff
      if (showDiff) {
        const diff = generateSimpleDiff(oldString, newString, resolvedPath);
        result += `\n\n\`\`\`diff\n${diff}\n\`\`\``;
      }

      return {
        content: result,
        metadata: {
          filePath: resolvedPath,
          matchLine: matchLineNum,
          oldLines,
          newLines,
          addedLines,
          removedLines,
          replacements: actualReplacements,
          backupPath,
          hasConflict,
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
        content: `Error editing file: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};

// ─── 辅助函数 ───

/** 计算子字符串出现次数 */
function countOccurrences(text: string, search: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(search, pos)) !== -1) {
    count++;
    pos += search.length;
  }
  return count;
}

/** 查找所有匹配位置 */
function findAllPositions(text: string, search: string): Array<{ offset: number; line: number }> {
  const positions: Array<{ offset: number; line: number }> = [];
  let pos = 0;
  while ((pos = text.indexOf(search, pos)) !== -1) {
    const line = text.substring(0, pos).split('\n').length;
    positions.push({ offset: pos, line });
    pos += search.length;
  }
  return positions;
}

/** 生成匹配失败的提示信息 */
function generateMatchHint(content: string, oldString: string): string {
  // 尝试去除首尾空白后匹配
  const trimmedOld = oldString.trim();
  const trimmedCount = countOccurrences(content, trimmedOld);

  if (trimmedCount > 0) {
    return '\n提示: 去除首尾空白后可以匹配到，请检查缩进和空格是否正确。';
  }

  // 尝试匹配第一行
  const firstLine = oldString.split('\n')[0]?.trim();
  if (firstLine && firstLine.length > 10 && content.includes(firstLine)) {
    return `\n提示: 文件中包含 "${firstLine.substring(0, 60)}..."，但完整的 old_string 不匹配。请检查内容是否完全一致。`;
  }

  // 尝试忽略空行差异
  const normalizedOld = oldString.replace(/\r\n/g, '\n');
  if (normalizedOld !== oldString && countOccurrences(content, normalizedOld) > 0) {
    return '\n提示: 检测到换行符差异（CRLF vs LF），请使用正确的换行符。';
  }

  // 尝试模糊匹配（忽略连续空白差异）
  const fuzzyOld = oldString.replace(/\s+/g, ' ').trim();
  const fuzzyContent = content.replace(/\s+/g, ' ');
  if (fuzzyContent.includes(fuzzyOld)) {
    return '\n提示: 忽略空白差异后可以匹配到，请检查空格和缩进是否与文件中完全一致。';
  }

  return '';
}

/** 导出哈希缓存更新函数（供 FileReadTool 使用） */
export { updateHashCache };
