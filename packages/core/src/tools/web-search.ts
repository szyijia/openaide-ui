/**
 * WebSearchTool — 网页搜索工具
 *
 * 参考 Claude Code: src/tools/WebSearchTool/
 * 搜索互联网获取最新信息。
 *
 * 实现策略：
 * - Claude Code 使用 Anthropic 内置的 web_search_20250305 服务端工具
 * - OpenAIDE使用通用搜索 API（支持多种后端：Brave Search、SearXNG、Bing 等）
 * - 默认使用 Brave Search API（免费额度 2000 次/月）
 */

import * as https from 'node:https';
import { URL } from 'node:url';
import type { Tool, ToolResult, ToolPermission, ToolContext } from './types.js';

// ─── 搜索结果类型 ───

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

interface SearchResponse {
  results: SearchResult[];
  query: string;
  totalResults?: number;
}

// ─── 搜索后端 ───

/**
 * Brave Search API
 * 免费额度：2000 次/月
 * 需要设置环境变量 BRAVE_SEARCH_API_KEY
 */
async function searchBrave(
  query: string,
  count: number,
  signal: AbortSignal,
): Promise<SearchResponse> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    throw new Error(
      '未设置 BRAVE_SEARCH_API_KEY 环境变量。\n' +
      '请前往 https://brave.com/search/api/ 获取免费 API Key。',
    );
  }

  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(count, 20)),
    text_decorations: 'false',
  });

  const url = `https://api.search.brave.com/res/v1/web/search?${params}`;

  return new Promise<SearchResponse>((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': apiKey,
        },
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf-8');
            const data = JSON.parse(body);

            if (res.statusCode !== 200) {
              reject(new Error(`Brave Search API 错误 (${res.statusCode}): ${data.message || body}`));
              return;
            }

            const results: SearchResult[] = (data.web?.results || []).map(
              (r: { title: string; url: string; description: string }) => ({
                title: r.title || '',
                url: r.url || '',
                description: r.description || '',
              }),
            );

            resolve({
              results,
              query,
              totalResults: data.web?.totalResults,
            });
          } catch (e) {
            reject(new Error(`解析搜索结果失败: ${e instanceof Error ? e.message : String(e)}`));
          }
        });
        res.on('error', reject);
      },
    );

    req.on('error', reject);
  });
}

/**
 * SearXNG 搜索（自托管搜索引擎，无需 API Key）
 * 需要设置环境变量 SEARXNG_URL
 */
async function searchSearXNG(
  query: string,
  count: number,
  signal: AbortSignal,
): Promise<SearchResponse> {
  const baseUrl = process.env.SEARXNG_URL;
  if (!baseUrl) {
    throw new Error('未设置 SEARXNG_URL 环境变量');
  }

  const params = new URLSearchParams({
    q: query,
    format: 'json',
    pageno: '1',
  });

  const url = `${baseUrl}/search?${params}`;

  return new Promise<SearchResponse>((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : require('node:http');

    const req = client.get(url, { signal }, (res: any) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf-8');
          const data = JSON.parse(body);

          const results: SearchResult[] = (data.results || [])
            .slice(0, count)
            .map((r: { title: string; url: string; content: string }) => ({
              title: r.title || '',
              url: r.url || '',
              description: r.content || '',
            }));

          resolve({ results, query });
        } catch (e) {
          reject(new Error(`解析搜索结果失败: ${e instanceof Error ? e.message : String(e)}`));
        }
      });
      res.on('error', reject);
    });

    req.on('error', reject);
  });
}

/**
 * 自动选择搜索后端
 */
function getSearchBackend(): 'brave' | 'searxng' {
  if (process.env.BRAVE_SEARCH_API_KEY) return 'brave';
  if (process.env.SEARXNG_URL) return 'searxng';
  return 'brave'; // 默认使用 Brave（会在执行时报错提示设置 API Key）
}

async function performSearch(
  query: string,
  count: number,
  signal: AbortSignal,
): Promise<SearchResponse> {
  const backend = getSearchBackend();
  switch (backend) {
    case 'brave':
      return searchBrave(query, count, signal);
    case 'searxng':
      return searchSearXNG(query, count, signal);
    default:
      throw new Error(`未知的搜索后端: ${backend}`);
  }
}

// ─── 工具定义 ───

