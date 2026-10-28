# BlockAssembly path-B — AI block-merge proposals (design note)

> **Status**: design, 2026-06-02. **Refs**: YUK-202; v0.4 roadmap P3.4; ADR-0011 (proposal/event paths); YUK-195 (mergeQuestions primitive); ADR-0006 v2.
> AI **only proposes** cross-page/adjacent block merges; the user accepts in the proposal inbox; acceptance reuses YUK-195 `mergeQuestions`. No auto-merge (hard safety boundary). All fork defaults below are locked (recommended options).

## 0. Decisive constraint — spatial signal is DEFERRED

`question_block.page_spans` is all placeholder today (`page_index=0`, full-page bbox; precise bbox is slice 2b, DEFERRED). So path-B v1 is **semantic-only**: the BlockAssemblyTask judges merge candidates from the `structured` tree (`question_no` continuity, sub-question `(1)(2)` carry-over, stem/answer split, "承接前题/根据上文" cues), NOT from bbox/page-edge spatial signals. Adjacency = the natural `structure.questions` array order (INSERT order); there is no ordering column. Recall is therefore limited to clear semantic cases; bbox-based page-edge detection layers in later when slice 2b lands (the task just gains a spatial input — no rework). **This caveat is documented in the prompt + PR.**

## 1. Proposal path (new `block_merge` kind via existing experimental:proposal/inbox)

Do NOT revive the dropped `dreaming_proposal` table; use a new `AiProposalPayload` discriminated-union kind on the existing event/inbox path.

- `src/core/schema/proposal.ts` (only schema change): add `'block_merge'` to `aiProposalKinds`; add the union member:
  ```ts
  BaseProposal.extend({
    kind: z.literal('block_merge'),
    target: ProposalTarget.extend({ subject_kind: z.literal('question_block') }),  // fork 3: question_block
    proposed_change: z.object({
      primary_block_id: z.string().min(1),
      merge_block_ids: z.array(z.string().min(1)).min(1),
      ingestion_session_id: z.string().min(1),
      continuity_signal: z.enum(['page_edge','numbering','stem_answer_split','carryover']).optional(),
    }),
  })
  ```
  `parseAiProposalPayload` needs no change (union extension is automatic).
- writer: NO change — `eventShapeForProposal`'s default branch maps non-knowledge kinds to `action='experimental:proposal'`, `subject_kind=payload.target.subject_kind`, `event_payload={ai_proposal}`. block_merge flows through it via `writeAiProposal()` (no event_override).
- inbox: NO change — `proposalWhere()`'s `action='experimental:proposal'` covers it; `ProposalInboxRow.kind` is read back from `payload.ai_proposal.kind`.

## 2. BlockAssemblyTask

New AgentTask (same shape as TaggingTask): `runBlockAssemblyTask` wrapper → `runAgentTask('BlockAssemblyTask', input, ctx)` → Zod-parse. Model = the lightweight TaggingTask tier (input is structured text, not page images — NOT vision/multimodal).

- **Input**: all draft blocks of one ingestion session (status='draft', same `ingestion_session_id` — exactly the batch `runAutoEnrollForSession` already loads). Per block, project the `structured` tree: `question_no`, `prompt_text` head, `role`, sub-question count, `layout_quality`. Adjacency = array order.
- **Signals (semantic-only, §0)**: numbering continuity; sub-question carry-over; stem/answer split (one block is the stem, the next only has the answer/analysis); "承接前题" cues. (spatial = deferred.)
- **Output** `BlockAssemblyOutput` = `{ candidates: Array<{ primary_block_id, merge_block_ids[], confidence: number(0..1), signal: 'page_edge'|'numbering'|'stem_answer_split'|'carryover', reason_md }> }`. `runBlockAssemblyTask` turns candidates → `writeBlockMergeProposal` calls.

## 3. Trigger — into the existing auto_enroll job (session-level assembly pass)

Run BlockAssemblyTask as a per-session pass inside `runAutoEnrollForSession` (NOT a new pg-boss queue), at the entry: `mode !== 'off'` AND after the draft blocks are loaded AND **before** any enroll import (so blocks are still draft). Rationale: input already loaded; trigger point correct (post-extraction, pre-review); failure boundary reused (auto_enroll is a cheap isolated queue, faults swallowed); observe-semantics aligned (proposal-only, zero mutation). The assembly AI failure is swallowed + logged (proposals are nice-to-have, not the critical path). (Optional later: an on-demand "suggest merges" button — fork 1c.)

