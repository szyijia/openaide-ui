/**
 * 启动与初始化流程
 *
 * 参考 Claude Code: src/bootstrap/state.ts + src/entrypoints/init.ts
 *
 * 负责 openAIDE Core 的完整初始化流程：
 * 1. 环境检测（Shell、Git、Node 版本等）
 * 2. 配置加载（用户配置、项目配置、环境变量）
 * 3. LLM Provider 初始化
 * 4. 工具注册
 * 5. MCP 连接初始化
 * 6. Agent Engine 创建
 * 7. 优雅关闭注册
 */

import type { LLMProvider, ProviderConfig } from '../llm/types.js';
import type { AgentConfig } from '../agent/engine.js';
import { AgentEngine } from '../agent/engine.js';
import { ToolRegistry } from '../tools/registry.js';
import { createProvider, createProviderFromEnv } from '../llm/factory.js';
import { detectShell, getSystemInfo, getGitInfo, type ShellInfo, type SystemInfo } from '../shell/executor.js';

// ─── 初始化状态 ───

/** 初始化阶段 */
export type InitPhase =
  | 'not_started'
  | 'environment'
  | 'config'
  | 'provider'
  | 'tools'
  | 'mcp'
  | 'agent'
  | 'ready'
  | 'failed';

/** 初始化状态 */
export interface InitState {
  /** 当前阶段 */
  phase: InitPhase;
  /** 是否已就绪 */
  ready: boolean;
  /** 错误信息（如果失败） */
  error?: string;
  /** 各阶段耗时（毫秒） */
  phaseDurations: Record<string, number>;
  /** 总耗时（毫秒） */
  totalDurationMs?: number;
  /** 环境信息 */
  environment?: EnvironmentInfo;
}

/** 环境信息 */
export interface EnvironmentInfo {
  /** 系统信息 */
  system: SystemInfo;
  /** Shell 信息 */
  shell: ShellInfo;
  /** Git 信息 */
  git?: {
    isGitRepo: boolean;
    branch?: string;
    remoteUrl?: string;
    isDirty?: boolean;
  };
  /** Node.js 版本 */
  nodeVersion: string;
  /** 工作目录 */
  cwd: string;
}

// ─── 初始化配置 ───

/** 启动配置 */
export interface BootstrapConfig {
  /** 工作目录 */
  cwd?: string;
  /** LLM Provider 配置（如果不提供则从环境变量自动检测） */
  providerConfig?: ProviderConfig;
  /** 模型名称（覆盖默认模型） */
  model?: string;
  /** System Prompt */
  systemPrompt?: string;
  /** 最大工具调用轮数 */
  maxToolRounds?: number;
  /** 是否启用并行工具调用 */
  parallelToolCalls?: boolean;
  /** 是否启用 MCP */
  enableMCP?: boolean;
  /** MCP 配置文件路径 */
  mcpConfigPath?: string;
  /** 是否注册默认工具（默认 true） */
  registerDefaultTools?: boolean;
  /** 额外的工具列表 */
  extraTools?: Array<import('../tools/types.js').Tool>;
  /** 工具权限审批回调 */
  askPermission?: (toolName: string, description: string) => Promise<boolean>;
  /** 生命周期钩子 */
  hooks?: import('../agent/engine.js').AgentLifecycleHooks;
  /** 初始化进度回调 */
  onProgress?: (phase: InitPhase, message: string) => void;
  /** 工具调用失败重试次数 */
  toolRetries?: number;
  /** 上下文自动压缩阈值 */
  autoCompactThreshold?: number;
}

/** 启动结果 */
export interface BootstrapResult {
  /** Agent Engine 实例 */
  engine: AgentEngine;
  /** LLM Provider 实例 */
  provider: LLMProvider;
  /** 工具注册表 */
  tools: ToolRegistry;
  /** 初始化状态 */
  state: InitState;
  /** 清理函数（优雅关闭） */
  cleanup: () => Promise<void>;
}

// ─── 默认 System Prompt ───

const DEFAULT_SYSTEM_PROMPT = `你是一个强大的 AI 编程助手，运行在 openAIDE 环境中。

你可以：
- 读取和编辑文件
- 在 shell 中执行命令
- 搜索代码和文件
- 管理 Jupyter Notebook
- 创建和管理待办事项
- 委派子任务给子 Agent

请遵循以下原则：
1. 仔细理解用户的需求，在开始工作前确认理解正确
2. 使用工具来完成任务，而不是仅仅给出建议
3. 修改代码前先阅读相关文件，理解上下文
4. 每次修改后验证结果
5. 保持代码质量，遵循项目的编码规范
6. 如果不确定，先询问用户`;

