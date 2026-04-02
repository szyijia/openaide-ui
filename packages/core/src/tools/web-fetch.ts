/**
 * WebFetchTool — 网页内容抓取工具
 *
 * 参考 Claude Code: src/tools/WebFetchTool/
 * 抓取指定 URL 的内容，将 HTML 转换为 Markdown，
 * 并可选地使用小模型对内容进行摘要处理。
 */

import * as https from 'node:https';
import * as http from 'node:http';
import { URL } from 'node:url';
import type { Tool, ToolResult, ToolPermission, ToolContext } from './types.js';

// ─── 常量 ───

const MAX_URL_LENGTH = 2000;
const MAX_CONTENT_LENGTH = 10 * 1024 * 1024; // 10MB
const MAX_MARKDOWN_LENGTH = 100_000; // 100K 字符
const FETCH_TIMEOUT_MS = 60_000; // 60 秒
const MAX_REDIRECTS = 10;

// ─── 简易 LRU 缓存 ───

interface CacheEntry {
  content: string;
  bytes: number;
  code: number;
  codeText: string;
  contentType: string;
  timestamp: number;
}

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 分钟
const urlCache = new Map<string, CacheEntry>();

function getCached(url: string): CacheEntry | null {
  const entry = urlCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    urlCache.delete(url);
    return null;
  }
  return entry;
}

function setCache(url: string, entry: CacheEntry): void {
  // 限制缓存大小（最多 50 条）
  if (urlCache.size >= 50) {
    const firstKey = urlCache.keys().next().value;
    if (firstKey) urlCache.delete(firstKey);
  }
  urlCache.set(url, entry);
}

// ─── URL 验证 ───

function validateURL(url: string): { valid: boolean; message?: string } {
  if (url.length > MAX_URL_LENGTH) {
    return { valid: false, message: `URL 过长（最大 ${MAX_URL_LENGTH} 字符）` };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, message: `无效的 URL: "${url}"` };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, message: `不支持的协议: ${parsed.protocol}（仅支持 http/https）` };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, message: '不支持包含用户名/密码的 URL' };
  }

  const parts = parsed.hostname.split('.');
  if (parts.length < 2) {
    return { valid: false, message: '无效的主机名' };
  }

  return { valid: true };
}

// ─── HTTP 请求 ───

interface FetchResult {
  content: Buffer;
  code: number;
  codeText: string;
  contentType: string;
  finalUrl: string;
}

interface RedirectResult {
  type: 'redirect';
  originalUrl: string;
  redirectUrl: string;
  statusCode: number;
}

/**
 * 检查重定向是否安全（同域名或仅 www 差异）
 */
function isPermittedRedirect(originalUrl: string, redirectUrl: string): boolean {
  try {
    const parsedOriginal = new URL(originalUrl);
    const parsedRedirect = new URL(redirectUrl);

    if (parsedRedirect.protocol !== parsedOriginal.protocol) return false;
    if (parsedRedirect.port !== parsedOriginal.port) return false;
    if (parsedRedirect.username || parsedRedirect.password) return false;

    const stripWww = (hostname: string) => hostname.replace(/^www\./, '');
    return stripWww(parsedOriginal.hostname) === stripWww(parsedRedirect.hostname);
  } catch {
    return false;
  }
}

/**
 * 发起 HTTP 请求，处理重定向
 */
function fetchUrl(
  url: string,
  signal: AbortSignal,
  depth = 0,
): Promise<FetchResult | RedirectResult> {
  return new Promise((resolve, reject) => {
    if (depth > MAX_REDIRECTS) {
      reject(new Error(`重定向次数过多（超过 ${MAX_REDIRECTS} 次）`));
      return;
    }

    const parsedUrl = new URL(url);
    // 升级 http 到 https
    if (parsedUrl.protocol === 'http:') {
      parsedUrl.protocol = 'https:';
    }
    const finalUrl = parsedUrl.toString();

    const client = parsedUrl.protocol === 'https:' ? https : http;

    const timeoutId = setTimeout(() => {
      req.destroy(new Error('请求超时'));
    }, FETCH_TIMEOUT_MS);

    const req = client.get(
      finalUrl,
      {
        headers: {
          Accept: 'text/markdown, text/html, */*',
          'User-Agent': 'OpenAIDE-IDE/1.0 (WebFetch)',
        },
        signal,
      },
      (res) => {
        clearTimeout(timeoutId);

        // 处理重定向
        if ([301, 302, 307, 308].includes(res.statusCode || 0)) {
          const redirectLocation = res.headers.location;
          if (!redirectLocation) {
            reject(new Error('重定向缺少 Location 头'));
            return;
          }

          const redirectUrl = new URL(redirectLocation, finalUrl).toString();

          if (isPermittedRedirect(finalUrl, redirectUrl)) {
            // 安全重定向，递归跟随
            resolve(fetchUrl(redirectUrl, signal, depth + 1));
          } else {
            // 跨域重定向，返回信息让用户决定
            resolve({
              type: 'redirect',
              originalUrl: url,
              redirectUrl,
              statusCode: res.statusCode!,
            });
          }
          // 消费响应体
          res.resume();
          return;
        }

        const chunks: Buffer[] = [];
        let totalSize = 0;

        res.on('data', (chunk: Buffer) => {
          totalSize += chunk.length;
          if (totalSize > MAX_CONTENT_LENGTH) {
            req.destroy(new Error(`响应体过大（超过 ${MAX_CONTENT_LENGTH / 1024 / 1024}MB）`));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          resolve({
            content: Buffer.concat(chunks),
            code: res.statusCode || 0,
            codeText: res.statusMessage || '',
            contentType: res.headers['content-type'] || '',
            finalUrl,
          });
        });

        res.on('error', reject);
      },
    );

    req.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });

    // 处理中止信号
    signal.addEventListener('abort', () => {
      req.destroy(new Error('请求被中止'));
    }, { once: true });
  });
}

