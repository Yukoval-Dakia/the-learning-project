import { and, desc, eq, gt, inArray, isNull, like, lt, not, or, sql } from 'drizzle-orm';
import { allowsDerivation } from '@/core/schema/derivation-policy';
import type { Db } from '@/db/client';
import { event, memory_brief_note } from '@/db/schema';
import { eventAllowsDerivationSql } from '@/kernel/events/derivation-policy';
import { BRIEF_REFRESH_BUDGET, LONG_TERM_FRESHNESS_BUDGET } from '@/kernel/tools/budgets';
import { scoreLongTermFreshness } from './brief-freshness';
import { learnerEvidenceSql } from './learner-evidence';

// Reserved rollback-ledger actions written before writeEvent persisted insert-time
// opt-out intent. The action list covers historical rows; the actor-qualified
// `correct` clause keeps ordinary user corrections while excluding cascade tombstones.
const LEGACY_INTERNAL_BRIEF_ACTIONS = [
  'experimental:grading_checkpoint',
  'experimental:state_snapshot',
  'experimental:reproject_deferred',
] as const;

function excludesInternalBriefLedger() {
  return sql`NOT (
    ${inArray(event.action, [...LEGACY_INTERNAL_BRIEF_ACTIONS])}
    OR (${eq(event.action, 'correct')} AND ${eq(event.actor_ref, 'cascade_revert')})
  )`;
}

export const BRIEF_TEMPLATES = {
  global:
    'Summarize the learner globally: stable preferences, current focus, risks, and next useful prompts.',
  subject:
    'Summarize this subject: recent learning direction, durable strengths, weak spots, and suggested next moves.',
  topic:
    'Summarize this topic: misconceptions, recent attempts, evidence-backed progress, and next review handles.',
  mistake_cluster:
    'Summarize this recurring mistake cluster: triggers, examples, correction strategies, and confidence.',
  'meta:orchestrator_self':
    'Summarize procedural memory for the orchestrator: how to communicate, coach, and avoid unhelpful patterns.',
} as const;

export type BriefScopePrefix = keyof typeof BRIEF_TEMPLATES;

export type BriefEvent = {
  id: string;
  action: string;
  subject_kind: string;
  subject_id: string;
  // Top-level event column, not payload: the brief writer needs success/failure
  // context for real weakness/progress summaries.
  outcome: string | null;
  payload: unknown;
  created_at: Date;
};

export type BriefFact = {
  id: string;
  memory: string;
};

export type BriefDraft = {
  recent_week_md: string;
  recent_months_md: string;
  long_term_md: string;
  recent_week_evidence_ids: string[];
  recent_months_evidence_ids: string[];
  long_term_evidence_ids: string[];
};

export type GenerateBrief = (input: {
  scopeKey: string;
  template: string;
  events: BriefEvent[];
  facts: BriefFact[];
}) => Promise<BriefDraft>;

export type BriefRow = BriefDraft & {
  id: string;
  scope_key: string;
  subject_id: string | null;
  // Computed here, not by the generate LLM. null means unjudgeable.
  long_term_freshness_score: number | null;
  source_event_id: string | null;
  latest_evidence_at: Date | null;
  evidence_count: number;
  refreshed_at: Date;
  created_at: Date;
  updated_at: Date;
};

function prefixForScope(scopeKey: string): BriefScopePrefix {
  if (scopeKey === 'global') return 'global';
  if (scopeKey === 'meta:orchestrator_self') return 'meta:orchestrator_self';
  if (scopeKey.startsWith('subject:')) return 'subject';
  if (scopeKey.startsWith('topic:')) return 'topic';
  if (scopeKey.startsWith('mistake_cluster:')) return 'mistake_cluster';
  throw new Error(`Unsupported memory brief scope: ${scopeKey}`);
}

function idForScope(scopeKey: string): string {
  return `memory_brief:${scopeKey}`;
}

function subjectForScope(scopeKey: string): string | null {
  return scopeKey.startsWith('subject:') ? scopeKey.slice('subject:'.length) : null;
}

