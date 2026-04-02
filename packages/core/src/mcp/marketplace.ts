/**
 * OpenAIDE IDE — MCP Marketplace
 *
 * MCP 服务器市场，提供：
 * - 内置 MCP 服务器注册表（常用服务器预配置）
 * - 搜索和发现 MCP 服务器
 * - 一键安装/卸载 MCP 服务器
 * - 服务器评分和推荐
 * - 配置管理
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';

// ─── 类型定义 ───

/** MCP 服务器注册信息 */
export interface MCPServerEntry {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 描述 */
  description: string;
  /** 分类 */
  category: MCPCategory;
  /** 标签 */
  tags: string[];
  /** 作者 */
  author: string;
  /** 版本 */
  version: string;
  /** 仓库地址 */
  repository?: string;
  /** 文档链接 */
  documentation?: string;
  /** 安装方式 */
  installMethod: MCPInstallMethod;
  /** 安装配置 */
  installConfig: MCPInstallConfig;
  /** 提供的工具列表 */
  tools: string[];
  /** 提供的资源列表 */
  resources: string[];
  /** 评分 (0-5) */
  rating: number;
  /** 下载次数 */
  downloads: number;
  /** 是否官方推荐 */
  featured: boolean;
  /** 图标 URL */
  icon?: string;
  /** 最后更新时间 */
  updatedAt: string;
}

/** MCP 服务器分类 */
export type MCPCategory =
  | 'database'      // 数据库
  | 'filesystem'    // 文件系统
  | 'web'           // 网络/API
  | 'devtools'      // 开发工具
  | 'ai'            // AI/ML
  | 'productivity'  // 生产力
  | 'cloud'         // 云服务
  | 'communication' // 通信
  | 'search'        // 搜索
  | 'other';        // 其他

/** 安装方式 */
export type MCPInstallMethod = 'npx' | 'pip' | 'docker' | 'binary' | 'manual';

/** 安装配置 */
export interface MCPInstallConfig {
  /** npx 包名 */
  package?: string;
  /** pip 包名 */
  pipPackage?: string;
  /** Docker 镜像 */
  dockerImage?: string;
  /** 二进制下载 URL */
  binaryUrl?: string;
  /** 启动命令 */
  command: string;
  /** 启动参数 */
  args?: string[];
  /** 环境变量（需要用户配置的） */
  requiredEnv?: MCPEnvVar[];
  /** 默认环境变量 */
  defaultEnv?: Record<string, string>;
}

/** 环境变量配置 */
export interface MCPEnvVar {
  /** 变量名 */
  name: string;
  /** 描述 */
  description: string;
  /** 是否必填 */
  required: boolean;
  /** 默认值 */
  default?: string;
  /** 是否为密钥（UI 中隐藏显示） */
  secret?: boolean;
}

/** 已安装的 MCP 服务器 */
export interface InstalledMCPServer {
  /** 服务器 ID */
  id: string;
  /** 安装时间 */
  installedAt: string;
  /** 用户配置的环境变量 */
  env: Record<string, string>;
  /** 是否启用 */
  enabled: boolean;
  /** 自定义启动命令（覆盖默认） */
  customCommand?: string;
  /** 自定义参数 */
  customArgs?: string[];
}

/** Marketplace 事件 */
export interface MarketplaceEvents {
  'install': (server: MCPServerEntry) => void;
  'uninstall': (serverId: string) => void;
  'update': (server: MCPServerEntry) => void;
  'error': (error: Error) => void;
}

// ─── 内置 MCP 服务器注册表 ───

