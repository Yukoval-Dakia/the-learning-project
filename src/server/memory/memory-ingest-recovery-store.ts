import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { allowsDerivation } from '@/core/schema/derivation-policy';
import type { Db, Tx } from '@/db/client';
import { event, provider_attempt, provider_attempt_admission } from '@/db/schema';
import { providerOperationIdForInvocation } from '@/server/ai/provider-attempt-runtime';
import {
  type MemoryIngestReplayGrant,
  MemoryIngestReplayGrantSchema,
  type MemoryIngestReplayRequest,
  MemoryIngestReplayRequestSchema,
} from './memory-ingest-recovery-contract';
import {
  MEMORY_RECONCILE_HANDOFF_ACTION,
  MemoryReconcileHandoffError,
  canonicalHandoffJson,
  memoryReconcileHandoffEventId,
} from './memory-reconcile-handoff-identity';
import {
  readIngestCompleted,
  readMemoryIngestStarted,
  writeMemoryHandoffRecord,
} from './memory-reconcile-handoff-store';

const AUTHORIZED = 'operator_replay_authorized';
const STARTED = 'operator_add_started';
// Longer than the handler's 65-second provider deadline, including legacy markers.
const STALLED_SECONDS = 120;

export function memoryIngestReplayGrantId(grant: MemoryIngestReplayGrant): string {
  return memoryReconcileHandoffEventId(AUTHORIZED, 'operator', grant.request_id);
}

export function memoryIngestReplayAnchor(grant: MemoryIngestReplayGrant, anchor: string): string {
  return `memory-ingest-replay:${memoryIngestReplayGrantId(grant)}:${anchor}`;
}

async function lockSource(tx: Tx, sourceId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`memory:ingest:${sourceId}`}, 0))`,
  );
}

async function grantsForSource(db: Db | Tx, sourceId: string): Promise<MemoryIngestReplayGrant[]> {
  const rows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, MEMORY_RECONCILE_HANDOFF_ACTION),
        eq(event.subject_id, sourceId),
        eq(sql<string>`${event.payload} ->> 'handoff_kind'`, AUTHORIZED),
      ),
    )
    .orderBy(desc(event.dispatch_seq), desc(event.id));
  return rows.map((row) => {
    const parsed = MemoryIngestReplayGrantSchema.safeParse(row.payload);
    if (
      !parsed.success ||
      parsed.data.source_event_id !== sourceId ||
      row.id !== memoryIngestReplayGrantId(parsed.data) ||
      row.actor_kind !== 'system' ||
      row.subject_kind !== 'event' ||
      row.ingest_at === null
    )
      throw new MemoryReconcileHandoffError(`invalid operator grant ${row.id}`);
    return parsed.data;
  });
}

async function assertUserSource(db: Db | Tx, sourceId: string): Promise<void> {
  const rows = await db
    .select({ actor: event.actor_kind, payload: event.payload })
    .from(event)
    .where(eq(event.id, sourceId))
    .limit(1);
  if (rows[0]?.actor !== 'user' || !allowsDerivation(rows[0]?.payload))
    throw new MemoryReconcileHandoffError(
      `operator replay requires an existing user event ${sourceId}`,
    );
}

async function hasLiveAttempt(
  db: Db | Tx,
  sourceId: string,
  grants: MemoryIngestReplayGrant[],
): Promise<boolean> {
  const anchors = [sourceId, `conjecture-edit:${sourceId}`];
  const operationIds = anchors.flatMap((anchor) => [
    providerOperationIdForInvocation(anchor),
    ...grants.map((grant) =>
      providerOperationIdForInvocation(memoryIngestReplayAnchor(grant, anchor)),
    ),
  ]);
  const rows = await db
    .select({ id: provider_attempt.attempt_id })
    .from(provider_attempt)
    .innerJoin(
      provider_attempt_admission,
      eq(provider_attempt.attempt_id, provider_attempt_admission.attempt_id),
    )
    .where(
      and(
        inArray(provider_attempt.operation_id, operationIds),
        eq(provider_attempt.provider, 'mem0'),
        eq(provider_attempt.lane_id, 'mem0.event-memory'),
        inArray(provider_attempt.operation_kind, ['add_inferred', 'add_verbatim']),
        sql`${provider_attempt.provider_start_reserved_at} IS NOT NULL`,
        sql`${provider_attempt.finished_at} IS NULL`,
        inArray(provider_attempt_admission.status, ['acquired', 'would_deny']),
        sql`${provider_attempt_admission.lease_expires_at} > clock_timestamp()`,
        sql`${provider_attempt_admission.deadline_at} > clock_timestamp()`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

function latestFence(sourceId: string, grants: MemoryIngestReplayGrant[]): string {
  return grants[0]
    ? memoryIngestReplayGrantId(grants[0])
    : memoryReconcileHandoffEventId('add_started', sourceId);
}

/** Append authorization; logical supersession never deletes an old paid-start fence. */
export async function authorizeMemoryIngestReplay(
  db: Db,
  raw: MemoryIngestReplayRequest,
): Promise<MemoryIngestReplayGrant> {
  const input = MemoryIngestReplayRequestSchema.parse(raw);
  const grant: MemoryIngestReplayGrant = {
    version: 1,
    handoff_kind: AUTHORIZED,
    source_event_id: input.sourceEventId,
    request_id: input.requestId,
    expected_fence_id: input.expectedFenceId,
    operator: input.operator,
    reason: input.reason,
    allow_paid_replay: true,
  };
  return db.transaction(async (tx) => {
    await lockSource(tx, input.sourceEventId);
    // Global request identity also fences accidental reuse for another source.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`memory:operator-request:${input.requestId}`}, 0))`,
    );
    await assertUserSource(tx, input.sourceEventId);
    const existing = await tx
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.id, memoryIngestReplayGrantId(grant)))
      .limit(1);
    if (existing[0]) {
      if (canonicalHandoffJson(existing[0].payload) !== canonicalHandoffJson(grant))
        throw new MemoryReconcileHandoffError('operator request id conflicts');
      return grant;
    }
    const startedAt = await readMemoryIngestStarted(tx, input.sourceEventId);
    if (!startedAt || (await readIngestCompleted(tx, input.sourceEventId)))
      throw new MemoryReconcileHandoffError('source has no stalled add marker');
    const age = await tx.execute<{ stalled: boolean }>(
      sql`SELECT ${startedAt.toISOString()}::timestamptz <= clock_timestamp() - ${STALLED_SECONDS} * interval '1 second' AS stalled`,
    );
    if (!age[0]?.stalled)
      throw new MemoryReconcileHandoffError('add marker is too recent for operator replay');
    const grants = await grantsForSource(tx, input.sourceEventId);
    if (latestFence(input.sourceEventId, grants) !== input.expectedFenceId)
      throw new MemoryReconcileHandoffError('stale operator fence; list the source again');
    if (await hasLiveAttempt(tx, input.sourceEventId, grants))
      throw new MemoryReconcileHandoffError('provider attempt is still live');
    // The global request ID is the record identity; its subject is still the real source.
    await writeMemoryHandoffRecord(
      tx,
      input.sourceEventId,
      AUTHORIZED,
      grant,
      '',
      memoryIngestReplayGrantId(grant),
    );
    return grant;
  });
}

