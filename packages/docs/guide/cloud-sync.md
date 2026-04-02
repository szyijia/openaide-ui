# 云同步

openAIDE支持将配置、记忆和会话历史同步到云端，实现多设备无缝切换。

## 功能概览

- 📁 **配置同步** — IDE 设置、快捷键、扩展列表
- 🧠 **记忆同步** — 全局记忆、项目记忆
- 💬 **会话同步** — 对话历史、用量统计
- 🔐 **端到端加密** — 可选 AES-256-GCM 加密
- 📡 **离线支持** — 断网时缓存操作，恢复后自动同步

## 启用同步

### 通过 UI

1. 打开设置 → 同步
2. 登录openAIDE账号
3. 选择要同步的数据类型
4. 点击「启用同步」

### 通过命令

```bash
# 启用同步
openaide sync enable

# 手动触发同步
openaide sync now

# 仅上传
openaide sync push

# 仅下载
openaide sync pull
```

## 同步策略

### 增量同步

openAIDE使用基于 SHA-256 哈希的增量同步，只传输变更的文件：

```
本地文件 → 计算哈希 → 与远端比较 → 仅传输差异
```

### 冲突解决

当同一文件在多台设备上被修改时，支持 4 种策略：

| 策略 | 说明 |
|------|------|
| `newest-wins` | 最后修改的版本优先（默认） |
| `local-wins` | 本地版本优先 |
| `remote-wins` | 远端版本优先 |
| `manual` | 手动选择 |

### 自动同步

默认每 5 分钟自动同步一次，可在设置中调整：

```json
{
  "openaide.sync.autoInterval": 300000,
  "openaide.sync.enabled": true,
  "openaide.sync.types": ["config", "memory", "session", "keybinding", "snippet"]
}
```

## 端到端加密

启用加密后，所有数据在上传前使用 AES-256-GCM 加密：

```json
{
  "openaide.sync.encryption": true
}
```

- 加密密钥由用户设置，服务器无法解密
- 密钥丢失将无法恢复数据
- 建议妥善保管加密密钥

## 数据导出/导入

支持手动导出所有同步数据：

```bash
# 导出
openaide sync export --output backup.json

# 导入
openaide sync import --input backup.json
```

## 隐私说明

- 同步数据存储在openAIDE云服务器
- 启用加密后，服务器只存储密文
- 不启用同步时，所有数据仅存储在本地
- 可随时删除云端数据
