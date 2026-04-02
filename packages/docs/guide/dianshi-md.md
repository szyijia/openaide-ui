# .openaide.md 配置

`.openaide.md` 是项目级的 AI 配置文件，类似于 `.editorconfig` 或 `.eslintrc`，用于告诉 AI 关于你的项目的信息。

## 文件位置

将 `.openaide.md` 放在项目根目录：

```
my-project/
├── .openaide.md    ← AI 配置文件
├── src/
├── package.json
└── ...
```

## 文件格式

使用 Markdown 格式编写，AI 会将其作为系统提示词的一部分：

```markdown
# 项目说明

这是一个基于 Next.js 14 的电商平台，使用 TypeScript + Tailwind CSS。

## 技术栈

- 框架：Next.js 14 (App Router)
- 语言：TypeScript 5.5
- 样式：Tailwind CSS 3.4
- 数据库：PostgreSQL + Prisma
- 状态管理：Zustand
- 测试：Vitest + Playwright

## 代码规范

- 使用函数式组件和 React Hooks
- 组件文件使用 PascalCase 命名
- 工具函数使用 camelCase 命名
- 所有函数必须有 TypeScript 类型注解
- 使用 ESLint + Prettier 格式化

## 项目结构

- `src/app/` — Next.js 页面和路由
- `src/components/` — React 组件
- `src/lib/` — 工具函数和配置
- `src/hooks/` — 自定义 Hooks
- `src/types/` — TypeScript 类型定义
- `prisma/` — 数据库 Schema

## 注意事项

- API 路由统一使用 `/api/v1/` 前缀
- 所有数据库操作通过 Prisma Client
- 敏感信息使用环境变量，不要硬编码
- 提交前运行 `pnpm lint && pnpm test`
```

## 最佳实践

1. **保持简洁** — 只写 AI 需要知道的信息
2. **结构清晰** — 使用标题和列表组织内容
3. **具体明确** — 避免模糊的描述
4. **及时更新** — 项目变化时同步更新配置
5. **纳入版本控制** — 提交到 Git，团队共享

## 与记忆系统的关系

- `.openaide.md` 是**显式**的项目配置，手动编写
- 记忆系统是**隐式**的，AI 自动提取
- 两者互补：配置文件提供项目概览，记忆系统补充细节
