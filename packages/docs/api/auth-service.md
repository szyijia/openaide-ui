# 认证服务 API

认证服务（`AuthService`）管理用户身份认证、API Key 安全存储和用量配额控制。

## 概述

```typescript
import { AuthService } from '@openaide/core';

const auth = new AuthService();
await auth.init();

// 添加 API Key
await auth.addApiKey('anthropic', 'sk-ant-xxx', '我的 Claude Key');

// 获取解密后的 Key
const key = auth.getApiKey('anthropic');

// 记录用量
await auth.recordUsage('claude-sonnet-4-20250514', 1000, 500, 0.015);

// 检查配额
const quota = auth.isOverQuota();
if (quota.exceeded) {
  console.warn(quota.reason);
}
```

## 认证方式

| 方式 | 说明 | 适用场景 |
|------|------|---------|
| `github` | GitHub OAuth 社交登录 | openAIDE账号体系 |
| `email` | 邮箱 + 密码（JWT） | openAIDE账号体系 |
| `apikey` | 直接使用 LLM API Key | 独立使用，无需注册 |

## AuthService

### 初始化

```typescript
const auth = new AuthService();
await auth.init(); // 从磁盘加载状态
```

### GitHub OAuth 登录

#### `loginWithGitHub(config): Promise<AuthState>`

启动 GitHub OAuth 登录流程。

```typescript
interface OAuthConfig {
  /** GitHub OAuth App Client ID */
  clientId: string;
  /** GitHub OAuth App Client Secret */
  clientSecret: string;
  /** 回调 URL */
  redirectUri: string;
  /** 请求的权限范围 */
  scopes: string[];
}

const state = await auth.loginWithGitHub({
  clientId: 'your-client-id',
  clientSecret: 'your-client-secret',
  redirectUri: 'http://localhost:19876/callback',
  scopes: ['user:email'],
});

console.log(state.user?.name); // 'Zhang San'
```

流程：
1. 启动本地 HTTP 服务器（端口 19876）
2. 构建 GitHub 授权 URL
3. 用户在浏览器中完成授权
4. 接收授权码并交换 Access Token
5. 获取用户信息并保存认证状态

### API Key 管理

#### `addApiKey(provider, key, label?): Promise<ApiKeyEntry>`

添加 API Key（自动 AES-256 加密存储）。

```typescript
const entry = await auth.addApiKey('anthropic', 'sk-ant-xxx', '主力 Key');
console.log(entry.maskedKey); // 'sk-a****xxx'
console.log(entry.isDefault); // true（同 Provider 第一个 Key 自动设为默认）
```

#### `getApiKey(provider): string | null`

获取指定 Provider 的默认 API Key（自动解密）。

```typescript
const key = auth.getApiKey('anthropic');
// 返回原始 Key: 'sk-ant-xxx'
```

#### `getApiKeys(provider?): ApiKeyEntry[]`

获取 API Key 列表（不含明文 Key）。

```typescript
interface ApiKeyEntry {
  id: string;
  provider: string;
  label: string;
  maskedKey: string;      // 脱敏显示
  encryptedKey: string;   // 加密存储
  createdAt: string;
  lastUsedAt?: string;
  isDefault: boolean;
}

const keys = auth.getApiKeys('anthropic');
const allKeys = auth.getApiKeys(); // 所有 Provider
```

#### `removeApiKey(id): Promise<boolean>`

删除 API Key。

```typescript
await auth.removeApiKey('key-id');
```

#### `setDefaultApiKey(id): Promise<boolean>`

设置默认 API Key（同 Provider 只能有一个默认）。

```typescript
await auth.setDefaultApiKey('key-id');
```

#### `getApiKeyEnvMap(): Record<string, string>`

获取所有 Provider 的环境变量映射。

```typescript
const envMap = auth.getApiKeyEnvMap();
// {
//   ANTHROPIC_API_KEY: 'sk-ant-xxx',
//   OPENAI_API_KEY: 'sk-xxx',
//   DEEPSEEK_API_KEY: 'sk-xxx',
// }
```

### 用量统计

#### `recordUsage(model, inputTokens, outputTokens, costUSD): Promise<void>`

记录一次 API 调用的用量。

```typescript
await auth.recordUsage('claude-sonnet-4-20250514', 1000, 500, 0.015);
```

#### `getTodayUsage()`

获取今日用量汇总。

```typescript
const today = auth.getTodayUsage();
console.log(`请求: ${today.requests}`);
console.log(`Token: ${today.tokens}`);
console.log(`费用: $${today.costUSD.toFixed(4)}`);
```

#### `getUsageHistory(days?): UsageRecord[]`

获取历史用量（默认最近 30 天）。

```typescript
interface UsageRecord {
  date: string;          // '2026-04-01'
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  requestCount: number;
}

const history = auth.getUsageHistory(7); // 最近 7 天
```

### 配额管理

#### `isOverQuota(): { exceeded: boolean; reason?: string }`

检查是否超出配额。

```typescript
const check = auth.isOverQuota();
if (check.exceeded) {
  console.warn(check.reason);
  // '已达到每日请求上限 (100)'
  // '已达到每日 Token 上限 (1000000)'
  // '已达到月度预算上限 ($50)'
}
```

#### `getQuota(): UsageQuota`

获取当前配额信息。

```typescript
interface UsageQuota {
  dailyRequestLimit: number;   // 0 = 不限制
  dailyTokenLimit: number;
  monthlyBudgetUSD: number;
  usedRequests: number;
  usedTokens: number;
  usedBudgetUSD: number;
  resetDate: string;
}

const quota = auth.getQuota();
console.log(`今日已用: ${quota.usedRequests}/${quota.dailyRequestLimit} 请求`);
```

#### `updateQuota(updates): Promise<void>`

更新配额设置。

```typescript
await auth.updateQuota({
  dailyRequestLimit: 100,
  dailyTokenLimit: 1_000_000,
  monthlyBudgetUSD: 50,
});
```

配额重置规则：
- 每日请求数和 Token 数在每天零点自动重置
- 月度预算在每月 1 日自动重置

### 认证状态

#### `getAuthState(): AuthState`

```typescript
interface AuthState {
  isAuthenticated: boolean;
  user?: UserProfile;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
}
```

#### `getUser(): UserProfile | null`

```typescript
interface UserProfile {
  id: string;
  email?: string;
  name?: string;
  avatar?: string;
  authMethod: AuthMethod;
  createdAt: string;
  plan: 'free' | 'pro' | 'team';
}
```

#### `isAuthenticated(): boolean`

#### `logout(): Promise<void>`

## 安全存储

API Key 使用 AES-256-CBC 加密存储：

- 加密密钥基于机器指纹（hostname + username + platform）生成
- 密钥通过 `scrypt` 派生，使用固定盐值
- 加密后的 Key 存储在 `~/.openaide/auth/keys.json`
- 不同设备无法解密其他设备的 Key

```
~/.openaide/auth/
├── auth-state.json   # 认证状态
├── keys.json         # 加密的 API Key
├── usage.json        # 用量记录（最近 90 天）
└── quota.json        # 配额设置
```

## 相关文档

- [API Key 管理指南](/guide/api-keys)
- [模型路由](/guide/model-router)
