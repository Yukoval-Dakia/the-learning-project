import { and, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { event, memory_brief_note } from '@/db/schema';
import { BRIEF_REFRESH_BUDGET } from '@/server/ai/tools/budgets';

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
    // P5.2 — semantically identical to the prior raw
    // `refreshed_at IS NULL OR refreshed_at < cutoff` fragment, but expressed
    // via drizzle's typed operators so the `cutoff` Date binds against the
    // timestamptz column type. The raw `sql\`... < ${cutoff}\`` form did NOT
    // carry the column type, so postgres-js's prepared-statement bind crashed
    // on a JS Date param (latent — the global sweep had no DB-level test until
    // P5.2 exercised it). Same query, same 24h gate, no behavior change.
    .where(or(isNull(memory_brief_note.refreshed_at), lt(memory_brief_note.refreshed_at, cutoff)));
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

export async function regenerateMemoryBrief(params: {
  db?: Db;
  scopeKey: string;
  loadEvents?: (scopeKey: string) => Promise<BriefEvent[]>;
  searchFacts?: (scopeKey: string) => Promise<BriefFact[]>;
  generate: GenerateBrief;
  upsertBrief?: (row: BriefRow) => Promise<void>;
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

  const row: BriefRow = {
    id: idForScope(params.scopeKey),
    scope_key: params.scopeKey,
    subject_id: subjectForScope(params.scopeKey),
    ...draft,
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
