# Phase 1c Design Spec — Encounter / Session 抽象 + UI 闭环

**Date**: 2026-05-14
**Status**: spec — 2026-05-14 全 grill 完成；**2026-05-15 loom design 对齐 addendum** 见 [`2026-05-15-phase1c-loom-design-addendum.md`](./2026-05-15-phase1c-loom-design-addendum.md)。addendum 覆盖 D2（UI 顺序）+ D6（drop shadcn → 用 loom Primitives）+ 新增 D9（design tokens lift 进 Tailwind v4 `@theme`）；不动 D1/D3/D4/D5。
**Brainstorm**: `docs/superpowers/brainstorms/2026-05-14-phase1c-encounter-session-ui.md`
**Audit**: `docs/superpowers/audits/2026-05-14-phase1-pre-1c-audit.md`
**Predecessor**: Sub 0c（async lane + Tencent Mark Agent，进行中）

---

## Scope

Phase 1c 同时解决两个耦合问题：

1. **UI 完全为 0**——所有后端在等不存在的用户
2. **架构隐含"错题→改对"范式**——`mistake` 是 first-class entity，与"通用学习框架"愿景冲突

不在范围（Phase 1d+）：多模态 ingestion 实质实现、goal trail、tutor / coach 角色、多用户、mobile-native UI。

---

## 决策（D1-D5，self-grill 答案，每条标"可推翻"）

### D1 (← brainstorm Q1)：encounter 实施 — 一次性 full rename + 多态重构（**修订**）

> **2026-05-14 grill 后修订** —— 原 lite-rename + 渐进多态方案被推翻。理由记下面。

**初版（已废）**：分两阶段——1c.1 lite rename（只改表名 + 加 `outcome` 默认列）、1c.3 outcome 多态。

**初版的三处硬伤**（grill 暴露）：

1. **lite rename 是 type lying**：表叫 `encounter` 但 `wrong_answer_md` / `cause` / `variants` / `variants_max` 等字段只对 `outcome='wrong'` 成立——接口承诺通用、实现强制 mistake-性。
2. **lite rename 的杠杆 ≈ 0**：1c.2 的 UI 只展示 wrongs（review + inbox 都是错题流），rename 不解锁任何 UI 新形态，只是 ~20 个文件的 grep-replace 工作量。
3. **API + SQL 不分两次**：`/api/mistakes` 端点 vs SQL `encounter` 表是半截子；UI 一上来就要被命名锁死思路。

**真正的推翻理由**（用户 2026-05-14 grill）：

> "我们没时间等上线之后再改。现在的一切都是draft，而真实数据要完工后才会有。"

→ "schema 等 UI 反馈再迭代" 的论据**依赖真实使用数据**；本项目在完工前无任何真实数据，反馈循环不存在。**不存在的反馈不能驱动设计**。结论：**做一次就要做对**。

---

**修订选定（a-honest）**：**1c.1 一次性完成 full rename + 多态重构 + API rename**。

**1c.1 schema 改动一次到位**：

- 新表 `encounter`（不是 `mistake` 改名，是新建 + 数据迁移）：
  - `id text PK`
  - `outcome text NOT NULL`，enum `wrong | right | exposed | created | drilled | reviewed`
  - `material_ref jsonb NOT NULL`，`{ kind: 'question' | 'artifact' | 'source_document' | 'free_text', id?: text, text?: text }`
  - `knowledge_ids jsonb`
  - `evidence jsonb NOT NULL`，outcome-specific schema（per-outcome Zod 守护，参考 ADR-0002 `extraction_evidence` 模式）
    - `wrong` → `{ wrong_answer_md, wrong_answer_image_refs, cause }`
    - `right` → `{ answer_md, took_ms? }`
    - `exposed` → `{ duration_ms?, scrolled?: boolean }`
    - `created` → `{ artifact_id, prompt_id? }`
    - `drilled` → `{ variant_of_encounter_id, attempt_outcome }`
    - `reviewed` → `{ source_encounter_id, fsrs_rating }`
  - `source text NOT NULL`，enum `manual | ingest | drill | ...`
  - `status text NOT NULL DEFAULT 'active'`
  - `version int`, `created_at`, `updated_at`
