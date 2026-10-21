// Activity detection for per-subject briefs: which subjects gained qualifying
// activity since their brief was last refreshed. A dedicated knowledge-resolved
// query is required because attempt/review carry only referenced knowledge ids and
// never tag `subject:*` in affected_scopes, so an affected_scopes filter would find
// almost nothing and regenerate an empty brief every night.

import { and, eq, gt, inArray, like, sql } from 'drizzle-orm';
import { batchResolveSubjectIds } from '@/capabilities/knowledge/public';
import type { Db } from '@/db/client';
import { event, learning_record, memory_brief_note } from '@/db/schema';
import { BRIEF_REFRESH_BUDGET } from '@/kernel/tools/budgets';
import type { BriefEvent } from './brief';

// Actions that count as learner work on a subject. Judge/propose/generate/rate are
// agent-side or meta and are excluded. record_capture carries no knowledge ids in
// its payload; its knowledge/subject lives on the linked learning_record, which we
// join to resolve the real subject. A capture whose record is missing or empty still
// falls back to the default subject rather than being dropped. The answered enroll
// path writes `attempt`, already covered.
export const QUALIFYING_ACTIONS = ['attempt', 'review', 'experimental:record_capture'] as const;
const RECORD_CAPTURE_ACTION = 'experimental:record_capture';

const DEFAULT_LOOKBACK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const SUBJECT_SCOPE_PREFIX = 'subject:';

export interface ActiveSubject {
  /** `subject:<id>` — the memory_brief_note scope_key for this subject. */
  scopeKey: string;
  /** Resolved subject profile id (the `<id>` in scopeKey). */
  subjectId: string;
  /** Newest qualifying event's created_at, used for recency ordering. */
  maxCreatedAt: Date;
  /**
   * Knowledge-resolved qualifying window, newest first, capped. Used for detection
   * and recency ordering only; regen reloads its own window via
   * loadSubjectBriefEvents so the two paths cannot diverge.
   */
  events: BriefEvent[];
}

export interface ListActiveSubjectsOptions {
  /** Bounded initial-build window for never-built subjects (default 30d). */
  lookbackDays?: number;
  /** Test seam — defaults to `new Date()`. */
  now?: Date;
}

type QualifyingEventRow = {
  id: string;
  action: string;
  subject_kind: string;
  subject_id: string;
  // Top-level event column; the brief writer needs success/failure context.
  outcome: string | null;
  payload: unknown;
  created_at: Date;
};

function extractKnowledgeIds(payload: unknown): string[] {
  // attempt/review carry referenced_knowledge_ids; capture events do not and are
  // resolved from their linked learning_record instead.
  if (payload && typeof payload === 'object' && 'referenced_knowledge_ids' in payload) {
    const ids = (payload as { referenced_knowledge_ids?: unknown }).referenced_knowledge_ids;
    if (Array.isArray(ids)) return ids.filter((id): id is string => typeof id === 'string');
  }
  return [];
}

/**
 * Resolve each qualifying event to a subject id. attempt/review resolve from their
 * payload knowledge ids. record_capture has none: its event subject_id is the
 * learning_record id, so use that record's knowledge_ids (or its explicit
 * subject_id). Unresolvable events fall back to the default subject.
 */
export async function resolveQualifyingEventSubjects(
  db: Db,
  rows: QualifyingEventRow[],
): Promise<Map<string, string>> {
  // 1. Capture events reference their record by subject_id; batch-fetch once.
  const captureRecordIds = rows
    .filter((row) => row.action === RECORD_CAPTURE_ACTION)
    .map((row) => row.subject_id);
  const recordById = new Map<string, { knowledge_ids: string[]; subject_id: string | null }>();
  if (captureRecordIds.length > 0) {
    const recordRows = await db
      .select({
        id: learning_record.id,
        knowledge_ids: learning_record.knowledge_ids,
        subject_id: learning_record.subject_id,
      })
      .from(learning_record)
      .where(inArray(learning_record.id, [...new Set(captureRecordIds)]));
    for (const rec of recordRows) {
      recordById.set(rec.id, { knowledge_ids: rec.knowledge_ids, subject_id: rec.subject_id });
    }
  }

  // 2. Build each event's knowledge list for the canonical bridge. Captures borrow
  //    their record's ids; records with only a subject_id are handled in step 3.
  const explicitSubjectByEvent = new Map<string, string>();
  const resolveInput = rows.map((row) => {
    if (row.action === RECORD_CAPTURE_ACTION) {
      const rec = recordById.get(row.subject_id);
      if (rec) {
        if (rec.knowledge_ids.length > 0) return { id: row.id, knowledge_ids: rec.knowledge_ids };
        if (rec.subject_id) explicitSubjectByEvent.set(row.id, rec.subject_id);
      }
      return { id: row.id, knowledge_ids: [] as string[] };
    }
    return { id: row.id, knowledge_ids: extractKnowledgeIds(row.payload) };
  });

  // 3. Canonical resolution, then override with a record's explicit subject_id.
  const resolved = await batchResolveSubjectIds(db, resolveInput);
  for (const [eventId, subjectId] of explicitSubjectByEvent) {
    resolved.set(eventId, subjectId);
  }
  return resolved;
}

