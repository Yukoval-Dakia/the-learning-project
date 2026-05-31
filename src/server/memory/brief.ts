import { and, desc, eq, gt, inArray, isNull, like, lt, not, or, sql } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { event, memory_brief_note } from '@/db/schema';
import { BRIEF_REFRESH_BUDGET, LONG_TERM_FRESHNESS_BUDGET } from '@/server/ai/tools/budgets';
import { scoreLongTermFreshness } from './brief-freshness';

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
  // P5.3 (YUK-183) — computed in regenerateMemoryBrief, NOT part of BriefDraft
  // (it is not the `generate` LLM's output). null = unjudgeable (§4.2).
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
    .where(sql`${event.affected_scopes} @> ARRAY[${scopeKey}]::text[]`)
    .orderBy(desc(event.created_at))
    // P5.2 (BR-9) — single-source per-brief read cap. Byte-identical to the
    // prior hardcoded 50; budgets.ts is now the only place this number lives.
    .limit(BRIEF_REFRESH_BUDGET.maxEventsPerBrief);
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
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
        // P5.3 (YUK-183) — also write on UPDATE so audit:schema sees a `.set(`
        // write path (the INSERT path rides in via `.values(row)`). Spec §5.
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

// P5.2 (BR-10) — test-only export of the affected_scopes loader. The
// acceptance test must prove that for a subject made active purely by
// attempt/review events (referenced_knowledge_ids only), this affected_scopes
// path returns 0 rows while the knowledge-resolved loader returns the events.
// Not part of the production API; named with the `ForTest` suffix so it is
// obviously a test seam, not a caller-facing helper.
export const loadEventsFromDbForTest = loadEventsFromDb;

export async function listStaleBriefScopes(db: Db, now = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ scope_key: memory_brief_note.scope_key })
    .from(memory_brief_note)
    .where(
      and(
        // P5.2 (BR-9) — EXCLUDE `subject:*` scopes from the 24h-stale loop.
        // Subject refresh is owned ENTIRELY by the capped per-subject path
        // (listActiveSubjectsSinceRefresh → selectSubjectsForRun, gated by
        // BRIEF_REFRESH_BUDGET.maxSubjectsPerRun). If the stale loop also
        // enqueued every >24h subject row, an already-built subject would be
        // refreshed UNCAPPED via this path, bypassing maxSubjectsPerRun. `global`
        // (and any legacy non-subject scope) stays on this stale path (BR-6
        // unchanged).
        not(like(memory_brief_note.scope_key, 'subject:%')),
        // P5.2 — semantically identical to the prior raw
        // `refreshed_at IS NULL OR refreshed_at < cutoff` fragment, but expressed
        // via drizzle's typed operators so the `cutoff` Date binds against the
        // timestamptz column type. The raw `sql\`... < ${cutoff}\`` form did NOT
        // carry the column type, so postgres-js's prepared-statement bind crashed
        // on a JS Date param (latent — the global sweep had no DB-level test until
        // P5.2 exercised it). Same 24h gate, no behavior change for non-subject scopes.
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
        gt(event.created_at, briefLatest),
      ),
    )
    .limit(1);
  return newer.length > 0;
}

/**
 * P5.3 (YUK-183) — resolve `created_at` for the long-term evidence ids backing
 * the freshness score (spec §4.3). The in-memory `events` array is the cheap
 * first pass; any id NOT present there (the test seams break the subset
 * guarantee, and the DB window is biased toward newest-50) is resolved LAZILY
 * and only if there is actually something to resolve AND a way to resolve it.
 *
 * CRASH-FIX (§4.3): we never construct a DB loader when `params.db` is
 * undefined. Resolution is gated on `missing.length > 0 && (loadEventTimestamps
 * || db)`. The injected-`loadEvents` unit path (no db, no loader) leaves the
 * missing ids unresolved → created_at: null → excluded from the score.
 *
 * Exported so the unit test can drive it directly with an injected
 * `loadEventTimestamps` fake without touching Postgres.
 */
export async function resolveEvidenceTimestamps(
  ids: string[],
  events: BriefEvent[],
  params: {
    db?: Db;
    loadEventTimestamps?: (ids: string[]) => Promise<{ id: string; created_at: Date }[]>;
  },
): Promise<{ id: string; created_at: Date | null }[]> {
  // 1. In-memory map of already-loaded events (zero query).
  const known = new Map<string, Date>();
  for (const ev of events) known.set(ev.id, ev.created_at);

  // 2. Partition into present (resolved from the map) vs missing.
  const missing: string[] = [];
  for (const id of ids) {
    if (!known.has(id)) missing.push(id);
  }

  // 3. Lazily resolve the missing set — and only then.
  if (missing.length > 0 && (params.loadEventTimestamps || params.db)) {
    const rows = params.loadEventTimestamps
      ? await params.loadEventTimestamps(missing)
      : // One batched query — no N+1. `params.db` is guaranteed defined here by
        // the guard above, so we never dereference an undefined db.
        await (params.db as Db)
          .select({ id: event.id, created_at: event.created_at })
          .from(event)
          .where(inArray(event.id, missing));
    for (const r of rows) known.set(r.id, r.created_at);
  }

  // 4. Any id still unresolved (invented by `generate`, or a learning_record id
  //    — §4.3 note) → created_at: null → excluded from the score per §4.2.
  return ids.map((id) => ({ id, created_at: known.get(id) ?? null }));
}

export async function regenerateMemoryBrief(params: {
  db?: Db;
  scopeKey: string;
  loadEvents?: (scopeKey: string) => Promise<BriefEvent[]>;
  searchFacts?: (scopeKey: string) => Promise<BriefFact[]>;
  generate: GenerateBrief;
  upsertBrief?: (row: BriefRow) => Promise<void>;
  // P5.3 (YUK-183) — injectable timestamp seam (§4.3) so the unit test drives
  // the decay path with in-memory timestamps and never touches Postgres.
  loadEventTimestamps?: (ids: string[]) => Promise<{ id: string; created_at: Date }[]>;
  now?: () => Date;
}): Promise<{ wrote: boolean; row: BriefRow }> {
  const now = params.now?.() ?? new Date();
  const template = BRIEF_TEMPLATES[prefixForScope(params.scopeKey)];
  const events = params.loadEvents
    ? await params.loadEvents(params.scopeKey)
    : await loadEventsFromDb(params.db as Db, params.scopeKey);
  const facts = params.searchFacts ? await params.searchFacts(params.scopeKey) : [];
  const draft = await params.generate({ scopeKey: params.scopeKey, template, events, facts });
  const latestEvidenceAt =
    events.length === 0
      ? null
      : new Date(Math.max(...events.map((row) => row.created_at.getTime())));

  // ── P5.3 long-term freshness score (no LLM/embedding call; no row mutation) ──
  // Computed over draft.long_term_evidence_ids (SoT ids) reusing the already-
  // loaded events + at most one batched timestamp lookup (§4.3). draft's
  // long_term_md + long_term_evidence_ids pass through verbatim below — there is
  // NO demotion and NO override of the LLM's long-term fields. Spec §4.1.
  // PR #229 review (medium): de-dup the SCORING input only — a duplicate evidence
  // id would otherwise be counted twice in the mean and over-weight that one
  // event (and double-query it). draft.long_term_evidence_ids is stored as-is.
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
    ...draft, // long_term_md + long_term_evidence_ids UNTOUCHED
    long_term_freshness_score: longTermFreshnessScore, // P5.3 (§5); number | null
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
