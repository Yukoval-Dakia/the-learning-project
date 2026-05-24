# YUK-19 — Learning-item proposal rollback UI

> Track 1 / M2 / 3pt — accept/dismiss/retract surface for `kind='learning_item'` proposals + retract status on the learning-items list/detail.

## Context

After YUK-17 (variant_question lifecycle) ship the `acceptAiProposal()` switch handles
`knowledge_node`, `knowledge_edge`, and `variant_question`, but `learning_item` still
falls through to the default arm returning `unsupported_proposal_kind 400`. Producer
`writeLearningItemProposal()` is live and the only call site (planLearningIntent) materializes
the hierarchy via `acceptLearningIntent()` through a bespoke route `/api/learning-intents/[id]/accept`.

This lane:
1. Closes the accept/dismiss/retract gap for `kind='learning_item'` proposals in
   `src/server/proposals/actions.ts`. The owner-service path delegates to the existing
   `acceptLearningIntent()` (no internal refactor).
2. Fixes `loadProposalEvents()` in `src/server/proposals/inbox.ts` so the
   `experimental:propose_learning_intent` event action surfaces in the unified inbox.
3. Adds retract tombstone semantics for already-accepted learning_item proposals: the
   materialized hub + atomic learning_items + paired artifacts archive with
   `archived_reason='proposal_retracted'`.
4. Surfaces retract state on `/learning-items` (list) and `/learning-items/[id]` (detail)
   via the existing `CorrectionStateRenderer` (CC-2). The detail page also exposes a
   retract CTA hitting `/api/proposals/[id]/retract` (CC-4).

## Cross-cutting concerns honored

- **CC-2** Correction renderer reused as-is. No new correction component.
- **CC-4** Accept routes through `acceptAiProposal()`; retract through `retractAiProposal()`.
  No new proposal lifecycle route.

## Scope

### Backend

#### `src/server/proposals/actions.ts`

Add `learning_item` branch to `acceptAiProposal()`. Behavior:
- Idempotency: if a `rate` event already chains the proposal id, short-circuit and
  return the materialized ids (same pattern as `acceptVariantQuestionProposal`).
- Happy path: delegate to `acceptLearningIntent({ db, proposalId })`. `acceptLearningIntent`
  already writes the `rate` event (rating='accept') in the same transaction as the
  hierarchy/artifact inserts, so this branch does **not** write a second rate event.
- After acceptLearningIntent returns, call `recordProposalDecisionSignal(db, proposal, 'accept', opts.user_note)`
  so cooldown / acceptance rate signals stay in sync with the other kinds.
- Return type: new `LearningItemAcceptResult` carrying hub_learning_item_id +
  atomic_learning_item_ids + root_knowledge_id + created_knowledge_ids + the rate event id.

`dismissAiProposal()` learning_item arm: write a generic rate event (`rating='dismiss'`).
No materialization. Use existing `writeGenericRateEvent()` helper and record dismiss signal.

`retractAiProposal()` extension: after writing the correction event, if proposal.kind ===
'learning_item', look up materialized rows (learning_items where `source='learning_intent'`
AND `source_ref=proposalId`, and their primary_artifact_id) and tombstone:
- `learning_item.archived_at = now`, `archived_reason='proposal_retracted'`, version+1
- `artifact.archived_at = now`, version+1
Already-archived rows are left alone (idempotent).

Schema change: extend `LearningItem.archived_reason` enum in `src/core/schema/index.ts` to
include `'proposal_retracted'`. Update `docs/modules/learning-items.md` schema snippet.

#### `src/server/proposals/inbox.ts`

`loadProposalEvents()` filter currently excludes `experimental:propose_learning_intent`.
Add it via either:
- expanding the LIKE to `experimental:propose_%` (catches future `propose_*` actions), or
- explicit `eq(event.action, 'experimental:propose_learning_intent')`.

Picking explicit `inArray(event.action, ['experimental:proposal', 'experimental:propose_learning_intent'])`
is safest — matches the discriminated set of legacy actions today without sweeping in
unrelated experimental events.

#### `app/api/learning-items/[id]/route.ts`

GET adds `source`, `source_ref`, and `source_event` (id + correction_state from
`getEffectiveTruth`) — mirrors the list response shape. The detail page reuses
`CorrectionStateRenderer` and decides whether to show the retract CTA from these fields.

#### Tests

