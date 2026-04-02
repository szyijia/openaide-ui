/**
 * TodoWriteTool — Todo 列表管理工具
 *
 * 参考 Claude Code: src/tools/TodoWriteTool/
 * 允许 Agent 创建和管理结构化的任务列表，用于跟踪复杂任务的进度
 *
 * 功能：
 * - 创建/更新/删除 Todo 项
 * - 支持任务状态管理（pending, in_progress, completed, cancelled）
 * - 支持任务依赖关系
 * - 持久化存储到会话中
 */

import type { Tool, ToolResult, ToolPermission, ToolContext } from './types.js';

/** Todo 项状态 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

/** 单个 Todo 项 */
export interface TodoItem {
  /** 唯一标识 */
  id: string;
  /** 任务描述 */
  content: string;
  /** 当前状态 */
  status: TodoStatus;
  /** 依赖的其他任务 ID */
  dependencies: string[];
  /** 创建时间 */
  createdAt: string;
  /** 最后更新时间 */
  updatedAt: string;
}

/** Todo 列表变更回调 */
export type TodoChangeCallback = (todos: TodoItem[]) => void;

/**
 * Todo 列表管理器
 * 维护当前会话的 Todo 列表状态
 */
export class TodoManager {
  private todos: TodoItem[] = [];
  private onChange?: TodoChangeCallback;

  constructor(onChange?: TodoChangeCallback) {
    this.onChange = onChange;
  }

  /** 获取所有 Todo 项 */
  getAll(): TodoItem[] {
    return [...this.todos];
  }

  /** 根据 ID 获取 Todo 项 */
  getById(id: string): TodoItem | undefined {
    return this.todos.find(t => t.id === id);
  }

  /** 设置完整的 Todo 列表（替换） */
  setAll(todos: TodoItem[]): void {
    this.todos = todos.map(t => ({
      ...t,
      updatedAt: new Date().toISOString(),
    }));
    this.notifyChange();
  }

  /** 添加单个 Todo 项 */
  add(item: Omit<TodoItem, 'createdAt' | 'updatedAt'>): TodoItem {
    const now = new Date().toISOString();
    const todo: TodoItem = {
      ...item,
      createdAt: now,
      updatedAt: now,
    };
    this.todos.push(todo);
    this.notifyChange();
    return todo;
  }

  /** 更新 Todo 项状态 */
  updateStatus(id: string, status: TodoStatus): boolean {
    const todo = this.todos.find(t => t.id === id);
    if (!todo) return false;
    todo.status = status;
    todo.updatedAt = new Date().toISOString();
    this.notifyChange();
    return true;
  }

  /** 更新 Todo 项内容 */
  update(id: string, updates: Partial<Pick<TodoItem, 'content' | 'status' | 'dependencies'>>): boolean {
    const todo = this.todos.find(t => t.id === id);
    if (!todo) return false;
    if (updates.content !== undefined) todo.content = updates.content;
    if (updates.status !== undefined) todo.status = updates.status;
    if (updates.dependencies !== undefined) todo.dependencies = updates.dependencies;
    todo.updatedAt = new Date().toISOString();
    this.notifyChange();
    return true;
  }

  /** 删除 Todo 项 */
  remove(id: string): boolean {
    const index = this.todos.findIndex(t => t.id === id);
    if (index === -1) return false;
    this.todos.splice(index, 1);
    this.notifyChange();
    return true;
  }

  /** 清空所有 Todo */
  clear(): void {
    this.todos = [];
    this.notifyChange();
  }

  /** 获取统计信息 */
  getStats(): { total: number; pending: number; inProgress: number; completed: number; cancelled: number } {
    return {
      total: this.todos.length,
      pending: this.todos.filter(t => t.status === 'pending').length,
      inProgress: this.todos.filter(t => t.status === 'in_progress').length,
      completed: this.todos.filter(t => t.status === 'completed').length,
      cancelled: this.todos.filter(t => t.status === 'cancelled').length,
    };
  }

  /** 格式化为可读文本 */
  formatAsText(): string {
    if (this.todos.length === 0) return '(无任务)';

    const statusIcons: Record<TodoStatus, string> = {
      pending: '⬜',
      in_progress: '🔄',
      completed: '✅',
      cancelled: '❌',
    };

    const lines = this.todos.map(t => {
      const icon = statusIcons[t.status];
      const deps = t.dependencies.length > 0
        ? ` (依赖: ${t.dependencies.join(', ')})`
        : '';
      return `${icon} [${t.id}] ${t.content}${deps}`;
    });

    const stats = this.getStats();
    lines.push('');
    lines.push(`--- 共 ${stats.total} 项 | ⬜ ${stats.pending} 待处理 | 🔄 ${stats.inProgress} 进行中 | ✅ ${stats.completed} 已完成 | ❌ ${stats.cancelled} 已取消 ---`);

    return lines.join('\n');
  }

