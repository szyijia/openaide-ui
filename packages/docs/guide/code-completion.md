# 代码补全

openAIDE内置 AI 代码补全，在你输入代码时实时提供智能建议。

## 工作原理

当你在编辑器中输入代码时，openAIDE会：
1. 收集当前文件内容和光标位置
2. 分析上下文（导入、函数签名、注释等）
3. 调用 LLM 生成补全建议
4. 以 Ghost Text（灰色文字）显示在光标后方

## 使用方式

### 接受补全

- **Tab** — 接受整个补全建议
- **Cmd/Ctrl+→** — 逐词接受
- **Escape** — 拒绝补全

### 触发补全

补全会在以下情况自动触发：
- 输入代码时（有短暂延迟）
- 输入注释后换行
- 输入函数签名后

也可以手动触发：
- **Alt+\\** — 手动触发补全

## 配置

在设置中搜索 `openaide.completion`：

```json
{
  // 启用/禁用代码补全
  "openaide.completion.enabled": true,

  // 触发延迟 (ms)
  "openaide.completion.delay": 300,

  // 最大补全行数
  "openaide.completion.maxLines": 10,

  // 排除的语言
  "openaide.completion.excludeLanguages": ["markdown", "plaintext"],

  // 使用的模型（默认使用快速模型）
  "openaide.completion.model": "deepseek-chat"
}
```

## 补全模型选择

代码补全默认使用快速模型（如 DeepSeek）以降低延迟和成本：

| 模型 | 延迟 | 质量 | 成本 |
|------|------|------|------|
| DeepSeek Chat | ~200ms | ★★★★ | 极低 |
| GPT-4o-mini | ~300ms | ★★★★ | 低 |
| Claude Haiku | ~250ms | ★★★★ | 低 |

你可以在设置中切换补全模型。

## 最佳实践

1. **写好注释** — AI 会根据注释生成更准确的代码
2. **写好函数签名** — 类型信息帮助 AI 理解意图
3. **使用有意义的变量名** — 语义化命名提升补全质量
4. **适时按 Escape** — 不需要时及时取消，避免干扰
