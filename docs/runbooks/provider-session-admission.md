# Provider session admission rollout

YUK-842 controls complete central Claude Agent SDK sessions across app and worker processes through
Postgres. Each admitted session starts the exact task-configured CLI with `startup()`, then submits
one prompt with `WarmQuery.query()`. It does not meter individual HTTP requests: one admitted session
may contain multiple turns, SDK-native subagents, tool loops, and the Claude CLI's internal retries.

## Configuration

Both app and worker must receive the same values:

```dotenv
AI_PROVIDER_SESSION_ADMISSION_MODE=off
AI_PROVIDER_SESSION_ADMISSION_POLICIES_JSON={"xiaomi":{"maxConcurrentSessions":4,"maxSessionStartsPerMinute":30,"maxQueuedSessions":32,"maxWaitMs":30000}}
```

- `off`: no admission-table/control-plane access. This rolls back the admission control plane only;
  the `startup()` / `WarmQuery.query()` lifecycle remains active. Restoring the former direct-query
  lifecycle requires the prior app/worker image, not an environment-only switch.
- `observe`: writes/heartbeats/releases real session rows but does not wait on capacity. A DB error is
  logged and fails open for this explicitly bounded observation phase.
- `enforce`: capacity, start rate, queue bound, policy consistency, cancellation, and timeout are
  enforced. Any ambiguous control-plane failure fails closed before provider execution.
- A lane absent from the JSON is explicitly off even when the global mode says observe/enforce.
- Numeric policy and fixed lease semantics form `policy_fingerprint`. Enforce rejects while an active
  or waiting row for the lane has another fingerprint.

The fixed runtime bounds are a 60s start-rate window, 40s SDK initialize timeout, 45s initial startup
lease, 15s steady lease/renewal horizon, 5s heartbeat, 30s abort grace, and seven-day terminal-pruning
eligibility. Successful SDK initialization is followed by a claim-token CAS that explicitly replaces
the startup lease with `min(hard_reclaim_at, DB now + 15s)`. Only ordinary heartbeat renewal is
monotonic and never shortens the last confirmed expiry. The hard-reclaim horizon is
acquisition + 45s startup budget + model timeout + abort grace. Pruning is opportunistic in bounded
batches on a later tick for that lane; it is not a background TTL. `maxWaitMs + 45s SDK startup +
model timeout + abort grace` must remain below the one-hour stuck-run reconciler threshold. All fixed
timings, including the 1s confirmed-lease margin required at provider start and lease protocol v2's
explicit startup-to-steady transition, participate in `policy_fingerprint`.

The starts/minute counter is deliberately conservative: a distributed admission grant reserves one
start immediately and remains in the 60s ledger even if cancellation, SDK initialization, or a later
local DB failure stops the caller before `WarmQuery.query()`. This prevents concurrent processes from
oversubscribing the rate window; it is admission-start accounting, not provider billing evidence.

CLI startup is inside the admission slot but before `ai_task_runs` start and before the model execution
timer. `startup()` performs the initialize handshake without submitting the prompt. After startup the
runner must confirm the startup-to-steady CAS, then synchronously recheck its DB-derived lease,
cancellation, retry-start deadline, and any caller-owned absolute session deadline. Only then does it
create the durable attempt, arm the remaining timer, and call `WarmQuery.query()`. An ambiguous CAS
fails closed in enforce; observe fails open immediately while a bounded background retry owns lease
maintenance. The Hono composition root gives every authenticated API request one shared 90s absolute
deadline; all central runner calls in that request automatically use the earlier of that scope and
any explicit caller deadline. Copilot also creates an explicit fallback from the same shared 90s
budget and carries it through classifier, teaching/free-form main work, and nested central tasks;
production runners still prefer the earlier request-scope deadline. The lifecycle rechecks lease,
abort and the absolute deadline after SDK completion, so a late success cannot cross the fence.
Durable worker calls have no HTTP scope and omit that edge-only bound.

Despite the compatibility key name, `maxConcurrentSessions` counts active session-family roots and
parallel branches, not every open SDK query object. One same-lane nested descendant chain may share a
root slot to avoid outer→tool→inner deadlock; parallel siblings cannot share that slot.

## Rollout gate

1. Apply migration `0088_yuk842_provider_session_admission` before enabling observation.
2. Deploy the code to every app and worker with mode `off`; do not leave an old binary able to call
   the lane during enforcement.
3. Configure the same policy everywhere and switch every central-call process to `observe`. Keep the
   observation window bounded. Confirm at least one real API-originated and one worker-originated
   session emit requested/acquired/released rows and matching structured logs.
4. Confirm no manual/support process will call the central runner with mode off during the canary.
   Direct embedding, Mem0, GLM/OCR, Tencent OCR, and preflight clients are outside this gate.
