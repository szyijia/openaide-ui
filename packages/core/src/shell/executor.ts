/**
 * Shell/Bash 执行引擎
 *
 * 参考 Claude Code: src/utils/bash/ (23 文件, 12,306 行) + src/utils/shell/ (10 文件, 3,069 行)
 *
 * 独立的 Shell 执行基础设施，供 BashTool、GrepTool、Git 操作等模块复用。
 *
 * 功能：
 * 1. Shell 检测与配置（bash/zsh/sh）
 * 2. 安全的命令执行（超时、输出限制、信号处理）
 * 3. 环境变量隔离
 * 4. 进程管理（前台/后台、优雅终止）
 * 5. 输出处理（ANSI 清理、截断、流式收集）
 * 6. 命令安全检查
 */

import { spawn, execFile, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

const execFileAsync = promisify(execFile);

// ─── 常量 ───

/** 默认命令超时（2 分钟） */
const DEFAULT_TIMEOUT_MS = 120_000;

/** 最大输出大小（100KB） */
const MAX_OUTPUT_SIZE = 100_000;

/** SIGTERM 后等待优雅退出的时间 */
const SIGTERM_GRACE_MS = 5_000;

/** 默认 Shell */
const DEFAULT_SHELL = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';

// ─── Shell 检测 ───

/** Shell 类型 */
export type ShellType = 'bash' | 'zsh' | 'sh' | 'fish' | 'cmd' | 'powershell' | 'unknown';

/** Shell 信息 */
export interface ShellInfo {
  /** Shell 类型 */
  type: ShellType;
  /** Shell 可执行文件路径 */
  path: string;
  /** Shell 版本 */
  version?: string;
}

/** 检测当前系统的默认 Shell */
export async function detectShell(): Promise<ShellInfo> {
  // 优先使用 SHELL 环境变量
  const shellEnv = process.env.SHELL;

  if (shellEnv) {
    const type = identifyShellType(shellEnv);
    const version = await getShellVersion(shellEnv);
    return { type, path: shellEnv, version };
  }

  // 尝试常见 Shell 路径
  const candidates = ['/bin/bash', '/usr/bin/bash', '/bin/zsh', '/usr/bin/zsh', '/bin/sh'];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      const type = identifyShellType(candidate);
      const version = await getShellVersion(candidate);
      return { type, path: candidate, version };
    } catch {
      continue;
    }
  }

  return { type: 'sh', path: '/bin/sh' };
}

/** 根据路径识别 Shell 类型 */
function identifyShellType(shellPath: string): ShellType {
  const name = path.basename(shellPath).toLowerCase();
  if (name.includes('bash')) return 'bash';
  if (name.includes('zsh')) return 'zsh';
  if (name.includes('fish')) return 'fish';
  if (name.includes('powershell') || name.includes('pwsh')) return 'powershell';
  if (name.includes('cmd')) return 'cmd';
  if (name === 'sh') return 'sh';
  return 'unknown';
}

/** 获取 Shell 版本 */
async function getShellVersion(shellPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(shellPath, ['--version'], {
      timeout: 5000,
      maxBuffer: 1024,
    });
    // 取第一行
    return stdout.split('\n')[0]?.trim();
  } catch {
    return undefined;
  }
}

// ─── 环境变量 ───

/** 环境变量配置选项 */
export interface EnvOptions {
  /** 工作目录 */
  cwd: string;
  /** 额外的环境变量 */
  extra?: Record<string, string>;
  /** 是否继承当前进程的环境变量（默认 true） */
  inheritEnv?: boolean;
  /** 是否禁用分页器（默认 true） */
  disablePager?: boolean;
  /** 是否禁用颜色（默认 true） */
  disableColor?: boolean;
  /** 是否设置 CI 模式（默认 true） */
  ciMode?: boolean;
}

/** 构建安全的环境变量 */
export function buildSafeEnv(options: EnvOptions): Record<string, string> {
  const env: Record<string, string> = {};

  // 继承当前进程环境
  if (options.inheritEnv !== false) {
    Object.assign(env, process.env as Record<string, string>);
  }

  // 设置工作目录
  env.PWD = options.cwd;

  // 禁用分页器
  if (options.disablePager !== false) {
    env.PAGER = 'cat';
    env.GIT_PAGER = 'cat';
  }

  // 禁用颜色
  if (options.disableColor !== false) {
    env.NO_COLOR = '1';
    env.FORCE_COLOR = '0';
  }

  // CI 模式（禁用交互式提示）
  if (options.ciMode !== false) {
    env.CI = '1';
    env.GIT_TERMINAL_PROMPT = '0';
  }

  // 确保 UTF-8
  env.LANG = env.LANG || 'en_US.UTF-8';

  // 合并额外环境变量
  if (options.extra) {
    Object.assign(env, options.extra);
  }

  return env;
}

// ─── 命令安全检查 ───

/** 危险命令模式 */
export interface DangerousPattern {
  pattern: RegExp;
  description: string;
  severity: 'critical' | 'warning';
}

