// YUK-280 P4 (YUK-203) — loadQuestionDetail aggregate (single-question reader).
//
// docs/superpowers/plans/2026-06-07-yuk280-question-bank-api.md §2 (A1d/A1e)
//
// Aggregates everything the question-bank detail view needs into one server call,
// mirroring loadNotePage's structure (null → 404). Reuses (never re-implements):
//   - deriveSourceTier            (@/core/schema/provenance)
//   - masteryDecayBucket          (@/capabilities/knowledge/server/node-page)
//   - getQuestionTimeline         (@/server/events/queries)
//   - loadFamilyMembers           (@/server/questions/list)
//
// Red lines honoured:
//   - decay 不给 question 单建 bucket (R-P4-5): per-knowledge node buckets are
//     aggregated; the题级 aggregate_decay_bucket is an explicitly-marked DERIVED
//     value (worst-of the per-knowledge buckets), never a question-owned state.
//   - 题级 backlink (R-P4-6): tool_state.question_ids @> [id] jsonb container
//     query across embedded_check + tool_quiz artifacts, grouped by intent_source.
//   - timestamps are unix seconds (`*_sec`) — timeline 已并入本详情聚合（M5 收编
//     至 src/capabilities/practice/api/question-detail.ts），与 /api/* 其余面一致。

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import {
  type MasteryDecayBucket,
  masteryDecayBucket,
} from '@/capabilities/knowledge/server/node-page';
import { type SourceTier, type SourceTierName, deriveSourceTier } from '@/core/schema/provenance';
import type { Db } from '@/db/client';
import { artifact, knowledge, material_fsrs_state, question } from '@/db/schema';
import { type QuestionTimelineEntry, getQuestionTimeline } from '@/server/events/queries';
import { getMasteryProjection } from '@/server/mastery/state';
import { loadFamilyMembers } from '@/server/questions/list';

const DEFAULT_TIMELINE_LIMIT = 10;
const MAX_TIMELINE_LIMIT = 50;

// Worst-to-best decay ordering for the题级 aggregate. The aggregate is the WORST
// (most stale) bucket across the question's knowledge nodes — a question is only
// as fresh as its least-fresh attached concept. Explicitly DERIVED, not stored.
const DECAY_SEVERITY: Record<MasteryDecayBucket, number> = {
  stale: 4,
  mild: 3,
  fresh: 2,
  untrained: 1,
  unknown: 0,
};

export interface QuestionDetailLabel {
  id: string;
  name: string;
}

export interface QuestionDetailFamilyMember {
  id: string;
  variant_depth: number;
  kind: string;
  is_self: boolean;
}

export interface QuestionDetailFamily {
  root_question_id: string;
  members: QuestionDetailFamilyMember[];
  variant_count: number;
}

// YUK-288 gap A — composite小题. A part is a `question` row tagged
// `kind='question_part'` linked via `parent_question_id` and ordered by
// `part_index` (parts.ts write path). The detail of a composite PARENT carries
// its ordered parts; a part's own detail carries `parent_question_id` so the UI
// can render the 面包屑 back to the parent. phase-1 data currently has zero
// composite questions, so `parts` is `[]` for every existing question — the field
// exists so the reader is ready when composite ingestion lands (no schema change).
export interface QuestionDetailPart {
  id: string;
  kind: string;
  part_index: number;
  prompt_md: string;
  difficulty: number;
  draft_status: string | null;
}

export interface QuestionDetailPerKnowledge {
  knowledge_id: string;
  name: string | null; // null when the node is archived/missing (dropped from labels but kept here for traceability).
  mastery: number | null;
  evidence_count: number;
  last_evidence_at_sec: number | null;
  decay_bucket: MasteryDecayBucket;
  due_at_sec: number | null;
}

export interface QuestionDetailScheduling {
  per_knowledge: QuestionDetailPerKnowledge[];
  // 题级整体新鲜度 — worst-of per_knowledge buckets. DERIVED aggregate, NOT a
  // question-owned state (R-P4-5). 'unknown' when the question has no knowledge nodes.
  aggregate_decay_bucket: MasteryDecayBucket;
  // legacy per-question FSRS fallback for unlabeled questions (knowledge_ids empty).
  legacy_question_fsrs: { due_at_sec: number } | null;
}

export interface QuestionDetailBacklink {
  artifact_id: string;
  type: string;
  title: string;
  tool_kind: string | null;
  intent_source: string;
  generation_status: string;
  created_at_sec: number;
}