- `src/server/proposals/actions.test.ts` — new `describe('learning_item proposal lifecycle')`:
  - accept happy: materializes hub + N atomic learning_items + artifacts + writes single rate event
  - dismiss: writes rate event only; no learning_items materialized
  - retract before accept: only correction event; no learning_items to tombstone
  - retract after accept: hub + atomic learning_items + artifacts all flip to
    archived_at != null, archived_reason='proposal_retracted'
  - accept idempotency: second accept on same proposal returns `not_pending` (matches
    variant_question pattern)
- `src/server/proposals/inbox.test.ts` — new test asserting `experimental:propose_learning_intent`
  rows surface in `listProposalInboxRows()` with `kind='learning_item'`.
- `app/api/proposals/[id]/accept/route.test.ts` — update the existing "future kinds 400"
  test: replace `learning_item` with a still-unimplemented kind (`completion`) so the
  fixture stays meaningful; add a happy-path learning_item accept test.
- `app/api/learning-items/[id]/route.test.ts` — assert `source` / `source_event` fields
  surface for `source='learning_intent'` rows.

### Frontend

#### `app/(app)/learning-items/page.tsx`

No code change required. The list already renders `CorrectionStateRenderer compact` when
`source_event` is present (line 376-384). The API change for learning_intent items
(`source_ref → correction_state`) flows through automatically once
`loadProposalEvents` surfaces the proposal — except the list already passes `source_ref`
through `getEffectiveTruths()`, so retract on the proposal event already lights up.

#### `app/(app)/learning-items/[id]/page.tsx`

Add:
- New `Detail.source` + `Detail.source_event` fields (typed identically to list).
- Source event block under PageHeader (only when source_event present) with
  `CorrectionStateRenderer state={source_event.correction_state} showActive />`.
- Retract CTA (only when `source === 'learning_intent'`, source_event.id present,
  source_event.correction_state.state === 'active'): button calls
  `apiJson<{ kind: 'retracted' }>('/api/proposals/${source_event.id}/retract', { method: 'POST', body: JSON.stringify({ reason_md }) })`.
  React-query invalidates `['learning-item', id]` + `['learning-items']` on success.
  Reason input is an inline `<textarea>` revealed by the CTA (mirror the inbox UI retract pattern).
- Disable the CTA while in-flight; show error inline on failure.

#### Design tokens

- Reuse Button/Card/Badge primitives; no bespoke color or spacing.
- Retract CTA uses `variant="ghost"` with `tone="again"` Badge for the confirm state
  (mirrors the existing delete CTA pattern in the list page).

## Test plan (pre-merge gate)

```
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm audit:schema
pnpm audit:partition
pnpm audit:profile
pnpm test:db
```

Single-test development loop:
- `pnpm vitest run --config vitest.db.config.ts src/server/proposals/actions.test.ts -t learning_item`
- `pnpm vitest run --config vitest.db.config.ts src/server/proposals/inbox.test.ts -t learning_intent`
- `pnpm vitest run --config vitest.db.config.ts app/api/proposals/\\[id\\]/accept/route.test.ts`
- `pnpm vitest run --config vitest.db.config.ts app/api/learning-items/\\[id\\]/route.test.ts`

## Risks / open questions

- `acceptLearningIntent()` reads `event.payload` directly with its own loose schema rather
  than going through `getProposalInboxRow()`. This means `acceptAiProposal('learning_item')`
  still calls `requireProposal()`/`assertPending()` for the inbox-layer status check (good),
  but the actual materialization uses the looser legacy projection. That's fine for this
  lane — we don't want to refactor `acceptLearningIntent` per task scope.
- Retract on already-accepted learning_item proposals **tombstones the materialized
  rows**. This matches the variant_question retract policy and `docs/superpowers/plans/2026-05-23-l5-2-proposal-inbox-ui.md`
  CC-4 semantics (proposal-level retract is an L3 correction and outweighs any
  downstream rows it produced). Children-of-children (e.g. NoteGenerateTask outputs that
  attached to the atomic learning_items) are left as-is — they'll naturally read
  `archived_at != null` from their parent learning_items and stop appearing.
- The retract CTA only appears on hub learning_items (where `source_event.id === source_ref`
  via the proposal id). Atomic children also share the same `source_ref`, so the CTA shows
  on all of them too — that's intentional: the user can rollback from any node in the
  hierarchy and we tombstone the whole tree.