- `mistake` 表数据迁移：每行 `outcome='wrong'`、`evidence = { wrong_answer_md, wrong_answer_image_refs, cause }`、`material_ref = { kind: 'question', id: question_id }`
- `mistake` 表 DROP（不保留兼容 VIEW —— 完工前 draft 数据不值这个长期复杂度）
- 所有引用 `mistake` 的代码：knowledge.attribute / propose / review、import route、export CSV、AI prompts、tests 全部迁到 `encounter`
- API：`/api/mistakes` → `/api/encounters`，`mistakes/recent` → `encounters/recent`

**1c.1 同时做 UI 脚手架**：状态管理 / 组件库 / fetch 模式三大约定。

**1c.1 不做**：

- `learning_session` 多态（R5）—— 这是独立问题，见 D2 grill
- artifact 表命运 —— 同上

**变化对实施计划的影响**：

- 1c.1 从 3-5 天 → **6-10 天**（schema 重构 + 数据迁移 + 全栈 rename + UI 脚手架）
- 1c.2（UI 五页）不变，但**长在新 schema 上**
- 1c.3 收窄为"learning_session envelope + artifact 决断"（不再含 encounter 多态——已并入 1c.1）

### D2 (← Q2)：~~UI 先行（带 lite rename 铺垫）~~ → schema-first，但与 UI 脚手架同 PR

> **2026-05-14 grill 修订**：原 "UI 先 + 后补 rename" 方案随 D1 一起作废。

**修订选定**：

- 1c.1 一个 PR 内：schema 重构 + UI 脚手架（routing / state mgmt / 组件约定）
- 1c.2 UI 五页长在已敲实的 schema 上，零迁移

理由：用户 2026-05-14 grill —— "完工前无真实使用反馈"，所以"UI 先跑、schema 后跟"的迭代逻辑失效。改成"schema 一次做对、UI 在对的 schema 上长"。

### D3 (← Q3)：source_kind 占位字段，image only 实质实现 ✅ ack

> 2026-05-14 ack（无推翻）。占位字段成本低，留口子不重谈契约。

**选定**：

- `ingestion_session` 加 `source_kind text NOT NULL DEFAULT 'image'` 列
- 值域：`'image' | 'pdf' | 'audio' | 'video' | 'clipboard' | 'file'`
- 仅 `'image'` 通过；其他 throw `'not_implemented'`

避免现在做多模态 ingestion 重构（Sub 0c 刚定下 image-only 假设），但**给未来留口子不重谈契约**。

### D4 (← Q4)：goal trail 延后到 Phase 1d ✅ ack

> 2026-05-14 ack。即使 "draft 期无反馈" 也不推翻——goal 是新增概念非修正旧错；1c 已经很重，再叠 goal 会拖到 Phase 1d 该有的位置。

**选定**：不引入 `goal` / `plan` / `progress` 实体。Phase 1c 收尾后看用户行为数据是否暗示需要"为什么学"语义层，再开 Phase 1d goal trail spec。

### D5 (← Q5)：单用户假设明文化为 ADR-0007 ✅ ack

> 2026-05-14 ack（ADR 编号从 0006 改为 0007——0006 让给 encounter）。

**选定**：

- 写 **ADR-0007**《单用户假设 + 多用户回滚成本》
- 明确：`user_id` 不进 schema、`x-internal-token` 是边界、export/import 是"换设备"路径
- 触发条件：如果未来要分享、协作、或合规多账户，认了"重做 schema + auth + middleware"成本

### D6（新增 2026-05-14）：R5 learning_session 并入 1c.1 + artifact 表 DROP ✅ 用户决策

> 用户 D1 grill 后 cascade："并入"——"draft 期无反馈"的论据同样杀掉"1c.3 等 UI 反馈再做 R5"。

**选定**：

- `learning_session` 表与 `encounter` **同 PR 落地**（1c.1）
- `IngestionSession` 模块（ADR-0005）一次演化为 `LearningSession` 多态模块
- `ingestion_session` 表迁移到 `learning_session WHERE type='ingestion'`（DROP 老表）
- **`artifact` 表 DROP**——零调用 verified；material_ref enum **不**含 `kind='artifact'`（未来要 artifact 时新建表 + 加 enum value，drizzle migration 是机械的）

