/**
 * 智能模型路由器
 *
 * 根据任务类型、复杂度和成本约束自动选择最优模型。
 *
 * 路由策略：
 * 1. 简单任务（补全、格式化）→ 快速/便宜模型（DeepSeek、GLM Flash）
 * 2. 中等任务（代码生成、Bug 修复）→ 平衡模型（GPT-4o、Claude Sonnet）
 * 3. 复杂任务（架构设计、多文件重构）→ 强力模型（Claude Opus、GPT-4o）
 * 4. 代码补全 → 专用补全模型（DeepSeek Coder）
 *
 * 支持：
 * - 基于规则的路由
 * - 成本预算控制
 * - 模型降级（主模型不可用时自动切换）
 * - 用户偏好覆盖
 */

import type { LLMProvider, ProviderConfig, ChatParams, StreamEvent, ChatResponse, TokenUsage } from './types.js';
import { createProvider } from './factory.js';

// ─── 类型定义 ───

/** 任务类型 */
export type TaskType =
  | 'completion'      // 代码补全（行级/块级）
  | 'chat'            // 普通对话
  | 'code_generation' // 代码生成
  | 'code_edit'       // 代码编辑/重构
  | 'code_review'     // 代码审查
  | 'bug_fix'         // Bug 修复
  | 'architecture'    // 架构设计
  | 'explanation'     // 代码解释
  | 'documentation'   // 文档生成
  | 'translation'     // 翻译
  | 'multi_agent'     // 多 Agent 协作
  | 'unknown';        // 未知

/** 任务复杂度 */
export type TaskComplexity = 'low' | 'medium' | 'high';

/** 模型能力等级 */
export type ModelTier = 'fast' | 'balanced' | 'powerful';

/** 路由决策 */
export interface RoutingDecision {
  /** 选择的 Provider */
  provider: LLMProvider;
  /** 选择原因 */
  reason: string;
  /** 模型等级 */
  tier: ModelTier;
  /** 预估单次成本（美元） */
  estimatedCost: number;
}

/** 模型注册信息 */
export interface ModelRegistration {
  /** Provider 配置 */
  config: ProviderConfig;
  /** 模型等级 */
  tier: ModelTier;
  /** 适合的任务类型 */
  suitableFor: TaskType[];
  /** 每百万 input token 价格（美元） */
  inputPricePerMillion: number;
  /** 每百万 output token 价格（美元） */
  outputPricePerMillion: number;
  /** 是否可用 */
  available: boolean;
  /** 优先级（同等级内，数字越小优先级越高） */
  priority: number;
}

/** 路由器配置 */
export interface RouterConfig {
  /** 注册的模型列表 */
  models: ModelRegistration[];
  /** 每日成本预算（美元），0 表示不限制 */
  dailyBudgetUSD: number;
  /** 默认模型等级 */
  defaultTier: ModelTier;
  /** 用户偏好的 Provider 名称（覆盖自动路由） */
  preferredProvider?: string;
  /** 是否启用自动降级 */
  enableFallback: boolean;
}

/** 路由统计 */
export interface RouterStats {
  totalRequests: number;
  totalCostUSD: number;
  requestsByModel: Record<string, number>;
  costByModel: Record<string, number>;
  fallbackCount: number;
  dailyCostUSD: number;
  lastResetDate: string;
}

// ─── 默认模型注册 ───

