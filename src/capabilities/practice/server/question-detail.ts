// Single-question detail reader: aggregates everything the question-bank detail view
// needs into one server call (null → 404). It reuses source-tier, mastery-decay,
// timeline and family readers instead of re-implementing them. The question-level
// decay bucket is a derived worst-of, never question-owned state; timestamps are unix
// seconds like the rest of the API.

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import {
  type MasteryDecayBucket,
  masteryDecayBucket,
  worstMasteryDecayBucket,
} from '@/core/mastery-freshness';
import { type SourceTier, type SourceTierName, deriveSourceTier } from '@/core/schema/provenance';
import type { Db } from '@/db/client';
import { artifact, knowledge, material_fsrs_state, question } from '@/db/schema';
import {
  abilityReadingsByIdOrFail,
  readLearnerJudgments,
} from '@/kernel/read-models/learner-judgment';
import {
  type QuestionTimelineEntry,
  getQuestionTimeline,
} from '@/kernel/read-models/question-activity';
import { loadFamilyMembers } from '@/kernel/read-models/questions';
import {
  batchResolveSubjectDisplayIds,
  resolveSubjectRenderNotation,
} from '@/kernel/read-models/subject-resolution';

const DEFAULT_TIMELINE_LIMIT = 10;
const MAX_TIMELINE_LIMIT = 50;

export interface QuestionDetailLabel {
  id: string;
  name: string;
}

export interface QuestionDetailFamilyMember {
  id: string;
  variant_depth: number;
  kind: string;
  // Part-ness authority; the `kind='question_part'` label is display-only.
  parent_question_id: string | null;
  is_self: boolean;
}

export interface QuestionDetailFamily {
  root_question_id: string;
  members: QuestionDetailFamilyMember[];
  variant_count: number;
}

// Composite parts: a part is a `question` row linked by `parent_question_id` and
// ordered by `part_index` (the FK is the authority, not the display label). A
// parent's detail carries its ordered parts; a part carries the parent id.
export interface QuestionDetailPart {
  id: string;
  kind: string;
  // Always the queried parent id; the UI reads this FK, not the display label.
  parent_question_id: string | null;
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
  // 'unknown' when there is no evidenced ability. That is not the untrained label.
  decay_bucket: MasteryDecayBucket;
  due_at_sec: number | null;
}

export interface QuestionDetailScheduling {
  per_knowledge: QuestionDetailPerKnowledge[];
  // Worst-of per-knowledge buckets; 'unknown' when there are no knowledge nodes.
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
  assessment?: {
    evaluation_group_id: string;
    original_evaluation_id: string | null;
    effective_evaluation_id: string | null;
  };
  // attempt-only
  cause?: {
    primary: string;
    confidence: number | null;
    // Display-only labels; unresolved ids fall back to the raw id.
    primary_label: string | null;
    secondary: string[];
    secondary_labels: Record<string, string>;
  } | null;
  // review-only
  fsrs_rating?: 'again' | 'hard' | 'good';
}