/**
 * The floor shared by detection and regen. A built subject floors at its own
 * refreshed_at: only evidence strictly newer counts. A never-built subject falls
 * back to the bounded lookback window. Both paths must use this helper, otherwise
 * an event detected near the lookback edge can age out before regen reloads it.
 */
export function subjectEventFloor(refreshedAt: Date | null, now: Date, lookbackDays: number): Date {
  return refreshedAt ?? new Date(now.getTime() - lookbackDays * DAY_MS);
}

/**
 * Subjects active since their brief's last refresh. Scan qualifying events from one
 * global floor, resolve them to subjects, and keep a subject when its newest event
 * is strictly after its floor. The returned event window is capped per brief.
 */
export async function listActiveSubjectsSinceRefresh(
  db: Db,
  opts: ListActiveSubjectsOptions = {},
): Promise<ActiveSubject[]> {
  const now = opts.now ?? new Date();
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const lookbackFloor = new Date(now.getTime() - lookbackDays * DAY_MS);

  // 1. Per-subject watermarks.
  const briefRows = await db
    .select({
      scope_key: memory_brief_note.scope_key,
      refreshed_at: memory_brief_note.refreshed_at,
    })
    .from(memory_brief_note)
    .where(like(memory_brief_note.scope_key, `${SUBJECT_SCOPE_PREFIX}%`));
  const refreshedAtBySubject = new Map<string, Date | null>();
  for (const row of briefRows) {
    // Derive the id from the scope key: a legacy row may have null subject_id.
    const subjectId = row.scope_key.slice(SUBJECT_SCOPE_PREFIX.length);
    if (subjectId) refreshedAtBySubject.set(subjectId, row.refreshed_at);
  }

  // 2. One global scan floor: the earliest point any subject can need evidence from.
  //    The per-subject strictly-after gate is applied later, in memory.
  const oldestRefreshedAt = briefRows.reduce<Date | null>((min, row) => {
    if (!row.refreshed_at) return min; // null refreshed_at → bounded by lookbackFloor anyway
    if (!min || row.refreshed_at < min) return row.refreshed_at;
    return min;
  }, null);
  const scanFloor =
    oldestRefreshedAt && oldestRefreshedAt < lookbackFloor ? oldestRefreshedAt : lookbackFloor;

  const rows = (await db
    .select({
      id: event.id,
      action: event.action,
      subject_kind: event.subject_kind,
      subject_id: event.subject_id,
      outcome: event.outcome,
      payload: event.payload,
      created_at: event.created_at,
    })
    .from(event)
    .where(and(inArray(event.action, [...QUALIFYING_ACTIONS]), gt(event.created_at, scanFloor)))
    .orderBy(sql`${event.created_at} DESC`)) as QualifyingEventRow[];

  if (rows.length === 0) return [];

  // 3. Resolve each event to a subject; unresolvable events go to the default.
  const subjectByEventId = await resolveQualifyingEventSubjects(db, rows);

  // 4. Group by subject. Rows are newest first, so each bucket's first row sets max.
  const bySubject = new Map<string, { maxCreatedAt: Date; events: BriefEvent[] }>();
  for (const row of rows) {
    const subjectId = subjectByEventId.get(row.id);
    if (!subjectId) continue; // defensive; batchResolveSubjectIds always maps every row
    let bucket = bySubject.get(subjectId);
    if (!bucket) {
      bucket = { maxCreatedAt: row.created_at, events: [] };
      bySubject.set(subjectId, bucket);
    }
    if (row.created_at > bucket.maxCreatedAt) bucket.maxCreatedAt = row.created_at;
    if (bucket.events.length < BRIEF_REFRESH_BUDGET.maxEventsPerBrief) {
      bucket.events.push({
        id: row.id,
        action: row.action,
        subject_kind: row.subject_kind,
        subject_id: row.subject_id,
        outcome: row.outcome,
        payload: row.payload,
        created_at: row.created_at,
      });
    }
  }

  const active: ActiveSubject[] = [];
  for (const [subjectId, bucket] of bySubject) {
    const refreshedAt = refreshedAtBySubject.get(subjectId) ?? null;
    // Active when the newest event is strictly after the shared floor, so a subject
    // flagged here always reloads at least one event in regen.
    const floor = subjectEventFloor(refreshedAt, now, lookbackDays);
    const isActive = bucket.maxCreatedAt > floor;
    if (!isActive) continue;
    active.push({
      scopeKey: `${SUBJECT_SCOPE_PREFIX}${subjectId}`,
      subjectId,
      maxCreatedAt: bucket.maxCreatedAt,
      events: bucket.events,
    });
  }
  return active;
}

