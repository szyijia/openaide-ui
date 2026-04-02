/**
 * Multi-Agent 协调器
 *
 * 参考 Claude Code: src/coordinator/coordinatorMode.ts
 *
 * 支持两种协作模式：
 *
 * 1. Coordinator 模式 — 一个主 Agent 协调多个子 Agent
 *    - 主 Agent 分析任务，拆分为子任务
 *    - 每个子 Agent 独立执行子任务
 *    - 主 Agent 汇总结果
 *
 * 2. Team 模式 — 多个平级 Agent 协作
 *    - 每个 Agent 有不同的角色/专长
 *    - Agent 之间可以互相发送消息
 *    - 协调器管理消息路由和同步
 */

import { AgentEngine } from './engine.js';
import type { AgentConfig, AgentEvent } from './engine.js';
import type { LLMProvider, TokenUsage } from '../llm/types.js';
import type { ToolRegistry } from '../tools/registry.js';

// ─── 类型定义 ───

/** 协作模式 */
export type CoordinationMode = 'coordinator' | 'team';

/** Agent 角色定义 */
export interface AgentRole {
  /** 角色 ID */
  id: string;
  /** 角色名称 */
  name: string;
  /** 角色描述 */
  description: string;
  /** 角色专长领域 */
  expertise: string[];
  /** 角色专属 System Prompt 补充 */
  systemPromptSuffix?: string;
  /** 使用的模型（可选，默认使用协调器的模型） */
  provider?: LLMProvider;
  /** 最大工具调用轮数 */
  maxToolRounds?: number;
}

/** 子任务定义 */
export interface SubTask {
  /** 任务 ID */
  id: string;
  /** 分配给的 Agent 角色 ID */
  agentId: string;
  /** 任务描述 */
  description: string;
  /** 依赖的其他任务 ID */
  dependencies: string[];
  /** 任务状态 */
  status: 'pending' | 'running' | 'completed' | 'failed';
  /** 任务结果 */
  result?: string;
  /** Token 用量 */
  usage?: TokenUsage;
}

/** 协调器配置 */
export interface CoordinatorConfig {
  /** 协作模式 */
  mode: CoordinationMode;
  /** 默认 LLM Provider */
  provider: LLMProvider;
  /** 工具注册表 */
  tools: ToolRegistry;
  /** 基础 System Prompt */
  systemPrompt: string;
  /** 工作目录 */
  cwd: string;
  /** Agent 角色列表 */
  roles: AgentRole[];
  /** 最大并行 Agent 数 */
  maxParallelAgents?: number;
  /** 单个 Agent 超时（毫秒） */
  agentTimeoutMs?: number;
}

/** 协调器事件 */
export type CoordinatorEvent =
  | { type: 'plan'; tasks: SubTask[] }
  | { type: 'agent_start'; agentId: string; taskId: string; description: string }
  | { type: 'agent_event'; agentId: string; taskId: string; event: AgentEvent }
  | { type: 'agent_done'; agentId: string; taskId: string; result: string; usage: TokenUsage }
  | { type: 'agent_error'; agentId: string; taskId: string; error: Error }
  | { type: 'synthesis'; text: string }
  | { type: 'done'; totalUsage: TokenUsage; taskResults: Map<string, string> }
  | { type: 'error'; error: Error };

// ─── 预定义角色模板 ───

export const PRESET_ROLES: Record<string, Omit<AgentRole, 'id'>> = {
  architect: {
    name: '架构师',
    description: '负责系统设计、架构决策和技术方案评审',
    expertise: ['system-design', 'architecture', 'design-patterns'],
    systemPromptSuffix: `你是一个资深软件架构师。你的职责是：
- 分析系统需求，设计合理的架构方案
- 评审代码结构和模块划分
- 提出技术选型建议
- 关注可扩展性、可维护性和性能`,
  },
  coder: {
    name: '开发者',
    description: '负责代码实现、重构和优化',
    expertise: ['coding', 'refactoring', 'implementation'],
    systemPromptSuffix: `你是一个高效的软件开发者。你的职责是：
- 编写高质量、可维护的代码
- 遵循项目的编码规范和最佳实践
- 实现具体的功能需求
- 进行代码重构和优化`,
  },
  reviewer: {
    name: '代码审查员',
    description: '负责代码审查、Bug 检测和质量保证',
    expertise: ['code-review', 'testing', 'quality-assurance'],
    systemPromptSuffix: `你是一个严格的代码审查员。你的职责是：
- 审查代码质量和潜在问题
- 检测 Bug、安全漏洞和性能问题
- 验证代码是否符合需求
- 提出改进建议`,
  },
  researcher: {
    name: '研究员',
    description: '负责信息收集、技术调研和文档分析',
    expertise: ['research', 'analysis', 'documentation'],
    systemPromptSuffix: `你是一个技术研究员。你的职责是：
- 搜索和分析代码库中的相关信息
- 调研技术方案和最佳实践
- 阅读和理解文档
- 提供详细的分析报告`,
  },
};

