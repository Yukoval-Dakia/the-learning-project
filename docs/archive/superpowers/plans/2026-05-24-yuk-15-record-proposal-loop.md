# YUK-15 — record ↔ proposal evidence loop 接通

> Lane #2 of /launch-phase Wave 2 — M1 Teaching 收口（5pts, High）.
> Worktree: `/private/tmp/the-learning-project-worktrees/yuk-15-record-proposal-loop`
> Branch: `yuk-15-record-proposal-loop` (cascading 自 YUK-14 tip `573ec4e`).
> Linear: https://linear.app/yukoval-studios/issue/YUK-15

## Goal

把 `learning_record` 接进 proposal evidence loop：
- record 被引用为 proposal evidence 时，processing_status 从 `raw` → `linked`；proposal accept 时 → `actioned`；retract 回滚。
- inbox UI 把 `evidence_refs` 中 `kind='record'` 渲染为可点击 backlink（跳 `/record?focus=<id>`）。
- record list page 每张 card 显示「已产生 N 个 proposal」+ 链接到 `/inbox`。
- `pnpm test:db` 覆盖双向跳转 + status flip。

## Grep verification（先于设计）

PR #122 stale 项已确认现状：
- `writeAiProposal` ✓ (`src/server/proposals/writer.ts:84`)
- `acceptAiProposal` ✓ (`src/server/proposals/actions.ts:396`)
- payload shape 在 `payload.ai_proposal.evidence_refs` 路径 ✓ (writer.ts:55/69/78/94)
- `ProposalEvidenceRef.kind` 已含 `'record'` ✓ (`src/core/schema/proposal.ts:20`)
- `BadgeTone` = `'neutral' | 'info' | 'good' | 'hard' | 'again' | 'coral'`（**无 `warning`** — PR #122 教训）

新发现（Linear 描述与代码不符 / 需要修正 assumption）：
- **不存在 `app/(app)/records/[id]/page.tsx`**。当前 record 详情只在 list page (`app/(app)/record/page.tsx`，单数) 的 inline card。所以 ticket 的「record 详情页」要落在 list card 上，不另开 detail route（避免新 page 引入新 design 决策）。
- `learning_record.processing_status` 已有完整 4 态机：`raw | linked | actioned | archived` (`schema.ts:233`)，POST/PATCH 都有 write path (`queries.ts:83/154`)，**无需新 schema 字段**。`unprocessed_at` 列 ticket 描述里的方案被覆盖（用现有 status 列更省）。
- **当前所有 producer 都不写 `evidence_refs: [{kind:'record',...}]`**。grep `'record'` 在 producers.ts / signals.ts / knowledge/review.ts 都无命中。需要 caller（learning_intent orchestrator / 未来 producer）显式传，**本 lane 只打通基础设施**，不强行回填现有 producer。
- `producers.ts:13` 中 `CommonProducerInput.evidence_refs` 已是 optional override —— `writeLearningItemProposal` 加上后将自然支持。
- `acceptAiProposal` switch 已经处理 4 个 kind（node/edge/variant/learning_item），其它走 default 只发 generic rate。我们 hook record-status flip 应该在 **`writeAiProposal` (proposal create) 与 accept / retract 副作用层**做，不嵌进单个 kind 分支。

## Architecture

```
record write/list  ──┐
                     ├── status: raw → linked (writeAiProposal w/ record evidence)
                     ├── status: linked → actioned (acceptAiProposal)
                     └── status: actioned → linked (retractAiProposal rollback)

inbox UI            ──> renders evidence_refs[kind=record] as Link to /record?focus=<id>
record list card    ──> shows "N proposals" badge, link to /inbox
```

设计决策：
- record→proposal 的状态 flip 放在 `src/server/records/` 新文件 `record_processing.ts`（暴露 `markRecordsLinked(db, recordIds)` / `markRecordsActioned` / `markRecordsLinkedRollback`），避免侵入 records/queries.ts 的 CRUD-only 风格。
- `writeAiProposal` (src/server/proposals/writer.ts) 在写入 propose event 后，扫描 `payload.evidence_refs`，把 `kind='record'` 的 ID 调 `markRecordsLinked(tx, ids)`，**同事务**保持原子性。
- `acceptAiProposal` (src/server/proposals/actions.ts) 在所有 kind 分支 success 后调一次 `markRecordsActioned(db, proposal.payload.evidence_refs.records)`。放在 `recordProposalDecisionSignal` 之后或并行；非事务（因为已经过 owner service 多事务）。
- `retractAiProposal`（已存在 retract path）回滚 record status：`actioned`/`linked` → 回 `raw`（如该 record 没有其它 active proposal 引用；带 dedup query 检查）。**MVP 简化：retract 仅 `actioned` → `linked`，不全回 `raw`，因为可能有其他 proposal 还引用。**finals 再优化。
- 反向 query：`getProposalCountsForRecords(db, recordIds): Map<string, number>` 走 `event.action='propose'` + `payload.ai_proposal.evidence_refs` JSONB GIN 索引扫描即可（小表无 hot path，naive scan 也行）。