/**
 * Per-run selection: most recently active first, capped. Deferred subjects stay
 * active and are eligible again next run, so nothing starves.
 */
export function selectSubjectsForRun(
  active: ActiveSubject[],
  maxSubjectsPerRun: number = BRIEF_REFRESH_BUDGET.maxSubjectsPerRun,
): ActiveSubject[] {
  return [...active]
    .sort((a, b) => b.maxCreatedAt.getTime() - a.maxCreatedAt.getTime())
    .slice(0, maxSubjectsPerRun);
}

/**
 * Load the knowledge-resolved qualifying window for one subject, newest first,
 * capped. Freshness is decided upstream by the sweep; this only gathers evidence.
 * Loading per subject keeps the job payload small at the cost of one bounded scan.
 */
export async function loadSubjectBriefEvents(
  db: Db,
  subjectId: string,
  opts: { lookbackDays?: number; now?: Date } = {},
): Promise<BriefEvent[]> {
  const now = opts.now ?? new Date();
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;

  // Floor at this subject's own refreshed_at (lookback only when never built). The
  // activity scan applies the same helper, so a subject flagged active always
  // reloads at least one event; a flat lookback floor could silently starve an
  // already-built subject whose evidence predates the window.
  const briefRows = await db
    .select({ refreshed_at: memory_brief_note.refreshed_at })
    .from(memory_brief_note)
    .where(eq(memory_brief_note.scope_key, `${SUBJECT_SCOPE_PREFIX}${subjectId}`))
    .limit(1);
  const refreshedAt = briefRows[0]?.refreshed_at ?? null;
  const floor = subjectEventFloor(refreshedAt, now, lookbackDays);

  const rows = (await db
    .select({
      id: event.id,
      action: event.action,
      subject_kind: event.subject_kind,
      subject_id: event.subject_id,
      outcome: event.outcome,
      payload: event.payload,
      created_at: event.created_at,
    })
    .from(event)
    .where(and(inArray(event.action, [...QUALIFYING_ACTIONS]), gt(event.created_at, floor)))
    .orderBy(sql`${event.created_at} DESC`)) as QualifyingEventRow[];

  if (rows.length === 0) return [];

  const subjectByEventId = await resolveQualifyingEventSubjects(db, rows);

  const out: BriefEvent[] = [];
  for (const row of rows) {
    if (subjectByEventId.get(row.id) !== subjectId) continue;
    out.push({
      id: row.id,
      action: row.action,
      subject_kind: row.subject_kind,
      subject_id: row.subject_id,
      outcome: row.outcome,
      payload: row.payload,
      created_at: row.created_at,
    });
    if (out.length >= BRIEF_REFRESH_BUDGET.maxEventsPerBrief) break;
  }
  return out;
}

/**
 * Knowledge-resolved freshness guard for the subject regen path. The stale loop
 * enqueues every brief older than 24h, including dormant subjects that activity
 * detection did not flag; without this guard each would pay an LLM call and bump
 * refreshed_at with no new evidence. Has new evidence iff the newest qualifying
 * event is newer than latest_evidence_at, or the brief has no evidence yet.
 */
export async function subjectScopeHasNewEvidence(
  db: Db,
  scopeKey: string,
  events: BriefEvent[],
): Promise<boolean> {
  if (events.length === 0) return false; // no qualifying evidence at all → nothing to refresh
  const rows = await db
    .select({ latest_evidence_at: memory_brief_note.latest_evidence_at })
    .from(memory_brief_note)
    .where(eq(memory_brief_note.scope_key, scopeKey))
    .limit(1);
  const briefLatest = rows[0]?.latest_evidence_at;
  if (!briefLatest) return true; // never built / no evidence yet → first real build
  const newestEvent = events.reduce(
    (max, e) => (e.created_at > max ? e.created_at : max),
    events[0].created_at,
  );
  return newestEvent > briefLatest;
}
