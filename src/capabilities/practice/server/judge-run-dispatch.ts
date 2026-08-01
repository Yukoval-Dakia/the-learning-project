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
import { event, job_events } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { getStartedBoss } from '@/server/boss/client';
import { observeBossJob } from '@/server/boss/job-observation';
import { checkRateLimit, refundRateLimit } from '@/server/http/rate-limit';
import { and, asc, eq, gt, lt, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { JobWithMetadata } from 'pg-boss';
import { JUDGE_RUN_QUEUE } from './judge-durable-config';
import type { JudgeRunJobData } from './judge-run-payload';
import {
  JUDGE_RUN_EVENTS,
  JUDGE_RUN_TABLE,
  JudgeRunRequeuedPayloadSchema,
} from './judge-run-status';

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
  return durableJudgeJobId(`judge_run:${runId}`);
}

/** A fresh, deterministic pg-boss UUID for one recovery delivery. */
export function judgeRecoveryJobId(runId: string, attempt: number): string {
  return durableJudgeJobId(`judge_run:${runId}:recovery:${attempt}`);
}

function durableJudgeJobId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
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
  /** Frozen hierarchical-Elo domain rows this attempt can write. */
  abilityGlobalIds?: string[];
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
  const payload = JudgePendingAttemptPayload.parse({
    run_id: input.runId,
    caller: 'submit',
    knowledge_ids: input.knowledgeIds,
    ability_global_ids: input.abilityGlobalIds ?? [],
    submit: {
      body: input.submit.body,
      question_id: input.submit.question_id,
      subject_profile: input.submit.subject_profile,
      question_snapshot: input.submit.question_snapshot,
      ability_global_by_knowledge_id: input.submit.ability_global_by_knowledge_id,
      submitted_at: input.submit.submitted_at,
    },
  });
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
  opts: { jobId?: string; token?: number; acceptExistingJobId?: boolean } = {},
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
      if (opts.acceptExistingJobId && opts.jobId) {
        // Deterministic recovery retry: ON CONFLICT means this exact delivery already exists.
        // No new paid work was created, so return this call's admission token before treating the
        // existing delivery as durable success.
        (deps.refundRateLimit ?? refundRateLimit)(rateLimitToken);
        rateLimitToken = null;
        return opts.jobId;
      }
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

/**
 * May the automatic sweeper create a fresh delivery for this queue state?
 *
 * Absence/completion can represent the dispatch gaps the sweeper owns. A failed or cancelled
 * job is deliberate terminal/DLQ evidence and is manual-only under D6; queue deadness alone must
 * never turn that operator boundary into more paid calls.
 */
export type AutomaticRecoveryEligibility = 'eligible' | 'live' | 'manual' | 'unknown';

export interface JudgeQueueInspection {
  liveness: QueueLiveness;
  eligibility: AutomaticRecoveryEligibility;
}

/**
 * Read one pg-boss row once and derive both poll liveness and automatic-recovery eligibility.
 * Keeping these decisions on one snapshot avoids a second queue round-trip disagreeing with the
 * first during a status poll.
 */
export async function inspectJudgeQueue(
  runId: string,
  deps: {
    boss?: { getJobById: (queue: string, id: string) => Promise<JobWithMetadata | null> };
    jobId?: string;
  } = {},
): Promise<JudgeQueueInspection> {
  const observation = await observeBossJob(JUDGE_RUN_QUEUE, deps.jobId ?? judgeRunJobId(runId), {
    ...(deps.boss ? { boss: deps.boss } : {}),
  });
  switch (observation.kind) {
    case 'missing':
      return { liveness: 'dead', eligibility: 'eligible' };
    case 'live':
      return { liveness: 'live', eligibility: 'live' };
    case 'settled':
      if (observation.state === 'completed') {
        return { liveness: 'dead', eligibility: 'eligible' };
      }
      console.warn(
        `[judge_run] ${runId} pg-boss job is terminal (state=${observation.state}) — automatic recovery is manual-only`,
      );
      return { liveness: 'dead', eligibility: 'manual' };
    case 'unknown':
      console.error(
        '[judge_run] pg-boss lookup failed while inspecting run',
        runId,
        observation.error,
      );
      return { liveness: 'unknown', eligibility: 'unknown' };
  }
}

