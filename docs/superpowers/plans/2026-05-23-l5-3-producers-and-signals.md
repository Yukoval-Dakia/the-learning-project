# L5.3 Producers And Signals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish YUK-44 by routing the remaining seven proposal producer categories through the shared `AiProposalPayload` writer and adding proposal feedback signals for inbox ranking.

**Architecture:** Keep event log as the source of truth. Producers write validated `AiProposalPayload` envelopes through `writeAiProposal`; legacy actions that already have accept flows keep their existing event action/subject shape with `payload.ai_proposal` attached. `proposal_signals` stores aggregate accept/dismiss counts per `(kind, cooldown_key)` so the inbox can rank active/high-acceptance suggestions first and push cooled-down suggestions later.

**Tech Stack:** Next.js App Router, Drizzle ORM/PostgreSQL, Vitest, Linear issue YUK-44.

---

### Task 1: Proposal Signals Schema

**Files:**
- Modify: `src/db/schema.ts`
- Generate: `drizzle/0012_*.sql`
- Generate: `drizzle/meta/0012_snapshot.json`
- Test: `tests/integration/migration-smoke.test.ts`

- [x] **Step 1: Add the `proposal_signals` table**

Add a Drizzle table after `event` in `src/db/schema.ts`:

```ts
export const proposal_signals = pgTable(
  'proposal_signals',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    cooldown_key: text('cooldown_key').notNull(),
    accept_count: integer('accept_count').notNull().default(0),
    dismiss_count: integer('dismiss_count').notNull().default(0),
    acceptance_rate: real('acceptance_rate').notNull().default(0.5),
    dismiss_reason: text('dismiss_reason'),
    cooldown_until: timestamp('cooldown_until', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('proposal_signals_key_unique').on(t.kind, t.cooldown_key),
    index('proposal_signals_kind_rate_idx').on(t.kind, t.acceptance_rate.desc()),
    index('proposal_signals_cooldown_idx').on(t.cooldown_key, t.cooldown_until),
  ],
);
```

- [x] **Step 2: Generate the migration**

Run:

```bash
pnpm exec drizzle-kit generate --name=proposal_signals
```

Expected: a new `drizzle/0012_*.sql` and `drizzle/meta/0012_snapshot.json`.

- [x] **Step 3: Verify migration smoke**

Run:

```bash
pnpm test:migration
```

Expected: PASS.

### Task 2: Signals Owner Service

**Files:**
- Create: `src/server/proposals/signals.ts`
- Create: `src/server/proposals/signals.test.ts`
- Modify: `src/server/proposals/inbox.ts`
- Modify: `src/server/proposals/actions.ts`
- Test: `src/server/proposals/inbox.test.ts`
- Test: `src/server/proposals/actions.test.ts`

- [x] **Step 1: Implement signal reads and writes**

Create `src/server/proposals/signals.ts` with:

```ts
export const PROPOSAL_DISMISS_COOLDOWN_DAYS = 7;

export interface ProposalSignalSnapshot {
  acceptance_rate: number;
  dismiss_reason: string | null;
  cooldown_until: Date | null;
  accept_count: number;
  dismiss_count: number;
}

export async function loadProposalSignalsForRows(
  db: DbLike,
  rows: Array<{ id: string; kind: string; payload: { cooldown_key?: string } }>,
): Promise<Map<string, ProposalSignalSnapshot>>;

export async function recordProposalDecisionSignal(
  db: DbLike,
  proposal: ProposalInboxRow,
  decision: 'accept' | 'dismiss',
  dismissReason?: string,
): Promise<void>;
```

Behavior:
- No-op when `proposal.payload.cooldown_key` is absent.
- Key rows by `(proposal.kind, proposal.payload.cooldown_key)`.
- On accept: increment `accept_count`, recompute `acceptance_rate`, clear `cooldown_until`.
- On dismiss: increment `dismiss_count`, recompute `acceptance_rate`, set `dismiss_reason`, set `cooldown_until = now + 7 days`.

