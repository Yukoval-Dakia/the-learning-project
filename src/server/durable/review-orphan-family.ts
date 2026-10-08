import { DBOS } from '@dbos-inc/dbos-sdk';
import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import {
  learning_session,
  review_orphan_control,
  review_orphan_disposition,
  review_orphan_receipt,
  review_orphan_tick,
} from '@/db/schema';
import {
  ContractEpochFenceError,
  gateContractEpoch,
  readContractEpoch,
  waitForRunnableEpoch,
} from '@/server/contract-epoch';
import { abandonOrphanReviewSession } from '@/server/session/review';
import { lockProducerFenceInstaller } from './producer-fence-lock';

export const REVIEW_ORPHAN_FAMILY = 'prune_orphan_review_sessions';
export const reviewOrphanPhaseSchema = z.enum([
  'pg-boss',
  'draining-pg-boss',
  'dbos',
  'draining-dbos',
]);
export type ReviewOrphanPhase = z.infer<typeof reviewOrphanPhaseSchema>;
const backendSchema = z.enum(['pg-boss', 'dbos']);
// Validate without converting to Date: PostgreSQL retains its microseconds.
const timestampSchema = z
  .string()
  .min(1)
  .refine((s) => Number.isFinite(Date.parse(s)), 'Invalid PG timestamp');
const candidateSchema = z.object({
  sessionId: z.string().min(1),
  selectedStartedAt: timestampSchema,
  selectedVersion: z.number().int().nonnegative(),
});
const outcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('abandoned'),
    fromVersion: z.number().int(),
    toVersion: z.number().int(),
  }),
  z.object({
    kind: z.literal('skipped'),
    reason: z.enum(['missing', 'terminal', 'reopened', 'not-old']),
  }),
  z.object({ kind: z.literal('deferred-known-failure'), error: z.string().min(1) }),
]);
export type ReviewOrphanOutcome = z.infer<typeof outcomeSchema>;
const tickSchema = z.object({
  tick_id: z.string(),
  backend: backendSchema,
  provenance: z.enum(['scheduled', 'legacy-first-admission']),
  tick_at: timestampSchema,
  cutoff: timestampSchema,
  admission: z.enum(['admitted', 'fenced']),
  candidates: z.array(candidateSchema),
  contract_version: z.literal(1),
});
type SavedTick = z.infer<typeof tickSchema>;
const inputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dbos'), workflowId: z.string().min(1), scheduledAt: z.date() }),
  z.object({ kind: z.literal('pg-boss'), jobId: z.uuid() }),
]);
export type ReviewOrphanTickInput = z.infer<typeof inputSchema>;
type ReviewOrphanCounts = {
  tickId: string;
  candidates: number;
  abandoned: number;
  skipped: number;
  deferred: number;
};
export type ReviewOrphanSummary =
  | (ReviewOrphanCounts & { kind: 'complete'; deferred: 0 })
  | (ReviewOrphanCounts & { kind: 'completed-with-deferred' })
  | { kind: 'fenced'; tickId: string; candidates: 0; abandoned: 0; skipped: 0; deferred: 0 };
export type ReviewOrphanBoundary =
  | { kind: 'selection-committed'; tickId: string }
  | { kind: 'row-committed'; tickId: string; sessionId: string }
  | { kind: 'checkpoint-saved'; tickId: string };
export type ReviewOrphanBoundaryHook = (event: ReviewOrphanBoundary) => Promise<void>;
type Executor = Pick<Db, 'execute'>;

export class ReviewOrphanIdentityConflict extends Error {}
export class ReviewOrphanUnknownOutcome extends Error {
  constructor(
    readonly tickId: string,
    readonly sessionId: string | null,
    cause: unknown,
  ) {
    super(`Review orphan outcome unknown: ${tickId}${sessionId ? `/${sessionId}` : ''}`, { cause });
  }
}

export async function readReviewOrphanPhase(db: Executor): Promise<ReviewOrphanPhase> {
  const rows = await db.execute(sql`select phase from review_orphan_control`);
  return reviewOrphanPhaseSchema.parse(rows[0]?.phase);
}

