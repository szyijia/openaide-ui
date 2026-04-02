# 路线图

openAIDE IDE 的开发路线图，展示已完成和计划中的功能。

## 已完成 ✅

### Phase 0 — 基础搭建
- ✅ Monorepo 骨架（pnpm + Turborepo）
- ✅ TypeScript + ESLint + Prettier 配置
- ✅ packages/core、extension、shared、ide 骨架
- ✅ Vitest 测试框架
- ✅ VSCodium 品牌配置（product.json）

### Phase 1 — Agent 核心引擎
- ✅ LLM Provider 抽象层（Anthropic / OpenAI / DeepSeek / GLM）
- ✅ 9 个核心工具（Bash / File×3 / Glob / Grep / WebFetch / WebSearch / Agent）
- ✅ System Prompt 引擎（多模型适配）
- ✅ 上下文压缩（9 步结构化）
- ✅ 记忆系统（自动提取 + 持久化）
- ✅ CLI 模式可运行

### Phase 2 — VS Code Extension
- ✅ Chat Panel（Webview + 流式输出 + @文件引用）
- ✅ Inline Diff（单文件/多文件）
- ✅ 代码补全（Ghost Text）
- ✅ Bridge 通信（JSON-RPC 2.0）
- ✅ 工具调用审批 UI
- ✅ 状态栏（模型/Token/成本）

### Phase 3 — 产品化（进行中）
- ✅ Multi-Agent（Coordinator + Team 模式）
- ✅ 智能模型路由器
- ✅ MCP 管理面板
- ✅ MCP Marketplace
- ✅ 记忆管理面板
- ✅ 用户认证（GitHub OAuth + API Key）
- ✅ 权限管理器
- ✅ CI/CD 流水线（GitHub Actions）
- ✅ 自动更新机制
- ✅ 云同步服务
- ✅ 文档站点（VitePress）
- ✅ 49 个单元测试

## 进行中 🔶

### Phase 3 剩余项
- ⏳ VSCodium 实际构建（生成安装包）
- ⏳ E2E 测试（Playwright）

## 计划中 📋

### Phase 4 — 商业化
- 📋 Pro 订阅和计费（Stripe 集成）
- 📋 团队协作功能
- 📋 企业版（私有部署）
- 📋 LLM 代理服务（统一计费）

### Phase 5 — 生态建设
- 📋 插件市场
- 📋 MCP 服务器开发 SDK
- 📋 社区论坛
- 📋 教程和视频

### Phase 6 — 高级功能
- 📋 代码审查 Agent
- 📋 自动化测试生成
- 📋 项目脚手架
- 📋 AI 驱动的重构建议
- 📋 性能分析 Agent
- 📋 安全扫描 Agent

## 版本计划

| 版本 | 预计时间 | 主要内容 |
|------|---------|---------|
| v0.1.0 | 2026 Q2 | 首个预览版，核心功能可用 |
| v0.2.0 | 2026 Q2 | 全平台安装包，E2E 测试 |
| v0.5.0 | 2026 Q3 | Pro 订阅，团队功能 |
| v1.0.0 | 2026 Q4 | 正式发布，完整生态 |

## 参与贡献

我们欢迎社区贡献！查看 [GitHub Issues](https://github.com/nicepkg/openaide/issues) 了解当前需要帮助的任务。