## 4. Acceptance — reuse mergeQuestions (two-step, idempotent)

`dispatchAccept` (actions.ts) gains `case 'block_merge'` → `acceptBlockMergeProposal`, modeled on `acceptRecordPromotionProposal`:
1. `ensureAcceptOnly('block_merge', opts)`.
2. `existingAcceptRate(db, proposalId)` — idempotency (already-rated → return idempotent + ensureProposalDecisionSignal).
3. **Execute merge = YUK-195 `mergeQuestions(db, { actorRef:'proposal:accept', primaryBlockId, mergeBlockIds })`** (block-structured-edit.ts). Its preconditions match (draft + same-session + has structured); it dedups + SELECT FOR UPDATE serializes.
4. Write the `rate` event (accept) + `recordProposalDecisionSignal`.

**Atomicity (locked decision)**: `mergeQuestions` opens its own `db.transaction` (cannot nest in the accept's rate-event tx). Use the **two-step** (mergeQuestions self-tx, then write the rate event) rather than modifying the YUK-195 primitive — the crash window is tiny and `existingAcceptRate` makes a retry idempotent (compensating). Do NOT add a tx-override overload to the verified primitive.

**Stale handling**: `mergeQuestions` returns a discriminated status. `'written'` → write accept rate + `merged_count`. Any `'skipped:*'` (block already manually merged/imported → no longer draft) → do NOT write accept rate; return `{ kind:'block_merge', stale:true, skip_reason }` so the UI shows "proposal is stale" instead of throwing. This naturally handles dedup/races.

`AcceptAiProposalResult` union += `BlockMergeAcceptResult { kind:'block_merge'; rate_event_id?; primary_block_id; merged_count?; idempotent?; stale?; skip_reason? }`. dismiss: no change (generic rate fallback). retract (fork 6): correct-event-only (no real unmerge — matches existing default; mergeQuestions is lossy).

## 5. Threshold / dedup / safety

- **AI never auto-merges** (hard boundary): observe pass only writes proposal events; `mergeQuestions` runs only on user accept.
- All candidates propose; UI sorts by `confidence` (fork 4a). Optional low-confidence floor (drop candidates < ~0.3) to reduce inbox noise — this is "propose-or-not", still never auto-merge.
- dedup: (1) producer `cooldown_key = block_merge:{session}:{primary}:{sorted(merge_ids)}` — a **stable dedup key** for downstream inbox cooldown-signal folding, NOT a pre-write suppressor (`writeAiProposal` does not hard-suppress a second write, so a re-run can emit a duplicate proposal — harmless); (2) accept-side mergeQuestions draft-only soft-reject (a merged/imported block is no longer draft → later accept goes stale). Together these prevent any double-merge. `block_merge` is **proactive** (not the corrective SK-3 kind) so accepts are counted in the signal/KPI path.
- idempotency: `existingAcceptRate` prevents double-merge.

## 6. Slices (each backend-shippable; UI last → redraw)

- **S1** — `proposal.ts` adds `block_merge` kind + union member. No behavior; unblocks type imports. Unit: `parseAiProposalPayload` accepts a block_merge payload.
- **S2** — `actions.ts` `dispatchAccept` case + `acceptBlockMergeProposal` (reuse mergeQuestions, two-step, stale/idempotent) + `AcceptAiProposalResult` union. **After S2 the user can manually accept a block_merge proposal end-to-end** (DB test: seed a block_merge event → accept → assert mergeQuestions ran + rate event + stale/idempotent branches).
- **S3** — `src/server/proposals/producers.ts` `writeBlockMergeProposal`. Unit: the written event lands in the inbox (`proposalWhere` hit) + kind reads back.
- **S4** — `src/server/ingestion/block-assembly.ts` `runBlockAssemblyTask` + `BlockAssemblyOutput` schema + registry `BlockAssemblyTask` (prompt/model) + the assembly pass in `runAutoEnrollForSession` (after load, before import; AI failure swallowed+logged). DB test with a fake `runTaskFn` injecting candidates → assert proposals land. **After S4 the full auto-propose chain works.**
- **UI [redraw]** — proposal inbox `block_merge` row (primary + merge-block structured preview, `continuity_signal` badge, confidence, reason_md, accept/dismiss). Only UI change; S1–S4 don't depend on it. → YUK-169 redraw, design pre-flight.

## 7. Out of scope (v1)

spatial/bbox page-edge signal (slice 2b); cross-session merge (mergeQuestions is same-session); auto-merge; real unmerge on retract; the inbox UI (→ redraw).
