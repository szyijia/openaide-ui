# 多模型支持

openAIDE支持同时配置多个 LLM 模型，并通过智能路由自动选择最优模型。

## 支持的模型

| Provider | 模型 | 特点 |
|----------|------|------|
| **Anthropic** | Claude 4 Opus / Sonnet / Haiku | 最强综合能力，推荐主力模型 |
| **OpenAI** | GPT-4o / GPT-4.1 / o3 | 广泛兼容，生态丰富 |
| **DeepSeek** | DeepSeek V3 / R1 | 高性价比，中文优秀 |
| **智谱** | GLM-4 / GLM-4-Flash | 中文优化，免费额度 |
| **Ollama** | Llama / Qwen / Mistral 等 | 本地运行，完全离线 |

## 配置模型

### 通过 UI

1. 点击状态栏的模型名称
2. 选择「管理模型」
3. 添加 Provider 和 API Key

### 通过配置文件

```json
// ~/.openaide/config/models.json
{
  "providers": [
    {
      "name": "anthropic",
      "apiKey": "sk-ant-xxx",
      "models": ["claude-sonnet-4-20250514", "claude-haiku"]
    },
    {
      "name": "deepseek",
      "apiKey": "sk-xxx",
      "baseUrl": "https://api.deepseek.com",
      "models": ["deepseek-chat", "deepseek-reasoner"]
    },
    {
      "name": "ollama",
      "baseUrl": "http://localhost:11434",
      "models": ["qwen2.5:14b", "llama3.1:8b"]
    }
  ]
}
```

## 智能路由

openAIDE内置模型路由器，根据任务类型自动选择模型：

| 任务类型 | 推荐模型 | 原因 |
|----------|---------|------|
| 复杂重构 | Claude Sonnet | 需要强推理能力 |
| 代码生成 | Claude Sonnet / GPT-4o | 需要高质量输出 |
| 简单修改 | DeepSeek Chat | 快速且便宜 |
| 代码补全 | DeepSeek Chat | 低延迟 |
| 文档编写 | GPT-4o-mini | 性价比高 |
| 翻译 | GLM-4-Flash | 中文优化 |

### 配置路由规则

```json
{
  "router": {
    "primary": "claude-sonnet-4-20250514",
    "fast": "deepseek-chat",
    "economy": "glm-4-flash",
    "budget": {
      "dailyLimitUSD": 5
    }
  }
}
```

## 手动切换模型

- **状态栏** — 点击模型名称切换
- **命令面板** — `OpenAIDE: Switch Model`
- **Chat 中** — 输入 `/model <模型名>`

## 本地模型

通过 Ollama 使用本地模型：

```bash
# 安装 Ollama
curl -fsSL https://ollama.com/install.sh | sh

# 下载模型
ollama pull qwen2.5:14b

# openAIDE会自动检测本地 Ollama 服务
```

优势：
- 完全离线，数据不出本机
- 无 API 费用
- 适合敏感项目
