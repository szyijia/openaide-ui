/**
 * AskUserQuestionTool — 向用户提问工具
 *
 * 参考 Claude Code: src/tools/AskUserQuestionTool/
 * 允许 Agent 在需要更多信息时主动向用户提问
 *
 * 使用场景：
 * - Agent 需要用户澄清需求
 * - 需要用户在多个方案中做选择
 * - 需要用户确认关键操作
 * - 需要用户提供缺失的信息（如 API key、配置等）
 */

import type { Tool, ToolResult, ToolPermission, ToolContext } from './types.js';

/**
 * 用户回答回调类型
 * 由外部（如 BridgeServer / VS Code Extension）注入
 */
export type AskUserCallback = (question: string, options?: AskUserOptions) => Promise<string>;

/** 提问选项 */
export interface AskUserOptions {
  /** 预设选项（如果提供，用户可以从中选择） */
  choices?: string[];
  /** 是否允许自由输入（默认 true） */
  allowFreeInput?: boolean;
  /** 默认值 */
  defaultValue?: string;
  /** 超时时间（毫秒），0 表示不超时 */
  timeout?: number;
  /** 是否为敏感信息（如密码，不应记录到日志） */
  sensitive?: boolean;
}

/** 默认超时：5 分钟 */
const DEFAULT_TIMEOUT = 5 * 60 * 1000;

/**
 * 创建 AskUserQuestionTool
 *
 * 需要注入 askUser 回调，因为提问的实现取决于运行环境：
 * - VS Code Extension: 通过 Webview 消息通道
 * - CLI: 通过 stdin/stdout
 * - Bridge: 通过 WebSocket
 */
export function createAskUserQuestionTool(askUser?: AskUserCallback): Tool {
  return {
    name: 'ask_user',
    description: '向用户提问以获取更多信息或确认',

    prompt: `向用户提出问题以获取更多信息。

使用场景：
- 当你需要用户澄清模糊的需求时
- 当有多个可行方案需要用户选择时
- 当你需要用户确认重要操作前
- 当缺少必要信息（如配置、偏好等）时

注意事项：
- 问题应该清晰、具体，避免模糊的开放式问题
- 如果可以通过上下文推断答案，不要提问
- 不要频繁提问，尽量一次性收集所有需要的信息
- 如果提供了 choices，用户可以从预设选项中选择
- 问题应该用用户能理解的语言表述`,

    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '要向用户提出的问题',
        },
        choices: {
          type: 'array',
          items: { type: 'string' },
          description: '可选的预设选项列表，用户可以从中选择',
        },
        allow_free_input: {
          type: 'boolean',
          description: '是否允许用户自由输入（默认 true）',
        },
        default_value: {
          type: 'string',
          description: '默认值（用户直接回车时使用）',
        },
      },
      required: ['question'],
    },

    permission: {
      default: 'always_allow',
      userConfigurable: false,
    } as ToolPermission,

    concurrentSafe: false, // 提问需要串行，避免多个问题同时弹出

    async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const question = input.question as string;
      const choices = input.choices as string[] | undefined;
      const allowFreeInput = (input.allow_free_input as boolean) ?? true;
      const defaultValue = input.default_value as string | undefined;

      if (!question || question.trim().length === 0) {
        return {
          content: 'Error: question is required and cannot be empty',
          isError: true,
        };
      }

      // 如果没有注入 askUser 回调，返回提示信息
      if (!askUser) {
        return {
          content: `[AskUser] 无法向用户提问（未配置交互通道）。问题: ${question}`,
          isError: true,
          metadata: { question, choices, noCallback: true },
        };
      }

      try {
        // 构建提问选项
        const options: AskUserOptions = {
          choices,
          allowFreeInput,
          defaultValue,
          timeout: DEFAULT_TIMEOUT,
        };

        // 使用 AbortSignal 支持取消
        const answer = await Promise.race([
          askUser(question, options),
          new Promise<never>((_, reject) => {
            if (context.abortSignal.aborted) {
              reject(new Error('提问被用户取消'));
            }
            context.abortSignal.addEventListener('abort', () => {
              reject(new Error('提问被用户取消'));
            }, { once: true });
          }),
        ]);

        if (!answer || answer.trim().length === 0) {
          return {
            content: '用户未提供回答（空回复）',
            metadata: { question, emptyAnswer: true },
          };
        }

        return {
          content: answer,
          metadata: {
            question,
            choices,
            answer,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes('取消') || message.includes('abort') || message.includes('cancel')) {
          return {
            content: '用户取消了提问',
            isError: false,
            metadata: { question, cancelled: true },
          };
        }

        if (message.includes('timeout') || message.includes('超时')) {
          return {
            content: '提问超时，用户未在规定时间内回答',
            isError: true,
            metadata: { question, timeout: true },
          };
        }

        return {
          content: `提问失败: ${message}`,
          isError: true,
          metadata: { question },
        };
      }
    },
  };
}
