# 云同步 API

云同步服务（`CloudSyncService`）支持将本地数据同步到云端，包括配置、记忆、会话历史等。

## 概述

```typescript
import { CloudSyncService } from '@openaide/core';

const sync = new CloudSyncService({
  authToken: 'your-auth-token',
  conflictStrategy: 'newest-wins',
  enableEncryption: true,
  encryptionKey: 'your-secret-key',
});

await sync.init();
await sync.setEnabled(true);

// 执行同步
const result = await sync.sync();
console.log(`上传: ${result.uploaded}, 下载: ${result.downloaded}`);
```

## 同步架构

```
┌──────────────┐                    ┌──────────────┐
│   本地设备 A  │                    │   本地设备 B  │
│              │                    │              │
│  ~/.openaide/ │    ┌──────────┐    │  ~/.openaide/ │
│  ├ config/   │◄──►│  云端 API │◄──►│  ├ config/   │
│  ├ memory/   │    │          │    │  ├ memory/   │
│  ├ sessions/ │    │  增量同步  │    │  ├ sessions/ │
│  └ snippets/ │    │  E2E 加密 │    │  └ snippets/ │
└──────────────┘    └──────────┘    └──────────────┘
```

## 可同步的数据类型

| 类型 | 说明 | 文件位置 |
|------|------|---------|
| `config` | IDE 配置 | `~/.openaide/config/*.json` |
| `memory` | 全局记忆 | `~/.openaide/memory/*.md` |
| `session` | 会话历史 | `~/.openaide/sessions/*.json` |
| `keybinding` | 快捷键 | `~/.openaide/config/keybindings.json` |
| `snippet` | 代码片段 | `~/.openaide/snippets/*` |
| `extension` | 扩展列表 | `~/.openaide/config/extensions.json` |

## CloudSyncService

### 构造函数

```typescript
interface CloudSyncConfig {
  /** API 基础 URL */
  apiBase?: string;
  /** 认证 Token */
  authToken?: string;
  /** 同步方向 */
  direction?: 'upload' | 'download' | 'bidirectional';
  /** 冲突解决策略 */
  conflictStrategy?: 'local-wins' | 'remote-wins' | 'newest-wins' | 'manual';
  /** 启用端到端加密 */
  enableEncryption?: boolean;
  /** 加密密钥 */
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

const sync = new CloudSyncService({
  authToken: 'token',
  direction: 'bidirectional',
  conflictStrategy: 'newest-wins',
  enableEncryption: true,
  encryptionKey: 'my-secret',
  autoSyncInterval: 300000, // 5 分钟
  syncTypes: ['config', 'memory', 'keybinding', 'snippet'],
});
```

### 初始化和销毁

#### `init(): Promise<void>`

初始化服务，加载持久化状态和离线队列。

```typescript
await sync.init();
```

#### `destroy(): void`

销毁服务，停止自动同步。

```typescript
sync.destroy();
```

### 同步控制

#### `setEnabled(enabled): Promise<void>`

启用/禁用同步。

```typescript
await sync.setEnabled(true);
```

#### `isEnabled(): boolean`

#### `getStatus(): SyncStatus`

```typescript
type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline' | 'conflict';
```

#### `getState(): SyncState`

获取完整同步状态。

```typescript
interface SyncState {
  enabled: boolean;
  lastSyncAt?: string;
  lastSuccessAt?: string;
  status: SyncStatus;
  items: Record<string, SyncItemMeta>;
  conflicts: SyncConflict[];
  stats: {
    totalUploads: number;
    totalDownloads: number;
    totalConflicts: number;
    totalErrors: number;
    lastErrorMessage?: string;
  };
}
```

### 核心同步

#### `sync(): Promise<SyncResult>`

执行完整双向同步。

```typescript
interface SyncResult {
  success: boolean;
  uploaded: number;
  downloaded: number;
  deleted: number;
  conflicts: number;
  errors: number;
  duration: number;        // ms
  bytesTransferred: number;
  errorDetails?: string[];
}

const result = await sync.sync();
if (result.success) {
  console.log(`同步完成: ↑${result.uploaded} ↓${result.downloaded} (${result.duration}ms)`);
} else {
  console.error('同步失败:', result.errorDetails);
}
```

