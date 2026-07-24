# Durable judge as the main path (YUK-594)

Status: **RULED — owner ballot closed 2026-07-24 (D1-D9 decided, see §5).** Refs YUK-594. Docs-only; no production code in this PR.

Author pass: Fable. Grounded against `main` @ `90d605e2` (all `file:line` below verified on that base; drift from the ticket triage is called out inline).

---

## 0. Framing & the owner ruling this doc implements

Owner decision (2026-07-23 决策清单⑥, hard constraint for this design):

> **异步为主路径** — every judging surface goes through a durable queue, submit returns **pending** immediately, the verdict is backfilled when judging completes. Synchronous in-request judging is **no longer the main path**. UI moves wholesale to "判题中 → 回填". Implementation must define the pending/degraded response contract and a cross-surface coverage list.

This inverts the emphasis of the original ticket (which framed async as "for the judge calls that *can tolerate* delay"). Under the ruling, async is the default for **all** judging faces; the synchronous fast path is demoted to (at most) an opt-in fallback, not the primary return.

### Root cause (verified, restated)

The judge sensor cannot survive endpoint-down inside a synchronous HTTP route because the two real down-shapes are physically too slow for the sync wall clock:

- cloudflared edge severs the connection at **~100s** (production ingress ceiling).
- Per-attempt abort fires at **90s** — the vision judge tasks pin `budget.timeout: 90_000` (`src/ai/registry.ts:1153` et al.), applied by the abort timer `setTimeout(() => abortController.abort(), def.budget.timeout)` at `runner.ts:547`. And the in-process transient-retry gate (`runner.ts:773`) only retries when `elapsedMs < RETRY_ELAPSED_CAP_MS` where `RETRY_ELAPSED_CAP_MS = 10_000` (`src/server/ai/agent-run-error.ts:51`) — so a failure that surfaces after ~90s is already past both the abort and the 10s retry-eligibility cap.
- Endpoint-down manifests as either connection-refused (>3min) or 500-hard-error (177s) — both arrive *after* the 90s abort has already turned the failure permanent, and both blow past the 10s retry-elapsed cap.

Conclusion (承重): endpoint-down tolerance **requires a wall clock longer than 100s** ⇒ judge must run in a background durable job (pg-boss), not in the request window. Moving the worker is **necessary but not sufficient** — the durable layer must *also* widen the retry budget (cross-provider retry, longer elapsed cap, queue redelivery), because a busy worker or a still-down endpoint otherwise just relocates the same failure.

### The six caller sites, re-grounded (triage line numbers had drifted)

| # | Surface | Site (verified `main@90d605e2`) | Triage said | Kind |
|---|---------|--------------------------------|-------------|------|
| 1 | practice submit | `src/capabilities/practice/api/submit.ts:322` (in `judgeSubmit`, Phase 2, outside the FSRS txn) | :246 | **sync HTTP route** |
| 2 | agency probe-answer | `src/capabilities/agency/api/probe-answer.ts:218` | :180 | **sync HTTP route** |
| 3 | paper submit | `src/capabilities/practice/server/paper-submit.ts:525` | :261 | **sync HTTP route** |
| 4 | rating advice | `src/capabilities/practice/api/advice.ts:61` | :65 | **sync HTTP route (no-persist preview — special-cased, §2.3)** |
| 5 | solve session | `src/capabilities/practice/server/solve-session.ts:334` (via injectable `judgeFn`) | :341 | **sync HTTP route** |
| 6 | `judgeAnswer` wrapper | `src/server/ai/judges/question-contract.ts:288` | :283 | **NOT a sync route** |

**Finding that reshapes the plan:** site #6 (`judgeAnswer`) is a library wrapper, not an HTTP caller. Its only two live consumers are already in the worker plane:

- `src/capabilities/practice/jobs/rejudge.ts:79` — a pg-boss job.
- `src/capabilities/practice/server/judge-calibration-sample-core.ts:243` — the YUK-573 calibration sampler (a second-provider replay lane).

So there are **five true synchronous HTTP callers** to migrate, plus one shared pure pipeline (`judgeAnswer` → `JudgeInvoker.invoke`) whose *existing* durable consumers are the precedent this whole design leans on. The chokepoint everything funnels through is `JudgeInvoker.invoke()` (`src/server/judge/invoker.ts:104`) — the durable job wraps exactly this, so no per-runner edits are needed (narrowing, route resolution, telemetry, capability-ref version pin all stay inside `invoke`).

---

## 1. Pending / degraded response contract

### 1.1 The precedent we copy verbatim

The copilot durable lane already ships a 202-pending contract we mirror byte-for-byte in shape:

- **Dispatch → 202** (`src/capabilities/copilot/api/chat.ts:140-158`): `boss.send('copilot_run', {...})` then `Response.json({ run_id, session_id, checkpoint_event_id }, { status: 202, headers: { Location: '/api/jobs/copilot_run/<run_id>/events' } })`.
- **Progress channel** = generic job-events SSE: `GET /api/jobs/<kind>/<id>/events` (`src/capabilities/observability/api/job-events.ts:35`), caller-agnostic (YUK-310), gated by an allowlist set `JOB_EVENT_KIND_SET` (job-events.ts:49) — **a new `kind` MUST be appended there or the stream 400s**. Replay via `computeReplay` (`src/server/events/sse_replay.ts`) + Last-Event-ID cursor.
- **Status derivation** = pure reducer `deriveCopilotRunStatus(events)` (`src/capabilities/copilot/server/copilot-run-status.ts:71`): `queued → started → running → done|failed`, terminal is last-writer-wins. We generalize this to a `deriveJudgeRunStatus` (same shape; the run handle = the judge_run id).
- **Progress writes** = `writeJobEvent(tx, {business_table, business_id, event_type, payload})` (`src/server/events/writer.ts:22`) — INSERT into `job_events` + `pg_notify('job_status', …)` in one tx; returns the row id used as the SSE cursor. **No schema change** — `job_events` is already generic (`business_table`/`business_id`).

