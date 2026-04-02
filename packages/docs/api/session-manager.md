# 会话管理 API

会话管理器（`SessionManager`）负责管理 AI 对话会话的完整生命周期。

## 概述

```typescript
import { SessionManager } from '@openaide/core';

const sm = new SessionManager({
  projectCwd: '/path/to/project',
});

// 创建新会话
const session = await sm.create('claude-sonnet-4-20250514');

// 更新消息
await sm.updateMessages(session.id, [
  { role: 'user', content: '你好' },
  { role: 'assistant', content: '你好！有什么可以帮你的？' },
]);

// 列出所有会话
const sessions = await sm.list();
```

## 存储位置

会话数据按项目隔离存储：

```
~/.openaide/sessions/<project-hash>/
├── session-abc123.json
├── session-def456.json
└── session-ghi789.json
```

项目哈希基于工作目录路径的 MD5 前 12 位生成。

## SessionManager

### 构造函数

```typescript
const sm = new SessionManager({
  /** 项目工作目录（用于计算存储路径） */
  projectCwd?: string;
});
```

### 方法

#### `create(model?): Promise<SessionData>`

创建新会话。

```typescript
const session = await sm.create('claude-sonnet-4-20250514');
console.log(session.id);    // 'session-m1abc-12345678'
console.log(session.title); // '新对话'
```

#### `load(sessionId): Promise<SessionData | null>`

加载指定会话（包含完整消息历史）。

```typescript
const session = await sm.load('session-m1abc-12345678');
if (session) {
  console.log(`消息数: ${session.messageCount}`);
  console.log(`模型: ${session.model}`);
}
```

#### `save(session): Promise<void>`

保存会话到磁盘。

```typescript
session.title = '重构讨论';
await sm.save(session);
```

#### `switchTo(sessionId): Promise<SessionData | null>`

切换到指定会话。

```typescript
const session = await sm.switchTo('session-m1abc-12345678');
```

#### `getCurrentSessionId(): string | null`

获取当前活跃会话的 ID。

```typescript
const currentId = sm.getCurrentSessionId();
```

#### `updateMessages(sessionId, messages): Promise<void>`

更新会话的消息列表。自动更新消息计数和时间戳，并从第一条用户消息自动生成标题。

```typescript
await sm.updateMessages(session.id, [
  { role: 'user', content: '帮我写一个 React 登录组件' },
  { role: 'assistant', content: '好的，我来帮你创建一个登录组件...' },
]);

// 标题会自动变为 "帮我写一个 React 登录组件"
```

#### `updateUsage(sessionId, usage): Promise<void>`

更新会话的用量信息。

```typescript
await sm.updateUsage(session.id, {
  totalTokens: 15000,
  totalCostUSD: 0.045,
  model: 'claude-sonnet-4-20250514',
});
```

#### `list(): Promise<SessionListItem[]>`

列出所有会话（按更新时间倒序），不包含消息内容。

```typescript
interface SessionListItem {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  model?: string;
  totalTokens?: number;
  totalCostUSD?: number;
}

const sessions = await sm.list();
for (const s of sessions) {
  console.log(`${s.title} (${s.messageCount} 条消息, $${s.totalCostUSD?.toFixed(4)})`);
}
```

#### `delete(sessionId): Promise<boolean>`

删除指定会话。

```typescript
const success = await sm.delete('session-m1abc-12345678');
```

#### `cleanup(keepCount?): Promise<number>`

清理旧会话，保留最近 N 个（默认 50）。

```typescript
const deleted = await sm.cleanup(30);
console.log(`清理了 ${deleted} 个旧会话`);
```

## 数据结构

### SessionData

```typescript
interface SessionData {
  /** 会话 ID */
  id: string;
  /** 会话标题 */
  title: string;
  /** 创建时间 (ISO 8601) */
  createdAt: string;
  /** 最后更新时间 */
  updatedAt: string;
  /** 消息数量 */
  messageCount: number;
  /** 使用的模型 */
  model?: string;
  /** 消息列表 */
  messages: ChatMessage[];
  /** 总 Token 数 */
  totalTokens?: number;
  /** 总费用 (USD) */
  totalCostUSD?: number;
}
```

### ChatMessage

```typescript
interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}
```

## 自动标题生成

当会话标题为默认值"新对话"时，`updateMessages` 会自动从第一条用户消息提取标题：

- 截取前 50 个字符
- 移除换行符
- 超长时添加 `...` 后缀

## 相关文档

- [AI 对话指南](/guide/ai-chat)
- [云同步 API](/api/cloud-sync)（会话历史同步）