/** 内置危险命令模式 */
const BUILTIN_DANGEROUS_PATTERNS: DangerousPattern[] = [
  { pattern: /rm\s+-rf\s+\/(?!\w)/, description: '删除根目录', severity: 'critical' },
  { pattern: /rm\s+-rf\s+~/, description: '删除用户主目录', severity: 'critical' },
  { pattern: /mkfs\./, description: '格式化磁盘', severity: 'critical' },
  { pattern: /dd\s+if=.*of=\/dev\//, description: '写入设备', severity: 'critical' },
  { pattern: /:\(\)\{\s*:\|:\s*&\s*\};:/, description: 'Fork bomb', severity: 'critical' },
  { pattern: />\s*\/dev\/sd[a-z]/, description: '覆写磁盘设备', severity: 'critical' },
  { pattern: /chmod\s+-R\s+777\s+\//, description: '修改根目录权限', severity: 'critical' },
  { pattern: /chown\s+-R\s+.*\s+\/(?!\w)/, description: '修改根目录所有者', severity: 'critical' },
  { pattern: /curl\s+.*\|\s*(?:bash|sh|zsh)/, description: '从网络下载并执行脚本', severity: 'warning' },
  { pattern: /wget\s+.*\|\s*(?:bash|sh|zsh)/, description: '从网络下载并执行脚本', severity: 'warning' },
];

/** 交互式命令模式 */
const INTERACTIVE_PATTERNS: RegExp[] = [
  /^vim\b/, /^vi\b/, /^nano\b/, /^emacs\b/,
  /^less\b/, /^more\b/, /^man\b/,
  /^top\b/, /^htop\b/,
  /^ssh\b(?!.*-o\s*BatchMode)/,
  /^ftp\b/, /^telnet\b/,
  /^python\b(?!\s)/, /^python3\b(?!\s)/, /^node\b(?!\s)/,
  /^irb\b/, /^pry\b/,
];

/** 命令安全检查结果 */
export interface CommandSafetyCheck {
  safe: boolean;
  reason?: string;
  severity?: 'critical' | 'warning' | 'interactive';
}

/**
 * 检查命令安全性
 * @param command 要检查的命令
 * @param extraPatterns 额外的危险模式
 */
export function checkCommandSafety(
  command: string,
  extraPatterns?: DangerousPattern[],
): CommandSafetyCheck {
  const allPatterns = [...BUILTIN_DANGEROUS_PATTERNS, ...(extraPatterns || [])];

  // 检查危险命令
  for (const { pattern, description, severity } of allPatterns) {
    if (pattern.test(command)) {
      return { safe: false, reason: description, severity };
    }
  }

  // 检查交互式命令
  const trimmed = command.trim();
  for (const pattern of INTERACTIVE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { safe: false, reason: '不支持交互式命令', severity: 'interactive' };
    }
  }

  return { safe: true };
}

// ─── 输出处理 ───

/** 清理 ANSI 转义码 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

/** 截断输出到指定大小 */
export function truncateOutput(text: string, maxSize: number = MAX_OUTPUT_SIZE): string {
  if (text.length <= maxSize) return text;

  const half = Math.floor(maxSize / 2) - 50;
  const truncatedLines = text.substring(half, text.length - half).split('\n').length;
  return (
    text.substring(0, half) +
    `\n\n... [已截断 ${truncatedLines} 行] ...\n\n` +
    text.substring(text.length - half)
  );
}

// ─── 命令执行 ───

/** 命令执行选项 */
export interface ExecOptions {
  /** 工作目录 */
  cwd: string;
  /** 超时（毫秒） */
  timeout?: number;
  /** 最大输出大小（字符数） */
  maxOutput?: number;
  /** 环境变量 */
  env?: Record<string, string>;
  /** Shell 路径 */
  shell?: string;
  /** 中止信号 */
  abortSignal?: AbortSignal;
  /** 输出回调（流式） */
  onStdout?: (chunk: string) => void;
  /** 错误输出回调（流式） */
  onStderr?: (chunk: string) => void;
  /** 是否清理 ANSI 转义码（默认 true） */
  stripAnsi?: boolean;
}

/** 命令执行结果 */
export interface ExecResult {
  /** 标准输出 */
  stdout: string;
  /** 标准错误 */
  stderr: string;
  /** 退出码 */
  exitCode: number | null;
  /** 终止信号 */
  signal: string | null;
  /** 是否被终止 */
  killed: boolean;
  /** 终止原因 */
  killReason?: 'timeout' | 'abort' | 'signal';
  /** 执行时间（毫秒） */
  durationMs: number;
}

/**
 * 执行 Shell 命令
 *
 * 核心执行函数，提供：
 * - 超时控制
 * - 输出大小限制
 * - 信号处理（SIGTERM → SIGKILL）
 * - 中止信号支持
 * - 流式输出回调
 */
export function execCommand(command: string, options: ExecOptions): Promise<ExecResult> {
  const {
    cwd,
    timeout = DEFAULT_TIMEOUT_MS,
    maxOutput = MAX_OUTPUT_SIZE,
    env,
    shell = DEFAULT_SHELL,
    abortSignal,
    onStdout,
    onStderr,
    stripAnsi: shouldStripAnsi = true,
  } = options;

  return new Promise<ExecResult>((resolve) => {
    const startTime = performance.now();
    let stdout = '';
    let stderr = '';
    let killed = false;
    let killReason: ExecResult['killReason'];

    const proc = spawn(shell, ['-c', command], {
      cwd,
      env: env || buildSafeEnv({ cwd }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 超时处理
    const timeoutId = setTimeout(() => {
      killed = true;
      killReason = 'timeout';
      gracefulKill(proc);
    }, timeout);

    // 中止信号处理
    const abortHandler = () => {
      killed = true;
      killReason = 'abort';
      gracefulKill(proc);
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        killed = true;
        killReason = 'abort';
        proc.kill('SIGKILL');
      } else {
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      }
    }

    // 收集 stdout
    proc.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      if (stdout.length < maxOutput) {
        stdout += chunk;
      }
      onStdout?.(chunk);
    });

    // 收集 stderr
    proc.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      if (stderr.length < maxOutput) {
        stderr += chunk;
      }
      onStderr?.(chunk);
    });

    proc.on('close', (code, signal) => {
      clearTimeout(timeoutId);
      abortSignal?.removeEventListener('abort', abortHandler);

      const durationMs = performance.now() - startTime;

      // 清理 ANSI
      if (shouldStripAnsi) {
        stdout = stripAnsi(stdout);
        stderr = stripAnsi(stderr);
      }

      // 截断
      stdout = truncateOutput(stdout, maxOutput);
      stderr = truncateOutput(stderr, maxOutput);

      resolve({
        stdout,
        stderr,
        exitCode: code,
        signal: signal || null,
        killed,
        killReason,
        durationMs,
      });
    });

    proc.on('error', (error) => {
      clearTimeout(timeoutId);
      abortSignal?.removeEventListener('abort', abortHandler);

      resolve({
        stdout,
        stderr: stderr + `\nProcess error: ${error.message}`,
        exitCode: null,
        signal: null,
        killed: false,
        durationMs: performance.now() - startTime,
      });
    });
  });
}

