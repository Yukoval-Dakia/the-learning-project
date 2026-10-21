// Generic event-envelope storage; the single INSERT owner for event rows (ADR-0005 / ADR-0021).

import { and, desc, eq, gte, ne, sql } from 'drizzle-orm';
import { readDerivationPolicy } from '@/core/schema/derivation-policy';
import { type EventT, parseEvent } from '@/core/schema/event';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { eventCorrectionLockKey, eventCorrectionsGlobalLockKey } from './correction-lock';
import {
  type CorrectionStatus,
  activeCorrectionStatus,
  getCorrectionStatuses,
} from './corrections';
import { eventAllowsDerivationSql } from './derivation-policy';
import { computeAffectedScopes } from './scope-tagger';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;

// parseEvent validates only the user payload; strip the DB envelope fields.
function rowToParseInput(row: typeof event.$inferSelect): Parameters<typeof parseEvent>[0] {
  return {
    actor_kind: row.actor_kind,
    actor_ref: row.actor_ref,
    action: row.action,
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    outcome: row.outcome,
    payload: row.payload,
    caused_by_event_id: row.caused_by_event_id ?? undefined,
    task_run_id: row.task_run_id ?? undefined,
    cost_micro_usd: row.cost_micro_usd ?? undefined,
  };
}

/** Parsed event by id, or null when absent. Invalid payloads throw. */
export async function getEventById(
  db: DbLike,
  id: string,
  opts: { forDerivation?: boolean } = {},
): Promise<EnvelopedEvent | null> {
  const rows = await db
    .select()
    .from(event)
    .where(and(eq(event.id, id), ...(opts.forDerivation ? [eventAllowsDerivationSql()] : [])))
    .limit(1);
  const enveloped = await rowsToEnvelopedEvents(db, rows);
  return enveloped[0] ?? null;
}

// Rows are parsed on the way out too, so schema drift throws instead of leaking
// a malformed event. A corrupted row must surface, never be skipped silently.

export interface GetEventsFilter {
  action?: string;
  subject_kind?: string;
  subject_id?: string;
  actor_kind?: string;
  actor_ref?: string;
  outcome?: string;
  since?: Date;
  limit?: number;
}

const DEFAULT_EVENTS_LIMIT = 50;
const MAX_EVENTS_LIMIT = 200;

// EventT plus the envelope identity/timestamps event API consumers need.
export type EnvelopedEvent = EventT & {
  id: string;
  /** Monotonic insertion chronology; authoritative when created_at timestamps tie. */
  dispatch_seq: number;
  // Raw envelope values also cover experimental:* events, whose Zod branch
  // validates only action and payload.
  actor_kind: string;
  actor_ref: string;
  action: string;
  subject_kind: string;
  subject_id: string;
  outcome: string | null;
  caused_by_event_id?: string;
  created_at: Date;
  correction_status: CorrectionStatus;
};

async function rowsToEnvelopedEvents(db: DbLike, rows: EventRow[]): Promise<EnvelopedEvent[]> {
  const statuses = await getCorrectionStatuses(
    db,
    rows.map((r) => r.id),
  );
  return rows.map(
    (r) =>
      ({
        ...parseEvent(rowToParseInput(r)),
        id: r.id,
        dispatch_seq: r.dispatch_seq,
        actor_kind: r.actor_kind,
        actor_ref: r.actor_ref,
        action: r.action,
        subject_kind: r.subject_kind,
        subject_id: r.subject_id,
        outcome: r.outcome,
        // Root events omit the optional link instead of widening the wire value to null.
        caused_by_event_id: r.caused_by_event_id ?? undefined,
        created_at: r.created_at,
        correction_status: statuses.get(r.id) ?? activeCorrectionStatus(),
      }) as EnvelopedEvent,
  );
}

export async function getEvents(
  db: DbLike,
  filter: GetEventsFilter = {},
): Promise<EnvelopedEvent[]> {
  const limit = Math.min(Math.max(filter.limit ?? DEFAULT_EVENTS_LIMIT, 1), MAX_EVENTS_LIMIT);
  const conditions = [];
  if (filter.action) conditions.push(eq(event.action, filter.action));
  if (filter.subject_kind) conditions.push(eq(event.subject_kind, filter.subject_kind));
  if (filter.subject_id) conditions.push(eq(event.subject_id, filter.subject_id));
  if (filter.actor_kind) conditions.push(eq(event.actor_kind, filter.actor_kind));
  if (filter.actor_ref) conditions.push(eq(event.actor_ref, filter.actor_ref));
  if (filter.outcome) conditions.push(eq(event.outcome, filter.outcome));
  if (filter.since) conditions.push(gte(event.created_at, filter.since));

  const baseQuery = db.select().from(event);
  const filtered = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;
  const rows = await filtered
    .orderBy(desc(event.created_at), desc(event.dispatch_seq), desc(event.id))
    .limit(limit);

  return rowsToEnvelopedEvents(db, rows);
}

// Throws when the focal id is unknown: the caller asked for a specific event,
// so a miss is an error rather than an empty chain.

export type EventChain = {
  caused_by: EnvelopedEvent | null;
  caused_events: EnvelopedEvent[];
  corrections: EnvelopedEvent[];
};

