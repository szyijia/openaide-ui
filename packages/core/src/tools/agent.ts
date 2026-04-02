/**
 * AgentTool — 子 Agent 工具（增强版）
 *
 * 参考 Claude Code: src/tools/AgentTool/ (20 文件, 6,782 行)
 *
 * 增强功能：
 * - 子 Agent 生命周期管理（创建、运行、终止、清理）
 * - 上下文传递（父 Agent 可以传递文件列表、代码片段等）
 * - 结果聚合与摘要
 * - 并发控制（限制同时运行的子 Agent 数量）
 * - 子 Agent 嵌套深度限制
 * - 进度报告
 * - 资源使用追踪
 */

import type { Tool, ToolContext, ToolResult } from './types.js';
import type { ToolDefinition, LLMProvider, TokenUsage } from '../llm/types.js';
import type { ToolRegistry } from './registry.js';
import { createTimer, truncateOutput } from './shared.js';

/** AgentTool 需要的外部依赖（通过工厂函数注入） */
export interface AgentToolDeps {
  /** LLM Provider 实例 */
  provider: LLMProvider;
  /** 工具注册表（子 Agent 可用的工具） */
  tools: ToolRegistry;
  /** System Prompt */
  systemPrompt: string;
  /** 工作目录 */
  cwd: string;
  /** 最大工具调用轮数 */
  maxToolRounds?: number;
  /** 当前嵌套深度（内部使用） */
  nestingDepth?: number;
}

// ─── 常量 ───

/** 最大嵌套深度（防止无限递归） */
const MAX_NESTING_DEPTH = 3;

/** 最大并发子 Agent 数 */
const MAX_CONCURRENT_AGENTS = 5;

/** 子 Agent 默认超时（3 分钟） */
const DEFAULT_TIMEOUT = 180_000;

/** 子 Agent 最大输出长度 */
const MAX_RESULT_LENGTH = 50_000;

// ─── 子 Agent 追踪 ───

/** 子 Agent 状态 */
export type SubAgentStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** 子 Agent 信息 */
export interface SubAgentInfo {
  id: string;
  task: string;
  status: SubAgentStatus;
  startedAt: Date;
  endedAt?: Date;
  toolCallCount: number;
  usage: TokenUsage;
  nestingDepth: number;
}

/** 全局子 Agent 追踪器 */
class SubAgentTracker {
  private agents = new Map<string, SubAgentInfo>();
  private nextId = 1;
  private runningCount = 0;

  /** 注册新的子 Agent */
  register(task: string, nestingDepth: number): SubAgentInfo {
    const id = `agent_${this.nextId++}`;
    const info: SubAgentInfo = {
      id,
      task: task.substring(0, 200),
      status: 'running',
      startedAt: new Date(),
      toolCallCount: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      nestingDepth,
    };
    this.agents.set(id, info);
    this.runningCount++;
    return info;
  }

  /** 标记完成 */
  complete(id: string, usage: TokenUsage, toolCallCount: number): void {
    const info = this.agents.get(id);
    if (info && info.status === 'running') {
      info.status = 'completed';
      info.endedAt = new Date();
      info.usage = usage;
      info.toolCallCount = toolCallCount;
      this.runningCount--;
    }
  }

  /** 标记失败 */
  fail(id: string): void {
    const info = this.agents.get(id);
    if (info && info.status === 'running') {
      info.status = 'failed';
      info.endedAt = new Date();
      this.runningCount--;
    }
  }

  /** 标记取消 */
  cancel(id: string): void {
    const info = this.agents.get(id);
    if (info && info.status === 'running') {
      info.status = 'cancelled';
      info.endedAt = new Date();
      this.runningCount--;
    }
  }

  /** 获取运行中的数量 */
  getRunningCount(): number {
    return this.runningCount;
  }

  /** 获取所有子 Agent 信息 */
  getAll(): SubAgentInfo[] {
    return Array.from(this.agents.values());
  }

  /** 清理已完成的记录 */
  cleanup(): void {
    for (const [id, info] of this.agents) {
      if (info.status !== 'running') {
        this.agents.delete(id);
      }
    }
  }
}

const subAgentTracker = new SubAgentTracker();

/**
 * 创建 AgentTool 实例
 *
 * 使用工厂函数而非直接实例化，因为 AgentTool 需要访问
 * LLM Provider 和 ToolRegistry，这些在工具注册时可能还未初始化。
 */