export interface QuestionDetailTimelineEntry {
  kind: 'attempt' | 'review';
  event_id: string;
  created_at_sec: number;
  outcome: string;
  duration_ms: number | null;
  // attempt-only
  cause?: { primary: string; confidence: number | null } | null;
  // review-only
  fsrs_rating?: 'again' | 'hard' | 'good';
}

export interface QuestionDetail {
  id: string;
  kind: string;
  prompt_md: string; // full text (list truncates; detail serves whole).
  reference_md: string | null;
  choices_md: string[] | null;
  rubric_json: unknown;
  difficulty: number;
  source: string;
  source_ref: string | null;
  source_tier: { tier: SourceTier; name: SourceTierName };
  visual_complexity: string | null;
  figures: unknown;
  image_refs: string[];
  variant_depth: number;
  root_question_id: string | null;
  parent_variant_id: string | null;
  // YUK-288 gap A — composite linkage. `parent_question_id` is set when THIS
  // question is itself a part (→ UI renders the parent 面包屑); `part_index` orders
  // it within the parent. `parts` is the ordered小题 list when THIS question is a
  // composite parent (empty otherwise — incl. all phase-1 data today).
  parent_question_id: string | null;
  part_index: number | null;
  parts: QuestionDetailPart[];
  draft_status: string | null;
  // YUK-413 — row version for optimistic-lock on the editor's PATCH/DELETE. The
  // edit surface (src/capabilities/practice/api/question-detail.ts) requires the
  // current version; without exposing it here the detail-page editor has no way to
  // supply a non-stale `version` and every save would 409. Pure projection of
  // question.version (no schema change, additive read field).
  version: number;
  knowledge_ids: string[];
  labels: QuestionDetailLabel[];
  family: QuestionDetailFamily;
  scheduling: QuestionDetailScheduling;
  backlinks: QuestionDetailBacklink[];
  backlinks_by_intent_source: Record<string, QuestionDetailBacklink[]>;
  timeline: QuestionDetailTimelineEntry[];
  metadata: Record<string, unknown> | null;
  created_at_sec: number;
  updated_at_sec: number;
  computed_at_sec: number;
}

function toSec(d: Date | null | undefined): number | null {
  return d ? Math.floor(d.getTime() / 1000) : null;
}

/**
 * Aggregate every read the /questions/[id] detail view needs into one server
 * call. Returns null when the question doesn't exist so the route can 404.
 *
 * NOTE: unlike the list reader, the detail reader does NOT exclude drafts — a
 * detail view must be able to show a draft question (the list defaults to
 * excluding them; the detail is reached by explicit id).
 */
export async function loadQuestionDetail(
  db: Db,
  questionId: string,
  timelineLimit: number = DEFAULT_TIMELINE_LIMIT,
): Promise<QuestionDetail | null> {
  // 1. the question row (full fields; drafts INCLUDED — detail shows them).
  const rows = await db.select().from(question).where(eq(question.id, questionId)).limit(1);
  const q = rows[0];
  if (!q) return null;

  const knowledgeIds = q.knowledge_ids ?? [];

  // 2. derived source_tier.
  const sourceTier = deriveSourceTier({
    source: q.source,
    metadata: (q.metadata ?? null) as Record<string, unknown> | null,
  });

  // 3. knowledge label resolution (non-archived names; archived/missing dropped
  // from labels — mirror note-page:127-135 archived-drop).
  const labelRows =
    knowledgeIds.length === 0
      ? []
      : await db
          .select({ id: knowledge.id, name: knowledge.name })
          .from(knowledge)
          .where(and(inArray(knowledge.id, knowledgeIds), isNull(knowledge.archived_at)));
  const nameById = new Map(labelRows.map((r) => [r.id, r.name]));
  const labels: QuestionDetailLabel[] = labelRows.map((r) => ({ id: r.id, name: r.name }));

  // 4. variant family — reuse loadFamilyMembers (the list's shared helper).
  // Detail shows drafts, so excludeDrafts=false.
  const familyKey = q.root_question_id ?? q.id;
  const familyRows = await loadFamilyMembers(db, familyKey, false);
  const family: QuestionDetailFamily = {
    root_question_id: familyKey,
    members: familyRows.map((m) => ({
      id: m.id,
      variant_depth: m.variant_depth,
      kind: m.kind,
      is_self: m.id === q.id,
    })),
    variant_count: familyRows.length,
  };

  // 4b. composite小题 (YUK-288 gap A) — ordered parts when this is a parent.
  const parts = await loadParts(db, questionId);

  // 5. per-knowledge FSRS / mastery / decay (聚合 knowledge_ids — R-P4-5/§7).
  const scheduling = await loadScheduling(db, questionId, knowledgeIds, nameById);

  // 6. backlinks (A1e) — tool_state.question_ids @> [id] across artifacts.
  const backlinks = await loadBacklinks(db, questionId);

  // 7. event timeline — reuse getQuestionTimeline (attempt+review, judge cause).
  const effectiveLimit = Math.min(Math.max(timelineLimit, 1), MAX_TIMELINE_LIMIT);
  const timelineEntries = await getQuestionTimeline(db, questionId, effectiveLimit);

  return {
    id: q.id,
    kind: q.kind,
    prompt_md: q.prompt_md,
    reference_md: q.reference_md ?? null,
    choices_md: q.choices_md ?? null,
    rubric_json: q.rubric_json ?? null,
    difficulty: q.difficulty,
    source: q.source,
    source_ref: q.source_ref ?? null,
    source_tier: { tier: sourceTier.tier, name: sourceTier.name },
    visual_complexity: q.visual_complexity ?? null,
    figures: q.figures ?? [],
    image_refs: q.image_refs ?? [],
    variant_depth: q.variant_depth,
    root_question_id: q.root_question_id ?? null,
    parent_variant_id: q.parent_variant_id ?? null,
    parent_question_id: q.parent_question_id ?? null,
    part_index: q.part_index ?? null,
    parts,
    draft_status: q.draft_status ?? null,
    version: q.version, // YUK-413 — editor optimistic-lock token (see interface).
    knowledge_ids: knowledgeIds,
    labels,
    family,
    scheduling,
    backlinks,
    backlinks_by_intent_source: groupByIntentSource(backlinks),
    timeline: timelineEntries.map(toTimelineEntry),
    metadata: (q.metadata ?? null) as Record<string, unknown> | null,
    created_at_sec: Math.floor(q.created_at.getTime() / 1000),
    updated_at_sec: Math.floor(q.updated_at.getTime() / 1000),
    computed_at_sec: Math.floor(Date.now() / 1000),
  };
}

