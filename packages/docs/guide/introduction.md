# 简介

## 什么是openAIDE IDE？

**openAIDE (OpenAIDE)** 是一款深度集成 AI Agent 能力的桌面 IDE，基于 VSCodium（VS Code 的开源构建版本）进行品牌化和功能定制。

与市面上的 AI 编程助手不同，openAIDE不仅仅是一个代码补全工具，而是一个**完整的 AI Agent 系统**，能够自主理解需求、规划方案、编写代码、执行测试。

## 核心特性

### 🤖 完整的 Agent 能力

openAIDE内置 40+ 工具，AI 可以：
- 读写文件、搜索代码、执行命令
- 浏览网页、调用 API
- 管理 Git 仓库
- 创建和编辑多个文件
- 自动修复错误

### 🧠 Multi-Agent 协作

支持两种多 Agent 模式：
- **Coordinator 模式**：主 Agent 拆分任务，子 Agent 并行执行
- **Team 模式**：架构师、开发者、审查员等角色平级协作

### 🔌 MCP 协议

完整实现 Model Context Protocol：
- 内置 MCP 服务器市场
- 一键安装 GitHub、数据库、搜索等服务
- 自定义 MCP 服务器配置

### 🎯 智能模型路由

- 12 种任务自动分类
- 三级模型选择（fast / balanced / powerful）
- 成本预算控制和自动降级
- 支持 Claude、GPT、DeepSeek、GLM、Qwen、Ollama

### 💾 记忆系统

- 8 种记忆分类（代码模式、架构决策、用户偏好等）
- 自动从对话中提取关键信息
- 项目级和全局记忆
- 跨会话持久化

## 与其他工具的对比

| 特性 | Cursor | Continue | Cline | **openAIDE** |
|------|--------|----------|-------|----------|
| 形态 | 闭源 IDE | VS Code 插件 | VS Code 插件 | **开源定制 IDE** |
| Agent 能力 | 有 | 有限 | 有 | **完整（40+ 工具）** |
| Multi-Agent | 无 | 无 | 无 | **有（Team 模式）** |
| MCP 协议 | 有限 | 有 | 有 | **完整实现 + 市场** |
| 上下文压缩 | 有 | 基础 | 基础 | **高级（9 步压缩）** |
| 记忆系统 | 无 | 无 | 无 | **自动记忆提取** |
| 多模型 | Claude/GPT | 多模型 | 多模型 | **多模型 + Router** |

## 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| IDE 基座 | VSCodium | MIT 许可的 VS Code 构建 |
| 插件 | VS Code Extension API | TypeScript + Webview |
| Agent 引擎 | 自研 | TypeScript/Node.js |
| LLM 接入 | 自研 Router | 统一 API 接口 |
| 构建工具 | pnpm + Turborepo | Monorepo 管理 |
| 前端 UI | React + Tailwind CSS | Webview 内的 Chat UI |
| 协议 | MCP SDK + LSP | 标准协议支持 |
| 测试 | Vitest + @vscode/test-electron | 单元测试 + E2E |
