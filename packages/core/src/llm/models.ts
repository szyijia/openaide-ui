/**
 * 模型配置与能力检测
 *
 * 参考 Claude Code: src/utils/model/ (16 文件, 2,710 行)
 *
 * 功能：
 * 1. 模型注册表 — 所有已知模型的能力和定价
 * 2. 能力检测 — 根据模型名称查询能力
 * 3. 模型选择策略 — 根据任务需求选择最优模型
 * 4. 成本计算 — 精确的模型成本计算
 * 5. 模型别名 — 支持简短别名
 */

import type { ModelCapabilities, TokenUsage } from './types.js';

// ─── 模型注册表 ───

/** 完整的模型定价信息 */
export interface ModelPricing {
  /** 每百万 input token 价格（美元） */
  inputPricePerMillion: number;
  /** 每百万 output token 价格（美元） */
  outputPricePerMillion: number;
  /** 每百万 cache write token 价格（美元，可选） */
  cacheWritePricePerMillion?: number;
  /** 每百万 cache read token 价格（美元，可选） */
  cacheReadPricePerMillion?: number;
}

/** 模型注册信息 */
export interface ModelInfo extends ModelCapabilities {
  /** 模型显示名称 */
  displayName: string;
  /** 模型别名列表 */
  aliases: string[];
  /** 定价信息 */
  pricing: ModelPricing;
  /** 是否已弃用 */
  deprecated: boolean;
  /** 推荐替代模型（如果已弃用） */
  replacedBy?: string;
  /** 发布日期 */
  releaseDate?: string;
}

// ─── 已知模型注册表 ───