async function loadEventsFromDb(db: Db, scopeKey: string): Promise<BriefEvent[]> {
  const rows = await db
    .select()
    .from(event)
    .where(
      and(
        sql`${event.affected_scopes} @> ARRAY[${scopeKey}]::text[]`,
        excludesInternalBriefLedger(),
        // Question-bank authoring/publish events audit bank content, not learner
        // activity, so they never enter the brief evidence window.
        learnerEvidenceSql(),
        eventAllowsDerivationSql(),
      ),
    )
    .orderBy(desc(event.created_at))
    // Per-brief read cap; budgets.ts is the only place this number lives.
    .limit(BRIEF_REFRESH_BUDGET.maxEventsPerBrief);
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    outcome: row.outcome,
    payload: row.payload,
    created_at: row.created_at,
  }));
}

async function upsertBriefInDb(db: Db, row: BriefRow): Promise<void> {
  await db
    .insert(memory_brief_note)
    .values(row)
    .onConflictDoUpdate({
      target: memory_brief_note.scope_key,
      set: {
        subject_id: row.subject_id,
        recent_week_md: row.recent_week_md,
        recent_months_md: row.recent_months_md,
        long_term_md: row.long_term_md,
        recent_week_evidence_ids: row.recent_week_evidence_ids,
        recent_months_evidence_ids: row.recent_months_evidence_ids,
        long_term_evidence_ids: row.long_term_evidence_ids,
        // Also write on UPDATE so audit:schema sees a write path for the column.
        long_term_freshness_score: row.long_term_freshness_score,
        source_event_id: row.source_event_id,
        latest_evidence_at: row.latest_evidence_at,
        evidence_count: row.evidence_count,
        refreshed_at: row.refreshed_at,
        updated_at: row.updated_at,
        version: sql`${memory_brief_note.version} + 1`,
      },
    });
}

// Test seam: proves the affected_scopes path returns 0 rows for subjects made
// active only by attempt/review events, while the knowledge-resolved loader finds them.
export const loadEventsFromDbForTest = loadEventsFromDb;

export async function listStaleBriefScopes(db: Db, now = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ scope_key: memory_brief_note.scope_key })
    .from(memory_brief_note)
    .where(
      and(
        // Subject scopes are owned by the capped per-subject path; enqueueing them
        // here would bypass maxSubjectsPerRun. Global/legacy scopes stay on this path.
        not(like(memory_brief_note.scope_key, 'subject:%')),
        // Typed operators keep the Date bound to the timestamptz column; a raw
        // sql comparison dropped the column type and crashed on a Date param.
        or(isNull(memory_brief_note.refreshed_at), lt(memory_brief_note.refreshed_at, cutoff)),
      ),
    );
  return rows.map((row) => row.scope_key);
}

export async function scopeHasNewEvidence(db: Db, scopeKey: string): Promise<boolean> {
  const rows = await db
    .select({ latest_evidence_at: memory_brief_note.latest_evidence_at })
    .from(memory_brief_note)
    .where(eq(memory_brief_note.scope_key, scopeKey))
    .limit(1);
  const briefLatest = rows[0]?.latest_evidence_at;
  if (!briefLatest) return true;
  const newer = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        sql`${event.affected_scopes} @> ARRAY[${scopeKey}]::text[]`,
        excludesInternalBriefLedger(),
        // Same classification as the evidence window: a question revision is not new evidence.
        learnerEvidenceSql(),
        eventAllowsDerivationSql(),
        gt(event.created_at, briefLatest),
      ),
    )
    .limit(1);
  return newer.length > 0;
}

/**
 * Resolve created_at for evidence ids backing the freshness score. The loaded event
 * window is the cheap first pass; missing ids are resolved in one batch only when a
 * loader exists. Without one they stay null and are excluded from the score.
 */
export async function resolveEvidenceTimestamps(
  ids: string[],
  events: BriefEvent[],
  params: {
    db?: Db;
    loadEventTimestamps?: (ids: string[]) => Promise<{ id: string; created_at: Date }[]>;
  },
): Promise<{ id: string; created_at: Date | null }[]> {
  // 1. Already-loaded events need no query.
  const known = new Map<string, Date>();
  for (const ev of events) known.set(ev.id, ev.created_at);

  // 2. Partition into resolved and missing ids.
  const missing: string[] = [];
  for (const id of ids) {
    if (!known.has(id)) missing.push(id);
  }

  // 3. Resolve the missing set lazily, only when a resolver exists.
  if (missing.length > 0 && (params.loadEventTimestamps || params.db)) {
    const rows = params.loadEventTimestamps
      ? await params.loadEventTimestamps(missing)
      : // One batched query — no N+1. The guard above guarantees db is defined.
        await (params.db as Db)
          .select({ id: event.id, created_at: event.created_at })
          .from(event)
          .where(inArray(event.id, missing));
    for (const r of rows) known.set(r.id, r.created_at);
  }

  // 4. Still-unresolved ids (invented by generate, or learning_record ids) get null
  //    and are excluded from the score.
  return ids.map((id) => ({ id, created_at: known.get(id) ?? null }));
}