- [x] **Step 2: Add signal snapshots and ranking to inbox rows**

Extend `ProposalInboxRow`:

```ts
signals: ProposalSignalSnapshot | null;
```

After collecting rows in `listProposalInboxRows`, load signals and sort:

```ts
const now = new Date();
out.sort((a, b) => {
  const aCooldown = Number(Boolean(a.signals?.cooldown_until && a.signals.cooldown_until > now));
  const bCooldown = Number(Boolean(b.signals?.cooldown_until && b.signals.cooldown_until > now));
  if (aCooldown !== bCooldown) return aCooldown - bCooldown;
  const aRate = a.signals?.acceptance_rate ?? 0.5;
  const bRate = b.signals?.acceptance_rate ?? 0.5;
  if (aRate !== bRate) return bRate - aRate;
  return b.proposed_at.getTime() - a.proposed_at.getTime();
});
```

- [x] **Step 3: Record signals from lifecycle actions**

In `acceptAiProposal`, record an accept signal after non-idempotent knowledge node / edge acceptance.

In `dismissAiProposal`, record a dismiss signal after non-idempotent knowledge node / edge / generic dismissal.

In `decideKnowledgeEdgeProposal`, record accept/dismiss signals for legacy edge route callers when it writes a fresh rate event.

- [x] **Step 4: Test signal service and ranking**

Tests:
- New signal row starts at `accept_count=1`, `dismiss_count=0`, `acceptance_rate=1`.
- Dismiss after accept updates `acceptance_rate=0.5`, stores `dismiss_reason`, and sets `cooldown_until`.
- Inbox sort puts high-acceptance active proposals before default proposals, and active cooldown proposals last.
- Accept/dismiss actions write signal rows once and do not double-count idempotent repeats.

### Task 3: Writer Legacy Envelope Support

**Files:**
- Modify: `src/server/proposals/writer.ts`
- Modify: `src/server/proposals/writer.test.ts`

- [x] **Step 1: Add a narrow event override to `writeAiProposal`**

Extend input with:

```ts
event_override?: {
  action: string;
  subject_kind: string;
  subject_id?: string;
  payload?: Record<string, unknown>;
};
```

When present, keep validation through `parseAiProposalPayload`, but write:

```ts
{
  action: override.action,
  subject_kind: override.subject_kind,
  subject_id: override.subject_id ?? proposalSubjectId(payload),
  event_payload: { ...(override.payload ?? {}), ai_proposal: payload },
}
```

- [x] **Step 2: Test legacy action preservation**

Add a writer test that writes a `learning_item` proposal with `event_override.action='experimental:propose_learning_intent'` and asserts:
- event action remains `experimental:propose_learning_intent`
- event payload contains legacy fields and `ai_proposal.kind === 'learning_item'`

### Task 4: Producer Helper Layer

**Files:**
- Create: `src/server/proposals/producers.ts`
- Create: `src/server/proposals/producers.test.ts`

- [x] **Step 1: Add typed producer helper functions**

Create helpers:

```ts
export async function writeVariantQuestionProposal(...): Promise<string>;
export async function writeNoteUpdateProposal(...): Promise<string>;
export async function writeLearningItemProposal(...): Promise<string>;
export async function writeCompletionProposal(...): Promise<string>;
export async function writeRelearnProposal(...): Promise<string>;
export async function writeArchiveProposal(...): Promise<string>;
export async function writeJudgeRetractionProposal(...): Promise<string>;
```

Each helper must call `writeAiProposal` and set a stable `cooldown_key`.

- [x] **Step 2: Test all seven producer helpers**

For each helper, assert the written event has `payload.ai_proposal.kind` equal to:

```ts
[
  'variant_question',
  'note_update',
  'learning_item',
  'completion',
  'relearn',
  'archive',
  'judge_retraction',
]
```