**1c.3 phase 消失**——所有 schema 改动并入 1c.1，Phase 1c **两阶段**结构：1c.1（schema + UI 脚手架）→ 1c.2（UI 五页）。

---

## 两阶段实施（按依赖排序，**2026-05-14 D1/D6 修订后**）

> 原 1c.3 阶段被吸收进 1c.1。所有 schema 改动一次到位。

### Phase 1c.1: encounter + learning_session 全量重构 + UI 脚手架（~10-14 day）

**前置**：Sub 0c **完全 merge**。

**Schema 一次到位**：

- **新表 `encounter`**：
  - `outcome` enum: `wrong | right | exposed | created | drilled | reviewed`
  - `material_ref jsonb`: `{ kind: 'question' | 'source_document' | 'free_text', id?, text? }`（**不**含 `'artifact'` —— D6 ack DROP artifact 表）
  - `evidence jsonb` —— per-outcome Zod schema 守护
  - `knowledge_ids jsonb` / `source` / `status` / `version` / timestamps
- **新表 `learning_session`**：
  - `type` enum: `ingestion | review | tutor | explore | create | conversation`（行为只实现前两个，其他 enum 占位）
  - 每 type 一套 status enum（type-driven 状态机）
  - `started_at` / `ended_at` / `summary_md` / `goal_id NULL`
- **数据迁移**：
  - `mistake` → `encounter`（每行 outcome='wrong'）
  - `ingestion_session` → `learning_session(type='ingestion')`
- **DROP**：`mistake` / `ingestion_session` / **`artifact`**（zero-callers verified）

**Code 全量 rename + 模块演化**：

- `src/server/knowledge/{attribute,propose,review}.ts`：mistake → encounter
- `app/api/mistakes/` → `app/api/encounters/`
- `app/api/ingestion/[id]/import/route.ts`：插入 `encounter(outcome='wrong')`
- AI prompts：registry.ts 中 "错题"/"mistake" 文案改为语义对齐版（保留中文领域语义）
- `src/server/export/csv.ts`：列名同步
- **`src/server/ingestion/session.ts`（ADR-0005）演化为 `src/server/session/`** 多态模块：
  - `LearningSession.<type>.applyXxx(...)` 多态接口
  - type='ingestion' 子状态机原样搬来（uploaded → queued → ... → imported）
  - type='review' 子状态机新建（最小：started → completed | abandoned）
  - 单一所有者 invariant 保留 + 升级到全 session type
- `review/submit` 路由插入 `learning_session(type='review')` + `encounter(outcome='reviewed')`
- 全部测试：~15 个 test 文件 mistake/ingestion_session → encounter/learning_session

**UI 脚手架**：

- `app/page.tsx` 占位 → "Home" 路由壳
- 状态管理：Zustand
- 数据 fetch：TanStack Query setup
- styling：Tailwind v4（CSS-first）+ design tokens
- 组件库：**待 grill**（自建 vs shadcn）

**ADRs 前置写完**（plan 开干前）：

- **ADR-0006**：encounter 替换 mistake
- **ADR-0007**：单用户假设
- **ADR-0008**：LearningSession 多态 envelope（ADR-0005 演化）

**产出**：encounter + learning_session 双 first-class entity；artifact 表清掉；UI 框架就位。

### Phase 1c.2: UI 主切片（~5-7 day）

**5 个页面（按价值排）**，**长在新 schema 上**：

1. **`/review`**（最高价值）：FSRS due queue → encounter prompt → 答 → judge → 反馈含 evidence.cause。**让 attribution 终于到达用户眼前**。
2. **`/inbox`**：SSE-driven 抽取进度 → 块编辑 / 合并 / 拆分 → 一键 import（生成 encounter outcome='wrong'）。
3. **`/capture`**：拍照上传入口 → enqueue ingestion session → redirect inbox。
4. **`/knowledge`**：read-only 知识树浏览。点节点 → 看挂在它下面的 encounters。
5. **`/history`**：session 列表（**已支持全 session type** —— ingestion + review；其他 type 待行为实现后自然出现）。

