/**
 * 工具系统类型定义
 *
 * 参考 Claude Code: src/Tool.ts
 * 定义工具的接口、权限模型和执行上下文
 */

import type { ToolDefinition } from '../llm/types.js';

/** 工具执行结果 */
export interface ToolResult {
  /** 输出内容（文本） */
  content: string;
  /** 是否出错 */
  isError?: boolean;
  /** 附加数据（如文件内容、搜索结果等） */
  metadata?: Record<string, unknown>;
}

/** 权限级别 */
export type PermissionLevel =
  | 'always_allow'    // 始终允许（如文件读取）
  | 'ask_user'        // 需要用户确认（如文件写入）
  | 'always_deny';    // 始终拒绝

/** 工具权限定义 */
export interface ToolPermission {
  /** 默认权限级别 */
  default: PermissionLevel;
  /** 是否可以被用户规则覆盖 */
  userConfigurable: boolean;
  /** 高风险操作警告信息 */
  riskWarning?: string;
}

/** 工具执行上下文 */
export interface ToolContext {
  /** 当前工作目录 */
  cwd: string;
  /** 请求用户确认的回调 */
  askPermission: (toolName: string, description: string) => Promise<boolean>;
  /** 中止信号 */
  abortSignal: AbortSignal;
  /** 日志回调 */
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** 进度回调 */
  onProgress?: (progress: ToolProgress) => void;
}

/** 工具执行进度 */
export interface ToolProgress {
  /** 进度描述 */
  message: string;
  /** 完成百分比 (0-100)，undefined 表示不确定 */
  percentage?: number;
}

/**
 * 工具接口 — 所有工具必须实现
 *
 * 参考 Claude Code 的 Tool 接口设计：
 * - 每个工具独立定义输入 Schema
 * - 每个工具有独立的 prompt（描述给 LLM）
 * - 每个工具有独立的权限模型
 * - 工具可以标记为「并发安全」
 */
export interface Tool {
  /** 工具名称（唯一标识） */
  readonly name: string;

  /** 工具描述（给用户看的简短描述） */
  readonly description: string;

  /** 工具 prompt（给 LLM 看的详细使用说明） */
  readonly prompt: string;

  /** 输入参数 Schema（JSON Schema） */
  readonly inputSchema: ToolDefinition['inputSchema'];

  /** 权限配置 */
  readonly permission: ToolPermission;

  /**
   * 是否并发安全
   * true = 可以与其他工具并行执行
   * false = 必须串行执行
   */
  readonly concurrentSafe: boolean;

  /**
   * 执行工具
   * @param input - LLM 提供的输入参数
   * @param context - 执行上下文
   * @returns 执行结果
   */
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;

  /**
   * 验证输入参数（可选）
   * 在执行前调用，用于提前检查参数合法性
   */
  validate?(input: Record<string, unknown>): { valid: true } | { valid: false; message: string };
}