// ─── 任务规划 Prompt ───

const PLANNING_PROMPT = `你是一个任务规划专家。请分析用户的需求，将其拆分为可以并行或串行执行的子任务。

## 可用的 Agent 角色

{ROLES}

## 输出格式

请以 JSON 格式输出任务计划：

\`\`\`json
{
  "analysis": "对需求的简要分析",
  "tasks": [
    {
      "id": "task_1",
      "agentId": "角色ID",
      "description": "具体的任务描述，包含完成任务所需的所有上下文",
      "dependencies": []
    },
    {
      "id": "task_2",
      "agentId": "角色ID",
      "description": "任务描述",
      "dependencies": ["task_1"]
    }
  ]
}
\`\`\`

## 规划原则

1. 尽量让无依赖的任务并行执行
2. 每个任务描述要具体、自包含
3. 合理分配给最适合的角色
4. 任务粒度适中，不要过细也不要过粗`;

// ─── 结果综合 Prompt ───

const SYNTHESIS_PROMPT = `你是一个结果综合专家。多个 Agent 已经完成了各自的子任务，请综合所有结果，给出最终的完整回答。

## 原始需求

{ORIGINAL_TASK}

## 各 Agent 的执行结果

{RESULTS}

## 要求

1. 综合所有 Agent 的结果，给出完整、连贯的回答
2. 如果有冲突的结论，进行分析和取舍
3. 确保回答直接解决用户的原始需求
4. 如果某些任务失败了，说明影响并给出替代方案`;

// ─── MultiAgentCoordinator ───

export class MultiAgentCoordinator {
  private config: CoordinatorConfig;
  private agents: Map<string, AgentEngine> = new Map();
  private totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(config: CoordinatorConfig) {
    this.config = {
      maxParallelAgents: 3,
      agentTimeoutMs: 180000, // 3 分钟
      ...config,
    };
  }

