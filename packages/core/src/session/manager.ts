/**
 * 会话管理器
 *
 * 管理 AI 对话会话的生命周期：
 * - 创建新会话
 * - 切换会话
 * - 恢复历史会话
 * - 持久化会话到磁盘
 *
 * 会话存储位置: ~/.openaide/sessions/<project-hash>/
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { ChatMessage } from '../llm/types.js';

// ─── 类型定义 ───

/** 会话元数据 */
export interface SessionMeta {
  /** 会话 ID */
  id: string;
  /** 会话标题（从第一条消息自动生成） */
  title: string;
  /** 创建时间 */
  createdAt: string;
  /** 最后更新时间 */
  updatedAt: string;
  /** 消息数量 */
  messageCount: number;
  /** 使用的模型 */
  model?: string;
  /** Token 用量 */
  totalTokens?: number;
  /** 费用（美元） */
  totalCostUSD?: number;
}

/** 完整会话数据 */
export interface SessionData extends SessionMeta {
  /** 对话消息历史 */
  messages: ChatMessage[];
}

/** 会话列表项（不含消息内容） */
export type SessionListItem = SessionMeta;

// ─── 常量 ───

const SESSIONS_DIR = '.openaide';
const SESSIONS_SUBDIR = 'sessions';
const MAX_SESSIONS = 100;
const MAX_TITLE_LENGTH = 80;

// ─── SessionManager ───

export class SessionManager {
  private sessionsDir: string;
  private currentSessionId: string | null = null;

  constructor(options?: { projectCwd?: string }) {
    const home = os.homedir();
    const cwd = options?.projectCwd || process.cwd();
    const projectHash = crypto.createHash('md5').update(cwd).digest('hex').substring(0, 12);
    this.sessionsDir = path.join(home, SESSIONS_DIR, SESSIONS_SUBDIR, projectHash);
  }

  /**
   * 确保会话目录存在
   */
  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
  }

  /**
   * 获取会话文件路径
   */
  private getSessionPath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  /**
   * 创建新会话
   */
  async create(model?: string): Promise<SessionData> {
    await this.ensureDir();

    const id = this.generateId();
    const now = new Date().toISOString();

    const session: SessionData = {
      id,
      title: '新对话',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      model,
      messages: [],
    };

    await this.save(session);
    this.currentSessionId = id;

    return session;
  }

  /**
   * 保存会话到磁盘
   */
  async save(session: SessionData): Promise<void> {
    await this.ensureDir();
    const filePath = this.getSessionPath(session.id);
    const data = JSON.stringify(session, null, 2);
    await fs.writeFile(filePath, data, 'utf-8');
  }

  /**
   * 加载会话
   */
  async load(sessionId: string): Promise<SessionData | null> {
    try {
      const filePath = this.getSessionPath(sessionId);
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as SessionData;
    } catch {
      return null;
    }
  }

  /**
   * 切换到指定会话
   */
  async switchTo(sessionId: string): Promise<SessionData | null> {
    const session = await this.load(sessionId);
    if (session) {
      this.currentSessionId = sessionId;
    }
    return session;
  }

  /**
   * 获取当前会话 ID
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * 更新会话消息
   */
  async updateMessages(sessionId: string, messages: ChatMessage[]): Promise<void> {
    const session = await this.load(sessionId);
    if (!session) return;

    session.messages = messages;
    session.messageCount = messages.length;
    session.updatedAt = new Date().toISOString();

    // 自动生成标题（从第一条用户消息）
    if (session.title === '新对话' && messages.length > 0) {
      const firstUserMsg = messages.find((m) => m.role === 'user');
      if (firstUserMsg) {
        const content = typeof firstUserMsg.content === 'string'
          ? firstUserMsg.content
          : firstUserMsg.content
              .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
              .map((b) => b.text)
              .join('');
        session.title = content.substring(0, MAX_TITLE_LENGTH).replace(/\n/g, ' ').trim();
        if (content.length > MAX_TITLE_LENGTH) {
          session.title += '...';
        }
      }
    }

    await this.save(session);
  }

  /**
   * 更新会话用量信息
   */
  async updateUsage(
    sessionId: string,
    usage: { totalTokens?: number; totalCostUSD?: number; model?: string },
  ): Promise<void> {
    const session = await this.load(sessionId);
    if (!session) return;

    if (usage.totalTokens !== undefined) session.totalTokens = usage.totalTokens;
    if (usage.totalCostUSD !== undefined) session.totalCostUSD = usage.totalCostUSD;
    if (usage.model) session.model = usage.model;
    session.updatedAt = new Date().toISOString();

    await this.save(session);
  }

  /**
   * 列出所有会话（按更新时间倒序）
   */
  async list(): Promise<SessionListItem[]> {
    try {
      await this.ensureDir();
      const files = await fs.readdir(this.sessionsDir);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));

      const sessions: SessionListItem[] = [];

      for (const file of jsonFiles.slice(0, MAX_SESSIONS)) {
        try {
          const filePath = path.join(this.sessionsDir, file);
          const data = await fs.readFile(filePath, 'utf-8');
          const session = JSON.parse(data) as SessionData;

          // 只返回元数据，不含消息内容
          sessions.push({
            id: session.id,
            title: session.title,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            messageCount: session.messageCount,
            model: session.model,
            totalTokens: session.totalTokens,
            totalCostUSD: session.totalCostUSD,
          });
        } catch {
          // 跳过损坏的文件
        }
      }

      // 按更新时间倒序排列
      sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

      return sessions;
    } catch {
      return [];
    }
  }

  /**
   * 删除会话
   */
  async delete(sessionId: string): Promise<boolean> {
    try {
      const filePath = this.getSessionPath(sessionId);
      await fs.unlink(filePath);
      if (this.currentSessionId === sessionId) {
        this.currentSessionId = null;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 清理旧会话（保留最近 N 个）
   */
  async cleanup(keepCount = 50): Promise<number> {
    const sessions = await this.list();
    if (sessions.length <= keepCount) return 0;

    const toDelete = sessions.slice(keepCount);
    let deleted = 0;

    for (const session of toDelete) {
      if (await this.delete(session.id)) {
        deleted++;
      }
    }

    return deleted;
  }

  /**
   * 生成唯一会话 ID
   */
  private generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(4).toString('hex');
    return `session-${timestamp}-${random}`;
  }
}
