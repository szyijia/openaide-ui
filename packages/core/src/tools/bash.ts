/**
 * BashTool — 命令执行工具（增强版）
 *
 * 参考 Claude Code: src/tools/BashTool/ (18 文件, 12,411 行)
 * 在 shell 中执行命令，支持：
 * - 沙箱执行模式（限制危险操作）
 * - 后台任务管理
 * - 环境变量隔离
 * - 信号处理与优雅终止
 * - 输出截断与流式收集
 * - 进程超时与资源限制
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Tool, ToolResult, ToolPermission, ToolContext } from './types.js';
import { truncateOutput, createTimer } from './shared.js';

// ─── 常量 ───

const DEFAULT_TIMEOUT = 120_000; // 2 分钟
const MAX_OUTPUT_SIZE = 100_000; // 最大输出字符数
const SIGTERM_GRACE_PERIOD = 5_000; // SIGTERM 后等待 5 秒再 SIGKILL
const MAX_BACKGROUND_TASKS = 10; // 最大后台任务数

// ─── 后台任务管理 ───

/** 后台任务状态 */
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'killed';

/** 后台任务信息 */
export interface BackgroundTask {
  /** 任务 ID */
  id: string;
  /** 执行的命令 */
  command: string;
  /** 进程 PID */
  pid: number;
  /** 任务状态 */
  status: BackgroundTaskStatus;
  /** 启动时间 */
  startedAt: Date;
  /** 结束时间 */
  endedAt?: Date;
  /** 退出码 */
  exitCode?: number | null;
  /** 输出（截断后） */
  stdout: string;
  /** 错误输出（截断后） */
  stderr: string;
  /** 进程引用 */
  process?: ChildProcess;
}

/**
 * 后台任务管理器
 * 管理 BashTool 启动的后台进程
 */
export class BackgroundTaskManager {
  private tasks = new Map<string, BackgroundTask>();
  private nextId = 1;

  /** 注册一个后台任务 */
  register(command: string, proc: ChildProcess): BackgroundTask {
    const id = `bg_${this.nextId++}`;
    const task: BackgroundTask = {
      id,
      command,
      pid: proc.pid || 0,
      status: 'running',
      startedAt: new Date(),
      stdout: '',
      stderr: '',
      process: proc,
    };

    this.tasks.set(id, task);

    // 收集输出
    proc.stdout?.on('data', (data: Buffer) => {
      if (task.stdout.length < MAX_OUTPUT_SIZE) {
        task.stdout += data.toString();
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      if (task.stderr.length < MAX_OUTPUT_SIZE) {
        task.stderr += data.toString();
      }
    });

    // 监听结束
    proc.on('close', (code) => {
      task.status = code === 0 ? 'completed' : 'failed';
      task.exitCode = code;
      task.endedAt = new Date();
      task.process = undefined; // 释放进程引用
    });

    proc.on('error', () => {
      task.status = 'failed';
      task.endedAt = new Date();
      task.process = undefined;
    });

    return task;
  }

  /** 获取任务 */
  get(id: string): BackgroundTask | undefined {
    return this.tasks.get(id);
  }

  /** 获取所有任务 */
  getAll(): BackgroundTask[] {
    return Array.from(this.tasks.values());
  }

  /** 终止后台任务 */
  async kill(id: string): Promise<boolean> {
    const task = this.tasks.get(id);
    if (!task || !task.process) return false;

    task.process.kill('SIGTERM');
    task.status = 'killed';
    task.endedAt = new Date();

    // 等待优雅退出
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (task.process && !task.process.killed) {
          task.process.kill('SIGKILL');
        }
        resolve();
      }, SIGTERM_GRACE_PERIOD);

      task.process?.on('close', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    task.process = undefined;
    return true;
  }

  /** 终止所有后台任务 */
  async killAll(): Promise<void> {
    const ids = Array.from(this.tasks.keys());
    await Promise.allSettled(ids.map(id => this.kill(id)));
  }