const DEFAULT_MODELS: ModelRegistration[] = [
  // ─── 快速模型 ───
  {
    config: { provider: 'deepseek', model: 'deepseek-chat', apiKey: '' },
    tier: 'fast',
    suitableFor: ['completion', 'chat', 'code_generation', 'explanation', 'translation'],
    inputPricePerMillion: 0.27,
    outputPricePerMillion: 1.10,
    available: false,
    priority: 1,
  },
  {
    config: { provider: 'glm', model: 'glm-4-flash', apiKey: '' },
    tier: 'fast',
    suitableFor: ['chat', 'explanation', 'translation', 'documentation'],
    inputPricePerMillion: 0.0,
    outputPricePerMillion: 0.0,
    available: false,
    priority: 2,
  },
  // ─── 平衡模型 ───
  {
    config: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', apiKey: '' },
    tier: 'balanced',
    suitableFor: ['chat', 'code_generation', 'code_edit', 'code_review', 'bug_fix', 'explanation', 'documentation'],
    inputPricePerMillion: 3.0,
    outputPricePerMillion: 15.0,
    available: false,
    priority: 1,
  },
  {
    config: { provider: 'openai', model: 'gpt-4o', apiKey: '' },
    tier: 'balanced',
    suitableFor: ['chat', 'code_generation', 'code_edit', 'code_review', 'bug_fix', 'explanation'],
    inputPricePerMillion: 2.5,
    outputPricePerMillion: 10.0,
    available: false,
    priority: 2,
  },
  {
    config: { provider: 'deepseek', model: 'deepseek-reasoner', apiKey: '' },
    tier: 'balanced',
    suitableFor: ['code_generation', 'code_edit', 'bug_fix', 'architecture'],
    inputPricePerMillion: 0.55,
    outputPricePerMillion: 2.19,
    available: false,
    priority: 3,
  },
  // ─── 强力模型 ───
  {
    config: { provider: 'anthropic', model: 'claude-opus-4-20250514', apiKey: '' },
    tier: 'powerful',
    suitableFor: ['architecture', 'multi_agent', 'code_review', 'code_edit', 'bug_fix'],
    inputPricePerMillion: 15.0,
    outputPricePerMillion: 75.0,
    available: false,
    priority: 1,
  },
  {
    config: { provider: 'qwen', model: 'qwen-max', apiKey: '' },
    tier: 'powerful',
    suitableFor: ['chat', 'code_generation', 'architecture', 'documentation'],
    inputPricePerMillion: 2.4,
    outputPricePerMillion: 9.6,
    available: false,
    priority: 3,
  },
];

// ─── 任务分类器 ───

/** 根据用户消息推断任务类型 */
export function classifyTask(message: string): { type: TaskType; complexity: TaskComplexity } {
  const lower = message.toLowerCase();

  // 补全相关
  if (lower.includes('补全') || lower.includes('complete') || lower.includes('autocomplete')) {
    return { type: 'completion', complexity: 'low' };
  }

  // 架构相关
  if (lower.includes('架构') || lower.includes('设计') || lower.includes('architecture') ||
      lower.includes('重构整个') || lower.includes('refactor entire') || lower.includes('系统设计')) {
    return { type: 'architecture', complexity: 'high' };
  }

  // 代码审查
  if (lower.includes('审查') || lower.includes('review') || lower.includes('检查代码')) {
    return { type: 'code_review', complexity: 'medium' };
  }

  // Bug 修复
  if (lower.includes('bug') || lower.includes('修复') || lower.includes('fix') ||
      lower.includes('错误') || lower.includes('error') || lower.includes('报错')) {
    return { type: 'bug_fix', complexity: 'medium' };
  }

  // 代码编辑/重构
  if (lower.includes('重构') || lower.includes('refactor') || lower.includes('修改') ||
      lower.includes('改成') || lower.includes('优化')) {
    return { type: 'code_edit', complexity: 'medium' };
  }

  // 代码生成
  if (lower.includes('生成') || lower.includes('创建') || lower.includes('写一个') ||
      lower.includes('实现') || lower.includes('generate') || lower.includes('create') ||
      lower.includes('implement') || lower.includes('write')) {
    return { type: 'code_generation', complexity: 'medium' };
  }

  // 文档
  if (lower.includes('文档') || lower.includes('注释') || lower.includes('document') ||
      lower.includes('comment') || lower.includes('readme')) {
    return { type: 'documentation', complexity: 'low' };
  }

  // 解释
  if (lower.includes('解释') || lower.includes('explain') || lower.includes('什么意思') ||
      lower.includes('怎么工作') || lower.includes('how does')) {
    return { type: 'explanation', complexity: 'low' };
  }

  // 翻译
  if (lower.includes('翻译') || lower.includes('translate')) {
    return { type: 'translation', complexity: 'low' };
  }

  // 复杂度推断
  const complexity = estimateComplexity(message);

  return { type: 'unknown', complexity };
}

