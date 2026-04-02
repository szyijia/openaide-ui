# 更新日志

## v0.1.0 (2026-04-01)

### 🎉 首个预览版

**核心引擎**
- ✅ LLM Provider 抽象层，支持 Anthropic / OpenAI / DeepSeek / GLM
- ✅ 智能模型路由器（12 种任务分类，三级模型选择，预算控制）
- ✅ 9 个内置工具（Bash / FileRead / FileWrite / FileEdit / Glob / Grep / WebFetch / WebSearch / Agent）
- ✅ System Prompt 引擎（多模型适配，缓存分离）
- ✅ 上下文压缩（9 步结构化压缩，自动触发）
- ✅ 记忆系统（8 种分类，自动提取，项目/全局范围）
- ✅ 会话管理（CRUD，持久化，自动标题，用量追踪）
- ✅ MCP 客户端（完整 MCP 协议，工具/资源/Prompt）
- ✅ Multi-Agent 协调器（Coordinator + Team 模式）
- ✅ 用户认证（GitHub OAuth，API Key 加密管理）
- ✅ 权限管理器（三级范围，Bash 安全检查）

**VS Code Extension**
- ✅ Chat Panel（Webview + 流式输出 + @文件引用 + 工具调用 UI）
- ✅ Inline Diff（单文件/多文件 Diff，Accept/Reject）
- ✅ 代码补全（InlineCompletionProvider + Ghost Text）
- ✅ MCP 管理面板（TreeView + 连接/断开/添加）
- ✅ 记忆管理面板（分类展示 + 搜索/CRUD）
- ✅ Bridge 通信（JSON-RPC 2.0 双向通信）

**产品化**
- ✅ VSCodium 品牌定制（product.json + 构建脚本）
- ✅ CI/CD 流水线（GitHub Actions：CI + Release + E2E）
- ✅ 自动更新机制（版本检查 + 下载安装）
- ✅ MCP Marketplace（服务器发现/安装/评分）
- ✅ 云同步服务（配置/记忆/会话同步 + 端到端加密）
- ✅ 文档站点（VitePress）

**测试**
- ✅ 49 个单元测试全部通过
- ✅ TypeScript 编译零错误
