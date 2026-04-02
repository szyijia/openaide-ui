# API Key 管理

openAIDE支持安全地管理多个 LLM Provider 的 API Key。

## 添加 API Key

### 通过 UI

1. 打开命令面板：`Cmd/Ctrl+Shift+P`
2. 输入 `OpenAIDE: Add API Key`
3. 选择 Provider（Anthropic / OpenAI / DeepSeek 等）
4. 输入 API Key
5. 可选：设置标签名称

### 通过命令行

```bash
openaide config set anthropic.apiKey sk-ant-xxx
openaide config set openai.apiKey sk-xxx
openaide config set deepseek.apiKey sk-xxx
```

### 通过环境变量

```bash
export ANTHROPIC_API_KEY=sk-ant-xxx
export OPENAI_API_KEY=sk-xxx
export DEEPSEEK_API_KEY=sk-xxx
```

## 安全存储

API Key 使用 AES-256-CBC 加密后存储在 `~/.openaide/auth/` 目录：

- 加密密钥基于机器指纹（MAC 地址 + 主机名 + 用户名）生成
- 不同设备无法解密
- Key 不会以明文形式出现在配置文件中

## 多 Key 管理

同一个 Provider 可以配置多个 API Key：

```bash
# 添加第一个 Key（自动设为默认）
openaide apikey add openai sk-key-1 --label "个人"

# 添加第二个 Key
openaide apikey add openai sk-key-2 --label "公司"

# 切换默认 Key
openaide apikey default openai --label "公司"

# 列出所有 Key
openaide apikey list
```

## 环境变量映射

openAIDE会自动将 API Key 映射为环境变量，供 MCP 服务器等使用：

| Provider | 环境变量 |
|----------|---------|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| 智谱 | `GLM_API_KEY` |

## 安全建议

1. **不要提交 Key** — 确保 `.env` 在 `.gitignore` 中
2. **定期轮换** — 定期更换 API Key
3. **设置预算** — 在 Provider 控制台设置用量上限
4. **使用配额** — 在openAIDE中设置每日/月度预算限制
