# 快速开始

本指南将帮助你在 5 分钟内上手openAIDE IDE。

## 前置条件

- **Node.js** ≥ 20.0.0
- **操作系统**：macOS / Windows / Linux
- 至少一个 LLM API Key（Claude / OpenAI / DeepSeek 等）

## 第一步：安装openAIDE

::: code-group

```bash [macOS]
# 下载 DMG 安装包
curl -fsSL https://openaide.io/install.sh | bash

# 或使用 Homebrew
brew install --cask openaide
```

```bash [Windows]
# 下载 EXE 安装器
winget install OpenAIDE.IDE

# 或从官网下载
# https://openaide.io/download/windows
```

```bash [Linux]
# Debian / Ubuntu
curl -fsSL https://openaide.io/install.sh | bash

# Arch Linux
yay -S openaide-ide

# 或下载 AppImage
# https://openaide.io/download/linux
```

:::

## 第二步：配置 API Key

首次启动openAIDE后，你需要配置至少一个 LLM Provider 的 API Key。

### 通过 UI 配置

1. 打开openAIDE IDE
2. 点击左侧边栏的 **AI 图标** 打开 Chat Panel
3. 点击底部状态栏的 **模型名称**
4. 在弹出的设置中添加 API Key

### 通过命令行配置

```bash
# 设置 Anthropic API Key
openaide config set anthropic.apiKey sk-ant-xxx

# 设置 OpenAI API Key
openaide config set openai.apiKey sk-xxx

# 设置 DeepSeek API Key
openaide config set deepseek.apiKey sk-xxx
```

### 通过环境变量

```bash
export ANTHROPIC_API_KEY=sk-ant-xxx
export OPENAI_API_KEY=sk-xxx
export DEEPSEEK_API_KEY=sk-xxx
```

## 第三步：开始对话

配置好 API Key 后，你就可以开始使用 AI 了：

1. 按 `Cmd+Shift+P`（macOS）或 `Ctrl+Shift+P`（Windows/Linux）
2. 输入 `OpenAIDE: Open Chat`
3. 在 Chat Panel 中输入你的问题

### 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Cmd/Ctrl+Shift+P` | 命令面板 |
| `Cmd/Ctrl+L` | 打开 AI Chat |
| `Cmd/Ctrl+I` | Inline 编辑 |
| `Tab` | 接受代码补全 |
| `Esc` | 取消补全 / 关闭面板 |

## 第四步：创建项目配置

在项目根目录创建 `.openaide.md` 文件，告诉 AI 关于你的项目：

```markdown
# 项目说明

这是一个 React + TypeScript 项目，使用 Tailwind CSS 做样式。

## 代码规范

- 使用函数式组件和 Hooks
- 使用 TypeScript 严格模式
- 组件文件使用 PascalCase 命名

## 项目结构

- `src/components/` — React 组件
- `src/hooks/` — 自定义 Hooks
- `src/utils/` — 工具函数
- `src/api/` — API 调用
```

## 下一步

- [AI 对话](/guide/ai-chat) — 深入了解 AI 对话功能
- [代码补全](/guide/code-completion) — 配置和使用代码补全
- [多模型支持](/guide/multi-model) — 配置多个 LLM 模型
- [MCP 协议](/guide/mcp) — 通过 MCP 扩展 AI 能力