export async function resolveAutomaticRecoveryEligibility(
  runId: string,
  deps: {
    boss?: { getJobById: (queue: string, id: string) => Promise<JobWithMetadata | null> };
    jobId?: string;
  } = {},
): Promise<AutomaticRecoveryEligibility> {
  return (await inspectJudgeQueue(runId, deps)).eligibility;
}

export async function resolveQueueLiveness(
  runId: string,
  deps: {
    boss?: { getJobById: (queue: string, id: string) => Promise<JobWithMetadata | null> };
    /** Latest recovery delivery id; absent means the original deterministic delivery. */
    jobId?: string;
  } = {},
): Promise<QueueLiveness> {
  return (await inspectJudgeQueue(runId, deps)).liveness;
}

export interface JudgeRecoveryMetadata {
  latestDeliveryId: string | null;
  attempts: number;
  hasTerminalFailure: boolean;
}

/**
 * Read the recovery marker, distinct-attempt budget, and terminal-failure evidence in one query.
 * Distinct identity falls back to the delivery id for legacy markers that predate `attempt`.
 */
export async function getJudgeRecoveryMetadata(
  db: Db,
  runId: string,
): Promise<JudgeRecoveryMetadata> {
  const rows = await db
    .select({
      latestPayload: sql<unknown>`(
        array_agg(${job_events.payload} order by ${job_events.id} desc)
        filter (where ${job_events.event_type} = ${JUDGE_RUN_EVENTS.REQUEUED})
      )[1]`,
      attempts: sql<number>`count(distinct case
        when ${job_events.event_type} = ${JUDGE_RUN_EVENTS.REQUEUED}
        then coalesce(
          ${job_events.payload}->>'attempt',
          ${job_events.payload}->>'delivery_id',
          ${job_events.payload}->>'job_id'
        )
      end)::int`,
      terminalFailures: sql<number>`count(*) filter (
        where ${job_events.event_type} = ${JUDGE_RUN_EVENTS.FAILED}
      )::int`,
    })
    .from(job_events)
    .where(and(eq(job_events.business_table, JUDGE_RUN_TABLE), eq(job_events.business_id, runId)));
  const row = rows[0];
  const parsed = JudgeRunRequeuedPayloadSchema.safeParse(row?.latestPayload);
  if (row?.latestPayload != null && !parsed.success) {
    console.warn('[judge_run] latest recovery marker failed its payload contract', {
      run_id: runId,
      error: parsed.error.message,
    });
  }
  const latestDeliveryId = parsed.success
    ? (parsed.data.delivery_id ?? parsed.data.job_id ?? null)
    : null;
  return {
    latestDeliveryId,
    attempts: row?.attempts ?? 0,
    hasTerminalFailure: (row?.terminalFailures ?? 0) > 0,
  };
}

