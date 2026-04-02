/**
 * 上下文管理器
 *
 * 参考 Claude Code:
 * - src/context.ts — Git 状态收集
 * - src/utils/claudemd.ts — 项目配置文件
 * - src/services/compact/ — 上下文压缩
 * - src/constants/prompts.ts — System Prompt 组装
 *
 * 负责：
 * 1. 加载项目配置文件 (.openaide.md)
 * 2. 收集 Git 状态信息
 * 3. 上下文压缩（当对话历史超过模型上下文窗口时）
 * 4. 组装完整的 System Prompt
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import type { ChatMessage, LLMProvider, TokenUsage } from '../llm/types.js';

// ─── 常量 ───

/** 自动压缩缓冲区（预留给输出的 token 数） */
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
/** 压缩摘要最大输出 token 数 */
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
/** 最大连续压缩失败次数（熔断器） */
const MAX_CONSECUTIVE_FAILURES = 3;

// ─── 类型 ───

export interface ContextConfig {
  /** 当前工作目录 */
  cwd: string;
  /** 项目配置文件名 */
  configFileName?: string;
  /** 全局配置目录 */
  globalConfigDir?: string;
  /** 是否启用自动压缩 */
  autoCompactEnabled?: boolean;
}

/** 编辑器状态（从 Extension 传入） */
export interface EditorState {
  activeFile?: string;
  openFiles: string[];
  selection?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
    text: string;
  };
  workspaceFolders: string[];
}

export interface GitStatus {
  /** 当前分支名 */
  branch: string;
  /** 是否有未提交的更改 */
  isDirty: boolean;
  /** 最近的 commit hash（短） */
  lastCommitHash: string;
  /** 最近的 commit 消息 */
  lastCommitMessage: string;
  /** 变更文件列表 */
  changedFiles: string[];
}

export interface CompactResult {
  /** 压缩后的消息列表 */
  messages: ChatMessage[];
  /** 压缩摘要 */
  summary: string;
  /** 压缩前的 token 数 */
  tokensBefore: number;
  /** 压缩后的 token 数 */
  tokensAfter: number;
}

// ─── 压缩 Prompt ───

/**
 * 参考 Claude Code: src/services/compact/prompt.ts
 * 9 步结构化压缩 prompt
 */
const COMPACT_PROMPT = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request.

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Important Code Snippet]

4. Errors and fixes:
    - [Error description]:
      - [How you fixed it]

5. Problem Solving:
   [Description]

6. All user messages:
    - [Detailed non tool use user message]

7. Pending Tasks:
   - [Task 1]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.

REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block.`;

// ─── ContextManager ───

export class ContextManager {
  private config: ContextConfig;
  private configFileName: string;
  private globalConfigDir: string;
  private consecutiveFailures = 0;
  private editorState: EditorState = { openFiles: [], workspaceFolders: [] };

  constructor(config: ContextConfig) {
    this.config = {
      autoCompactEnabled: true,
      ...config,
    };
    this.configFileName = config.configFileName || '.openaide.md';
    this.globalConfigDir = config.globalConfigDir || path.join(os.homedir(), '.openaide');
  }

  /**
   * 更新编辑器状态（由 BridgeServer 调用）
   */
  updateEditorState(state: EditorState): void {
    this.editorState = state;
  }

  /**
   * 获取当前编辑器状态
   */
  getEditorState(): Readonly<EditorState> {
    return this.editorState;
  }

  /**
   * 加载项目配置文件 (.openaide.md)
   *
   * 搜索顺序：全局配置 → 父目录 → ... → 当前目录
   * 所有找到的配置文件内容会合并（父目录在前）
   *
   * 参考 Claude Code: src/utils/claudemd.ts
   */
  async loadProjectConfig(): Promise<string | null> {
    const configFiles: string[] = [];

    // 1. 全局配置
    const globalConfigPath = path.join(this.globalConfigDir, this.configFileName);
    try {
      const content = await fs.readFile(globalConfigPath, 'utf-8');
      if (content.trim()) {
        configFiles.push(`# 全局配置 (${globalConfigPath})\n${content.trim()}`);
      }
    } catch {
      // 全局配置不存在
    }

    // 2. 从根目录到当前目录逐层查找
    let dir = this.config.cwd;
    const foundConfigs: Array<{ dir: string; content: string }> = [];

    while (true) {
      const configPath = path.join(dir, this.configFileName);
      try {
        const content = await fs.readFile(configPath, 'utf-8');
        if (content.trim()) {
          foundConfigs.unshift({ dir, content: content.trim() });
        }
      } catch {
        // 文件不存在
      }

      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    for (const { dir: configDir, content } of foundConfigs) {
      configFiles.push(`# 项目配置 (${configDir}/${this.configFileName})\n${content}`);
    }

    return configFiles.length > 0 ? configFiles.join('\n\n---\n\n') : null;
  }

  /**
   * 收集 Git 状态信息
   *
   * 参考 Claude Code: src/context.ts
   */
  async collectGitStatus(): Promise<GitStatus | null> {
    try {
      const cwd = this.config.cwd;

      // 检查是否在 git 仓库中
      try {
        execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: 'pipe' });
      } catch {
        return null;
      }

      // 获取当前分支
      let branch = 'unknown';
      try {
        branch = execSync('git branch --show-current', { cwd, stdio: 'pipe' })
          .toString()
          .trim();
        if (!branch) {
          // detached HEAD
          branch = execSync('git rev-parse --short HEAD', { cwd, stdio: 'pipe' })
            .toString()
            .trim();
        }
      } catch {
        // ignore
      }

      // 检查是否有未提交的更改
      let isDirty = false;
      try {
        const status = execSync('git status --porcelain', { cwd, stdio: 'pipe' })
          .toString()
          .trim();
        isDirty = status.length > 0;
      } catch {
        // ignore
      }

      // 获取最近的 commit
      let lastCommitHash = '';
      let lastCommitMessage = '';
      try {
        lastCommitHash = execSync('git log -1 --format=%h', { cwd, stdio: 'pipe' })
          .toString()
          .trim();
        lastCommitMessage = execSync('git log -1 --format=%s', { cwd, stdio: 'pipe' })
          .toString()
          .trim();
      } catch {
        // 可能是空仓库
      }

      // 获取变更文件列表
      let changedFiles: string[] = [];
      try {
        const diff = execSync('git diff --name-only HEAD', { cwd, stdio: 'pipe' })
          .toString()
          .trim();
        const staged = execSync('git diff --name-only --cached', { cwd, stdio: 'pipe' })
          .toString()
          .trim();
        const untracked = execSync('git ls-files --others --exclude-standard', { cwd, stdio: 'pipe' })
          .toString()
          .trim();

        const allFiles = new Set<string>();
        for (const f of [...diff.split('\n'), ...staged.split('\n'), ...untracked.split('\n')]) {
          if (f.trim()) allFiles.add(f.trim());
        }
        changedFiles = Array.from(allFiles).slice(0, 50); // 最多 50 个文件
      } catch {
        // ignore
      }

      return { branch, isDirty, lastCommitHash, lastCommitMessage, changedFiles };
    } catch {
      return null;
    }
  }

  /**
   * 估算消息列表的 token 数
   */
  estimateTokenCount(messages: ChatMessage[], provider: LLMProvider): number {
    let total = 0;
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        total += provider.estimateTokens(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if ('text' in block) {
            total += provider.estimateTokens(block.text);
          } else if ('content' in block && typeof block.content === 'string') {
            total += provider.estimateTokens(block.content);
          }
        }
      }
    }
    return total;
  }

  /**
   * 判断是否需要自动压缩
   *
   * 参考 Claude Code: src/services/compact/autoCompact.ts
   */
  shouldAutoCompact(messages: ChatMessage[], provider: LLMProvider): boolean {
    if (!this.config.autoCompactEnabled) return false;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return false;

    const tokenCount = this.estimateTokenCount(messages, provider);
    const effectiveWindow = provider.maxContextWindow - MAX_OUTPUT_TOKENS_FOR_SUMMARY;
    const threshold = effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS;

    return tokenCount >= threshold;
  }

  /**
   * 执行上下文压缩
   *
   * 参考 Claude Code: src/services/compact/compact.ts
   * 使用 LLM 对对话历史进行结构化摘要
   */
  async compactHistory(
    messages: ChatMessage[],
    provider: LLMProvider,
    abortSignal?: AbortSignal,
  ): Promise<CompactResult> {
    const tokensBefore = this.estimateTokenCount(messages, provider);

    try {
      // 使用 LLM 生成摘要
      const response = await provider.chat({
        messages: [
          ...messages,
          {
            role: 'user',
            content: COMPACT_PROMPT,
          },
        ],
        systemPrompt: '你是一个对话摘要助手。请严格按照指示生成结构化摘要。',
        maxTokens: MAX_OUTPUT_TOKENS_FOR_SUMMARY,
        temperature: 0,
      });

      // 提取摘要内容
      let summary = '';
      for (const block of response.content) {
        if ('text' in block) {
          summary += block.text;
        }
      }

      // 格式化摘要（去除 <analysis> 部分，保留 <summary> 部分）
      summary = this.formatCompactSummary(summary);

      // 构建压缩后的消息
      const compactedMessages: ChatMessage[] = [
        {
          role: 'user',
          content: `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n${summary}`,
        },
        {
          role: 'assistant',
          content: 'I understand. I have the context from the previous conversation. How can I continue helping you?',
        },
      ];

      const tokensAfter = this.estimateTokenCount(compactedMessages, provider);

      // 重置失败计数
      this.consecutiveFailures = 0;

      return {
        messages: compactedMessages,
        summary,
        tokensBefore,
        tokensAfter,
      };
    } catch (error) {
      this.consecutiveFailures++;
      throw error;
    }
  }

  /**
   * 格式化压缩摘要
   *
   * 参考 Claude Code: src/services/compact/prompt.ts - formatCompactSummary
   * 去除 <analysis> 草稿部分，提取 <summary> 内容
   */
  private formatCompactSummary(rawSummary: string): string {
    let formatted = rawSummary;

    // 去除 analysis 部分（这是草稿，不需要保留）
    formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/i, '');

    // 提取 summary 部分
    const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/i);
    if (summaryMatch) {
      formatted = summaryMatch[1]!.trim();
    }

    // 清理多余空行
    formatted = formatted.replace(/\n{3,}/g, '\n\n').trim();

    return formatted;
  }

  /**
   * 构建上下文 Prompt
   * 整合项目配置 + Git 状态，供 Agent Engine 嵌入 System Prompt
   */
  async buildContextPrompt(): Promise<string | null> {
    const parts: string[] = [];

    // 1. 项目配置
    const projectConfig = await this.loadProjectConfig();
    if (projectConfig) {
      parts.push(projectConfig);
    }

    // 2. Git 状态
    const gitStatus = await this.collectGitStatus();
    if (gitStatus) {
      const gitLines: string[] = [];
      gitLines.push(`当前分支: ${gitStatus.branch}`);
      if (gitStatus.lastCommitHash) {
        gitLines.push(`最近提交: ${gitStatus.lastCommitHash} — ${gitStatus.lastCommitMessage}`);
      }
      if (gitStatus.isDirty) {
        gitLines.push(`工作区状态: 有未提交的更改`);
        if (gitStatus.changedFiles.length > 0) {
          gitLines.push(`变更文件 (${gitStatus.changedFiles.length}):`);
          for (const f of gitStatus.changedFiles.slice(0, 20)) {
            gitLines.push(`  - ${f}`);
          }
          if (gitStatus.changedFiles.length > 20) {
            gitLines.push(`  ... 还有 ${gitStatus.changedFiles.length - 20} 个文件`);
          }
        }
      } else {
        gitLines.push(`工作区状态: 干净`);
      }
      parts.push(`# Git 状态\n${gitLines.join('\n')}`);
    }

    // 3. 编辑器状态
    if (this.editorState.activeFile || this.editorState.openFiles.length > 0) {
      const editorLines: string[] = [];
      if (this.editorState.activeFile) {
        editorLines.push(`当前活动文件: ${this.editorState.activeFile}`);
      }
      if (this.editorState.selection?.text) {
        editorLines.push(`当前选中内容 (行 ${this.editorState.selection.start.line + 1}-${this.editorState.selection.end.line + 1}):`);
        // 限制选中内容长度
        const selText = this.editorState.selection.text;
        if (selText.length > 500) {
          editorLines.push(`\`\`\`\n${selText.substring(0, 500)}...\n\`\`\``);
        } else {
          editorLines.push(`\`\`\`\n${selText}\n\`\`\``);
        }
      }
      if (this.editorState.openFiles.length > 0) {
        editorLines.push(`打开的文件 (${this.editorState.openFiles.length}):`);
        for (const f of this.editorState.openFiles.slice(0, 10)) {
          editorLines.push(`  - ${f}`);
        }
        if (this.editorState.openFiles.length > 10) {
          editorLines.push(`  ... 还有 ${this.editorState.openFiles.length - 10} 个文件`);
        }
      }
      parts.push(`# 编辑器状态\n${editorLines.join('\n')}`);
    }

    return parts.length > 0 ? parts.join('\n\n---\n\n') : null;
  }

  /**
   * 获取上下文使用百分比
   */
  getContextUsagePercent(messages: ChatMessage[], provider: LLMProvider): number {
    const tokenCount = this.estimateTokenCount(messages, provider);
    const effectiveWindow = provider.maxContextWindow - MAX_OUTPUT_TOKENS_FOR_SUMMARY;
    return Math.round((tokenCount / effectiveWindow) * 100);
  }

  /**
   * 获取上下文状态信息
   */
  getContextStatus(messages: ChatMessage[], provider: LLMProvider): {
    tokenCount: number;
    maxTokens: number;
    usagePercent: number;
    needsCompact: boolean;
  } {
    const tokenCount = this.estimateTokenCount(messages, provider);
    const maxTokens = provider.maxContextWindow - MAX_OUTPUT_TOKENS_FOR_SUMMARY;
    const usagePercent = Math.round((tokenCount / maxTokens) * 100);
    const needsCompact = this.shouldAutoCompact(messages, provider);

    return { tokenCount, maxTokens, usagePercent, needsCompact };
  }
}