/** 估算任务复杂度 */
function estimateComplexity(message: string): TaskComplexity {
  const length = message.length;
  const fileCount = (message.match(/\.(ts|js|py|go|rs|java|cpp|c|rb|php)/gi) || []).length;
  const hasMultiStep = /(\d+\.|第[一二三四五六七八九十]|步骤|然后|接着|最后)/g.test(message);

  if (length > 500 || fileCount > 3 || hasMultiStep) {
    return 'high';
  }
  if (length > 200 || fileCount > 1) {
    return 'medium';
  }
  return 'low';
}

// ─── ModelRouter ───

export class ModelRouter {
  private config: RouterConfig;
  private providers: Map<string, LLMProvider> = new Map();
  private stats: RouterStats;

  constructor(config?: Partial<RouterConfig>) {
    this.config = {
      models: DEFAULT_MODELS,
      dailyBudgetUSD: 0,
      defaultTier: 'balanced',
      enableFallback: true,
      ...config,
    };

    this.stats = {
      totalRequests: 0,
      totalCostUSD: 0,
      requestsByModel: {},
      costByModel: {},
      fallbackCount: 0,
      dailyCostUSD: 0,
      lastResetDate: new Date().toISOString().split('T')[0]!,
    };

    // 从环境变量自动检测可用模型
    this.detectAvailableModels();
  }

  /**
   * 路由请求到最优模型
   */
  route(taskType: TaskType, complexity: TaskComplexity): RoutingDecision {
    // 用户偏好覆盖
    if (this.config.preferredProvider) {
      const preferred = this.findPreferredProvider();
      if (preferred) return preferred;
    }

    // 确定目标等级
    const targetTier = this.determineTier(taskType, complexity);

    // 在目标等级中找最优模型
    const decision = this.findBestModel(taskType, targetTier);

    if (decision) return decision;

    // 降级搜索
    if (this.config.enableFallback) {
      const fallback = this.findFallbackModel(taskType, targetTier);
      if (fallback) {
        this.stats.fallbackCount++;
        return fallback;
      }
    }

    // 最终降级：使用任何可用模型
    const anyModel = this.config.models.find((m) => m.available);
    if (anyModel) {
      const provider = this.getOrCreateProvider(anyModel);
      return {
        provider,
        reason: '所有首选模型不可用，使用降级模型',
        tier: anyModel.tier,
        estimatedCost: 0,
      };
    }

    throw new Error('没有可用的模型。请检查 API Key 配置。');
  }

  /**
   * 智能路由 — 自动分析消息并路由
   */
  routeMessage(message: string): RoutingDecision {
    const { type, complexity } = classifyTask(message);
    return this.route(type, complexity);
  }

  /**
   * 记录请求完成，更新统计
   */
  recordUsage(model: string, usage: TokenUsage): void {
    this.checkDailyReset();

    this.stats.totalRequests++;
    this.stats.requestsByModel[model] = (this.stats.requestsByModel[model] || 0) + 1;

    if (usage.totalCostUSD) {
      this.stats.totalCostUSD += usage.totalCostUSD;
      this.stats.dailyCostUSD += usage.totalCostUSD;
      this.stats.costByModel[model] = (this.stats.costByModel[model] || 0) + usage.totalCostUSD;
    }
  }

  /**
   * 检查是否超出每日预算
   */
  isOverBudget(): boolean {
    if (this.config.dailyBudgetUSD <= 0) return false;
    this.checkDailyReset();
    return this.stats.dailyCostUSD >= this.config.dailyBudgetUSD;
  }

  /**
   * 获取路由统计
   */
  getStats(): RouterStats {
    this.checkDailyReset();
    return { ...this.stats };
  }

  /**
   * 注册新模型
   */
  registerModel(registration: ModelRegistration): void {
    this.config.models.push(registration);
  }

  /**
   * 更新模型可用性
   */
  setModelAvailability(model: string, available: boolean): void {
    const reg = this.config.models.find((m) => m.config.model === model);
    if (reg) {
      reg.available = available;
    }
  }

  /**
   * 获取所有已注册模型
   */
  getRegisteredModels(): ModelRegistration[] {
    return [...this.config.models];
  }

  // ─── 私有方法 ───

