# OpenAIDE

> OpenAIDE —— 基于 VSCodium 的 AI 原生 IDE 

**OpenAIDE** 是一款基于 VSCodium 深度定制的 AI 编程 IDE，将 LLM Agent 能力原生融入编辑器，提供代码生成、智能重构、多文件编辑、上下文管理等一站式 AI 编程体验。

核心 AI 引擎从 Claude Code 源码改造而来，将 CLI 的 Agent 能力以原生 UI 形态融入 IDE。

## 🌐 官网

- 域名：[openaide.io](https://openaide.io)

## ✨ 核心特性

- **AI 对话面板** — 侧边栏原生 Chat UI，支持多轮对话、会话历史、上下文管理
- **多模型支持** — Anthropic (Claude)、OpenAI、DeepSeek、通义千问、智谱 GLM、Ollama 本地模型，以及自定义 OpenAI 兼容端点
- **智能代码编辑** — Inline Diff 预览、多文件变更审查、一键接受/拒绝
- **AI 代码补全** — 基于 LLM 的智能代码补全
- **工具系统** — 文件读写、Bash 执行、Glob/Grep 搜索、Web 搜索与抓取、Sub-Agent 等
- **MCP 协议** — 标准化工具扩展，内置 MCP 服务器市场
- **记忆系统** — 项目级 (.openaide.md) 与全局记忆，自动提取与管理
- **上下文压缩** — 智能上下文管理与压缩策略，优化 Token 使用
- **权限管理** — 工具执行权限控制，安全可控
- **云端同步** — 配置与会话云端同步
- **自动更新** — 内置更新检查与自动升级
- **右键菜单集成** — 选中代码即可询问、解释、重构

## 🏗️ 技术架构

```
┌─────────────────────────────────────────────────────┐
│                  OpenAIDE IDE (VSCodium)             │
│  ┌────────────────┐  ┌────────────────┐             │
│  │   编辑器核心     │  │  AI 侧边栏      │             │
│  │   (Monaco)      │  │  (Chat Panel)  │             │
│  └───────┬────────┘  └───────┬────────┘             │
│          └──────────┬────────┘                      │
│              ┌──────▼──────┐                        │
│              │  Bridge 层   │ ← JSON-RPC/IPC 双向通信│
│              └──────┬──────┘                        │
│              ┌──────▼──────┐                        │
│              │  Agent Core  │ ← Claude Code 引擎改造 │
│              │  ├ 工具系统   │   文件/Bash/搜索/Web   │
│              │  ├ Prompt 引擎│   系统提示词管理       │
│              │  ├ 上下文管理 │   智能压缩策略         │
│              │  ├ 记忆系统   │   项目/全局记忆        │
│              │  ├ MCP 协议   │   标准化工具扩展       │
│              │  ├ 权限系统   │   工具执行权限控制     │
│              │  └ 会话管理   │   多会话/历史记录      │
│              └──────┬──────┘                        │
│              ┌──────▼──────┐                        │
│              │  LLM Router  │ ← 多模型支持           │
│              │  ├ Anthropic │   Claude 系列          │
│              │  ├ OpenAI    │   GPT 系列             │
│              │  ├ DeepSeek  │                        │
│              │  ├ Qwen      │   通义千问             │
│              │  ├ GLM       │   智谱                 │
│              │  ├ Ollama    │   本地模型             │
│              │  └ Custom    │   自定义端点           │
│              └─────────────┘                        │
└─────────────────────────────────────────────────────┘
```

## 📁 项目结构

```
openaide/
├── .openaide.md                  # 项目级 AI 配置文件
├── README.md
├── package.json                  # Monorepo 根配置 (pnpm + Turborepo)
├── pnpm-workspace.yaml
├── turbo.json                    # Turborepo 任务编排
├── tsconfig.base.json            # TypeScript 基础配置
├── eslint.config.mjs             # ESLint 配置
├── assets/
│   └── logo.svg                  # 项目 Logo
├── packages/
│   ├── core/                     # 🧠 Agent 核心引擎（从 Claude Code 改造）
│   │   └── src/
│   │       ├── agent/            # Agent 核心循环（Engine + Coordinator）
│   │       ├── tools/            # 工具系统（文件读写/Bash/Glob/Grep/Web 等）
│   │       ├── prompts/          # 系统提示词
│   │       ├── context/          # 上下文管理 + 压缩
│   │       ├── mcp/              # MCP 协议（Client + Marketplace）
│   │       ├── memory/           # 记忆系统
│   │       ├── llm/              # LLM Provider（Anthropic / OpenAI 兼容）
│   │       ├── auth/             # 认证服务
│   │       ├── session/          # 会话管理
│   │       ├── permissions/      # 权限管理
│   │       ├── sync/             # 云端同步
│   │       ├── updater/          # 自动更新
│   │       ├── bridge-server.ts  # Bridge 服务端（IPC 通信）
│   │       └── cli.ts            # CLI 入口
│   ├── extension/                # 🖥️ VS Code Extension
│   │   └── src/
│   │       ├── chat/             # AI 聊天面板 + 设置面板
│   │       ├── diff/             # Inline Diff + 多文件变更审查
│   │       ├── completion/       # 代码补全 Provider
│   │       ├── bridge/           # 与 Agent Core 的 IPC 桥接
│   │       ├── mcp/              # MCP 管理面板 + 市场
│   │       ├── memory/           # 记忆管理面板
│   │       ├── updater/          # 更新管理
│   │       └── extension.ts      # Extension 入口
│   ├── ide/                      # 🎨 VSCodium 品牌定制层
│   │   ├── product.json          # 品牌配置
│   │   ├── build.sh              # IDE 构建脚本
│   │   └── resources/            # 图标资源
│   ├── shared/                   # 📡 共享类型和协议
│   │   └── src/
│   │       └── protocol.ts       # Bridge 通信协议
│   ├── docs/                     # 📖 文档站点（VitePress）
│   │   ├── guide/                # 使用指南
│   │   ├── api/                  # API 文档
│   │   └── tools/                # 工具文档
│   └── e2e/                      # 🧪 端到端测试（Playwright）
│       └── tests/
│           ├── chat/             # 聊天面板测试
│           ├── extension/        # Extension 激活测试
│           ├── mcp/              # MCP 面板测试
│           └── tools/            # 工具系统测试
```

## 🚀 快速开始

### 环境要求

- Node.js >= 20.0.0
- pnpm >= 9.0.0

### 安装与开发

```bash
# 安装依赖
pnpm install

# 开发模式（核心引擎）
pnpm dev:core

# 开发模式（Extension）
pnpm dev:extension

# 构建全部
pnpm build

# 构建核心引擎
pnpm build:core

# 构建 Extension
pnpm build:extension

# 文档站点开发
pnpm docs:dev

# 运行测试
pnpm test

# 代码检查
pnpm lint

# 代码格式化
pnpm format
```

## � 支持的模型

| Provider | 模型 | 说明 |
|----------|------|------|
| Anthropic | Claude 系列 | 默认 Provider |
| OpenAI | GPT 系列 | |
| DeepSeek | DeepSeek 系列 | |
| Qwen | 通义千问 | DashScope API |
| GLM | 智谱 GLM | |
| Ollama | 本地模型 | 本地部署 |
| Custom | 自定义 | 兼容 OpenAI API 的任意端点 |

## 📄 License

MIT