// ── A1d step 5 / A1e (1): per-knowledge scheduling + decay aggregate ───────────
async function loadScheduling(
  db: Db,
  questionId: string,
  knowledgeIds: string[],
  nameById: Map<string, string>,
): Promise<QuestionDetailScheduling> {
  if (knowledgeIds.length === 0) {
    // unlabeled legacy fallback: read per-question FSRS (re-map R-P3-3 confirms
    // unlabeled questions still ride the legacy material_fsrs_state(subject_kind=
    // 'question') path).
    const legacy = await db
      .select({ due_at: material_fsrs_state.due_at })
      .from(material_fsrs_state)
      .where(
        and(
          eq(material_fsrs_state.subject_kind, 'question'),
          eq(material_fsrs_state.subject_id, questionId),
        ),
      )
      .limit(1);
    const dueAtSec = toSec(legacy[0]?.due_at ?? null);
    return {
      per_knowledge: [],
      aggregate_decay_bucket: 'unknown',
      legacy_question_fsrs: dueAtSec !== null ? { due_at_sec: dueAtSec } : null,
    };
  }

  // B1 double-truth fix — mastery / evidence_count / last_evidence_at come from
  // the SoT mastery_state.theta_hat projection (getMasteryProjection → σ(θ̂)),
  // NOT the deprecated knowledge_mastery view's weighted-success-rate + `<3 →
  // 0.5` placeholder. `last_evidence_at` maps to mastery_state.last_outcome_at
  // (the real last-attempt time). Absent (never-attempted) nodes → mastery null /
  // evidence 0 / no last_evidence_at, matching the old view's NULL/0 semantics.
  const masteryByKnowledge = await getMasteryProjection(db, knowledgeIds);

  // FSRS due_at per knowledge node (subject_kind='knowledge').
  const fsrsRows = await db
    .select({ subject_id: material_fsrs_state.subject_id, due_at: material_fsrs_state.due_at })
    .from(material_fsrs_state)
    .where(
      and(
        eq(material_fsrs_state.subject_kind, 'knowledge'),
        inArray(material_fsrs_state.subject_id, knowledgeIds),
      ),
    );
  const dueByKnowledge = new Map(fsrsRows.map((r) => [r.subject_id, r.due_at]));

  const perKnowledge: QuestionDetailPerKnowledge[] = knowledgeIds.map((kid) => {
    const m = masteryByKnowledge.get(kid);
    const evidenceCount = m?.evidence_count ?? 0;
    // B1 double-truth fix — `last_evidence_at` is now the real last-attempt time
    // (mastery_state.last_outcome_at), replacing the view's last_evidence_at.
    const lastEvidenceAt = m?.last_outcome_at ?? null;
    return {
      knowledge_id: kid,
      name: nameById.get(kid) ?? null,
      mastery: m?.mastery ?? null,
      evidence_count: evidenceCount,
      last_evidence_at_sec: toSec(lastEvidenceAt),
      // 逐 knowledge 节点算 bucket（import from node-page）；不给 question 单建 bucket.
      decay_bucket: masteryDecayBucket(evidenceCount, lastEvidenceAt),
      due_at_sec: toSec(dueByKnowledge.get(kid) ?? null),
    };
  });

  // 题级 aggregate = worst-of per-knowledge bucket (DERIVED, explicitly marked).
  const aggregate = perKnowledge.reduce<MasteryDecayBucket>((worst, pk) => {
    return DECAY_SEVERITY[pk.decay_bucket] > DECAY_SEVERITY[worst] ? pk.decay_bucket : worst;
  }, 'unknown');

  return {
    per_knowledge: perKnowledge,
    aggregate_decay_bucket: aggregate,
    legacy_question_fsrs: null,
  };
}

