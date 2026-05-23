# YUK-48 Knowledge Maintenance Nightly Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `knowledge_maintenance_nightly` pg-boss job that runs the `KnowledgeReviewTask` maintenance agent and writes only inbox proposals.

**Architecture:** Keep the existing cheaper split jobs (`knowledge_propose_nightly`, `knowledge_edge_propose_nightly`) in place, then run a broader `KnowledgeReviewTask` maintenance pass after them. Deduplicate and honor proposal cooldown at the shared `runWriteProposal` boundary so both manual review and cron tool calls avoid repeated pending/cooled proposals.

**Tech Stack:** TypeScript, Next server modules, pg-boss v12 schedules, Drizzle/Postgres, Vitest DB tests, Claude Agent SDK in-process MCP tool.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/server/knowledge/review.ts` | Add proposal dedupe/cooldown gating inside `runWriteProposal`; keep destructive actions proposal-only. |
| `src/server/boss/handlers/knowledge_maintenance_nightly.ts` | New cron-friendly handler that runs `streamReviewTask`, drains the response, and returns proposal delta stats. |
| `src/server/boss/handlers.ts` | Register `knowledge_maintenance_nightly` queue, worker, and BJT schedule after existing node/edge proposers. |
| `src/server/boss/handlers/knowledge_maintenance_nightly.test.ts` | DB coverage for proposal creation through the maintenance handler and pending/cooldown dedupe. |
| `src/server/boss/handlers.test.ts` | Unit coverage that registration creates and schedules the new queue. |
| `src/server/knowledge/review.test.ts` | Focused regression for direct `runWriteProposal` dedupe/cooldown behavior if the handler test does not cover enough. |
| `docs/superpowers/status.md`, `docs/architecture.md` | Update current queue table so docs reflect the new schedule. |

## Tasks

### Task 1: Shared KnowledgeReview proposal gating

**Files:**
- Modify: `src/server/knowledge/review.ts`
- Test: `src/server/knowledge/review.test.ts` or `src/server/boss/handlers/knowledge_maintenance_nightly.test.ts`

- [x] Add a small helper that maps recognized KnowledgeReview proposal payloads to `(kind, cooldown_key)`.
- [x] Before writing `knowledge_node`, `knowledge_edge`, and `archive` proposals, load inbox rows and skip if the same kind/cooldown key is already pending.
- [x] Skip if the same kind/cooldown key has an active `proposal_signals.cooldown_until`.
- [x] Return a JSON-safe skipped result (`skipped_duplicate` or `skipped_cooldown`) so the MCP tool can report the reason to the model.
- [x] Keep `reparent`, `merge`, and `split` on their existing legacy proposal path because they do not yet have canonical `AiProposalPayload` kinds.

### Task 2: Maintenance cron handler

**Files:**
- Create: `src/server/boss/handlers/knowledge_maintenance_nightly.ts`
- Test: `src/server/boss/handlers/knowledge_maintenance_nightly.test.ts`

- [x] Implement `runKnowledgeMaintenanceNightly(db, deps?)` with injectable `streamReviewTaskFn`.
- [x] Count proposal rows before and after with `listProposalInboxRows` and return `{ processed, proposals_created, pending_after }`.
- [x] Drain the `Response.body` so `streamTask` finishes and tool calls complete.
- [x] Implement `buildKnowledgeMaintenanceNightlyHandler(db)` for pg-boss.
- [x] Add DB test where injected stream task calls `runWriteProposal` and the proposal appears in inbox.
- [x] Add DB test where a pending duplicate or dismissed cooldown prevents a second proposal.

### Task 3: pg-boss registration

**Files:**
- Modify: `src/server/boss/handlers.ts`
- Create or modify: `src/server/boss/handlers.test.ts`

- [x] Register queue `knowledge_maintenance_nightly`.
- [x] Register worker with `pollingIntervalSeconds: 2`, `batchSize: 1`.
- [x] Schedule at BJT `0 3 * * *` after node and edge proposal jobs.
- [x] Add a unit test using a fake PgBoss object to assert createQueue/work/schedule calls.

### Task 4: Docs and verification

**Files:**
- Modify: `docs/superpowers/status.md`
- Modify: `docs/architecture.md`

- [x] Add `knowledge_maintenance_nightly` to the current queue tables.
- [x] Run focused DB/unit tests for the new handler, registration, and KnowledgeReview path.
- [x] Run `pnpm typecheck`, `pnpm lint`, and `pnpm test:db` if feasible.
- [x] Update Linear with validation evidence before commit/PR.