// ─── 启动流程 ───

/**
 * 初始化 openAIDE Core
 *
 * 完整的启动流程，返回可用的 AgentEngine 实例。
 *
 * @example
 * ```ts
 * const { engine, cleanup } = await bootstrap({
 *   cwd: '/path/to/project',
 *   model: 'claude-sonnet-4-20250514',
 * });
 *
 * // 使用 engine 处理消息
 * for await (const event of engine.processMessage('Hello')) {
 *   console.log(event);
 * }
 *
 * // 清理
 * await cleanup();
 * ```
 */
export async function bootstrap(config: BootstrapConfig = {}): Promise<BootstrapResult> {
  const startTime = performance.now();
  const phaseDurations: Record<string, number> = {};
  const cwd = config.cwd || process.cwd();

  const state: InitState = {
    phase: 'not_started',
    ready: false,
    phaseDurations,
  };

  const progress = (phase: InitPhase, message: string) => {
    state.phase = phase;
    config.onProgress?.(phase, message);
  };

  // 清理函数列表
  const cleanupFns: Array<() => Promise<void>> = [];

  try {
    // ─── 阶段 1: 环境检测 ───
    progress('environment', '检测运行环境...');
    const envStart = performance.now();

    const [systemInfo, shellInfo, gitInfo] = await Promise.all([
      Promise.resolve(getSystemInfo()),
      detectShell(),
      getGitInfo(cwd).catch(() => null),
    ]);

    state.environment = {
      system: systemInfo,
      shell: shellInfo,
      git: gitInfo || undefined,
      nodeVersion: process.version,
      cwd,
    };

    phaseDurations.environment = performance.now() - envStart;

    // ─── 阶段 2: 配置加载 ───
    progress('config', '加载配置...');
    const configStart = performance.now();

    const systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;

    phaseDurations.config = performance.now() - configStart;

    // ─── 阶段 3: LLM Provider 初始化 ───
    progress('provider', '初始化 LLM Provider...');
    const providerStart = performance.now();

    let provider: LLMProvider;
    if (config.providerConfig) {
      provider = createProvider(config.providerConfig);
    } else {
      provider = createProviderFromEnv(config.model);
    }

    phaseDurations.provider = performance.now() - providerStart;

    // ─── 阶段 4: 工具注册 ───
    progress('tools', '注册工具...');
    const toolsStart = performance.now();

    const tools = new ToolRegistry();

    if (config.registerDefaultTools !== false) {
      await registerDefaultTools(tools);
    }

    // 注册额外工具
    if (config.extraTools) {
      for (const tool of config.extraTools) {
        tools.register(tool);
      }
    }

    phaseDurations.tools = performance.now() - toolsStart;

    // ─── 阶段 5: MCP 初始化 ───
    progress('mcp', '初始化 MCP...');
    const mcpStart = performance.now();

    // MCP 初始化（如果启用）
    // 注意：MCP 连接是异步的，这里只做基本初始化
    // 实际连接在首次使用时建立
    let mcpManager: AgentConfig['mcpManager'] | undefined;

    if (config.enableMCP) {
      try {
        const { MCPConnectionManager } = await import('../mcp/client.js');
        mcpManager = new MCPConnectionManager();

        // 注册 MCP 清理
        cleanupFns.push(async () => {
          if (mcpManager && 'disconnectAll' in mcpManager) {
            await (mcpManager as { disconnectAll: () => Promise<void> }).disconnectAll();
          }
        });
      } catch {
        // MCP 初始化失败不影响主流程
      }
    }

    phaseDurations.mcp = performance.now() - mcpStart;

    // ─── 阶段 6: Agent Engine 创建 ───
    progress('agent', '创建 Agent Engine...');
    const agentStart = performance.now();

    const agentConfig: AgentConfig = {
      provider,
      tools,
      systemPrompt,
      maxToolRounds: config.maxToolRounds || 25,
      cwd,
      mcpManager,
      parallelToolCalls: config.parallelToolCalls ?? true,
      askPermission: config.askPermission,
      hooks: config.hooks,
      toolRetries: config.toolRetries || 0,
      autoCompactThreshold: config.autoCompactThreshold,
    };

    const engine = new AgentEngine(agentConfig);

    phaseDurations.agent = performance.now() - agentStart;

    // ─── 完成 ───
    state.phase = 'ready';
    state.ready = true;
    state.totalDurationMs = performance.now() - startTime;

    progress('ready', `初始化完成 (${state.totalDurationMs.toFixed(0)}ms)`);

    // 构建清理函数
    const cleanup = async () => {
      // 停止 Agent
      if (engine.isRunning) {
        engine.requestStop();
      }

      // 执行所有清理函数
      for (const fn of cleanupFns) {
        try {
          await fn();
        } catch {
          // 清理错误不抛出
        }
      }
    };

    // 注册进程退出清理
    const exitHandler = () => {
      cleanup().catch(() => {});
    };
    process.once('SIGINT', exitHandler);
    process.once('SIGTERM', exitHandler);

    // 将退出处理器的清理也加入
    cleanupFns.push(async () => {
      process.removeListener('SIGINT', exitHandler);
      process.removeListener('SIGTERM', exitHandler);
    });

    return {
      engine,
      provider,
      tools,
      state,
      cleanup,
    };
  } catch (error) {
    state.phase = 'failed';
    state.error = error instanceof Error ? error.message : String(error);
    state.totalDurationMs = performance.now() - startTime;
    throw error;
  }
}

