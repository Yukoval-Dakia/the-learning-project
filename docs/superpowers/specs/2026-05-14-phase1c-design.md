# Phase 1c Design Spec — Encounter / Session 抽象 + UI 闭环

**Date**: 2026-05-14
**Status**: spec — D1 用户 grill 修订完成（2026-05-14），D2 顺带修订（与 D1 耦合），D3/D4/D5 待 grill
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

### D3 (← Q3)：source_kind 占位字段，image only 实质实现

> **可推翻** — 占位字段成本低，但定义其值域是一次设计承诺。

**选定**：

- `ingestion_session` 加 `source_kind text NOT NULL DEFAULT 'image'` 列
- 值域：`'image' | 'pdf' | 'audio' | 'video' | 'clipboard' | 'file'`
- 仅 `'image'` 通过；其他 throw `'not_implemented'`

避免现在做多模态 ingestion 重构（Sub 0c 刚定下 image-only 假设），但**给未来留口子不重谈契约**。

### D4 (← Q4)：goal trail 延后到 Phase 1d

> **可推翻** — 但加 goal 在没 UI 数据时是猜。

**选定**：不引入 `goal` / `plan` / `progress` 实体。Phase 1c 收尾后看用户行为数据是否暗示需要"为什么学"语义层，再开 Phase 1d goal trail spec。

### D5 (← Q5)：单用户假设明文化为 ADR-0006

> **可推翻** — 但多用户 retrofit 成本极高。

**选定**：

- 写 ADR-0006《单用户假设 + 多用户回滚成本》
- 明确：`user_id` 不进 schema、`x-internal-token` 是边界、export/import 是"换设备"路径
- 触发条件：如果未来要分享、协作、或合规多账户，认了"重做 schema + auth + middleware"成本

---

## 三阶段实施（按依赖排序，**2026-05-14 D1 修订后**）

### Phase 1c.1: encounter 全量重构 + UI 脚手架（~6-10 day）

**前置**：Sub 0c **完全 merge**（不可与 1c.1 同时改 schema）。

**Schema 一次到位（详见 D1 修订）**：

- 新建 `encounter` 表（含 `outcome` / `material_ref` / `evidence` jsonb / `knowledge_ids` / `source` / `status`）
- 数据迁移：`mistake` → `encounter`（每行 outcome='wrong'、evidence 重组）
- DROP `mistake` 表（无兼容 view）
- per-outcome `evidence` Zod schema（`src/core/schema/encounter.ts`）

**Code 全量 rename**：

- `src/server/knowledge/{attribute,propose,review}.ts`：所有 mistake 引用 → encounter
- `app/api/mistakes/` → `app/api/encounters/`
- `app/api/ingestion/[id]/import/route.ts`：插入 encounter(outcome='wrong') 而非 mistake
- AI prompts：registry.ts 中 "错题" / "mistake" 文案改为"做错的 encounter" 或"答错"——保留中文领域语义，不强行直译
- `src/server/export/csv.ts`：CSV 列名同步
- 全部测试：~10 个 test 文件 mistake → encounter

**UI 脚手架**：

- `app/page.tsx` 占位 → "Home" 路由壳
- 状态管理：Zustand
- 数据 fetch：TanStack Query setup
- styling：Tailwind v4（CSS-first）+ design tokens
- 组件库：**待 grill**（自建 vs shadcn）

**产出**：encounter 是干净的 first-class entity；UI 框架就位；任何 1c.2 UI 长在新 schema 上。

### Phase 1c.2: UI 主切片（~5-7 day）

**5 个页面（按价值排）**，**长在 encounter 上**：

1. **`/review`**（最高价值）：FSRS due queue → encounter prompt → 答 → judge → 反馈含 evidence.cause。**让 attribution 终于到达用户眼前**。
2. **`/inbox`**：SSE-driven 抽取进度 → 块编辑 / 合并 / 拆分 → 一键 import（生成 encounter outcome='wrong'）。
3. **`/capture`**：拍照上传入口 → enqueue ingestion session → redirect inbox。
4. **`/knowledge`**：read-only 知识树浏览。点节点 → 看挂在它下面的 encounters。
5. **`/history`**：session 列表（仅 ingestion session；扩到全 session type 在 1c.3）。

**Schema**: 不动。
**API**: 仅补漏 query 参数 / list endpoint，不开新主线。

**产出**：Phase 1 闭环可演示。

### Phase 1c.3: learning_session envelope + artifact 决断（~3-5 day）

> 修订后 1c.3 **收窄**：encounter 多态已在 1c.1 落定，本步只剩 R5 + artifact。

**前置**：1c.2 完成。

**Schema**:

