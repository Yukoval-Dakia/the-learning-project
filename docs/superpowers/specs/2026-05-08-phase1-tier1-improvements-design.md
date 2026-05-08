# Phase 1 Tier 1 改进 · 设计 spec

> 2026-05-08 · 输入：5 项 Tier 1 改进（解锁 Phase 1 推进）

---

## 背景

当前状态：文档 v0.11 完整、scaffold 已搭（Zod + Drizzle schema 与文档对齐、技术选型完毕），但 Phase 1 推进卡在五个关键决策 / 缺口。本 spec 把这五项固化为可执行设计。

---

## 改进 1：锁定本地存储路线 → D1 远程优先

### 决策

Phase 1 直接走 Cloudflare D1（远程模式），不接 sqlite-wasm + OPFS。离线推到 Phase 4 用 PWA cache 补。

### Why

- sqlite-wasm + drizzle-sqlite-proxy 整合是被低估的 1-2 周工程（worker thread + query executor 适配）
- 自用工具初期"能用"远比"离线"重要
- Phase 4 反正要上 D1，提前满足同步需求 → Phase 4 自动减负
- 避免架构摇摆（已经有 sqlite-wasm vs Tauri better-sqlite3 两条 future path，再加远程 = 三选一焦虑）

### 实施要点

- `src/db/client.ts` 不再尝试在浏览器跑 SQLite；改成"客户端不持 DB，所有 mutation/query 走 worker RPC"
- worker 通过 `[[d1_databases]] binding = "DB"` 拿 D1 connection
- 用 `drizzle-orm/d1` adapter
- migration 走 `drizzle-kit generate` + `wrangler d1 migrations apply`
- client side：TanStack Query 缓存 + 乐观更新管 UI state；不持本地 DB

### Trade-off

- 弱网体验差（移动端实测后再补 cache）
- 离线录入消失 — 自用场景影响有限
- 数据全在 Cloudflare，但有定期 export（Phase 1 checklist 已列"数据导出"）兜底

### 文档改动

- `docs/architecture.md § 六 技术栈` 把"本地存储 = OPFS-backed sqlite-wasm"改成"Phase 1 = D1 远程；Phase 4 = D1 + PWA cache 离线层；Phase 3 Tauri 端用 better-sqlite3 镜像"
- `README.md` 同步技术栈表

---

## 改进 2：Worker 加 shared-secret auth

### 决策

`/api/*` 路径加中间件，要求 `X-Internal-Token` header 与 `INTERNAL_TOKEN` 环境变量匹配。

### Why

- Worker endpoint 公开 → 任何人扫到都能 burn 你 Anthropic 配额
- 自用工具不需要 Cloudflare Access（要 OAuth、要域名挂托管，过重）
- 一个 long random shared secret 能挡掉 99% bot scan

### 实施要点

```ts
// workers/src/index.ts
app.use('/api/*', async (c, next) => {
  const token = c.req.header('x-internal-token');
  if (token !== c.env.INTERNAL_TOKEN) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});
```

- `workers/.dev.vars` 加 `INTERNAL_TOKEN=<long-random>`（git ignore）
- 部署用 `wrangler secret put INTERNAL_TOKEN`
- 客户端走 `import.meta.env.VITE_INTERNAL_TOKEN`，build time 注入
- `src/ai/client.ts` 在 fetch headers 里塞这个 token

### 已知局限

- VITE_ env var 会暴露到浏览器 bundle，view source 看得到
- 这层 auth 实际上只挡 bot scan，挡不住决心攻击者
- 真要严起来 → Phase 4 上 Cloudflare Access

---

## 改进 3：Phase 1 闭环再瘦身（拆 Phase 1a / 1b）

### 决策

把当前 60+ 条 Phase 1 checklist 拆成两子段，1a 是「能上手」MVP，1b 是「补完」。

### Phase 1a · 最小可用（目标 5-7 天上手）

- DB driver 接 D1
- Worker auth 中间件
- Knowledge schema seed（文言文课标 import + AI 自动建议节点的人工确认 UI）
- Question + Mistake schema 接通 D1
- **manual** 录入页（粘贴题面 / 参考答案 / 错答 / 知识点 dropdown）
- AttributionTask 接通（10 类 cause + AI 自动归因 + 失败兜底走"待人工归因队列"）
- FSRS 复习队列（一个 OSS lib 搞定，如 `ts-fsrs`）+ 简陋复习 UI
- LearningItem 简化版（仅 pending / in_progress / done 三态走通；6 状态字段保留 schema，状态机本身先简化）
- AI Task runner 骨架（接通 AttributionTask 时顺手做最小版本：单 task / 单 provider / 写 ToolCallLog + CostLedger；多 task fallback chain 推 1b 或 Tier 2）

### Phase 1b · 补完（1a 跑出第一周数据后做）

- vision_single 录入路径（视觉模型 + 一击确认页）
- tool_quiz embedded check（Phase 1 quiz 骨架最小落地）
- StudyLog 录入入口（错题 / 题目 / note 旁批"+ 写学习日志"按钮）
- LearningItem 6 状态完整 + 优先级 score 公式
- AI 主动提议完成（DreamingProposal.kind=learning_item_completion）

### 推到 Phase 1.5+

- vision_paper（已是 Phase 1.5）
- reverse_mark（依赖 Note UI，本来就 Phase 2）
- LearningItem 复学机制 / hub status 自动聚合（Phase 2，依赖 dreaming）

### Why

