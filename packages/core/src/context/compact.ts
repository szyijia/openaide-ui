/**
 * 上下文压缩服务
 *
 * 当对话历史过长（接近模型上下文窗口限制）时，
 * 自动压缩历史消息以释放空间。
 *
 * 压缩策略（参考 Claude Code 的 9 步结构化压缩）：
 * 1. 保留 System Prompt（不压缩）
 * 2. 保留最近 N 轮对话（不压缩）
 * 3. 对早期对话进行摘要压缩
 * 4. 工具调用结果压缩（只保留关键信息）
 * 5. 代码块压缩（只保留文件名和变更摘要）
 * 6. 微压缩（移除冗余空白和重复内容）
 *
 * 触发条件：
 * - 自动触发：当 Token 使用量超过上下文窗口的 80%
 * - 手动触发：用户主动请求压缩
 */

import type { LLMProvider, ChatMessage } from '../llm/types.js';

// ─── 类型定义 ───

/** 压缩配置 */
export interface CompactConfig {
  /** 上下文窗口大小（Token） */
  maxContextTokens: number;
  /** 触发压缩的阈值（占比，0-1） */
  compactThreshold: number;
  /** 保留最近 N 轮对话不压缩 */
  keepRecentTurns: number;
  /** 压缩后的目标 Token 数（占比） */
  targetRatio: number;
  /** 是否启用微压缩 */
  enableMicroCompact: boolean;
}

/** 压缩结果 */
export interface CompactResult {
  /** 压缩后的消息列表 */
  messages: ChatMessage[];
  /** 压缩前的 Token 数 */
  originalTokens: number;
  /** 压缩后的 Token 数 */
  compactedTokens: number;
  /** 压缩摘要 */
  summary: string;
  /** 被压缩的消息数 */
  compactedMessageCount: number;
}

/** 压缩统计 */
export interface CompactStats {
  totalCompactions: number;
  totalTokensSaved: number;
  lastCompactedAt: string | null;
}

// ─── 默认配置 ───

const DEFAULT_CONFIG: CompactConfig = {
  maxContextTokens: 128000,
  compactThreshold: 0.8,
  keepRecentTurns: 4,
  targetRatio: 0.5,
  enableMicroCompact: true,
};

// ─── 压缩 Prompt ───

const COMPACT_SYSTEM_PROMPT = `你是一个对话历史压缩助手。你的任务是将一段较长的 AI 编程助手对话历史压缩为简洁的摘要。

## 压缩规则

1. **保留关键信息**：
   - 用户的核心需求和意图
   - 重要的技术决策和选择
   - 已完成的文件修改（文件路径 + 变更摘要）
   - 遇到的错误和解决方案
   - 用户的偏好和约束

2. **可以省略的信息**：
   - 工具调用的详细参数和完整输出
   - 代码的完整内容（只保留文件名和变更描述）
   - 中间的思考过程和探索步骤
   - 重复的确认和反馈

3. **输出格式**：
   使用结构化的摘要格式：
   
   ## 对话摘要
   
   ### 用户需求
   [简述用户的核心需求]
   
   ### 已完成的工作
   - [文件路径]: [变更描述]
   - ...
   
   ### 关键决策
   - [决策1]
   - [决策2]
   
   ### 当前状态
   [当前进展和下一步]
   
   ### 注意事项
   - [需要记住的约束或偏好]

4. **长度要求**：摘要应该是原始对话的 1/5 到 1/3 长度。`;

// ─── CompactService ───

export class CompactService {
  private config: CompactConfig;
  private stats: CompactStats = {
    totalCompactions: 0,
    totalTokensSaved: 0,
    lastCompactedAt: null,
  };

  constructor(
    private readonly provider: LLMProvider,
    config?: Partial<CompactConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // 根据 Provider 的上下文窗口调整配置
    if (provider.maxContextWindow) {
      this.config.maxContextTokens = provider.maxContextWindow;
    }
  }

