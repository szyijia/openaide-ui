/**
 * 权限管理器
 *
 * 管理工具调用的权限策略：
 *
 * 1. 权限级别：
 *    - always_allow: 始终允许（不再询问）
 *    - ask: 每次询问用户
 *    - always_deny: 始终拒绝
 *
 * 2. 规则匹配：
 *    - 按工具名精确匹配
 *    - 按工具名 + 参数模式匹配（如 bash 命令白名单）
 *    - 按会话/全局范围
 *
 * 3. 持久化：
 *    - 全局规则存储在 ~/.openaide/permissions.json
 *    - 项目规则存储在 .openaide.md 中
 *    - 会话规则仅在内存中
 *
 * 参考 Claude Code: src/hooks/toolPermission/
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// ─── 类型定义 ───

/** 权限决策 */
export type PermissionDecision = 'allow' | 'deny' | 'ask';

/** 权限规则范围 */
export type PermissionScope = 'session' | 'project' | 'global';

/** 权限规则 */
export interface PermissionRule {
  /** 规则 ID */
  id: string;
  /** 工具名称（支持通配符 *） */
  toolName: string;
  /** 参数匹配模式（可选） */
  paramPattern?: Record<string, string | RegExp>;
  /** 权限决策 */
  decision: PermissionDecision;
  /** 规则范围 */
  scope: PermissionScope;
  /** 创建时间 */
  createdAt: string;
  /** 过期时间（可选） */
  expiresAt?: string;
  /** 规则描述 */
  description?: string;
}

/** 权限检查结果 */
export interface PermissionCheckResult {
  /** 最终决策 */
  decision: PermissionDecision;
  /** 匹配的规则（如果有） */
  matchedRule?: PermissionRule;
  /** 决策原因 */
  reason: string;
}

/** 工具调用上下文 */
export interface ToolCallContext {
  /** 工具名称 */
  toolName: string;
  /** 工具参数 */
  params: Record<string, unknown>;
  /** 工具描述 */
  description?: string;
  /** 当前工作目录 */
  cwd?: string;
}

// ─── 预定义安全规则 ───

/** 安全的只读工具（默认允许） */
const SAFE_READONLY_TOOLS = new Set([
  'file_read',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
]);

/** 危险的 Bash 命令模式 */
const DANGEROUS_BASH_PATTERNS = [
  /\brm\s+-rf?\s+[\/~]/i,           // rm -rf /
  /\bsudo\b/i,                       // sudo
  /\bchmod\s+777\b/i,               // chmod 777
  /\bdd\s+if=/i,                     // dd if=
  /\bmkfs\b/i,                       // mkfs
  /\b(shutdown|reboot|halt)\b/i,     // 系统关机
  /\bcurl\b.*\|\s*(bash|sh)\b/i,    // curl | bash
  /\bwget\b.*\|\s*(bash|sh)\b/i,    // wget | bash
  />\s*\/dev\/(sda|nvme)/i,         // 写入磁盘设备
  /\bformat\b/i,                     // format
];

/** 安全的 Bash 命令模式（默认允许） */
const SAFE_BASH_PATTERNS = [
  /^(ls|cat|head|tail|wc|echo|pwd|date|whoami|uname|which|type|file)\b/,
  /^(git\s+(status|log|diff|branch|show|remote|tag))\b/,
  /^(node|npm|npx|pnpm|yarn|bun)\s+(--version|-v|list|info|view)\b/,
  /^(python|python3|pip)\s+--version\b/,
  /^(tsc|eslint|prettier)\s+--/,
  /^(find|grep|rg|fd|ag)\b/,
];

// ─── 常量 ───

const PERMISSIONS_DIR = path.join(os.homedir(), '.openaide');
const PERMISSIONS_FILE = 'permissions.json';

// ─── PermissionManager ───

export class PermissionManager {
  private globalRules: PermissionRule[] = [];
  private projectRules: PermissionRule[] = [];
  private sessionRules: PermissionRule[] = [];
  private projectCwd: string;

