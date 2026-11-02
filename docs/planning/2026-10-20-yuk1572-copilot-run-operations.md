# copilot-run-operations — architecture delivery

Refs YUK-1572. Partial delivery; keep issue In Progress.

Base: 46663192de354dfe09aa8a474b5030b2726116eb. `jobs/copilot_run.ts` measured
1714 → 849 lines; `server/copilot-run-settlement.ts` added at 966 lines;
`server/copilot-run-session-cursor.ts` added at 98 lines. Dependency debt
unchanged: capability→server 429, cross-capability value 42, SCC catalog
unchanged — zero net new edges, no baseline change required.

## What actually changed in ownership

Within the durable worker lane, every write that can terminalize an accepted
run, plus every decision that turns stored evidence into the canonical
outcome, moved from the job file into `server/copilot-run-settlement.ts`: the
two pre-execution gates under the dispatch lock (STARTED heartbeat,
at-most-once EXECUTION_STARTED fence), pre-execution cancellation projection,
the outcome-marker two-phase (`ensureCopilotOutcomeMarker` →
`projectCopilotOutcomeMarker`), the public REPLY+DONE / FAILED receipt
writers, `terminalRunResult` (events → canonical result), the three recovery
decisions (cancel drain → cancelled, exhausted, ambiguous_execution), and
`reconcileCopilotDurableRun` (bounded converger: marker repair /
pre_execution_lost / ambiguous classification). Scoped honestly: the Stop API
compensation and other non-worker entry points still write their own
terminalizing evidence through separate flows; no repo-wide uniqueness claim
is made. The job file keeps the sole durable execution owner role: replay
guards, crisis lane, run input assembly, the paid execute/teaching loop,
cancel observation wiring, delta chaining, successor wake, and the pg-boss
handler. All previously exported symbols stay importable from
`jobs/copilot_run.ts` via re-export; moved code is verbatim.

Two boundary seams replaced open-coded logic rather than relocating it:
`copilot-run-session-cursor.ts` owns the full decision surface for the
persisted (`agent_sdk_session_id`) cursor paired with the in-process
worker-session registry — `captureWorkerSessionCursor` reads once at pickup
and returns a discard armed against that captured cursor,
`selectResumableWorkerSession` owns the persisted-read → process-ownership →
answer-only decision — and `publishCopilotRunProgressEvent` moves the
"progress cannot cross cancel/marker boundary" rule inside the settlement
lock it depends on. No cross-store atomicity is gained: the in-process
registry is not transactional with Postgres, so a rolled-back write does not
roll back memory; the pre-existing protocol is preserved unchanged.

## Two real change scenarios

1. **New recovery classification** (e.g. a future bounded-repair reason):
   previously a reason had to be threaded through the job file's cancel branch,
   projection payload, `PersistedDurableReply` decoding, `terminalRunResult`,
   and the reconciler's observation list scattered across one 1714-line file.
   Now the reason taxonomy lives in one module: `PersistedDurableReply`
   failure reasons ↔ FAILED payload ↔ `CopilotDurableRunObservation` stay in
   `copilot-run-settlement.ts`; the execution owner only sees
   `RunCopilotRunResult`.
2. **Changing the paid-outcome commit protocol** (e.g. checkpoint-anchor
   policy or an additional marker field): the internals of each phase —
   settlement-lock acquisition, terminal guards, cancellation recheck — now
   live in one module instead of being open-coded at call sites, so a protocol
   change touches one file. The job still sequences
   `ensureCopilotOutcomeMarker` → `projectCopilotOutcomeMarker` and injects
   the projection functions itself; the two-phase call order is NOT hidden
   from the execution owner. The cursor decision surface
   (`captureWorkerSessionCursor` / `selectResumableWorkerSession` /
   `commitWorkerSessionCursor`) consolidates the persisted↔in-process pairing
   ordering — without gaining cross-store atomicity.

## What callers now know less

The execution owner and the reconcile sweep no longer know: the
dispatch-vs-settlement lock ordering (settlement decides internally which
lock a write needs), the internals of each outcome-marker phase (settlement
lock, terminal guard, cancellation recheck), the legacy FAILED(reason=error)
retryability carve-out, the checkpoint-anchor (turn-materialized) suppression
policy, the recovery-reason taxonomy, or the resume-selection ordering
(persisted read → process ownership → answer-only). What they still know,
unchanged: the explicit `ensureCopilotOutcomeMarker` →
`projectCopilotOutcomeMarker` call sequence and the injected projection
functions — the two-phase ordering stays visible in the job.
`RunCopilotRunParams` injection seams are unchanged, so fixture callers keep
pinning the same stages.

## Transaction / recovery ownership

- Pre-execution (no fence yet): dispatch advisory lock owns linearization;
  settlement module appends STARTED / EXECUTION_STARTED or the
  cancelled-before-start FAILED under it.
- Post-execution: settlement advisory lock owns outcome publication; recovery
  winners (API Stop drain timeout, reconcile ambiguous) and the paid owner
  serialize through the same lock, first terminal wins.
- Marker repair and reconcile classification never invoke model/tools;
  `reconcileCopilotDurableRun` remains the only bounded converger, called by
  `jobs/copilot_run_reconcile.ts` unchanged.
- Native-session cursor lifecycle belongs to `copilot-run-session-cursor.ts`
  (persisted + in-process stores driven through one decision surface); both
  execution and settlement call it. Ordering is consolidated, not made
  atomic — the registry update is not rolled back if the Postgres write
  aborts, matching the pre-existing protocol.

## Verification

`pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm audit:capability-boundaries`,
`pnpm audit:architecture-deepening` all pass at code head
e5d9f8a27baf26aa7b6a5163fd0f1cc2a1e117b1 (the doc commit adds only this file);
moved blocks verified verbatim against origin/main by scripted diff. Evidence:
`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1572/e5d9f8a27baf26aa7b6a5163fd0f1cc2a1e117b1/`
(incl. `cursor-before-after.txt`), SHA-256 manifest `checks-sha256.json`
inside.

This is a responsibility split, not line shuffling: within the durable worker
lane the settlement module is where terminalization and recovery decisions
live. Residual coupling honestly reported: the job still orchestrates
injection plumbing, holds `withCopilotExecutionSettlementLock` for the crisis
lane (one literal call), and explicitly sequences the marker→projection two
phases; both halves share `TerminalProjectionEvent` vocabulary by design. The
existing boundary audits do not verify terminal-write ownership — noted as a
limitation of current checks; no new gate is added here.

NOT_RUN: local tests, DB, TEST, Docker, provider, runtime acceptance and
deployment. No test code changes. Exact-head CI and independent review remain
required before merge.
