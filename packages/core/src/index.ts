/**
 * OpenAIDE — AI Agent Core Engine
 *
 * 核心引擎入口，导出所有公共 API
 */

// ─── LLM Provider ───
export type {
  LLMProvider,
  ProviderConfig,
  ChatParams,
  ChatMessage,
  ChatResponse,
  StreamEvent,
  TokenUsage,
  ContentBlock,
  ToolDefinition,
  MessageRole,
  ModelCapabilities,
  APIErrorType,
  ReasoningEffort,
} from './llm/types.js';
export { APIError } from './llm/types.js';
export { createProvider, createProviderFromEnv } from './llm/factory.js';
export { ModelRouter, classifyTask as classifyTaskForRouter } from './llm/router.js';
export type { RouterConfig, RouterStats, RoutingDecision, ModelRegistration, TaskType, ModelTier } from './llm/router.js';
export { OpenAICompatibleProvider } from './llm/providers/openai-compatible.js';
export { AnthropicProvider } from './llm/providers/anthropic.js';

// ─── LLM Token Estimation ───
export {
  estimateTokensFast,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateSystemPromptTokens,
  estimateToolDefinitionsTokens,
  estimateRequestTokens,
  calculateTokenBudget,
  calculateCost as calculateTokenCost,
  formatTokenUsage,
} from './llm/tokens.js';
export type { TokenBudget } from './llm/tokens.js';

// ─── LLM Model Registry ───
export {
  resolveModelName,
  getModelInfo,
  getModelCapabilities,
  calculateModelCost,
  modelSupports,
  getRegisteredModels as getRegisteredModelInfos,
  getModelsByProvider,
  registerModel,
  selectModel,
} from './llm/models.js';
export type { ModelInfo, ModelPricing } from './llm/models.js';

// ─── Agent Engine ───
export { AgentEngine, TaskManager } from './agent/engine.js';
export type {
  AgentConfig,
  AgentEvent,
  AgentLifecycleHooks,
  ToolCallInfo,
  ToolResultInfo,
  TaskStatus,
  TaskInfo,
} from './agent/engine.js';
export { MultiAgentCoordinator, PRESET_ROLES } from './agent/coordinator.js';
export type { CoordinatorConfig, CoordinatorEvent, CoordinationMode, AgentRole, SubTask } from './agent/coordinator.js';

// ─── Tool System ───
export type { Tool, ToolResult, ToolContext, ToolPermission, ToolProgress, PermissionLevel } from './tools/types.js';
export { ToolRegistry } from './tools/registry.js';

// ─── Built-in Tools ───
export { FileReadTool } from './tools/file-read.js';
export { FileWriteTool } from './tools/file-write.js';
export { FileEditTool } from './tools/file-edit.js';
export { GlobTool } from './tools/glob.js';
export { GrepTool } from './tools/grep.js';
export { BashTool, BackgroundTaskManager, getBackgroundTaskManager } from './tools/bash.js';
export type { BackgroundTask, BackgroundTaskStatus } from './tools/bash.js';
export { WebFetchTool } from './tools/web-fetch.js';
export { WebSearchTool } from './tools/web-search.js';
export { createAgentTool } from './tools/agent.js';
export type { AgentToolDeps, SubAgentStatus, SubAgentInfo } from './tools/agent.js';
export { getSubAgentTracker } from './tools/agent.js';

// ─── New P0 Tools ───
export { NotebookEditTool } from './tools/notebook-edit.js';
export type { CellType, NotebookCell, NotebookDocument, NotebookEditAction } from './tools/notebook-edit.js';
export { createAskUserQuestionTool } from './tools/ask-user.js';
export type { AskUserCallback, AskUserOptions } from './tools/ask-user.js';
export { createTodoWriteTool, TodoManager } from './tools/todo-write.js';
export type { TodoItem, TodoStatus, TodoChangeCallback } from './tools/todo-write.js';
export { createMCPTool } from './tools/mcp-tool.js';

// ─── Tool Shared Utils ───
export {
  isPathSafe,
  resolveAndValidatePath,
  isWithinWorkspace,
  truncateOutput,
  truncateLines,
  fileExists,
  getFileInfo,
  isBinaryFile,
  atomicWriteFile,
  createBackup,
  formatSuccess,
  formatError,
  formatFileResult,
  addLineNumbers,
  extractLineRange,
  generateSimpleDiff,
  getPlatformInfo,
  isCommandAvailable,
  createTimer,
} from './tools/shared.js';

// ─── Prompt Engine ───
export { buildSystemPrompt, loadProjectConfig } from './prompts/system.js';
export type { PromptConfig } from './prompts/system.js';

// ─── Context ───
export { ContextManager } from './context/manager.js';
export { CompactService } from './context/compact.js';
export type { CompactConfig, CompactResult, CompactStats } from './context/compact.js';

// ─── Memory ───
export { MemoryManager } from './memory/manager.js';
export type { Memory, MemoryType, MemorySource } from './memory/manager.js';

// ─── Session ───
export { SessionManager } from './session/manager.js';
export type { SessionData, SessionMeta, SessionListItem } from './session/manager.js';

// ─── Auth ───
export { AuthService } from './auth/service.js';
export type { UserProfile, ApiKeyEntry, UsageRecord, UsageQuota, AuthState, OAuthConfig } from './auth/service.js';

// ─── Permissions ───
export { PermissionManager } from './permissions/manager.js';
export type { PermissionRule, PermissionCheckResult, PermissionDecision, PermissionScope, ToolCallContext } from './permissions/manager.js';

// ─── MCP ───
export { MCPClient } from './mcp/client.js';
export { MCPMarketplace } from './mcp/marketplace.js';
export type { MCPServerEntry, MCPCategory, MCPInstallMethod, MCPInstallConfig, MCPEnvVar, InstalledMCPServer } from './mcp/marketplace.js';

// ─── Bridge Server ───
export { BridgeServer, ToolApprovalQueue, ConfigStore } from './bridge-server.js';

// ─── Auto Update ───
export { AutoUpdateService, createAutoUpdater } from './updater/auto-update.js';
export type { UpdateInfo, DownloadProgress, UpdateConfig } from './updater/auto-update.js';

// ─── Shell Executor ───
export {
  detectShell,
  buildSafeEnv as buildShellEnv,
  checkCommandSafety,
  stripAnsi,
  truncateOutput as truncateShellOutput,
  execCommand,
  execSimple,
  execOrThrow,
  gracefulKill,
  killProcessTree,
  getSystemInfo,
  getGitInfo,
} from './shell/executor.js';
export type {
  ShellType,
  ShellInfo,
  EnvOptions,
  DangerousPattern,
  CommandSafetyCheck,
  ExecOptions,
  ExecResult,
  SystemInfo,
} from './shell/executor.js';

// ─── Bootstrap ───
export {
  bootstrap,
  quickStart,
  quickStartWithModel,
  quickStartWithProvider,
} from './bootstrap/init.js';
export type {
  BootstrapConfig,
  BootstrapResult,
  InitState,
  InitPhase,
  EnvironmentInfo,
} from './bootstrap/init.js';

// ─── Cloud Sync ───
export { CloudSyncService } from './sync/cloud-sync.js';
export type {
  SyncDataType,
  SyncDirection,
  ConflictStrategy,
  SyncStatus,
  SyncItemMeta,
  SyncConflict,
  SyncOperation,
  SyncLogEntry,
  SyncState,
  CloudSyncConfig,
  SyncProgressEvent,
  SyncResult,
} from './sync/cloud-sync.js';
