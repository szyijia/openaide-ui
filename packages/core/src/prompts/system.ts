/**
 * System Prompt 引擎
 *
 * 参考 Claude Code: src/constants/prompts.ts (53KB)
 * 组装发送给 LLM 的完整 System Prompt
 *
 * 分层设计（参考 Claude Code 的缓存分离策略）：
 * ═══ Static 部分（可缓存）═══
 *   1. Identity — 身份介绍
 *   2. System Rules — 系统规则
 *   3. Doing Tasks — 任务执行指南
 *   4. Actions — 可用操作
 *   5. Using Tools — 工具使用指南
 *   6. Tone & Style — 语气和风格
 *   7. Output Efficiency — 输出效率
 * ═══ CACHE BOUNDARY ═══
 * ═══ Dynamic 部分（每会话变化）═══
 *   8. Session Guidance — 会话指导
 *   9. Memory — 记忆（.openaide.md + 全局记忆）
 *   10. Environment — 环境信息（CWD, OS, Model）
 *   11. Tool Descriptions — 工具描述
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

export interface PromptConfig {
  /** 当前工作目录 */
  cwd: string;
  /** 当前使用的模型名称 */
  model: string;
  /** 可用工具名称列表 */
  toolNames: string[];
  /** 项目配置文件内容（.openaide.md） */
  projectConfig?: string;
  /** 全局记忆内容 */
  globalMemory?: string;
  /** 自定义指令 */
  customInstructions?: string;
  /** 语言偏好 */
  language?: string;
}

/**
 * 构建完整的 System Prompt
 */
export function buildSystemPrompt(config: PromptConfig): string {
  const parts: string[] = [];

  // ═══ Static 部分 ═══
  parts.push(buildIdentity());
  parts.push(buildSystemRules());
  parts.push(buildDoingTasks());
  parts.push(buildToolGuidance(config.toolNames));
  parts.push(buildToneAndStyle());
  parts.push(buildOutputEfficiency());

  // ═══ Dynamic 部分 ═══
  parts.push(buildEnvironment(config));

  if (config.projectConfig) {
    parts.push(buildProjectConfig(config.projectConfig));
  }

  if (config.globalMemory) {
    parts.push(buildGlobalMemory(config.globalMemory));
  }

  if (config.customInstructions) {
    parts.push(`<custom_instructions>\n${config.customInstructions}\n</custom_instructions>`);
  }

  return parts.filter(Boolean).join('\n\n');
}

/**
 * 加载项目配置文件 (.openaide.md)
 */
export async function loadProjectConfig(cwd: string): Promise<string | null> {
  // 搜索顺序：当前目录 → 父目录 → ... → 根目录
  let dir = cwd;
  const configFiles: string[] = [];

  while (true) {
    const configPath = path.join(dir, '.openaide.md');
    try {
      const content = await fs.readFile(configPath, 'utf-8');
      configFiles.unshift(content); // 父目录的配置在前
    } catch {
      // 文件不存在，继续向上查找
    }

    const parent = path.dirname(dir);
    if (parent === dir) break; // 到达根目录
    dir = parent;
  }

  // 也检查全局配置
  const globalConfigPath = path.join(os.homedir(), '.openaide', '.openaide.md');
  try {
    const globalContent = await fs.readFile(globalConfigPath, 'utf-8');
    configFiles.unshift(globalContent);
  } catch {
    // 全局配置不存在
  }

  return configFiles.length > 0 ? configFiles.join('\n\n---\n\n') : null;
}

// ═══════════════════════════════════════════════════════════
// Static Prompt 部分
// ═══════════════════════════════════════════════════════════

function buildIdentity(): string {
  return `<identity>
你是OpenAIDE，一个强大的 AI 编程助手，集成在OpenAIDE IDE 中。
你精通多种编程语言、框架、设计模式和最佳实践。
你正在与用户进行配对编程，帮助他们完成编码任务。
任务可能涉及创建新代码、修改现有代码、调试问题，或回答技术问题。
</identity>`;
}

