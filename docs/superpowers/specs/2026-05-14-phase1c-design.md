# Phase 1c Design Spec — Encounter / Session 抽象 + UI 闭环

**Date**: 2026-05-14
**Status**: spec（self-grill 完成，待用户 ack / override）
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

### D1 (← brainstorm Q1)：encounter 实施 — 阶段式 rename + 渐进重构

> **可推翻** — 三选一的 (a)，但伴随显著工作量。

**选定 (a) rename in place + 渐进字段扩展**，理由：

- 项目品味偏 single-owner / no-duplication（见 ADR-0005），(b) 双表共存违反；(c) 视图是半截子方案，长期束缚。
- Sub 0c 是这个码库历史上最大的一次 schema 改动；下一个大改 == Phase 1c。**改名 + 加列**比"先复制再迁移"便宜。
- 重命名是机械的（grep + sed + drizzle migration），不是 risk vector；**真正的 risk 在 outcome 多态语义**——分两阶段降级风险。

**分两阶段**：

1. **Phase 1c.1 lite rename**：`mistake` 表 → `encounter` 表，**加 `outcome` 列 default `'wrong'`**，其他字段不动。所有 query / route / AI prompt 也跟着改名。这一步零行为变化，纯换皮。
2. **Phase 1c.3 outcome 多态**：加 `material_ref` polymorphic 字段（`question_id | artifact_id | source_document_id | free_text`），扩 `outcome` enum 到 `wrong | right | exposed | created | drilled | reviewed`，把 `wrong_answer_md` / `cause` 等 outcome-specific 字段下沉到 `evidence_jsonb`。这一步引入新概念，等 UI 反馈到位再做。

### D2 (← Q2)：UI 先行（带 lite rename 铺垫）

> **可推翻** — 但延后 UI 的代价（架构反馈失联）继续累计。

**选定**：先做 D1 的 lite rename → 再建 UI → 再做 D1 的 outcome 多态重构。

理由：

- UI 需要立刻拿到反馈；不能等"理想 schema"
- UI 代码若长在 `mistake` 名字上，未来再迁就两遍劳力
- lite rename 是 1-2 天的事，不阻塞 UI

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

## 三阶段实施（按依赖排序）

### Phase 1c.1: Namespace prep + UI 脚手架（~3-5 day）

**前置**：Sub 0c **完全 merge**（不可与 1c.1 同时改 schema）。

**Schema**:
- `mistake` 表 rename → `encounter`，加 `outcome text NOT NULL DEFAULT 'wrong'`
- 所有 FK / index / 业务代码 / AI prompts / tests 跟随改名

**Code**:
- 100% mechanical 改名 + tests pass
- 验证：测试 全绿；handler grep 无 `mistake` 残留

**UI 脚手架**:
- `app/page.tsx` 替换占位 → 一个 "Home" 路由壳
- 决定状态管理：Zustand store skeleton
- 决定数据 fetch：TanStack Query setup + 一份 `/api/health` 调用作 smoke
- 决定 styling：Tailwind v4（CSS-first）+ 一份 design token convention
- 决定 component 库：自建（参考 frontend-design skill）or shadcn——**待 grill**

**产出**: 命名干净的 encounter 抽象 + 可运行的 UI 框架 + 第一份 health 页面（"系统活着"）

### Phase 1c.2: UI 主切片（~5-7 day）

**5 个页面（按价值排）**：

1. **`/review`**（最高价值）：FSRS due queue → 一道题 prompt → 答 → judge → 反馈含 `cause`。**让 attribution 终于到达用户眼前**。
2. **`/inbox`**：SSE-driven 抽取进度可视化 → 块编辑 / 合并 / 拆分 → 一键 import。复用 Sub 0c 的 `/api/ingestion/[id]/events` SSE。
3. **`/capture`**：拍照上传入口（mobile-camera-first，但桌面也 OK）→ enqueue ingestion session → redirect 到 inbox。
4. **`/knowledge`**：read-only 知识树浏览。点节点 → 看挂在它下面的 encounters。
5. **`/history`**：session 列表（先只 ingestion session，等 1c.3 扩到所有 session type）

**Schema**: 不动。
**API**: 仅"补漏"——若 UI 发现某查询效率低 / 返回值不够，加 query parameter / 加 list endpoint。不开新主线。

**产出**: 用户能拍照、看抽取过程、审阅、import、复习、看错因、看自己知识树、看历史。**Phase 1 闭环可演示**。

### Phase 1c.3: encounter 多态重构 + R5 envelope（~3-5 day）