async function lockPhase(tx: Tx): Promise<ReviewOrphanPhase> {
  await tx.execute(sql`select phase from review_orphan_control for share`);
  return readReviewOrphanPhase(tx);
}
async function readTick(tx: Tx, id: string): Promise<SavedTick | null> {
  const rows = await tx.execute(sql`select tick_id, backend, provenance, tick_at::text,
    cutoff::text, admission, candidates, contract_version from review_orphan_tick
    where tick_id = ${id} for update`);
  return rows.length ? tickSchema.parse(rows[0]) : null;
}
function tickId(input: ReviewOrphanTickInput) {
  return input.kind === 'dbos' ? input.workflowId : `legacy:${input.jobId}`;
}
async function validateIdentity(tx: Tx, saved: SavedTick, input: ReviewOrphanTickInput) {
  if (saved.backend !== input.kind) throw new ReviewOrphanIdentityConflict('Tick backend conflict');
  if (input.kind === 'dbos') {
    const [row] = await tx.execute(sql`select ${saved.tick_at}::timestamptz =
      ${input.scheduledAt.toISOString()}::timestamptz as same`);
    if (row?.same !== true)
      throw new ReviewOrphanIdentityConflict('Tick scheduled timestamp conflict');
  }
}

async function admitTick(db: Db, input: ReviewOrphanTickInput): Promise<SavedTick> {
  return db.transaction(async (tx) => {
    const phase = await lockPhase(tx);
    const id = tickId(input);
    // Admission has no row yet; this lock also reconciles a lost admission COMMIT.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 1393))`);
    const saved = await readTick(tx, id);
    if (saved) {
      await validateIdentity(tx, saved, input);
      return saved;
    }
    const [clock] = await tx.execute(sql`select clock_timestamp()::text as at,
      coalesce(legacy_not_before <= clock_timestamp(), true) as legacy_ready from review_orphan_control`);
    const at =
      input.kind === 'dbos' ? input.scheduledAt.toISOString() : timestampSchema.parse(clock?.at);
    const [time] = await tx.execute(
      sql`select (${at}::timestamptz - interval '6 hours')::text as cutoff`,
    );
    const cutoff = timestampSchema.parse(time?.cutoff);
    const authorized =
      input.kind === 'dbos'
        ? phase === 'dbos'
        : phase === 'pg-boss' && clock?.legacy_ready === true;
    const candidates = authorized
      ? await tx
          .select({
            sessionId: learning_session.id,
            selectedStartedAt: sql<string>`${learning_session.started_at}::text`,
            selectedVersion: learning_session.version,
          })
          .from(learning_session)
          .where(
            and(
              eq(learning_session.type, 'review'),
              inArray(learning_session.status, ['started', 'paused']),
              sql`${learning_session.started_at} < ${cutoff}::timestamptz`,
            ),
          )
          .orderBy(learning_session.id)
      : [];
    await tx.insert(review_orphan_tick).values({
      tick_id: id,
      backend: input.kind,
      provenance: input.kind === 'dbos' ? 'scheduled' : 'legacy-first-admission',
      // Raw strings preserve legacy database microseconds in both columns.
      tick_at: sql`${at}::timestamptz`,
      cutoff: sql`${cutoff}::timestamptz`,
      admission: authorized ? 'admitted' : 'fenced',
      candidates,
      contract_version: 1,
    });
    const admitted = await readTick(tx, id);
    if (!admitted) throw new Error('Admission did not persist');
    return admitted;
  });
}
async function readReceipt(
  tx: Tx,
  id: string,
  sessionId: string,
): Promise<ReviewOrphanOutcome | null> {
  const rows = await tx
    .select({ outcome: review_orphan_receipt.outcome })
    .from(review_orphan_receipt)
    .where(
      and(eq(review_orphan_receipt.tick_id, id), eq(review_orphan_receipt.session_id, sessionId)),
    );
  return rows.length ? outcomeSchema.parse(rows[0].outcome) : null;
}
function authorizeAdmitted(phase: ReviewOrphanPhase, saved: SavedTick) {
  const authorized =
    saved.backend === 'dbos'
      ? phase === 'dbos' || phase === 'draining-dbos'
      : phase === 'pg-boss' || phase === 'draining-pg-boss';
  if (saved.admission !== 'admitted' || !authorized)
    throw new Error(`Admitted tick ${saved.tick_id} cannot execute in ${phase}`);
}

