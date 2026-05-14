# Phase 1c.1 Implementation Plan — encounter + learning_session 全量重构 + UI 脚手架

> **Status**: sketch（高层 step 已敲定；TDD 红/绿子步待开干前细化）。
>
> **For agentic workers**：开干前请补 TDD substeps（参考 sub-0c plan 的 X.1 (red) / X.3 (green) / X.5 (commit) 模式），且**必须**先确认 Sub 0c 已 merge 到 main。

**Goal**：把 Phase 1c 的双 first-class entity（`encounter` + `learning_session`）一次性落地——schema、数据迁移、server code rename、模块演化、API rename、AI prompts、测试，外加 UI 脚手架（让 1c.2 五页有家可回）。Phase 1c.1 收尾时：mistake / ingestion_session / artifact 三张表 DROP，新 schema 长成，UI 框架可见 health 页面。

**Spec**：`docs/superpowers/specs/2026-05-14-phase1c-design.md`

**ADRs**：
- ADR-0006（encounter 替换 mistake）
- ADR-0007（单用户假设）
- ADR-0008（LearningSession 多态 envelope）
- 演化 ADR-0005（IngestionSession single-owner → LearningSession single-owner）

**前置（不可妥协）**：Sub 0c 完全 merge 到 main。`git log main --oneline` 含 sub-0c 收尾 commit；CI 绿。

**预估**：10-14 d 单人推进，13 个 Step。

---

## Step 0: 准备 + 工作树 + 依赖

- 检查 `git status` 干净；从 main 起新分支 `phase1c1-implementation`
- 起 worktree（参考 superpowers `using-git-worktrees` skill）
- `pnpm install` 干净，无新依赖（理论上）
- 启 `pnpm db:push` against testcontainer 验证起手 schema 与 main 一致
- Commit 占位：分支创建 + worktree 配置

---

## Step 1: 新 schema — `encounter` + `learning_session` 表（DDL only，**不动**旧表）

在 `src/db/schema.ts` 加：

```typescript
export const encounter = pgTable('encounter', {
  id: text('id').primaryKey(),
  outcome: text('outcome').notNull(),  // wrong | right | exposed | created | drilled | reviewed
  material_ref: jsonb('material_ref').$type<MaterialRefT>().notNull(),
  knowledge_ids: jsonb('knowledge_ids').$type<string[]>().notNull().default([]),
  evidence: jsonb('evidence').$type<EvidenceT>().notNull(),
  source: text('source').notNull(),
  status: text('status').notNull().default('active'),
  version: integer('version').notNull().default(0),
  created_at, updated_at, ...
});

export const learning_session = pgTable('learning_session', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),  // ingestion | review | tutor | explore | create | conversation
  status: text('status').notNull(),  // per-type 状态机
  source_document_id: text('source_document_id'),  // 仅 type='ingestion'
  // ... 其他 ingestion 字段（source_asset_ids / entrypoint / error_message / warnings 等）
  // 各 type 自己用到的列允许 NULL，其他 type 不碰
  started_at: timestamp('started_at', { withTimezone: true }).notNull(),
  ended_at: timestamp('ended_at', { withTimezone: true }),
  summary_md: text('summary_md'),
  goal_id: text('goal_id'),  // 占位，Phase 1d
  ...
});
```

`pnpm db:generate` 出 migration；不动 `mistake` / `ingestion_session` / `artifact`。

`pnpm test` 期望 全绿（schema 新增不破坏现有）。

Commit：`feat(1c.1): add encounter + learning_session tables (drizzle DDL, no data yet)`

---

## Step 2: per-outcome + per-session-type Zod schemas

在 `src/core/schema/` 新建 `encounter.ts` 与 `learning_session.ts`：

- `EncounterOutcome` enum
- `MaterialRef` polymorphic Zod schema（kind discriminant）
- `EvidenceByOutcome` discriminated union：
  - `wrong` → `{ wrong_answer_md, wrong_answer_image_refs, cause }`
  - `right` → `{ answer_md, took_ms? }`
  - `exposed` → `{ duration_ms?, scrolled?: boolean }`
  - `created` → `{ artifact_ref?, output_md? }`（**注**：artifact 表已 DROP，此 ref 暂为 free-text id 字符串）
  - `drilled` → `{ source_encounter_id, attempt_outcome }`
  - `reviewed` → `{ source_encounter_id, fsrs_rating }`
- `LearningSessionType` enum
- `LearningSessionStatusByType` discriminated union（per-type 状态机 enum）

Test：每种 outcome × evidence 组合至少 1 个 parse 用例；非法组合（如 outcome='wrong' 但 evidence shape='right'）必须拒绝。

Commit：`feat(1c.1): per-outcome / per-session-type Zod schemas`

---

## Step 3: 数据迁移脚本（mistake → encounter，ingestion_session → learning_session）

写 `scripts/migrate-phase1c1.ts`（参考 Sub 5 export/import 风格）：

