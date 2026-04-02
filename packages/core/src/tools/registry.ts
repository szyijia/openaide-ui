/**
 * 工具注册表
 *
 * 参考 Claude Code: src/tools.ts
 * 管理所有可用工具的注册和查找
 */

import type { Tool, ToolContext, ToolResult } from './types.js';
import type { ToolDefinition } from '../llm/types.js';

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  /** 注册一个工具 */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  /** 批量注册工具 */
  registerAll(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /** 获取工具 */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 获取所有工具 */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** 获取所有工具的 LLM 定义（用于发送给模型） */
  getToolDefinitions(): ToolDefinition[] {
    return this.getAll().map((tool) => ({
      name: tool.name,
      description: tool.prompt, // 使用详细 prompt 而非短描述
      inputSchema: tool.inputSchema,
    }));
  }

  /** 执行工具调用 */
  async execute(
    toolName: string,
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        content: `Error: Unknown tool "${toolName}"`,
        isError: true,
      };
    }

    // 验证输入
    if (tool.validate) {
      const validation = tool.validate(input);
      if (!validation.valid) {
        return {
          content: `Validation error: ${validation.message}`,
          isError: true,
        };
      }
    }

    // 检查权限
    if (tool.permission.default === 'ask_user') {
      const description = `Tool "${tool.name}" wants to: ${tool.description}`;
      const approved = await context.askPermission(tool.name, description);
      if (!approved) {
        return {
          content: `Tool "${tool.name}" was denied by user`,
          isError: true,
        };
      }
    } else if (tool.permission.default === 'always_deny') {
      return {
        content: `Tool "${tool.name}" is not allowed`,
        isError: true,
      };
    }

    // 执行
    try {
      return await tool.execute(input, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.log('error', `Tool "${tool.name}" failed: ${message}`);
      return {
        content: `Error executing "${tool.name}": ${message}`,
        isError: true,
      };
    }
  }

  /** 工具数量 */
  get size(): number {
    return this.tools.size;
  }
}
