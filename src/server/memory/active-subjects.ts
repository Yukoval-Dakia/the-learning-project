// P5.2 activity-detection query (YUK-143) — spec
// `docs/superpowers/specs/2026-05-31-p5.2-brief-refresh-design.md` §3.2.
//
// Discovers which learning-subjects became ACTIVE since their per-subject brief
// was last refreshed, so the nightly sweep can refresh exactly those (and only
// those) — activity-gated, not freshness-gated, and not a blind daily refresh
// of every subject (BR-1 / BR-2).
//
// WHY a dedicated query and not `affected_scopes` (BR-10, load-bearing): the two
// core learning events (`attempt` / `review`) carry only
// `payload.referenced_knowledge_ids`, never `subject_id` / `domain`, so
// `computeAffectedScopes` tags them `global` + `topic:<id>` but NEVER
// `subject:X`. Reading `affected_scopes @> [subject:X]` would therefore return
// ~0 rows for an active subject → empty brief → re-generated empty every night.
// Instead we resolve each qualifying event's knowledge ids → subject via the
// SAME canonical bridge the review scheduler uses (BR-4,
// `@/server/knowledge/subject-resolution`).

import type { Db } from '@/db/client';
import { event, memory_brief_note } from '@/db/schema';
import { BRIEF_REFRESH_BUDGET } from '@/server/ai/tools/budgets';
import { batchResolveSubjectIds } from '@/server/knowledge/subject-resolution';
import { and, eq, gt, inArray, like, sql } from 'drizzle-orm';
import type { BriefEvent } from './brief';

// Actions that count as "the user did learning work on this subject" (BR-3).
// `judge` / `propose` / `generate` / `rate` are agent-side or meta and are
// intentionally excluded. `experimental:record_capture` is included for the
// direct /record + ingestion-enroll (unanswered) path, but its payload carries
// NO referenced_knowledge_ids (§5-Q2) — such events resolve to the DEFAULT
// subject via the orphan fallback (YUK-56), same as any unresolvable id, rather
// than being dropped. The enroll answered path writes `action='attempt'`, which
// is already covered and DOES carry referenced_knowledge_ids.
const QUALIFYING_ACTIONS = ['attempt', 'review', 'experimental:record_capture'] as const;

const DEFAULT_LOOKBACK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const SUBJECT_SCOPE_PREFIX = 'subject:';

export interface ActiveSubject {
  /** `subject:<id>` — the memory_brief_note scope_key for this subject. */
  scopeKey: string;
  /** Resolved subject profile id (the `<id>` in scopeKey). */
  subjectId: string;
  /** Newest qualifying event's created_at — drives the BR-9 recency sort. */
  maxCreatedAt: Date;
  /** The knowledge-resolved qualifying event window for THIS subject, most
   *  recent first, capped at BRIEF_REFRESH_BUDGET.maxEventsPerBrief. This is
   *  what the regen step (BR-10) summarizes from, so it never re-queries. */
  events: BriefEvent[];
}

export interface ListActiveSubjectsOptions {
  /** Bounded initial-build window for never-built subjects (BR-5, default 30d). */
  lookbackDays?: number;
  /** Test seam — defaults to `new Date()`. */
  now?: Date;
}

type QualifyingEventRow = {
  id: string;
  action: string;
  subject_kind: string;
  subject_id: string;
  payload: unknown;
  created_at: Date;
};

function extractKnowledgeIds(payload: unknown): string[] {
  // attempt / review carry payload.referenced_knowledge_ids; capture has none
  // (resolves to default subject via the orphan fallback in batchResolveSubjectIds).
  if (payload && typeof payload === 'object' && 'referenced_knowledge_ids' in payload) {
    const ids = (payload as { referenced_knowledge_ids?: unknown }).referenced_knowledge_ids;
    if (Array.isArray(ids)) return ids.filter((id): id is string => typeof id === 'string');
  }
  return [];
}

/**
 * The single floor predicate shared by detection (the per-subject "is this event
 * newer than this subject's watermark" test) and regen (`loadSubjectBriefEvents`).
 *
 * For an already-built subject the floor is its OWN `refreshed_at`: only evidence
 * STRICTLY AFTER the brief's last refresh counts (BR-1 — "≥1 qualifying activity
 * event with created_at strictly after that brief's last refresh"). A never-built
 * subject (no brief row / null refreshed_at) falls back to the bounded lookback
 * window (BR-5).
 *
 * Both detection and regen MUST derive their per-subject floor from this helper so
 * they can never diverge: previously detection flagged a subject active on an event
 * newer than its refreshed_at but OLDER than a fixed `now - lookbackDays`, while
 * regen used the fixed floor and dropped that event → empty window → silent starve.
 */