- 读 `mistake` 全表 → 每行映射：`outcome='wrong'`、`material_ref={kind:'question', id:question_id}`、`evidence={wrong_answer_md, wrong_answer_image_refs, cause}` → INSERT 进 `encounter`
- 读 `ingestion_session` 全表 → 每行映射：`type='ingestion'`、`status` 平移、其他 ingestion-specific 列对齐 → INSERT 进 `learning_session`
- **未做**：DROP 旧表（留给 Step 9）

测试：建一个 fixture mistake + ingestion_session → 跑 migration → 验证新表行符合预期 + 旧表数据不变。

Commit：`feat(1c.1): data migration script — mistake/ingestion_session → encounter/learning_session`

---

## Step 4: Server 端 rename — mistake → encounter（**Big Bang**）

机械化批量替换（**不**修改逻辑）：

- `src/server/knowledge/attribute.ts`：`mistake` 表引用 → `encounter` 表；写入时 `outcome='wrong'`、cause 入 `evidence.cause`
- `src/server/knowledge/propose.ts`：同上
- `src/server/knowledge/review.ts`：query mistake → query encounter（仍 filter outcome='wrong'）
- `src/server/export/csv.ts`：encounter 列、evidence 拆出
- 所有 `import { mistake } from '@/db/schema'` → `import { encounter } from '@/db/schema'`
- 全部相关 test 同步改

**注意**：本步**写代码用 encounter 表**，但**老 mistake 表仍未删**（Step 9 删）。在测试里 verify：所有路径只写 encounter，不写 mistake。

`pnpm test` 全绿；`grep -r "table.*mistake\|from.*mistake\b" src/ app/` 期望仅在迁移脚本中出现。

Commit（可分多 sub-commit）：`refactor(1c.1): server rename mistake → encounter (knowledge / export)`

---

## Step 5: IngestionSession 模块演化 → `src/server/session/`

> 这是本 plan 最复杂的一步。参考 ADR-0008 的演化路径。

- 新建 `src/server/session/index.ts` —— 多态入口
- 新建 `src/server/session/ingestion.ts` —— 把 `src/server/ingestion/session.ts` 的实现搬过来，命名空间改为 `LearningSession.Ingestion.*`
- 新建 `src/server/session/review.ts` —— 最小状态机：`started → completed | abandoned`
- 删 `src/server/ingestion/session.ts`（搬空了）
- 所有调用方（OCR handler / rescue / import route / extract route）改 import `from '@/server/session'`
- API 命名保留 `/api/ingestion/*` 不动（语义本身没变），但内部写 `learning_session(type='ingestion')`
- 单一所有者 invariant verify：grep `db.update(learning_session)` 在模块外应 zero hit；grep `db.update(encounter).*status` 同理

`pnpm test` 全绿。

Commit：`refactor(1c.1): IngestionSession → LearningSession multi-type module (ADR-0005 evolved by ADR-0008)`

---

## Step 6: API rename — `/api/mistakes` → `/api/encounters`

- `app/api/mistakes/route.ts` → `app/api/encounters/route.ts`
- `app/api/mistakes/recent/route.ts` → `app/api/encounters/recent/route.ts`
- POST body schema 调整：客户端可送 `outcome`（默认 'wrong' 向后兼容）+ evidence shape
- 所有 route test 改 path

Commit：`refactor(1c.1): API rename /api/mistakes → /api/encounters`

---

## Step 7: AI prompts + registry 更新

- `src/ai/registry.ts` 各 task system prompt：
  - "错题" 在用户面文案保留（"做错的题目"），但 entity 命名提到 mistake 的统一改 encounter
  - AttributionTask: input 改 encounter shape，output 仍 cause
  - KnowledgeReviewTask: tree snapshot + recent encounters (filter outcome='wrong'，与历史一致)
  - 其他 task 同理
- 测试：AI runner 自测（registry parse + runTask 仍工作）

Commit：`refactor(1c.1): AI prompts + registry — entity rename mistake → encounter`

---

## Step 8: 跑数据迁移（一次性脚本 + 整合到 db:push 流程）

> 严格按顺序：**Step 1-7 已 merge** → 老 mistake/ingestion_session 数据 + 新 encounter/learning_session 空表共存 → 跑迁移。

- Production（NAS）维护窗：手动 `pnpm tsx scripts/migrate-phase1c1.ts` 跑一次
- Dev：写 `tests/global-setup.ts` 钩子，testcontainer 初次 `db:push` 后自动跑（**幂等**：如果 encounter 已有数据则跳过）
- 整合后跑全套测试，**期望全绿**

Commit：`feat(1c.1): execute data migration in test setup + add prod migration script`

---

## Step 9: DROP 旧表 — mistake / ingestion_session / artifact

> 不可逆点。本步**之前**所有代码必须已切到新表。

- Drizzle schema：删除 `mistake` / `ingestion_session` / `artifact` 表定义
- `pnpm db:generate` 出 DROP migration
- 同时 `src/core/schema/generated.ts` 重新 generate（生成的 Zod 类型同步消失）
- 测试 round-trip：跑测试套件 + 全栈 grep `mistake\|ingestion_session\|artifact` 在 schema/migration 外应 zero hit