// ─── HTML → Markdown 简易转换 ───

/**
 * 简易 HTML 转 Markdown
 * 不依赖外部库，处理常见的 HTML 标签
 */
function htmlToMarkdown(html: string): string {
  let md = html;

  // 移除 script 和 style 标签及内容
  md = md.replace(/<script[\s\S]*?<\/script>/gi, '');
  md = md.replace(/<style[\s\S]*?<\/style>/gi, '');
  md = md.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  // 移除 HTML 注释
  md = md.replace(/<!--[\s\S]*?-->/g, '');

  // 移除 head 标签
  md = md.replace(/<head[\s\S]*?<\/head>/gi, '');

  // 移除 nav、footer、header 中的内容（通常是导航/页脚噪音）
  md = md.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  md = md.replace(/<footer[\s\S]*?<\/footer>/gi, '');

  // 标题
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
  md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n');
  md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n');

  // 段落和换行
  md = md.replace(/<p[^>]*>/gi, '\n');
  md = md.replace(/<\/p>/gi, '\n');
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<hr\s*\/?>/gi, '\n---\n');

  // 链接
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // 图片
  md = md.replace(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi, '![$1]($2)');
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, '![$2]($1)');
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, '![]($1)');

  // 粗体和斜体
  md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  md = md.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
  md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  md = md.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');

  // 代码
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');

  // 列表
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  md = md.replace(/<\/?[ou]l[^>]*>/gi, '\n');

  // 表格（简化处理）
  md = md.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, '$1|\n');
  md = md.replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, '| $1 ');
  md = md.replace(/<\/?table[^>]*>/gi, '\n');
  md = md.replace(/<\/?thead[^>]*>/gi, '');
  md = md.replace(/<\/?tbody[^>]*>/gi, '');

  // 引用
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content) => {
    return content.split('\n').map((line: string) => `> ${line}`).join('\n');
  });

  // 移除所有剩余的 HTML 标签
  md = md.replace(/<[^>]+>/g, '');

  // 解码 HTML 实体
  md = md.replace(/&amp;/g, '&');
  md = md.replace(/&lt;/g, '<');
  md = md.replace(/&gt;/g, '>');
  md = md.replace(/&quot;/g, '"');
  md = md.replace(/&#39;/g, "'");
  md = md.replace(/&nbsp;/g, ' ');
  md = md.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)));

  // 清理多余空行
  md = md.replace(/\n{3,}/g, '\n\n');
  md = md.trim();

  return md;
}

// ─── 工具定义 ───

