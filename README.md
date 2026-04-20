# OpenAIDE

> OpenAIDE —— 基于 VSCodium 的 AI 原生 IDE 

**OpenAIDE** 是一款基于 VSCodium 深度定制的 AI 编程 IDE，将 LLM Agent 能力原生融入编辑器，提供代码生成、智能重构、多文件编辑、上下文管理等一站式 AI 编程体验。

核心 AI 引擎从 Claude Code 源码改造而来，将 CLI 的 Agent 能力以原生 UI 形态融入 IDE。

## 🌐 官网

- 域名：[openaide.io](https://openaide.io)
- 文档：[openaide.io/docs](https://openaide.io/docs)（VitePress）

## 📚 相关文档

| 文档 | 说明 |
|------|------|
| [docs/architecture.md](docs/architecture.md) | 架构设计文档 |
| [docs/bridge-protocol-spec.md](docs/bridge-protocol-spec.md) | Bridge 协议规范 |
| [docs/core-migration-plan.md](docs/core-migration-plan.md) | Core 迁移计划 |
| [docs/core-legal-risk-analysis.md](docs/core-legal-risk-analysis.md) | Core 法律风险分析 |
| [docs/core-go-refactor-feasibility.md](docs/core-go-refactor-feasibility.md) | Go 重构可行性分析 |
| [docs/webview-template-string-escape-pitfall.md](docs/webview-template-string-escape-pitfall.md) | WebView 模板转义陷阱 |
| [scripts/ICONS.md](scripts/ICONS.md) | 图标生成说明 |

## ✨ 核心特性

- **AI 对话面板** — 侧边栏原生 Chat UI，支持多轮对话、会话历史、上下文管理
- **多模型支持** — Anthropic (Claude)、OpenAI、DeepSeek、通义千问、智谱 GLM、Ollama 本地模型，以及自定义 OpenAI 兼容端点
- **双引擎架构** — TypeScript 引擎（claude-code bridge-adapter）+ Rust 引擎（claw-code），可自由切换或自动检测
- **智能代码编辑** — Inline Diff 预览、多文件变更审查、一键接受/拒绝
- **AI 代码补全** — 基于 LLM 的智能代码补全，支持开关切换和延迟配置
- **工具系统** — 文件读写、Bash 执行、Glob/Grep 搜索、Web 搜索与抓取、Sub-Agent 等
- **MCP 协议** — 标准化工具扩展，内置 MCP 服务器市场
- **记忆系统** — 项目级 (.openaide.md) 与全局记忆，自动提取与管理
- **上下文压缩** — 智能上下文管理与压缩策略，优化 Token 使用
- **权限管理** — 工具执行权限控制，安全可控
- **云端同步** — 配置与会话云端同步
- **自动更新** — 内置更新检查与自动升级
- **右键菜单集成** — 选中代码即可询问、解释、重构
- **快捷键** — 新建对话 (Cmd+Shift+D)、询问选中代码 (Cmd+Shift+A)、修复错误 (Cmd+Shift+F)、切换补全 (Cmd+Shift+C)

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
│              │  Bridge 层   │ ← JSON-RPC 2.0 over   │
│              │  (Extension) │   stdio 双向通信        │
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
│              │  └ Custom    │   OpenAI 兼容端点      │
│              └─────────────┘                        │
└─────────────────────────────────────────────────────┘
```

## 📁 项目结构

```
openaide-ui/
├── README.md
├── package.json                  # Monorepo 根配置 (pnpm + Turborepo)
├── pnpm-workspace.yaml
├── turbo.json                    # Turborepo 任务编排
├── tsconfig.base.json            # TypeScript 基础配置
├── eslint.config.mjs             # ESLint 配置
├── scripts/                      # 🔧 开发脚本
│   ├── dev.sh                    # 完整开发环境启动
│   ├── dev-core.sh               # Agent Core 开发模式
│   ├── dev-ts.sh                 # TS 引擎 (claude-code) 开发
│   ├── dev-rust.sh               # Rust 引擎 (claw-code) 开发
│   ├── run-core.sh               # Agent Core 运行入口
│   ├── cli.sh                    # 终端交互式 Agent 对话
│   ├── cli-cc.sh                 # Claude Code CLI 模式
│   ├── build-desktop.sh          # 桌面版构建
│   └── generate-icons.sh         # 图标生成脚本
├── packages/
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
│   ├── protocol/                 # 📡 语言无关的 JSON-RPC 2.0 协议定义
│   │   └── src/
│   │       ├── index.ts          # 协议导出
│   │       └── protocol.ts       # Bridge 通信协议（请求/响应/通知类型）
│   ├── shared/                   # 🔄 共享类型和工具
│   │   └── src/
│   │       ├── index.ts          # 共享导出
│   │       └── protocol.ts       # 协议辅助类型
│   ├── ide/                      # 🎨 VSCodium 品牌定制层
│   │   ├── product.json          # 品牌配置（名称/扩展画廊/主题/默认设置）
│   │   ├── build.sh              # IDE 构建脚本
│   │   ├── patches/              # VSCodium 补丁
│   │   └── resources/            # 图标资源（bmp/png/svg/ico/icns）
│   ├── docs/                     # 📖 文档站点（VitePress）
│   │   ├── guide/                # 使用指南（17 篇）
│   │   ├── api/                  # API 文档（9 篇）
│   │   ├── changelog.md          # 更新日志
│   │   ├── faq.md                # 常见问题
│   │   └── roadmap.md            # 路线图
│   └── e2e/                      # 🧪 端到端测试（Playwright）
│       └── tests/
│           ├── chat/             # 聊天面板测试
│           ├── extension/        # Extension 激活测试
│           ├── mcp/              # MCP 面板测试
│           ├── tools/            # 工具系统测试
│           └── helpers.ts        # 测试辅助工具
```

## 🚀 快速开始

### 环境要求

- Node.js >= 20.0.0
- pnpm >= 9.0.0

### 安装与开发

```bash
# 安装依赖
pnpm install

# 开发模式（Extension）
pnpm dev:extension

# 构建全部
pnpm build

# 构建协议层
pnpm build:protocol

# 构建 Extension
pnpm build:extension

# 构建 IDE
pnpm build:ide

# 文档站点开发
pnpm docs:dev

# 文档站点构建
pnpm docs:build

# 运行测试
pnpm test

# 代码检查
pnpm lint

# 代码格式化
pnpm format
```

### 开发脚本

项目提供了多个开发脚本，位于 `scripts/` 目录下：

| 脚本 | 说明 | 用法 |
|------|------|------|
| `scripts/dev.sh` | 完整开发环境启动 | `./scripts/dev.sh` |
| `scripts/dev-core.sh` | Agent Core 开发模式 | `./scripts/dev-core.sh` |
| `scripts/dev-ts.sh` | **TS 引擎 (claude-code) 开发** | `./scripts/dev-ts.sh` |
| `scripts/dev-rust.sh` | Rust 引擎 (claw-code) 开发 | `./scripts/dev-rust.sh` |
| `scripts/run-core.sh` | Agent Core 运行入口 | `./scripts/run-core.sh` |
| `scripts/cli.sh` | 终端交互式 Agent 对话 | `./scripts/cli.sh --model deepseek-chat` |
| `scripts/cli-cc.sh` | Claude Code CLI 模式 | `./scripts/cli-cc.sh` |
| `scripts/build-desktop.sh` | 桌面版构建 | `./scripts/build-desktop.sh` |
| `scripts/generate-icons.sh` | 图标生成 | `./scripts/generate-icons.sh` |

#### TS 引擎开发（dev-ts.sh）

将 claude-code 作为 TS 引擎后端，通过 JSON-RPC 2.0 协议接入 openaide-ui：

```bash
# 完整构建 + 启动 VSCode（TS 引擎）
./scripts/dev-ts.sh

# 独立调试模式（stdin/stdout 交互，不启动 VSCode）
./scripts/dev-ts.sh --core-only

# 指定模型（如 DeepSeek）
DEEPSEEK_API_KEY=sk-xxx ./scripts/dev-ts.sh --core-only --model deepseek-chat

# 跳过构建，直接启动
./scripts/dev-ts.sh --skip-build

# 只检查环境状态
./scripts/dev-ts.sh --check

# 查看完整帮助
./scripts/dev-ts.sh --help
```

> 详细的 Bridge Adapter 说明请参考 [claude-code/BRIDGE.md](../claude-code/BRIDGE.md)

## 🤖 支持的模型

| Provider | 默认模型 | 说明 |
|----------|----------|------|
| Anthropic | claude-sonnet-4-20250514 | 默认 Provider |
| OpenAI | gpt-4o 等 | |
| DeepSeek | deepseek-chat 等 | |
| Qwen | 通义千问 | DashScope API |
| GLM | 智谱 GLM | |
| Ollama | 本地模型 | 本地部署 |
| Custom | 自定义 | OpenAI 兼容的任意端点（可自定义 baseUrl + model） |

## 📄 License

MIT