- 新表 `learning_session`：
  - `type text NOT NULL`（`ingestion | review | tutor | explore | create | conversation`）
  - `status text` / `started_at` / `ended_at` / `summary_md text` / `goal_id text NULL`
- `ingestion_session` 改名 → `learning_session` row WHERE type='ingestion'（数据迁移 + DROP 老表）
- `artifact` 表决断：保留 / 删除 / 重塑（**待 grill**——与 `material_ref kind='artifact'` 关系决定）

**Code**:

- ADR-0005 的 `IngestionSession` 模块演化为 `LearningSession` 多态模块（type-driven 状态机分支，内部仍单一所有者）
- review submit 同时写一条 `learning_session(type='review')`
- `/history` 扩到全 session type

**产出**：通用 session envelope；artifact 命运拍板；CONTEXT.md 提议词条转正式。

**产出**: schema 真正承载"通用学习框架"概念；后续 tutor / coach / explore 角色有 session 落点。

---

## Schema 改动一览（**D1 修订后**）

| 阶段 | 改动 | 风险 |
|---|---|---|
| 1c.1 | 新建 `encounter` 表（含 `outcome` / `material_ref` / `evidence` jsonb）；migrate `mistake` → `encounter`；DROP `mistake`；加 `ingestion_session.source_kind` 列 default `'image'`；per-outcome Zod schema | **高**——大型 migration + 全栈 rename + per-outcome evidence schema 守护 |
| 1c.2 | 无 schema 改动 | 低 |
| 1c.3 | 新表 `learning_session`；migrate `ingestion_session` → `learning_session`；artifact 表决断 | 中——migration + IngestionSession 模块演化为 LearningSession 多态 |

---

## 风险与回滚

1. **UI 是新栈**——`src/ui/` 空，需建组件库 + 数据 fetch + 状态管理三大约定。**回滚成本低**（UI 是新的，可任意推翻）。
2. **encounter 全量重构触面巨大**——~15 个 server / AI 文件 + ~10 个 test 同时改。**缓解**：在 worktree 推；migration 单独 commit；mechanical rename 与 schema design 分两层 commit。**回滚**：drizzle migration 反向恢复 `mistake` 表，复原 evidence 拆字段。
3. **outcome 多态若做错**会让 schema 长成"什么都能塞"的 jsonb 黑洞。**缓解**：per-outcome Zod schema 守 evidence 形状（参考 ADR-0002 的 `extraction_evidence` 模式）；evidence schema 单独的 test 文件覆盖所有 outcome × 字段组合。
4. **Sub 0c 未 merge → 1c.1 阻塞**。期间可推进：spec / ADRs / UI 脚手架（不动 schema 的部分）。
5. **D5 单用户假设 + encounter 重构同时落地** —— ADR-0006 / 0007 应在 1c.1 开干**之前**写完，避免 schema 长出之后再回头补 ADR。

---

## 待 grill / 待决

- **UI 组件库选型**：自建 vs shadcn。前者更可控、后者更快。**Sub-grill 后单写一份 spec addendum**。
- **artifact 表命运**：1c.3 拍板（与 `material_ref kind='artifact'` 关系）。
- **R5 多 type 一开始建几个**：spec 写 6 种，1c.3 仅实现 ingestion + review。其他 type 是 enum 占位还是延后加？倾向：**enum 全写、行为延后**。
- **D1 修订引出的新问题**：用户 "没时间等上线后再改" 的逻辑也适用于 R5——learning_session 是否应该并入 1c.1 而非 1c.3？倾向：**不并入**——learning_session 与 encounter 解耦（encounters 可独立存在），1c.1 已经很重，再叠 R5 会让单 PR 过 10 天。但本条**待与你 grill 后定**。

---

## ADRs（待写）

- **ADR-0006**：`encounter` 替换 `mistake` 为 first-class learning event（D1 已拍板，可起草）
- **ADR-0007**：单用户假设明文化 + 多用户回滚成本（D5 拍板后写）
- **ADR-0008**（可选）：`learning_session` 多态 envelope 模式（1c.3 开干前写）

---

## 下一步

1. **用户继续 grill D2-D5**（D1 已 grill+修订）—— 任一推翻则 spec 再修订
2. D5 拍板后起 ADR-0006 + ADR-0007 草稿
3. 拆 → 两份 plan（1c.3 暂缓拆，等 1c.1/1c.2 收尾再起）：
   - `docs/superpowers/plans/2026-05-1X-phase1c1-encounter-and-ui-scaffold.md`
   - `docs/superpowers/plans/2026-05-1X-phase1c2-ui-main.md`
4. 等 Sub 0c merge → 开 worktree 推 1c.1
