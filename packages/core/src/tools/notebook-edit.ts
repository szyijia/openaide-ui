/**
 * NotebookEditTool — Jupyter Notebook 编辑工具
 *
 * 参考 Claude Code: src/tools/NotebookEditTool/
 * 支持对 .ipynb 文件进行结构化编辑操作
 *
 * 功能：
 * - 添加/删除/修改 Notebook 单元格
 * - 修改单元格类型（code / markdown / raw）
 * - 修改单元格内容
 * - 移动单元格位置
 * - 清除单元格输出
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool, ToolResult, ToolPermission, ToolContext } from './types.js';

/** Notebook 单元格类型 */
export type CellType = 'code' | 'markdown' | 'raw';

/** Notebook 单元格 */
export interface NotebookCell {
  cell_type: CellType;
  source: string[];
  metadata: Record<string, unknown>;
  outputs?: Array<Record<string, unknown>>;
  execution_count?: number | null;
}

/** Notebook 文件结构 (ipynb JSON 格式) */
export interface NotebookDocument {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: NotebookCell[];
}

/** 编辑操作类型 */
export type NotebookEditAction =
  | 'add_cell'       // 添加单元格
  | 'delete_cell'    // 删除单元格
  | 'edit_cell'      // 编辑单元格内容
  | 'move_cell'      // 移动单元格
  | 'change_type'    // 修改单元格类型
  | 'clear_outputs'  // 清除输出
  | 'clear_all_outputs'; // 清除所有输出