/**
 * 简化的命令执行（不抛出异常）
 * 适用于不关心退出码的场景
 */
export async function execSimple(
  command: string,
  cwd: string,
  timeout?: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const result = await execCommand(command, { cwd, timeout });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

/**
 * 执行命令并返回 stdout（如果失败则抛出异常）
 */
export async function execOrThrow(
  command: string,
  cwd: string,
  timeout?: number,
): Promise<string> {
  const result = await execCommand(command, { cwd, timeout });
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (exit ${result.exitCode}): ${command}\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

// ─── 进程管理 ───

/**
 * 优雅终止进程
 * 先发送 SIGTERM，等待一段时间后发送 SIGKILL
 */
export function gracefulKill(proc: ChildProcess, graceMs: number = SIGTERM_GRACE_MS): void {
  if (!proc || proc.killed) return;

  proc.kill('SIGTERM');

  setTimeout(() => {
    if (proc && !proc.killed) {
      proc.kill('SIGKILL');
    }
  }, graceMs);
}

/**
 * 终止进程树
 * 终止进程及其所有子进程
 */
export async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    // Windows: 使用 taskkill
    try {
      await execFileAsync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 5000 });
    } catch {
      // 忽略错误（进程可能已退出）
    }
  } else {
    // Unix: 先尝试 SIGTERM 整个进程组，再 SIGKILL
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // 忽略
    }

    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // 忽略
    }
  }
}

// ─── 系统信息 ───

/** 系统 Shell 信息 */
export interface SystemInfo {
  /** 操作系统 */
  platform: string;
  /** 架构 */
  arch: string;
  /** 主机名 */
  hostname: string;
  /** 用户名 */
  username: string;
  /** 主目录 */
  homeDir: string;
  /** 临时目录 */
  tmpDir: string;
  /** 默认 Shell */
  defaultShell: string;
  /** CPU 核心数 */
  cpuCount: number;
  /** 总内存（MB） */
  totalMemoryMB: number;
}

/** 获取系统信息 */
export function getSystemInfo(): SystemInfo {
  return {
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    username: os.userInfo().username,
    homeDir: os.homedir(),
    tmpDir: os.tmpdir(),
    defaultShell: process.env.SHELL || DEFAULT_SHELL,
    cpuCount: os.cpus().length,
    totalMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
  };
}

/**
 * 获取当前工作目录的 Git 信息
 */
export async function getGitInfo(cwd: string): Promise<{
  isGitRepo: boolean;
  branch?: string;
  remoteUrl?: string;
  isDirty?: boolean;
} | null> {
  try {
    const { stdout: branch } = await execSimple('git rev-parse --abbrev-ref HEAD', cwd, 5000);
    const { stdout: remoteUrl } = await execSimple('git config --get remote.origin.url', cwd, 5000);
    const { stdout: status } = await execSimple('git status --porcelain', cwd, 5000);

    return {
      isGitRepo: true,
      branch: branch.trim(),
      remoteUrl: remoteUrl.trim() || undefined,
      isDirty: status.trim().length > 0,
    };
  } catch {
    return { isGitRepo: false };
  }
}