const BUILTIN_SERVERS: MCPServerEntry[] = [
  // ─── 文件系统 ───
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: '安全的文件系统访问，支持读写文件、创建目录、搜索文件等操作',
    category: 'filesystem',
    tags: ['文件', '目录', '搜索'],
    author: 'Anthropic',
    version: '0.6.0',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installMethod: 'npx',
    installConfig: {
      package: '@modelcontextprotocol/server-filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/workspace'],
      requiredEnv: [],
    },
    tools: ['read_file', 'write_file', 'list_directory', 'create_directory', 'move_file', 'search_files', 'get_file_info'],
    resources: [],
    rating: 4.8,
    downloads: 50000,
    featured: true,
    updatedAt: '2025-12-01',
  },

  // ─── 数据库 ───
  {
    id: 'sqlite',
    name: 'SQLite',
    description: '查询和管理 SQLite 数据库，支持只读和读写模式',
    category: 'database',
    tags: ['SQL', 'SQLite', '数据库'],
    author: 'Anthropic',
    version: '0.6.0',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installMethod: 'npx',
    installConfig: {
      package: '@modelcontextprotocol/server-sqlite',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path'],
      requiredEnv: [
        { name: 'DB_PATH', description: 'SQLite 数据库文件路径', required: true },
      ],
    },
    tools: ['read_query', 'write_query', 'create_table', 'list_tables', 'describe_table'],
    resources: [],
    rating: 4.6,
    downloads: 30000,
    featured: true,
    updatedAt: '2025-12-01',
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: '连接和查询 PostgreSQL 数据库',
    category: 'database',
    tags: ['SQL', 'PostgreSQL', '数据库'],
    author: 'Anthropic',
    version: '0.6.0',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installMethod: 'npx',
    installConfig: {
      package: '@modelcontextprotocol/server-postgres',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres'],
      requiredEnv: [
        { name: 'POSTGRES_URL', description: 'PostgreSQL 连接字符串 (postgresql://user:pass@host:5432/db)', required: true, secret: true },
      ],
    },
    tools: ['query', 'list_tables', 'describe_table'],
    resources: [],
    rating: 4.5,
    downloads: 25000,
    featured: true,
    updatedAt: '2025-12-01',
  },

  // ─── 网络/API ───
  {
    id: 'fetch',
    name: 'Fetch',
    description: '获取网页内容和 API 数据，支持 HTML 转 Markdown',
    category: 'web',
    tags: ['HTTP', 'API', '网页'],
    author: 'Anthropic',
    version: '0.6.0',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installMethod: 'npx',
    installConfig: {
      package: '@modelcontextprotocol/server-fetch',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-fetch'],
    },
    tools: ['fetch'],
    resources: [],
    rating: 4.7,
    downloads: 45000,
    featured: true,
    updatedAt: '2025-12-01',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: '使用 Brave Search API 进行网络搜索',
    category: 'search',
    tags: ['搜索', 'Brave', '网络'],
    author: 'Anthropic',
    version: '0.6.0',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installMethod: 'npx',
    installConfig: {
      package: '@modelcontextprotocol/server-brave-search',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-brave-search'],
      requiredEnv: [
        { name: 'BRAVE_API_KEY', description: 'Brave Search API Key', required: true, secret: true },
      ],
    },
    tools: ['brave_web_search', 'brave_local_search'],
    resources: [],
    rating: 4.4,
    downloads: 20000,
    featured: false,
    updatedAt: '2025-12-01',
  },

  // ─── 开发工具 ───
  {
    id: 'github',
    name: 'GitHub',
    description: 'GitHub API 集成，管理仓库、Issue、PR、代码搜索等',
    category: 'devtools',
    tags: ['GitHub', 'Git', 'PR', 'Issue'],
    author: 'Anthropic',
    version: '0.6.0',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installMethod: 'npx',
    installConfig: {
      package: '@modelcontextprotocol/server-github',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      requiredEnv: [
        { name: 'GITHUB_PERSONAL_ACCESS_TOKEN', description: 'GitHub Personal Access Token', required: true, secret: true },
      ],
    },
    tools: ['create_issue', 'list_issues', 'create_pull_request', 'search_code', 'get_file_contents', 'push_files'],
    resources: [],
    rating: 4.9,
    downloads: 60000,
    featured: true,
    updatedAt: '2025-12-01',
  },
  {
    id: 'git',
    name: 'Git',
    description: '本地 Git 仓库操作，支持 log、diff、commit、branch 等',
    category: 'devtools',
    tags: ['Git', '版本控制'],
    author: 'Anthropic',
    version: '0.6.0',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installMethod: 'npx',
    installConfig: {
      package: '@modelcontextprotocol/server-git',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-git'],
    },
    tools: ['git_log', 'git_diff', 'git_commit', 'git_branch', 'git_status', 'git_checkout'],
    resources: [],
    rating: 4.7,
    downloads: 35000,
    featured: true,
    updatedAt: '2025-12-01',
  },

  // ─── 生产力 ───
  {
    id: 'slack',
    name: 'Slack',
    description: 'Slack 工作区集成，发送消息、管理频道、搜索历史',
    category: 'communication',
    tags: ['Slack', '消息', '团队'],
    author: 'Anthropic',
    version: '0.6.0',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installMethod: 'npx',
    installConfig: {
      package: '@modelcontextprotocol/server-slack',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-slack'],
      requiredEnv: [
        { name: 'SLACK_BOT_TOKEN', description: 'Slack Bot Token (xoxb-...)', required: true, secret: true },
        { name: 'SLACK_TEAM_ID', description: 'Slack Team ID', required: true },
      ],
    },
    tools: ['send_message', 'list_channels', 'search_messages', 'get_channel_history'],
    resources: [],
    rating: 4.3,
    downloads: 15000,
    featured: false,
    updatedAt: '2025-12-01',
  },
  {
    id: 'memory',
    name: 'Memory',
    description: '基于知识图谱的持久化记忆系统',
    category: 'ai',
    tags: ['记忆', '知识图谱', 'AI'],
    author: 'Anthropic',
    version: '0.6.0',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installMethod: 'npx',
    installConfig: {
      package: '@modelcontextprotocol/server-memory',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
    },
    tools: ['create_entities', 'create_relations', 'search_nodes', 'open_nodes', 'delete_entities'],
    resources: [],
    rating: 4.2,
    downloads: 18000,
    featured: false,
    updatedAt: '2025-12-01',
  },

  // ─── 云服务 ───
  {
    id: 'aws-kb-retrieval',
    name: 'AWS Knowledge Base',
    description: 'AWS Bedrock Knowledge Base 检索',
    category: 'cloud',
    tags: ['AWS', 'Bedrock', 'RAG'],
    author: 'Anthropic',
    version: '0.6.0',
    repository: 'https://github.com/modelcontextprotocol/servers',
    installMethod: 'npx',
    installConfig: {
      package: '@modelcontextprotocol/server-aws-kb-retrieval',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-aws-kb-retrieval'],
      requiredEnv: [
        { name: 'AWS_ACCESS_KEY_ID', description: 'AWS Access Key ID', required: true, secret: true },
        { name: 'AWS_SECRET_ACCESS_KEY', description: 'AWS Secret Access Key', required: true, secret: true },
        { name: 'AWS_REGION', description: 'AWS Region', required: true, default: 'us-east-1' },
      ],
    },
    tools: ['retrieve_from_knowledge_base'],
    resources: [],
    rating: 4.0,
    downloads: 8000,
    featured: false,
    updatedAt: '2025-12-01',
  },

  // ─── 搜索 ───
  {
    id: 'exa',
    name: 'Exa Search',
    description: 'Exa AI 搜索引擎，支持语义搜索和内容提取',
    category: 'search',
    tags: ['搜索', 'AI', '语义'],
    author: 'Exa',
    version: '1.0.0',
    repository: 'https://github.com/exa-labs/exa-mcp-server',
    installMethod: 'npx',
    installConfig: {
      package: 'exa-mcp-server',
      command: 'npx',
      args: ['-y', 'exa-mcp-server'],
      requiredEnv: [
        { name: 'EXA_API_KEY', description: 'Exa API Key', required: true, secret: true },
      ],
    },
    tools: ['search', 'find_similar', 'get_contents'],
    resources: [],
    rating: 4.5,
    downloads: 12000,
    featured: false,
    updatedAt: '2025-11-15',
  },

  // ─── Docker ───
  {
    id: 'docker',
    name: 'Docker',
    description: '管理 Docker 容器、镜像和网络',
    category: 'devtools',
    tags: ['Docker', '容器', 'DevOps'],
    author: 'Community',
    version: '0.3.0',
    repository: 'https://github.com/ckreiling/mcp-server-docker',
    installMethod: 'npx',
    installConfig: {
      package: 'mcp-server-docker',
      command: 'npx',
      args: ['-y', 'mcp-server-docker'],
    },
    tools: ['list_containers', 'create_container', 'start_container', 'stop_container', 'list_images', 'pull_image'],
    resources: [],
    rating: 4.1,
    downloads: 10000,
    featured: false,
    updatedAt: '2025-10-20',
  },
];

