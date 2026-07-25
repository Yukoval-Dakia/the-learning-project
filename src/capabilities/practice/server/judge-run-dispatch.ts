// YUK-777 (A2 / A3 / B2) — the durable judge DISPATCH protocol, in one place.
//
// W1/W2 dispatched a judge by doing exactly one durable thing: `boss.send`. That made the
// pg-boss payload the sole home of the learner's answer between the 202 and a successful
// backfill, so a run that exhausted its deliveries into `judge_run_dlq` — or whose question
// was deleted before pickup — lost the answer outright (codex #Tu71c, confirmed). This
// module inverts that: the answer becomes IMMUTABLE DOMAIN EVIDENCE first, and the queue
// becomes merely the (retryable, replaceable) delivery mechanism for judging it.
//
// The three exported pieces are one protocol, deliberately not three modules:
//
//   1. `recordJudgePendingAttempt` — writes the `experimental:judge_pending_attempt` event.
//      MUST happen before the send. Keeping both halves here is what stops the ordering
//      invariant from being re-derived (and eventually inverted) at each call site.
//   2. `enqueueJudgeRun` — the ONE rate-limited entry into the `judge_run` queue. Every
//      producer goes through it: the submit face, the reconcile sweeper, and (YUK-800) the
//      manual DLQ re-enqueue. A producer that bypassed it would spend paid inference outside
//      the AI budget window — precisely the failure mode that hurts most when a provider is
//      already rate-limiting us.
//   3. `findStalledJudgePendingAttempts` / `resolveQueueLiveness` — the domain-state scan the
//      sweeper runs. It keys on the DOMAIN log, never on `job_events`: per design §3.6b a
//      `job_events`-keyed recovery is structurally blind to the crash window it exists to
//      cover (send-first ordering can leave a job with no marker, and a marker-first ordering
//      can leave a marker with no job).