export const WebSearchTool: Tool = {
  name: 'web_search',
  description: '搜索互联网获取最新信息',

  prompt: `搜索互联网获取最新信息，返回搜索结果列表。

使用场景：
- 查找最新的技术文档和 API 参考
- 获取当前事件和最新数据
- 搜索错误信息的解决方案
- 查找库/框架的最新版本信息
- 获取超出 AI 知识截止日期的信息

重要要求：
- 搜索后回答用户问题时，必须在回复末尾包含"来源"部分
- 在来源部分，列出所有相关 URL 作为 Markdown 超链接：[标题](URL)
- 这是强制性的 — 永远不要跳过在回复中包含来源

注意事项：
- 搜索查询应简洁明了
- 当前日期是 ${new Date().toISOString().split('T')[0]}，搜索最新信息时请使用正确的年份
- 支持域名过滤（allowed_domains / blocked_domains）
- 每次搜索返回最多 10 条结果
- 如果搜索结果不够理想，可以尝试不同的关键词重新搜索`,

  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索查询关键词',
      },
      count: {
        type: 'number',
        description: '返回结果数量（默认 10，最大 20）',
      },
      allowed_domains: {
        type: 'array',
        description: '仅包含这些域名的搜索结果',
      },
      blocked_domains: {
        type: 'array',
        description: '排除这些域名的搜索结果',
      },
    },
    required: ['query'],
  },

  permission: {
    default: 'always_allow',
    userConfigurable: true,
  } as ToolPermission,

  concurrentSafe: true,

  validate(input: Record<string, unknown>) {
    const query = input.query as string;
    if (!query || query.trim().length < 2) {
      return { valid: false, message: '搜索查询至少需要 2 个字符' };
    }
    const allowedDomains = input.allowed_domains as string[] | undefined;
    const blockedDomains = input.blocked_domains as string[] | undefined;
    if (allowedDomains?.length && blockedDomains?.length) {
      return { valid: false, message: '不能同时指定 allowed_domains 和 blocked_domains' };
    }
    return { valid: true };
  },

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const query = input.query as string;
    const count = Math.min((input.count as number) || 10, 20);
    const allowedDomains = input.allowed_domains as string[] | undefined;
    const blockedDomains = input.blocked_domains as string[] | undefined;
    const startTime = Date.now();

    if (!query || query.trim().length < 2) {
      return { content: 'Error: 搜索查询至少需要 2 个字符', isError: true };
    }

    try {
      context.onProgress?.({ message: `正在搜索: ${query}` });

      // 构建搜索查询（添加域名过滤）
      let searchQuery = query;
      if (allowedDomains?.length) {
        const siteFilter = allowedDomains.map((d) => `site:${d}`).join(' OR ');
        searchQuery = `${query} (${siteFilter})`;
      }
      if (blockedDomains?.length) {
        const excludeFilter = blockedDomains.map((d) => `-site:${d}`).join(' ');
        searchQuery = `${query} ${excludeFilter}`;
      }

      const response = await performSearch(searchQuery, count, context.abortSignal);
      const durationMs = Date.now() - startTime;

      if (response.results.length === 0) {
        return {
          content: `搜索 "${query}" 没有找到结果。\n\n请尝试使用不同的关键词重新搜索。`,
          metadata: { query, resultCount: 0, durationMs },
        };
      }

      // 格式化搜索结果
      const formattedResults = response.results
        .map((r, i) => {
          const parts = [`${i + 1}. **${r.title}**`];
          parts.push(`   URL: ${r.url}`);
          if (r.description) {
            parts.push(`   ${r.description}`);
          }
          return parts.join('\n');
        })
        .join('\n\n');

      const header = `搜索: "${query}" | 找到 ${response.results.length} 条结果 | 耗时 ${durationMs}ms | 后端: ${getSearchBackend()}`;

      const output = `${header}\n${'─'.repeat(80)}\n\n${formattedResults}\n\n提醒：回复用户时，请在末尾包含上述搜索结果的来源链接。`;

      return {
        content: output,
        metadata: {
          query,
          resultCount: response.results.length,
          durationMs,
          backend: getSearchBackend(),
          results: response.results,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('中止') || message.includes('abort')) {
        return { content: '搜索被中止', isError: true };
      }

      return {
        content: `Error searching for "${query}": ${message}`,
        isError: true,
      };
    }
  },
};
