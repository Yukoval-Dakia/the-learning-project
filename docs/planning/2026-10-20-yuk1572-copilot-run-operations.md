# copilot-run-operations — architecture delivery

Refs YUK-1572. Partial delivery; keep issue In Progress.

Base: 46663192de354dfe09aa8a474b5030b2726116eb. `jobs/copilot_run.ts` measured
1714 → 863 lines; `server/copilot-run-settlement.ts` added at 966 lines;
`server/copilot-run-session-cursor.ts` added at 73 lines. Dependency debt
unchanged: capability→server 429, cross-capability value 42, SCC catalog
unchanged — zero net new edges, no baseline change required.

## What actually changed in ownership

Every write that can terminalize an accepted durable run, plus every decision
that turns stored evidence into the canonical outcome, moved from the job file
into `server/copilot-run-settlement.ts`: the two pre-execution gates under the
dispatch lock (STARTED heartbeat, at-most-once EXECUTION_STARTED fence),
pre-execution cancellation projection, the outcome-marker two-phase
(`ensureCopilotOutcomeMarker` → `projectCopilotOutcomeMarker`), the public
REPLY+DONE / FAILED receipt writers, `terminalRunResult` (events → canonical
result), the three recovery decisions (cancel drain → cancelled, exhausted,
ambiguous_execution), and `reconcileCopilotDurableRun` (bounded converger:
marker repair / pre_execution_lost / ambiguous classification). The job file
keeps the sole durable execution owner role: replay guards, crisis lane, run
input assembly, native session reuse decision, the paid execute/teaching loop,
cancel observation wiring, delta chaining, successor wake, and the pg-boss
handler. All previously exported symbols stay importable from
`jobs/copilot_run.ts` via re-export; moved code is verbatim.

Two boundary seams replaced open-coded duplication rather than relocating it:
`copilot-run-session-cursor.ts` owns the paired durable (`agent_sdk_session_id`)
and in-process worker-session registry that four sites previously drove
separately, and `publishCopilotRunProgressEvent` moves the "progress cannot
cross cancel/marker boundary" rule inside the settlement lock it depends on.

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
   policy or an additional marker field): the two-phase commit
   (marker-under-settlement-lock → public receipt) is now a closed operation
   the execution owner cannot interleave with — before, `executeAccepted`
   could touch the same helpers mid-loop. The cursor pairing
   (`commitWorkerSessionCursor` / `discardWorkerSessionCursor`) removes a
   second latent split-brain between the persisted session pointer and the
   in-process registry.

## What callers now know less

The execution owner and the reconcile sweep no longer know: the
dispatch-vs-settlement lock ordering (settlement decides internally which
lock a write needs), the marker→projection two-phase ordering, the legacy
FAILED(reason=error) retryability carve-out, the checkpoint-anchor
(turn-materialized) suppression policy, or the recovery-reason taxonomy.
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
  (paired persisted + in-process stores); both execution and settlement call
  it, neither drives the stores apart.

## Verification

`pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm audit:capability-boundaries`,
`pnpm audit:architecture-deepening` all pass at head
fe41a11f0cdabd4a831a7628c8f468935fa5f5db; moved blocks verified verbatim
against origin/main by scripted diff. Evidence:
`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1572/fe41a11f0cdabd4a831a7628c8f468935fa5f5db/`,
SHA-256 manifest `checks-sha256.json` inside.

This is a responsibility split, not line shuffling: the claimed boundary is
"only `copilot-run-settlement.ts` can terminalize or recover an accepted run",
not "1714 lines became smaller files". Residual coupling honestly reported:
the job still orchestrates injection plumbing and holds
`withCopilotExecutionSettlementLock` for the crisis lane (one literal call),
and both halves share `TerminalProjectionEvent` vocabulary by design.

## Gate proposal (pending approval — not implemented)

An anti-regression gate could assert "no file outside
`server/copilot-run-settlement.ts` writes `DONE`/`FAILED`/outcome-marker rows
for `business_table='copilot_run'`" (static grep/AST check), plus "progress
events only via `publishCopilotRunProgressEvent`". Awaiting owner approval;
not added to `pnpm audit:*`.

NOT_RUN: local tests, DB, TEST, Docker, provider, runtime acceptance and
deployment. No test code changes. Exact-head CI and independent review remain
required before merge.