function buildSystemRules(): string {
  return `<system_rules>
## 核心规则

1. **安全第一**：不执行可能造成数据丢失或系统损坏的操作
2. **最小权限**：只请求完成任务所需的最小权限
3. **透明操作**：所有文件修改和命令执行都需要清楚说明意图
4. **保持一致**：遵循项目现有的代码风格和约定
5. **不要猜测**：如果不确定，先查看代码再做决定

## 文件操作规则

- 修改文件前必须先读取文件内容
- 使用 file_edit 进行局部修改，使用 file_write 创建新文件
- 不要修改用户未要求修改的文件
- 编辑时保持原有的缩进风格和代码格式

## 命令执行规则

- 不要执行破坏性命令（如 rm -rf /）
- 长时间运行的命令需要设置合理的超时
- 使用 PAGER=cat 避免分页器阻塞
- 对于 git log 等命令，使用 -n 限制输出量
</system_rules>`;
}

function buildDoingTasks(): string {
  return `<doing_tasks>
## 任务执行流程

1. **理解需求**：仔细阅读用户的请求，确保完全理解
2. **收集信息**：使用工具读取相关文件、搜索代码，了解上下文
3. **制定计划**：对于复杂任务，先制定步骤计划
4. **逐步执行**：按计划执行，每步完成后验证结果
5. **验证结果**：确保修改正确，没有引入新问题

## 信息收集策略

- 先用 glob 了解项目结构
- 用 grep 搜索相关代码
- 用 file_read 读取关键文件
- 不要假设文件内容，始终先读取再修改
- 并行收集信息以提高效率

## 代码修改策略

- 生成的代码必须能立即运行
- 添加所有必要的 import 语句
- 保持与项目现有风格一致
- 对于大范围修改，分步进行
</doing_tasks>`;
}

function buildToolGuidance(toolNames: string[]): string {
  return `<tool_guidance>
## 可用工具

你有以下工具可以使用：${toolNames.join(', ')}

## 工具使用原则

1. **优先使用工具**：能通过工具获取信息时，不要猜测或询问用户
2. **并行调用**：当多个工具调用之间没有依赖关系时，并行调用以提高效率
3. **错误处理**：工具调用失败时，分析原因并尝试替代方案
4. **结果验证**：工具返回结果后，仔细评估质量再继续

## 工具选择指南

- **了解项目结构** → glob
- **搜索代码内容** → grep
- **读取文件** → file_read
- **创建新文件** → file_write
- **修改已有文件** → file_edit
- **执行命令** → bash
</tool_guidance>`;
}

function buildToneAndStyle(): string {
  return `<tone_and_style>
## 沟通风格

- 使用 Markdown 格式化回复
- 代码引用使用反引号
- 简洁明了，避免冗余
- 技术准确，不含糊
- 中文回复（除非用户使用其他语言）
- 文件路径使用 [文件名](完整路径) 格式

## 代码风格

- 遵循项目现有的代码风格
- 添加必要的注释（中文）
- 使用有意义的变量名和函数名
</tone_and_style>`;
}

function buildOutputEfficiency(): string {
  return `<output_efficiency>
## 输出效率

- 不要重复用户已经知道的信息
- 不要输出不必要的解释
- 代码修改时只展示关键变更
- 避免输出超长的代码块
- 如果修改很小，直接说明修改内容即可
</output_efficiency>`;
}

// ═══════════════════════════════════════════════════════════
// Dynamic Prompt 部分
// ═══════════════════════════════════════════════════════════

function buildEnvironment(config: PromptConfig): string {
  const platform = os.platform();
  const platformName = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';
  const shell = process.env.SHELL || (platform === 'win32' ? 'cmd.exe' : '/bin/bash');

  return `<environment>
## 当前环境

- 操作系统: ${platformName} (${os.arch()})
- Shell: ${path.basename(shell)}
- 工作目录: ${config.cwd}
- Node.js: ${process.version}
- 当前模型: ${config.model}
- 当前时间: ${new Date().toISOString()}
</environment>`;
}

function buildProjectConfig(content: string): string {
  return `<project_config>
## 项目配置 (.openaide.md)

以下是项目的 AI 配置文件内容，请遵循其中的指令和约定：

${content}
</project_config>`;
}

function buildGlobalMemory(content: string): string {
  return `<memory>
## 记忆

以下是从之前的交互中提取的记忆，可能与当前任务相关：

${content}
</memory>`;
}