### 1.2 The judge pending contract

Every migrated caller returns, on submit:

```
202 Accepted
{
  "run_id": "<judge_run id>",          // = the domain event id that anchors the attempt (see §2)
  "verdict": "pending",                // discriminant; clients branch on this
  "backfill": {
    "channel": "sse",                  // primary
    "url": "/api/jobs/judge_run/<run_id>/events",
    "poll_url": "/api/jobs/judge_run/<run_id>/status"  // fallback for no-SSE clients
  }
}
Location: /api/jobs/judge_run/<run_id>/events
```

When judging completes, the terminal `job_event` — `judge_run.done` (verdict) or the latest `judge_run.attempt_failed` (degraded, see §3.1 for why failure is written per-attempt in the handler `catch`, not on DLQ landing) — carries the payload. `done` carries the `JudgeResultV2` (coarse_outcome, score, feedback_md, capability_ref, telemetry). The client swaps its optimistic "判题中" badge for the real verdict off that event; a reconnecting/late client replays the same terminal event.

Backfill contract is **three-tier** so no client is stranded:
1. **SSE** (`.../events`) — live, primary. Same stream copilot uses.
2. **Poll** (`.../status`) — a thin GET that runs `deriveJudgeRunStatus(computeReplay(...))` and returns `{status, result?}`. For clients that can't hold an SSE connection (mobile background, flaky links). *Ruled D2 (§5): three-tier adopted.*
3. **Replay** — reconnect with Last-Event-ID; the terminal `job_event` is retained `RETENTION_7D` (`src/server/boss/queue-config.ts`) so a client offline at completion still gets the verdict on next fetch **within 7 days**. Past that window the progress stream is gone — but **`job_events` is only the progress stream, NOT the source of truth.** The durable source of truth is the **domain event** the worker wrote on backfill: the `review` event (id = run_id) for submit/paper/solve, the `probe_result` event for probe — these live in the permanent domain event log, not under the 7d job_events retention. So the recovery contract is: the `.../status` endpoint (and any late client) resolves a run by (a) checking `job_events` for a terminal `done`/`attempt_failed`, and (b) **falling back to the domain event keyed by run_id** when job_events has aged out. See §3.6 for the exact `/status`-beyond-retention behavior. (The `advice` face has no domain event; a >7d advice run is simply "expired — resubmit for a fresh preview", which is harmless since it never persisted anything.)

### 1.3 Degraded scenario matrix

| Scenario | Detection | Client-visible degraded state | Recovery |
|----------|-----------|-------------------------------|----------|
| **Queue backlog** (worker busy / batchSize serial) | run sits `queued` past a soft deadline. Copilot's `PICKUP_TIMEOUT_MS = 10_000` (`durable-pickup.ts:27`) + `isDurablePickupStalled` predicate is the ready-made primitive. | "判题排队中" (queued, not yet started). Attempt already recorded unjudged (§2). | Worker drains queue; STARTED event flips badge to "判题中". |
| **Endpoint-down, retrying** | job threw → pg-boss redelivery in flight (`JOB_RETRY_LIMIT = 2`, `JOB_RETRY_DELAY_SECONDS = 30`, `retryBackoff: true` → ~30s→~60s between paid attempts). | "判题中(重试)" — same pending badge, optionally a retry-count hint. Attempt stays recorded unjudged. | Cross-provider retry (§3.4) or endpoint recovery lands a terminal `done`. |
| **Exhausted / permanent failure** | each failed attempt's `catch` wrote a `judge_run.attempt_failed` trace (§3.1); on the final attempt the job lands in `judge_run_dlq` (dead-letter, per `jobQueueOpts`) with **no further handler invocation** — the last `attempt_failed` trace is the terminal record. | "本次判分暂不可用 — 已记录，稍后可补判" — explicit degraded-final, NOT a silent wrong-answer. Attempt remains recorded but **unjudged** (never scored as wrong; that was the whole point of the F4 photo-only gate lineage). | Manual rejudge (`rejudge.ts` already exists); DLQ auto-sweep NOT built (RULED D6, manual-only). |
| **Worker down entirely** (no `RW_WORKER`, crash-loop) | `isDurablePickupStalled` fires (pickup deadline passed, never STARTED). | "判分服务离线 — 答案已记录" | Worker restart drains the backlog; runs were durably enqueued, nothing lost. |
| **Auto-rate needs the verdict** (submit `auto_rate=true`) | judging is now async; the suggested rating isn't available at submit time. | See §2.3 — this is the one real UX regression and needs an owner ruling. | — |

---

## 2. Cross-surface coverage list

For each of the five sync HTTP callers: pending UX, the write-timing decision (record-unjudged-then-backfill vs block), and the YUK-444 interaction.

### Shared write-timing principle — only the paths that make a *server-side* judge call defer

**Grounded correction (thread):** async-main does **not** make every submit "unjudged with no rating". The split判据 is precise — *does this request make a synchronous server-side judge (LLM) call?* Only those paths move to the durable lane. On the submit face this is exactly `judgeSubmit`'s server-invoke condition (submit.ts:318, mirrored by `resolveDurableDivert` in #1068): **`auto_rate && no client-supplied `judge_result_v2` && has an answer && not photo-only-on-a-text-only-route && the subject profile resolves`**. Everything else is untouched:

