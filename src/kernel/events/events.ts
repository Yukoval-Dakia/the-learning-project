// Generic event-envelope storage API (ADR-0005 / ADR-0021).
// This module is the single INSERT owner for event rows.

import { type EventT, parseEvent } from '@/core/schema/event';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { and, desc, eq, gte, ne } from 'drizzle-orm';
import {
  type CorrectionStatus,
  activeCorrectionStatus,
  getCorrectionStatuses,
} from './corrections';
import { computeAffectedScopes } from './scope-tagger';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;

// ============================================================================
// getEventById — single event lookup (caused_by chain navigation).
// ============================================================================

// Internal row → parseEvent input projection. parseEvent only validates Lane B's
// user payload shape (action / subject / outcome / payload + base optional
// fields); the DB row's id / session_id / created_at envelope fields are stripped.
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

/**
 * Fetches one event by id and returns the parsed KnownEvent shape (validated
 * via parseEvent — failures throw, never silently swallowed). Returns null
 * when the row is absent.
 */
export async function getEventById(db: DbLike, id: string): Promise<EnvelopedEvent | null> {
  const rows = await db.select().from(event).where(eq(event.id, id)).limit(1);
  const enveloped = await rowsToEnvelopedEvents(db, rows);
  return enveloped[0] ?? null;
}

// ============================================================================
// getEvents — Phase 1c.1 Step 6: raw event log filter API.
//
// Filters AND-combined. Default limit 50, max 200. Output goes through
// parseEvent — guards schema drift on the way OUT (Step 4's writeEvent only
// guards INWARD writes). A corrupted row throws (something tampered the db);
// callers must surface, not silently skip.
// ============================================================================

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

// EventT plus the envelope fields callers need to identify the row (id) or
// order things along time (created_at). Phase 1c.2 added these because the
// /api/events consumers (notably the edge-proposal decide flow) need the
// event id to address proposals on the wire.
export type EnvelopedEvent = EventT & {
  id: string;
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
  const rows = await filtered.orderBy(desc(event.created_at)).limit(limit);

  return rowsToEnvelopedEvents(db, rows);
}

// ============================================================================
// getEventChain — Phase 1c.1 Step 6: caused_by chain navigation.
//
// Returns the focal event's parent (caused_by_event_id resolved) + the events
// that point back to it via caused_by_event_id (reverse lookup, supported by
// `event_caused_by_idx`). Throws when focal event id is unknown — the caller
// asked for a specific id, so missing = error, not empty chain.
// ============================================================================

export type EventChain = {
  caused_by: EnvelopedEvent | null;
  caused_events: EnvelopedEvent[];
  corrections: EnvelopedEvent[];
};

export async function getEventChain(db: DbLike, id: string): Promise<EventChain> {
  const focalRows = await db.select().from(event).where(eq(event.id, id)).limit(1);
  const focal = (await rowsToEnvelopedEvents(db, focalRows))[0] ?? null;
  if (focal === null) {
    throw new Error(`event ${id} not found`);
  }

  // Forward link: caused_by_event_id is a DB-envelope field, so retain it from
  // the focal row used above rather than querying the same event a second time.
  const caused_by_event_id = focalRows[0]?.caused_by_event_id ?? null;

  const caused_by = caused_by_event_id ? await getEventById(db, caused_by_event_id) : null;

  // Reverse link: events with caused_by_event_id = id. Use index on caused_by_event_id.
  const reverseRows = await db
    .select()
    .from(event)
    .where(and(eq(event.caused_by_event_id, id), ne(event.action, 'correct')))
    .orderBy(desc(event.created_at));
  const caused_events = await rowsToEnvelopedEvents(db, reverseRows);

  const correctionRows = await db
    .select()
    .from(event)
    .where(
      and(eq(event.action, 'correct'), eq(event.subject_kind, 'event'), eq(event.subject_id, id)),
    )
    .orderBy(desc(event.created_at), desc(event.id));
  const corrections = await rowsToEnvelopedEvents(db, correctionRows);

  return { caused_by, caused_events, corrections };
}

// ============================================================================
// writeEvent(s) — single-owner INSERT path (ADR-0005).
// ============================================================================

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
   * ADR-0021 opt-out: when set non-NULL at INSERT, the memory-ingestion outbox
   * poller (`src/server/memory/triggers.ts` — `WHERE ingest_at IS NULL`) skips
   * this event, so it never spawns a Mem0 `add` or brief-regen. Unless the caller
   * explicitly supplies affected_scopes, writeEvent also stores an empty scope
   * set so later brief scans cannot mistake the opt-out row for learner evidence.
   * Default NULL preserves the pending-ingest semantics for every existing
   * caller. Stamping `ingest_at = now` is an *opt-out of memory ingestion*, NOT
   * a claim that ingestion already ran. Used by internal/observe-only ledgers.
   */
  ingest_at?: Date | null;
}

/**
 * The single INSERT path for `event` rows. parseEvent() validates every row
 * matches a KnownEvent or experimental:* shape before writing — failures throw,
 * never silently swallowed. Per ADR-0005, no other module should call
 * `db.insert(event)` directly.
 *
 * Idempotency: PK conflict do-nothing means re-running with the same id is safe.
 * First write wins — a duplicate does NOT overwrite payload.
 */
function prepareEventInsert(input: WriteEventInput): typeof event.$inferInsert {
  // parseEvent on a normalised view — Lane B's discriminated union locks
  // action/subject/outcome/payload. Envelope fields (id, session_id, created_at,
  // etc.) live on the DB row but outside Lane B's contract, so they're not
  // included in the parse input.
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

  // YUK-565 — preserve insert-time outbox intent in the immutable scope tags.
  // The poller later stamps normal learner rows' ingest_at, so the FINAL
  // ingest_at value cannot distinguish "processed" from "born opted-out".
  // Empty affected_scopes makes every brief reader ignore internal ledgers while
  // processed learner rows keep the scopes computed at INSERT.
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
    // NULL default = pending ingest (ADR-0021). A non-NULL stamp opts the row
    // out of both the outbox poller and implicit brief scopes (see above).
    ingest_at: input.ingest_at ?? null,
    created_at: input.created_at ?? new Date(),
  };
}

/**
 * Validate the complete batch before issuing one multi-row INSERT. If any payload is invalid,
 * parseEvent throws before the DB is touched. Returned ids preserve input order (including ids
 * that already existed); first-write-wins remains the same as writeEvent.
 */
export async function writeEvents(db: DbLike, inputs: WriteEventInput[]): Promise<string[]> {
  if (inputs.length === 0) return [];
  const rows = inputs.map(prepareEventInsert);
  await db.insert(event).values(rows).onConflictDoNothing({ target: event.id });

  return inputs.map((input) => input.id);
}

export async function writeEvent(db: DbLike, input: WriteEventInput): Promise<string> {
  await writeEvents(db, [input]);

  // ADR-0021 — INSERT-only. The new row's `ingest_at` is NULL (pending). The
  // outbox poll handler picks it up after the caller transaction commits. If
  // that transaction rolls back, the row disappears and no job is enqueued.
  // First write wins, so the caller-provided id is always the return value.
  return input.id;
}