## File structure

修改 / 新建：
- `src/server/records/record_processing.ts` (NEW) — `markRecordsLinked` / `markRecordsActioned` / `markRecordsLinkedRollback` / `getProposalCountsForRecords`
- `src/server/records/record_processing.test.ts` (NEW) — unit tests against testDb (DB partition)
- `src/server/proposals/writer.ts` — 在 returning 之前扫 evidence_refs，调 `markRecordsLinked`（同 tx）
- `src/server/proposals/actions.ts` — `acceptAiProposal` / `retractAiProposal` 末尾调 `markRecordsActioned` / rollback
- `src/server/proposals/writer.test.ts` — 加 record-linked status flip case
- `src/server/proposals/actions.test.ts` — 加 accept→actioned + retract→linked case
- `app/api/records/[id]/route.ts` — `GET` 返回 `proposal_count` 字段（reuse `getProposalCountsForRecords`）
- `app/api/records/route.ts` — `GET` list 同样附加 `proposal_count`
- `app/(app)/record/page.tsx` — list card 加 "N proposals" inline 行 + 链 `/inbox?evidence_record=<id>`
- `app/(app)/inbox/page.tsx` — `GenericProposalCard` / `NodeProposalCard` / `EdgeProposalCard` 中 evidence_refs render `kind='record'` 为 `<Link href="/record?focus=<id>">`；同时支持 query string `?evidence_record=<id>` filter 列表

## Tasks (TDD red-green-refactor)

### T1. `markRecordsLinked` / `markRecordsActioned` / `markRecordsLinkedRollback` 单元（DB 分区）
- Red: 写 `record_processing.test.ts` 期望 `markRecordsLinked(['r1','r2'])` 把 status raw→linked，archived 不变；call w/ empty list = no-op。
- Green: 在 `record_processing.ts` 实现，单 `UPDATE ... WHERE id IN (...) AND processing_status='raw'`，rollback 路径用 `archived_at IS NULL AND processing_status='actioned'`.
- Refactor: 共享内部 helper `bulkSetStatus(tx, ids, from, to)`.

### T2. `writeAiProposal` 同事务 record flip
- Red: `writer.test.ts` 加 case：写 1 record (status=raw)，writeAiProposal 带 `evidence_refs: [{kind:'record', id}]`，然后 select learning_record → status='linked'。
- Green: 在 `writer.ts` 的 db.insert(...).returning() 后 (但还在同 tx) 扫 payload.evidence_refs 收集 record ids → `markRecordsLinked(tx, ids)`。⚠ writeAiProposal 当前不是 `tx` 包装的 —— 看代码：它 accept `DbLike = Db | Tx`，意味着 caller 决定事务边界。直接在 writeAiProposal 内调 markRecordsLinked(db, ids) 就够，caller 如果传 tx 自然共享。

### T3. `acceptAiProposal` flip → actioned + retract rollback
- Red: `actions.test.ts` 加：写 record (raw)+知识点 proposal 带 record evidence，accept after，→ status='actioned'。retract 后 → 'linked'。
- Green: 在 `acceptAiProposal` end (前 return)，把 `proposal.payload.evidence_refs` 过滤出 record ids → `markRecordsActioned(db, ids)`。`retractAiProposal` 同样在 retract event 写入后调 rollback。

### T4. `getProposalCountsForRecords` 反查
- Red: 写多个 proposal 都引用 r1，查 r1 count=N。
- Green: 用 `select ... from event where action='propose' AND payload->'ai_proposal'->'evidence_refs' @> [{kind:'record',id:<id>}]::jsonb`. naive scan 没问题。