const MODEL_REGISTRY: Record<string, ModelInfo> = {
  // ─── Anthropic Claude ───
  'claude-opus-4-20250514': {
    model: 'claude-opus-4-20250514',
    provider: 'anthropic',
    displayName: 'Claude Opus 4',
    aliases: ['claude-opus-4', 'opus-4', 'opus'],
    maxContextWindow: 200_000,
    maxOutputTokens: 32_000,
    supportsTool: true,
    supportsThinking: true,
    supportsVision: true,
    supportsPromptCache: true,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    inputPricePerMillion: 15,
    outputPricePerMillion: 75,
    pricing: {
      inputPricePerMillion: 15,
      outputPricePerMillion: 75,
      cacheWritePricePerMillion: 18.75,
      cacheReadPricePerMillion: 1.5,
    },
    deprecated: false,
    releaseDate: '2025-05-14',
  },
  'claude-sonnet-4-20250514': {
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    displayName: 'Claude Sonnet 4',
    aliases: ['claude-sonnet-4', 'sonnet-4', 'sonnet'],
    maxContextWindow: 200_000,
    maxOutputTokens: 16_384,
    supportsTool: true,
    supportsThinking: true,
    supportsVision: true,
    supportsPromptCache: true,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    inputPricePerMillion: 3,
    outputPricePerMillion: 15,
    pricing: {
      inputPricePerMillion: 3,
      outputPricePerMillion: 15,
      cacheWritePricePerMillion: 3.75,
      cacheReadPricePerMillion: 0.3,
    },
    deprecated: false,
    releaseDate: '2025-05-14',
  },
  'claude-3-5-sonnet-20241022': {
    model: 'claude-3-5-sonnet-20241022',
    provider: 'anthropic',
    displayName: 'Claude 3.5 Sonnet',
    aliases: ['claude-3.5-sonnet', 'sonnet-3.5'],
    maxContextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsTool: true,
    supportsThinking: false,
    supportsVision: true,
    supportsPromptCache: true,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    inputPricePerMillion: 3,
    outputPricePerMillion: 15,
    pricing: {
      inputPricePerMillion: 3,
      outputPricePerMillion: 15,
      cacheWritePricePerMillion: 3.75,
      cacheReadPricePerMillion: 0.3,
    },
    deprecated: false,
    releaseDate: '2024-10-22',
  },
  'claude-3-5-haiku-20241022': {
    model: 'claude-3-5-haiku-20241022',
    provider: 'anthropic',
    displayName: 'Claude 3.5 Haiku',
    aliases: ['claude-3.5-haiku', 'haiku-3.5', 'haiku'],
    maxContextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsTool: true,
    supportsThinking: false,
    supportsVision: true,
    supportsPromptCache: true,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    inputPricePerMillion: 0.8,
    outputPricePerMillion: 4,
    pricing: {
      inputPricePerMillion: 0.8,
      outputPricePerMillion: 4,
      cacheWritePricePerMillion: 1,
      cacheReadPricePerMillion: 0.08,
    },
    deprecated: false,
    releaseDate: '2024-10-22',
  },

  // ─── OpenAI ───
  'gpt-4o': {
    model: 'gpt-4o',
    provider: 'openai',
    displayName: 'GPT-4o',
    aliases: ['4o'],
    maxContextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsTool: true,
    supportsThinking: false,
    supportsVision: true,
    supportsPromptCache: false,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    inputPricePerMillion: 2.5,
    outputPricePerMillion: 10,
    pricing: { inputPricePerMillion: 2.5, outputPricePerMillion: 10 },
    deprecated: false,
  },
  'gpt-4o-mini': {
    model: 'gpt-4o-mini',
    provider: 'openai',
    displayName: 'GPT-4o Mini',
    aliases: ['4o-mini'],
    maxContextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsTool: true,
    supportsThinking: false,
    supportsVision: true,
    supportsPromptCache: false,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    inputPricePerMillion: 0.15,
    outputPricePerMillion: 0.6,
    pricing: { inputPricePerMillion: 0.15, outputPricePerMillion: 0.6 },
    deprecated: false,
  },
  'o3': {
    model: 'o3',
    provider: 'openai',
    displayName: 'o3',
    aliases: [],
    maxContextWindow: 200_000,
    maxOutputTokens: 100_000,
    supportsTool: true,
    supportsThinking: true,
    supportsVision: true,
    supportsPromptCache: false,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    inputPricePerMillion: 10,
    outputPricePerMillion: 40,
    pricing: { inputPricePerMillion: 10, outputPricePerMillion: 40 },
    deprecated: false,
  },
  'o3-mini': {
    model: 'o3-mini',
    provider: 'openai',
    displayName: 'o3-mini',
    aliases: [],
    maxContextWindow: 200_000,
    maxOutputTokens: 100_000,
    supportsTool: true,
    supportsThinking: true,
    supportsVision: false,
    supportsPromptCache: false,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    inputPricePerMillion: 1.1,
    outputPricePerMillion: 4.4,
    pricing: { inputPricePerMillion: 1.1, outputPricePerMillion: 4.4 },
    deprecated: false,
  },

  // ─── DeepSeek ───
  'deepseek-chat': {
    model: 'deepseek-chat',
    provider: 'deepseek',
    displayName: 'DeepSeek V3',
    aliases: ['deepseek-v3', 'deepseek'],
    maxContextWindow: 64_000,
    maxOutputTokens: 8_192,
    supportsTool: true,
    supportsThinking: false,
    supportsVision: false,
    supportsPromptCache: true,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    inputPricePerMillion: 0.27,
    outputPricePerMillion: 1.1,
    pricing: {
      inputPricePerMillion: 0.27,
      outputPricePerMillion: 1.1,
      cacheReadPricePerMillion: 0.07,
    },
    deprecated: false,
  },
  'deepseek-reasoner': {
    model: 'deepseek-reasoner',
    provider: 'deepseek',
    displayName: 'DeepSeek R1',
    aliases: ['deepseek-r1', 'r1'],
    maxContextWindow: 64_000,
    maxOutputTokens: 8_192,
    supportsTool: true,
    supportsThinking: true,
    supportsVision: false,
    supportsPromptCache: true,
    supportsStreaming: true,
    supportsParallelToolCalls: false,
    inputPricePerMillion: 0.55,
    outputPricePerMillion: 2.19,
    pricing: {
      inputPricePerMillion: 0.55,
      outputPricePerMillion: 2.19,
      cacheReadPricePerMillion: 0.14,
    },
    deprecated: false,
  },

  // ─── 通义千问 ───
  'qwen-max': {
    model: 'qwen-max',
    provider: 'qwen',
    displayName: '通义千问 Max',
    aliases: ['qwen'],
    maxContextWindow: 32_000,
    maxOutputTokens: 8_192,
    supportsTool: true,
    supportsThinking: false,
    supportsVision: false,
    supportsPromptCache: false,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    inputPricePerMillion: 2.4,
    outputPricePerMillion: 9.6,
    pricing: { inputPricePerMillion: 2.4, outputPricePerMillion: 9.6 },
    deprecated: false,
  },
  'qwen-plus': {
    model: 'qwen-plus',
    provider: 'qwen',
    displayName: '通义千问 Plus',
    aliases: [],
    maxContextWindow: 131_072,
    maxOutputTokens: 8_192,
    supportsTool: true,
    supportsThinking: false,
    supportsVision: false,
    supportsPromptCache: false,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    inputPricePerMillion: 0.8,
    outputPricePerMillion: 2,
    pricing: { inputPricePerMillion: 0.8, outputPricePerMillion: 2 },
    deprecated: false,
  },

  // ─── 智谱 GLM ───
  'glm-4-plus': {
    model: 'glm-4-plus',
    provider: 'glm',
    displayName: 'GLM-4 Plus',
    aliases: ['glm-4', 'glm'],
    maxContextWindow: 128_000,
    maxOutputTokens: 4_096,
    supportsTool: true,
    supportsThinking: false,
    supportsVision: false,
    supportsPromptCache: false,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    inputPricePerMillion: 7.14,
    outputPricePerMillion: 7.14,
    pricing: { inputPricePerMillion: 7.14, outputPricePerMillion: 7.14 },
    deprecated: false,
  },
  'glm-4-flash': {
    model: 'glm-4-flash',
    provider: 'glm',
    displayName: 'GLM-4 Flash',
    aliases: ['glm-flash'],
    maxContextWindow: 128_000,
    maxOutputTokens: 4_096,
    supportsTool: true,
    supportsThinking: false,
    supportsVision: false,
    supportsPromptCache: false,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
    pricing: { inputPricePerMillion: 0, outputPricePerMillion: 0 },
    deprecated: false,
  },
};