  /**
   * 执行多 Agent 协作任务
   */
  async *execute(
    task: string,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<CoordinatorEvent, void, unknown> {
    try {
      if (this.config.mode === 'coordinator') {
        yield* this.executeCoordinatorMode(task, abortSignal);
      } else {
        yield* this.executeTeamMode(task, abortSignal);
      }
    } catch (error) {
      yield { type: 'error', error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  /**
   * Coordinator 模式执行
   *
   * 流程：规划 → 分配 → 执行 → 综合
   */
  private async *executeCoordinatorMode(
    task: string,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<CoordinatorEvent, void, unknown> {
    // 1. 规划阶段 — 使用 LLM 拆分任务
    const tasks = await this.planTasks(task, abortSignal);
    yield { type: 'plan', tasks };

    // 2. 执行阶段 — 按依赖关系调度
    const taskResults = new Map<string, string>();
    yield* this.executeTasks(tasks, taskResults, abortSignal);

    // 3. 综合阶段 — 汇总结果
    yield* this.synthesizeResults(task, taskResults, abortSignal);

    yield {
      type: 'done',
      totalUsage: { ...this.totalUsage },
      taskResults,
    };
  }

  /**
   * Team 模式执行
   *
   * 所有 Agent 同时接收任务，各自从自己的角色视角处理
   */
  private async *executeTeamMode(
    task: string,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<CoordinatorEvent, void, unknown> {
    const tasks: SubTask[] = this.config.roles.map((role, index) => ({
      id: `team_${index}`,
      agentId: role.id,
      description: `从${role.name}的角度分析和处理以下任务：\n\n${task}`,
      dependencies: [],
      status: 'pending' as const,
    }));

    yield { type: 'plan', tasks };

    const taskResults = new Map<string, string>();
    yield* this.executeTasks(tasks, taskResults, abortSignal);

    // 综合所有角色的结果
    yield* this.synthesizeResults(task, taskResults, abortSignal);

    yield {
      type: 'done',
      totalUsage: { ...this.totalUsage },
      taskResults,
    };
  }

  /**
   * 使用 LLM 规划任务
   */
  private async planTasks(task: string, abortSignal?: AbortSignal): Promise<SubTask[]> {
    const rolesDescription = this.config.roles
      .map((r) => `- **${r.id}** (${r.name}): ${r.description} | 专长: ${r.expertise.join(', ')}`)
      .join('\n');

    const planningPrompt = PLANNING_PROMPT.replace('{ROLES}', rolesDescription);

    const response = await this.config.provider.chat({
      messages: [
        { role: 'user', content: `请为以下任务制定执行计划：\n\n${task}` },
      ],
      systemPrompt: planningPrompt,
      temperature: 0.3,
      maxTokens: 2000,
    });

    this.accumulateUsage(response.usage);

    // 解析 JSON 响应
    const responseText = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const jsonMatch = responseText.match(/```json\s*([\s\S]*?)```/);
    if (!jsonMatch) {
      // 降级：创建单个任务
      return [{
        id: 'task_1',
        agentId: this.config.roles[0]?.id || 'default',
        description: task,
        dependencies: [],
        status: 'pending',
      }];
    }

    try {
      const plan = JSON.parse(jsonMatch[1]!) as { tasks: Array<{ id: string; agentId: string; description: string; dependencies: string[] }> };
      return plan.tasks.map((t) => ({
        ...t,
        status: 'pending' as const,
      }));
    } catch {
      return [{
        id: 'task_1',
        agentId: this.config.roles[0]?.id || 'default',
        description: task,
        dependencies: [],
        status: 'pending',
      }];
    }
  }

  /**
   * 按依赖关系执行任务
   */
  private async *executeTasks(
    tasks: SubTask[],
    taskResults: Map<string, string>,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<CoordinatorEvent, void, unknown> {
    const completed = new Set<string>();
    const running = new Map<string, Promise<void>>();
    const maxParallel = this.config.maxParallelAgents!;

    // 事件队列（用于从并行任务中收集事件）
    const eventQueue: CoordinatorEvent[] = [];

    while (completed.size < tasks.length) {
      if (abortSignal?.aborted) {
        yield { type: 'error', error: new Error('协调器被用户中止') };
        return;
      }

      // 找出可以执行的任务（依赖已完成 + 未在运行中）
      const ready = tasks.filter(
        (t) =>
          t.status === 'pending' &&
          t.dependencies.every((dep) => completed.has(dep)) &&
          !running.has(t.id),
      );

      // 启动新任务（不超过并行上限）
      for (const task of ready) {
        if (running.size >= maxParallel) break;

        task.status = 'running';
        yield { type: 'agent_start', agentId: task.agentId, taskId: task.id, description: task.description };

        const promise = this.executeSubTask(task, taskResults, abortSignal)
          .then((events) => {
            eventQueue.push(...events);
            completed.add(task.id);
            running.delete(task.id);
          })
          .catch((error) => {
            task.status = 'failed';
            eventQueue.push({
              type: 'agent_error',
              agentId: task.agentId,
              taskId: task.id,
              error: error instanceof Error ? error : new Error(String(error)),
            });
            completed.add(task.id);
            running.delete(task.id);
          });

        running.set(task.id, promise);
      }

      // 等待至少一个任务完成
      if (running.size > 0) {
        await Promise.race(running.values());
      }

      // 输出收集到的事件
      while (eventQueue.length > 0) {
        yield eventQueue.shift()!;
      }

      // 如果没有可运行的任务也没有正在运行的任务，检查是否有死锁
      if (ready.length === 0 && running.size === 0 && completed.size < tasks.length) {
        yield {
          type: 'error',
          error: new Error('任务调度死锁：存在无法满足的依赖关系'),
        };
        return;
      }
    }
  }

  /**
   * 执行单个子任务
   */
  private async executeSubTask(
    task: SubTask,
    taskResults: Map<string, string>,
    abortSignal?: AbortSignal,
  ): Promise<CoordinatorEvent[]> {
    const events: CoordinatorEvent[] = [];
    const role = this.config.roles.find((r) => r.id === task.agentId);

    // 构建子 Agent 的 System Prompt
    let subPrompt = this.config.systemPrompt;
    if (role?.systemPromptSuffix) {
      subPrompt += `\n\n## 你的角色\n\n${role.systemPromptSuffix}`;
    }

    // 创建子 Agent
    const agent = new AgentEngine({
      provider: role?.provider || this.config.provider,
      tools: this.config.tools,
      systemPrompt: subPrompt,
      maxToolRounds: role?.maxToolRounds || 15,
      cwd: this.config.cwd,
      parallelToolCalls: true,
      askPermission: async () => true, // 子 Agent 自动批准
    });

    // 构建任务消息（包含已完成任务的结果作为上下文）
    let message = task.description;
    if (task.dependencies.length > 0) {
      const depResults = task.dependencies
        .map((depId) => {
          const result = taskResults.get(depId);
          return result ? `[${depId} 的结果]: ${result}` : null;
        })
        .filter(Boolean)
        .join('\n\n');

      if (depResults) {
        message += `\n\n## 前置任务的结果\n\n${depResults}`;
      }
    }

    // 执行子 Agent（带超时）
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), this.config.agentTimeoutMs);

    const combinedAbort = new AbortController();
    if (abortSignal) {
      abortSignal.addEventListener('abort', () => combinedAbort.abort());
    }
    timeoutController.signal.addEventListener('abort', () => combinedAbort.abort());

    try {
      const resultParts: string[] = [];

      for await (const event of agent.processMessage(message, combinedAbort.signal)) {
        events.push({ type: 'agent_event', agentId: task.agentId, taskId: task.id, event });

        if (event.type === 'text') {
          resultParts.push(event.text);
        }
      }

      const result = resultParts.join('');
      const usage = agent.getTotalUsage();

      task.status = 'completed';
      task.result = result;
      task.usage = usage;
      taskResults.set(task.id, result);
      this.accumulateUsage(usage);

      events.push({
        type: 'agent_done',
        agentId: task.agentId,
        taskId: task.id,
        result,
        usage,
      });
    } finally {
      clearTimeout(timer);
    }

    return events;
  }

  /**
   * 综合所有 Agent 的结果
   */
  private async *synthesizeResults(
    originalTask: string,
    taskResults: Map<string, string>,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<CoordinatorEvent, void, unknown> {
    if (taskResults.size <= 1) {
      // 只有一个结果，不需要综合
      const [result] = taskResults.values();
      if (result) {
        yield { type: 'synthesis', text: result };
      }
      return;
    }

    const resultsText = Array.from(taskResults.entries())
      .map(([id, result]) => `### ${id}\n\n${result}`)
      .join('\n\n---\n\n');

    const synthesisPrompt = SYNTHESIS_PROMPT
      .replace('{ORIGINAL_TASK}', originalTask)
      .replace('{RESULTS}', resultsText);

    try {
      const stream = this.config.provider.chatStream({
        messages: [
          { role: 'user', content: '请综合以上所有 Agent 的结果，给出最终回答。' },
        ],
        systemPrompt: synthesisPrompt,
        temperature: 0.3,
      });

      for await (const event of stream) {
        if (abortSignal?.aborted) break;

        if (event.type === 'text_delta') {
          yield { type: 'synthesis', text: event.text };
        }
        if (event.type === 'message_end') {
          this.accumulateUsage(event.usage);
        }
      }
    } catch (error) {
      yield {
        type: 'error',
        error: new Error(`结果综合失败: ${error instanceof Error ? error.message : String(error)}`),
      };
    }
  }

  /**
   * 获取总 Token 用量
   */
  getTotalUsage(): TokenUsage {
    return { ...this.totalUsage };
  }

  private accumulateUsage(usage: TokenUsage): void {
    this.totalUsage.inputTokens += usage.inputTokens;
    this.totalUsage.outputTokens += usage.outputTokens;
    if (usage.totalCostUSD) {
      this.totalUsage.totalCostUSD = (this.totalUsage.totalCostUSD || 0) + usage.totalCostUSD;
    }
  }
}