export interface QuestionDetail {
  id: string;
  /** Learner-facing subject id derived from the first knowledge node, or null. */
  subject: string | null;
  /** Server-resolved render notation; includes retired custom subject profiles. */
  notation: string | null;
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
  // Composite linkage: set when this question is a part; `parts` is populated when
  // it is a parent.
  parent_question_id: string | null;
  part_index: number | null;
  parts: QuestionDetailPart[];
  draft_status: string | null;
  // Optimistic-lock token for the editor's PATCH/DELETE; a stale value 409s.
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
 * Aggregate the /questions/[id] detail reads into one call; null lets the route 404.
 * Unlike the list reader, detail includes drafts because it is reached by explicit id.
 */
export async function loadQuestionDetail(
  db: Db,
  questionId: string,
  timelineLimit: number = DEFAULT_TIMELINE_LIMIT,
): Promise<QuestionDetail | null> {
  const rows = await db.select().from(question).where(eq(question.id, questionId)).limit(1);
  const q = rows[0];
  if (!q) return null;

  const knowledgeIds = q.knowledge_ids ?? [];

  const subjectById = await batchResolveSubjectDisplayIds(db, [
    { id: q.id, knowledge_ids: knowledgeIds },
  ]);
  const subject = subjectById.get(q.id) ?? null;

  const sourceTier = deriveSourceTier({
    source: q.source,
    metadata: (q.metadata ?? null) as Record<string, unknown> | null,
  });

  // Labels drop archived/missing nodes; the scheduling section keeps them.
  const labelRows =
    knowledgeIds.length === 0
      ? []
      : await db
          .select({ id: knowledge.id, name: knowledge.name })
          .from(knowledge)
          .where(and(inArray(knowledge.id, knowledgeIds), isNull(knowledge.archived_at)));
  const nameById = new Map(labelRows.map((r) => [r.id, r.name]));
  const labels: QuestionDetailLabel[] = labelRows.map((r) => ({ id: r.id, name: r.name }));

  // Detail shows drafts, so excludeDrafts=false.
  const familyKey = q.root_question_id ?? q.id;
  const familyRows = await loadFamilyMembers(db, familyKey, false);
  const family: QuestionDetailFamily = {
    root_question_id: familyKey,
    members: familyRows.map((m) => ({
      id: m.id,
      variant_depth: m.variant_depth,
      kind: m.kind,
      parent_question_id: m.parent_question_id,
      is_self: m.id === q.id,
    })),
    variant_count: familyRows.length,
  };

  const parts = await loadParts(db, questionId);
  const scheduling = await loadScheduling(db, questionId, knowledgeIds, nameById);
  const backlinks = await loadBacklinks(db, questionId);
  const effectiveLimit = Math.min(Math.max(timelineLimit, 1), MAX_TIMELINE_LIMIT);
  const timelineEntries = await getQuestionTimeline(db, questionId, effectiveLimit);

  return {
    id: q.id,
    subject,
    notation: resolveSubjectRenderNotation(subject),
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
    version: q.version,
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

async function loadScheduling(
  db: Db,
  questionId: string,
  knowledgeIds: string[],
  nameById: Map<string, string>,
): Promise<QuestionDetailScheduling> {
  if (knowledgeIds.length === 0) {
    // Unlabeled questions still use the legacy per-question FSRS card.
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

  // Evidenced ability only. Insufficient evidence stays null with decay
  // unknown, not an untrained/cold-start low score. Due dates stay on the raw
  // scheduling projection — the contract does not own due dates.
  const judgmentBatch = await readLearnerJudgments(db, {
    knowledge_ids: knowledgeIds,
    context: 'any',
    as_of: new Date(),
  });
  const masteryByKnowledge = abilityReadingsByIdOrFail(judgmentBatch);

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
    const lastEvidenceAt = m?.last_outcome_at ?? null;
    return {
      knowledge_id: kid,
      name: nameById.get(kid) ?? null,
      mastery: m?.mastery ?? null,
      evidence_count: evidenceCount,
      last_evidence_at_sec: toSec(lastEvidenceAt),
      decay_bucket: m
        ? masteryDecayBucket(evidenceCount, lastEvidenceAt, judgmentBatch.as_of)
        : 'unknown',
      due_at_sec: toSec(dueByKnowledge.get(kid) ?? null),
    };
  });

  const aggregate = worstMasteryDecayBucket(perKnowledge.map((pk) => pk.decay_bucket));

  return {
    per_knowledge: perKnowledge,
    aggregate_decay_bucket: aggregate,
    legacy_question_fsrs: null,
  };
}

async function loadParts(db: Db, parentId: string): Promise<QuestionDetailPart[]> {
  const rows = await db
    .select({
      id: question.id,
      kind: question.kind,
      parent_question_id: question.parent_question_id,
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
    parent_question_id: r.parent_question_id,
    // Nullable in schema but always set by the parts writer.
    part_index: r.part_index ?? 0,
    prompt_md: r.prompt_md,
    difficulty: r.difficulty,
    draft_status: r.draft_status ?? null,
  }));
}

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
    // Drop archived rows in SQL; keep non-ready artifacts so management can see
    // draft/in-flight papers, with generation_status left to the UI.
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
  // Map grouping avoids prototype-key collisions from DB-supplied intent_source
  // ('__proto__' etc.); Object.fromEntries re-materializes the same JSON shape.
  const buckets = new Map<string, QuestionDetailBacklink[]>();
  for (const b of backlinks) {
    const bucket = buckets.get(b.intent_source);
    if (bucket) bucket.push(b);
    else buckets.set(b.intent_source, [b]);
  }
  return Object.fromEntries(buckets);
}

function toTimelineEntry(entry: QuestionTimelineEntry): QuestionDetailTimelineEntry {
  const base = {
    event_id: entry.event_id,
    created_at_sec: Math.floor(entry.created_at.getTime() / 1000),
    duration_ms: entry.duration_ms,
  };
  if (entry.kind === 'attempt') {
    return {
      kind: 'attempt',
      ...base,
      outcome: entry.outcome,
      cause: entry.cause,
      ...(entry.assessment ? { assessment: entry.assessment } : {}),
    };
  }
  return {
    kind: 'review',
    ...base,
    outcome: entry.outcome,
    fsrs_rating: entry.fsrs_rating,
  };
}
