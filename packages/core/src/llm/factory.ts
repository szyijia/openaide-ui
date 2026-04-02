/**
 * LLM Provider 工厂
 *
 * 根据配置创建对应的 LLM Provider 实例
 */

import type { LLMProvider, ProviderConfig } from './types.js';
import { OpenAICompatibleProvider } from './providers/openai-compatible.js';
import { AnthropicProvider } from './providers/anthropic.js';

/** 创建 LLM Provider 实例 */
export function createProvider(config: ProviderConfig): LLMProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'openai':
    case 'deepseek':
    case 'qwen':
    case 'glm':
    case 'custom':
      return new OpenAICompatibleProvider(config);
    case 'ollama':
      return new OpenAICompatibleProvider({
        ...config,
        baseUrl: config.baseUrl || 'http://localhost:11434/v1',
        apiKey: config.apiKey || 'ollama', // Ollama 不需要真实 API Key
      });
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

/**
 * 从环境变量自动检测并创建 Provider
 *
 * 优先级：
 * 1. OPENAIDE_PROVIDER 指定的 Provider
 * 2. 自定义模型（CUSTOM_API_KEY + CUSTOM_BASE_URL）
 * 3. 自动检测：ANTHROPIC_API_KEY → OPENAI_API_KEY → DEEPSEEK_API_KEY → QWEN_API_KEY → GLM_API_KEY
 */
export function createProviderFromEnv(model?: string): LLMProvider {
  const specifiedProvider = process.env.OPENAIDE_PROVIDER;

  // 如果明确指定了 Provider，优先使用
  if (specifiedProvider) {
    const providerKeyMap: Record<string, { envKey: string; defaultModel: string }> = {
      anthropic: { envKey: 'ANTHROPIC_API_KEY', defaultModel: 'claude-sonnet-4-20250514' },
      openai: { envKey: 'OPENAI_API_KEY', defaultModel: 'gpt-4o' },
      deepseek: { envKey: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-chat' },
      qwen: { envKey: 'DASHSCOPE_API_KEY', defaultModel: 'qwen-max' },
      glm: { envKey: 'GLM_API_KEY', defaultModel: 'glm-5.1' },
    };

    const mapping = providerKeyMap[specifiedProvider];
    if (mapping) {
      const apiKey = process.env[mapping.envKey];
      if (apiKey) {
        return createProvider({
          provider: specifiedProvider as ProviderConfig['provider'],
          apiKey,
          model: model || process.env.OPENAIDE_MODEL || mapping.defaultModel,
        });
      }
    }

    // 自定义 Provider
    if (specifiedProvider === 'custom' && process.env.CUSTOM_API_KEY) {
      return createProvider({
        provider: 'custom',
        apiKey: process.env.CUSTOM_API_KEY,
        baseUrl: process.env.CUSTOM_BASE_URL,
        model: model || process.env.CUSTOM_MODEL || process.env.OPENAIDE_MODEL || 'gpt-4o',
      });
    }

    // Ollama
    if (specifiedProvider === 'ollama') {
      return createProvider({
        provider: 'ollama',
        model: model || process.env.OPENAIDE_MODEL || 'qwen2.5-coder',
      });
    }
  }

  // 自定义模型（有 CUSTOM_API_KEY 和 CUSTOM_BASE_URL）
  if (process.env.CUSTOM_API_KEY && process.env.CUSTOM_BASE_URL) {
    return createProvider({
      provider: 'custom',
      apiKey: process.env.CUSTOM_API_KEY,
      baseUrl: process.env.CUSTOM_BASE_URL,
      model: model || process.env.CUSTOM_MODEL || 'gpt-4o',
    });
  }

  // 自动检测
  if (process.env.ANTHROPIC_API_KEY) {
    return createProvider({
      provider: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: model || 'claude-sonnet-4-20250514',
    });
  }

  if (process.env.OPENAI_API_KEY) {
    return createProvider({
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      model: model || 'gpt-4o',
    });
  }

  if (process.env.DEEPSEEK_API_KEY) {
    return createProvider({
      provider: 'deepseek',
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: model || 'deepseek-chat',
    });
  }

  if (process.env.DASHSCOPE_API_KEY) {
    return createProvider({
      provider: 'qwen',
      apiKey: process.env.DASHSCOPE_API_KEY,
      model: model || 'qwen-max',
    });
  }

  if (process.env.GLM_API_KEY) {
    return createProvider({
      provider: 'glm',
      apiKey: process.env.GLM_API_KEY,
      model: model || 'glm-5.1',
    });
  }

  throw new Error(
    '未找到 API Key。请在设置中配置，或设置以下环境变量之一：\n' +
    '  ANTHROPIC_API_KEY — Claude 模型\n' +
    '  OPENAI_API_KEY — OpenAI 模型\n' +
    '  DEEPSEEK_API_KEY — DeepSeek 模型\n' +
    '  DASHSCOPE_API_KEY — 通义千问模型\n' +
    '  GLM_API_KEY — 智谱 GLM 模型\n' +
    '  CUSTOM_API_KEY + CUSTOM_BASE_URL — 自定义模型',
  );
}