- **Manual rating (non-`auto_rate`)** — `finalRating` is `body.rating` (submit.ts:365); the judge is never called. This path writes the `review` event + advances FSRS **synchronously and immediately**, exactly as today. It does NOT go async.
- **Client-supplied `judge_result_v2`** — verdict already in hand, no LLM call, stays synchronous.
- **No-answer 422 / photo-only-unsupported 422** — route-resolution checks, no LLM call, stay synchronous.

So the surfaces/paths that actually defer are: **`auto_rate` submits, probe-answer, paper-submit, solve-session** (all of which always/conditionally make a server judge call), plus the advice preview (§2.3). For *those* paths only, we **invert to record-unjudged-then-backfill**:

1. On submit: write the attempt/outcome event with `judge: pending` (unjudged), enqueue `judge_run`, return 202. FSRS is **not** advanced yet (an unjudged attempt has no rating). (Manual-rating submits are unaffected — they already advanced FSRS synchronously above.)
2. On judge completion: the worker writes the verdict as a **follow-up event** chained to the attempt, and *then* performs the FSRS transition.

This preserves the existing single-owner event invariants (ADR-0005 writeEvent, upsertFsrsState single-owner) — the verdict/FSRS write simply moves from the request tx to the worker tx. It also inherits the existing "recorded-but-unjudged" path that submit.ts already has for photo-only-unsupported (`submit.ts` F4 lineage) — that path proves an attempt can legitimately exist without a verdict.

**Blocking alternative** (record unjudged but hold FSRS until backfill) is the recommendation and is what the above describes. A pure-optimistic alternative (guess a rating, correct later) would pollute FSRS with a provisional rating and require a reversal — rejected (violates evidence-first + FSRS is not cheaply reversible). *Ruled D3 (§5): record-unjudged, defer FSRS.*

### 2.1 practice submit (`submit.ts:322`)

- **Applies only to the `auto_rate` server-judge path** (`resolveDurableDivert`, submit.ts:318 / #1068). A **manual-rating** submit never calls the judge — it writes the `review` event + advances FSRS synchronously with `body.rating` and is untouched by this design.
- **Pending UX (auto_rate path):** answer card shows "判题中"; the question stays in the session as answered-pending. No score/feedback yet.
- **Write timing (auto_rate path):** attempt/`review` event written unjudged at submit; FSRS transition + auto-rate application deferred to the worker's backfill event (RULED D4).
- **YUK-444 synergy:** ⭐ This is the surface where deferred-reveal fits perfectly (see §2.6).

### 2.2 agency probe-answer (`probe-answer.ts:218`)

- **Pending UX:** probe shows "评估中". Note the ND-5 red line: `answerProbe` writes exactly ONE `experimental:probe_result` outcome event — under async that single write moves to the worker (probe recorded-pending at submit, `probe_result` written on completion).
- **Write timing:** the probe is a placement/calibration signal (n=1 anchor); it's *inherently* tolerant of a few-seconds delay — arguably the easiest surface to migrate first after submit. The photo-only fail-closed 422 gate stays synchronous (it's a pure route-resolution check, no LLM call), so a mis-routed photo-only probe still rejects instantly.

### 2.3 rating advice (`advice.ts:61`) — the no-persist preview face (special-cased)

**Grounded correction:** `advice.ts` is a *pre-submit RatingAdvisor preview route* (its header: "T-RA — pre-submit RatingAdvisor preview route (YUK-98)"). It calls `invoke()`, resolves a cause, optionally signs a provenance token, and returns `Response.json` — it writes **NO domain event, NO FSRS, NO attempt**. So the §2 shared "run_id = attempt/outcome event id" contract **does not hold for advice** — there is no attempt event to anchor on, and there is nothing to backfill into.

Advice is therefore handled as its own case, NOT folded into the four persisting faces:

- **Run handle:** advice's `judge_run` uses a **freshly-generated opaque `run_id`** (used only as the `job_events` business_id + SSE handle). Do **not** fabricate a dummy domain event just to manufacture an anchor.
- **Backfill = pure verdict return.** The worker writes only `judge_run.done` with the `JudgeResultV2` + the provenance-token fields advice already returns; the client renders the suggested rating when the event lands. There is no deferred FSRS/mistake/probe_result write on this face (nothing persists — it's a preview).
- **Degraded semantics (advice-specific):** on failure the preview simply doesn't resolve — client shows "评分建议暂不可用"; because nothing was recorded, there is no unjudged-attempt cleanup and no rejudge obligation (unlike the four persisting faces). The learner can still submit and get the real (also-async) verdict on the submit face.
- **Wave placement:** advice can ride W3 with these bespoke semantics, but it is the lowest-stakes face (a preview a user may never act on) — if W3 needs trimming, advice is the safe one to defer. *(No owner ruling needed; mechanical.)*

**The auto_rate regression (separate from advice, lives on the submit face):** any surface with `auto_rate=true` (submit path) currently relies on "suggested wins → final rating at submit". Async breaks the synchronous availability of the suggestion. Options, all deferring FSRS to backfill: (a) auto-rate is applied by the worker at backfill time (user sees "判题中" → rating appears); (b) auto-rate degrades to manual self-rating while async is the main path. **Ruled D4 (§5): option (a) — worker applies auto-rate at backfill.**

### 2.4 paper submit (`paper-submit.ts:525`)

- Papers already have a claim/release protocol (`PAPER_JUDGE_STARTED_ACTION` / `PAPER_JUDGE_RELEASED_ACTION` events, paper-submit.ts:245-270) — a paper is a multi-question batch that already models "judging in progress" as events. **This surface is the most naturally async of the five**: the durable job maps cleanly onto per-question `judge_run`s, and the existing started/released events become the pending/done UI signal. Recommend paper submit rides the same `judge_run` job, one per question/part_ref.

### 2.5 solve session (`solve-session.ts:334`)

- Uses an injectable `judgeFn` already (test seam) — swapping the sync invoke for an enqueue is a localized change. Multi-step solve answers (text steps + final) are exactly the vision-judge (`steps` / `multimodal_direct`) traffic that is slowest and most endpoint-down-exposed, so this surface benefits most from the widened durable retry budget.
- **Write timing:** solve enrolls a mistake when the attempt scores below mastery — that enrollment moves to the backfill event (record attempt unjudged → worker judges → worker enrolls mistake if below threshold).

### 2.6 YUK-444 deferred-reveal synergy (⭐ the natural absorber)

The ticket asks to flag this and it's real: **a confidence self-assessment interstitial exactly absorbs the pending latency.** The intended UX (YUK-444) is: after the learner answers, before the verdict is revealed, they self-rate their confidence. That interstitial is dead time *by design* — and it is precisely the window the durable judge needs to complete. So the deferred-reveal flow and async-judge are complementary: the interstitial hides the pending delay, and the verdict is ready (or nearly) by the time the learner finishes self-rating.

**Caveat (grounded):** YUK-444 / axis A10 (`confidence`/`calibration_curve`) is currently **HOLD** — `src/db/schema.ts:1544` states "A10 (confidence/calibration_curve, YUK-444) is HOLD". So this is a *forward-compatibility* synergy to design toward, **not** a live dependency. Async-judge must stand on its own pending UX (§2.1) and must not block on YUK-444 landing; when A10 ships, the interstitial slots in as the pending-latency mask with zero rework if we keep the pending contract event-driven.

---

## 3. Durable job design (`judge_run`)

### 3.1 Job contract

```ts
// enqueued by each migrated caller; consumed by a new worker handler
interface JudgeRunJobData {
  // For the FOUR persisting faces (submit/probe/paper/solve): run_id = the
  // attempt/outcome domain event id — the same id anchors the backfilled verdict
  // + FSRS write and is the job_events business_id. For the `advice` face there is
  // NO such event (it's a pure preview, §2.3), so run_id = a freshly-generated
  // opaque id used ONLY as the job_events business_id + SSE run handle. Do NOT
  // fabricate a dummy domain event for advice just to have an anchor.
  run_id: string;
  caller: 'submit' | 'probe' | 'paper' | 'solve' | 'advice';  // surface; 'advice' = no-persist preview
  // RULED D5 — the FULL SubjectProfile is FROZEN into the payload at enqueue (JSON),
  // NOT a subject_id to be re-resolved at pickup. This matches #1068's implemented
  // shape (`submit.subject_profile: unknown`, re-validated worker-side via
  // `SubjectProfileSchema.parse`). Freezing the whole profile guarantees the verdict
  // reflects the profile active when the learner answered — never one edited between
  // enqueue and pickup. The submit face nests its frozen inputs so the worker can
  // reuse the SAME judgeSubmit/persistSubmit head/body (byte-parity with sync):
  submit: {
    body: SubmitBody;              // the validated request body (answer, auto_rate, rating, …)
    question_id: string;
    subject_profile: SubjectProfile;   // D5-frozen; SubjectProfileSchema.parse on the worker
    submitted_at: string;              // ISO; the answer instant
  };
  // (W3 faces carry their own frozen-input shape; only the run_id anchor rule and the
  // frozen-profile rule are universal — the rest of the payload is per-face.)
}
```

`run_id` for the persisting faces = the worker-written attempt/outcome event id (the idempotency anchor, §3.2); for `advice` it is a freshly-generated opaque id (§2.3). No per-field `subject_id`/`answer_md` at the top level — those live inside the frozen per-face input block.

Handler wraps `JudgeInvoker.invoke()` (`invoker.ts:104`) — the exact same chokepoint the sync path uses, so route resolution / narrowing / capability-ref version pin / telemetry are unchanged. **On success:** `writeJobEvent(tx, {business_table:'judge_run', business_id:run_id, event_type:'judge_run.done', payload: JudgeResultV2 + telemetry})` **and** — for the four persisting faces — perform the deferred FSRS/mistake/probe_result write in the same tx (atomic verdict + state). The `advice` face writes only the `judge_run.done` job_event (no domain/FSRS write).

**On failure — write the failed trace in the `catch`, do NOT rely on DLQ to write it.** Grounded correction: under this repo's pg-boss config, a re-throw only schedules a delayed redelivery; when retries exhaust and the job lands in `<queue>_dlq`, **the handler is not invoked again**, so no terminal `job_event` gets written from the DLQ landing. The established convention is `note_generate.ts:293-305`: the handler's own `catch` writes the failed status in its own best-effort tx **before re-throwing** ("Mark failed so UI doesn't sit on 'pending' forever; pg-boss will still retry per policy because we rethrow"). So `judge_run` must, in its `catch`: (1) `writeJobEvent(..., event_type:'judge_run.attempt_failed', payload:{attempt, error, next: 'redelivery'|'dlq'})` in a best-effort tx (a cleanup throw is logged, never masks the original error), then (2) re-throw so pg-boss redelivers per `JOB_RETRY_LIMIT`. **Terminal-failed semantics:** the status reducer treats the latest `attempt_failed` as the current failed state (`deriveJudgeRunStatus`); a later successful redelivery writes `judge_run.done` which supersedes it (last-writer-wins, same as the copilot reducer). On DLQ exhaustion the last `attempt_failed` trace IS the terminal record — nothing further runs, which is exactly why the trace must be written each attempt, not deferred to the DLQ. (The handler may distinguish the final attempt via pg-boss's retry-count on the job to stamp `next:'dlq'`, but must not depend on any post-DLQ callback.)

### 3.2 Idempotency

`run_id` (the anchor event id) is the idempotency key, mirroring copilot's `run_id = user_ask event id = job_events business_id`. Redelivery re-runs the same logical judge; the terminal-write step must be idempotent on `run_id` (guard: skip if a terminal `judge_run.done` already exists for this `business_id`, or upsert-on-conflict the FSRS/outcome write). This matches the copilot enqueue-failure compensation discipline (chat.ts:158+).

### 3.3 job_events, kill switch, budget

- **Progress events:** `judge_run.queued|started|running|done|failed` via `writeJobEvent`. Append `'judge_run'` to `JOB_EVENT_KIND_SET` (job-events.ts:49) or the SSE stream 400s.
- **Queue config:** register `judge_run` as an **LLM-tier** queue (`EXPIRE_LLM = 3_600` / 1h; single ~30–90s LLM call, unlike copilot's AGENT tier). DLQ `judge_run_dlq` via `jobQueueOpts` (`queue-config.ts`). Retry policy inherited: `JOB_RETRY_LIMIT = 2`, `JOB_RETRY_DELAY_SECONDS = 30`, `retryBackoff: true`.
- **Stuck-run guard:** any internal timeout must stay `< STUCK_RUN_THRESHOLD_MS = 3_600_000` (1h, `ai_task_run_reconcile.ts:47`) so the stuck-in-running sweeper doesn't false-converge a live run — same static constraint copilot's `DURABLE_BUDGET` respects.
- **Kill switch:** an env flag `JUDGE_DURABLE_ENABLED` (per the repo's `*_ENABLED` ledger convention, reconciled by `pnpm audit:flags`) gates the enqueue path so we can dark-ship and instantly fall back to sync if the durable lane misbehaves. *This is the fallback lever referenced in §4.*

### 3.4 Cross-provider retry & the cost lever

This is the endpoint-down payload and the part that is **new** (not just relocated):

- **A per-call provider override ALREADY exists** (grounded correction — earlier draft overstated this as "needs new plumbing"): `RunTaskCtx.override?: { provider?; model? }` (`runner.ts:101`) is threaded into `resolveTaskProvider(kind, ctx.override)` (called at `runner.ts:763` + `:844`), whose resolution chain is `override?.provider ?? envOverride?.provider ?? def.defaultProvider` (`providers.ts:205,214`). So the handler can pin a provider per-attempt today by passing `ctx.override = { provider: 'anthropic-sub' }` — no new runner seam required. The global `AI_PROVIDER_OVERRIDE` env (`providers.ts:155`) stays the deployment-wide switch and sits *below* the per-call override in that same chain.
- **What is actually new** is only the durable-retry-layer **decision logic**: on redelivery, the handler must decide *when* to flip `ctx.override.provider` to the fallback (e.g. read pg-boss's retry-count / prior `attempt_failed` traces → on the last redelivery, pass `override.provider = JUDGE_FALLBACK_PROVIDER`). That's a handful of lines in the `judge_run` handler, not a runner change. The `budgetOverride` seam (`runner.ts:184`, YUK-575) is the sibling precedent for per-call overrides riding `ctx`.
- **Retry-layer discipline — the durable path must EXPLICITLY force in-process transient retry OFF (concrete mechanism, not a slogan):** the two vision judges **default `enableTransientRetry: true`** — `steps-judge.ts:297` and `multimodal-direct-judge.ts:233` set it (YUK-576 opt-in, justified for the *synchronous* route where one in-process retry is the only retry layer), and the invoker's default runner is careful to *preserve* that opt-in through to the runner (`invoker.ts:150-172`, YUK-589 K2). If the durable handler simply reused the invoker, it would inherit `enableTransientRetry: true` and stack an in-process retry loop *on top of* queue redelivery → paid inference calls multiply. So the durable handler must **override it to false**. #1068 implements this by threading a `durable: {…}` marker into the invoke call, which makes the invoker force `enableTransientRetry: false` regardless of the judge's default (durable also carries the optional `providerOverride` in that same marker). Result: **queue redelivery is the ONLY transient layer**, so worst-case paid inference calls per logical judge = `1 + JOB_RETRY_LIMIT = 3` (`queue-config.ts` documents this). Cross-provider retry must fit *inside* that budget: attempt 1 = mimo, redelivery 1 = mimo (transient), redelivery 2 = anthropic-sub (last-resort).
- **Cost lever:** owner leaned "open, no daily cap" for anthropic-sub fallback in YUK-592 — **but that was the sync scenario**; the ticket explicitly says re-evaluate for async. In async, redelivery makes retries cheaper to reason about (bounded at 3 paid calls/job) but also *automatic* (no human in the loop). Env cost lever `JUDGE_FALLBACK_PROVIDER` (default `anthropic-sub`) + the bounded `JOB_RETRY_LIMIT` as the cap, rather than an unbounded daily-spend fallback. *Ruled D7 (§5): bounded — `1 + JOB_RETRY_LIMIT` cap, anthropic-sub on final redelivery.*

### 3.5 Reuse / fork points vs copilot durable (YUK-575)

| Mechanism | Reuse from copilot? |
|-----------|--------------------|
| `job_events` + `writeJobEvent` + `pg_notify` | **Reuse verbatim** |
| Generic SSE `/api/jobs/<kind>/<id>/events` + `computeReplay` | **Reuse** (add `judge_run` to allowlist) |
| Status reducer (`deriveCopilotRunStatus`) | **Fork** — write a parallel `deriveJudgeRunStatus` (same shape; judge has no cancel/chip semantics, simpler) |
| Pickup-stall detection (`isDurablePickupStalled`, `PICKUP_TIMEOUT_MS`) | **Reuse** (pure predicate, caller-agnostic) |
| Queue config / DLQ / retry policy (`jobQueueOpts`) | **Reuse**; register at LLM tier not AGENT |
| Per-call provider override (`RunTaskCtx.override` → `resolveTaskProvider`, `runner.ts:101/763/844`, `providers.ts:205`) | **Reuse as-is** — already per-call; handler just sets `ctx.override.provider` on the fallback redelivery (RULED D9). `budgetOverride` (`runner.ts:184`) is the sibling seam precedent. |
| Enqueue-failure compensation (write FAILED job_event so status ≠ stuck-queued) | **Reuse pattern** (chat.ts:158+) |

The fork is deliberately small: judge is a single stateless LLM call (no conversation memory, no tool loop, no MCP surface), so it does *not* need `assembleCopilotRunInput`, the tool registry mount, skills resolution, or the AGENT-tier budget. The durable judge handler is much thinner than `copilot_run.ts`.

### 3.6 Durable-lane correctness hardening (admission control, crash-window reconcile, dual idempotency, retention)

These four are correctness requirements surfaced in review — resolved here with the recommended approach + implementation wave (no new owner ballot items; all follow from the ruled decisions).

- **(a) Admission control must run HTTP-side, BEFORE enqueue (W2 contract).** Today `checkRateLimit()` lives *inside* `judgeSubmit` (submit.ts:350). On the durable path the request returns at `enqueueDurableJudge` *before* `judgeSubmit` runs — so the AI-funnel rate limit would be bypassed at the HTTP boundary and instead evaluated in the worker per redelivery (wrong layer: a retry storm could each re-consume/skip the budget). **Contract:** `checkRateLimit()` executes once at the HTTP route (`createAttempt`, before `resolveDurableDivert`/enqueue) so every submit — sync or diverted — is admission-controlled at the request boundary exactly once. The worker's reused `judgeSubmit` runs with `skipRateLimit: true` (redeliveries are already-admitted work; they must neither re-charge nor bypass the funnel). **Wave: W2** (part of the submit divert; #1068 must satisfy this before submit flips on).
- **(b) Crash-window between attempt-marker commit and enqueue → reconcile (no lost run).** `enqueueDurableJudge` writes the `QUEUED` `job_event` (commit) and *then* `boss.send` — two separate operations, **not one tx** (pg-boss `send` is its own INSERT). The existing `catch` compensates a *thrown* `boss.send`, but a hard crash between the QUEUED commit and a durable `send` leaves a run whose latest `job_event` is `QUEUED` with **no pg-boss job to pick it up → permanent pending.** **Remediation:** a periodic **reconcile sweeper** scans `judge_run` business_ids whose latest event is `QUEUED` (never `STARTED`) older than a threshold (reuse `isDurablePickupStalled` semantics) with no live pg-boss job, and **re-enqueues** them. The repo already has the pattern to lean on — the **event-write outbox** (`docs/adr/0021-event-write-outbox-pattern.md`, `drizzle/0017_outbox_event_ingest.sql`): the cleanest form is to enqueue *through* the outbox (the QUEUED marker + the send-intent commit in one tx, a relay drains to pg-boss), which closes the window entirely. **Wave: W2-hardening** — ship the sweeper with the submit flip (a stalled-QUEUED run is a real user-visible permanent-pending, not a nicety); the full outbox-relay form can follow if the sweeper proves insufficient.
- **(c) Two DIFFERENT idempotencies — don't conflate them.**
  - **Redelivery idempotency (handled):** pg-boss re-runs the same job on retry. Guarded by the review event PK = `run_id`: the worker's persist tx conflicts on the existing row and returns `skipped: already_persisted` (implemented in #1068's handler). This protects the *same* logical run from double-persisting.
  - **Request idempotency (NEW design point):** an HTTP client that times out on the 202 and **retries the POST** generates a *fresh* `run_id` (`newId()`) → a *second* `judge_run` job → double judging (double paid inference) and potentially two attempt events for one answer. The redelivery guard does NOT catch this (different run_id). **Remediation:** accept a client-supplied idempotency key (e.g. `Idempotency-Key` header, or a client-generated `submit_nonce` in the body) and dedupe server-side at `createAttempt` — first request reserves the key→run_id mapping, a retry with the same key returns the *existing* run's 202 instead of enqueuing again. Fallback if clients can't supply one: server-side dedupe on `(question_id, session_id, answer_hash)` within a short window. **Wave: W2** for the submit face (double inference is a real cost + FSRS-integrity risk); the key plumbs through to all faces in W3.
- **(d) Retention vs the real source of truth (`/status` beyond 7d).** As §1.2 tier-3 states, `job_events` is retained only `RETENTION_7D`; the **permanent** record is the domain event (`review`/`probe_result`, keyed by `run_id`). **`/status` contract:** resolve in order — (1) terminal `job_event` (`done`/`attempt_failed`) if present; (2) else the **domain event by `run_id`** → reconstruct `done` (the verdict is embedded in the review/judge event payload); (3) else, if the run is younger than the pickup deadline, `queued`/`running` from the live `job_events`; (4) else `expired_unknown` (older than retention, no domain event ever written — a genuinely-lost run, which the reconcile sweeper (b) should have caught earlier). This makes a client offline past 7d still able to learn its verdict from the durable domain log. **Wave: W2** (the `/status` route ships in W1/W2; the domain-event fallback is part of its contract).

---

## 4. Migration waves

| Wave | Scope | Exit criteria |
|------|-------|---------------|
| **W1 — dark-ship the job** | Build `judge_run` handler + queue registration + `JOB_EVENT_KIND_SET` entry + `deriveJudgeRunStatus` + status/SSE routes. Enqueue behind `JUDGE_DURABLE_ENABLED=false`. No caller switched yet. | Handler unit + DB tests green; `judge_run` visible in `/api/jobs/...` SSE for a manually enqueued run; DLQ wired; `audit:flags` reconciles the new flag. |
| **W2 — submit face to main path** | Switch `submit.ts` to enqueue + 202-pending (auto_rate path only; manual rating stays synchronous, §2.1); UI "判题中 → 回填"; FSRS + auto-rate deferred to backfill (D4); wire the §3.6 hardening: (a) `checkRateLimit` HTTP-side before enqueue, (b) stalled-QUEUED reconcile sweeper, (c) request-idempotency key + dedupe, (d) `/status` domain-event fallback. | Submit returns 202-pending; attempt recorded unjudged; verdict + FSRS land on backfill event; endpoint-down soak (kill the endpoint, confirm cross-provider recovery within `1+retryLimit`); rate limit enforced once at HTTP boundary; a crash between QUEUED-marker and enqueue is recovered by the sweeper; a duplicate POST returns the same run (no double inference). |
| **W3 — remaining faces** | probe-answer, solve-session, paper-submit, advice → enqueue. paper rides per-question `judge_run`. | Each surface returns pending + backfills; probe `probe_result` / solve mistake-enrollment / paper claim-release all move to worker tx; full cross-face coverage-list ticked. |
| **W4 — remove the sync fast path** (RULED D8) | Delete the synchronous judge invoke branch at all five caller sites + the `JUDGE_DURABLE_ENABLED` gate. **Gated on the D8 validation criterion**, not folded into W2/W3. | Submit face ran fully async N=7–14 consecutive days with `judge_run_dlq` depth 0, zero flag-flip reversions, and ≥1 production endpoint-down soak with cross-provider recovery observed (§5 D8). Removal PR references YUK-594 as an owner-instructed deletion. |

**Sync fast-path disposition (RULED D8 — owner-instructed deletion):** the flag-gated sync fallback (`JUDGE_DURABLE_ENABLED=false` reverts any face to synchronous judging) is **transitional only** — an escape hatch for W2/W3 while async proves out. Owner ballot (2026-07-24) overrode the "keep as permanent fallback" recommendation: once async is validated (D8 criterion), the sync path is **removed outright** in W4. This is the explicit locked-decision exception to the CLAUDE.md "demote, don't delete" product principle — owner-instructed, so it does not violate the pre-AI-feature protection. Tone owner set: aggressive and clean, no over-engineering hedge. The sync path is a temporary bridge, not a keeper.

---

## 5. Decisions (RULED — owner ballot 2026-07-24)

Owner ballot closed 2026-07-24. Overall tone owner set: **aggressive and clean — do not hedge for over-engineering.** All nine ruled below; each carries the ruling + the reason of record. D1-D7 and D9 ratify the recommendation; **D8 deviates from the recommendation** — see its note.

- **D1 — Scope of "async-main" — RULED: all five sync faces migrate, phased (W2 submit, W3 rest).** ✔ ratifies recommendation. The ruling covers 全部判题面; phasing manages risk without narrowing scope.
- **D2 — Backfill channels — RULED: three-tier (SSE + poll + replay).** ✔ Single-user self-hosted with flaky Cloudflare ingress; poll fallback + retained terminal event guarantees no stranded verdict.
- **D3 — Write timing — RULED: record-unjudged-then-backfill, FSRS deferred to the worker tx.** ✔ Evidence-first; FSRS is not cheaply reversible; reuses the existing recorded-but-unjudged path.
- **D4 — auto_rate under async — RULED: worker applies auto-rate at backfill (rating appears when the verdict lands).** ✔ Preserves the auto-rate product behavior; the only cost is the few-seconds delay the pending UX already communicates.
- **D5 — Profile resolution timing — RULED: resolve `SubjectProfile` at enqueue, freeze into the job payload.** ✔ The verdict reflects the profile active when the learner answered, not one edited between enqueue and pickup (matches copilot's ambient RIDE-in-payload rationale). Cheap, deterministic.
- **D6 — DLQ recovery policy — RULED: manual-only for now (existing `rejudge.ts`); no auto-sweep subsystem yet.** ✔ Don't build auto-recovery before observing real DLQ traffic (避免 建成不通电).
- **D7 — Cross-provider fallback cost lever — RULED: bounded — cap = `1 + JOB_RETRY_LIMIT` paid calls/job, `anthropic-sub` only on the final redelivery, env `JUDGE_FALLBACK_PROVIDER`.** ✔ Async makes fallback automatic (no human gate), so the bounded redelivery budget is the natural cap; the YUK-592 "open, no daily cap" stance was a sync-scenario lean, re-evaluated for async per the ticket.
- **D8 — Sync fast-path fate — RULED: REMOVE the synchronous fast path after async validation. ⚠ DEVIATES from the recommendation (which was "keep as fallback indefinitely").** This is an **owner-instructed deletion** — the explicit, locked-decision exception to the pre-AI "demote, don't delete" discipline (CLAUDE.md Product principle). Owner directive: once async is validated, delete the sync judging path outright rather than retaining it as a permanent fallback. The flag-gated fallback is a **transitional** escape hatch (W2/W3 only), not a keeper.
  - **Validation criterion (recommended, owner to confirm the numbers):** remove the sync path once the **submit face has run fully async for N consecutive days (suggest N = 7–14) with zero `judge_run_dlq` accumulation and zero flag-flip reversions to sync.** Concretely: (a) `judge_run_dlq` depth stays 0 across the window (no job exhausts retries), (b) `JUDGE_DURABLE_ENABLED` never toggled back to sync for an incident, (c) endpoint-down soak (§4 W2 exit) passed at least once in production with cross-provider recovery observed. When all three hold, a follow-up removal PR deletes the sync invoke branches at the five caller sites + the `JUDGE_DURABLE_ENABLED` gate.
  - Removal is a **separate scheduled wave (W4)**, gated on the criterion above — not folded into W2/W3.
- **D9 — Provider-override plumbing — RULED: reuse the EXISTING per-call `ctx.override` mechanism; the only new code is the durable-retry decision to switch provider on redelivery.** ✔ Grounded correction (earlier draft overstated this as "needs entirely new plumbing"): `RunTaskCtx.override` → `resolveTaskProvider` already resolves `override → env → registry` per call (`runner.ts:101/763/844`, `providers.ts:205,214`). No new runner seam. The `judge_run` handler sets `ctx.override.provider = JUDGE_FALLBACK_PROVIDER` on the fallback redelivery (decision logic keyed on retry-count / prior `attempt_failed` traces). The global `AI_PROVIDER_OVERRIDE` env remains the deployment-wide switch, below the per-call override in the same chain.

---

## 6. Interaction with related issues

- **YUK-575 (durable lane infra, Wave 3 in flight) — prerequisite.** This design *reuses* YUK-575's landed seams (`job_events`, generic SSE route, pickup-stall detection, `budgetOverride`, enqueue-failure compensation, DLQ/retry config). Judge_run is a thinner sibling of `copilot_run` on the same rails. Sequencing: judge_run W1 should land *after* YUK-575's seams are stable on `main`, to avoid forking the infra.
- **YUK-573 (judge calibration, MF5 lane snapshot).** The calibration sampler (`judge-calibration-sample-core.ts:243`) already calls `judgeAnswer` on a second provider lane in the worker — it is the living precedent that judge-in-worker works. Under async, the durable judge must stamp its **lane provenance** (provider/model) into telemetry so YUK-573's `same_lane` inference and re-judge override protection stay correct. The `JudgeInvocationTelemetry` already carries `capability_ref`/`profile_version` (`invoker.ts:63`); add the resolved provider/model to the job's terminal payload so calibration can read the *actual* lane that produced each async verdict (crucial once cross-provider fallback means the lane isn't fixed).
- **YUK-576 (fallbackChain removal + `transientRetries`).** Directly constrains §3.4: `transientRetries` is the in-process opt-in that stays **OFF** for durable handlers (queue redelivery is the sole transient layer). The `judge_run` handler must NOT opt into `transientRetries`, or the paid-call budget doubles. YUK-576's honesty pass (declared-but-unwired `fallbackChain`) also means the cross-provider fallback here is the *real, wired* replacement for the dead `fallbackChain` declaration — worth noting so the two don't both claim to own provider fallback.

---

## Appendix — grounding index (all `main@90d605e2`)

- Sync callers: `submit.ts:322`, `probe-answer.ts:218`, `paper-submit.ts:525`, `advice.ts:61`, `solve-session.ts:334`.
- Chokepoint: `JudgeInvoker.invoke` `src/server/judge/invoker.ts:104`; `judgeAnswer` wrapper `question-contract.ts:288` (durable consumers: `rejudge.ts:79`, `judge-calibration-sample-core.ts:243`).
- Durable precedent: `copilot_run.ts` (handler), `chat.ts:140-158` (202 dispatch), `copilot-run-status.ts:71` (status reducer), `durable-pickup.ts:27` (pickup stall).
- Infra: `writer.ts:22` (`writeJobEvent`), `sse_replay.ts` (`computeReplay`), `job-events.ts:35/49` (generic SSE + `JOB_EVENT_KIND_SET`), `queue-config.ts` (`EXPIRE_LLM`/DLQ/`JOB_RETRY_LIMIT`), `ai_task_run_reconcile.ts:47` (`STUCK_RUN_THRESHOLD_MS`), `runner.ts:184` (`budgetOverride`), `runner.ts:773`/`agent-run-error.ts:51` (`RETRY_ELAPSED_CAP_MS`), `runner.ts:547` + `registry.ts:1153` (90s judge `budget.timeout` abort timer), `providers.ts:155` (`AI_PROVIDER_OVERRIDE`), `RunTaskCtx.override`→`resolveTaskProvider` (`runner.ts:101/763/844`, `providers.ts:205`).
- YUK-444 HOLD: `src/db/schema.ts:1544` (A10 confidence/calibration_curve HOLD).