  constructor(options?: { projectCwd?: string }) {
    this.projectCwd = options?.projectCwd || process.cwd();
  }

  /**
   * 初始化 — 从磁盘加载规则
   */
  async init(): Promise<void> {
    await this.loadGlobalRules();
    await this.loadProjectRules();
  }

  /**
   * 检查工具调用权限
   *
   * 优先级：session > project > global > 默认规则
   */
  check(context: ToolCallContext): PermissionCheckResult {
    // 1. 检查会话规则
    const sessionResult = this.matchRules(this.sessionRules, context);
    if (sessionResult) return sessionResult;

    // 2. 检查项目规则
    const projectResult = this.matchRules(this.projectRules, context);
    if (projectResult) return projectResult;

    // 3. 检查全局规则
    const globalResult = this.matchRules(this.globalRules, context);
    if (globalResult) return globalResult;

    // 4. 应用默认规则
    return this.applyDefaultRules(context);
  }

  /**
   * 添加权限规则
   */
  async addRule(rule: Omit<PermissionRule, 'id' | 'createdAt'>): Promise<PermissionRule> {
    const fullRule: PermissionRule = {
      ...rule,
      id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
    };

    switch (rule.scope) {
      case 'session':
        this.sessionRules.push(fullRule);
        break;
      case 'project':
        this.projectRules.push(fullRule);
        await this.saveProjectRules();
        break;
      case 'global':
        this.globalRules.push(fullRule);
        await this.saveGlobalRules();
        break;
    }

    return fullRule;
  }

  /**
   * 快捷方法：设置"始终允许"
   */
  async alwaysAllow(toolName: string, scope: PermissionScope = 'session'): Promise<PermissionRule> {
    return this.addRule({
      toolName,
      decision: 'allow',
      scope,
      description: `始终允许 ${toolName}`,
    });
  }

  /**
   * 快捷方法：设置"始终拒绝"
   */
  async alwaysDeny(toolName: string, scope: PermissionScope = 'session'): Promise<PermissionRule> {
    return this.addRule({
      toolName,
      decision: 'deny',
      scope,
      description: `始终拒绝 ${toolName}`,
    });
  }

  /**
   * 删除规则
   */
  async removeRule(ruleId: string): Promise<boolean> {
    for (const rules of [this.sessionRules, this.projectRules, this.globalRules]) {
      const idx = rules.findIndex((r) => r.id === ruleId);
      if (idx !== -1) {
        const rule = rules[idx]!;
        rules.splice(idx, 1);
        if (rule.scope === 'project') await this.saveProjectRules();
        if (rule.scope === 'global') await this.saveGlobalRules();
        return true;
      }
    }
    return false;
  }

  /**
   * 获取所有规则
   */
  getAllRules(): { session: PermissionRule[]; project: PermissionRule[]; global: PermissionRule[] } {
    return {
      session: [...this.sessionRules],
      project: [...this.projectRules],
      global: [...this.globalRules],
    };
  }

  /**
   * 清空会话规则
   */
  clearSessionRules(): void {
    this.sessionRules = [];
  }

  /**
   * 重置所有规则
   */
  async resetAll(): Promise<void> {
    this.sessionRules = [];
    this.projectRules = [];
    this.globalRules = [];
    await Promise.all([this.saveGlobalRules(), this.saveProjectRules()]);
  }

  // ─── 规则匹配 ───

  private matchRules(rules: PermissionRule[], context: ToolCallContext): PermissionCheckResult | null {
    for (const rule of rules) {
      if (this.isExpired(rule)) continue;

      // 工具名匹配
      if (!this.matchToolName(rule.toolName, context.toolName)) continue;

      // 参数模式匹配
      if (rule.paramPattern && !this.matchParams(rule.paramPattern, context.params)) continue;

      return {
        decision: rule.decision,
        matchedRule: rule,
        reason: rule.description || `匹配规则: ${rule.toolName} → ${rule.decision}`,
      };
    }

    return null;
  }