export function createAgentTool(getDeps: () => AgentToolDeps): Tool {
  return {
    name: 'agent',
    description: '创建一个子 Agent 来执行独立的子任务',

    prompt: `使用此工具将任务委派给一个独立的子 Agent。子 Agent 有自己的对话上下文，可以使用文件读写、搜索等工具来完成任务。

适合委派的任务：
- 在大型代码库中搜索特定模式或实现
- 分析和理解某个模块的功能
- 执行独立的代码修改或重构
- 生成测试代码
- 收集项目信息和统计

不适合委派的任务：
- 需要与用户交互的任务
- 需要访问当前对话上下文的任务
- 非常简单的单步操作（直接用工具更高效）

高级选项：
- context: 传递给子 Agent 的额外上下文（文件路径、代码片段等）
- timeout: 超时时间（毫秒，默认 180000）
- files: 相关文件路径列表，子 Agent 会优先关注这些文件

注意：
- 子 Agent 无法看到主对话的历史
- 子 Agent 的工具调用不需要额外的用户审批
- 最多嵌套 ${MAX_NESTING_DEPTH} 层子 Agent
- 同时最多运行 ${MAX_CONCURRENT_AGENTS} 个子 Agent
- 请提供清晰、具体的任务描述，包含必要的上下文信息`,

    inputSchema: {
      type: 'object' as const,
      properties: {
        task: {
          type: 'string',
          description: '要委派给子 Agent 的任务描述。应该清晰、具体，包含完成任务所需的所有上下文信息。',
        },
        context: {
          type: 'string',
          description: '可选的额外上下文信息，如相关文件路径、代码片段等。',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: '相关文件路径列表，子 Agent 会优先关注这些文件。',
        },
        timeout: {
          type: 'number',
          description: `超时时间（毫秒），默认 ${DEFAULT_TIMEOUT}ms`,
        },
      },
      required: ['task'],
    },

    permission: {
      default: 'always_allow',
      userConfigurable: true,
    },

    concurrentSafe: true,

    async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const task = input.task as string;
      const extraContext = input.context as string | undefined;
      const files = input.files as string[] | undefined;
      const timeout = (input.timeout as number) || DEFAULT_TIMEOUT;

      if (!task || typeof task !== 'string') {
        return { content: 'Error: task 参数是必需的字符串', isError: true };
      }

      let deps: AgentToolDeps;
      try {
        deps = getDeps();
      } catch (error) {
        return {
          content: `Error: 无法初始化子 Agent — ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }

      // 嵌套深度检查
      const currentDepth = deps.nestingDepth || 0;
      if (currentDepth >= MAX_NESTING_DEPTH) {
        return {
          content: `Error: 子 Agent 嵌套深度已达上限 (${MAX_NESTING_DEPTH})。请简化任务结构。`,
          isError: true,
        };
      }

      // 并发限制检查
      if (subAgentTracker.getRunningCount() >= MAX_CONCURRENT_AGENTS) {
        return {
          content: `Error: 并发子 Agent 数已达上限 (${MAX_CONCURRENT_AGENTS})。请等待其他子 Agent 完成。`,
          isError: true,
        };
      }

      const timer = createTimer();

      // 注册子 Agent
      const agentInfo = subAgentTracker.register(task, currentDepth + 1);

      // 动态导入（避免循环依赖）
      const { AgentEngine } = await import('../agent/engine.js');
      const { ToolRegistry } = await import('./registry.js');

      // 创建子 Agent 的工具集（排除 AgentTool 自身或限制嵌套深度）
      const subTools = new ToolRegistry();
      for (const tool of deps.tools.getAll()) {
        if (tool.name === 'agent' && currentDepth + 1 >= MAX_NESTING_DEPTH) {
          continue; // 达到最大深度时不再提供 AgentTool
        }
        subTools.register(tool);
      }

      // 构建子 Agent 的 System Prompt
      const subSystemPromptParts = [
        deps.systemPrompt,
        '',
        `你是一个子 Agent（深度 ${currentDepth + 1}/${MAX_NESTING_DEPTH}），被主 Agent 委派来执行特定任务。`,
        '请专注于完成分配的任务，完成后给出清晰的结果摘要。',
        '不要询问用户问题，直接使用可用的工具来完成任务。',
      ];

      // 添加文件上下文
      if (files && files.length > 0) {
        subSystemPromptParts.push('');
        subSystemPromptParts.push('相关文件（请优先关注）：');
        for (const f of files) {
          subSystemPromptParts.push(`  - ${f}`);
        }
      }

      const subSystemPrompt = subSystemPromptParts.join('\n');

      // 创建子 Agent Engine
      const subEngine = new AgentEngine({
        provider: deps.provider,
        tools: subTools,
        systemPrompt: subSystemPrompt,
        maxToolRounds: deps.maxToolRounds || 15,
        cwd: deps.cwd,
        parallelToolCalls: true,
        askPermission: async () => true,
      });

      // 构建子 Agent 的消息
      const messageParts = [task];
      if (extraContext) {
        messageParts.push(`\n额外上下文:\n${extraContext}`);
      }
      if (files && files.length > 0) {
        messageParts.push(`\n相关文件: ${files.join(', ')}`);
      }
      const message = messageParts.join('\n');

      // 执行子 Agent（带超时控制）
      const timeoutController = new AbortController();
      const timeoutTimer = setTimeout(() => {
        timeoutController.abort();
      }, timeout);

      // 合并父级中止信号和超时信号
      const combinedAbort = new AbortController();
      const parentAbortHandler = () => combinedAbort.abort();
      const timeoutAbortHandler = () => combinedAbort.abort();
      context.abortSignal.addEventListener('abort', parentAbortHandler, { once: true });
      timeoutController.signal.addEventListener('abort', timeoutAbortHandler, { once: true });

      try {
        context.log('info', `[AgentTool] 子 Agent ${agentInfo.id} 开始执行 (深度 ${currentDepth + 1}): ${task.substring(0, 100)}...`);

        const resultParts: string[] = [];
        let toolCallCount = 0;
        let hasError = false;

        for await (const event of subEngine.processMessage(message, combinedAbort.signal)) {
          switch (event.type) {
            case 'text':
              resultParts.push(event.text);
              break;

            case 'tool_call':
              toolCallCount++;
              context.onProgress?.({
                message: `子 Agent ${agentInfo.id}: 调用 ${event.name} (${toolCallCount} 次)`,
              });
              break;

            case 'tool_result':
              if (event.isError) {
                context.log('warn', `[AgentTool] 子 Agent ${agentInfo.id} 工具错误: ${event.name} — ${event.result.substring(0, 200)}`);
              }
              break;

            case 'error':
              hasError = true;
              resultParts.push(`\n[错误] ${event.error.message}`);
              break;

            case 'done':
              break;
          }
        }

        clearTimeout(timeoutTimer);
        context.abortSignal.removeEventListener('abort', parentAbortHandler);
        timeoutController.signal.removeEventListener('abort', timeoutAbortHandler);

        const usage = subEngine.getTotalUsage();
        const elapsed = timer.elapsedMs();

        // 更新追踪器
        subAgentTracker.complete(agentInfo.id, usage, toolCallCount);

        // 构建结果
        let resultText = resultParts.join('');
        resultText = truncateOutput(resultText, MAX_RESULT_LENGTH);

        const totalTokens = usage.inputTokens + usage.outputTokens;
        const costStr = usage.totalCostUSD ? ` | $${usage.totalCostUSD.toFixed(4)}` : '';

        const summary = [
          resultText,
          '',
          `---`,
          `子 Agent ${agentInfo.id} 执行摘要: ${toolCallCount} 次工具调用 | ${totalTokens} tokens${costStr} | ${elapsed}`,
        ].join('\n');

        context.log('info', `[AgentTool] 子 Agent ${agentInfo.id} 完成: ${toolCallCount} 次工具调用, ${elapsed}`);

        return {
          content: summary,
          isError: hasError,
          metadata: {
            agentId: agentInfo.id,
            toolCallCount,
            usage,
            elapsed,
            nestingDepth: currentDepth + 1,
          },
        };
      } catch (error) {
        clearTimeout(timeoutTimer);
        context.abortSignal.removeEventListener('abort', parentAbortHandler);
        timeoutController.signal.removeEventListener('abort', timeoutAbortHandler);

        if (combinedAbort.signal.aborted) {
          subAgentTracker.cancel(agentInfo.id);
          const reason = context.abortSignal.aborted ? '用户取消' : '超时';
          return {
            content: `子 Agent ${agentInfo.id} 执行被中止（${reason}，${timer.elapsedMs()}）`,
            isError: true,
            metadata: { agentId: agentInfo.id, cancelled: true, reason },
          };
        }

        subAgentTracker.fail(agentInfo.id);
        return {
          content: `子 Agent ${agentInfo.id} 执行失败: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
          metadata: { agentId: agentInfo.id },
        };
      }
    },
  };
}

/** 获取子 Agent 追踪器（供外部使用） */
export function getSubAgentTracker(): SubAgentTracker {
  return subAgentTracker;
}
