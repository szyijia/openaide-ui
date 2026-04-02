/**
 * 云同步服务
 *
 * 支持将本地数据同步到云端：
 * 1. 配置同步 — IDE 设置、快捷键、扩展列表
 * 2. 记忆同步 — 全局记忆、项目记忆
 * 3. 会话历史同步 — 对话记录、用量统计
 *
 * 同步策略：
 * - 增量同步（基于时间戳和哈希）
 * - 冲突解决（最后写入优先 / 手动合并）
 * - 离线队列（断网时缓存操作，恢复后自动同步）
 * - 端到端加密（可选）
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

// ─── 常量 ───

const OPENAIDE_DIR = path.join(os.homedir(), '.openaide');
const SYNC_DIR = path.join(OPENAIDE_DIR, 'sync');
const SYNC_STATE_FILE = 'sync-state.json';
const SYNC_QUEUE_FILE = 'sync-queue.json';
const SYNC_LOG_FILE = 'sync-log.json';

/** 同步 API 基础 URL */
const DEFAULT_API_BASE = 'https://api.openaide.io/v1/sync';

/** 最大离线队列长度 */
const MAX_QUEUE_SIZE = 500;

/** 同步日志最大条数 */
const MAX_LOG_ENTRIES = 200;

/** 单次同步最大数据量 (5MB) */
const MAX_SYNC_PAYLOAD = 5 * 1024 * 1024;

/** 自动同步间隔 (5 分钟) */
const AUTO_SYNC_INTERVAL = 5 * 60 * 1000;

/** 同步重试次数 */
const MAX_RETRIES = 3;

/** 重试延迟基数 (ms) */
const RETRY_BASE_DELAY = 1000;

// ─── 类型定义 ───

/** 可同步的数据类型 */
export type SyncDataType = 'config' | 'memory' | 'session' | 'extension' | 'keybinding' | 'snippet';

/** 同步方向 */
export type SyncDirection = 'upload' | 'download' | 'bidirectional';

/** 冲突解决策略 */
export type ConflictStrategy = 'local-wins' | 'remote-wins' | 'newest-wins' | 'manual';

/** 同步状态 */
export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline' | 'conflict';

/** 同步项元数据 */
export interface SyncItemMeta {
  /** 唯一标识 */
  id: string;
  /** 数据类型 */
  type: SyncDataType;
  /** 相对路径（相对于 ~/.openaide/） */
  relativePath: string;
  /** 内容哈希 (SHA-256) */
  contentHash: string;
  /** 内容大小 (bytes) */
  size: number;
  /** 本地最后修改时间 */
  localModifiedAt: string;
  /** 云端最后修改时间 */
  remoteModifiedAt?: string;
  /** 是否已加密 */
  encrypted: boolean;
  /** 版本号（用于乐观锁） */
  version: number;
}

/** 同步冲突 */
export interface SyncConflict {
  /** 冲突项 ID */
  itemId: string;
  /** 数据类型 */
  type: SyncDataType;
  /** 相对路径 */
  relativePath: string;
  /** 本地版本信息 */
  local: {
    contentHash: string;
    modifiedAt: string;
    version: number;
  };
  /** 远端版本信息 */
  remote: {
    contentHash: string;
    modifiedAt: string;
    version: number;
  };
  /** 冲突发生时间 */
  detectedAt: string;
  /** 是否已解决 */
  resolved: boolean;
  /** 解决方式 */
  resolution?: 'keep-local' | 'keep-remote' | 'merged';
}

/** 同步操作（离线队列项） */
export interface SyncOperation {
  /** 操作 ID */
  id: string;
  /** 操作类型 */
  action: 'create' | 'update' | 'delete';
  /** 数据类型 */
  type: SyncDataType;
  /** 相对路径 */
  relativePath: string;
  /** 内容（create/update 时） */
  content?: string;
  /** 内容哈希 */
  contentHash?: string;
  /** 操作时间 */
  timestamp: string;
  /** 重试次数 */
  retries: number;
  /** 最后错误 */
  lastError?: string;
}

/** 同步日志条目 */
export interface SyncLogEntry {
  /** 时间戳 */
  timestamp: string;
  /** 操作方向 */
  direction: 'upload' | 'download';
  /** 数据类型 */
  type: SyncDataType;
  /** 文件路径 */
  relativePath: string;
  /** 操作 */
  action: 'create' | 'update' | 'delete';
  /** 是否成功 */
  success: boolean;
  /** 数据大小 */
  size?: number;
  /** 错误信息 */
  error?: string;
}

/** 同步状态（持久化） */
export interface SyncState {
  /** 是否启用同步 */
  enabled: boolean;
  /** 上次同步时间 */
  lastSyncAt?: string;
  /** 上次成功同步时间 */
  lastSuccessAt?: string;
  /** 当前状态 */
  status: SyncStatus;
  /** 已同步项的元数据 */
  items: Record<string, SyncItemMeta>;
  /** 未解决的冲突 */
  conflicts: SyncConflict[];
  /** 同步统计 */
  stats: {
    totalUploads: number;
    totalDownloads: number;
    totalConflicts: number;
    totalErrors: number;
    lastErrorMessage?: string;
  };
}