- 当前 Phase 1 checklist 一周做不完，会陷入"一直在搭基础设施，没用过"困境
- "30 秒手动录一题 + 错因 + 明天能复习"的最小闭环 1a 5-7 天能上手
- 拿到第一周数据再迭代，避免设计-数据脱节
- 6 状态机 / Hub status 聚合 / 优先级公式都依赖"用了一段时间才知道权重对不对"，1a 不上无损

### 文档改动

- `PLANNING.md § Phase 1` 拆 1a / 1b 两段；保留模块文档 Phase 1 总观不变
- 各模块文档"已定 / 待 push"不动

---

## 改进 4：用 drizzle-zod 单一来源

### 决策

`drizzle-zod` 自动从 Drizzle 表生成 base Zod schema；`src/core/schema.ts` 只手写业务 union / refinement / cross-table validation。

### Why

- 现在 `src/core/schema.ts`（Zod）和 `src/db/schema.ts`（Drizzle）字段对齐靠人工，第一周改字段必漏
- `drizzle-zod` 是 Drizzle 团队维护的官方 OSS（符合"用 OSS 解成熟问题"偏好）
- 单测可以直接用生成的 schema 验证 DB roundtrip

### 实施要点

- `pnpm add drizzle-zod`
- `src/core/schema.ts` 拆两块：
  - 一个 generated 入口（用 `createInsertSchema` / `createSelectSchema` 自动生成）
  - 一个 business 入口（在 generated 上 `extend()` 收紧 enum / 加 refinement）
- 现有手写 Zod 中"业务 union 类"（如 `CauseCategory` enum、`MistakeStatus` enum、`Cause` 复合 schema 这种 JSON 内层结构）保留
- 现有手写 Zod 中"和 db 表字段一对一"的部分（如 `Knowledge` 顶层字段）改为 generated

### 风险

- drizzle-zod 在 nullish / json column 上的具体行为需要 verify（可能需要手动 cast）
- 实施时如发现 generated schema 不够精确，逐字段 `extend()` 收紧

### 验证

- 改完后 typecheck 必须通过
- 手写一份 Knowledge / Question / Mistake 的 insert + parse 单测，roundtrip 通过

---

## 改进 5：代码进库 + 配置补全

### 决策

创建一个 scaffold commit 把现有未追踪的代码全部进库，同时补缺的配置文件。

### 缺失文件清单

1. `workers/wrangler.toml`：

```toml
name = "the-learning-project-api"
main = "src/index.ts"
compatibility_date = "2026-04-01"
compatibility_flags = ["nodejs_compat"]

# Phase 1 D1 binding（database_id 创建后填）
[[d1_databases]]
binding = "DB"
database_name = "learning-project"
database_id = "<TBD-after-d1-create>"
```

2. `workers/.dev.vars.example`：

```
ANTHROPIC_API_KEY=sk-ant-xxx
INTERNAL_TOKEN=<generate-with: openssl rand -hex 32>
```

3. `.env.example` 补 `VITE_INTERNAL_TOKEN=<same-as-workers/.dev.vars>`

### Commit 内容

`chore: scaffold Phase 1 skeleton`

包含：

- 修改：`.gitignore`
- 新增：`README.md` / `package.json` / `biome.json` / `drizzle.config.ts` / `vite.config.ts` / `tsconfig.json` / `index.html` / `.env.example`
- 新增：`src/` 全部内容
- 新增：`workers/` 全部 + 新建的 `wrangler.toml` + `.dev.vars.example`

### Why

- 9 个 commit 都是 doc，所有代码 untracked → 没有起点 commit 后续重构无锚
- `wrangler.toml` 不在的话 `pnpm workers:dev` 直接报错
- `.dev.vars.example` 给后续协作（包括三月后的自己）一个 onboarding 锚

---

## 顺序 + 依赖

```
[改进 5: 进库 + wrangler.toml]
  → [改进 1 + 2: D1 + Worker auth] 一个 PR 做（都改 worker）
    → [改进 4: drizzle-zod] （独立纯重构，可并行）
      → [改进 3: Phase 1 拆分文档改动] （前面落地后再调路线图）
```

- 改进 5 必先：commit 锚点
- 改进 1 + 2 强相关，建议合并一个 PR
- 改进 4 是纯重构，可在改进 1+2 之前或之后插入
- 改进 3 是文档改动，最后做（前面真落地了再写 1a/1b 路线）

---

## 完成标准

| Item | Done 标志 |
| --- | --- |
| 1. D1 路线 | `pnpm workers:dev` 起来 + client 能从 D1 读到 seed knowledge node |
| 2. Worker auth | curl 不带 header 返 401；带正确 header 通过 |
| 3. Phase 1 拆分 | PLANNING.md § Phase 1 拆 1a / 1b；1a checklist 每条单天内完成 |
| 4. drizzle-zod | core/schema 不再与 db/schema 重复定义字段；typecheck + roundtrip 单测通 |
| 5. 进库 | git log 看到 scaffold commit；wrangler.toml + .dev.vars.example 在仓库 |

---

## Open questions（实施时再决）

- D1 production database id：等用户 `wrangler d1 create` 后填
- INTERNAL_TOKEN 生成策略：脚本一次生成 + 同步 client/server，还是 wrangler secret put 后人工同步到 .env
- drizzle-zod 在 json column / nullish 上的具体生成结果：实施时 verify
- Phase 1a 跑通后，下一步是 Phase 1b 还是直接跳 Phase 1.5（批改识别）？等数据出来再决，不在本 spec 范围
