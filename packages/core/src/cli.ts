#!/usr/bin/env node
/**
 * OpenAIDE CLI — Agent 引擎验证入口
 *
 * 用于在终端中直接与 Agent 对话，验证引擎端到端工作
 *
 * 使用方法：
 *   npx tsx packages/core/src/cli.ts
 *   # 或
 *   pnpm --filter @openaide/core dev
 *
 * 环境变量：
 *   ANTHROPIC_API_KEY — Claude 模型
 *   OPENAI_API_KEY — OpenAI 模型
 *   DEEPSEEK_API_KEY — DeepSeek 模型
 *   QWEN_API_KEY — 通义千问模型
 *   GLM_API_KEY — 智谱 GLM 模型
 *   OPENAIDE_MODEL — 指定模型（如 gpt-4o, deepseek-chat, glm-4-plus）
 */

import * as readline from 'node:readline';
import { AgentEngine } from './agent/engine.js';
import { createProviderFromEnv } from './llm/factory.js';
import { ToolRegistry } from './tools/registry.js';
import { FileReadTool } from './tools/file-read.js';
import { FileWriteTool } from './tools/file-write.js';
import { FileEditTool } from './tools/file-edit.js';
import { GlobTool } from './tools/glob.js';
import { GrepTool } from './tools/grep.js';
import { BashTool } from './tools/bash.js';
import { createAgentTool } from './tools/agent.js';
import { buildSystemPrompt, loadProjectConfig } from './prompts/system.js';

// ─── 颜色辅助 ───
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

function c(color: keyof typeof colors, text: string): string {
  return `${colors[color]}${text}${colors.reset}`;
}

// ─── 主函数 ───
async function main() {
console.log(c('bold', '\n⛏️  OpenAIDE — AI Agent CLI\n'));

  // 1. 创建 LLM Provider
  const model = process.env.OPENAIDE_MODEL;
  let provider;
  try {
    provider = createProviderFromEnv(model);
  } catch (error) {
    console.error(c('red', (error as Error).message));
    process.exit(1);
  }

  console.log(c('dim', `模型: ${provider.name}/${provider.model}`));
  console.log(c('dim', `上下文窗口: ${(provider.maxContextWindow / 1000).toFixed(0)}K tokens`));
  console.log(c('dim', `工作目录: ${process.cwd()}`));

  // 2. 注册工具
  const tools = new ToolRegistry();
  tools.registerAll([
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    GlobTool,
    GrepTool,
    BashTool,
  ]);

  console.log(c('dim', `已注册工具: ${tools.getAll().map((t) => t.name).join(', ')}`));

  // 3. 构建 System Prompt
  const projectConfig = await loadProjectConfig(process.cwd());
  const systemPrompt = buildSystemPrompt({
    cwd: process.cwd(),
    model: `${provider.name}/${provider.model}`,
    toolNames: tools.getAll().map((t) => t.name),
    projectConfig: projectConfig || undefined,
  });

  console.log(c('dim', `System Prompt: ${(systemPrompt.length / 1024).toFixed(1)} KB`));

  // 注册 AgentTool（需要 provider、tools 和 systemPrompt）
  const agentTool = createAgentTool(() => ({
    provider,
    tools,
    systemPrompt,
    cwd: process.cwd(),
    maxToolRounds: 15,
  }));
  tools.register(agentTool);

  console.log(c('dim', `─`.repeat(60)));
  console.log(c('green', '准备就绪！输入消息开始对话（输入 /quit 退出，/clear 清空历史）\n'));

  // 4. 创建 Agent Engine
  const engine = new AgentEngine({
    provider,
    tools,
    systemPrompt,
    maxToolRounds: 25,
    cwd: process.cwd(),
  });

  // 5. 交互式对话循环
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question(c('cyan', '\n你: '), async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      // 命令处理
      if (trimmed === '/quit' || trimmed === '/exit' || trimmed === '/q') {
        console.log(c('dim', '\n再见！👋\n'));
        rl.close();
        process.exit(0);
      }

      if (trimmed === '/clear') {
        engine.clearHistory();
        console.log(c('dim', '对话历史已清空'));
        prompt();
        return;
      }

      if (trimmed === '/usage') {
        const usage = engine.getTotalUsage();
        console.log(c('dim', `\nToken 用量: 输入 ${usage.inputTokens} | 输出 ${usage.outputTokens}`));
        if (usage.totalCostUSD) {
          console.log(c('dim', `费用: $${usage.totalCostUSD.toFixed(4)}`));
        }
        prompt();
        return;
      }

      if (trimmed === '/help') {
        console.log(c('dim', '\n可用命令:'));
        console.log(c('dim', '  /quit, /exit, /q — 退出'));
        console.log(c('dim', '  /clear — 清空对话历史'));
        console.log(c('dim', '  /usage — 查看 Token 用量'));
        console.log(c('dim', '  /help — 显示帮助'));
        prompt();
        return;
      }

      // 发送消息给 Agent
      console.log('');
      const abortController = new AbortController();

      // Ctrl+C 中止当前请求
      const sigintHandler = () => {
        abortController.abort();
        console.log(c('yellow', '\n(已中止)'));
      };
      process.on('SIGINT', sigintHandler);

      try {
        for await (const event of engine.processMessage(trimmed, abortController.signal)) {
          switch (event.type) {
            case 'text':
              process.stdout.write(event.text);
              break;

            case 'thinking':
              process.stdout.write(c('dim', event.text));
              break;

            case 'tool_call':
              console.log(c('yellow', `\n🔧 调用工具: ${event.name}`));
              if (Object.keys(event.input).length > 0) {
                const inputStr = JSON.stringify(event.input, null, 2);
                // 截断过长的输入显示
                const displayInput = inputStr.length > 500
                  ? inputStr.substring(0, 500) + '...'
                  : inputStr;
                console.log(c('dim', displayInput));
              }
              break;

            case 'tool_result':
              if (event.isError) {
                console.log(c('red', `❌ ${event.name}: ${event.result.substring(0, 200)}`));
              } else {
                const resultPreview = event.result.length > 300
                  ? event.result.substring(0, 300) + '...'
                  : event.result;
                console.log(c('green', `✅ ${event.name}: ${resultPreview}`));
              }
              console.log('');
              break;

            case 'usage':
              console.log(c('dim', `\n[tokens: in=${event.usage.inputTokens} out=${event.usage.outputTokens}${event.usage.totalCostUSD ? ` cost=$${event.usage.totalCostUSD.toFixed(4)}` : ''}]`));
              break;

            case 'done':
              // 对话结束
              break;

            case 'error':
              console.log(c('red', `\n❌ 错误: ${event.error.message}`));
              break;
          }
        }
      } catch (error) {
        console.log(c('red', `\n❌ 未预期的错误: ${(error as Error).message}`));
      } finally {
        process.removeListener('SIGINT', sigintHandler);
      }

      prompt();
    });
  };

  prompt();
}

// 启动
main().catch((error) => {
  console.error(c('red', `启动失败: ${error.message}`));
  process.exit(1);
});