export const NotebookEditTool: Tool = {
  name: 'notebook_edit',
  description: '编辑 Jupyter Notebook (.ipynb) 文件',

  prompt: `编辑 Jupyter Notebook (.ipynb) 文件的单元格。

支持的操作：
- add_cell: 在指定位置添加新单元格
- delete_cell: 删除指定位置的单元格
- edit_cell: 修改指定单元格的内容
- move_cell: 将单元格移动到新位置
- change_type: 修改单元格类型（code/markdown/raw）
- clear_outputs: 清除指定单元格的输出
- clear_all_outputs: 清除所有单元格的输出

参数说明：
- file_path: Notebook 文件路径
- action: 操作类型
- cell_index: 目标单元格索引（从 0 开始）
- content: 单元格内容（用于 add_cell 和 edit_cell）
- cell_type: 单元格类型（用于 add_cell 和 change_type）
- target_index: 目标位置（用于 move_cell）

注意事项：
- cell_index 从 0 开始计数
- 添加单元格时，如果不指定 cell_index，默认添加到末尾
- 编辑内容时，content 中的换行会被正确处理`,

  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Notebook 文件路径 (.ipynb)',
      },
      action: {
        type: 'string',
        enum: ['add_cell', 'delete_cell', 'edit_cell', 'move_cell', 'change_type', 'clear_outputs', 'clear_all_outputs'],
        description: '编辑操作类型',
      },
      cell_index: {
        type: 'number',
        description: '目标单元格索引（从 0 开始）',
      },
      content: {
        type: 'string',
        description: '单元格内容（用于 add_cell 和 edit_cell）',
      },
      cell_type: {
        type: 'string',
        enum: ['code', 'markdown', 'raw'],
        description: '单元格类型（用于 add_cell 和 change_type）',
      },
      target_index: {
        type: 'number',
        description: '目标位置索引（用于 move_cell）',
      },
    },
    required: ['file_path', 'action'],
  },

  permission: {
    default: 'ask_user',
    userConfigurable: true,
    riskWarning: '将修改 Notebook 文件',
  } as ToolPermission,

  concurrentSafe: false,

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const filePath = input.file_path as string;
    const action = input.action as NotebookEditAction;
    const cellIndex = input.cell_index as number | undefined;
    const content = input.content as string | undefined;
    const cellType = (input.cell_type as CellType) || 'code';
    const targetIndex = input.target_index as number | undefined;

    if (!filePath) {
      return { content: 'Error: file_path is required', isError: true };
    }
    if (!action) {
      return { content: 'Error: action is required', isError: true };
    }

    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(context.cwd, filePath);

    // 检查文件扩展名
    if (!resolvedPath.endsWith('.ipynb')) {
      return {
        content: `Error: File "${resolvedPath}" is not a Jupyter Notebook (.ipynb)`,
        isError: true,
      };
    }

    try {
      // 读取并解析 Notebook
      let notebook: NotebookDocument;

      if (action === 'add_cell' && !(await fileExists(resolvedPath))) {
        // 如果文件不存在且是添加操作，创建新 Notebook
        notebook = createEmptyNotebook();
      } else {
        const raw = await fs.readFile(resolvedPath, 'utf-8');
        notebook = JSON.parse(raw) as NotebookDocument;
      }

      if (!notebook.cells) {
        notebook.cells = [];
      }

      const totalCells = notebook.cells.length;

      // 执行操作
      switch (action) {
        case 'add_cell': {
          const newCell = createCell(cellType, content || '');
          const insertAt = cellIndex !== undefined ? cellIndex : totalCells;

          if (insertAt < 0 || insertAt > totalCells) {
            return {
              content: `Error: cell_index ${insertAt} out of range (0-${totalCells})`,
              isError: true,
            };
          }

          notebook.cells.splice(insertAt, 0, newCell);

          await writeNotebook(resolvedPath, notebook);
          return {
            content: `✅ 已在位置 ${insertAt} 添加 ${cellType} 单元格 (共 ${notebook.cells.length} 个单元格)`,
            metadata: { action, cellIndex: insertAt, cellType, totalCells: notebook.cells.length },
          };
        }

        case 'delete_cell': {
          if (cellIndex === undefined) {
            return { content: 'Error: cell_index is required for delete_cell', isError: true };
          }
          if (cellIndex < 0 || cellIndex >= totalCells) {
            return {
              content: `Error: cell_index ${cellIndex} out of range (0-${totalCells - 1})`,
              isError: true,
            };
          }

          const deleted = notebook.cells.splice(cellIndex, 1)[0]!;
          await writeNotebook(resolvedPath, notebook);
          return {
            content: `✅ 已删除位置 ${cellIndex} 的 ${deleted.cell_type} 单元格 (剩余 ${notebook.cells.length} 个)`,
            metadata: { action, cellIndex, deletedType: deleted.cell_type, totalCells: notebook.cells.length },
          };
        }

        case 'edit_cell': {
          if (cellIndex === undefined) {
            return { content: 'Error: cell_index is required for edit_cell', isError: true };
          }
          if (content === undefined) {
            return { content: 'Error: content is required for edit_cell', isError: true };
          }
          if (cellIndex < 0 || cellIndex >= totalCells) {
            return {
              content: `Error: cell_index ${cellIndex} out of range (0-${totalCells - 1})`,
              isError: true,
            };
          }

          const cell = notebook.cells[cellIndex]!;
          cell.source = contentToSource(content);

          // 编辑代码单元格时清除旧输出
          if (cell.cell_type === 'code') {
            cell.outputs = [];
            cell.execution_count = null;
          }

          await writeNotebook(resolvedPath, notebook);
          return {
            content: `✅ 已编辑位置 ${cellIndex} 的 ${cell.cell_type} 单元格`,
            metadata: { action, cellIndex, cellType: cell.cell_type },
          };
        }

        case 'move_cell': {
          if (cellIndex === undefined) {
            return { content: 'Error: cell_index is required for move_cell', isError: true };
          }
          if (targetIndex === undefined) {
            return { content: 'Error: target_index is required for move_cell', isError: true };
          }
          if (cellIndex < 0 || cellIndex >= totalCells) {
            return {
              content: `Error: cell_index ${cellIndex} out of range (0-${totalCells - 1})`,
              isError: true,
            };
          }
          if (targetIndex < 0 || targetIndex >= totalCells) {
            return {
              content: `Error: target_index ${targetIndex} out of range (0-${totalCells - 1})`,
              isError: true,
            };
          }

          const [movedCell] = notebook.cells.splice(cellIndex, 1);
          notebook.cells.splice(targetIndex, 0, movedCell!);

          await writeNotebook(resolvedPath, notebook);
          return {
            content: `✅ 已将单元格从位置 ${cellIndex} 移动到位置 ${targetIndex}`,
            metadata: { action, fromIndex: cellIndex, toIndex: targetIndex },
          };
        }

        case 'change_type': {
          if (cellIndex === undefined) {
            return { content: 'Error: cell_index is required for change_type', isError: true };
          }
          if (cellIndex < 0 || cellIndex >= totalCells) {
            return {
              content: `Error: cell_index ${cellIndex} out of range (0-${totalCells - 1})`,
              isError: true,
            };
          }

          const cell = notebook.cells[cellIndex]!;
          const oldType = cell.cell_type;
          cell.cell_type = cellType;

          // 类型变更时清理不兼容的字段
          if (cellType !== 'code') {
            delete cell.outputs;
            delete cell.execution_count;
          } else if (!cell.outputs) {
            cell.outputs = [];
            cell.execution_count = null;
          }

          await writeNotebook(resolvedPath, notebook);
          return {
            content: `✅ 已将位置 ${cellIndex} 的单元格类型从 ${oldType} 改为 ${cellType}`,
            metadata: { action, cellIndex, oldType, newType: cellType },
          };
        }

        case 'clear_outputs': {
          if (cellIndex === undefined) {
            return { content: 'Error: cell_index is required for clear_outputs', isError: true };
          }
          if (cellIndex < 0 || cellIndex >= totalCells) {
            return {
              content: `Error: cell_index ${cellIndex} out of range (0-${totalCells - 1})`,
              isError: true,
            };
          }

          const cell = notebook.cells[cellIndex]!;
          if (cell.cell_type === 'code') {
            cell.outputs = [];
            cell.execution_count = null;
          }

          await writeNotebook(resolvedPath, notebook);
          return {
            content: `✅ 已清除位置 ${cellIndex} 的单元格输出`,
            metadata: { action, cellIndex },
          };
        }

        case 'clear_all_outputs': {
          let cleared = 0;
          for (const cell of notebook.cells) {
            if (cell.cell_type === 'code' && cell.outputs && cell.outputs.length > 0) {
              cell.outputs = [];
              cell.execution_count = null;
              cleared++;
            }
          }

          await writeNotebook(resolvedPath, notebook);
          return {
            content: `✅ 已清除 ${cleared} 个单元格的输出 (共 ${totalCells} 个单元格)`,
            metadata: { action, clearedCount: cleared, totalCells },
          };
        }

        default:
          return {
            content: `Error: Unknown action "${action}"`,
            isError: true,
          };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { content: `Error: File not found: "${resolvedPath}"`, isError: true };
      }
      if (error instanceof SyntaxError) {
        return { content: `Error: Invalid Notebook JSON format: ${error.message}`, isError: true };
      }
      return {
        content: `Error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  },
};

// ─── 辅助函数 ───

/** 检查文件是否存在 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 创建空 Notebook */
function createEmptyNotebook(): NotebookDocument {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: {
        display_name: 'Python 3',
        language: 'python',
        name: 'python3',
      },
      language_info: {
        name: 'python',
        version: '3.10.0',
      },
    },
    cells: [],
  };
}

/** 创建新单元格 */
function createCell(type: CellType, content: string): NotebookCell {
  const cell: NotebookCell = {
    cell_type: type,
    source: contentToSource(content),
    metadata: {},
  };

  if (type === 'code') {
    cell.outputs = [];
    cell.execution_count = null;
  }

  return cell;
}

/** 将内容字符串转换为 Notebook source 格式（按行分割，保留换行符） */
function contentToSource(content: string): string[] {
  if (!content) return [];
  const lines = content.split('\n');
  // Notebook 格式：除最后一行外，每行末尾都有 \n
  return lines.map((line, i) => (i < lines.length - 1 ? line + '\n' : line));
}

/** 写入 Notebook 文件 */
async function writeNotebook(filePath: string, notebook: NotebookDocument): Promise<void> {
  // 确保目录存在
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  // 使用 1 个空格缩进（与 Jupyter 默认格式一致）
  const json = JSON.stringify(notebook, null, 1) + '\n';
  await fs.writeFile(filePath, json, 'utf-8');
}