**前置**：Phase 1c.2 跑过至少一周，有真实使用反馈。

**Schema**:
- `encounter`:
  - 加 `material_ref jsonb`（`{ kind: 'question' | 'artifact' | 'source_document' | 'free_text', id: text }`）
  - 加 `evidence jsonb`（outcome-specific，例：wrong 时 `{ wrong_answer_md, cause }`；created 时 `{ artifact_id }`；exposed 时 `{ duration_ms }`）
  - 扩 `outcome` enum 到 `wrong | right | exposed | created | drilled | reviewed`
  - 弃用 `wrong_answer_md` / `cause` 顶级字段（迁移到 evidence jsonb）
- 新表 `learning_session`：
  - `type text NOT NULL`（`ingestion | review | tutor | explore | create | conversation`，仅前两个有实现）
  - `status text` / `started_at` / `ended_at` / `summary_md text` / `goal_id text NULL`
- `ingestion_session` 改名 → `learning_session WHERE type='ingestion'`（或保留 view 兼容）

**Code**:
- ADR-0005 的 `IngestionSession` 模块演化为 `LearningSession` 多态模块——内部仍单一所有者，但 type-driven 状态机分支
- review submit 写一条 `learning_session(type='review')` 记录（启动每次复习会话）

**Artifact 表决断**：在此阶段决定保留 / 删除。倾向：**与 R5 一起拍板**，因为 artifact 与 `material_ref kind='artifact'` 的关系决定 artifact 表的命运。

**产出**: schema 真正承载"通用学习框架"概念；后续 tutor / coach / explore 角色有 session 落点。

---

## Schema 改动一览

| 阶段 | 改动 | 风险 |
|---|---|---|
| 1c.1 | rename `mistake` → `encounter` + `outcome` 列 default `'wrong'`；加 `ingestion_session.source_kind` 列 default `'image'` | 中——触及 ~15 个 server / AI 文件 + ~10 个 test |
| 1c.2 | 无 schema 改动 | 低 |
| 1c.3 | encounter `material_ref` / `evidence` polymorphic；新 `learning_session` 表；artifact 表保留 / 删除决断 | 高——大型 migration + agent prompts 重写 + IngestionSession 模块演化 |

---

## 风险与回滚

1. **UI 是新栈**——`src/ui/` 空，需建组件库 + 数据 fetch + 状态管理三大约定。**回滚成本低**（UI 是新的，可任意推翻）。
2. **mistake → encounter rename 触面广**——但 100% 机械。**回滚**：drizzle migration 反向（重命名再反向）。
3. **Sub 0c 尚未 merge**——1c.1 严格阻塞至 Sub 0c merge。期间可推进 spec / ADRs / UI 脚手架 prototype（不动 schema）。
4. **D1 阶段二（outcome 多态）若做错**会让 schema 长成"什么都能塞"的 jsonb 黑洞。**缓解**：每种 outcome 自带 Zod schema 守 evidence 形状（参考 ADR-0002 的 `extraction_evidence` 模式）。
5. **设计反馈缺失**——单用户无 telemetry。Phase 1c.2 上线后**至少自用一周**再做 1c.3。

---

## 待 grill / 待决

- **UI 组件库选型**：自建 vs shadcn。前者更可控、后者更快。**Sub-grill 后单写一份 spec addendum**。
- **artifact 表命运**：与 D1 阶段二一起拍板。
- **R5 多 type 一开始建几个**：spec 写 6 种，1c.3 仅实现 ingestion + review。其他 type 是 enum 占位还是延后加？倾向：**enum 全写、行为延后**。

---

## ADRs（待写）

- **ADR-0006**：`encounter` 替换 `mistake` 为 first-class learning event（D1 拍板后写）
- **ADR-0007**：单用户假设明文化 + 多用户回滚成本（D5 拍板后写）
- **ADR-0008**（可选）：`learning_session` 多态 envelope 模式（D1 阶段二完成后写）

---

## 下一步

1. **用户 grill D1-D5** —— 任一推翻则 spec 需修订；全 ack 则进 2
2. 拆 → 三份 plan：
   - `docs/superpowers/plans/2026-05-1X-phase1c1-rename-and-ui-scaffold.md`
   - `docs/superpowers/plans/2026-05-1X-phase1c2-ui-main.md`
   - `docs/superpowers/plans/2026-05-1X-phase1c3-encounter-polymorphic.md`
3. 起 ADR-0006 + 0007 草稿
4. 等 Sub 0c merge → 开 worktree 推 1c.1