// ─── 别名映射 ───

/** 构建别名 → 模型名映射 */
function buildAliasMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [modelId, info] of Object.entries(MODEL_REGISTRY)) {
    map.set(modelId.toLowerCase(), modelId);
    for (const alias of info.aliases) {
      map.set(alias.toLowerCase(), modelId);
    }
  }
  return map;
}

const aliasMap = buildAliasMap();

// ─── 公共 API ───

/**
 * 解析模型名称（支持别名）
 * @returns 标准模型 ID，如果未找到则返回原始输入
 */
export function resolveModelName(nameOrAlias: string): string {
  return aliasMap.get(nameOrAlias.toLowerCase()) || nameOrAlias;
}

/**
 * 获取模型信息
 * @returns 模型信息，如果未注册则返回 null
 */
export function getModelInfo(model: string): ModelInfo | null {
  const resolved = resolveModelName(model);
  return MODEL_REGISTRY[resolved] || null;
}

/**
 * 获取模型能力
 * 如果模型未注册，返回保守的默认值
 */
export function getModelCapabilities(model: string): ModelCapabilities {
  const info = getModelInfo(model);
  if (info) {
    return {
      model: info.model,
      provider: info.provider,
      maxContextWindow: info.maxContextWindow,
      maxOutputTokens: info.maxOutputTokens,
      supportsTool: info.supportsTool,
      supportsThinking: info.supportsThinking,
      supportsVision: info.supportsVision,
      supportsPromptCache: info.supportsPromptCache,
      supportsStreaming: info.supportsStreaming,
      supportsParallelToolCalls: info.supportsParallelToolCalls,
      inputPricePerMillion: info.inputPricePerMillion,
      outputPricePerMillion: info.outputPricePerMillion,
    };
  }

  // 未知模型的保守默认值
  return {
    model,
    provider: 'custom',
    maxContextWindow: 8_000,
    maxOutputTokens: 4_096,
    supportsTool: true,
    supportsThinking: false,
    supportsVision: false,
    supportsPromptCache: false,
    supportsStreaming: true,
    supportsParallelToolCalls: false,
    inputPricePerMillion: 0,
    outputPricePerMillion: 0,
  };
}