export type ReviewOrphanOutcomeInspection =
  | { kind: 'committed'; outcome: ReviewOrphanOutcome }
  | { kind: 'not-committed' }
  | { kind: 'unknown'; error: string };
/** The writable primary's tick lock waits for the original transaction to resolve. No mutation. */
export async function inspectReviewOrphanOutcome(
  db: Db,
  input: { tickId: string; sessionId: string },
): Promise<ReviewOrphanOutcomeInspection> {
  try {
    return await db.transaction(async (tx) => {
      await lockPhase(tx);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.tickId}, 1393))`);
      const saved = await readTick(tx, input.tickId);
      if (!saved) return { kind: 'not-committed' };
      const outcome = await readReceipt(tx, input.tickId, input.sessionId);
      return outcome ? { kind: 'committed', outcome } : { kind: 'not-committed' };
    });
  } catch (error) {
    return { kind: 'unknown', error: String(error) };
  }
}

async function commitRow(
  db: Db,
  saved: SavedTick,
  candidate: z.infer<typeof candidateSchema>,
  deferred?: string,
): Promise<ReviewOrphanOutcome> {
  return db.transaction(async (tx) => {
    const phase = await lockPhase(tx);
    const locked = await readTick(tx, saved.tick_id);
    if (!locked) throw new Error('Frozen tick is missing');
    // Receipt wins over current session state and even subsequent phase transitions.
    const prior = await readReceipt(tx, saved.tick_id, candidate.sessionId);
    if (prior) return prior;
    authorizeAdmitted(phase, locked);
    if (deferred)
      await tx.execute(
        sql`select id from learning_session where id = ${candidate.sessionId} for update`,
      );
    const outcome: ReviewOrphanOutcome = deferred
      ? { kind: 'deferred-known-failure', error: deferred }
      : await abandonOrphanReviewSession(tx, { candidate, cutoff: saved.cutoff });
    await tx
      .insert(review_orphan_receipt)
      .values({ tick_id: saved.tick_id, session_id: candidate.sessionId, outcome });
    return outcome;
  });
}

async function gateTickEpoch(db: Db, input: ReviewOrphanTickInput): Promise<void> {
  if (input.kind === 'dbos') return waitForRunnableEpoch(db);
  // Legacy housekeeping retains the existing drain disposition at an older active epoch.
  const verdict = gateContractEpoch(await readContractEpoch(db));
  if (!verdict.runnable && verdict.reason !== 'epoch_mismatch')
    throw new ContractEpochFenceError(`job:${REVIEW_ORPHAN_FAMILY}`, verdict);
}

export async function runReviewOrphanTick(
  db: Db,
  raw: ReviewOrphanTickInput,
  boundary: ReviewOrphanBoundaryHook = async () => {},
): Promise<ReviewOrphanSummary> {
  const input = inputSchema.parse(raw);
  const id = tickId(input);
  await gateTickEpoch(db, input);
  let saved: SavedTick;
  try {
    saved = await admitTick(db, input);
  } catch (error) {
    if (error instanceof ReviewOrphanIdentityConflict) throw error;
    // Same lock/identity: either recover the committed header or make the first admission.
    try {
      saved = await admitTick(db, input);
    } catch (reconciliationError) {
      if (reconciliationError instanceof ReviewOrphanIdentityConflict) throw reconciliationError;
      throw new ReviewOrphanUnknownOutcome(id, null, reconciliationError);
    }
  }
  await boundary({ kind: 'selection-committed', tickId: id });
  if (saved.admission === 'fenced')
    return { kind: 'fenced', tickId: id, candidates: 0, abandoned: 0, skipped: 0, deferred: 0 };
  const summary: ReviewOrphanCounts = {
    tickId: id,
    candidates: saved.candidates.length,
    abandoned: 0,
    skipped: 0,
    deferred: 0,
  };
  for (const candidate of saved.candidates) {
    await gateTickEpoch(db, input);
    let outcome: ReviewOrphanOutcome;
    try {
      outcome = await commitRow(db, saved, candidate);
    } catch (error) {
      const inspected = await inspectReviewOrphanOutcome(db, {
        tickId: id,
        sessionId: candidate.sessionId,
      });
      if (inspected.kind === 'unknown')
        throw new ReviewOrphanUnknownOutcome(id, candidate.sessionId, error);
      if (inspected.kind === 'committed') outcome = inspected.outcome;
      else {
        // Proven absence under the authoritative lock confirms rollback. Preserve the daily backstop.
        try {
          outcome = await commitRow(db, saved, candidate, String(error));
        } catch (receiptError) {
          const receipt = await inspectReviewOrphanOutcome(db, {
            tickId: id,
            sessionId: candidate.sessionId,
          });
          if (receipt.kind !== 'committed')
            throw new ReviewOrphanUnknownOutcome(id, candidate.sessionId, receiptError);
          outcome = receipt.outcome;
        }
      }
    }
    if (outcome.kind === 'abandoned') summary.abandoned++;
    else if (outcome.kind === 'skipped') summary.skipped++;
    else summary.deferred++;
    await boundary({ kind: 'row-committed', tickId: id, sessionId: candidate.sessionId });
  }
  return summary.deferred
    ? { ...summary, kind: 'completed-with-deferred' }
    : { ...summary, kind: 'complete', deferred: 0 };
}

export async function installReviewOrphanProducerFence(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await lockProducerFenceInstaller(tx);
    await tx.execute(sql`select pg_advisory_xact_lock(1393, 1)`);
    for (const table of ['job', 'schedule']) {
      await tx.execute(
        sql.raw(`DROP TRIGGER IF EXISTS yuk1393_review_orphan_producer ON pgboss.${table}`),
      );
      await tx.execute(
        sql.raw(
          `CREATE TRIGGER yuk1393_review_orphan_producer BEFORE INSERT OR UPDATE OF name ON pgboss.${table} FOR EACH ROW EXECUTE FUNCTION fence_review_orphan_producer()`,
        ),
      );
    }
  });
}

const obligationSchema = z.object({
  task_id: z.string(),
  state: z.string(),
  kind: z.enum(['task', 'receipt', 'forwarder']),
  session_id: z.string().nullable(),
});
export type ReviewOrphanObligation = z.infer<typeof obligationSchema>;
export async function reviewOrphanObligations(
  db: Executor,
  backend: 'pg-boss' | 'dbos',
): Promise<ReviewOrphanObligation[]> {
  const tasks =
    backend === 'pg-boss'
      ? await db.execute(sql`select j.id::text as task_id, j.state::text as state, 'task' as kind, null::text as session_id
      from pgboss.job j where j.name in ('prune_orphan_review_sessions','prune_orphan_review_sessions_dlq')
      and (j.state <> 'completed' or j.name = 'prune_orphan_review_sessions_dlq')
      and not exists (select 1 from review_orphan_disposition d where d.backend = 'pg-boss' and d.kind = 'terminal'
        and d.task_id = j.id::text and d.observed_state = j.state::text)
      union all select id::text, state::text, 'forwarder', null::text from pgboss.job
      where name = '__pgboss__send-it' and state <> 'completed'
        and (jsonb_typeof(data) is distinct from 'object'
          or jsonb_typeof(data->'name') is distinct from 'string'
          or data->>'name' = '' or data->>'name' = 'prune_orphan_review_sessions')`)
      : await db.execute(sql`select w.workflow_uuid as task_id, w.status as state, 'task' as kind, null::text as session_id
      from tlp_dbos.workflow_status w where w.name = 'prune_orphan_review_sessions'
      and (w.status <> 'SUCCESS' or not exists (select 1 from review_orphan_tick t where t.tick_id = w.workflow_uuid))
      and not exists (select 1 from review_orphan_disposition d where d.backend = 'dbos' and d.kind = 'terminal'
        and d.task_id = w.workflow_uuid and d.observed_state = w.status)`);
  const gaps =
    await db.execute(sql`select t.tick_id as task_id, 'missing-receipt' as state, 'receipt' as kind,
    c->>'sessionId' as session_id from review_orphan_tick t cross join lateral jsonb_array_elements(t.candidates) c
    where t.backend = ${backend} and not exists (select 1 from review_orphan_receipt r
      where r.tick_id = t.tick_id and r.session_id = c->>'sessionId')
    and not exists (select 1 from review_orphan_disposition d where d.backend = ${backend} and d.kind = 'terminal'
      and d.task_id = t.tick_id and d.observed_state = 'missing-receipt:' || (c->>'sessionId'))`);
  return z.array(obligationSchema).parse([...tasks, ...gaps]);
}

/** A source lookback is a minimum cooldown, never proof that suspended senders disappeared. */
export async function reviewOrphanRollbackHorizon(db: Executor) {
  const [row] = await db.execute(sql`select greatest(c.phase_changed_at,
    coalesce((select max(tick_at) from review_orphan_tick where backend = 'dbos'), c.phase_changed_at),
    coalesce((select max(substring(workflow_uuid from length('sched-prune_orphan_review_sessions-') + 1)::timestamptz)
      from tlp_dbos.workflow_status where name = 'prune_orphan_review_sessions'
      and workflow_uuid ~ '^sched-prune_orphan_review_sessions-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$'), c.phase_changed_at))
    + interval '60 seconds' as not_before from review_orphan_control c`);
  return timestampSchema.parse(row?.not_before);
}

export async function attestReviewOrphanQuiescence(db: Db, reason: string): Promise<void> {
  if (!reason.trim())
    throw new Error('Quiescence requires observed old-consumer and producer evidence');
  await db.transaction(async (tx) => {
    const [control] = await tx.execute(
      sql`select phase, phase_changed_at::text as barrier from review_orphan_control for update`,
    );
    const phase = reviewOrphanPhaseSchema.parse(control?.phase);
    if (phase !== 'draining-pg-boss' && phase !== 'draining-dbos')
      throw new Error('Quiescence is recorded only at a drain barrier');
    await tx.insert(review_orphan_disposition).values({
      id: createId(),
      backend: phase === 'draining-pg-boss' ? 'pg-boss' : 'dbos',
      task_id: timestampSchema.parse(control?.barrier),
      kind: 'quiescence',
      observed_state: phase,
      reason,
    });
  });
}

export type ReviewOrphanDispositionInput = {
  backend: 'pg-boss' | 'dbos';
  taskId: string;
  sessionId?: string;
  reason: string;
};
export async function retireFailedReviewOrphan(
  db: Db,
  input: ReviewOrphanDispositionInput,
): Promise<void> {
  if (!input.reason.trim()) throw new Error('Disposition requires a reason');
  await db.transaction(async (tx) => {
    await tx.execute(sql`select phase from review_orphan_control for update`);
    const tasks = await reviewOrphanObligations(tx, input.backend);
    const taskId =
      input.backend === 'pg-boss' && input.taskId.startsWith('legacy:')
        ? input.taskId.slice(7)
        : input.taskId;
    const task = tasks.find((r) => r.task_id === taskId && r.kind === 'task');
    const terminal =
      input.backend === 'pg-boss'
        ? ['failed', 'cancelled']
        : ['ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'];
    // A missing task cannot prove that an execution has stopped.
    if (!task || !terminal.includes(task.state))
      throw new Error('Only an observed terminal failure can be dispositioned');
    if (input.backend === 'pg-boss') {
      const [row] = await tx.execute(
        sql`select name, state::text as state from pgboss.job where id::text = ${taskId} for update`,
      );
      if (row?.state !== task.state) throw new Error('Terminal job state changed');
      if (row?.name !== REVIEW_ORPHAN_FAMILY)
        throw new Error('Unexpected DLQ requires investigation');
    } else {
      const [row] = await tx.execute(
        sql`select status from tlp_dbos.workflow_status where workflow_uuid = ${taskId} for update`,
      );
      if (row?.status !== task.state) throw new Error('Terminal workflow state changed');
    }
    const id = input.backend === 'pg-boss' ? `legacy:${taskId}` : taskId;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 1393))`);
    await readTick(tx, id);
    if (input.sessionId) {
      const gap = tasks.find(
        (r) => r.task_id === id && r.kind === 'receipt' && r.session_id === input.sessionId,
      );
      if (!gap || (await readReceipt(tx, id, input.sessionId)))
        throw new Error('No unresolved frozen row');
    }
    await tx.insert(review_orphan_disposition).values({
      id: createId(),
      backend: input.backend,
      task_id: input.sessionId ? id : taskId,
      kind: 'terminal',
      observed_state: input.sessionId ? `missing-receipt:${input.sessionId}` : task.state,
      reason: input.reason,
    });
  });
}

