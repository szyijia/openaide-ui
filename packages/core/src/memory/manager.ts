/**
 * 记忆管理器
 *
 * 参考 Claude Code:
 * - src/memdir/memdir.ts — 持久化记忆目录 (MEMORY.md 入口 + 主题文件)
 * - src/memdir/memoryScan.ts — 记忆文件扫描和 frontmatter 解析
 * - src/memdir/findRelevantMemories.ts — 基于 LLM 的记忆相关性选择
 * - src/memdir/memoryTypes.ts — 记忆类型分类 (user/feedback/project/reference)
 * - src/services/extractMemories/ — 自动记忆提取
 * - src/services/SessionMemory/ — 会话记忆
 *
 * OpenAIDE的记忆系统：
 * 1. 项目记忆 — .openaide.md（当前项目的指令和偏好）
 * 2. 全局记忆 — ~/.openaide/memory/（跨项目的长期记忆）
 * 3. 项目级记忆 — ~/.openaide/projects/<sanitized-cwd>/memory/（项目级自动记忆）
 * 4. 会话记忆 — 当前对话中提取的临时记忆
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

// ─── 记忆类型 ───

/** 记忆类型（参考 Claude Code memoryTypes.ts） */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

/** 记忆来源 */
export type MemorySource = 'global' | 'project' | 'session';

/** 记忆条目 */
export interface Memory {
  /** 唯一标识（文件名或生成的 ID） */
  id: string;
  /** 记忆标题 */
  title: string;
  /** 记忆内容 */
  content: string;
  /** 简短描述（用于相关性判断） */
  description: string;
  /** 记忆类型 */
  type: MemoryType;
  /** 记忆来源 */
  source: MemorySource;
  /** 创建时间 */
  createdAt: Date;
  /** 更新时间 */
  updatedAt: Date;
  /** 标签 */
  tags?: string[];
  /** 文件路径（持久化记忆） */
  filePath?: string;
}

/** Frontmatter 解析结果 */
interface Frontmatter {
  name?: string;
  description?: string;
  type?: string;
  tags?: string[];
  [key: string]: unknown;
}

// ─── 常量 ───

const ENTRYPOINT_NAME = 'MEMORY.md';
const MAX_ENTRYPOINT_LINES = 200;
const MAX_ENTRYPOINT_BYTES = 25_000;
const MAX_MEMORY_FILES = 200;
const FRONTMATTER_MAX_BYTES = 2048; // 读取 frontmatter 的最大字节数

// ─── 辅助函数 ───

/**
 * 将路径转换为安全的目录名
 * 参考 Claude Code: src/utils/path.ts sanitizePath
 */
function sanitizePath(p: string): string {
  return p
    .replace(/^\//, '')           // 移除开头的 /
    .replace(/[/\\]/g, '_')       // 替换路径分隔符
    .replace(/[^a-zA-Z0-9_.-]/g, '_') // 替换特殊字符
    .replace(/_+/g, '_')          // 合并连续下划线
    .substring(0, 200);           // 限制长度
}

/**
 * 解析 Markdown frontmatter
 * 参考 Claude Code: src/utils/frontmatterParser.ts
 */
function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const trimmed = content.trim();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: content };
  }

  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) {
    return { frontmatter: {}, body: content };
  }

  const fmBlock = trimmed.substring(3, endIndex).trim();
  const body = trimmed.substring(endIndex + 3).trim();

  const frontmatter: Frontmatter = {};
  for (const line of fmBlock.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.substring(0, colonIndex).trim();
    let value: string | string[] = line.substring(colonIndex + 1).trim();

    // 简单的数组解析（tags: [a, b, c]）
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    }

    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

/**
 * 生成 frontmatter 字符串
 */