5. Before `enforce`, pause new ingress/job dispatch and require application-level normal drain; an
   admission-table snapshot alone is insufficient because observe may have failed open. If any owner
   is aborted, killed, or ambiguously stopped, keep traffic closed until process stop time plus the
   deployed 45s startup budget, maximum execution timeout, and 30s abort grace; a captured
   `hard_reclaim_at` may only extend that bound. If the maximum timeout cannot be proven, remain off.
   Verify there is no mixed
   binary/policy population, restart app and worker together with `enforce`, then resume traffic. A
   rolling observe→enforce switch is not a global cap: an old observe process can still start
   sessions, so it is forbidden.
6. Canary one configured provider lane first. Product defaults remain runnable because mode defaults
   to off and unlisted lanes bypass explicitly.

Useful read-only checks:

```sql
select lane_id, mode, policy_fingerprint, status, count(*)
from provider_session_admission
where requested_at > clock_timestamp() - interval '15 minutes'
group by 1,2,3,4
order by 1,2,3,4;

select task_run_id, lane_id, status, borrowed_from_task_run_id,
       extract(epoch from (acquired_at - requested_at)) * 1000 as wait_ms,
       acquired_at, lease_expires_at, hard_reclaim_at, terminal_reason
from provider_session_admission
where requested_at > clock_timestamp() - interval '15 minutes'
order by requested_at desc;
```

Expected evidence is capacity behavior and admission events only. It does not prove lower cost,
better quality, wire-request RPM, or full-product outbound coverage.

## Failure and recovery semantics

- Normal wait timeout/cancel is DB-linearized by a dedicated short terminal CAS. If that CAS also
  exhausts its 250ms DB budget, the caller still stops at its local bound: enforce fails closed,
  observe alone fails open, and any previously inserted waiting row becomes ineligible and is marked
  timed-out on a later successful lane tick. All cases occur before `ai_task_runs` start, so no model
  attempt/cost row is created and the runner does not transient-retry them.
- Every Loom retry or pg-boss redelivery that is actually allowed to execute a new provider attempt
  resolves its provider again and obtains a fresh admission identity. Replay/fence paths that skip
  paid work do not re-admit. CLI-internal retries remain inside one session lease.
- Same-lane nested DomainTool tasks borrow an active parent concurrency slot to avoid outer→tool→inner
  deadlock. Only one active descendant chain borrows a family slot; a parallel sibling must wait or
  consume another available root slot. Children have their own start-rate charge, lease, and row. If
  a parent terminates first, its still-active child occupies the session-family slot until release or
  hard reclaim. Cross-lane children acquire normally.
- Startup completion may shorten the initial lease exactly once through its matching claim-token CAS.
  A normal heartbeat may only renew an unexpired matching claim token and never shortens the last
  confirmed steady expiry. Lease loss aborts the SDK in enforce. The token fences DB ownership only; it
  cannot cancel an already sent provider request. Therefore a lost active family root/branch remains
  counted until owner release or `hard_reclaim_at`.
- Release failure never changes a completed model result; the slot stays conservatively occupied until
  hard reclaim.

## Restore protocol

Wiping admission state while old SDK sessions still run erases both capacity and the 60s start
window, so an online provider restore is unsafe. The two supported restore paths differ:

- Application archive import excludes this table and wipes it transactionally. Block user ingress,
  pause dispatch, and require an application-level normal-drain signal. A DB snapshot of zero waiting
  and zero active/quarantined rows is necessary but cannot by itself close the wait→acquire race.
  Before aborting/stopping any remaining owner, record the maximum `hard_reclaim_at`, then stop worker
  and keep only the admin Hono process running in admission mode `off` for the import endpoint.
- Full `pg_dump` includes operational rows. Stop app/worker, restore, run migrations, then explicitly
  `TRUNCATE provider_session_admission` before either process starts. Capture the same pre-stop
  active-row quarantine bound before the restore overwrites it.

For either path, restart provider traffic only after every applicable bound has passed: 60 seconds
since the last pre-restore provider traffic; the captured maximum `hard_reclaim_at`; and, unless
application-level normal drain was positively confirmed, process stop time plus the deployed 45s SDK
startup budget, maximum execution timeout, and 30s abort grace. Abort is not evidence that an already
sent provider request stopped. The DB-derived timestamp may extend this worst-case fallback but never
shorten it. If the maximum deployed timeout or bypassing caller state cannot be proven, the restore
remains fail-closed.

The authoritative commands and gates for both paths are in `docs/sub5-restore-cli.md`.

## Rollback

Pause ingress/job dispatch, set mode `off` for every app and worker, restart them together, then resume.
This disables only admission-table coordination. To roll back the startup/WarmQuery lifecycle itself,
deploy the recorded prior image to app and worker together. Old rows remain operational diagnostics and
become eligible for bounded pruning only when that lane later runs admission; they do not affect calls
in off mode. Do not delete rows manually during live enforcement.
