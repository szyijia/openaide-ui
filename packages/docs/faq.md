# 常见问题

## 通用问题

### openAIDE和 VS Code 有什么关系？

openAIDE基于 [VSCodium](https://vscodium.com/)（VS Code 的开源构建版本）进行品牌化定制。你可以把它理解为一个预装了强大 AI 能力的 VS Code。所有 VS Code 扩展都可以在openAIDE中使用。

### openAIDE是免费的吗？

openAIDE IDE 本身是开源免费的（MIT 许可）。但使用 AI 功能需要 LLM API Key，API 调用费用由各模型提供商收取。你也可以使用免费的本地模型（通过 Ollama）。

### 我的代码会被发送到云端吗？

只有你主动发送给 AI 的内容会通过 API 发送到 LLM 提供商。openAIDE不会在后台收集或上传你的代码。如果你使用本地模型，所有数据都不会离开你的电脑。

### 支持哪些编程语言？

openAIDE支持所有 VS Code 支持的编程语言。AI 功能对所有语言都有效，但对主流语言（TypeScript、Python、Java、Go、Rust 等）的效果最好。

## 配置问题

### 如何切换 AI 模型？

1. 点击底部状态栏的模型名称
2. 在弹出列表中选择目标模型
3. 或使用命令面板：`OpenAIDE: Switch Model`

### 如何配置代理？

在设置中搜索 `proxy`，或设置环境变量：

```bash
export HTTP_PROXY=http://proxy:port
export HTTPS_PROXY=http://proxy:port
```

### API Key 存储在哪里？

API Key 经过 AES-256 加密后存储在 `~/.openaide/auth/` 目录下。加密密钥基于机器指纹生成，不同设备无法解密。

### .openaide.md 文件是什么？

类似于 `.editorconfig` 或 `.eslintrc`，`.openaide.md` 是项目级的 AI 配置文件。你可以在其中定义项目说明、代码规范、AI 行为偏好等。详见 [.openaide.md 配置](/guide/openaide-md)。

## 功能问题

### Multi-Agent 模式怎么用？

在 Chat Panel 中输入 `/team` 命令启动 Team 模式，或使用 `/coordinator` 启动 Coordinator 模式。详见 [Multi-Agent 指南](/guide/multi-agent)。

### 如何安装 MCP 服务器？

1. 打开 MCP 管理面板（侧边栏 MCP 图标）
2. 点击「浏览市场」
3. 搜索并安装需要的 MCP 服务器
4. 或手动配置 `.openaide/mcp.json`

### 代码补全不工作？

检查以下几点：
1. 确认已配置 API Key
2. 确认网络连接正常
3. 检查设置中 `openaide.completion.enabled` 是否为 `true`
4. 某些文件类型可能被排除，检查 `openaide.completion.excludeLanguages`

### 如何减少 API 费用？

- 使用智能路由，让简单任务使用便宜的模型
- 设置每日预算上限
- 使用上下文压缩减少 Token 消耗
- 对于不需要联网的任务，使用本地模型

## 故障排除

### IDE 启动缓慢

1. 禁用不需要的扩展
2. 检查是否有大量 MCP 服务器在启动时连接
3. 清理旧的会话历史：`OpenAIDE: Cleanup Sessions`

### AI 回复质量差

1. 检查 `.openaide.md` 是否提供了足够的项目上下文
2. 尝试切换到更强的模型（如 Claude Sonnet）
3. 提供更具体的指令
4. 使用 `@文件名` 引用相关文件

### 内存占用过高

1. 关闭不需要的编辑器标签
2. 减少同时运行的 MCP 服务器数量
3. 清理会话历史
4. 重启 IDE
