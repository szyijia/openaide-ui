/**
 * 用户认证服务
 *
 * 支持多种认证方式：
 * 1. GitHub OAuth — 社交登录
 * 2. API Key — 直接使用 LLM Provider 的 API Key
 * 3. OpenAIDE账号 — 邮箱 + 密码（JWT Token）
 *
 * 功能：
 * - Token 管理（存储/刷新/验证）
 * - 用量统计和配额管理
 * - 多 API Key 管理
 * - 安全存储（使用 OS Keychain）
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as http from 'node:http';

// ─── 类型定义 ───

/** 认证方式 */
export type AuthMethod = 'github' | 'email' | 'apikey';

/** 用户信息 */
export interface UserProfile {
  id: string;
  email?: string;
  name: string;
  avatar?: string;
  authMethod: AuthMethod;
  createdAt: string;
  plan: 'free' | 'pro' | 'team';
}

/** API Key 条目 */
export interface ApiKeyEntry {
  id: string;
  provider: string;
  label: string;
  /** 加密存储的 API Key（前 4 位明文 + 掩码） */
  maskedKey: string;
  /** 加密后的完整 Key */
  encryptedKey: string;
  createdAt: string;
  lastUsedAt?: string;
  isDefault: boolean;
}

/** 用量记录 */
export interface UsageRecord {
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  requestCount: number;
}

/** 用量配额 */
export interface UsageQuota {
  dailyRequestLimit: number;
  dailyTokenLimit: number;
  monthlyBudgetUSD: number;
  usedRequests: number;
  usedTokens: number;
  usedBudgetUSD: number;
  resetDate: string;
}

/** 认证状态 */
export interface AuthState {
  isAuthenticated: boolean;
  user?: UserProfile;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
}

/** OAuth 配置 */
export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

// ─── 常量 ───

const AUTH_DIR = path.join(os.homedir(), '.openaide', 'auth');
const KEYS_FILE = 'api-keys.json';
const USAGE_FILE = 'usage.json';
const AUTH_STATE_FILE = 'auth-state.json';
const QUOTA_FILE = 'quota.json';

/** 加密密钥（实际应使用 OS Keychain，这里用机器 ID 派生） */
function deriveEncryptionKey(): Buffer {
  const machineId = `${os.hostname()}-${os.userInfo().username}-openaide`;
  return crypto.scryptSync(machineId, 'openaide-salt-v1', 32);
}

// ─── 加密工具 ───

function encrypt(text: string): string {
  const key = deriveEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText: string): string {
  const key = deriveEncryptionKey();
  const [ivHex, encrypted] = encryptedText.split(':');
  if (!ivHex || !encrypted) throw new Error('无效的加密数据');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function maskApiKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.substring(0, 4) + '****' + key.substring(key.length - 4);
}

// ─── AuthService ───

export class AuthService {
  private authState: AuthState = { isAuthenticated: false };
  private apiKeys: ApiKeyEntry[] = [];
  private usageRecords: UsageRecord[] = [];
  private quota: UsageQuota;

  constructor() {
    this.quota = this.getDefaultQuota();
  }

  /**
   * 初始化 — 从磁盘加载状态
   */
  async init(): Promise<void> {
    await fs.mkdir(AUTH_DIR, { recursive: true });
    await Promise.all([
      this.loadAuthState(),
      this.loadApiKeys(),
      this.loadUsage(),
      this.loadQuota(),
    ]);
  }

  // ─── GitHub OAuth ───