  /**
   * 检查是否需要压缩
   */
  shouldCompact(messages: readonly ChatMessage[]): boolean {
    const estimatedTokens = this.estimateTokens(messages);
    const threshold = this.config.maxContextTokens * this.config.compactThreshold;
    return estimatedTokens > threshold;
  }

  /**
   * 执行上下文压缩
   *
   * 将早期对话历史压缩为摘要，保留最近的对话
   */
  async compact(messages: readonly ChatMessage[]): Promise<CompactResult> {
    const originalTokens = this.estimateTokens(messages);

    // 1. 分离：保留最近 N 轮对话
    const { toCompact, toKeep } = this.splitMessages(messages);

    if (toCompact.length === 0) {
      return {
        messages: [...messages],
        originalTokens,
        compactedTokens: originalTokens,
        summary: '',
        compactedMessageCount: 0,
      };
    }

    // 2. 微压缩：先对要压缩的消息做预处理
    const preprocessed = this.config.enableMicroCompact
      ? this.microCompact(toCompact)
      : toCompact;

    // 3. 使用 LLM 生成摘要
    const summary = await this.generateSummary(preprocessed);

    // 4. 构建压缩后的消息列表
    const summaryMessage: ChatMessage = {
      role: 'user',
      content: `[以下是之前对话的压缩摘要，请基于此继续对话]\n\n${summary}`,
    };

    const compactedMessages: ChatMessage[] = [summaryMessage, ...toKeep];

    const compactedTokens = this.estimateTokens(compactedMessages);

    // 更新统计
    this.stats.totalCompactions++;
    this.stats.totalTokensSaved += originalTokens - compactedTokens;
    this.stats.lastCompactedAt = new Date().toISOString();

    return {
      messages: compactedMessages,
      originalTokens,
      compactedTokens,
      summary,
      compactedMessageCount: toCompact.length,
    };
  }

  /**
   * 自动压缩（检查 + 执行）
   *
   * 如果需要压缩则执行，否则返回原消息
   */
  async autoCompact(messages: readonly ChatMessage[]): Promise<{ messages: ChatMessage[]; compacted: boolean }> {
    if (!this.shouldCompact(messages)) {
      return { messages: [...messages], compacted: false };
    }

    const result = await this.compact(messages);
    return { messages: result.messages, compacted: true };
  }

  /**
   * 微压缩 — 不使用 LLM，纯规则压缩
   *
   * 处理：
   * - 截断过长的工具调用结果
   * - 移除重复的空白行
   * - 压缩代码块（只保留首尾几行）
   * - 截断过长的错误堆栈
   */
  microCompact(messages: readonly ChatMessage[]): ChatMessage[] {
    return messages.map((msg) => {
      const content = this.getTextContent(msg);
      if (!content) return msg;

      let compressed = content;

      // 1. 压缩代码块（超过 30 行的只保留首尾 5 行）
      compressed = compressed.replace(
        /```(\w*)\n([\s\S]*?)```/g,
        (_match, lang: string, code: string) => {
          const lines = code.split('\n');
          if (lines.length > 30) {
            const head = lines.slice(0, 5).join('\n');
            const tail = lines.slice(-5).join('\n');
            return `\`\`\`${lang}\n${head}\n// ... (${lines.length - 10} 行已省略) ...\n${tail}\`\`\``;
          }
          return `\`\`\`${lang}\n${code}\`\`\``;
        },
      );

      // 2. 截断过长的错误堆栈
      compressed = compressed.replace(
        /((?:at\s+.+\n){5})(?:at\s+.+\n)+/g,
        '$1    ... (更多堆栈已省略)\n',
      );

      // 3. 移除连续空行（保留最多 1 个）
      compressed = compressed.replace(/\n{3,}/g, '\n\n');

      // 4. 截断超长的单行输出（如 JSON）
      compressed = compressed.replace(
        /^(.{500}).{100,}$/gm,
        '$1... (已截断)',
      );

      return this.setTextContent(msg, compressed);
    });
  }