/** 同步配置 */
export interface CloudSyncConfig {
  /** API 基础 URL */
  apiBase?: string;
  /** 认证 Token */
  authToken?: string;
  /** 同步方向 */
  direction?: SyncDirection;
  /** 冲突解决策略 */
  conflictStrategy?: ConflictStrategy;
  /** 启用端到端加密 */
  enableEncryption?: boolean;
  /** 加密密钥（用户提供） */
  encryptionKey?: string;
  /** 自动同步间隔 (ms)，0 = 禁用 */
  autoSyncInterval?: number;
  /** 要同步的数据类型 */
  syncTypes?: SyncDataType[];
  /** 排除的路径模式 */
  excludePatterns?: string[];
  /** 最大同步文件大小 (bytes) */
  maxFileSize?: number;
}

/** 同步进度事件 */
export interface SyncProgressEvent {
  /** 阶段 */
  phase: 'preparing' | 'uploading' | 'downloading' | 'resolving' | 'complete' | 'error';
  /** 当前进度 (0-100) */
  progress: number;
  /** 当前处理的文件 */
  currentFile?: string;
  /** 总文件数 */
  totalFiles: number;
  /** 已处理文件数 */
  processedFiles: number;
  /** 传输字节数 */
  bytesTransferred: number;
  /** 错误信息 */
  error?: string;
}

/** 同步结果 */
export interface SyncResult {
  /** 是否成功 */
  success: boolean;
  /** 上传文件数 */
  uploaded: number;
  /** 下载文件数 */
  downloaded: number;
  /** 删除文件数 */
  deleted: number;
  /** 冲突数 */
  conflicts: number;
  /** 错误数 */
  errors: number;
  /** 耗时 (ms) */
  duration: number;
  /** 传输数据量 (bytes) */
  bytesTransferred: number;
  /** 错误详情 */
  errorDetails?: string[];
}

// ─── 云同步服务 ───

export class CloudSyncService {
  private config: Required<CloudSyncConfig>;
  private state: SyncState;
  private queue: SyncOperation[] = [];
  private logs: SyncLogEntry[] = [];
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private isSyncing = false;
  private progressListeners: Array<(event: SyncProgressEvent) => void> = [];

  constructor(config?: CloudSyncConfig) {
    this.config = {
      apiBase: config?.apiBase || DEFAULT_API_BASE,
      authToken: config?.authToken || '',
      direction: config?.direction || 'bidirectional',
      conflictStrategy: config?.conflictStrategy || 'newest-wins',
      enableEncryption: config?.enableEncryption || false,
      encryptionKey: config?.encryptionKey || '',
      autoSyncInterval: config?.autoSyncInterval ?? AUTO_SYNC_INTERVAL,
      syncTypes: config?.syncTypes || ['config', 'memory', 'session', 'keybinding', 'snippet'],
      excludePatterns: config?.excludePatterns || ['*.tmp', '*.lock', 'sync-queue.json'],
      maxFileSize: config?.maxFileSize || MAX_SYNC_PAYLOAD,
    };

    this.state = this.getDefaultState();
  }

  // ─── 初始化 ───

  /**
   * 初始化同步服务
   * 加载持久化状态、离线队列、启动自动同步
   */
  async init(): Promise<void> {
    await fs.mkdir(SYNC_DIR, { recursive: true });
    await Promise.all([
      this.loadState(),
      this.loadQueue(),
      this.loadLogs(),
    ]);

    // 如果有离线队列，尝试处理
    if (this.queue.length > 0 && this.config.authToken) {
      this.processQueue().catch(() => {});
    }

    // 启动自动同步
    if (this.config.autoSyncInterval > 0 && this.state.enabled) {
      this.startAutoSync();
    }
  }

  /**
   * 销毁服务（停止自动同步）
   */
  destroy(): void {
    this.stopAutoSync();
    this.progressListeners = [];
  }

  // ─── 同步控制 ───

  /**
   * 启用/禁用同步
   */
  async setEnabled(enabled: boolean): Promise<void> {
    this.state.enabled = enabled;
    await this.saveState();

    if (enabled) {
      this.startAutoSync();
    } else {
      this.stopAutoSync();
    }
  }

  /**
   * 是否已启用同步
   */
  isEnabled(): boolean {
    return this.state.enabled;
  }

  /**
   * 获取当前同步状态
   */
  getStatus(): SyncStatus {
    return this.state.status;
  }

  /**
   * 获取完整同步状态
   */
  getState(): SyncState {
    return { ...this.state };
  }