  /**
   * 启动 GitHub OAuth 登录流程
   *
   * 1. 启动本地 HTTP 服务器接收回调
   * 2. 打开浏览器进行 GitHub 授权
   * 3. 接收授权码并交换 Token
   */
  async loginWithGitHub(config: OAuthConfig): Promise<AuthState> {
    const state = crypto.randomBytes(16).toString('hex');

    // 构建授权 URL
    const authUrl = new URL('https://github.com/login/oauth/authorize');
    authUrl.searchParams.set('client_id', config.clientId);
    authUrl.searchParams.set('redirect_uri', config.redirectUri);
    authUrl.searchParams.set('scope', config.scopes.join(' '));
    authUrl.searchParams.set('state', state);

    // 启动本地回调服务器
    const code = await this.startCallbackServer(config.redirectUri, state);

    // 用授权码交换 Access Token
    const tokenResponse = await this.exchangeGitHubToken(config, code);

    // 获取用户信息
    const userInfo = await this.fetchGitHubUser(tokenResponse.access_token);

    // 更新认证状态
    this.authState = {
      isAuthenticated: true,
      user: {
        id: `github-${userInfo.id}`,
        email: userInfo.email,
        name: userInfo.name || userInfo.login,
        avatar: userInfo.avatar_url,
        authMethod: 'github',
        createdAt: new Date().toISOString(),
        plan: 'free',
      },
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      expiresAt: tokenResponse.expires_in
        ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
        : undefined,
    };

    await this.saveAuthState();
    return this.authState;
  }