export function subjectEventFloor(refreshedAt: Date | null, now: Date, lookbackDays: number): Date {
  return refreshedAt ?? new Date(now.getTime() - lookbackDays * DAY_MS);
}

/**
 * §3.2 — the set of subjects active since their brief's last refresh.
 *
 * 1. Load per-subject brief watermarks (`scope_key LIKE 'subject:%'` → refreshed_at).
 * 2. Scan qualifying activity events newer than the global floor
 *    `min(now - lookback, oldest subject refreshed_at)` — one cheap query
 *    (§5-Q3 "single global floor + per-subject post-filter").
 * 3. Resolve each event → subject via the BR-4 bridge (orphan → default).
 * 4. Group by subject keeping max created_at; a subject is ACTIVE iff its newest
 *    qualifying event is STRICTLY AFTER its brief refreshed_at, OR it has no
 *    brief row and has activity within the lookback window (BR-5).
 *
 * The returned `events` per active subject are the regen input window (BR-10),
 * most recent first, capped at BRIEF_REFRESH_BUDGET.maxEventsPerBrief.
 */
export async function listActiveSubjectsSinceRefresh(
  db: Db,
  opts: ListActiveSubjectsOptions = {},
): Promise<ActiveSubject[]> {
  const now = opts.now ?? new Date();
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const lookbackFloor = new Date(now.getTime() - lookbackDays * DAY_MS);

  // 1. Per-subject brief watermarks.
  const briefRows = await db
    .select({
      scope_key: memory_brief_note.scope_key,
      refreshed_at: memory_brief_note.refreshed_at,
    })
    .from(memory_brief_note)
    .where(like(memory_brief_note.scope_key, `${SUBJECT_SCOPE_PREFIX}%`));
  const refreshedAtBySubject = new Map<string, Date | null>();
  for (const row of briefRows) {
    // Derive subjectId from scope_key (matching the regen handler,
    // triggers.ts), not the subject_id column — robust against a legacy row
    // with a null subject_id but a well-formed `subject:<id>` scope_key.
    const subjectId = row.scope_key.slice(SUBJECT_SCOPE_PREFIX.length);
    if (subjectId) refreshedAtBySubject.set(subjectId, row.refreshed_at);
  }

  // 2. Global scan floor: the earliest point any subject could need new
  //    evidence from. A never-built subject uses the lookback window; an
  //    already-built subject only re-summarizes evidence newer than its
  //    refreshed_at. Taking the MIN over both keeps this a single query; the
  //    per-subject "strictly after refreshed_at" gate (step 4) is applied in
  //    memory. We never scan a subject's whole history (lookbackFloor bounds
  //    even the oldest refreshed_at).
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
      payload: event.payload,
      created_at: event.created_at,
    })
    .from(event)
    .where(and(inArray(event.action, [...QUALIFYING_ACTIONS]), gt(event.created_at, scanFloor)))
    .orderBy(sql`${event.created_at} DESC`)) as QualifyingEventRow[];

  if (rows.length === 0) return [];

  // 3. Resolve each event → subject via the canonical bridge (BR-4). Memoised
  //    by first knowledge id; orphan / capture (no knowledge ids) → default.
  const subjectByEventId = await batchResolveSubjectIds(
    db,
    rows.map((row) => ({ id: row.id, knowledge_ids: extractKnowledgeIds(row.payload) })),
  );

  // 4. Group by subject, keep max created_at + the resolved event window.
  //    `rows` is already newest-first, so per-subject pushes preserve that order
  //    and the first row per subject is its max created_at.
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
        payload: row.payload,
        created_at: row.created_at,
      });
    }
  }

  const active: ActiveSubject[] = [];
  for (const [subjectId, bucket] of bySubject) {
    const refreshedAt = refreshedAtBySubject.get(subjectId) ?? null;
    // ACTIVE iff the subject's newest qualifying event is STRICTLY AFTER its
    // per-subject floor. The floor is shared with the regen reload
    // (`subjectEventFloor` / `loadSubjectBriefEvents`) so detection and regen can
    // never diverge: a built subject floors at its own `refreshed_at` (BR-1), a
    // never-built / null-refreshed_at subject floors at the lookback window (BR-5,
    // which `scanFloor`/`gt` already enforces, so any qualifying event is in
    // window). This is the same predicate the regen reload applies, guaranteeing a
    // detected-active subject reloads ≥1 event.
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
 * BR-9 — per-run subject selection: sort the active set by activity recency
 * (max created_at DESC) and take the top `maxSubjectsPerRun`. Deferred subjects
 * remain active and are eligible again next run (no starvation). Pure +
 * exported so the budget/defer behavior is unit-testable without seeding 12+
 * real subjects (only 3 subject profiles exist today).
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
 * BR-10 — load the knowledge-resolved qualifying event window for a SINGLE
 * subject, most recent first, capped at BRIEF_REFRESH_BUDGET.maxEventsPerBrief.
 *
 * This is what the per-subject regen handler injects via
 * `regenerateMemoryBrief`'s existing `loadEvents` param: the same
 * knowledge-id→subject resolution as the activity-detection query (§3.2), NOT
 * the `affected_scopes @> [subject:X]` filter (which returns ~0 rows for
 * attempt/review events, §1.2). Freshness is already decided upstream by the
 * sweep, so this just gathers the window to summarize — no separate guard.
 *
 * Resolving per-subject in the regen handler (rather than threading the event
 * list through the pg-boss job payload) keeps the queue payload small and the
 * handler self-contained; the cost is one bounded event scan + one memoised
 * resolution pass for the single subject being regenerated.
 */
export async function loadSubjectBriefEvents(
  db: Db,
  subjectId: string,
  opts: { lookbackDays?: number; now?: Date } = {},
): Promise<BriefEvent[]> {
  const now = opts.now ?? new Date();
  const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;

  // Floor at the subject's OWN brief refreshed_at (load events STRICTLY AFTER
  // the last refresh, BR-1), falling back to `now - lookbackDays` only for a
  // never-built subject (no brief row / null refreshed_at, BR-5). This is the
  // SAME `subjectEventFloor` predicate the activity-detection scan applies, so a
  // subject the sweep flagged active (newest event strictly after refreshed_at)
  // always reloads ≥1 event here. A flat `now - lookbackDays` floor for an
  // already-built subject silently starved any subject whose qualifying event
  // was newer than refreshed_at but older than the lookback window.
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
      payload: event.payload,
      created_at: event.created_at,
    })
    .from(event)
    .where(and(inArray(event.action, [...QUALIFYING_ACTIONS]), gt(event.created_at, floor)))
    .orderBy(sql`${event.created_at} DESC`)) as QualifyingEventRow[];

  if (rows.length === 0) return [];

  const subjectByEventId = await batchResolveSubjectIds(
    db,
    rows.map((row) => ({ id: row.id, knowledge_ids: extractKnowledgeIds(row.payload) })),
  );

  const out: BriefEvent[] = [];
  for (const row of rows) {
    if (subjectByEventId.get(row.id) !== subjectId) continue;
    out.push({
      id: row.id,
      action: row.action,
      subject_kind: row.subject_kind,
      subject_id: row.subject_id,
      payload: row.payload,
      created_at: row.created_at,
    });
    if (out.length >= BRIEF_REFRESH_BUDGET.maxEventsPerBrief) break;
  }
  return out;
}

/**
 * BR-2 / BR-10 — knowledge-resolved freshness guard for the SUBJECT regen path.
 *
 * The nightly sweep's `listStaleBriefScopes` loop (the global path) enqueues
 * EVERY brief row older than 24h, including dormant `subject:*` rows that the
 * activity-detection query did NOT flag active. Without a guard, the subject
 * regen branch would re-summarize such a dormant subject every night (an LLM
 * call + refreshed_at bump with no new evidence — exactly the BR-2 cost the
 * gate is meant to avoid). This guard is the knowledge-resolved analogue of
 * `scopeHasNewEvidence` (NOT the affected_scopes one, which returns false for
 * active subjects, §1.2): a subject scope has new evidence iff its newest
 * knowledge-resolved qualifying event is strictly newer than its brief's
 * `latest_evidence_at` (or the brief was never built / has no evidence yet).
 *
 * `events` is the already-loaded window from `loadSubjectBriefEvents` so this
 * adds only one cheap `memory_brief_note` read, no extra event scan.
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