/**
 * 计算模型使用成本
 */
export function calculateModelCost(model: string, usage: TokenUsage): number {
  const info = getModelInfo(model);
  if (!info) return 0;

  const { pricing } = info;
  let cost = 0;

  cost += (usage.inputTokens / 1_000_000) * pricing.inputPricePerMillion;
  cost += (usage.outputTokens / 1_000_000) * pricing.outputPricePerMillion;

  if (usage.cacheCreationTokens && pricing.cacheWritePricePerMillion) {
    cost += (usage.cacheCreationTokens / 1_000_000) * pricing.cacheWritePricePerMillion;
  }
  if (usage.cacheReadTokens && pricing.cacheReadPricePerMillion) {
    cost += (usage.cacheReadTokens / 1_000_000) * pricing.cacheReadPricePerMillion;
  }

  return cost;
}

/**
 * 检查模型是否支持某个能力
 */
export function modelSupports(model: string, capability: keyof Pick<
  ModelCapabilities,
  'supportsTool' | 'supportsThinking' | 'supportsVision' | 'supportsPromptCache' | 'supportsStreaming' | 'supportsParallelToolCalls'
>): boolean {
  const caps = getModelCapabilities(model);
  return caps[capability];
}

/**
 * 获取所有已注册的模型列表
 */
export function getRegisteredModels(): ModelInfo[] {
  return Object.values(MODEL_REGISTRY).filter(m => !m.deprecated);
}

/**
 * 获取指定提供者的所有模型
 */
export function getModelsByProvider(provider: string): ModelInfo[] {
  return Object.values(MODEL_REGISTRY).filter(
    m => m.provider === provider && !m.deprecated,
  );
}

/**
 * 注册自定义模型
 */
export function registerModel(info: ModelInfo): void {
  MODEL_REGISTRY[info.model] = info;
  // 更新别名映射
  aliasMap.set(info.model.toLowerCase(), info.model);
  for (const alias of info.aliases) {
    aliasMap.set(alias.toLowerCase(), info.model);
  }
}

/**
 * 根据需求选择最优模型
 */
export function selectModel(requirements: {
  /** 需要工具调用 */
  needsTool?: boolean;
  /** 需要思考模式 */
  needsThinking?: boolean;
  /** 需要视觉能力 */
  needsVision?: boolean;
  /** 最低上下文窗口 */
  minContextWindow?: number;
  /** 偏好的提供者 */
  preferredProvider?: string;
  /** 最大每百万 token 价格 */
  maxPricePerMillion?: number;
}): ModelInfo | null {
  const candidates = Object.values(MODEL_REGISTRY).filter(m => {
    if (m.deprecated) return false;
    if (requirements.needsTool && !m.supportsTool) return false;
    if (requirements.needsThinking && !m.supportsThinking) return false;
    if (requirements.needsVision && !m.supportsVision) return false;
    if (requirements.minContextWindow && m.maxContextWindow < requirements.minContextWindow) return false;
    if (requirements.preferredProvider && m.provider !== requirements.preferredProvider) return false;
    if (requirements.maxPricePerMillion && m.inputPricePerMillion > requirements.maxPricePerMillion) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  // 按性价比排序（上下文窗口 / 价格）
  candidates.sort((a, b) => {
    const aScore = a.maxContextWindow / Math.max(a.inputPricePerMillion, 0.01);
    const bScore = b.maxContextWindow / Math.max(b.inputPricePerMillion, 0.01);
    return bScore - aScore;
  });

  return candidates[0]!;
}
