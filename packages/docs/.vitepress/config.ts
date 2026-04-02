import { defineConfig } from 'vitepress';

export default defineConfig({
  // 站点元数据
  title: 'openAIDE IDE',
  description: 'AI Native IDE — 基于 VSCodium 的智能开发环境',
  lang: 'zh-CN',

  // 主题配置
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'openAIDE IDE',

    // 导航栏
    nav: [
      { text: '指南', link: '/guide/getting-started' },
      { text: 'API 参考', link: '/api/core-engine' },
      { text: '工具', link: '/tools/overview' },
      {
        text: '更多',
        items: [
          { text: '更新日志', link: '/changelog' },
          { text: '路线图', link: '/roadmap' },
          { text: 'FAQ', link: '/faq' },
        ],
      },
      {
        text: 'v0.1.0',
        items: [
          { text: 'GitHub', link: 'https://github.com/nicepkg/openaide' },
          { text: '问题反馈', link: 'https://github.com/nicepkg/openaide/issues' },
        ],
      },
    ],

    // 侧边栏
    sidebar: {
      '/guide/': [
        {
          text: '入门',
          items: [
            { text: '什么是openAIDE', link: '/guide/what-is-openaide' },
            { text: '快速开始', link: '/guide/getting-started' },
            { text: '安装', link: '/guide/installation' },
          ],
        },
        {
          text: '核心功能',
          items: [
            { text: 'AI 对话', link: '/guide/ai-chat' },
            { text: '代码补全', link: '/guide/code-completion' },
            { text: 'Inline Diff', link: '/guide/inline-diff' },
            { text: '多模型支持', link: '/guide/multi-model' },
            { text: 'MCP 协议', link: '/guide/mcp' },
          ],
        },
        {
          text: '高级功能',
          items: [
            { text: 'Multi-Agent', link: '/guide/multi-agent' },
            { text: '记忆系统', link: '/guide/memory' },
            { text: '上下文压缩', link: '/guide/context-compact' },
            { text: '云同步', link: '/guide/cloud-sync' },
            { text: '权限管理', link: '/guide/permissions' },
          ],
        },
        {
          text: '配置',
          items: [
            { text: '.openaide.md 配置', link: '/guide/openaide-md' },
            { text: 'API Key 管理', link: '/guide/api-keys' },
            { text: '模型路由', link: '/guide/model-router' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'API 参考',
          items: [
            { text: '核心引擎', link: '/api/core-engine' },
            { text: 'LLM Provider', link: '/api/llm-provider' },
            { text: '工具系统', link: '/api/tool-system' },
            { text: 'MCP 客户端', link: '/api/mcp-client' },
            { text: '记忆管理', link: '/api/memory-manager' },
            { text: '会话管理', link: '/api/session-manager' },
            { text: '认证服务', link: '/api/auth-service' },
            { text: '云同步', link: '/api/cloud-sync' },
          ],
        },
      ],
      '/tools/': [
        {
          text: '内置工具',
          items: [
            { text: '工具概览', link: '/tools/overview' },
            { text: 'Bash', link: '/tools/bash' },
            { text: 'FileRead', link: '/tools/file-read' },
            { text: 'FileWrite', link: '/tools/file-write' },
            { text: 'FileEdit', link: '/tools/file-edit' },
            { text: 'Glob', link: '/tools/glob' },
            { text: 'Grep', link: '/tools/grep' },
            { text: 'WebFetch', link: '/tools/web-fetch' },
            { text: 'WebSearch', link: '/tools/web-search' },
            { text: 'Agent', link: '/tools/agent' },
          ],
        },
      ],
    },

    // 社交链接
    socialLinks: [
      { icon: 'github', link: 'https://github.com/nicepkg/openaide' },
    ],

    // 页脚
    footer: {
      message: '基于 MIT 许可发布',
      copyright: 'Copyright © 2026 openAIDE团队',
    },

    // 搜索
    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '无法找到相关结果',
            resetButtonTitle: '清除查询条件',
            footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
          },
        },
      },
    },

    // 编辑链接
    editLink: {
      pattern: 'https://github.com/nicepkg/openaide/edit/main/packages/docs/:path',
      text: '在 GitHub 上编辑此页',
    },

    // 上次更新
    lastUpdated: {
      text: '最后更新于',
    },

    // 文档页脚导航
    docFooter: {
      prev: '上一页',
      next: '下一页',
    },

    outline: {
      label: '页面导航',
      level: [2, 3],
    },

    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '菜单',
    darkModeSwitchLabel: '主题',
  },

  // 构建配置
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/logo.svg' }],
    ['meta', { name: 'theme-color', content: '#6366f1' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'openAIDE IDE — AI Native IDE' }],
    ['meta', { property: 'og:description', content: '基于 VSCodium 的 AI 原生智能开发环境' }],
    ['meta', { property: 'og:url', content: 'https://openaide.io' }],
  ],

  // Markdown 配置
  markdown: {
    lineNumbers: true,
    theme: {
      light: 'github-light',
      dark: 'one-dark-pro',
    },
  },

  // 站点地图
  sitemap: {
    hostname: 'https://openaide.io',
  },
});
