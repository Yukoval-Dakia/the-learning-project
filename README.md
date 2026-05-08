# AI 学习工具 (the-learning-project)

自用 AI 学习系统。规划与架构详见 [PLANNING.md](./PLANNING.md) 与 [docs/](./docs)。

## 技术栈（Phase 1）

| 层 | 选型 |
| --- | --- |
| 前端 | React 19 + TypeScript（strict） + Vite 6 |
| 样式 | Tailwind v4（CSS-first 配置） |
| 路由 | React Router 7 |
| 状态 | TanStack Query + Zustand |
| Schema / 校验 | Zod |
| ORM | Drizzle（SQLite dialect） |
| 数据存储 | Cloudflare D1（Phase 1 远程优先；Phase 1.5 起 R2 存图片；Phase 4 加 PWA cache；Phase 3 Tauri 端 better-sqlite3 镜像） |
| AI SDK | Vercel AI SDK + `@ai-sdk/anthropic` |
| 边缘后端 | Cloudflare Workers + Hono（AI 代理 / 持 key；Phase 4 起接管同步） |
| Lint / Format | Biome |
| 包管理 | pnpm |

设计原则：用 OSS 解成熟问题，不自建 tool-calling 循环，不抽通用接口直到第二实例出现。详见 [docs/architecture.md § 六 技术栈](./docs/architecture.md#六技术栈)。

## 开发

```bash
pnpm install

# 客户端
pnpm dev

# Workers AI 代理（另开终端）
pnpm workers:dev
```

把 Anthropic API key 放在 `workers/.dev.vars`：

```
ANTHROPIC_API_KEY=sk-ant-...
```

浏览器代码绝不持有 key —— 所有 AI 调用走 `/api/ai/<task>`，由 Workers 转发到 Anthropic。

## 目录

```
src/
  core/          # 领域 Zod schema、id 工具、跨学科共享
  db/            # Drizzle schema + client（D1 driver via Cloudflare Workers）
  ai/            # Task 注册表 + 客户端调用器
  ui/            # 共享 UI 组件
  routes/        # PWA 路由（React Router）
  subjects/
    wenyan/      # 文言文学科 bundle（Phase 1 首发数据集）
workers/         # Cloudflare Workers（AI 代理；Phase 4 同步）
docs/            # 架构与模块文档
PLANNING.md      # 主索引
```

`core/` 跨学科共享，`subjects/<name>/` 单学科特化。边界在 Phase 1 就划好。