// ─── MCP Marketplace 服务 ───

export class MCPMarketplace extends EventEmitter {
  private configDir: string;
  private installedConfigPath: string;
  private installed: Map<string, InstalledMCPServer> = new Map();
  private registry: MCPServerEntry[] = [...BUILTIN_SERVERS];

  constructor(configDir?: string) {
    super();
    this.configDir = configDir || path.join(os.homedir(), '.openaide', 'mcp');
    this.installedConfigPath = path.join(this.configDir, 'installed.json');
    this.loadInstalled();
  }

  // ─── 搜索和发现 ───

  /**
   * 获取所有可用的 MCP 服务器
   */
  getAllServers(): MCPServerEntry[] {
    return [...this.registry];
  }

  /**
   * 获取推荐的 MCP 服务器
   */
  getFeaturedServers(): MCPServerEntry[] {
    return this.registry.filter(s => s.featured);
  }

  /**
   * 按分类获取服务器
   */
  getServersByCategory(category: MCPCategory): MCPServerEntry[] {
    return this.registry.filter(s => s.category === category);
  }

  /**
   * 搜索 MCP 服务器
   */
  searchServers(query: string): MCPServerEntry[] {
    const q = query.toLowerCase();
    return this.registry.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tags.some(t => t.toLowerCase().includes(q)) ||
      s.tools.some(t => t.toLowerCase().includes(q)) ||
      s.category.toLowerCase().includes(q)
    ).sort((a, b) => {
      // 优先显示精确匹配名称的
      const aNameMatch = a.name.toLowerCase().includes(q) ? 1 : 0;
      const bNameMatch = b.name.toLowerCase().includes(q) ? 1 : 0;
      if (aNameMatch !== bNameMatch) return bNameMatch - aNameMatch;
      // 其次按评分排序
      return b.rating - a.rating;
    });
  }

  /**
   * 获取服务器详情
   */
  getServer(id: string): MCPServerEntry | undefined {
    return this.registry.find(s => s.id === id);
  }

  /**
   * 获取所有分类
   */
  getCategories(): { category: MCPCategory; label: string; count: number }[] {
    const categoryLabels: Record<MCPCategory, string> = {
      database: '数据库',
      filesystem: '文件系统',
      web: '网络/API',
      devtools: '开发工具',
      ai: 'AI/ML',
      productivity: '生产力',
      cloud: '云服务',
      communication: '通信',
      search: '搜索',
      other: '其他',
    };

    const counts = new Map<MCPCategory, number>();
    for (const server of this.registry) {
      counts.set(server.category, (counts.get(server.category) || 0) + 1);
    }

    return Object.entries(categoryLabels)
      .filter(([cat]) => counts.has(cat as MCPCategory))
      .map(([cat, label]) => ({
        category: cat as MCPCategory,
        label,
        count: counts.get(cat as MCPCategory) || 0,
      }));
  }

  // ─── 安装管理 ───

  /**
   * 安装 MCP 服务器
   */
  async installServer(id: string, env: Record<string, string> = {}): Promise<void> {
    const server = this.getServer(id);
    if (!server) {
      throw new Error(`未找到 MCP 服务器: ${id}`);
    }

    // 检查必填环境变量
    const missingEnv = (server.installConfig.requiredEnv || [])
      .filter(e => e.required && !env[e.name] && !e.default)
      .map(e => e.name);

    if (missingEnv.length > 0) {
      throw new Error(`缺少必填环境变量: ${missingEnv.join(', ')}`);
    }

    // 合并默认环境变量
    const finalEnv = { ...server.installConfig.defaultEnv };
    for (const envVar of server.installConfig.requiredEnv || []) {
      if (env[envVar.name]) {
        finalEnv[envVar.name] = env[envVar.name];
      } else if (envVar.default) {
        finalEnv[envVar.name] = envVar.default;
      }
    }

    // 保存安装信息
    const installed: InstalledMCPServer = {
      id,
      installedAt: new Date().toISOString(),
      env: finalEnv,
      enabled: true,
    };

    this.installed.set(id, installed);
    await this.saveInstalled();

    this.emit('install', server);
  }

  /**
   * 卸载 MCP 服务器
   */
  async uninstallServer(id: string): Promise<void> {
    if (!this.installed.has(id)) {
      throw new Error(`MCP 服务器未安装: ${id}`);
    }

    this.installed.delete(id);
    await this.saveInstalled();

    this.emit('uninstall', id);
  }

  /**
   * 启用/禁用 MCP 服务器
   */
  async toggleServer(id: string, enabled?: boolean): Promise<void> {
    const server = this.installed.get(id);
    if (!server) {
      throw new Error(`MCP 服务器未安装: ${id}`);
    }

    server.enabled = enabled ?? !server.enabled;
    await this.saveInstalled();
  }

  /**
   * 更新 MCP 服务器环境变量
   */
  async updateServerEnv(id: string, env: Record<string, string>): Promise<void> {
    const server = this.installed.get(id);
    if (!server) {
      throw new Error(`MCP 服务器未安装: ${id}`);
    }

    server.env = { ...server.env, ...env };
    await this.saveInstalled();
  }

  /**
   * 获取已安装的服务器列表
   */
  getInstalledServers(): (MCPServerEntry & { installed: InstalledMCPServer })[] {
    const result: (MCPServerEntry & { installed: InstalledMCPServer })[] = [];

    for (const [id, installed] of this.installed) {
      const entry = this.getServer(id);
      if (entry) {
        result.push({ ...entry, installed });
      }
    }

    return result;
  }

  /**
   * 检查服务器是否已安装
   */
  isInstalled(id: string): boolean {
    return this.installed.has(id);
  }

  /**
   * 获取服务器的启动配置（用于 MCP Client 连接）
   */
  getServerLaunchConfig(id: string): { command: string; args: string[]; env: Record<string, string> } | null {
    const installed = this.installed.get(id);
    if (!installed || !installed.enabled) return null;

    const entry = this.getServer(id);
    if (!entry) return null;

    return {
      command: installed.customCommand || entry.installConfig.command,
      args: installed.customArgs || entry.installConfig.args || [],
      env: installed.env,
    };
  }

  /**
   * 导出所有已安装服务器的 MCP 配置（兼容 Claude Desktop 格式）
   */
  exportConfig(): Record<string, { command: string; args: string[]; env?: Record<string, string> }> {
    const config: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};

    for (const [id, installed] of this.installed) {
      if (!installed.enabled) continue;

      const entry = this.getServer(id);
      if (!entry) continue;

      config[id] = {
        command: installed.customCommand || entry.installConfig.command,
        args: installed.customArgs || entry.installConfig.args || [],
        env: Object.keys(installed.env).length > 0 ? installed.env : undefined,
      };
    }

    return config;
  }

  /**
   * 从配置文件导入 MCP 服务器
   */
  async importConfig(config: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>): Promise<number> {
    let imported = 0;

    for (const [id, serverConfig] of Object.entries(config)) {
      if (this.installed.has(id)) continue;

      const installed: InstalledMCPServer = {
        id,
        installedAt: new Date().toISOString(),
        env: serverConfig.env || {},
        enabled: true,
        customCommand: serverConfig.command,
        customArgs: serverConfig.args,
      };

      this.installed.set(id, installed);
      imported++;
    }

    if (imported > 0) {
      await this.saveInstalled();
    }

    return imported;
  }

  // ─── 持久化 ───

  private loadInstalled(): void {
    try {
      if (fs.existsSync(this.installedConfigPath)) {
        const data = JSON.parse(fs.readFileSync(this.installedConfigPath, 'utf-8'));
        if (Array.isArray(data)) {
          for (const item of data) {
            this.installed.set(item.id, item);
          }
        }
      }
    } catch {
      // 忽略加载错误
    }
  }

  private async saveInstalled(): Promise<void> {
    try {
      await fs.promises.mkdir(this.configDir, { recursive: true });
      const data = Array.from(this.installed.values());
      await fs.promises.writeFile(this.installedConfigPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }
}