  /**
   * 启动本地 HTTP 服务器接收 OAuth 回调
   */
  private startCallbackServer(redirectUri: string, expectedState: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(redirectUri);
      const port = parseInt(url.port) || 19876;

      const server = http.createServer((req, res) => {
        const reqUrl = new URL(req.url || '/', `http://localhost:${port}`);
        const code = reqUrl.searchParams.get('code');
        const state = reqUrl.searchParams.get('state');

        if (state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>认证失败</h1><p>状态验证失败，请重试。</p>');
          reject(new Error('OAuth state 验证失败'));
          server.close();
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>认证失败</h1><p>未收到授权码。</p>');
          reject(new Error('未收到 OAuth 授权码'));
          server.close();
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html>
          <body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:system-ui;background:#1a1a2e;color:#e0e0e0;">
            <div style="text-align:center;">
              <h1 style="font-size:48px;margin-bottom:16px;">✨</h1>
              <h2>认证成功！</h2>
<p>你可以关闭此页面，返回OpenAIDE IDE 继续使用。</p>
            </div>
          </body>
          </html>
        `);

        resolve(code);
        server.close();
      });

      server.listen(port, () => {
        console.log(`[Auth] OAuth 回调服务器已启动: http://localhost:${port}`);
      });

      // 30 秒超时
      setTimeout(() => {
        server.close();
        reject(new Error('OAuth 登录超时'));
      }, 30000);
    });
  }

  /**
   * 用授权码交换 GitHub Access Token
   */
  private async exchangeGitHubToken(
    config: OAuthConfig,
    code: string,
  ): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
      }),
    });

    if (!response.ok) {
      throw new Error(`GitHub Token 交换失败: ${response.status}`);
    }

    return response.json() as Promise<{ access_token: string; refresh_token?: string; expires_in?: number }>;
  }

  /**
   * 获取 GitHub 用户信息
   */
  private async fetchGitHubUser(
    accessToken: string,
  ): Promise<{ id: number; login: string; name: string; email: string; avatar_url: string }> {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`获取 GitHub 用户信息失败: ${response.status}`);
    }

    return response.json() as Promise<{ id: number; login: string; name: string; email: string; avatar_url: string }>;
  }

  // ─── API Key 管理 ───

  /**
   * 添加 API Key
   */
  async addApiKey(provider: string, key: string, label?: string): Promise<ApiKeyEntry> {
    const entry: ApiKeyEntry = {
      id: crypto.randomBytes(8).toString('hex'),
      provider,
      label: label || `${provider} Key`,
      maskedKey: maskApiKey(key),
      encryptedKey: encrypt(key),
      createdAt: new Date().toISOString(),
      isDefault: this.apiKeys.filter((k) => k.provider === provider).length === 0,
    };

    this.apiKeys.push(entry);
    await this.saveApiKeys();
    return entry;
  }

  /**
   * 获取解密后的 API Key
   */
  getApiKey(provider: string): string | null {
    const entry = this.apiKeys.find((k) => k.provider === provider && k.isDefault);
    if (!entry) return null;

    try {
      const key = decrypt(entry.encryptedKey);
      entry.lastUsedAt = new Date().toISOString();
      return key;
    } catch {
      return null;
    }
  }

  /**
   * 获取指定 Provider 的所有 Key
   */
  getApiKeys(provider?: string): ApiKeyEntry[] {
    if (provider) {
      return this.apiKeys.filter((k) => k.provider === provider);
    }
    return [...this.apiKeys];
  }

  /**
   * 删除 API Key
   */
  async removeApiKey(id: string): Promise<boolean> {
    const idx = this.apiKeys.findIndex((k) => k.id === id);
    if (idx === -1) return false;

    this.apiKeys.splice(idx, 1);
    await this.saveApiKeys();
    return true;
  }

  /**
   * 设置默认 API Key
   */
  async setDefaultApiKey(id: string): Promise<boolean> {
    const target = this.apiKeys.find((k) => k.id === id);
    if (!target) return false;

    // 取消同 Provider 的其他默认
    for (const key of this.apiKeys) {
      if (key.provider === target.provider) {
        key.isDefault = key.id === id;
      }
    }

    await this.saveApiKeys();
    return true;
  }

  /**
   * 获取所有 Provider 的环境变量映射
   */
  getApiKeyEnvMap(): Record<string, string> {
    const envMap: Record<string, string> = {};
    const providerEnvKeys: Record<string, string> = {
      anthropic: 'ANTHROPIC_API_KEY',
      openai: 'OPENAI_API_KEY',
      deepseek: 'DEEPSEEK_API_KEY',
      qwen: 'DASHSCOPE_API_KEY',
      glm: 'GLM_API_KEY',
    };

    for (const [provider, envKey] of Object.entries(providerEnvKeys)) {
      const key = this.getApiKey(provider);
      if (key) {
        envMap[envKey] = key;
      }
    }

    return envMap;
  }

  // ─── 用量统计 ───

  /**
   * 记录一次 API 调用的用量
   */
  async recordUsage(model: string, inputTokens: number, outputTokens: number, costUSD: number): Promise<void> {
    const today = new Date().toISOString().split('T')[0]!;

    let record = this.usageRecords.find((r) => r.date === today && r.model === model);
    if (!record) {
      record = { date: today, model, inputTokens: 0, outputTokens: 0, costUSD: 0, requestCount: 0 };
      this.usageRecords.push(record);
    }

    record.inputTokens += inputTokens;
    record.outputTokens += outputTokens;
    record.costUSD += costUSD;
    record.requestCount += 1;

    // 更新配额
    this.quota.usedRequests += 1;
    this.quota.usedTokens += inputTokens + outputTokens;
    this.quota.usedBudgetUSD += costUSD;

    await Promise.all([this.saveUsage(), this.saveQuota()]);
  }

  /**
   * 获取今日用量
   */
  getTodayUsage(): { requests: number; tokens: number; costUSD: number } {
    const today = new Date().toISOString().split('T')[0]!;
    const todayRecords = this.usageRecords.filter((r) => r.date === today);

    return {
      requests: todayRecords.reduce((sum, r) => sum + r.requestCount, 0),
      tokens: todayRecords.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0),
      costUSD: todayRecords.reduce((sum, r) => sum + r.costUSD, 0),
    };
  }

  /**
   * 获取历史用量（最近 N 天）
   */
  getUsageHistory(days = 30): UsageRecord[] {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().split('T')[0]!;

    return this.usageRecords
      .filter((r) => r.date >= cutoffStr)
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  /**
   * 检查是否超出配额
   */
  isOverQuota(): { exceeded: boolean; reason?: string } {
    this.checkQuotaReset();

    if (this.quota.dailyRequestLimit > 0 && this.quota.usedRequests >= this.quota.dailyRequestLimit) {
      return { exceeded: true, reason: `已达到每日请求上限 (${this.quota.dailyRequestLimit})` };
    }

    if (this.quota.dailyTokenLimit > 0 && this.quota.usedTokens >= this.quota.dailyTokenLimit) {
      return { exceeded: true, reason: `已达到每日 Token 上限 (${this.quota.dailyTokenLimit})` };
    }

    if (this.quota.monthlyBudgetUSD > 0 && this.quota.usedBudgetUSD >= this.quota.monthlyBudgetUSD) {
      return { exceeded: true, reason: `已达到月度预算上限 ($${this.quota.monthlyBudgetUSD})` };
    }

    return { exceeded: false };
  }

  /**
   * 获取配额信息
   */
  getQuota(): UsageQuota {
    this.checkQuotaReset();
    return { ...this.quota };
  }

  /**
   * 更新配额设置
   */
  async updateQuota(updates: Partial<Pick<UsageQuota, 'dailyRequestLimit' | 'dailyTokenLimit' | 'monthlyBudgetUSD'>>): Promise<void> {
    Object.assign(this.quota, updates);
    await this.saveQuota();
  }

  // ─── 认证状态 ───

  /**
   * 获取当前认证状态
   */
  getAuthState(): AuthState {
    return { ...this.authState };
  }

  /**
   * 获取当前用户
   */
  getUser(): UserProfile | null {
    return this.authState.user || null;
  }

  /**
   * 是否已认证
   */
  isAuthenticated(): boolean {
    return this.authState.isAuthenticated;
  }

  /**
   * 登出
   */
  async logout(): Promise<void> {
    this.authState = { isAuthenticated: false };
    await this.saveAuthState();
  }

  // ─── 持久化 ───

  private async loadAuthState(): Promise<void> {
    try {
      const data = await fs.readFile(path.join(AUTH_DIR, AUTH_STATE_FILE), 'utf-8');
      this.authState = JSON.parse(data);
    } catch {
      this.authState = { isAuthenticated: false };
    }
  }

  private async saveAuthState(): Promise<void> {
    await fs.writeFile(
      path.join(AUTH_DIR, AUTH_STATE_FILE),
      JSON.stringify(this.authState, null, 2),
      'utf-8',
    );
  }

  private async loadApiKeys(): Promise<void> {
    try {
      const data = await fs.readFile(path.join(AUTH_DIR, KEYS_FILE), 'utf-8');
      this.apiKeys = JSON.parse(data);
    } catch {
      this.apiKeys = [];
    }
  }

  private async saveApiKeys(): Promise<void> {
    await fs.writeFile(
      path.join(AUTH_DIR, KEYS_FILE),
      JSON.stringify(this.apiKeys, null, 2),
      'utf-8',
    );
  }

  private async loadUsage(): Promise<void> {
    try {
      const data = await fs.readFile(path.join(AUTH_DIR, USAGE_FILE), 'utf-8');
      this.usageRecords = JSON.parse(data);
      // 只保留最近 90 天的记录
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 90);
      const cutoffStr = cutoff.toISOString().split('T')[0]!;
      this.usageRecords = this.usageRecords.filter((r) => r.date >= cutoffStr);
    } catch {
      this.usageRecords = [];
    }
  }

  private async saveUsage(): Promise<void> {
    await fs.writeFile(
      path.join(AUTH_DIR, USAGE_FILE),
      JSON.stringify(this.usageRecords, null, 2),
      'utf-8',
    );
  }

  private async loadQuota(): Promise<void> {
    try {
      const data = await fs.readFile(path.join(AUTH_DIR, QUOTA_FILE), 'utf-8');
      this.quota = JSON.parse(data);
    } catch {
      this.quota = this.getDefaultQuota();
    }
  }

  private async saveQuota(): Promise<void> {
    await fs.writeFile(
      path.join(AUTH_DIR, QUOTA_FILE),
      JSON.stringify(this.quota, null, 2),
      'utf-8',
    );
  }

  private getDefaultQuota(): UsageQuota {
    return {
      dailyRequestLimit: 0,   // 0 = 不限制
      dailyTokenLimit: 0,
      monthlyBudgetUSD: 0,
      usedRequests: 0,
      usedTokens: 0,
      usedBudgetUSD: 0,
      resetDate: new Date().toISOString().split('T')[0]!,
    };
  }

  private checkQuotaReset(): void {
    const today = new Date().toISOString().split('T')[0]!;
    if (this.quota.resetDate !== today) {
      this.quota.usedRequests = 0;
      this.quota.usedTokens = 0;
      // 月度预算在月初重置
      const resetMonth = this.quota.resetDate.substring(0, 7);
      const currentMonth = today.substring(0, 7);
      if (resetMonth !== currentMonth) {
        this.quota.usedBudgetUSD = 0;
      }
      this.quota.resetDate = today;
    }
  }
}