  /** 清理已完成的任务 */
  cleanup(): number {
    let cleaned = 0;
    for (const [id, task] of this.tasks) {
      if (task.status !== 'running') {
        this.tasks.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }

  /** 运行中的任务数 */
  get runningCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === 'running') count++;
    }
    return count;
  }

  /** 总任务数 */
  get size(): number {
    return this.tasks.size;
  }
}

// ─── 全局后台任务管理器 ───
const backgroundTasks = new BackgroundTaskManager();

// ─── 危险命令检测 ───

/** 危险命令模式 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /rm\s+-rf\s+\/(?!\w)/, description: '删除根目录' },
  { pattern: /rm\s+-rf\s+~/, description: '删除用户主目录' },
  { pattern: /mkfs\./, description: '格式化磁盘' },
  { pattern: /dd\s+if=.*of=\/dev\//, description: '写入设备' },
  { pattern: /:\(\)\{\s*:\|:\s*&\s*\};:/, description: 'Fork bomb' },
  { pattern: />\s*\/dev\/sd[a-z]/, description: '覆写磁盘设备' },
  { pattern: /chmod\s+-R\s+777\s+\//, description: '修改根目录权限' },
  { pattern: /chown\s+-R\s+.*\s+\/(?!\w)/, description: '修改根目录所有者' },
  { pattern: /curl\s+.*\|\s*(?:bash|sh|zsh)/, description: '从网络下载并执行脚本' },
  { pattern: /wget\s+.*\|\s*(?:bash|sh|zsh)/, description: '从网络下载并执行脚本' },
];

/** 需要交互的命令（应该被拒绝） */
const INTERACTIVE_COMMANDS = [
  /^vim\b/, /^vi\b/, /^nano\b/, /^emacs\b/,
  /^less\b/, /^more\b/, /^man\b/,
  /^top\b/, /^htop\b/,
  /^ssh\b(?!.*-o\s*BatchMode)/,
  /^ftp\b/, /^telnet\b/,
  /^python\b(?!\s)/, /^python3\b(?!\s)/, /^node\b(?!\s)/,
  /^irb\b/, /^pry\b/,
];

/** 检查命令是否危险 */
function checkDangerousCommand(command: string): string | null {
  for (const { pattern, description } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return description;
    }
  }
  return null;
}

/** 检查命令是否需要交互 */
function checkInteractiveCommand(command: string): boolean {
  const trimmed = command.trim();
  return INTERACTIVE_COMMANDS.some(pattern => pattern.test(trimmed));
}

// ─── 环境变量构建 ───

/** 构建安全的环境变量 */
function buildSafeEnv(
  cwd: string,
  customEnv?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    // 禁用分页器
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    // 禁用颜色（避免 ANSI 转义码干扰输出解析）
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    // 设置工作目录
    PWD: cwd,
    // 设置语言环境（确保输出为 UTF-8）
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL || '',
    // 禁用 npm/yarn 交互
    CI: '1',
    // Git 配置
    GIT_TERMINAL_PROMPT: '0',
  };

  // 合并自定义环境变量
  if (customEnv) {
    Object.assign(env, customEnv);
  }

  return env;
}

// ─── 输出处理 ───