export async function assertMemoryIngestReplayGrant(
  db: Db | Tx,
  grant: MemoryIngestReplayGrant,
  sourceId: string,
): Promise<void> {
  const parsed = MemoryIngestReplayGrantSchema.parse(grant);
  if (parsed.source_event_id !== sourceId)
    throw new MemoryReconcileHandoffError('operator source mismatch');
  await assertUserSource(db, sourceId);
  const latest = (await grantsForSource(db, sourceId))[0];
  if (!latest || canonicalHandoffJson(latest) !== canonicalHandoffJson(parsed))
    throw new MemoryReconcileHandoffError('operator grant missing or superseded');
}

/** Called only after the provider lifecycle has durably reserved this grant's start. */
export async function claimMemoryIngestReplay(
  db: Db,
  grant: MemoryIngestReplayGrant,
  sourceId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockSource(tx, sourceId);
    await assertMemoryIngestReplayGrant(tx, grant, sourceId);
    if (await readIngestCompleted(tx, sourceId))
      throw new MemoryReconcileHandoffError('ingest already completed');
    if (!(await readMemoryIngestStarted(tx, sourceId)))
      throw new MemoryReconcileHandoffError('original add marker missing');
    const grantId = memoryIngestReplayGrantId(grant);
    const started = await tx
      .select({ id: event.id })
      .from(event)
      .where(eq(event.id, memoryReconcileHandoffEventId(STARTED, sourceId, grantId)))
      .limit(1);
    if (started.length)
      throw new MemoryReconcileHandoffError('operator add already started; exact lookup required');
    await writeMemoryHandoffRecord(
      tx,
      sourceId,
      STARTED,
      {
        version: 1,
        handoff_kind: STARTED,
        source_event_id: sourceId,
        grant_id: grantId,
      },
      grantId,
    );
  });
}

/** Read-only, bounded, keyset-paged inventory. No source text or credentials. */
export async function listStalledMemoryIngests(db: Db, afterId = '', limit = 50) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError('limit must be 1..100');
  const rows = await db
    .select({ id: event.id, sourceId: event.subject_id, createdAt: event.created_at })
    .from(event)
    .where(
      and(
        eq(event.action, MEMORY_RECONCILE_HANDOFF_ACTION),
        eq(sql<string>`${event.payload} ->> 'handoff_kind'`, 'add_started'),
        sql`${event.id} > ${afterId}`,
        sql`${event.created_at} <= clock_timestamp() - ${STALLED_SECONDS} * interval '1 second'`,
      ),
    )
    .orderBy(asc(event.id))
    .limit(limit);
  const candidates = [];
  for (const row of rows) {
    if (!row.sourceId || (await readIngestCompleted(db, row.sourceId))) continue;
    if (!(await readMemoryIngestStarted(db, row.sourceId))) continue;
    const grants = await grantsForSource(db, row.sourceId);
    candidates.push({
      sourceEventId: row.sourceId,
      startedAt: row.createdAt.toISOString(),
      expectedFenceId: latestFence(row.sourceId, grants),
      liveAttempt: await hasLiveAttempt(db, row.sourceId, grants),
    });
  }
  return { candidates, nextAfterId: rows.length === limit ? (rows.at(-1)?.id ?? null) : null };
}