export async function getEventChain(
  db: DbLike,
  id: string,
  opts: { forDerivation?: boolean } = {},
): Promise<EventChain> {
  const focalRows = await db
    .select()
    .from(event)
    .where(and(eq(event.id, id), ...(opts.forDerivation ? [eventAllowsDerivationSql()] : [])))
    .limit(1);
  const focal = (await rowsToEnvelopedEvents(db, focalRows))[0] ?? null;
  if (focal === null) {
    throw new Error(`event ${id} not found`);
  }

  // Reuse the focal row's envelope value instead of querying the same event again.
  const caused_by_event_id = focalRows[0]?.caused_by_event_id ?? null;

  const caused_by = caused_by_event_id ? await getEventById(db, caused_by_event_id, opts) : null;

  // Reverse links; event_caused_by_idx backs the lookup.
  const reverseRows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.caused_by_event_id, id),
        ne(event.action, 'correct'),
        ...(opts.forDerivation ? [eventAllowsDerivationSql()] : []),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.dispatch_seq), desc(event.id));
  const caused_events = await rowsToEnvelopedEvents(db, reverseRows);

  const correctionRows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'correct'),
        eq(event.subject_kind, 'event'),
        eq(event.subject_id, id),
        ...(opts.forDerivation ? [eventAllowsDerivationSql()] : []),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.dispatch_seq), desc(event.id));
  const corrections = await rowsToEnvelopedEvents(db, correctionRows);

  return { caused_by, caused_events, corrections };
}

export interface WriteEventInput {
  id: string;
  session_id?: string | null;
  actor_kind: string;
  actor_ref: string;
  action: string;
  subject_kind: string;
  subject_id: string;
  outcome?: string | null;
  payload: unknown;
  caused_by_event_id?: string | null;
  affected_scopes?: string[];
  task_run_id?: string | null;
  cost_micro_usd?: number | null;
  created_at?: Date;
  /**
   * Non-NULL opts the row out of memory ingestion and implicit brief scopes
   * (ADR-0021). It is not a claim that ingestion already ran. Default NULL
   * keeps pending-ingest semantics.
   */
  ingest_at?: Date | null;
}

/**
 * Validate one input before INSERT; a malformed event throws before touching the DB.
 * Duplicate ids are ignored, so the first write wins and re-running is safe.
 */
function prepareEventInsert(input: WriteEventInput): typeof event.$inferInsert {
  // Any non-allow usage (including crisis) leaves the memory outbox at write
  // time; the read-side predicates are the second line of defence.
  if (readDerivationPolicy(input.payload) !== 'allow') {
    input = { ...input, ingest_at: input.ingest_at ?? new Date(), affected_scopes: [] };
  }
  // Envelope fields live on the row but outside parseEvent's payload contract.
  parseEvent({
    actor_kind: input.actor_kind,
    actor_ref: input.actor_ref,
    action: input.action,
    subject_kind: input.subject_kind,
    subject_id: input.subject_id,
    outcome: input.outcome,
    payload: input.payload,
    caused_by_event_id: input.caused_by_event_id ?? undefined,
    task_run_id: input.task_run_id ?? undefined,
    cost_micro_usd: input.cost_micro_usd ?? undefined,
  });

  // Preserve insert-time outbox intent in the immutable scope tags: the poller
  // later stamps ingest_at, so the final value cannot tell "processed" from
  // "born opted-out". Empty scopes keep brief readers off internal ledgers.
  const affectedScopes =
    input.affected_scopes ??
    (input.ingest_at === undefined || input.ingest_at === null ? computeAffectedScopes(input) : []);

  return {
    id: input.id,
    session_id: input.session_id ?? null,
    actor_kind: input.actor_kind,
    actor_ref: input.actor_ref,
    action: input.action,
    subject_kind: input.subject_kind,
    subject_id: input.subject_id,
    outcome: input.outcome ?? null,
    payload: input.payload as Record<string, unknown>,
    caused_by_event_id: input.caused_by_event_id ?? null,
    affected_scopes: affectedScopes,
    task_run_id: input.task_run_id ?? null,
    cost_micro_usd: input.cost_micro_usd ?? null,
    // NULL = pending ingest; a non-NULL stamp opts out of the outbox and brief scopes.
    ingest_at: input.ingest_at ?? null,
    created_at: input.created_at ?? new Date(),
  };
}

/** Validate the whole batch before one INSERT; duplicate ids keep the first write. */
export async function writeEvents(db: DbLike, inputs: WriteEventInput[]): Promise<string[]> {
  if (inputs.length === 0) return [];
  const rows = inputs.map(prepareEventInsert);
  const correctionTargetIds = [
    ...new Set(
      inputs
        .filter((input) => input.action === 'correct' && input.subject_kind === 'event')
        .map((input) => input.subject_id),
    ),
  ].sort();

  if (correctionTargetIds.length === 0) {
    await db.insert(event).values(rows).onConflictDoNothing({ target: event.id });
  } else {
    // Corrections serialize with activation decisions on their target. On Tx the
    // lock lasts until the outer transaction ends; sort targets to avoid deadlock.
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${eventCorrectionsGlobalLockKey()}, 0))`,
      );
      for (const targetId of correctionTargetIds) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${eventCorrectionLockKey(targetId)}, 0))`,
        );
      }
      await tx.insert(event).values(rows).onConflictDoNothing({ target: event.id });
    });
  }

  return inputs.map((input) => input.id);
}

export async function writeEvent(db: DbLike, input: WriteEventInput): Promise<string> {
  await writeEvents(db, [input]);

  // INSERT-only: the outbox picks the row up after commit; a rollback leaves no job.
  return input.id;
}