  /**
   * 分离消息：需要压缩的 vs 保留的
   */
  private splitMessages(messages: readonly ChatMessage[]): {
    toCompact: ChatMessage[];
    toKeep: ChatMessage[];
  } {
    // 计算保留的消息数量（按轮次计算）
    let keepCount = 0;
    let turns = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') {
        turns++;
      }
      if (turns > this.config.keepRecentTurns) {
        break;
      }
      keepCount++;
    }

    const splitIndex = messages.length - keepCount;

    return {
      toCompact: messages.slice(0, splitIndex),
      toKeep: messages.slice(splitIndex),
    };
  }

  /**
   * 使用 LLM 生成对话摘要
   */
  private async generateSummary(messages: readonly ChatMessage[]): Promise<string> {
    // 构建要压缩的对话文本
    const conversationText = messages
      .map((msg) => {
        const role = msg.role === 'user' ? '用户' : 'AI';
        const content = this.getTextContent(msg);
        return `[${role}]: ${content}`;
      })
      .join('\n\n');

    try {
      // 使用 LLM 生成摘要
      let summary = '';

      for await (const event of this.provider.chatStream({
        messages: [
          {
            role: 'user',
            content: `请压缩以下对话历史：\n\n${conversationText}`,
          },
        ],
        systemPrompt: COMPACT_SYSTEM_PROMPT,
        maxTokens: 2000,
        temperature: 0.3,
      })) {
        if (event.type === 'text_delta') {
          summary += event.text;
        }
      }

      return summary || this.fallbackSummary(messages);
    } catch (error) {
      console.error('[Compact] LLM 摘要生成失败:', error);
      return this.fallbackSummary(messages);
    }
  }

  /**
   * 降级摘要（LLM 不可用时）
   *
   * 使用纯规则生成简单摘要
   */
  private fallbackSummary(messages: readonly ChatMessage[]): string {
    const userMessages = messages.filter((m) => m.role === 'user');
    const assistantMessages = messages.filter((m) => m.role === 'assistant');

    const topics = userMessages
      .map((m) => {
        const text = this.getTextContent(m);
        return text ? text.substring(0, 100) : '';
      })
      .filter(Boolean)
      .slice(0, 5);

    return [
      '## 对话摘要（自动生成）',
      '',
      `共 ${messages.length} 条消息（${userMessages.length} 条用户消息，${assistantMessages.length} 条 AI 回复）`,
      '',
      '### 讨论主题',
      ...topics.map((t, i) => `${i + 1}. ${t}...`),
      '',
      '### 注意',
      '此摘要为自动生成，可能遗漏部分细节。',
    ].join('\n');
  }

  /**
   * 估算消息列表的 Token 数
   *
   * 使用简单的字符数估算（1 Token ≈ 4 字符英文 / 2 字符中文）
   */
  estimateTokens(messages: readonly ChatMessage[]): number {
    let totalChars = 0;

    for (const msg of messages) {
      const content = this.getTextContent(msg);
      if (content) {
        // 粗略估算：中文字符按 0.5 token/char，英文按 0.25 token/char
        const chineseChars = (content.match(/[\u4e00-\u9fff]/g) || []).length;
        const otherChars = content.length - chineseChars;
        totalChars += chineseChars * 2 + otherChars;
      }
    }

    // 1 Token ≈ 4 字符
    return Math.ceil(totalChars / 4);
  }

  /**
   * 获取消息的文本内容
   */
  private getTextContent(msg: ChatMessage): string {
    if (typeof msg.content === 'string') {
      return msg.content;
    }
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');
    }
    return '';
  }

  /**
   * 设置消息的文本内容（保持原始结构）
   */
  private setTextContent(msg: ChatMessage, text: string): ChatMessage {
    if (typeof msg.content === 'string') {
      return { ...msg, content: text };
    }
    // 对于复杂内容，替换第一个 text block
    if (Array.isArray(msg.content)) {
      const newContent = msg.content.map((block) => {
        if (block.type === 'text') {
          return { ...block, text };
        }
        return block;
      });
      return { ...msg, content: newContent };
    }
    return msg;
  }

  /**
   * 获取压缩统计
   */
  getStats(): CompactStats {
    return { ...this.stats };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<CompactConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