Also assert `listProposalInboxRows(db, { status: 'pending' })` returns all seven kinds.

### Task 5: Migrate Existing Producers

**Files:**
- Modify: `src/server/boss/handlers/variant_gen.ts`
- Modify: `src/server/boss/handlers/variant_gen.test.ts`
- Modify: `src/server/boss/handlers/note_verify.ts`
- Modify: `src/server/boss/handlers/note_verify.test.ts`
- Modify: `src/server/orchestrator/learning_intent.ts`
- Modify: `src/server/orchestrator/learning_intent.test.ts`
- Modify: `src/server/knowledge/proposals.ts`
- Modify: `src/server/knowledge/proposals.test.ts`
- Modify: `src/server/knowledge/review.ts`
- Modify: `src/server/knowledge/review.test.ts`
- Modify: `app/api/review/appeal/route.ts`
- Modify: `app/api/review/appeal/route.test.ts`

- [x] **Step 1: Variant producer**

Change `runVariantGen` happy path from direct `question` insert to `writeVariantQuestionProposal`. Return status `proposed` and `proposal_id`.

Expected test changes:
- no new `question` row on happy path
- one pending `variant_question` proposal appears in inbox
- subject profile routing tests still pass

- [x] **Step 2: Note update producer**

Keep `note_verify` status updates and `experimental:note_verify` event. When verdict is `needs_review`, call `writeNoteUpdateProposal` with:
- target artifact id
- evidence ref to the note verify event id
- proposed_change containing summary and issues

- [x] **Step 3: Learning item producer**

Change `planLearningIntent` to call `writeLearningItemProposal` with an `event_override` that preserves:
- action `experimental:propose_learning_intent`
- subject_kind `artifact`
- the existing accept payload fields

Existing `acceptLearningIntent` must continue to work.

- [x] **Step 4: Archive producer**

Change `writeKnowledgeProposeEvent` for `mutation === 'archive'` to call `writeArchiveProposal` with an override preserving `experimental:knowledge_archive`. Keep reparent/merge/split on the legacy experimental path.

- [x] **Step 5: Judge retraction producer**

After `/api/review/appeal` writes `experimental:appeal_request`, call `writeJudgeRetractionProposal` targeting the appealed judge/attempt event and referencing the appeal event.

- [x] **Step 6: Completion/relearn/light archive helper coverage**

Keep completion/relearn/learning-item archive as helper-level producer writes only. Do not create a nightly job in YUK-44.

### Task 6: Verification And Closeout

**Files:**
- Modify: `docs/superpowers/plans/2026-05-23-l5-3-producers-and-signals.md`
- Modify: Linear YUK-44

- [x] **Step 1: Run focused tests**

Run:

```bash
pnpm vitest run src/server/proposals/writer.test.ts src/server/proposals/inbox.test.ts src/server/proposals/actions.test.ts src/server/proposals/signals.test.ts src/server/proposals/producers.test.ts src/server/boss/handlers/variant_gen.test.ts src/server/boss/handlers/note_verify.test.ts src/server/orchestrator/learning_intent.test.ts src/server/knowledge/proposals.test.ts src/server/knowledge/review.test.ts app/api/review/appeal/route.test.ts
```

Expected: PASS.

- [x] **Step 2: Run fixture regressions**

Run:

```bash
pnpm vitest run src/ai/task-prompts.test.ts src/subjects/math/fixtures/e2e.smoke.test.ts src/subjects/physics/fixtures/e2e.smoke.test.ts
```

Expected: PASS.

- [x] **Step 3: Run acceptance gates**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm audit:schema
pnpm test:db
pnpm test:migration
```

Expected: PASS. If `audit:schema` fails from sandbox IPC, rerun with escalation and record the sandbox failure in Linear.

- [x] **Step 4: Linear closeout**

Add a Linear comment with:
- migrated producer list
- migration/test evidence
- any follow-up issue created or explicit "No new Linear issue needed"