Commit：`feat(1c.1): DROP mistake / ingestion_session / artifact tables — point of no return`

---

## Step 10: UI 脚手架 — Next.js routing + Zustand + TanStack Query + Tailwind tokens

- 替换 `app/page.tsx` 占位为简单 "Home" 路由（暂不展示真实数据）
- `app/layout.tsx`：globals.css import、TanStack Query Provider、Zustand store provider
- `src/ui/lib/queryClient.ts`：TanStack Query 单例配置
- `src/ui/stores/`：Zustand stores skeleton（先空：session store / encounter store）
- `app/globals.css`：Tailwind v4 + design tokens（CSS-first，sub-grill 阶段先用 minimal palette）
- `app/health/page.tsx`：测试页面，GET `/api/health` 显示 status
- **组件库**：shadcn/ui（2026-05-14 spec 决策）—— `pnpm dlx shadcn@latest init`，先装 minimal set: `button` / `input` / `card` / `dialog`。深度组件（form / tree / sheet 等）按 1c.2 各页面需要时再装。Tailwind tokens 通过 `app/globals.css` 控制 shadcn 色彩 / radius / typography。

`pnpm dev` 启起来；浏览器访问 `/health` 显示 OK。

Commit：`feat(1c.1): UI scaffold — Next.js routing + Zustand + TanStack Query + Tailwind v4 tokens`

---

## Step 11: 烟测 + 验证 invariant

- `pnpm test` 全绿
- `pnpm typecheck` 全绿
- `pnpm lint` 全绿
- grep 健康度：
  - `mistake` 在 src / app 内零 hit
  - `ingestion_session` 在 src / app 内零 hit（migration 脚本除外）
  - `artifact` 在 src / app 内零 hit
  - `db.update(learning_session)` 仅在 `src/server/session/` 出现
  - `db.update(encounter).*status` 同上
- 集成测试：跑一次完整 ingestion → import → encounter 创建 → review submit → encounter outcome='reviewed' 写入

Commit：`test(1c.1): single-owner invariant verified across encounter + learning_session`

---

## Step 12: docs — architecture.md + CONTEXT.md provisional → final

- `docs/architecture.md`：
  - "录入会话状态机" 章节 → 升级为 "学习会话 (LearningSession) 多态状态机"
  - 加 "encounter — first-class learning event" 章节
  - 删除任何 "mistake 是学习记录核心" 的描述
- `CONTEXT.md`：
  - "提议中" 节标题改为 "核心实体（Phase 1c.1 后正式生效）"
  - 删除 provisional 标记
  - "错题（mistake）" 旧词条 → 改为 "encounter (outcome='wrong')" 的别名注解
- `README.md`：如有提到 mistake 的，同步更新

Commit：`docs(1c.1): architecture.md + CONTEXT.md — encounter / learning_session promoted to canonical`

---

## Step 13: PR

```bash
gh pr create --title "Phase 1c.1: encounter + learning_session full restructure + UI scaffold" \
  --body "$(cat <<'EOF'
## Summary
- Phase 1c.1 实现 spec docs/superpowers/specs/2026-05-14-phase1c-design.md
- ADRs: 0006 (encounter) / 0007 (single-user) / 0008 (LearningSession)
- mistake / ingestion_session / artifact 三表 DROP；encounter + learning_session 取代
- IngestionSession 模块 (ADR-0005) 演化为 LearningSession 多态模块 (ADR-0008)
- UI 脚手架就位，1c.2 五页可以开始落

## Test plan
- [ ] pnpm test 全绿
- [ ] pnpm typecheck 全绿
- [ ] grep verify: mistake/ingestion_session/artifact 在 src/app/ 零 hit
- [ ] 集成测试: ingestion → import → encounter → review 全链路
- [ ] pnpm dev + 浏览器 /health 显示 OK

🤖 Generated with Claude Code
EOF
)"
```

---

## Notes / 防踩坑

- **Step 9 是不可逆点**：DROP 之前所有代码必须切干净；建议 Step 9 前在 worktree 内做一次"假装我已经 merge"自测
- **rename touch 面太广不要试图一次 commit**：Step 4 / 6 / 7 各自可拆 2-3 个 sub-commit（按文件域分）便于 review
- **Step 5 模块演化最易出错**：建议在 worktree 内单独建子分支推 Step 5、稳定后 rebase 回主分支
- **测试 fixture 大概 ~15 个文件改**：用 codemod 工具（如 ts-morph）批量处理可省时
- **Phase 1c.2 plan 等本 plan 落定后再细化**：等 1c.1 PR merge 时 UI 脚手架就位，再起 `docs/superpowers/plans/2026-05-XX-phase1c2-ui-main.md`

---

## TBD: TDD 子步细化

本 plan 是 sketch。开干前应：

1. 用 `superpowers:writing-plans` skill 把每个 Step 拆成 X.1 (red test) / X.2 (verify fail) / X.3 (green impl) / X.4 (verify pass) / X.5 (commit) 五子步
2. 标注每个测试文件 path 和测试名
3. 跑一次"用 plan 落地"演练（在 disposable worktree 上）评估真实工时