### T5. API 暴露 proposal_count
- Red: `app/api/records/route.test.ts` 加 case: list 含 proposal_count 字段。
- Green: list/get serialize 时调 `getProposalCountsForRecords` 后注入。

### T6. Inbox UI: record evidence chip = Link
- 改 `app/(app)/inbox/page.tsx`：抽出 `EvidenceRefChip` 组件，event→`/events/[id]`、record→`/record?focus=<id>`、question→`/mistakes?focus=<id>`（如不存在则 fallback 仅显示）、artifact/knowledge 维持原显示。
- 同时支持 `?evidence_record=<id>` URL param → client filter 列表。
- 单元 / smoke：考虑 Playwright 走不上，先用 React unit + DOM check（@testing-library 已经在 package 里）。本 lane 跳过 unit smoke，留 manual QA + db test 兜底（design pre-flight 部分会说明）。

### T7. Record list card: "N proposals" 行
- 改 `app/(app)/record/page.tsx`：rows 用 `proposal_count`，> 0 时显示 "已产生 N 条 AI 提议" 链 `/inbox?evidence_record=<id>`。Tone neutral，不抢眼。
- 走现有 design tokens（`var(--fs-meta)`、`var(--ink-3)` 等已有 row pattern）。

## Open questions

无 — 全部 grep 验证完毕。

## Risk + rollback

- 风险 1：writeAiProposal 调用点跨多场景（producers + propose_edge + review 等），都引用 `payload.evidence_refs` 但未必传 record。直接读取 evidence_refs 后过滤 record kind ids 即可，no-op 安全。
- 风险 2：accept 路径 4 个 kind 分支 + default，加 hook 必须保证所有路径都走（包括 `KnowledgeEdgeProposalDecisionResult` 早返回）。**统一在 acceptAiProposal 函数末尾、return 前** 调 markRecordsActioned 是行不通的（kind 分支直接 return），需要在每个 case return 前调，或包装。决定：抽 helper `flipRecordsForDecision(db, proposal, 'actioned')` 在每个 case 的 return 前调；或重构 acceptAiProposal 用 try-finally。**MVP 选每个 case 显式调**（5 个调用点，明显 + 测试覆盖）。
- 回滚：单 migration（**无新表 / 字段**）+ 单逻辑变更。`git revert` lane head commits 即可恢复 record/proposal/inbox 旧行为。

## Linear capture gate (proposed follow-ups)

在 plan 中预先识别 — 实施后再确认：
- **Follow-up A**：当下无 producer 主动写 `evidence_refs: [{kind:'record', id}]`。后续 task（如 `/coach` chat → /api/records 写 record 后请 AI 分析 → 自动写 proposal 引用该 record）需要 caller 显式把 record id 放进 evidence_refs。建 Linear issue: "extend planLearningIntent / record-driven producers to attach evidence_refs.record".
- **Follow-up B**：retract→raw 全回流（依赖 dedup query），MVP 简化只回到 'linked'。若产品决定 retract 应全清，再开 issue.
- **Follow-up C**：record detail page (`/record/[id]`) 不存在；inbox 反链跳到 `/record?focus=<id>` 是 list-with-anchor，不是真 detail。若需要真 detail page，单独开 issue。

## Exit criteria

- `learning_record.processing_status` 三态 flip：raw→linked→actioned，retract → linked。
- inbox UI 中 `kind='record'` 的 evidence chip 是 `<Link>`，可点击跳 record list 并 focus。
- record list card 显示 proposal_count > 0 时，反链到 inbox filter。
- `pnpm test:db` 覆盖 writeAiProposal + acceptAiProposal + retractAiProposal flip + reverse query.
- `pnpm audit:schema` PASS（用现有 processing_status 列，**无新 allowlist entry**）。
- pre-merge gate 全绿（typecheck + lint + audit* + test）。

## Commit shape

- T1+T2 → 1 commit `feat(records): YUK-15 markRecordsLinked + writeAiProposal flip`
- T3 → 1 commit `feat(proposals): YUK-15 acceptAiProposal/retractAiProposal flip record status`
- T4+T5 → 1 commit `feat(api): YUK-15 expose proposal_count on records`
- T6 → 1 commit `feat(ui): YUK-15 inbox record evidence chip`
- T7 → 1 commit `feat(ui): YUK-15 record list shows AI proposal backlink`
- 最终 commit message 均含 `YUK-15`，最后一条含 `Closes YUK-15`。