  /**
   * 更新配置
   */
  async updateConfig(updates: Partial<CloudSyncConfig>): Promise<void> {
    Object.assign(this.config, updates);

    // 重启自动同步
    if (updates.autoSyncInterval !== undefined) {
      this.stopAutoSync();
      if (this.config.autoSyncInterval > 0 && this.state.enabled) {
        this.startAutoSync();
      }
    }
  }

  // ─── 核心同步 ───

  /**
   * 执行完整同步
   *
   * 流程：
   * 1. 扫描本地文件，计算哈希
   * 2. 获取远端文件列表
   * 3. 比较差异，确定操作
   * 4. 处理冲突
   * 5. 执行上传/下载
   * 6. 更新状态
   */
  async sync(): Promise<SyncResult> {
    if (this.isSyncing) {
      return { success: false, uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, errors: 1, duration: 0, bytesTransferred: 0, errorDetails: ['同步正在进行中'] };
    }

    if (!this.config.authToken) {
      return { success: false, uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, errors: 1, duration: 0, bytesTransferred: 0, errorDetails: ['未设置认证 Token'] };
    }

    this.isSyncing = true;
    this.state.status = 'syncing';
    this.state.lastSyncAt = new Date().toISOString();
    const startTime = Date.now();

    const result: SyncResult = {
      success: true,
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      errors: 0,
      duration: 0,
      bytesTransferred: 0,
      errorDetails: [],
    };

    try {
      this.emitProgress({ phase: 'preparing', progress: 0, totalFiles: 0, processedFiles: 0, bytesTransferred: 0 });

      // 1. 先处理离线队列
      if (this.queue.length > 0) {
        await this.processQueue();
      }

      // 2. 扫描本地文件
      const localFiles = await this.scanLocalFiles();

      // 3. 获取远端文件列表
      const remoteFiles = await this.fetchRemoteFileList();

      // 4. 计算差异
      const diff = this.computeDiff(localFiles, remoteFiles);

      const totalOps = diff.toUpload.length + diff.toDownload.length + diff.toDelete.length + diff.conflicts.length;
      let processedOps = 0;

      // 5. 处理冲突
      for (const conflict of diff.conflicts) {
        const resolved = this.resolveConflict(conflict);
        if (resolved === 'upload') {
          diff.toUpload.push(conflict.itemId);
        } else if (resolved === 'download') {
          diff.toDownload.push(conflict.itemId);
        } else {
          // 手动解决 — 添加到冲突列表
          this.state.conflicts.push({
            itemId: conflict.itemId,
            type: conflict.type,
            relativePath: conflict.relativePath,
            local: conflict.local,
            remote: conflict.remote,
            detectedAt: new Date().toISOString(),
            resolved: false,
          });
          result.conflicts++;
        }
        processedOps++;
        this.emitProgress({ phase: 'resolving', progress: Math.round((processedOps / totalOps) * 100), totalFiles: totalOps, processedFiles: processedOps, bytesTransferred: result.bytesTransferred });
      }

      // 6. 上传
      if (this.config.direction !== 'download') {
        for (const itemId of diff.toUpload) {
          try {
            const meta = localFiles.get(itemId);
            if (!meta) continue;

            const bytes = await this.uploadFile(meta);
            result.uploaded++;
            result.bytesTransferred += bytes;

            this.addLog({
              timestamp: new Date().toISOString(),
              direction: 'upload',
              type: meta.type,
              relativePath: meta.relativePath,
              action: this.state.items[itemId] ? 'update' : 'create',
              success: true,
              size: bytes,
            });

            // 更新本地状态
            this.state.items[itemId] = { ...meta, remoteModifiedAt: new Date().toISOString(), version: meta.version + 1 };
          } catch (err) {
            result.errors++;
            const errMsg = err instanceof Error ? err.message : String(err);
            result.errorDetails!.push(`上传失败 [${itemId}]: ${errMsg}`);

            this.addLog({
              timestamp: new Date().toISOString(),
              direction: 'upload',
              type: localFiles.get(itemId)?.type || 'config',
              relativePath: localFiles.get(itemId)?.relativePath || itemId,
              action: 'update',
              success: false,
              error: errMsg,
            });
          }

          processedOps++;
          this.emitProgress({ phase: 'uploading', progress: Math.round((processedOps / totalOps) * 100), currentFile: localFiles.get(itemId)?.relativePath, totalFiles: totalOps, processedFiles: processedOps, bytesTransferred: result.bytesTransferred });
        }
      }

      // 7. 下载
      if (this.config.direction !== 'upload') {
        for (const itemId of diff.toDownload) {
          try {
            const remoteMeta = remoteFiles.get(itemId);
            if (!remoteMeta) continue;

            const bytes = await this.downloadFile(remoteMeta);
            result.downloaded++;
            result.bytesTransferred += bytes;

            this.addLog({
              timestamp: new Date().toISOString(),
              direction: 'download',
              type: remoteMeta.type,
              relativePath: remoteMeta.relativePath,
              action: this.state.items[itemId] ? 'update' : 'create',
              success: true,
              size: bytes,
            });

            // 更新本地状态
            this.state.items[itemId] = { ...remoteMeta };
          } catch (err) {
            result.errors++;
            const errMsg = err instanceof Error ? err.message : String(err);
            result.errorDetails!.push(`下载失败 [${itemId}]: ${errMsg}`);

            this.addLog({
              timestamp: new Date().toISOString(),
              direction: 'download',
              type: remoteFiles.get(itemId)?.type || 'config',
              relativePath: remoteFiles.get(itemId)?.relativePath || itemId,
              action: 'update',
              success: false,
              error: errMsg,
            });
          }

          processedOps++;
          this.emitProgress({ phase: 'downloading', progress: Math.round((processedOps / totalOps) * 100), currentFile: remoteFiles.get(itemId)?.relativePath, totalFiles: totalOps, processedFiles: processedOps, bytesTransferred: result.bytesTransferred });
        }
      }

      // 8. 删除远端已删除的本地文件
      for (const itemId of diff.toDelete) {
        try {
          const meta = this.state.items[itemId];
          if (!meta) continue;

          const localPath = path.join(OPENAIDE_DIR, meta.relativePath);
          await fs.unlink(localPath).catch(() => {});
          delete this.state.items[itemId];
          result.deleted++;

          this.addLog({
            timestamp: new Date().toISOString(),
            direction: 'download',
            type: meta.type,
            relativePath: meta.relativePath,
            action: 'delete',
            success: true,
          });
        } catch {
          result.errors++;
        }
        processedOps++;
      }

      // 9. 更新状态
      result.success = result.errors === 0;
      if (result.success) {
        this.state.lastSuccessAt = new Date().toISOString();
      }
      this.state.status = result.conflicts > 0 ? 'conflict' : 'idle';
      this.state.stats.totalUploads += result.uploaded;
      this.state.stats.totalDownloads += result.downloaded;
      this.state.stats.totalConflicts += result.conflicts;
      this.state.stats.totalErrors += result.errors;

      this.emitProgress({ phase: 'complete', progress: 100, totalFiles: totalOps, processedFiles: processedOps, bytesTransferred: result.bytesTransferred });

    } catch (err) {
      result.success = false;
      result.errors++;
      const errMsg = err instanceof Error ? err.message : String(err);
      result.errorDetails!.push(errMsg);
      this.state.status = 'error';
      this.state.stats.lastErrorMessage = errMsg;

      this.emitProgress({ phase: 'error', progress: 0, totalFiles: 0, processedFiles: 0, bytesTransferred: 0, error: errMsg });
    } finally {
      this.isSyncing = false;
      result.duration = Date.now() - startTime;
      await Promise.all([this.saveState(), this.saveLogs()]);
    }

    return result;
  }