export const WebFetchTool: Tool = {
  name: 'web_fetch',
  description: '抓取网页内容并转换为 Markdown',

  prompt: `抓取指定 URL 的内容，将 HTML 转换为 Markdown 格式返回。

重要提示：WebFetch 无法访问需要认证的 URL。使用前请检查 URL 是否指向需要认证的服务（如 Google Docs、Confluence、Jira、GitHub 私有仓库）。如果是，请使用专门的 MCP 工具进行认证访问。

使用场景：
- 获取网页文档内容
- 查看 API 文档
- 获取在线教程或参考资料
- 查看 npm/pypi 包的文档页面

注意事项：
- URL 必须是完整的有效 URL
- HTTP URL 会自动升级为 HTTPS
- 结果可能会因内容过大而被截断
- 包含 15 分钟缓存，重复访问同一 URL 会更快
- 当 URL 重定向到不同域名时，工具会告知你重定向 URL
- 对于 GitHub URL，优先使用 bash 工具执行 gh CLI 命令（如 gh pr view、gh issue view）
- 不要用于下载二进制文件`,

  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: '要抓取的 URL',
      },
      prompt: {
        type: 'string',
        description: '对抓取内容的处理提示（描述你想从页面中提取什么信息）',
      },
    },
    required: ['url'],
  },

  permission: {
    default: 'ask_user',
    userConfigurable: true,
    riskWarning: '将从互联网抓取内容',
  } as ToolPermission,

  concurrentSafe: true,

  validate(input: Record<string, unknown>) {
    const url = input.url as string;
    if (!url) {
      return { valid: false, message: 'url 参数是必需的' };
    }
    const validation = validateURL(url);
    if (!validation.valid) {
      return { valid: false, message: validation.message! };
    }
    return { valid: true };
  },

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const url = input.url as string;
    const prompt = input.prompt as string | undefined;
    const startTime = Date.now();

    if (!url) {
      return { content: 'Error: url is required', isError: true };
    }

    // 验证 URL
    const validation = validateURL(url);
    if (!validation.valid) {
      return { content: `Error: ${validation.message}`, isError: true };
    }

    // 检查缓存
    const cached = getCached(url);
    if (cached) {
      const durationMs = Date.now() - startTime;
      let result = cached.content;
      if (result.length > MAX_MARKDOWN_LENGTH) {
        result = result.substring(0, MAX_MARKDOWN_LENGTH) + '\n\n[内容因过长被截断...]';
      }

      return {
        content: formatOutput(url, cached.code, cached.codeText, cached.bytes, result, durationMs, true),
        metadata: {
          url,
          bytes: cached.bytes,
          code: cached.code,
          cached: true,
          durationMs,
        },
      };
    }

    // 发起请求
    try {
      context.onProgress?.({ message: `正在抓取 ${new URL(url).hostname}...` });

      const response = await fetchUrl(url, context.abortSignal);

      // 处理跨域重定向
      if ('type' in response && response.type === 'redirect') {
        const statusText = response.statusCode === 301 ? 'Moved Permanently'
          : response.statusCode === 308 ? 'Permanent Redirect'
          : response.statusCode === 307 ? 'Temporary Redirect'
          : 'Found';

        const message = `检测到重定向：

原始 URL: ${response.originalUrl}
重定向 URL: ${response.redirectUrl}
状态: ${response.statusCode} ${statusText}

请使用重定向后的 URL 重新调用 web_fetch 工具：
- url: "${response.redirectUrl}"${prompt ? `\n- prompt: "${prompt}"` : ''}`;

        return {
          content: message,
          metadata: {
            url: response.originalUrl,
            redirectUrl: response.redirectUrl,
            statusCode: response.statusCode,
          },
        };
      }

      const fetchResult = response as FetchResult;
      const bytes = fetchResult.content.length;
      const htmlContent = fetchResult.content.toString('utf-8');

      // 转换为 Markdown
      context.onProgress?.({ message: '正在转换内容...' });

      let markdownContent: string;
      if (fetchResult.contentType.includes('text/html')) {
        markdownContent = htmlToMarkdown(htmlContent);
      } else {
        // 非 HTML 内容直接使用
        markdownContent = htmlContent;
      }

      // 截断过长内容
      if (markdownContent.length > MAX_MARKDOWN_LENGTH) {
        markdownContent = markdownContent.substring(0, MAX_MARKDOWN_LENGTH)
          + '\n\n[内容因过长被截断...]';
      }

      // 缓存结果
      setCache(url, {
        content: markdownContent,
        bytes,
        code: fetchResult.code,
        codeText: fetchResult.codeText,
        contentType: fetchResult.contentType,
        timestamp: Date.now(),
      });

      const durationMs = Date.now() - startTime;

      return {
        content: formatOutput(url, fetchResult.code, fetchResult.codeText, bytes, markdownContent, durationMs, false),
        metadata: {
          url,
          bytes,
          code: fetchResult.code,
          contentType: fetchResult.contentType,
          durationMs,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes('中止') || message.includes('abort')) {
        return { content: '请求被中止', isError: true };
      }

      return {
        content: `Error fetching URL "${url}": ${message}`,
        isError: true,
      };
    }
  },
};

// ─── 辅助函数 ───

function formatOutput(
  url: string,
  code: number,
  codeText: string,
  bytes: number,
  content: string,
  durationMs: number,
  cached: boolean,
): string {
  const sizeStr = bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

  const header = [
    `URL: ${url}`,
    `Status: ${code} ${codeText}`,
    `Size: ${sizeStr}`,
    `Duration: ${durationMs}ms`,
    cached ? '(cached)' : '',
  ].filter(Boolean).join(' | ');

  return `${header}\n${'─'.repeat(80)}\n${content}`;
}