import { createHash } from 'node:crypto';
import { newId } from '@/core/ids';
import {
  JudgePendingAttemptPayload,
  type JudgePendingAttemptPayloadT,
} from '@/core/schema/event/judge-pending-events';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { getStartedBoss } from '@/server/boss/client';
import { checkRateLimit, refundRateLimit } from '@/server/http/rate-limit';
import { and, asc, eq, gt, lt, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { JobWithMetadata } from 'pg-boss';
import { JUDGE_RUN_QUEUE } from './judge-durable-config';
import type { JudgeRunJobData } from './judge-run-payload';

/** The reserved action name. Single source for the writer, the scan, and the guard. */
export const JUDGE_PENDING_ATTEMPT_ACTION = 'experimental:judge_pending_attempt' as const;

/**
 * The pg-boss job id for a run handle.
 *
 * **pg-boss job ids are `uuid` COLUMNS.** Our run handles are cuid2s (`newId()`), so passing
 * one as `SendOptions.id` makes Postgres throw `invalid input syntax for type uuid` — i.e. W2's
 * `boss.send(..., { id: runId })` would have failed on the very first real submit after
 * `JUDGE_DURABLE_ENABLED` was flipped on, and `getJobById(queue, runId)` would have thrown on
 * every liveness lookup (swallowed into `'unknown'`, so `/status` would have degraded silently
 * rather than telling anyone). Nothing caught it because every test injects a fake boss whose
 * `send` accepts any id — a double MORE permissive than production. Verified against real
 * pg-boss in judge-run-dispatch-boss-contract.db.test.ts.
 *
 * Deriving the uuid instead of storing a mapping keeps the run handle the single identifier
 * everything else is keyed on (the review event id, the job_events business_id, the pending
 * attempt's `run_id`), while still giving the poll route and the sweeper a direct PK lookup.
 * RFC 9562 UUIDv8 (custom): a sha-256 of a fixed namespace + the run handle, with the version
 * and variant bits stamped — deterministic, and collision-resistant well past the point where
 * anything else here would break first.
 */
export function judgeRunJobId(runId: string): string {
  const hex = createHash('sha256').update(`judge_run:${runId}`).digest('hex');
  const bytes = hex.slice(0, 32).split('');
  bytes[12] = '8'; // version 8 (custom)
  const variantNibble = (Number.parseInt(bytes[16], 16) & 0x3) | 0x8; // variant 10xx
  bytes[16] = variantNibble.toString(16);
  const h = bytes.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// ============================================================================
// 1. Immutable answer evidence (A2)
// ============================================================================

export interface RecordJudgePendingAttemptInput {
  /** The reserved run handle — also the id the worker will give the `review` event. */
  runId: string;
  sessionId: string | null;
  questionId: string;
  /** The question's OWN labels at answer time = the θ̂ write domain (⊇ the FSRS subset). */
  knowledgeIds: string[];
  /** The frozen judge input, stored verbatim so recovery re-judges the same inputs (D5). */
  submit: JudgeRunJobData['submit'];
  /** The answer instant — the ordering water mark. Also the row's `created_at`. */
  submittedAt: Date;
}

/**
 * Write the "answered, not yet judged" evidence row and return its event id.
 *
 * `created_at` is the ANSWER instant, not the insert instant: the row is a water mark for the
 * late-arrival guard, and a wall-clock stamp taken here would order two attempts by when their
 * request happened to reach this line rather than by when the learner answered.
 *
 * `ingest_at` is stamped (ADR-0021 opt-out) for two reasons. The row is a job-plane ledger
 * carrying a frozen judge payload, so feeding it to memory ingestion would push the whole
 * frozen question snapshot into Mem0; and the answer reaches memory anyway through the
 * `review` event the backfill writes. The opt-out also empties `affected_scopes`, which keeps
 * brief scans from reading an unjudged attempt as learner evidence.
 */
export async function recordJudgePendingAttempt(
  db: Db | Tx,
  input: RecordJudgePendingAttemptInput,
): Promise<string> {
  const pendingEventId = newId();
  const payload: JudgePendingAttemptPayloadT = {
    run_id: input.runId,
    caller: 'submit',
    knowledge_ids: input.knowledgeIds,
    submit: {
      body: input.submit.body as Record<string, unknown>,
      question_id: input.submit.question_id,
      subject_profile: input.submit.subject_profile as Record<string, unknown>,
      question_snapshot: input.submit.question_snapshot as Record<string, unknown>,
      submitted_at: input.submit.submitted_at,
    },
  };
  await writeEvent(db, {
    id: pendingEventId,
    session_id: input.sessionId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: JUDGE_PENDING_ATTEMPT_ACTION,
    subject_kind: 'question',
    subject_id: input.questionId,
    // NULL — an unjudged attempt has no outcome. See the schema docblock: that absence is
    // what keeps this row out of every success/failure aggregate.
    outcome: null,
    payload,
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: input.submittedAt,
    ingest_at: input.submittedAt,
  });
  return pendingEventId;
}

// ============================================================================
// 2. The single rate-limited enqueue face
// ============================================================================

export interface JudgeRunEnqueueDeps {
  /** test seam — default `getStartedBoss()`. */
  boss?: {
    send: (name: string, data: unknown, options?: { id?: string }) => Promise<string | null>;
  };
  /** test seam — default the real process-wide paid-AI budget gate. */
  checkRateLimit?: () => number;
  /** test seam — paired refund for the failed-enqueue path. */
  refundRateLimit?: (token: number) => void;
}

/**
 * Charge the paid-AI budget for one judge_run, returning the token to refund if it never
 * ships. Split out from {@link enqueueJudgeRun} for the one caller that must settle ADMISSION
 * before doing anything durable: the submit route records the learner's answer before it
 * dispatches, and a rate-limited submit has to be refused cleanly. Leaving a recorded pending
 * attempt behind a 429 would have the sweeper judge it minutes later — quietly turning a
 * refusal into a deferral and letting every rejected submit through the budget after all.
 */
export function admitJudgeRun(deps: JudgeRunEnqueueDeps = {}): number {
  return (deps.checkRateLimit ?? checkRateLimit)();
}

/**
 * Enqueue a `judge_run`, charging the paid-AI budget exactly once.
 *
 * **Every** producer must come through here. `checkRateLimit` is a process-local window, so
 * this is not one shared counter across API and worker — that is fine and intended: the API
 * face limits learner-driven dispatch, and the worker face (sweeper, and later the manual DLQ
 * re-enqueue) limits recovery-driven dispatch inside the process that issues it. What matters
 * is that no producer exists with NO gate, which is what a bespoke `boss.send` would create.
 *
 * The gate stays BEFORE the send — moving it after would enqueue a paid job and then reject
 * the client, who retries and enqueues another — and the token is REFUNDED when the enqueue
 * fails, so a transient pg-boss blip cannot burn budget with no job to show for it.
 *
 * `opts.token` lets a caller that already went through {@link admitJudgeRun} hand its token
 * over rather than be charged twice; the refund-on-failure guarantee is identical either way.
 *
 * `jobId` pins the pg-boss job id to the run handle (the YUK-758 orchestrator idiom) so the
 * poll route can do a PK lookup. Recovery re-enqueues deliberately pass NO `jobId`: the
 * original job id is still occupied by the failed/DLQ'd job, and an id collision there returns
 * null (ON CONFLICT DO NOTHING), which would silently refuse every recovery attempt.
 */
export async function enqueueJudgeRun(
  job: JudgeRunJobData,
  deps: JudgeRunEnqueueDeps = {},
  opts: { jobId?: string; token?: number } = {},
): Promise<string> {
  let rateLimitToken: number | null = null;
  try {
    rateLimitToken = opts.token ?? admitJudgeRun(deps);
    const boss = deps.boss ?? (await getStartedBoss());
    const jobId = await boss.send(
      JUDGE_RUN_QUEUE,
      job,
      opts.jobId === undefined ? undefined : { id: opts.jobId },
    );
    if (!jobId) {
      throw new ApiError(
        'durable_enqueue_failed',
        `judge_run enqueue returned no jobId for run ${job.run_id}`,
        503,
      );
    }
    // Durable from here: the budget token was genuinely spent.
    rateLimitToken = null;
    return jobId;
  } catch (err) {
    if (rateLimitToken !== null) (deps.refundRateLimit ?? refundRateLimit)(rateLimitToken);
    throw err;
  }
}

// ============================================================================
// 3. The domain-state scan (A3) + queue liveness
// ============================================================================

/**
 * pg-boss states from which a job can still run.
 *
 * W5 #TumMo — existence is NOT the question; LIVENESS is. `getJobById` returns a row for
 * terminal states too, so treating one as alive tells a poller to keep waiting on a job that
 * will never emit another event, and tells the sweeper to skip a run nothing will ever judge.
 *
 * pg-boss 12 types the field as `'created' | 'retry' | 'active' | 'completed' | 'cancelled' |
 * 'failed'`. There is no separate `expired` state: a job never picked up before its expire
 * window lands in `failed`, which this set already excludes.
 */
const LIVE_BOSS_STATES: ReadonlySet<JobWithMetadata['state']> = new Set([
  'created',
  'retry',
  'active',
] as const);

/**
 * Can this run still make progress on the queue?
 *
 * Deliberately TRI-state. A boolean would fold "pg-boss says this job is dead" together with
 * "pg-boss did not answer", and those demand opposite responses: the first lets a poller stop
 * and lets the sweeper act, while the second must change nothing — declaring a genuinely
 * in-flight run dead is a far worse error than waiting one more cycle.
 *
 * `dead` also covers a null row: pg-boss prunes completed jobs on its own retention, so an
 * absent job is either long-finished or long-gone.
 */
export type QueueLiveness = 'live' | 'dead' | 'unknown';

export async function resolveQueueLiveness(
  runId: string,
  deps: {
    boss?: { getJobById: (queue: string, id: string) => Promise<JobWithMetadata | null> };
  } = {},
): Promise<QueueLiveness> {
  try {
    const boss = deps.boss ?? (await getStartedBoss());
    const job = await boss.getJobById(JUDGE_RUN_QUEUE, judgeRunJobId(runId));
    if (job === null) return 'dead';
    const { state } = job;
    if (LIVE_BOSS_STATES.has(state)) return 'live';
    console.warn(
      `[judge_run] ${runId} pg-boss job is not live (state=${state}) — it will not progress further`,
    );
    return 'dead';
  } catch (err) {
    console.error('[judge_run] pg-boss lookup failed while resolving run liveness', runId, err);
    return 'unknown';
  }
}

/**
 * Was this run's answer recorded, whatever became of its job?
 *
 * The `/status` route's last-resort branch used to choose between 404 ("no such run") and
 * `failed` ("this will never be judged") purely from `job_events`. Since the answer is now
 * recorded before dispatch, a run can exist with neither a job nor a marker — a failed
 * enqueue — and both of those answers would be wrong for it. One indexed containment lookup
 * (the `event_payload_idx` GIN index) settles it.
 */
export async function hasPendingAttemptEvidence(db: Db, runId: string): Promise<boolean> {
  const rows = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, JUDGE_PENDING_ATTEMPT_ACTION),
        sql`${event.payload} @> ${JSON.stringify({ run_id: runId })}::jsonb`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export interface StalledPendingAttempt {
  pendingEventId: string;
  payload: JudgePendingAttemptPayloadT;
  submittedAt: Date;
}

/**
 * Scan the DOMAIN log for attempts recorded before `stalledBefore` whose verdict never landed.
 *
 * "Verdict never landed" is `NOT EXISTS (event WHERE id = payload.run_id)`: the backfill tx
 * writes the `review` event with that exact id, so its absence means no delivery ever
 * committed. That question is answerable without pg-boss AND without `job_events`, which is
 * the entire point — it holds whether the crash lost the job, lost the marker, or lost both.
 *
 * **The "was it judged?" test is in the WHERE clause, not applied after the LIMIT.** Pending
 * rows are immutable and never deleted, so the judged ones accumulate forever in front of the
 * unjudged ones. Paging the oldest N first and filtering afterwards would therefore return an
 * empty page — and hide every genuinely stranded answer behind them — as soon as N judged
 * attempts existed inside the recovery window. `limit` has to bound the ANSWER set, not the
 * candidate set.
 *
 * `limit` bounds one sweep. A backlog drains over successive ticks instead of putting an
 * unbounded number of paid judge jobs on the queue in a single burst.
 */
export async function findStalledJudgePendingAttempts(
  db: Db,
  args: { stalledBefore: Date; recordedAfter: Date; limit: number },
): Promise<StalledPendingAttempt[]> {
  const backfilled = alias(event, 'backfilled_attempt');
  const rows = await db
    .select({ id: event.id, payload: event.payload, created_at: event.created_at })
    .from(event)
    .where(
      and(
        eq(event.action, JUDGE_PENDING_ATTEMPT_ACTION),
        lt(event.created_at, args.stalledBefore),
        // Older than the recovery window: the row stays as permanent evidence, but automatic
        // recovery stops (the caller's bound explains why).
        gt(event.created_at, args.recordedAfter),
        notExists(
          db
            .select({ one: sql`1` })
            .from(backfilled)
            .where(eq(backfilled.id, sql`${event.payload}->>'run_id'`)),
        ),
      ),
    )
    .orderBy(asc(event.created_at))
    .limit(args.limit);

  return rows.flatMap((row) => {
    const result = JudgePendingAttemptPayload.safeParse(row.payload);
    if (!result.success) {
      // Unreachable through `writeEvent` (the parse barrier rejects a malformed payload), so
      // this can only be hand-edited or pre-schema data. Skip it loudly rather than throwing:
      // one bad row must not stop the sweep from recovering every other stranded answer.
      console.error(
        '[judge_pending_reconcile] skipping a pending-attempt row with an unreadable payload',
        row.id,
        result.error.message,
      );
      return [];
    }
    return [{ pendingEventId: row.id, payload: result.data, submittedAt: row.created_at }];
  });
}

// ============================================================================
// 4. The evidence water mark (B2)
// ============================================================================

/**
 * Is there evidence of a NEWER attempt on material this attempt would write?
 *
 * B2 (codex #Tu1cY) — the projection-based half of the late-arrival guard reads state that a
 * skipped run never wrote. Run B (newer, covering K1+K2) is judged late because of K2, so it
 * skips EVERY derived write and leaves K1's `last_review` / `last_outcome_at` untouched; the
 * older run A, covering only K1, then reads those stale projections, passes the check, and
 * walks K1 backwards. One skip lets every older attempt behind it through.
 *
 * The fix is to stop asking derived state when the answer lives in immutable evidence. A
 * pending-attempt row is written for EVERY durable attempt at submit time and is never
 * conditional on a verdict landing, so B is visible here whether or not it wrote anything.
 *
 * Overlap is material overlap: the same question, or any shared knowledge id (the θ̂ domain,
 * which is a superset of the FSRS subset). Rows are filtered in memory after an indexed
 * `(action, created_at)` range read — the scan is bounded by `limit` and by the fact that only
 * attempts NEWER than this one can match, which for a healthy lane is a handful.
 */
export async function hasNewerAttemptEvidence(
  tx: Tx,
  args: {
    now: Date;
    questionId: string;
    knowledgeIds: string[];
    /** This run's own pending row must not count as evidence against itself. */
    excludeRunId: string;
    limit?: number;
  },
): Promise<boolean> {
  const rows = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(and(eq(event.action, JUDGE_PENDING_ATTEMPT_ACTION), gt(event.created_at, args.now)))
    .orderBy(asc(event.created_at))
    .limit(args.limit ?? NEWER_EVIDENCE_SCAN_LIMIT);
  const mine = new Set(args.knowledgeIds.filter((id) => id.length > 0));
  for (const row of rows) {
    const payload = row.payload as unknown as Partial<JudgePendingAttemptPayloadT>;
    if (payload.run_id === args.excludeRunId) continue;
    if (payload.submit?.question_id === args.questionId) return true;
    for (const id of payload.knowledge_ids ?? []) {
      if (mine.has(id)) return true;
    }
  }
  return false;
}

/**
 * Bound on one water-mark read. Only attempts submitted AFTER the one being persisted can
 * appear, so in a healthy lane this is 0–2 rows; the cap exists so a pathological backlog
 * degrades into "read the oldest N" rather than an unbounded scan inside the attempt tx.
 */
const NEWER_EVIDENCE_SCAN_LIMIT = 200;