  /** 从环境变量检测可用模型 */
  private detectAvailableModels(): void {
    const envKeyMap: Record<string, string> = {
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      deepseek: 'DEEPSEEK_API_KEY',
      qwen: 'QWEN_API_KEY',
      glm: 'GLM_API_KEY',
    };

    for (const model of this.config.models) {
      const envKey = envKeyMap[model.config.provider];
      if (envKey && process.env[envKey]) {
        model.available = true;
        model.config.apiKey = process.env[envKey]!;
      }
    }
  }

  /** 确定目标模型等级 */
  private determineTier(taskType: TaskType, complexity: TaskComplexity): ModelTier {
    // 预算超限时强制使用快速模型
    if (this.isOverBudget()) return 'fast';

    // 补全任务始终使用快速模型
    if (taskType === 'completion') return 'fast';

    // 架构和多 Agent 任务使用强力模型
    if (taskType === 'architecture' || taskType === 'multi_agent') return 'powerful';

    // 根据复杂度决定
    switch (complexity) {
      case 'low': return 'fast';
      case 'medium': return 'balanced';
      case 'high': return 'powerful';
      default: return this.config.defaultTier;
    }
  }

  /** 在指定等级中找最优模型 */
  private findBestModel(taskType: TaskType, tier: ModelTier): RoutingDecision | null {
    const candidates = this.config.models
      .filter((m) => m.available && m.tier === tier && m.suitableFor.includes(taskType))
      .sort((a, b) => a.priority - b.priority);

    if (candidates.length === 0) return null;

    const best = candidates[0]!;
    const provider = this.getOrCreateProvider(best);

    return {
      provider,
      reason: `${tier} 等级最优模型，适合 ${taskType} 任务`,
      tier,
      estimatedCost: (best.inputPricePerMillion + best.outputPricePerMillion) / 2000, // 粗略估算
    };
  }

  /** 降级搜索 */
  private findFallbackModel(taskType: TaskType, originalTier: ModelTier): RoutingDecision | null {
    const tierOrder: ModelTier[] = ['powerful', 'balanced', 'fast'];
    const startIndex = tierOrder.indexOf(originalTier);

    // 先向下降级，再向上升级
    for (let i = startIndex + 1; i < tierOrder.length; i++) {
      const result = this.findBestModel(taskType, tierOrder[i]!);
      if (result) {
        result.reason = `降级: ${result.reason}`;
        return result;
      }
    }
    for (let i = startIndex - 1; i >= 0; i--) {
      const result = this.findBestModel(taskType, tierOrder[i]!);
      if (result) {
        result.reason = `升级: ${result.reason}`;
        return result;
      }
    }

    // 最后尝试不限任务类型
    const anyAvailable = this.config.models
      .filter((m) => m.available)
      .sort((a, b) => a.priority - b.priority);

    if (anyAvailable.length > 0) {
      const model = anyAvailable[0]!;
      const provider = this.getOrCreateProvider(model);
      return {
        provider,
        reason: '降级: 使用任意可用模型',
        tier: model.tier,
        estimatedCost: 0,
      };
    }

    return null;
  }

  /** 查找用户偏好的 Provider */
  private findPreferredProvider(): RoutingDecision | null {
    const preferred = this.config.models.find(
      (m) => m.available && m.config.provider === this.config.preferredProvider,
    );

    if (!preferred) return null;

    const provider = this.getOrCreateProvider(preferred);
    return {
      provider,
      reason: `用户偏好: ${this.config.preferredProvider}`,
      tier: preferred.tier,
      estimatedCost: 0,
    };
  }

  /** 获取或创建 Provider 实例（缓存） */
  private getOrCreateProvider(registration: ModelRegistration): LLMProvider {
    const key = `${registration.config.provider}:${registration.config.model}`;
    let provider = this.providers.get(key);

    if (!provider) {
      provider = createProvider(registration.config);
      this.providers.set(key, provider);
    }

    return provider;
  }

  /** 检查并重置每日统计 */
  private checkDailyReset(): void {
    const today = new Date().toISOString().split('T')[0]!;
    if (this.stats.lastResetDate !== today) {
      this.stats.dailyCostUSD = 0;
      this.stats.lastResetDate = today;
    }
  }
}