  /**
   * 仅上传本地变更
   */
  async push(): Promise<SyncResult> {
    const originalDirection = this.config.direction;
    this.config.direction = 'upload';
    try {
      return await this.sync();
    } finally {
      this.config.direction = originalDirection;
    }
  }

  /**
   * 仅下载远端变更
   */
  async pull(): Promise<SyncResult> {
    const originalDirection = this.config.direction;
    this.config.direction = 'download';
    try {
      return await this.sync();
    } finally {
      this.config.direction = originalDirection;
    }
  }

  // ─── 离线队列 ───

  /**
   * 将操作加入离线队列
   * 当网络不可用时，操作会被缓存到队列中
   */
  async enqueue(operation: Omit<SyncOperation, 'id' | 'timestamp' | 'retries'>): Promise<void> {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      // 移除最旧的操作
      this.queue.shift();
    }

    this.queue.push({
      ...operation,
      id: crypto.randomBytes(8).toString('hex'),
      timestamp: new Date().toISOString(),
      retries: 0,
    });

    await this.saveQueue();
  }

  /**
   * 处理离线队列
   */
  async processQueue(): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed = 0;
    const remaining: SyncOperation[] = [];

    for (const op of this.queue) {
      try {
        await this.executeOperation(op);
        processed++;
      } catch (err) {
        op.retries++;
        op.lastError = err instanceof Error ? err.message : String(err);

        if (op.retries < MAX_RETRIES) {
          remaining.push(op);
        } else {
          failed++;
          this.addLog({
            timestamp: new Date().toISOString(),
            direction: 'upload',
            type: op.type,
            relativePath: op.relativePath,
            action: op.action,
            success: false,
            error: `超过最大重试次数: ${op.lastError}`,
          });
        }
      }
    }

    this.queue = remaining;
    await this.saveQueue();

    return { processed, failed };
  }

  /**
   * 获取离线队列长度
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  // ─── 冲突管理 ───

  /**
   * 获取未解决的冲突列表
   */
  getConflicts(): SyncConflict[] {
    return this.state.conflicts.filter((c) => !c.resolved);
  }

  /**
   * 手动解决冲突
   */
  async resolveConflictManually(
    itemId: string,
    resolution: 'keep-local' | 'keep-remote',
  ): Promise<boolean> {
    const conflict = this.state.conflicts.find((c) => c.itemId === itemId && !c.resolved);
    if (!conflict) return false;

    conflict.resolved = true;
    conflict.resolution = resolution;

    if (resolution === 'keep-local') {
      // 上传本地版本覆盖远端
      await this.enqueue({
        action: 'update',
        type: conflict.type,
        relativePath: conflict.relativePath,
      });
    } else {
      // 下载远端版本覆盖本地
      const remoteMeta: SyncItemMeta = {
        id: itemId,
        type: conflict.type,
        relativePath: conflict.relativePath,
        contentHash: conflict.remote.contentHash,
        size: 0,
        localModifiedAt: conflict.remote.modifiedAt,
        remoteModifiedAt: conflict.remote.modifiedAt,
        encrypted: false,
        version: conflict.remote.version,
      };
      await this.downloadFile(remoteMeta);
    }

    // 清理已解决的冲突（保留最近 50 条记录）
    const resolvedConflicts = this.state.conflicts.filter((c) => c.resolved);
    if (resolvedConflicts.length > 50) {
      this.state.conflicts = [
        ...this.state.conflicts.filter((c) => !c.resolved),
        ...resolvedConflicts.slice(-50),
      ];
    }

    await this.saveState();
    return true;
  }

  // ─── 进度监听 ───

  /**
   * 注册进度监听器
   */
  onProgress(listener: (event: SyncProgressEvent) => void): () => void {
    this.progressListeners.push(listener);
    return () => {
      this.progressListeners = this.progressListeners.filter((l) => l !== listener);
    };
  }

  // ─── 同步日志 ───

  /**
   * 获取同步日志
   */
  getLogs(limit = 50): SyncLogEntry[] {
    return this.logs.slice(-limit);
  }

  /**
   * 清空同步日志
   */
  async clearLogs(): Promise<void> {
    this.logs = [];
    await this.saveLogs();
  }

  // ─── 数据导出/导入 ───

  /**
   * 导出所有同步数据为 JSON
   * 用于手动备份或迁移
   */
  async exportData(): Promise<{
    exportedAt: string;
    dataTypes: SyncDataType[];
    files: Array<{ relativePath: string; type: SyncDataType; content: string }>;
  }> {
    const files: Array<{ relativePath: string; type: SyncDataType; content: string }> = [];

    for (const type of this.config.syncTypes) {
      const typeFiles = await this.getFilesForType(type);
      for (const filePath of typeFiles) {
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const relativePath = path.relative(OPENAIDE_DIR, filePath);
          files.push({ relativePath, type, content });
        } catch {
          // 跳过无法读取的文件
        }
      }
    }

    return {
      exportedAt: new Date().toISOString(),
      dataTypes: this.config.syncTypes,
      files,
    };
  }

  /**
   * 从导出数据中导入
   */
  async importData(data: {
    files: Array<{ relativePath: string; type: SyncDataType; content: string }>;
  }): Promise<{ imported: number; errors: number }> {
    let imported = 0;
    let errors = 0;

    for (const file of data.files) {
      try {
        const fullPath = path.join(OPENAIDE_DIR, file.relativePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, file.content, 'utf-8');
        imported++;
      } catch {
        errors++;
      }
    }

    return { imported, errors };
  }

  // ─── 重置 ───

  /**
   * 重置同步状态（不删除本地数据）
   */
  async reset(): Promise<void> {
    this.stopAutoSync();
    this.state = this.getDefaultState();
    this.queue = [];
    this.logs = [];
    await Promise.all([this.saveState(), this.saveQueue(), this.saveLogs()]);
  }

  // ─── 内部方法：文件扫描 ───

  /**
   * 扫描本地需要同步的文件
   */
  private async scanLocalFiles(): Promise<Map<string, SyncItemMeta>> {
    const result = new Map<string, SyncItemMeta>();

    for (const type of this.config.syncTypes) {
      const files = await this.getFilesForType(type);

      for (const filePath of files) {
        try {
          // 检查排除模式
          const relativePath = path.relative(OPENAIDE_DIR, filePath);
          if (this.isExcluded(relativePath)) continue;

          const stat = await fs.stat(filePath);

          // 跳过过大的文件
          if (stat.size > this.config.maxFileSize) continue;

          const content = await fs.readFile(filePath);
          const contentHash = crypto.createHash('sha256').update(content).digest('hex');

          const id = this.filePathToId(relativePath);
          const existing = this.state.items[id];

          result.set(id, {
            id,
            type,
            relativePath,
            contentHash,
            size: stat.size,
            localModifiedAt: stat.mtime.toISOString(),
            remoteModifiedAt: existing?.remoteModifiedAt,
            encrypted: false,
            version: existing?.version || 0,
          });
        } catch {
          // 跳过无法读取的文件
        }
      }
    }

    return result;
  }

  /**
   * 获取指定类型的文件列表
   */
  private async getFilesForType(type: SyncDataType): Promise<string[]> {
    const files: string[] = [];

    try {
      switch (type) {
        case 'config': {
          // IDE 配置文件
          const configDir = path.join(OPENAIDE_DIR, 'config');
          const configFiles = await this.walkDir(configDir);
          files.push(...configFiles.filter((f) => f.endsWith('.json') || f.endsWith('.yaml')));
          break;
        }
        case 'memory': {
          // 全局记忆
          const memoryDir = path.join(OPENAIDE_DIR, 'memory');
          const memoryFiles = await this.walkDir(memoryDir);
          files.push(...memoryFiles.filter((f) => f.endsWith('.md')));
          break;
        }
        case 'session': {
          // 会话历史（只同步元数据，不同步完整消息）
          const sessionsDir = path.join(OPENAIDE_DIR, 'sessions');
          const sessionFiles = await this.walkDir(sessionsDir);
          files.push(...sessionFiles.filter((f) => f.endsWith('.json')));
          break;
        }
        case 'keybinding': {
          // 快捷键配置
          const keybindingFile = path.join(OPENAIDE_DIR, 'config', 'keybindings.json');
          try {
            await fs.access(keybindingFile);
            files.push(keybindingFile);
          } catch { /* 文件不存在 */ }
          break;
        }
        case 'snippet': {
          // 代码片段
          const snippetDir = path.join(OPENAIDE_DIR, 'snippets');
          const snippetFiles = await this.walkDir(snippetDir);
          files.push(...snippetFiles.filter((f) => f.endsWith('.json') || f.endsWith('.code-snippets')));
          break;
        }
        case 'extension': {
          // 扩展列表
          const extFile = path.join(OPENAIDE_DIR, 'config', 'extensions.json');
          try {
            await fs.access(extFile);
            files.push(extFile);
          } catch { /* 文件不存在 */ }
          break;
        }
      }
    } catch {
      // 目录不存在等情况
    }

    return files;
  }

  /**
   * 递归遍历目录
   */
  private async walkDir(dir: string): Promise<string[]> {
    const results: string[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const subFiles = await this.walkDir(fullPath);
          results.push(...subFiles);
        } else if (entry.isFile()) {
          results.push(fullPath);
        }
      }
    } catch {
      // 目录不存在
    }

    return results;
  }

  // ─── 内部方法：差异计算 ───

  /**
   * 计算本地和远端的差异
   */
  private computeDiff(
    localFiles: Map<string, SyncItemMeta>,
    remoteFiles: Map<string, SyncItemMeta>,
  ): {
    toUpload: string[];
    toDownload: string[];
    toDelete: string[];
    conflicts: Array<{
      itemId: string;
      type: SyncDataType;
      relativePath: string;
      local: { contentHash: string; modifiedAt: string; version: number };
      remote: { contentHash: string; modifiedAt: string; version: number };
    }>;
  } {
    const toUpload: string[] = [];
    const toDownload: string[] = [];
    const toDelete: string[] = [];
    const conflicts: Array<{
      itemId: string;
      type: SyncDataType;
      relativePath: string;
      local: { contentHash: string; modifiedAt: string; version: number };
      remote: { contentHash: string; modifiedAt: string; version: number };
    }> = [];

    // 检查本地文件
    for (const [id, localMeta] of localFiles) {
      const remoteMeta = remoteFiles.get(id);

      if (!remoteMeta) {
        // 远端不存在 → 上传
        toUpload.push(id);
      } else if (localMeta.contentHash !== remoteMeta.contentHash) {
        // 内容不同 → 可能冲突
        const lastKnown = this.state.items[id];

        if (!lastKnown) {
          // 首次同步，两端都有不同内容 → 冲突
          conflicts.push({
            itemId: id,
            type: localMeta.type,
            relativePath: localMeta.relativePath,
            local: { contentHash: localMeta.contentHash, modifiedAt: localMeta.localModifiedAt, version: localMeta.version },
            remote: { contentHash: remoteMeta.contentHash, modifiedAt: remoteMeta.remoteModifiedAt || remoteMeta.localModifiedAt, version: remoteMeta.version },
          });
        } else if (lastKnown.contentHash === remoteMeta.contentHash) {
          // 远端未变，本地变了 → 上传
          toUpload.push(id);
        } else if (lastKnown.contentHash === localMeta.contentHash) {
          // 本地未变，远端变了 → 下载
          toDownload.push(id);
        } else {
          // 两端都变了 → 冲突
          conflicts.push({
            itemId: id,
            type: localMeta.type,
            relativePath: localMeta.relativePath,
            local: { contentHash: localMeta.contentHash, modifiedAt: localMeta.localModifiedAt, version: localMeta.version },
            remote: { contentHash: remoteMeta.contentHash, modifiedAt: remoteMeta.remoteModifiedAt || remoteMeta.localModifiedAt, version: remoteMeta.version },
          });
        }
      }
      // 哈希相同 → 无需操作
    }

    // 检查远端有但本地没有的文件
    for (const [id, remoteMeta] of remoteFiles) {
      if (!localFiles.has(id)) {
        const lastKnown = this.state.items[id];
        if (lastKnown) {
          // 之前同步过但本地已删除 → 通知远端删除（或下载恢复）
          // 默认行为：认为本地删除是有意的，不下载
          // 如果需要恢复，用户可以手动 pull
        } else {
          // 远端新文件 → 下载
          toDownload.push(id);
        }
      }
    }

    return { toUpload, toDownload, toDelete, conflicts };
  }

  /**
   * 自动解决冲突
   */
  private resolveConflict(conflict: {
    itemId: string;
    local: { contentHash: string; modifiedAt: string; version: number };
    remote: { contentHash: string; modifiedAt: string; version: number };
  }): 'upload' | 'download' | 'manual' {
    switch (this.config.conflictStrategy) {
      case 'local-wins':
        return 'upload';
      case 'remote-wins':
        return 'download';
      case 'newest-wins': {
        const localTime = new Date(conflict.local.modifiedAt).getTime();
        const remoteTime = new Date(conflict.remote.modifiedAt).getTime();
        return localTime >= remoteTime ? 'upload' : 'download';
      }
      case 'manual':
        return 'manual';
      default:
        return 'manual';
    }
  }

  // ─── 内部方法：网络操作 ───

  /**
   * 获取远端文件列表
   */
  private async fetchRemoteFileList(): Promise<Map<string, SyncItemMeta>> {
    const result = new Map<string, SyncItemMeta>();

    try {
      const response = await this.apiRequest('GET', '/files');
      if (response.ok) {
        const data = await response.json() as { files: SyncItemMeta[] };
        for (const file of data.files) {
          result.set(file.id, file);
        }
      }
    } catch {
      // 网络错误，标记为离线
      this.state.status = 'offline';
    }

    return result;
  }

  /**
   * 上传文件到云端
   */
  private async uploadFile(meta: SyncItemMeta): Promise<number> {
    const localPath = path.join(OPENAIDE_DIR, meta.relativePath);
    let content = await fs.readFile(localPath, 'utf-8');

    // 可选加密
    if (this.config.enableEncryption && this.config.encryptionKey) {
      content = this.encrypt(content);
    }

    const payload = JSON.stringify({
      id: meta.id,
      type: meta.type,
      relativePath: meta.relativePath,
      content,
      contentHash: meta.contentHash,
      version: meta.version,
      encrypted: this.config.enableEncryption,
    });

    const response = await this.apiRequest('PUT', `/files/${encodeURIComponent(meta.id)}`, payload);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`上传失败 (${response.status}): ${errorText}`);
    }

    return Buffer.byteLength(payload, 'utf-8');
  }

  /**
   * 从云端下载文件
   */
  private async downloadFile(meta: SyncItemMeta): Promise<number> {
    const response = await this.apiRequest('GET', `/files/${encodeURIComponent(meta.id)}`);

    if (!response.ok) {
      throw new Error(`下载失败 (${response.status})`);
    }

    const data = await response.json() as { content: string; encrypted: boolean };
    let content = data.content;

    // 解密
    if (data.encrypted && this.config.encryptionKey) {
      content = this.decrypt(content);
    }

    const localPath = path.join(OPENAIDE_DIR, meta.relativePath);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, content, 'utf-8');

    return Buffer.byteLength(content, 'utf-8');
  }

  /**
   * 执行单个同步操作
   */
  private async executeOperation(op: SyncOperation): Promise<void> {
    switch (op.action) {
      case 'create':
      case 'update': {
        const localPath = path.join(OPENAIDE_DIR, op.relativePath);
        let content: string;

        if (op.content) {
          content = op.content;
        } else {
          content = await fs.readFile(localPath, 'utf-8');
        }

        if (this.config.enableEncryption && this.config.encryptionKey) {
          content = this.encrypt(content);
        }

        const payload = JSON.stringify({
          type: op.type,
          relativePath: op.relativePath,
          content,
          contentHash: op.contentHash || crypto.createHash('sha256').update(content).digest('hex'),
          encrypted: this.config.enableEncryption,
        });

        const response = await this.apiRequest('PUT', `/files/${encodeURIComponent(this.filePathToId(op.relativePath))}`, payload);
        if (!response.ok) {
          throw new Error(`操作失败 (${response.status})`);
        }
        break;
      }
      case 'delete': {
        const response = await this.apiRequest('DELETE', `/files/${encodeURIComponent(this.filePathToId(op.relativePath))}`);
        if (!response.ok && response.status !== 404) {
          throw new Error(`删除失败 (${response.status})`);
        }
        break;
      }
    }
  }

  /**
   * 发送 API 请求（带重试）
   */
  private async apiRequest(
    method: string,
    endpoint: string,
    body?: string,
  ): Promise<Response> {
    const url = `${this.config.apiBase}${endpoint}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.config.authToken}`,
      'Content-Type': 'application/json',
      'X-Client-Version': '1.0.0',
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          method,
          headers,
          body: method !== 'GET' ? body : undefined,
          signal: AbortSignal.timeout(30000), // 30 秒超时
        });

        // 429 Too Many Requests — 等待后重试
        if (response.status === 429) {
          const retryAfter = parseInt(response.headers.get('Retry-After') || '5', 10);
          await this.sleep(retryAfter * 1000);
          continue;
        }

        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // 指数退避重试
        if (attempt < MAX_RETRIES - 1) {
          await this.sleep(RETRY_BASE_DELAY * Math.pow(2, attempt));
        }
      }
    }

    throw lastError || new Error('请求失败');
  }

  // ─── 内部方法：加密 ───

  /**
   * AES-256-GCM 加密
   */
  private encrypt(plaintext: string): string {
    const key = crypto.scryptSync(this.config.encryptionKey, 'openaide-sync-salt', 32);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let encrypted = cipher.update(plaintext, 'utf-8', 'base64');
    encrypted += cipher.final('base64');

    const authTag = cipher.getAuthTag();

    // 格式: iv:authTag:ciphertext (均为 base64)
    return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
  }

  /**
   * AES-256-GCM 解密
   */
  private decrypt(ciphertext: string): string {
    const parts = ciphertext.split(':');
    if (parts.length !== 3) {
      throw new Error('无效的加密数据格式');
    }

    const [ivB64, authTagB64, encryptedB64] = parts as [string, string, string];
    const key = crypto.scryptSync(this.config.encryptionKey, 'openaide-sync-salt', 32);
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const encrypted = Buffer.from(encryptedB64, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString('utf-8');
  }

  // ─── 内部方法：自动同步 ───

  /**
   * 启动自动同步定时器
   */
  private startAutoSync(): void {
    this.stopAutoSync();
    this.autoSyncTimer = setInterval(() => {
      if (!this.isSyncing && this.state.enabled) {
        this.sync().catch(() => {});
      }
    }, this.config.autoSyncInterval);
  }

  /**
   * 停止自动同步
   */
  private stopAutoSync(): void {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  // ─── 内部方法：持久化 ───

  private async loadState(): Promise<void> {
    try {
      const data = await fs.readFile(path.join(SYNC_DIR, SYNC_STATE_FILE), 'utf-8');
      this.state = JSON.parse(data);
    } catch {
      this.state = this.getDefaultState();
    }
  }

  private async saveState(): Promise<void> {
    await fs.writeFile(
      path.join(SYNC_DIR, SYNC_STATE_FILE),
      JSON.stringify(this.state, null, 2),
      'utf-8',
    );
  }

  private async loadQueue(): Promise<void> {
    try {
      const data = await fs.readFile(path.join(SYNC_DIR, SYNC_QUEUE_FILE), 'utf-8');
      this.queue = JSON.parse(data);
    } catch {
      this.queue = [];
    }
  }

  private async saveQueue(): Promise<void> {
    await fs.writeFile(
      path.join(SYNC_DIR, SYNC_QUEUE_FILE),
      JSON.stringify(this.queue, null, 2),
      'utf-8',
    );
  }

  private async loadLogs(): Promise<void> {
    try {
      const data = await fs.readFile(path.join(SYNC_DIR, SYNC_LOG_FILE), 'utf-8');
      this.logs = JSON.parse(data);
    } catch {
      this.logs = [];
    }
  }

  private async saveLogs(): Promise<void> {
    await fs.writeFile(
      path.join(SYNC_DIR, SYNC_LOG_FILE),
      JSON.stringify(this.logs, null, 2),
      'utf-8',
    );
  }

  // ─── 内部方法：工具函数 ───

  private addLog(entry: SyncLogEntry): void {
    this.logs.push(entry);
    if (this.logs.length > MAX_LOG_ENTRIES) {
      this.logs = this.logs.slice(-MAX_LOG_ENTRIES);
    }
  }

  private emitProgress(event: SyncProgressEvent): void {
    for (const listener of this.progressListeners) {
      try {
        listener(event);
      } catch {
        // 忽略监听器错误
      }
    }
  }

  private filePathToId(relativePath: string): string {
    return crypto.createHash('md5').update(relativePath).digest('hex').substring(0, 16);
  }

  private isExcluded(relativePath: string): boolean {
    const filename = path.basename(relativePath);
    return this.config.excludePatterns.some((pattern) => {
      if (pattern.startsWith('*')) {
        return filename.endsWith(pattern.substring(1));
      }
      return filename === pattern || relativePath.includes(pattern);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getDefaultState(): SyncState {
    return {
      enabled: false,
      status: 'idle',
      items: {},
      conflicts: [],
      stats: {
        totalUploads: 0,
        totalDownloads: 0,
        totalConflicts: 0,
        totalErrors: 0,
      },
    };
  }
}