export async function regenerateMemoryBrief(params: {
  db?: Db;
  scopeKey: string;
  loadEvents?: (scopeKey: string) => Promise<BriefEvent[]>;
  searchFacts?: (scopeKey: string) => Promise<BriefFact[]>;
  generate: GenerateBrief;
  upsertBrief?: (row: BriefRow) => Promise<void>;
  // Injectable timestamp seam so the decay path stays DB-free in unit tests.
  loadEventTimestamps?: (ids: string[]) => Promise<{ id: string; created_at: Date }[]>;
  now?: () => Date;
}): Promise<{ wrote: boolean; row: BriefRow }> {
  const now = params.now?.() ?? new Date();
  const template = BRIEF_TEMPLATES[prefixForScope(params.scopeKey)];
  const loadedEvents = params.loadEvents
    ? await params.loadEvents(params.scopeKey)
    : await loadEventsFromDb(params.db as Db, params.scopeKey);
  const events = loadedEvents.filter((row) => allowsDerivation(row.payload));
  const facts = params.searchFacts ? await params.searchFacts(params.scopeKey) : [];
  const generated = await params.generate({ scopeKey: params.scopeKey, template, events, facts });
  const restrictedIds = new Set(
    loadedEvents.filter((row) => !allowsDerivation(row.payload)).map((row) => row.id),
  );
  if (params.db) {
    const ids = [
      ...new Set([
        ...generated.recent_week_evidence_ids,
        ...generated.recent_months_evidence_ids,
        ...generated.long_term_evidence_ids,
      ]),
    ];
    if (ids.length) {
      const forbidden = await params.db
        .select({ id: event.id })
        .from(event)
        .where(and(inArray(event.id, ids), sql`NOT (${eventAllowsDerivationSql()})`));
      for (const row of forbidden) restrictedIds.add(row.id);
    }
  }
  const draft = {
    ...generated,
    recent_week_evidence_ids: generated.recent_week_evidence_ids.filter(
      (id) => !restrictedIds.has(id),
    ),
    recent_months_evidence_ids: generated.recent_months_evidence_ids.filter(
      (id) => !restrictedIds.has(id),
    ),
    long_term_evidence_ids: generated.long_term_evidence_ids.filter((id) => !restrictedIds.has(id)),
  };
  const latestEvidenceAt =
    events.length === 0
      ? null
      : new Date(Math.max(...events.map((row) => row.created_at.getTime())));

  // Long-term freshness is advisory: no LLM/embedding call and no mutation of the
  // generated long-term fields. Deduplicate only the scoring input so a repeated id
  // is not weighted twice; the stored id list is unchanged.
  const scoringEvidenceIds = [...new Set(draft.long_term_evidence_ids)];
  const evidenceTimestamps = await resolveEvidenceTimestamps(scoringEvidenceIds, events, params);
  const { score: longTermFreshnessScore } = scoreLongTermFreshness(
    evidenceTimestamps,
    now,
    LONG_TERM_FRESHNESS_BUDGET,
  );

  const row: BriefRow = {
    id: idForScope(params.scopeKey),
    scope_key: params.scopeKey,
    subject_id: subjectForScope(params.scopeKey),
    ...draft, // long_term_md and long_term_evidence_ids pass through untouched
    long_term_freshness_score: longTermFreshnessScore,
    source_event_id: events[0]?.id ?? null,
    latest_evidence_at: latestEvidenceAt,
    evidence_count: events.length,
    refreshed_at: now,
    created_at: now,
    updated_at: now,
  };

  if (params.upsertBrief) {
    await params.upsertBrief(row);
  } else {
    await upsertBriefInDb(params.db as Db, row);
  }
  return { wrote: true, row };
}
