# 记忆管理 API

记忆管理器（`MemoryManager`）实现了openAIDE的三层记忆架构，支持自动提取、持久化存储和智能检索。

## 概述

```typescript
import { MemoryManager } from '@openaide/core';

const memory = new MemoryManager({
  projectCwd: '/path/to/project',
});

// 加载所有记忆
const allMemories = await memory.loadAll();

// 搜索相关记忆
const relevant = await memory.findRelevant('React 组件规范');

// 添加记忆
await memory.saveWithIndex({
  title: 'React 组件规范',
  description: '项目中 React 组件的编写规范',
  content: '使用函数式组件和 Hooks，禁止使用 class 组件。',
  type: 'project',
  source: 'project',
});
```

## 三层记忆架构

```
┌─────────────────────────────────────────┐
│              记忆系统                     │
│                                         │
│  ┌─────────────┐  存储: ~/.openaide/     │
│  │  全局记忆    │  memory/              │
│  │  (Global)   │  跨项目持久化           │
│  └─────────────┘                        │
│                                         │
│  ┌─────────────┐  存储: ~/.openaide/     │
│  │  项目记忆    │  projects/<hash>/     │
│  │  (Project)  │  memory/              │
│  └─────────────┘  项目级持久化           │
│                                         │
│  ┌─────────────┐                        │
│  │  会话记忆    │  仅存在内存中           │
│  │  (Session)  │  会话结束后清除         │
│  └─────────────┘                        │
└─────────────────────────────────────────┘
```

## 记忆类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `user` | 用户偏好和习惯 | "我习惯用 Vim 键位" |
| `feedback` | 用户反馈和纠正 | "不要使用 any 类型" |
| `project` | 项目相关信息 | "这个项目使用 pnpm" |
| `reference` | 参考资料和文档 | "API 文档链接: ..." |

## MemoryManager

### 构造函数

```typescript
const memory = new MemoryManager({
  /** 全局记忆目录（默认 ~/.openaide/memory/） */
  globalMemoryDir?: string;
  /** 项目工作目录（用于计算项目记忆路径） */
  projectCwd?: string;
});
```

### 加载记忆

#### `loadAll(): Promise<Memory[]>`

加载所有记忆（全局 + 项目 + 会话）。

```typescript
const memories = await memory.loadAll();
for (const m of memories) {
  console.log(`[${m.source}/${m.type}] ${m.title}: ${m.description}`);
}
```

#### `loadEntrypoint(source?): Promise<string | null>`

加载 MEMORY.md 入口文件内容。

```typescript
const projectIndex = await memory.loadEntrypoint('project');
const globalIndex = await memory.loadEntrypoint('global');
```

#### `scanMemoryDir(dir, source): Promise<Memory[]>`

扫描指定目录的记忆文件。

```typescript
const memories = await memory.scanMemoryDir('/path/to/memory', 'project');
```

### 写入记忆

#### `add(memory): Promise<Memory>`

添加一条记忆。

```typescript
const saved = await memory.add({
  title: '代码风格偏好',
  description: '用户偏好的代码风格',
  content: '使用 2 空格缩进，单引号，无分号。',
  type: 'user',
  source: 'global', // 'global' | 'project' | 'session'
});
```

#### `saveWithIndex(memory): Promise<Memory>`

添加记忆并自动更新 MEMORY.md 索引（推荐方式）。

```typescript
const saved = await memory.saveWithIndex({
  title: 'API 接口规范',
  description: 'RESTful API 设计规范',
  content: '所有 API 使用 JSON 格式，错误码遵循 HTTP 标准。',
  type: 'project',
  source: 'project',
});
```

#### `update(id, updates): Promise<Memory | null>`

更新已有记忆。

```typescript
const updated = await memory.update('memory-id', {
  title: '更新后的标题',
  content: '更新后的内容',
  tags: ['react', 'typescript'],
});
```

#### `delete(id): Promise<boolean>`

删除记忆。

```typescript
const success = await memory.delete('memory-id');
```

### 搜索记忆

#### `findRelevant(query, limit?): Promise<Memory[]>`

基于关键词搜索相关记忆。

```typescript
const results = await memory.findRelevant('React 组件', 5);
for (const m of results) {
  console.log(`${m.title} (${m.source})`);
}
```

搜索算法：
- 标题匹配权重 ×3
- 描述匹配权重 ×2
- 标签匹配权重 ×2
- 内容匹配权重 ×1
- 完整查询匹配额外 +5
- 7 天内更新的记忆额外加分

#### `getMemorySummary(): Promise<string | null>`

获取记忆摘要（用于嵌入 System Prompt）。

```typescript
const summary = await memory.getMemorySummary();
if (summary) {
  systemPrompt += `\n\n## 记忆\n${summary}`;
}
```

### 会话记忆

#### `getSessionMemories(): Memory[]`

获取当前会话的所有记忆。

```typescript
const sessionMems = memory.getSessionMemories();
```

#### `clearSessionMemories(): void`

清空会话记忆。

```typescript
memory.clearSessionMemories();
```

### MEMORY.md 管理

#### `addToEntrypoint(entry, source?): Promise<void>`

向 MEMORY.md 索引文件添加条目。

```typescript
await memory.addToEntrypoint(
  '- [API规范](./api-spec-abc123.md) — RESTful API 设计规范',
  'project',
);
```

## Memory 数据结构

```typescript
interface Memory {
  /** 唯一 ID */
  id: string;
  /** 标题 */
  title: string;
  /** 描述 */
  description: string;
  /** 内容 */
  content: string;
  /** 记忆类型 */
  type: MemoryType; // 'user' | 'feedback' | 'project' | 'reference'
  /** 记忆来源 */
  source: MemorySource; // 'global' | 'project' | 'session'
  /** 创建时间 */
  createdAt: Date;
  /** 更新时间 */
  updatedAt: Date;
  /** 标签 */
  tags?: string[];
  /** 文件路径（持久化记忆） */
  filePath?: string;
}
```

## 记忆文件格式

记忆以 Markdown 文件存储，使用 YAML frontmatter：

```markdown
---
name: React 组件规范
description: 项目中 React 组件的编写规范
type: project
tags:
  - react
  - typescript
  - component
---

## 组件规范

1. 使用函数式组件和 Hooks
2. Props 必须定义 TypeScript 接口
3. 组件文件使用 PascalCase 命名
```

## 相关文档

- [记忆系统指南](/guide/memory)
- [.openaide.md 配置](/guide/openaide-md)