// ─── 默认工具注册 ───

/**
 * 注册所有默认工具
 */
async function registerDefaultTools(registry: ToolRegistry): Promise<void> {
  // 动态导入所有工具（避免循环依赖）
  const [
    { BashTool },
    { FileReadTool },
    { FileWriteTool },
    { FileEditTool },
    { GrepTool },
    { GlobTool },
    { WebFetchTool },
    { WebSearchTool },
    { NotebookEditTool },
    { createMCPTool },
    { createAskUserQuestionTool },
    { createTodoWriteTool, TodoManager },
  ] = await Promise.all([
    import('../tools/bash.js'),
    import('../tools/file-read.js'),
    import('../tools/file-write.js'),
    import('../tools/file-edit.js'),
    import('../tools/grep.js'),
    import('../tools/glob.js'),
    import('../tools/web-fetch.js'),
    import('../tools/web-search.js'),
    import('../tools/notebook-edit.js'),
    import('../tools/mcp-tool.js'),
    import('../tools/ask-user.js'),
    import('../tools/todo-write.js'),
  ]);

  // 直接导出的 Tool 实例
  registry.register(BashTool);
  registry.register(FileReadTool);
  registry.register(FileWriteTool);
  registry.register(FileEditTool);
  registry.register(GrepTool);
  registry.register(GlobTool);
  registry.register(WebFetchTool);
  registry.register(WebSearchTool);
  registry.register(NotebookEditTool);

  // 工厂函数创建的工具（使用默认参数）
  registry.register(createAskUserQuestionTool());
  registry.register(createTodoWriteTool(new TodoManager()));

  // MCPTool 和 AgentTool 需要外部依赖注入，由调用方根据需要注册
  // 例如: registry.register(createMCPTool(mcpManager));
  // 例如: registry.register(createAgentTool(getDeps));
}

// ─── 快速启动 ───

/**
 * 快速启动 — 最简配置
 *
 * 自动从环境变量检测 Provider，注册所有默认工具。
 *
 * @example
 * ```ts
 * const { engine, cleanup } = await quickStart();
 * ```
 */
export async function quickStart(cwd?: string): Promise<BootstrapResult> {
  return bootstrap({ cwd });
}

/**
 * 快速启动 — 指定模型
 *
 * @example
 * ```ts
 * const { engine } = await quickStartWithModel('claude-sonnet-4-20250514');
 * ```
 */
export async function quickStartWithModel(
  model: string,
  cwd?: string,
): Promise<BootstrapResult> {
  return bootstrap({ model, cwd });
}

/**
 * 快速启动 — 指定 Provider 配置
 *
 * @example
 * ```ts
 * const { engine } = await quickStartWithProvider({
 *   provider: 'anthropic',
 *   apiKey: 'sk-...',
 *   model: 'claude-sonnet-4-20250514',
 * });
 * ```
 */
export async function quickStartWithProvider(
  providerConfig: ProviderConfig,
  cwd?: string,
): Promise<BootstrapResult> {
  return bootstrap({ providerConfig, cwd });
}