// ── YUK-288 gap A: composite小题 — ordered parts under a parent ────────────────
// Parts are `question` rows tagged kind='question_part' (parts.ts write path),
// linked by parent_question_id and ordered by part_index. Mirrors the
// loadFamilyMembers / paper-detail.ts:247-263 select-and-order precedent. Drafts
// are NOT excluded (the detail view shows drafts — same as the parent row).
async function loadParts(db: Db, parentId: string): Promise<QuestionDetailPart[]> {
  const rows = await db
    .select({
      id: question.id,
      kind: question.kind,
      part_index: question.part_index,
      prompt_md: question.prompt_md,
      difficulty: question.difficulty,
      draft_status: question.draft_status,
    })
    .from(question)
    .where(eq(question.parent_question_id, parentId))
    .orderBy(asc(question.part_index), asc(question.created_at), asc(question.id));

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    // part_index is nullable in schema but always set by the parts.ts writer; fall
    // back to 0 so the projection type stays non-null for the UI.
    part_index: r.part_index ?? 0,
    prompt_md: r.prompt_md,
    difficulty: r.difficulty,
    draft_status: r.draft_status ?? null,
  }));
}

// ── A1e (2): 题级 backlink — tool_state.question_ids container query ────────────
async function loadBacklinks(db: Db, questionId: string): Promise<QuestionDetailBacklink[]> {
  const rows = await db
    .select({
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      tool_kind: artifact.tool_kind,
      intent_source: artifact.intent_source,
      generation_status: artifact.generation_status,
      created_at: artifact.created_at,
    })
    .from(artifact)
    // Drop archived (mirror note-page XC-5 archived drop) at the SQL layer so
    // archived rows never participate in the DB sort/transfer. We do NOT drop
    // non-ready artifacts — question-bank management wants to see ALL references
    // including draft/in-flight papers, so generation_status is surfaced and the
    // UI decides (plan §A1e).
    .where(
      and(
        sql`${artifact.tool_state}->'question_ids' @> ${JSON.stringify([questionId])}::jsonb`,
        isNull(artifact.archived_at),
      ),
    )
    .orderBy(desc(artifact.created_at));

  return rows.map((r) => ({
    artifact_id: r.id,
    type: r.type,
    title: r.title,
    tool_kind: r.tool_kind ?? null,
    intent_source: r.intent_source,
    generation_status: r.generation_status,
    created_at_sec: Math.floor(r.created_at.getTime() / 1000),
  }));
}

function groupByIntentSource(
  backlinks: QuestionDetailBacklink[],
): Record<string, QuestionDetailBacklink[]> {
  const out: Record<string, QuestionDetailBacklink[]> = {};
  for (const b of backlinks) {
    const bucket = out[b.intent_source] ?? [];
    bucket.push(b);
    out[b.intent_source] = bucket;
  }
  return out;
}

function toTimelineEntry(entry: QuestionTimelineEntry): QuestionDetailTimelineEntry {
  const base = {
    event_id: entry.event_id,
    created_at_sec: Math.floor(entry.created_at.getTime() / 1000),
    duration_ms: entry.duration_ms,
  };
  if (entry.kind === 'attempt') {
    return { kind: 'attempt', ...base, outcome: entry.outcome, cause: entry.cause };
  }
  return {
    kind: 'review',
    ...base,
    outcome: entry.outcome,
    fsrs_rating: entry.fsrs_rating,
  };
}