  private matchToolName(pattern: string, toolName: string): boolean {
    if (pattern === '*') return true;
    if (pattern === toolName) return true;
    // 简单通配符匹配（如 file_* 匹配 file_read, file_write 等）
    if (pattern.endsWith('*')) {
      return toolName.startsWith(pattern.slice(0, -1));
    }
    return false;
  }

  private matchParams(pattern: Record<string, string | RegExp>, params: Record<string, unknown>): boolean {
    for (const [key, expected] of Object.entries(pattern)) {
      const actual = String(params[key] || '');
      if (expected instanceof RegExp) {
        if (!expected.test(actual)) return false;
      } else {
        if (actual !== expected) return false;
      }
    }
    return true;
  }

  private isExpired(rule: PermissionRule): boolean {
    if (!rule.expiresAt) return false;
    return new Date(rule.expiresAt) < new Date();
  }

  // ─── 默认规则 ───

  private applyDefaultRules(context: ToolCallContext): PermissionCheckResult {
    // 只读工具默认允许
    if (SAFE_READONLY_TOOLS.has(context.toolName)) {
      return {
        decision: 'allow',
        reason: '只读工具，默认允许',
      };
    }

    // Bash 工具特殊处理
    if (context.toolName === 'bash') {
      return this.checkBashPermission(context);
    }

    // 文件写入/编辑工具 — 需要询问
    if (context.toolName === 'file_write' || context.toolName === 'file_edit') {
      return {
        decision: 'ask',
        reason: '文件修改操作，需要用户确认',
      };
    }

    // Agent 工具 — 需要询问
    if (context.toolName === 'agent') {
      return {
        decision: 'ask',
        reason: '子 Agent 调用，需要用户确认',
      };
    }

    // 默认询问
    return {
      decision: 'ask',
      reason: '未知工具，需要用户确认',
    };
  }

  /**
   * Bash 命令权限检查
   */
  private checkBashPermission(context: ToolCallContext): PermissionCheckResult {
    const command = String(context.params.command || '').trim();

    // 检查危险命令
    for (const pattern of DANGEROUS_BASH_PATTERNS) {
      if (pattern.test(command)) {
        return {
          decision: 'deny',
          reason: `危险命令被自动拒绝: ${command.substring(0, 50)}`,
        };
      }
    }

    // 检查安全命令
    for (const pattern of SAFE_BASH_PATTERNS) {
      if (pattern.test(command)) {
        return {
          decision: 'allow',
          reason: '安全的只读命令，默认允许',
        };
      }
    }

    // 其他命令需要询问
    return {
      decision: 'ask',
      reason: `Bash 命令需要用户确认: ${command.substring(0, 80)}`,
    };
  }

  // ─── 持久化 ───

  private async loadGlobalRules(): Promise<void> {
    try {
      const filePath = path.join(PERMISSIONS_DIR, PERMISSIONS_FILE);
      const data = await fs.readFile(filePath, 'utf-8');
      this.globalRules = JSON.parse(data);
    } catch {
      this.globalRules = [];
    }
  }

  private async saveGlobalRules(): Promise<void> {
    await fs.mkdir(PERMISSIONS_DIR, { recursive: true });
    const filePath = path.join(PERMISSIONS_DIR, PERMISSIONS_FILE);
    await fs.writeFile(filePath, JSON.stringify(this.globalRules, null, 2), 'utf-8');
  }

  private async loadProjectRules(): Promise<void> {
    try {
      const filePath = path.join(this.projectCwd, '.openaide', 'permissions.json');
      const data = await fs.readFile(filePath, 'utf-8');
      this.projectRules = JSON.parse(data);
    } catch {
      this.projectRules = [];
    }
  }

  private async saveProjectRules(): Promise<void> {
    const dirPath = path.join(this.projectCwd, '.openaide');
    await fs.mkdir(dirPath, { recursive: true });
    const filePath = path.join(dirPath, 'permissions.json');
    await fs.writeFile(filePath, JSON.stringify(this.projectRules, null, 2), 'utf-8');
  }
}
