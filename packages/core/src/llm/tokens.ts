/**
 * Token 估算服务
 *
 * 参考 Claude Code: src/utils/tokens.ts + src/services/tokenEstimation.ts
 *
 * 提供多种 token 估算方法：
 * 1. 基于字符的快速估算（无依赖）
 * 2. 基于消息结构的精确估算
 * 3. 工具定义的 token 开销估算
 */

import type { ChatMessage, ContentBlock, ToolDefinition, TokenUsage } from './types.js';

// ─── 常量 ───

/** 每个消息的固定开销（角色标记、分隔符等） */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** 每个工具定义的固定开销 */
const TOOL_DEFINITION_OVERHEAD = 20;

/** System prompt 的固定开销 */
const SYSTEM_PROMPT_OVERHEAD = 4;

// ─── 快速估算 ───

/**
 * 快速估算文本的 token 数
 *
 * 基于字符统计的启发式方法：
 * - 英文：约 4 个字符 = 1 个 token
 * - 中文/日文/韩文：约 1.5 个字符 = 1 个 token
 * - 代码：约 3.5 个字符 = 1 个 token（因为有很多短标识符和符号）
 *
 * 精度：±15%（对于大多数场景足够用于上下文管理）
 */
export function estimateTokensFast(text: string): number {
  if (!text) return 0;

  let tokens = 0;
  let i = 0;

  while (i < text.length) {
    const code = text.charCodeAt(i);

    // CJK 统一表意文字（中文、日文汉字、韩文汉字）
    if (
      (code >= 0x4E00 && code <= 0x9FFF) ||   // CJK 基本
      (code >= 0x3400 && code <= 0x4DBF) ||   // CJK 扩展 A
      (code >= 0x20000 && code <= 0x2A6DF) || // CJK 扩展 B
      (code >= 0xF900 && code <= 0xFAFF)      // CJK 兼容
    ) {
      tokens += 0.67; // 约 1.5 字符 = 1 token
    }
    // 日文假名
    else if (
      (code >= 0x3040 && code <= 0x309F) || // 平假名
      (code >= 0x30A0 && code <= 0x30FF)    // 片假名
    ) {
      tokens += 0.5;
    }
    // 韩文音节
    else if (code >= 0xAC00 && code <= 0xD7AF) {
      tokens += 0.67;
    }
    // ASCII
    else if (code < 128) {
      tokens += 0.25; // 约 4 字符 = 1 token
    }
    // 其他 Unicode
    else {
      tokens += 0.5;
    }

    i++;
  }

  // 至少 1 个 token
  return Math.max(1, Math.ceil(tokens));
}

// ─── 消息级估算 ───

/**
 * 估算单个 ContentBlock 的 token 数
 */
function estimateContentBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTokensFast(block.text);

    case 'image':
      // 图片 token 取决于分辨率，这里使用保守估算
      // Anthropic: 低分辨率 ~85 tokens, 高分辨率 ~1600 tokens
      return 1000;

    case 'tool_use':
      return (
        estimateTokensFast(block.name) +
        estimateTokensFast(JSON.stringify(block.input)) +
        10 // tool_use 结构开销
      );

    case 'tool_result':
      return (
        estimateTokensFast(block.content) +
        10 // tool_result 结构开销
      );

    default:
      return 0;
  }
}

/**
 * 估算单条消息的 token 数
 */
export function estimateMessageTokens(message: ChatMessage): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS;

  if (typeof message.content === 'string') {
    tokens += estimateTokensFast(message.content);
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      tokens += estimateContentBlockTokens(block);
    }
  }

  return tokens;
}

/**
 * 估算消息列表的总 token 数
 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

/**
 * 估算 System Prompt 的 token 数
 */
export function estimateSystemPromptTokens(systemPrompt: string): number {
  return SYSTEM_PROMPT_OVERHEAD + estimateTokensFast(systemPrompt);
}

/**
 * 估算工具定义的 token 数
 */
export function estimateToolDefinitionsTokens(tools: ToolDefinition[]): number {
  let total = 0;
  for (const tool of tools) {
    total += TOOL_DEFINITION_OVERHEAD;
    total += estimateTokensFast(tool.name);
    total += estimateTokensFast(tool.description);
    total += estimateTokensFast(JSON.stringify(tool.inputSchema));
  }
  return total;
}

/**
 * 估算完整请求的 token 数（用于上下文管理）
 */
export function estimateRequestTokens(params: {
  messages: ChatMessage[];
  systemPrompt?: string;
  tools?: ToolDefinition[];
}): number {
  let total = 0;

  if (params.systemPrompt) {
    total += estimateSystemPromptTokens(params.systemPrompt);
  }

  total += estimateMessagesTokens(params.messages);

  if (params.tools) {
    total += estimateToolDefinitionsTokens(params.tools);
  }

  return total;
}

// ─── Token 预算管理 ───

/**
 * Token 预算
 * 用于管理上下文窗口的 token 分配
 */
export interface TokenBudget {
  /** 总预算（模型的最大上下文窗口） */
  total: number;
  /** System Prompt 预算 */
  systemPrompt: number;
  /** 工具定义预算 */
  toolDefinitions: number;
  /** 输出预留（maxOutputTokens） */
  outputReserve: number;
  /** 消息历史可用预算 */
  messageHistory: number;
}

/**
 * 计算 token 预算分配
 */
export function calculateTokenBudget(params: {
  maxContextWindow: number;
  maxOutputTokens: number;
  systemPromptTokens: number;
  toolDefinitionsTokens: number;
}): TokenBudget {
  const { maxContextWindow, maxOutputTokens, systemPromptTokens, toolDefinitionsTokens } = params;

  // 消息历史可用 = 总预算 - 系统提示 - 工具定义 - 输出预留 - 安全边际
  const safetyMargin = Math.floor(maxContextWindow * 0.05); // 5% 安全边际
  const messageHistory = Math.max(
    0,
    maxContextWindow - systemPromptTokens - toolDefinitionsTokens - maxOutputTokens - safetyMargin,
  );

  return {
    total: maxContextWindow,
    systemPrompt: systemPromptTokens,
    toolDefinitions: toolDefinitionsTokens,
    outputReserve: maxOutputTokens,
    messageHistory,
  };
}

// ─── 成本计算 ───

/**
 * 计算请求成本（美元）
 */
export function calculateCost(
  usage: TokenUsage,
  pricing: { inputPricePerMillion: number; outputPricePerMillion: number },
): number {
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputPricePerMillion;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputPricePerMillion;
  return inputCost + outputCost;
}

/**
 * 格式化 token 用量为可读字符串
 */
export function formatTokenUsage(usage: TokenUsage): string {
  const parts: string[] = [];
  parts.push(`${usage.inputTokens.toLocaleString()} in`);
  parts.push(`${usage.outputTokens.toLocaleString()} out`);

  if (usage.cacheReadTokens) {
    parts.push(`${usage.cacheReadTokens.toLocaleString()} cache-read`);
  }
  if (usage.cacheCreationTokens) {
    parts.push(`${usage.cacheCreationTokens.toLocaleString()} cache-write`);
  }

  const total = usage.inputTokens + usage.outputTokens;
  let result = `${total.toLocaleString()} tokens (${parts.join(', ')})`;

  if (usage.totalCostUSD !== undefined) {
    result += ` | $${usage.totalCostUSD.toFixed(4)}`;
  }

  return result;
}