同步流程：
1. 处理离线队列中的待处理操作
2. 扫描本地文件，计算 SHA-256 哈希
3. 获取远端文件列表
4. 比较差异（基于哈希和版本号）
5. 解决冲突
6. 执行上传/下载
7. 更新本地状态

#### `push(): Promise<SyncResult>`

仅上传本地变更到云端。

```typescript
const result = await sync.push();
```

#### `pull(): Promise<SyncResult>`

仅下载云端变更到本地。

```typescript
const result = await sync.pull();
```

### 离线队列

当网络不可用时，操作会被缓存到离线队列中。

#### `enqueue(operation): Promise<void>`

手动将操作加入队列。

```typescript
await sync.enqueue({
  action: 'update',
  type: 'config',
  relativePath: 'config/settings.json',
});
```

#### `processQueue(): Promise<{ processed: number; failed: number }>`

处理离线队列。

```typescript
const { processed, failed } = await sync.processQueue();
```

#### `getQueueLength(): number`

获取队列长度。

### 冲突管理

#### `getConflicts(): SyncConflict[]`

获取未解决的冲突列表。

```typescript
interface SyncConflict {
  itemId: string;
  type: SyncDataType;
  relativePath: string;
  local: { contentHash: string; modifiedAt: string; version: number };
  remote: { contentHash: string; modifiedAt: string; version: number };
  detectedAt: string;
  resolved: boolean;
  resolution?: 'keep-local' | 'keep-remote' | 'merged';
}

const conflicts = sync.getConflicts();
```

#### `resolveConflictManually(itemId, resolution): Promise<boolean>`

手动解决冲突。

```typescript
await sync.resolveConflictManually('item-id', 'keep-local');
// 或
await sync.resolveConflictManually('item-id', 'keep-remote');
```

### 冲突解决策略

| 策略 | 说明 |
|------|------|
| `local-wins` | 始终保留本地版本 |
| `remote-wins` | 始终保留远端版本 |
| `newest-wins` | 保留最新修改的版本（默认） |
| `manual` | 所有冲突都需要手动解决 |

### 进度监听

#### `onProgress(listener): () => void`

注册同步进度监听器，返回取消函数。

```typescript
interface SyncProgressEvent {
  phase: 'preparing' | 'uploading' | 'downloading' | 'resolving' | 'complete' | 'error';
  progress: number;       // 0-100
  currentFile?: string;
  totalFiles: number;
  processedFiles: number;
  bytesTransferred: number;
  error?: string;
}

const unsubscribe = sync.onProgress((event) => {
  console.log(`[${event.phase}] ${event.progress}% - ${event.currentFile || ''}`);
});

// 取消监听
unsubscribe();
```

### 同步日志

#### `getLogs(limit?): SyncLogEntry[]`

获取同步日志。

```typescript
interface SyncLogEntry {
  timestamp: string;
  direction: 'upload' | 'download';
  type: SyncDataType;
  relativePath: string;
  action: 'create' | 'update' | 'delete';
  success: boolean;
  size?: number;
  error?: string;
}

const logs = sync.getLogs(20);
```

#### `clearLogs(): Promise<void>`

### 数据导出/导入

#### `exportData()`

导出所有同步数据为 JSON（手动备份）。

```typescript
const data = await sync.exportData();
// { exportedAt, dataTypes, files: [...] }
```

#### `importData(data)`

从导出数据中导入。

```typescript
const { imported, errors } = await sync.importData(data);
```

#### `reset(): Promise<void>`

重置同步状态（不删除本地数据）。

## 端到端加密

启用加密后，所有上传的数据使用 **AES-256-GCM** 加密：

- 加密密钥通过 `scrypt` 从用户提供的密码派生
- 每个文件使用独立的随机 IV
- 包含 GCM 认证标签，防止篡改
- 云端只存储密文，服务器无法解密

```typescript
const sync = new CloudSyncService({
  enableEncryption: true,
  encryptionKey: 'my-strong-password',
});
```

::: warning 注意
加密密钥丢失将导致云端数据无法恢复。请妥善保管你的加密密钥。
:::

## 持久化文件

```
~/.openaide/sync/
├── sync-state.json   # 同步状态（已同步项、冲突列表、统计）
├── sync-queue.json   # 离线操作队列
└── sync-log.json     # 同步日志
```

## 相关文档

- [云同步指南](/guide/cloud-sync)
- [认证服务 API](/api/auth-service)