  private notifyChange(): void {
    this.onChange?.(this.getAll());
  }
}

/**
 * 创建 TodoWriteTool
 *
 * @param todoManager - Todo 管理器实例（跨工具调用共享状态）
 */
export function createTodoWriteTool(todoManager: TodoManager): Tool {
  return {
    name: 'todo_write',
    description: '创建和管理任务列表，用于跟踪复杂任务的进度',

    prompt: `创建和管理结构化的任务列表（Todo List）。

使用场景：
- 将复杂任务分解为多个子任务
- 跟踪多步骤工作的进度
- 在完成任务后标记为已完成
- 管理任务之间的依赖关系

操作方式：
- 提供 todos 数组来设置完整的任务列表
- 每个 todo 项包含: id, content, status, dependencies

任务状态：
- pending: 待处理
- in_progress: 进行中（同一时间建议只有一个）
- completed: 已完成
- cancelled: 已取消

注意事项：
- 每次调用会替换整个任务列表
- 完成任务后立即更新状态
- 使用有意义的 id 便于引用
- 合理设置依赖关系`,

    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: '任务唯一标识',
              },
              content: {
                type: 'string',
                description: '任务描述',
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                description: '任务状态',
              },
              dependencies: {
                type: 'array',
                items: { type: 'string' },
                description: '依赖的其他任务 ID 列表',
              },
            },
            required: ['id', 'content', 'status'],
          },
          description: '完整的任务列表',
        },
      },
      required: ['todos'],
    },

    permission: {
      default: 'always_allow',
      userConfigurable: false,
    } as ToolPermission,

    concurrentSafe: false,

    validate(input: Record<string, unknown>) {
      const todos = input.todos as Array<Record<string, unknown>> | undefined;
      if (!todos || !Array.isArray(todos)) {
        return { valid: false, message: 'todos must be an array' };
      }

      // 检查 ID 唯一性
      const ids = new Set<string>();
      for (const todo of todos) {
        if (!todo.id || typeof todo.id !== 'string') {
          return { valid: false, message: 'Each todo must have a string id' };
        }
        if (ids.has(todo.id as string)) {
          return { valid: false, message: `Duplicate todo id: "${todo.id}"` };
        }
        ids.add(todo.id as string);
      }

      // 检查依赖引用有效性
      for (const todo of todos) {
        const deps = (todo.dependencies as string[]) || [];
        for (const dep of deps) {
          if (!ids.has(dep)) {
            return { valid: false, message: `Todo "${todo.id}" depends on unknown id "${dep}"` };
          }
          if (dep === todo.id) {
            return { valid: false, message: `Todo "${todo.id}" cannot depend on itself` };
          }
        }
      }

      // 检查状态值有效性
      const validStatuses = ['pending', 'in_progress', 'completed', 'cancelled'];
      for (const todo of todos) {
        if (!validStatuses.includes(todo.status as string)) {
          return { valid: false, message: `Invalid status "${todo.status}" for todo "${todo.id}"` };
        }
      }

      return { valid: true };
    },

    async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
      const todosInput = input.todos as Array<{
        id: string;
        content: string;
        status: TodoStatus;
        dependencies?: string[];
      }>;

      // 转换为 TodoItem 并设置到管理器
      const items: TodoItem[] = todosInput.map(t => ({
        id: t.id,
        content: t.content,
        status: t.status,
        dependencies: t.dependencies || [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

      // 保留已有 todo 的创建时间
      const existing = todoManager.getAll();
      const existingMap = new Map(existing.map(t => [t.id, t]));

      for (const item of items) {
        const prev = existingMap.get(item.id);
        if (prev) {
          item.createdAt = prev.createdAt;
          // 如果内容和状态都没变，保留原更新时间
          if (prev.content === item.content && prev.status === item.status) {
            item.updatedAt = prev.updatedAt;
          }
        }
      }

      todoManager.setAll(items);

      // 返回格式化的任务列表
      const stats = todoManager.getStats();
      const summary = `任务列表已更新 (共 ${stats.total} 项: ⬜${stats.pending} 🔄${stats.inProgress} ✅${stats.completed} ❌${stats.cancelled})`;

      return {
        content: `${summary}\n\n${todoManager.formatAsText()}`,
        metadata: {
          stats,
          todoCount: items.length,
        },
      };
    },
  };
}
