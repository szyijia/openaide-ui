# 什么是openAIDE

openAIDE（OpenAIDE）是一款**基于 VSCodium 的 AI 原生 IDE**，将完整的 AI Agent 能力深度融入桌面开发环境。

## 核心理念

传统的 AI 编程助手以插件形态存在，受限于宿主 IDE 的 API 能力。openAIDE采用不同的路径——直接定制 IDE 本身，让 AI 成为 IDE 的一等公民。

```
┌─────────────────────────────────────────┐
│              openAIDE IDE                     │
│                                         │
│  ┌──────────────┐  ┌─────────────────┐  │
│  │  VSCodium    │  │  AI Agent Core  │  │
│  │  编辑器       │  │  ├ 40+ 工具     │  │
│  │  ├ Monaco    │  │  ├ 多模型路由    │  │
│  │  ├ Terminal  │  │  ├ MCP 协议     │  │
│  │  ├ File Tree │  │  ├ 记忆系统     │  │
│  │  └ Webview   │  │  └ Multi-Agent  │  │
│  └──────────────┘  └─────────────────┘  │
└─────────────────────────────────────────┘
```

## 主要特性

### 🤖 完整的 AI Agent 能力

openAIDE内置 40+ 工具，AI 可以：
- 读写文件、搜索代码、执行命令
- 浏览网页、调用 API
- 创建子 Agent 处理复杂任务
- 通过 MCP 协议扩展能力

### 🧠 智能记忆系统

三层记忆架构：
- **项目记忆** — `.openaide.md` 文件，存储项目特定的指令和偏好
- **全局记忆** — `~/.openaide/memory/`，跨项目的长期记忆
- **会话记忆** — 当前对话中自动提取的临时记忆

### 🔀 Multi-Agent 协作

两种协作模式：
- **Coordinator 模式** — 一个主 Agent 协调多个子 Agent
- **Team 模式** — 多个平级 Agent 协作完成任务

### 🌐 多模型智能路由

内置模型路由器，根据任务类型自动选择最优模型：
- 简单任务 → 快速模型（DeepSeek、GLM）
- 复杂任务 → 强力模型（Claude、GPT-4）
- 支持预算控制和用量统计

### 🔌 MCP 协议

完整实现 Model Context Protocol：
- 内置 MCP Marketplace，一键安装服务器
- 支持工具、资源、Prompt 三种能力
- 可视化管理面板

### 🔒 开源安全

- 基于 MIT 许可的 VSCodium
- 代码完全开源
- 支持本地模型（Ollama）
- 端到端加密的云同步（可选）

## 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| IDE 基座 | VSCodium | MIT 许可的 VS Code |
| 插件 | VS Code Extension API | TypeScript + Webview |
| Agent 引擎 | Node.js | TypeScript |
| 前端 UI | React + Tailwind CSS | Webview Chat UI |
| 协议 | MCP SDK + LSP | 标准协议 |
| 构建 | pnpm + Turborepo | Monorepo |
| 测试 | Vitest + Playwright | 单元 + E2E |

## 下一步

- [快速开始](/guide/getting-started) — 5 分钟上手openAIDE
- [安装指南](/guide/installation) — 各平台安装说明
- [API 参考](/api/core-engine) — 核心引擎 API 文档
