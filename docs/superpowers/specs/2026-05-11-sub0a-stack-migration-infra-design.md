# Sub 0a — Stack Migration Infrastructure (Vercel + Next.js + Neon)

> **Master spec**: `docs/superpowers/specs/2026-05-11-architecture-review.md` § Stack Pivot
> 
> **触发**：Architecture review 决定弃 CF Workers，迁 Vercel + Next.js + Neon Postgres。Sub 0a 是 3-sub Stack Migration 的第 1 步：基础设施。
> 
> **Goal**: 2-2.5 天 / 1 PR。Vercel 项目跑起来，Next.js shell + Neon Postgres + Drizzle PG schema 全通；旧 Vite 代码清空；旧 Workers 代码保留。**0 业务 logic 迁移**（Sub 0b 才做）。

---

## 一、范围 / 不在范围

| 在 | 不在（推 Sub 0b / 0c） |
|---|---|
| Next.js 14+ App Router 项目骨架（package.json / next.config.ts / tsconfig / app/layout / app/page） | 任何业务路由（mistakes / review / capture / etc.）— Sub 0b |
| 删 Vite 类代码（src/main.tsx / vite.config.ts / index.html / src/App.tsx / src/routes/*） | 删 workers/* — Sub 0b 后才删 |
| Neon Postgres 接通（已有项目；schema 推 Neon） | Workflow DevKit / Cron — Sub 0c |
| Drizzle PG schema 重写 18 张表（`text({mode:'json'})` → `jsonb()`，boolean / timestamp 同理） | Tencent OCR 升级 — Sub 0c |
| 删旧 SQLite migrations，generate 新 0000_initial PG migration | R2 客户端封装（声明依赖即可，不接到任何路由） |
| `app/api/health/route.ts` smoke endpoint（`{ok, db_ok}`） | LLM client / AI SDK — Sub 0b 后才挪 |
| `app/page.tsx` 占位 hero（"Loom"）| 任何 UI 业务 page |
| Tailwind v4 接 Next.js（保现有 `src/index.css` token） | Loom design system 接入 — 留着 reference 不用 |
| `.gitignore` 加 `.vercel/` `.next/` `next-env.d.ts` | |
| 18 张表 schema 推到 Neon main branch + 验证 | seed knowledge tree —— Sub 0b（要先有 multi-subject migration）|
| Vercel deploy 成功；prod URL `/api/health` 返 db_ok=true | |

---

## 二、关键决策（lock）

| 决策 | 选择 | 理由 |
|---|---|---|
| Frontend framework | **Next.js 14+ App Router + Server Components** | architecture review § Q1 lock'd |
| API routing | **混合模式**：`app/api/[...path]/route.ts` Hono dynamic catch-all（Sub 0b 用）；新 routes 用 Next.js 原生 | architecture review § Q2 lock'd；Sub 0a 不写任何业务 route，但占位 catch-all |
| Vite 处理 | **一次清空**所有 Vite 类代码 | architecture review § Sub 0a Q4 lock'd |
| 数据库 | **Neon Postgres free tier (0.5 GB)** | 用户拍板：图存 R2，DB 主要 text + JSON metadata，500 MB 可撑 1-3 年 |
| Drizzle driver | **`drizzle-orm/postgres-js`** + `postgres` package | 标准 PG driver；不用 Neon HTTP serverless driver（Sub 0a 不需要 edge） |
| 旧 SQLite migrations | **删 `drizzle/` 整目录** | 无 production 数据需保（用户已确认 fixture 数据可丢）；fresh PG 0000_initial 干净 |
| Workers 代码处理 | **保留不动** workers/* | Sub 0b 才迁路由，Sub 0a 完了 workers/* 仍能跑（但 deploy 不再走它） |
| Vercel preset | **Next.js**（auto-detected after Next.js 骨架 push） | 当前 main 还是 Vite；新 branch push 后 Vercel 自动检测 Next.js |
| 字体 / 设计系统 | **Phase 1b 不接** Loom design system；Tailwind v4 用现有 `src/index.css` token；保留 inspect.tsx 等已 ship UI 不接 | Sub 0b 才迁这些；Sub 0a 仅 placeholder hero |
| Deployment | git push → Vercel auto-deploy 该 branch（preview）；merge 后 main 自动 prod | 标准流程 |
| Env vars | **用户 dashboard 设**：DATABASE_URL（Neon integration auto-注）+ INTERNAL_TOKEN + ANTHROPIC_API_KEY + TENCENT_* + R2_*；本地 `.env.local` 同步（不 commit） | 标准；Sub 0a 仅 DATABASE_URL 实际用上 |

---

## 三、Vercel + Neon 工作流分配

### 3.1 用户做的（一次性，~10 min）

1. **已完成**：`vercel login` + 创建项目 `the-learning-project` (`prj_7sQRdVyBQZ0ew4Ok8ziNMwQnGlTj`)
2. **本 sub 完成时做**：Vercel dashboard → Marketplace → 装 **Neon** integration 到该项目；自动注入 `DATABASE_URL` 到 prod + preview env
3. 仅当需要时做：dashboard 设其他 secrets（INTERNAL_TOKEN / ANTHROPIC_API_KEY / TENCENT_* / R2_*）— Sub 0a 不接 LLM / OCR / R2，所以这步**可推到 Sub 0b/0c**

### 3.2 我（Claude）做的

1. 写 `.vercel/project.json`（已写）
2. 写 Next.js 骨架代码
3. 删 Vite 代码
4. 重写 Drizzle PG schema
5. drizzle-kit generate + push 到 Neon
6. 写 /api/health + /page placeholder
7. 用 MCP `deploy_to_vercel` 触发部署，`get_deployment` / `get_runtime_logs` 验证
8. 失败诊断 + 迭代

---

## 四、Schema 迁移要点

### 4.1 类型映射表

| SQLite (drizzle) | Postgres (drizzle) |
|---|---|
| `text('col')` | `text('col')` 不变 |
| `integer('col')` | `integer('col')` 不变 |
| `real('col')` | `real('col')` 不变 |
| `text('col', { mode: 'json' })` | `jsonb('col')` |
| `text('col', { mode: 'json' }).$type<X[]>()` | `jsonb('col').$type<X[]>()` |
| `integer('col', { mode: 'boolean' })` | `boolean('col')` |
| `integer('col', { mode: 'timestamp' })` | `timestamp('col', { withTimezone: true })` |

### 4.2 18 张表

按 `architecture-review.md` § Audit 列表全部迁。Schema 文件结构保持单文件 `src/db/schema.ts`（drizzle PG）。

### 4.3 SQL 查询语法（不在 Sub 0a 范围；Sub 0b 才迁）

- `json_extract(col, '$.field')` → `col->'field'` (jsonb operator) 或 `col->>'field'` (text)
- `json_array_length(col)` → `jsonb_array_length(col)`
- 这些路由代码改在 Sub 0b（路由迁移时一并改）

### 4.4 Drizzle config

```ts
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
  strict: true,
  verbose: true,
});
```

### 4.5 Migration push

`pnpm drizzle-kit push` 直接推到 Neon（适合 Sub 0a fresh start）；Sub 0b+ 走 `drizzle-kit migrate` 确保 audit trail。

---

## 五、Next.js 骨架文件

### 5.1 文件清单（创建）

| 文件 | 内容 |
|---|---|
| `next.config.ts` | 基础配置：`{ reactStrictMode: true }` |
| `tsconfig.json` | Next.js 默认 + paths `{"@/*": ["./src/*"]}` |
| `app/layout.tsx` | RootLayout，导入 globals.css + 字体 |
| `app/page.tsx` | placeholder：`<main>Loom — Stack migrating...</main>` |
| `app/globals.css` | 沿用现有 `src/index.css` 的 Tailwind v4 + token CSS |
| `app/api/health/route.ts` | GET 返 `{ok, db_ok}` |
| `src/db/client.ts` | drizzle PG client `db` 单例 |
| `src/db/schema.ts` | 18 张表 PG types（重写）|
| `drizzle.config.ts` | 见 § 4.4 |
| `package.json` 更新 | next + drizzle-orm + postgres + (drop vite/wrangler/etc) |
| `.env.local.example` | env vars 文档 |

### 5.2 文件清单（删除）

| 文件 | 删 |
|---|---|
| `src/main.tsx` | ✅ |
| `src/App.tsx` | ✅ |
| `index.html` | ✅ |
| `vite.config.ts` | ✅ |
| `src/routes/*` (整目录) | ✅ |
| `src/components/*` | ⚠ 保留如有共用 utility；目前无 |
| `src/index.css` | 移到 `app/globals.css` |
| `drizzle/` (旧 SQLite migrations) | ✅ |
| `vite-pwa` 相关配置 | ✅ |

### 5.3 文件清单（保留 — 不动）

| 路径 | 备注 |
|---|---|
| `workers/*` | Sub 0b 才迁，Sub 0c 才删 |
| `src/db/schema.ts` 现版本 | 重写但同路径 |
| `src/core/*` schema 类型定义 | 保留（Next.js 仍用）|
| `src/ai/registry.ts` | 保留（Sub 0b 路由迁移会用）|
| `docs/*` | 保留 |
| `PLANNING.md` | 保留 |
| `package.json` | 改而非删 |

---

## 六、验证 milestone

1. ✅ `pnpm install` 成功
2. ✅ `pnpm typecheck` 干净
3. ✅ `pnpm build`（next build）成功 — 含 .next/ 输出
4. ✅ Local dev `pnpm dev` 启 Next.js → `http://localhost:3000/` 显 Loom 占位
5. ✅ `http://localhost:3000/api/health` 返 `{ok: true, db_ok: true}`（前提 .env.local 配 DATABASE_URL）
6. ✅ Drizzle push 成功 → Neon main branch 出现 18 张表
7. ✅ Branch push 触发 Vercel preview deploy 成功
8. ✅ Preview URL `/api/health` 返 db_ok=true
9. ✅ Old Vite 代码确认删；workers/* 保留
10. ✅ MCP `get_deployment` 看 latest deploy state=READY

---

## 七、估时 / PR

| 段 | 任务 | 估时 |
|---|---|---|
| Vercel link 验证 + Neon integration 装（用户操作）| 你 dashboard 装 Neon，~10 min | — |
| Next.js 骨架 init + Vite 清除 | package.json 改 + 删 Vite + 创 layout/page | ~3h |
| Drizzle PG schema 重写（18 张表）| 类型映射 + 字段 1-1 翻译 | ~3h |
| Drizzle config + migrate + push 到 Neon | drizzle.config + push 验证 | ~1h |
| /api/health + db client + globals.css 移植 | ~2h |
| Vercel deploy + smoke + iterate | 我用 MCP deploy + logs；可能改 1-2 轮 | ~3h |
| 文档更新 (PLANNING / sub0a-spec) | ~1h |
| **合计** | **~13h ≈ 2 天** |

**1 个 PR**：`feat(stack): Sub 0a — Vercel + Next.js + Neon Postgres infrastructure`

---

## 八、不变量 / 失败模式

- **Workers 代码不能 deploy**：Vercel build 不会触发 workers/* 编译；保留只为 Sub 0b reference
- **drizzle.config.ts 强 dialect=postgresql**：保下次 generate 不会偶发回 sqlite
- **`.env.local` 不 commit**；只 commit `.env.local.example`
- **`.vercel/` ignore**：项目 link 信息本机即可，不入 git
- **Neon free tier**：0.5GB / 1 compute；超了告警 → 升 Pro $19 或归档老 logs

**预期失败模式**：
- Drizzle PG schema syntax error — 边写边 typecheck 拦截
- Vercel build 失败：跑 `next build` 本地试通过再 push
- Neon connection 在 Vercel function 冷启动慢：用 `postgres-js` driver + connection pooling 默认即可
- Tailwind v4 在 Next.js App Router 配置：用官方 `@tailwindcss/postcss`（v4 PostCSS plugin），跟 Vite 不同

---

## 九、Open（实施时再决）

1. **package.json scripts**：保留 `pnpm test` (vitest) / 加 `pnpm dev` (next dev) / `pnpm build` (next build)；旧 `workers:dev` 暂保
2. **Tailwind v4 config**：用 `@tailwindcss/postcss` (v4 推荐) 还是 `@tailwindcss/vite`（不适用 next）— lock postcss
3. **TypeScript path alias**：`@/*` → `./src/*` 标准
4. **Next.js version**：14 或 15；推荐 **15**（最新 stable）
5. **Lucide-react**：保留（已 deps）；Next.js 兼容
6. **TanStack Query**：保留；Next.js App Router 用 client component wrap
7. **PWA**：删 vite-plugin-pwa；Next.js PWA 用 `next-pwa` 或 manual SW（Phase 2 再说，Sub 0a 不接）
8. **Build cache**：Vercel 自动；本地 `.next/` ignore

---

## 十、依赖（OSS）

新增：
- `next` (^15.x)
- `react` 已有 (19.x)
- `drizzle-orm/postgres-js` (already)
- `postgres` (PG client)
- `drizzle-kit` (already)
- `@tailwindcss/postcss` (v4)
- `@types/node`

删除：
- `vite`
- `vite-plugin-react`
- `vite-plugin-pwa`
- `wrangler`
- `@cloudflare/workers-types`（保到 Sub 0b 完才删）

```bash
pnpm add next postgres
pnpm add -D @tailwindcss/postcss @types/node
pnpm remove vite vite-plugin-react vite-plugin-pwa
# wrangler / workers-types 不删，Sub 0b 后再删
```