**Schema**: 不动。
**API**: 仅补漏 query 参数 / list endpoint。

**产出**：Phase 1 闭环可演示。

**产出**: schema 真正承载"通用学习框架"概念；后续 tutor / coach / explore 角色有 session 落点。

---

## Schema 改动一览（**D1 / D6 修订后，两阶段**）

| 阶段 | 改动 | 风险 |
|---|---|---|
| 1c.1 | 新表 `encounter`（outcome / material_ref / evidence jsonb）；新表 `learning_session`（type 多态）；加 `ingestion_session.source_kind`（迁移前过渡）；migrate `mistake` → `encounter` + `ingestion_session` → `learning_session`；**DROP** `mistake` / `ingestion_session` / `artifact`；per-outcome + per-session-type Zod schema | **极高**——重大 migration + 全栈 rename + 模块演化 + 多 ADR 同步 |
| 1c.2 | 无 schema 改动 | 低 |

---

## 风险与回滚

1. **UI 是新栈**——`src/ui/` 空，需建组件库 + 数据 fetch + 状态管理三大约定。**回滚成本低**。
2. **1c.1 触面巨大**——~20 个 server / AI 文件 + ~15 个 test 同时改，加新表 2 张、DROP 3 张。**缓解**：
   - 在 worktree 推；migration / mechanical rename / 模块演化 分多个 commit
   - drizzle migration 必须做完整测试 round-trip（migrate up + 自测 + migrate down 恢复原状）
   - 在 sub-0c 完全 merge **之后**才开始
3. **outcome / session_type 多态若做错** 会让 schema 长成 jsonb 黑洞。**缓解**：per-outcome 与 per-session-type 都有专门 Zod schema 守护（参考 ADR-0002 `extraction_evidence` 模式）；每种组合至少 1 个测试覆盖。
4. **三份 ADR 同时演进** ——ADR-0005 被 ADR-0008 演化（IngestionSession → LearningSession）；新增 ADR-0006（encounter）+ ADR-0007（单用户）。**纪律**：1c.1 plan 开写**之前**三 ADR 全部 commit。
5. **Sub 0c 未 merge → 1c.1 阻塞**。期间可推进：ADR-0006/0007/0008 起草、UI 脚手架原型、组件库选型 grill。

---

## 待 grill / 待决（剩余）

- ~~**UI 组件库选型**：自建 vs shadcn~~ ✅ **2026-05-14 self-grill 拍板 shadcn**——理由：（1）契合"用成熟 OSS"原则（CLAUDE.md）；（2）copy-paste 模式不是 npm lock-in，装完拥有；（3）Claude Code 有 `vercel:shadcn` skill + `frontend-design` skill 按 shadcn 形状训练。若审美太"AI 默认味"，用 frontend-design skill 改 Tailwind tokens + 组件 variant 一晚搞定独特感。
- ~~**R5 enum 占位 vs 延后加**~~ ✅ **spec 内已答**：enum 全写、行为延后（per "draft 期一次做对" 原则）。

---

## ADRs（前置任务）

- **ADR-0006**：`encounter` 替换 `mistake` 为 first-class learning event（D1 拍板，**起草**）
- **ADR-0007**：单用户假设明文化（D5 拍板，**起草**）
- **ADR-0008**：`LearningSession` 多态 envelope（D6 拍板，**起草**；演化 ADR-0005）

---

## 下一步

1. **起 ADR-0006 + 0007 + 0008**（本 spec 决策的归档）
2. **拆 plan**：
   - `docs/superpowers/plans/2026-05-14-phase1c1-encounter-session-ui-scaffold.md`（重头戏，~10-14 day）
   - `docs/superpowers/plans/2026-05-14-phase1c2-ui-main.md`（轻，~5-7 day，待 1c.1 落定再细化）
3. 等 Sub 0c merge → 开 worktree 推 1c.1
4. （等 1c.2 推进时）UI 组件库选型 + enum 完整性 grill