/** Latest successfully recorded recovery delivery, used by poll and subsequent sweeps. */
export async function latestJudgeRecoveryJobId(db: Db, runId: string): Promise<string | null> {
  return (await getJudgeRecoveryMetadata(db, runId)).latestDeliveryId;
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
export async function pendingAttemptRecordedAt(db: Db, runId: string): Promise<Date | null> {
  const rows = await db
    .select({ createdAt: event.created_at })
    .from(event)
    .where(
      and(
        eq(event.action, JUDGE_PENDING_ATTEMPT_ACTION),
        sql`${event.payload} @> ${JSON.stringify({ run_id: runId })}::jsonb`,
      ),
    )
    .limit(1);
  return rows[0]?.createdAt ?? null;
}

export async function hasPendingAttemptEvidence(db: Db, runId: string): Promise<boolean> {
  return (await pendingAttemptRecordedAt(db, runId)) !== null;
}

export const JUDGE_RECOVERY_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
export const JUDGE_MAX_RECOVERY_ATTEMPTS = 2;

export function hasAutomaticRecoveryBudgetFor(
  recordedAt: Date | null,
  recovery: JudgeRecoveryMetadata,
  now = new Date(),
): boolean {
  return (
    recordedAt !== null &&
    recordedAt.getTime() > now.getTime() - JUDGE_RECOVERY_MAX_AGE_MS &&
    recovery.attempts < JUDGE_MAX_RECOVERY_ATTEMPTS
  );
}

/** Whether a pending run remains inside the automatic sweeper's age and attempt bounds. */
export async function hasAutomaticRecoveryBudget(
  db: Db,
  runId: string,
  now = new Date(),
): Promise<boolean> {
  const [recordedAt, recovery] = await Promise.all([
    pendingAttemptRecordedAt(db, runId),
    getJudgeRecoveryMetadata(db, runId),
  ]);
  return hasAutomaticRecoveryBudgetFor(recordedAt, recovery, now);
}

export interface StalledPendingAttempt {
  pendingEventId: string;
  payload: JudgePendingAttemptPayloadT;
  submittedAt: Date;
}

export interface StalledPendingAttemptPage {
  attempts: StalledPendingAttempt[];
  /** Raw rows consumed before malformed legacy payloads were discarded. */
  rowsRead: number;
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
  args: { stalledBefore: Date; recordedAfter: Date; limit: number; offset?: number },
): Promise<StalledPendingAttemptPage> {
  const backfilled = alias(event, 'backfilled_attempt');
  const terminalRun = alias(job_events, 'terminal_judge_run');
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
        // Persisted terminal/manual decisions must be filtered BEFORE LIMIT/OFFSET. Otherwise
        // 200 immutable rows at the front of the window make every hourly sweep restart on the
        // same dead prefix and permanently starve a later dispatch gap. Exhausted recovery
        // budgets remain visible once so the sweeper can persist their terminal decision too.
        notExists(
          db
            .select({ one: sql`1` })
            .from(terminalRun)
            .where(
              and(
                eq(terminalRun.business_table, JUDGE_RUN_TABLE),
                eq(terminalRun.business_id, sql`${event.payload}->>'run_id'`),
                eq(terminalRun.event_type, JUDGE_RUN_EVENTS.FAILED),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(event.created_at))
    .limit(args.limit)
    .offset(args.offset ?? 0);

  const attempts = rows.flatMap((row) => {
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
  return { attempts, rowsRead: rows.length };
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
 * Overlap is material overlap: the same question, any shared knowledge id, or any shared frozen
 * hierarchical-Elo domain. Every membership predicate uses top-level `payload @> ...`
 * containment so `event_payload_idx` (`jsonb_path_ops`) can support it.
 */
export async function hasNewerAttemptEvidence(
  tx: Tx,
  args: {
    submittedAt: Date;
    questionId: string;
    knowledgeIds: string[];
    abilityGlobalIds: string[];
    /** This run's own pending row must not count as evidence against itself. */
    excludeRunId: string;
  },
): Promise<boolean> {
  const knowledgeOverlap =
    args.knowledgeIds.length === 0
      ? sql`false`
      : sql`(${sql.join(
          args.knowledgeIds.map(
            (id) => sql`${event.payload} @> ${JSON.stringify({ knowledge_ids: [id] })}::jsonb`,
          ),
          sql` OR `,
        )})`;
  const abilityGlobalOverlap =
    args.abilityGlobalIds.length === 0
      ? sql`false`
      : sql`(${sql.join(
          args.abilityGlobalIds.map(
            (id) => sql`${event.payload} @> ${JSON.stringify({ ability_global_ids: [id] })}::jsonb`,
          ),
          sql` OR `,
        )})`;
  const rows = await tx
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, JUDGE_PENDING_ATTEMPT_ACTION),
        gt(event.created_at, args.submittedAt),
        sql`${event.payload}->>'run_id' <> ${args.excludeRunId}`,
        sql`(
          ${event.payload} @> ${JSON.stringify({ submit: { question_id: args.questionId } })}::jsonb
          OR ${knowledgeOverlap}
          OR ${abilityGlobalOverlap}
        )`,
      ),
    )
    // The overlap predicate is applied before the cap. Non-overlapping traffic can never hide a
    // relevant newer answer, regardless of how many other questions were submitted meanwhile.
    .limit(1);
  return rows.length > 0;
}
