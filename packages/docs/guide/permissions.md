# 权限管理

openAIDE采用三级权限模型，控制 AI 对系统资源的访问。

## 权限级别

| 级别 | 行为 | 适用工具 |
|------|------|---------|
| 🟢 **低风险** | 自动批准 | file-read, glob, grep, web-fetch, web-search |
| 🟡 **中风险** | 首次确认 | file-write, file-edit, agent |
| 🔴 **高风险** | 每次确认 | bash |

## 权限范围

```
Session（会话级）— 仅当前对话有效
  └── Project（项目级）— 当前项目持久有效
       └── Global（全局级）— 跨项目持久有效
```

## 审批流程

当 AI 调用需要权限的工具时：

1. 弹出审批对话框，显示工具名称和参数
2. 用户选择：
   - **允许一次** — 仅本次允许
   - **允许本会话** — 当前对话中不再询问
   - **允许本项目** — 在此项目中不再询问
   - **始终允许** — 全局不再询问
   - **拒绝** — 拒绝本次调用

## 权限规则

### 添加规则

```json
// .openaide/permissions.json
{
  "rules": [
    {
      "tool": "bash",
      "pattern": "npm *",
      "decision": "allow",
      "scope": "project"
    },
    {
      "tool": "bash",
      "pattern": "rm -rf *",
      "decision": "deny",
      "scope": "global"
    },
    {
      "tool": "file-write",
      "pattern": "src/**",
      "decision": "allow",
      "scope": "project"
    }
  ]
}
```

### Bash 安全检查

对于 bash 工具，openAIDE内置了额外的安全检查：

**自动拒绝的命令**：
- `rm -rf /` — 删除根目录
- `:(){ :|:& };:` — Fork 炸弹
- `dd if=/dev/zero` — 磁盘擦除
- `chmod -R 777 /` — 全局权限修改

**需要确认的命令**：
- `sudo *` — 需要 root 权限
- `curl * | bash` — 管道执行
- `npm publish` — 发布包
- `git push --force` — 强制推送

## 管理权限

- 命令：`OpenAIDE: Permission Settings`
- 查看和编辑所有权限规则
- 清除已保存的权限决策
- 导出/导入权限配置