export async function changeReviewOrphanPhase(
  db: Db,
  boss: Pick<PgBoss, 'unschedule'>,
  target: ReviewOrphanPhase,
  schedules: Pick<typeof DBOS, 'getSchedule' | 'pauseSchedule'> = DBOS,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [control] = await tx.execute(
      sql`select phase, phase_changed_at::text as barrier from review_orphan_control for update`,
    );
    const current = reviewOrphanPhaseSchema.parse(control?.phase);
    if (current === target) return;
    const expected: Record<ReviewOrphanPhase, ReviewOrphanPhase> = {
      'draining-pg-boss': 'pg-boss',
      dbos: 'draining-pg-boss',
      'draining-dbos': 'dbos',
      'pg-boss': 'draining-dbos',
    };
    if (current !== expected[target])
      throw new Error(`Invalid review orphan transition ${current} -> ${target}`);
    if (target === 'dbos' || target === 'pg-boss') {
      const backend = target === 'dbos' ? 'pg-boss' : 'dbos';
      const obligations = await reviewOrphanObligations(tx, backend);
      // Legacy forwarding must also be absent on rollback, independent of workflow success.
      const forwarders =
        target === 'pg-boss'
          ? (await reviewOrphanObligations(tx, 'pg-boss')).filter((r) => r.kind === 'forwarder')
          : [];
      if (obligations.length || forwarders.length)
        throw new Error(
          `Review orphan drain blocked: ${JSON.stringify([...obligations, ...forwarders])}`,
        );
      const proof = await tx
        .select()
        .from(review_orphan_disposition)
        .where(
          and(
            eq(review_orphan_disposition.kind, 'quiescence'),
            eq(review_orphan_disposition.task_id, timestampSchema.parse(control?.barrier)),
            eq(review_orphan_disposition.observed_state, current),
          ),
        );
      if (!proof.length)
        throw new Error('Drain requires verified old-process and in-flight producer quiescence');
      if (target === 'pg-boss') {
        const horizon = await reviewOrphanRollbackHorizon(tx);
        const [clock] = await tx.execute(
          sql`select clock_timestamp() >= ${horizon}::timestamptz as ready`,
        );
        if (clock?.ready !== true)
          throw new Error(`Review orphan rollback cooldown until ${horizon}`);
        await tx
          .update(review_orphan_control)
          .set({ legacy_not_before: sql`${horizon}::timestamptz` });
      }
    }
    if (await schedules.getSchedule(REVIEW_ORPHAN_FAMILY))
      await schedules.pauseSchedule(REVIEW_ORPHAN_FAMILY);
    await boss.unschedule(REVIEW_ORPHAN_FAMILY);
    await tx
      .update(review_orphan_control)
      .set({ phase: target, phase_changed_at: sql`clock_timestamp()` });
  });
}