function generateFrontmatter(memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt' | 'filePath'>): string {
  const lines = ['---'];
  lines.push(`name: ${memory.title}`);
  lines.push(`description: ${memory.description}`);
  lines.push(`type: ${memory.type}`);
  if (memory.tags?.length) {
    lines.push(`tags: [${memory.tags.join(', ')}]`);
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * 截断 MEMORY.md 内容
 * 参考 Claude Code: memdir.ts truncateEntrypointContent
 */
function truncateEntrypointContent(raw: string): {
  content: string;
  wasLineTruncated: boolean;
  wasByteTruncated: boolean;
} {
  const trimmed = raw.trim();
  const lines = trimmed.split('\n');
  const lineCount = lines.length;
  const byteCount = Buffer.byteLength(trimmed);

  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES;
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES;

  if (!wasLineTruncated && !wasByteTruncated) {
    return { content: trimmed, wasLineTruncated, wasByteTruncated };
  }

  let truncated = wasLineTruncated
    ? lines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : trimmed;

  if (Buffer.byteLength(truncated) > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf('\n', MAX_ENTRYPOINT_BYTES);
    truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES);
  }

  const reason = wasByteTruncated && !wasLineTruncated
    ? `${(byteCount / 1024).toFixed(1)}KB（限制: ${(MAX_ENTRYPOINT_BYTES / 1024).toFixed(0)}KB）— 索引条目过长`
    : wasLineTruncated && !wasByteTruncated
      ? `${lineCount} 行（限制: ${MAX_ENTRYPOINT_LINES}）`
      : `${lineCount} 行 / ${(byteCount / 1024).toFixed(1)}KB`;

  return {
    content: truncated + `\n\n> 警告: ${ENTRYPOINT_NAME} 过大（${reason}）。仅加载了部分内容。请保持索引条目简短（每行 ~200 字符以内），将详细内容移入主题文件。`,
    wasLineTruncated,
    wasByteTruncated,
  };
}

/**
 * 解析记忆类型
 */
function parseMemoryType(raw: unknown): MemoryType | undefined {
  if (typeof raw !== 'string') return undefined;
  const validTypes: MemoryType[] = ['user', 'feedback', 'project', 'reference'];
  return validTypes.find(t => t === raw);
}

/**
 * 生成唯一 ID
 */
function generateId(): string {
  return crypto.randomUUID().substring(0, 8);
}

/**
 * 将标题转换为安全的文件名
 */
function titleToFilename(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-') // 保留中文字符
    .replace(/^-|-$/g, '')
    .substring(0, 80) || 'untitled';
}

// ─── MemoryManager ───

export class MemoryManager {
  private sessionMemories: Memory[] = [];
  private globalMemoryDir: string;
  private projectMemoryDir: string;

  constructor(options?: {
    globalMemoryDir?: string;
    projectCwd?: string;
  }) {
    const home = os.homedir();
    this.globalMemoryDir = options?.globalMemoryDir || path.join(home, '.openaide', 'memory');

    const cwd = options?.projectCwd || process.cwd();
    this.projectMemoryDir = path.join(home, '.openaide', 'projects', sanitizePath(cwd), 'memory');
  }

  // ─── 目录管理 ───

  /** 确保记忆目录存在 */
  private async ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }

  /** 获取全局记忆目录 */
  getGlobalMemoryDir(): string {
    return this.globalMemoryDir;
  }

  /** 获取项目记忆目录 */
  getProjectMemoryDir(): string {
    return this.projectMemoryDir;
  }

  // ─── 加载记忆 ───

  /**
   * 加载所有记忆（全局 + 项目 + 会话）
   */
  async loadAll(): Promise<Memory[]> {
    const [globalMemories, projectMemories] = await Promise.all([
      this.scanMemoryDir(this.globalMemoryDir, 'global'),
      this.scanMemoryDir(this.projectMemoryDir, 'project'),
    ]);

    return [...globalMemories, ...projectMemories, ...this.sessionMemories];
  }

  /**
   * 加载 MEMORY.md 入口文件内容
   * 参考 Claude Code: memdir.ts buildMemoryPrompt
   */
  async loadEntrypoint(source: MemorySource = 'project'): Promise<string | null> {
    const dir = source === 'global' ? this.globalMemoryDir : this.projectMemoryDir;
    const entrypointPath = path.join(dir, ENTRYPOINT_NAME);

    try {
      const raw = await fs.readFile(entrypointPath, 'utf-8');
      const { content } = truncateEntrypointContent(raw);
      return content;
    } catch {
      return null;
    }
  }

  /**
   * 扫描记忆目录，读取所有 .md 文件的 frontmatter
   * 参考 Claude Code: memoryScan.ts scanMemoryFiles
   */
  async scanMemoryDir(dir: string, source: MemorySource): Promise<Memory[]> {
    try {
      const entries = await fs.readdir(dir, { recursive: true });
      const mdFiles = entries.filter(
        (f) => typeof f === 'string' && f.endsWith('.md') && path.basename(f) !== ENTRYPOINT_NAME,
      );

      const results = await Promise.allSettled(
        mdFiles.slice(0, MAX_MEMORY_FILES).map(async (relativePath): Promise<Memory> => {
          const filePath = path.join(dir, relativePath as string);
          const stat = await fs.stat(filePath);

          // 只读取文件开头的 frontmatter 部分
          const fd = await fs.open(filePath, 'r');
          const buffer = Buffer.alloc(FRONTMATTER_MAX_BYTES);
          const { bytesRead } = await fd.read(buffer, 0, FRONTMATTER_MAX_BYTES, 0);
          await fd.close();

          const headerContent = buffer.toString('utf-8', 0, bytesRead);
          const { frontmatter, body } = parseFrontmatter(headerContent);

          return {
            id: path.basename(relativePath as string, '.md'),
            title: (frontmatter.name as string) || path.basename(relativePath as string, '.md'),
            description: (frontmatter.description as string) || '',
            content: body,
            type: parseMemoryType(frontmatter.type) || 'project',
            source,
            createdAt: stat.birthtime,
            updatedAt: stat.mtime,
            tags: Array.isArray(frontmatter.tags) ? frontmatter.tags as string[] : undefined,
            filePath,
          };
        }),
      );

      return results
        .filter((r): r is PromiseFulfilledResult<Memory> => r.status === 'fulfilled')
        .map((r) => r.value)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    } catch {
      // 目录不存在等情况
      return [];
    }
  }

  // ─── 写入记忆 ───

  /**
   * 添加记忆
   * 创建一个新的 .md 文件到对应的记忆目录
   */
  async add(memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt' | 'filePath'>): Promise<Memory> {
    const id = `${titleToFilename(memory.title)}-${generateId()}`;
    const now = new Date();

    if (memory.source === 'session') {
      // 会话记忆只存在内存中
      const sessionMemory: Memory = {
        ...memory,
        id,
        createdAt: now,
        updatedAt: now,
      };
      this.sessionMemories.push(sessionMemory);
      return sessionMemory;
    }

    // 持久化记忆写入文件
    const dir = memory.source === 'global' ? this.globalMemoryDir : this.projectMemoryDir;
    await this.ensureDir(dir);

    const filename = `${id}.md`;
    const filePath = path.join(dir, filename);

    const frontmatter = generateFrontmatter(memory);
    const fileContent = `${frontmatter}\n\n${memory.content}`;

    await fs.writeFile(filePath, fileContent, 'utf-8');

    return {
      ...memory,
      id,
      createdAt: now,
      updatedAt: now,
      filePath,
    };
  }

  /**
   * 更新记忆
   */
  async update(id: string, updates: Partial<Pick<Memory, 'title' | 'content' | 'description' | 'tags'>>): Promise<Memory | null> {
    // 先在会话记忆中查找
    const sessionIdx = this.sessionMemories.findIndex((m) => m.id === id);
    if (sessionIdx !== -1) {
      const existing = this.sessionMemories[sessionIdx]!;
      const updated: Memory = {
        ...existing,
        ...updates,
        updatedAt: new Date(),
      };
      this.sessionMemories[sessionIdx] = updated;
      return updated;
    }

    // 在持久化记忆中查找
    const allMemories = await this.loadAll();
    const memory = allMemories.find((m) => m.id === id);
    if (!memory || !memory.filePath) return null;

    const updatedMemory: Memory = {
      ...memory,
      ...updates,
      updatedAt: new Date(),
    };

    // 重写文件
    const frontmatter = generateFrontmatter(updatedMemory);
    const fileContent = `${frontmatter}\n\n${updatedMemory.content}`;
    await fs.writeFile(memory.filePath, fileContent, 'utf-8');

    return updatedMemory;
  }

  /**
   * 删除记忆
   */
  async delete(id: string): Promise<boolean> {
    // 先在会话记忆中查找
    const sessionIdx = this.sessionMemories.findIndex((m) => m.id === id);
    if (sessionIdx !== -1) {
      this.sessionMemories.splice(sessionIdx, 1);
      return true;
    }

    // 在持久化记忆中查找
    const allMemories = await this.loadAll();
    const memory = allMemories.find((m) => m.id === id);
    if (!memory || !memory.filePath) return false;

    try {
      await fs.unlink(memory.filePath);
      return true;
    } catch {
      return false;
    }
  }

  // ─── 搜索记忆 ───

  /**
   * 基于关键词搜索相关记忆
   * 简单的文本匹配搜索（不依赖 LLM）
   *
   * 参考 Claude Code 的 findRelevantMemories 使用 LLM 进行相关性判断，
   * 但这里先实现基于关键词的搜索，后续可以升级为 LLM 驱动。
   */
  async findRelevant(query: string, limit = 5): Promise<Memory[]> {
    const allMemories = await this.loadAll();
    if (allMemories.length === 0) return [];

    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 1);

    // 计算每个记忆的相关性分数
    const scored = allMemories.map((memory) => {
      let score = 0;
      const searchText = `${memory.title} ${memory.description} ${memory.content} ${memory.tags?.join(' ') || ''}`.toLowerCase();

      for (const term of queryTerms) {
        // 标题匹配权重最高
        if (memory.title.toLowerCase().includes(term)) score += 3;
        // 描述匹配
        if (memory.description.toLowerCase().includes(term)) score += 2;
        // 内容匹配
        if (memory.content.toLowerCase().includes(term)) score += 1;
        // 标签匹配
        if (memory.tags?.some((t) => t.toLowerCase().includes(term))) score += 2;
      }

      // 完整查询匹配加分
      if (searchText.includes(queryLower)) score += 5;

      // 新鲜度加分（最近 7 天内的记忆加分）
      const ageMs = Date.now() - memory.updatedAt.getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays < 1) score += 2;
      else if (ageDays < 7) score += 1;

      return { memory, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.memory);
  }

  /**
   * 获取记忆摘要（用于 System Prompt）
   * 返回格式化的记忆内容，可直接嵌入 prompt
   */
  async getMemorySummary(): Promise<string | null> {
    const parts: string[] = [];

    // 1. 加载 MEMORY.md 入口文件
    const projectEntrypoint = await this.loadEntrypoint('project');
    if (projectEntrypoint) {
      parts.push(`### 项目记忆索引\n${projectEntrypoint}`);
    }

    const globalEntrypoint = await this.loadEntrypoint('global');
    if (globalEntrypoint) {
      parts.push(`### 全局记忆索引\n${globalEntrypoint}`);
    }

    // 2. 会话记忆
    if (this.sessionMemories.length > 0) {
      const sessionSummary = this.sessionMemories
        .map((m) => `- **${m.title}**: ${m.description || m.content.substring(0, 100)}`)
        .join('\n');
      parts.push(`### 会话记忆\n${sessionSummary}`);
    }

    return parts.length > 0 ? parts.join('\n\n') : null;
  }

  /**
   * 读取指定记忆文件的完整内容
   */
  async readMemoryFile(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  // ─── 会话记忆管理 ───

  /** 获取所有会话记忆 */
  getSessionMemories(): Memory[] {
    return [...this.sessionMemories];
  }

  /** 清空会话记忆 */
  clearSessionMemories(): void {
    this.sessionMemories = [];
  }

  // ─── MEMORY.md 入口文件管理 ───

  /**
   * 更新 MEMORY.md 入口文件
   * 添加一行索引条目
   */
  async addToEntrypoint(
    entry: string,
    source: MemorySource = 'project',
  ): Promise<void> {
    const dir = source === 'global' ? this.globalMemoryDir : this.projectMemoryDir;
    await this.ensureDir(dir);

    const entrypointPath = path.join(dir, ENTRYPOINT_NAME);

    let existing = '';
    try {
      existing = await fs.readFile(entrypointPath, 'utf-8');
    } catch {
      // 文件不存在，创建新的
existing = `# OpenAIDE记忆索引\n\n> 此文件由OpenAIDE自动维护。每行是一个记忆文件的索引条目。\n> 详细内容存储在同目录下的主题文件中。\n\n`;
    }

    const updatedContent = existing.trimEnd() + '\n' + entry + '\n';
    await fs.writeFile(entrypointPath, updatedContent, 'utf-8');
  }

  /**
   * 保存记忆并更新 MEMORY.md 索引
   * 这是添加记忆的推荐方式 — 同时创建文件和更新索引
   */
  async saveWithIndex(
    memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt' | 'filePath'>,
  ): Promise<Memory> {
    const saved = await this.add(memory);

    if (saved.source !== 'session' && saved.filePath) {
      // 添加索引条目到 MEMORY.md
      const relativeName = path.basename(saved.filePath);
      const indexEntry = `- [${saved.title}](./${relativeName}) — ${saved.description}`;
      await this.addToEntrypoint(indexEntry, saved.source);
    }

    return saved;
  }
}