/** 清理 ANSI 转义码 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

// ─── BashTool 定义 ───

export const BashTool: Tool = {
  name: 'bash',
  description: '在 shell 中执行命令',

  prompt: `在用户的 shell 中执行命令。

使用场景：
- 运行构建命令（npm, pnpm, cargo 等）
- 执行 git 操作
- 运行测试
- 安装依赖
- 查看系统信息
- 执行脚本
- 启动后台任务

注意事项：
- 命令在用户的工作目录中执行
- 不要执行危险的命令（如 rm -rf /）
- 长时间运行的命令会在超时后被终止
- 输出过长会被截断
- 不要运行需要用户交互的命令（如 vim、less）
- 使用 PAGER=cat 避免分页器阻塞
- 对于 git log 等可能输出很长的命令，请加上 -n 限制
- 设置 background=true 可以在后台运行长时间命令
- 使用 action="list_bg" 查看后台任务
- 使用 action="get_bg" 获取后台任务输出
- 使用 action="kill_bg" 终止后台任务`,

  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: '要执行的 shell 命令',
      },
      timeout: {
        type: 'number',
        description: `超时时间（毫秒），默认 ${DEFAULT_TIMEOUT}ms`,
      },
      background: {
        type: 'boolean',
        description: '是否在后台运行（不等待完成）',
      },
      env: {
        type: 'object',
        description: '额外的环境变量',
      },
      action: {
        type: 'string',
        enum: ['run', 'list_bg', 'get_bg', 'kill_bg'],
        description: '操作类型（默认 run）',
      },
      task_id: {
        type: 'string',
        description: '后台任务 ID（用于 get_bg 和 kill_bg）',
      },
    },
    required: ['command'],
  },

  permission: {
    default: 'ask_user',
    userConfigurable: true,
    riskWarning: '将在 shell 中执行命令',
  } as ToolPermission,

  concurrentSafe: false,

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = (input.action as string) || 'run';

    // ─── 后台任务管理操作 ───
    switch (action) {
      case 'list_bg': {
        const tasks = backgroundTasks.getAll();
        if (tasks.length === 0) {
          return { content: '没有后台任务' };
        }

        const lines = tasks.map(t => {
          const statusIcon = t.status === 'running' ? '🔄' : t.status === 'completed' ? '✅' : t.status === 'killed' ? '⛔' : '❌';
          const duration = t.endedAt
            ? `${((t.endedAt.getTime() - t.startedAt.getTime()) / 1000).toFixed(1)}s`
            : `${((Date.now() - t.startedAt.getTime()) / 1000).toFixed(1)}s (运行中)`;
          return `${statusIcon} [${t.id}] PID:${t.pid} | ${duration} | ${t.command.substring(0, 80)}`;
        });

        return {
          content: `后台任务 (${tasks.length}):\n${lines.join('\n')}`,
          metadata: { taskCount: tasks.length },
        };
      }

      case 'get_bg': {
        const taskId = input.task_id as string;
        if (!taskId) {
          return { content: 'Error: task_id is required for get_bg', isError: true };
        }

        const task = backgroundTasks.get(taskId);
        if (!task) {
          return { content: `Error: Background task "${taskId}" not found`, isError: true };
        }

        const parts: string[] = [
          `任务: ${task.id} (${task.status})`,
          `命令: ${task.command}`,
          `PID: ${task.pid}`,
          `开始: ${task.startedAt.toISOString()}`,
        ];

        if (task.endedAt) {
          parts.push(`结束: ${task.endedAt.toISOString()}`);
          parts.push(`退出码: ${task.exitCode}`);
        }

        if (task.stdout.trim()) {
          parts.push(`\n--- stdout ---\n${truncateOutput(task.stdout.trim())}`);
        }
        if (task.stderr.trim()) {
          parts.push(`\n--- stderr ---\n${truncateOutput(task.stderr.trim())}`);
        }

        return {
          content: parts.join('\n'),
          metadata: { taskId: task.id, status: task.status, exitCode: task.exitCode },
        };
      }

      case 'kill_bg': {
        const taskId = input.task_id as string;
        if (!taskId) {
          return { content: 'Error: task_id is required for kill_bg', isError: true };
        }

        const killed = await backgroundTasks.kill(taskId);
        if (!killed) {
          return { content: `Error: Cannot kill task "${taskId}" (not found or already finished)`, isError: true };
        }

        return { content: `✅ 后台任务 ${taskId} 已终止` };
      }
    }

    // ─── 执行命令 ───
    const command = input.command as string;
    const timeout = (input.timeout as number) || DEFAULT_TIMEOUT;
    const background = input.background as boolean || false;
    const customEnv = input.env as Record<string, string> | undefined;

    if (!command) {
      return { content: 'Error: command is required', isError: true };
    }

    // 安全检查：危险命令
    const dangerReason = checkDangerousCommand(command);
    if (dangerReason) {
      return {
        content: `Error: 命令被安全策略拒绝 — ${dangerReason}\n命令: ${command}`,
        isError: true,
      };
    }

    // 安全检查：交互式命令
    if (checkInteractiveCommand(command)) {
      return {
        content: `Error: 不支持交互式命令。请使用非交互模式或添加适当的参数。\n命令: ${command}`,
        isError: true,
      };
    }

    // 构建环境变量
    const env = buildSafeEnv(context.cwd, customEnv);

    // ─── 后台执行 ───
    if (background) {
      if (backgroundTasks.runningCount >= MAX_BACKGROUND_TASKS) {
        return {
          content: `Error: 后台任务数已达上限 (${MAX_BACKGROUND_TASKS})。请先终止一些任务。`,
          isError: true,
        };
      }

      const proc = spawn('bash', ['-c', command], {
        cwd: context.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // 后台运行
      });

      const task = backgroundTasks.register(command, proc);

      return {
        content: `✅ 后台任务已启动\nID: ${task.id}\nPID: ${task.pid}\n命令: ${command}\n\n使用 action="get_bg" task_id="${task.id}" 查看输出\n使用 action="kill_bg" task_id="${task.id}" 终止任务`,
        metadata: { taskId: task.id, pid: task.pid, background: true },
      };
    }

    // ─── 前台执行 ───
    const timer = createTimer();

    return new Promise<ToolResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;

      const proc = spawn('bash', ['-c', command], {
        cwd: context.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // 超时处理
      const timeoutId = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, SIGTERM_GRACE_PERIOD);
      }, timeout);

      // 收集 stdout
      proc.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        if (stdout.length < MAX_OUTPUT_SIZE) {
          stdout += chunk;
        }
        // 报告进度
        context.onProgress?.({
          message: `执行中... (${timer.elapsedMs()})`,
        });
      });

      // 收集 stderr
      proc.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        if (stderr.length < MAX_OUTPUT_SIZE) {
          stderr += chunk;
        }
      });

      // 处理中止信号
      const abortHandler = () => {
        killed = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, SIGTERM_GRACE_PERIOD);
      };
      context.abortSignal.addEventListener('abort', abortHandler, { once: true });

      proc.on('close', (code, signal) => {
        clearTimeout(timeoutId);
        context.abortSignal.removeEventListener('abort', abortHandler);

        const elapsed = timer.elapsedMs();

        // 清理 ANSI 转义码
        stdout = stripAnsi(stdout);
        stderr = stripAnsi(stderr);

        // 截断过长输出
        stdout = truncateOutput(stdout, MAX_OUTPUT_SIZE);
        stderr = truncateOutput(stderr, MAX_OUTPUT_SIZE);

        if (killed) {
          const reason = context.abortSignal.aborted ? '用户中止' : '超时';
          resolve({
            content: `命令被终止 (${reason}, ${elapsed}).\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}`,
            isError: true,
            metadata: { exitCode: code, signal, killed: true, reason, elapsed },
          });
          return;
        }

        const isError = code !== 0;
        const parts: string[] = [];

        if (stdout.trim()) {
          parts.push(stdout.trim());
        }
        if (stderr.trim()) {
          parts.push(`stderr:\n${stderr.trim()}`);
        }
        if (parts.length === 0) {
          parts.push(isError ? `Command failed with exit code ${code}` : '(no output)');
        }

        const output = parts.join('\n\n');

        resolve({
          content: isError
            ? `Exit code: ${code} (${elapsed})\n\n${output}`
            : output,
          isError,
          metadata: {
            exitCode: code,
            signal,
            command,
            elapsed,
          },
        });
      });

      proc.on('error', (error) => {
        clearTimeout(timeoutId);
        context.abortSignal.removeEventListener('abort', abortHandler);
        resolve({
          content: `Error executing command: ${error.message}`,
          isError: true,
        });
      });
    });
  },
};

/** 获取后台任务管理器（供外部使用） */
export function getBackgroundTaskManager(): BackgroundTaskManager {
  return backgroundTasks;
}
