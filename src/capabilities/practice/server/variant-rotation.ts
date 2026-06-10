// YUK-282 / ADR-0030 — variant-rotation probe: by-kind selection routing.
//
// Replaces ADR-0028's single-question-avoidance seam in `pickQuestionForKnowledge`
// (was: one ORDER BY pushing last-reviewed to the tail) with a by-kind router:
//
//   recall      (fill_blank | translation)            → original-question repeat
//   application (short_answer | reading | choice + …)  → variant-family rotation
//
// "recall" repeats the SAME question the FSRS card is measuring — replacing it
// would change the measured item and pollute the FSRS signal. "application"
// rotates within the question's `root_question_id` variant family so repeated
// reviews of one knowledge point exercise the SKILL instead of letting the user
// memorise a single question's answer.
//
// Pure / deterministic: same input → same output, no LLM, no side effects beyond
// mutating the caller-owned `usedQuestionIds` set. This is the "due = deterministic
// fallback" channel (owner Q2: AI scheduler stays a separate paper channel,
// ADR-0029). The seam stays a swappable pure function so a future AI scheduler can
// replace ONLY this selection step — see ADR-0030 §5.

import type { QuestionKindT } from '@/core/schema/judge-routing';
import type { Db } from '@/db/client';
import { event, question } from '@/db/schema';
import { and, eq, isNull, ne, notInArray, or, sql } from 'drizzle-orm';

// ADR-0030 §1 — by-kind routing class.
export type RotationClass = 'recall' | 'application';

// ADR-0030 §1 routing table (owner 2026-06-07 拍板, YUK-203 评论 a7db1f40).
//   recall:      fill_blank / translation — repeat the same question.
//   application: short_answer / reading / choice — rotate the variant family.
// Unadjudicated kinds (essay / computation / derivation / true_false) fall through
// to the CONSERVATIVE application default: they are all open/solve-type where
// "memorise the answer" is harmful, and a family of one degrades naturally to an
// original-repeat (see pickProbeForKnowledge). The `satisfies` map over the full
// QuestionKind enum forces every NEW kind through an explicit classification at
// compile time — adding a kind to the enum without listing it here is a type error.
const ROTATION_CLASS_BY_KIND = {
  fill_blank: 'recall',
  translation: 'recall',
  short_answer: 'application',
  reading: 'application',
  choice: 'application',
  // Conservative default for kinds owner did not name (ADR-0030 §决定·1). If a
  // future kind is genuinely a recall type, it MUST be reclassified here — the
  // exhaustive `satisfies` below is the guard that surfaces the new kind.
  essay: 'application',
  computation: 'application',
  derivation: 'application',
  true_false: 'application',
} satisfies Record<QuestionKindT, RotationClass>;

export function rotationClassForKind(kind: QuestionKindT): RotationClass {
  return ROTATION_CLASS_BY_KIND[kind];
}

// Projection returned to due-list — identical field set to the pre-ADR-0030
// `pickQuestionForKnowledge` return (question_id, prompt_md, reference_md,
// knowledge_ids, created_at, source, metadata). `source`/`metadata` are kept so
// downstream tier derivation (YUK-226) is unchanged.
export type SelectedProbe = {
  question_id: string;
  prompt_md: string;
  reference_md: string | null;
  knowledge_ids: string[];
  created_at: Date;
  source: string;
  metadata: Record<string, unknown> | null;
};

// Internal row shape read from `question` for routing/rotation. `draft_status` is
// carried so the recall branch can re-check the last question is still non-draft
// without a second round-trip. Read via the drizzle query builder (NOT raw
// execute) so `created_at` comes back as a Date — raw `db.execute` returns
// timestamps as strings, which would break the JS rotation sort.
type QuestionRow = {
  id: string;
  prompt_md: string;
  reference_md: string | null;
  knowledge_ids: string[];
  created_at: Date;
  source: string;
  metadata: Record<string, unknown> | null;
  kind: string;
  variant_depth: number;
  root_question_id: string | null;
  draft_status: string | null;
};

// Shared column projection — keeps the three reads (single, family, K-fallback)
// in sync.
const QUESTION_PROJECTION = {
  id: question.id,
  prompt_md: question.prompt_md,
  reference_md: question.reference_md,
  knowledge_ids: question.knowledge_ids,
  created_at: question.created_at,
  source: question.source,
  metadata: question.metadata,
  kind: question.kind,
  variant_depth: question.variant_depth,
  root_question_id: question.root_question_id,
  draft_status: question.draft_status,
} as const;

// Gate-B non-draft predicate — same三-valued-logic-safe shape as due-list's
// `notDraftQuiz` (NULL stays in pool; only literal 'draft' excluded).
const notDraft = or(isNull(question.draft_status), ne(question.draft_status, 'draft'));

function knowledgeContains(knowledgeId: string) {
  return sql`${question.knowledge_ids} @> ${JSON.stringify([knowledgeId])}::jsonb`;
}

function toProbe(row: QuestionRow): SelectedProbe {
  return {
    question_id: row.id,
    prompt_md: row.prompt_md,
    reference_md: row.reference_md,
    knowledge_ids: row.knowledge_ids ?? [],
    created_at: row.created_at,
    source: row.source,
    metadata: row.metadata,
  };
}

function isNonDraft(row: { draft_status: string | null }): boolean {
  return row.draft_status === null || row.draft_status !== 'draft';
}

// Resolve the question id presented at the knowledge point's LAST review:
//   material_fsrs_state.last_review_event_id → event.subject_id (the question).
// NULL when never reviewed.
async function lastReviewedQuestionId(
  dbHandle: Db,
  lastReviewEventId: string | null,
): Promise<string | null> {
  if (!lastReviewEventId) return null;
  const rows = await dbHandle
    .select({ subject_id: event.subject_id })
    .from(event)
    .where(eq(event.id, lastReviewEventId))
    .limit(1);
  return rows[0]?.subject_id ?? null;
}

// Read one question row (routing + lineage cols) if it exists.
async function readQuestion(dbHandle: Db, questionId: string): Promise<QuestionRow | null> {
  const rows = await dbHandle
    .select(QUESTION_PROJECTION)
    .from(question)
    .where(eq(question.id, questionId))
    .limit(1);
  return (rows[0] as QuestionRow | undefined) ?? null;
}

// K 下首个未用 non-draft 题, created_at ASC, id ASC — the shared fallback序 used by
// both branches (matches the pre-ADR-0030 fallback ordering exactly).
//
// The used-id exclusion is pushed into the WHERE (notInArray) instead of a JS
// post-filter so the DB returns the first *available* row directly: a `.limit(N)`
// page + in-memory `.find(unused)` would silently drop a knowledge point whose
// first N rows are all already used this page even though available questions
// exist past position N (CodeRabbit F1). `notInArray(col, [])` is safe in this
// drizzle version — it lowers to `true`, so the never-used-anything case still
// returns the genuine first non-draft row.
async function firstForKnowledge(
  dbHandle: Db,
  knowledgeId: string,
  usedQuestionIds: Set<string>,
): Promise<SelectedProbe | null> {
  const rows = (await dbHandle
    .select(QUESTION_PROJECTION)
    .from(question)
    .where(
      and(knowledgeContains(knowledgeId), notDraft, notInArray(question.id, [...usedQuestionIds])),
    )
    .orderBy(question.created_at, question.id)
    .limit(1)) as QuestionRow[];
  const chosen = rows[0];
  if (!chosen) return null;
  usedQuestionIds.add(chosen.id);
  return toProbe(chosen);
}

// Read the variant family of `familyRoot` that is still tagged knowledge K and
// non-draft. Family = { q : root_question_id = familyRoot OR id = familyRoot }.
async function readFamily(
  dbHandle: Db,
  familyRoot: string,
  knowledgeId: string,
): Promise<QuestionRow[]> {
  return (await dbHandle
    .select(QUESTION_PROJECTION)
    .from(question)
    .where(
      and(
        or(eq(question.root_question_id, familyRoot), eq(question.id, familyRoot)),
        knowledgeContains(knowledgeId),
        notDraft,
      ),
    )) as QuestionRow[];
}

// Deterministic rotation order (ADR-0030 §3): variant_depth ASC, created_at ASC,
// id ASC. Stable ring; same input → same order.
function sortFamily(rows: QuestionRow[]): QuestionRow[] {
  return [...rows].sort((a, b) => {
    if (a.variant_depth !== b.variant_depth) return a.variant_depth - b.variant_depth;
    const created = a.created_at.getTime() - b.created_at.getTime();
    if (created !== 0) return created;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Pick the deterministic probe question for a due knowledge point (ADR-0030).
 *
 * Routing key = the kind of the question presented at the knowledge point's LAST
 * review. NULL last review → application default (first probe).
 *
 * - recall: re-present the last question (FSRS measures THIS recall item). If it
 *   was deleted / demoted to draft / unlabelled K / already used → fall back to
 *   K's first non-draft question (created_at ASC).
 * - application: rotate within the last question's root_question_id family, taking
 *   the next member after the last (wrapping the ring). A family of one degrades
 *   to an original-repeat — the safe convergence point with recall.
 *
 * Mutates `usedQuestionIds` (adds the chosen id) so a question surfaces at most
 * once per due page (cross-knowledge dedup, unchanged from current behaviour).
 */
export async function pickProbeForKnowledge(
  dbHandle: Db,
  input: {
    knowledgeId: string;
    lastReviewEventId: string | null;
    usedQuestionIds: Set<string>;
  },
): Promise<SelectedProbe | null> {
  const { knowledgeId, lastReviewEventId, usedQuestionIds } = input;

  const lastQuestionId = await lastReviewedQuestionId(dbHandle, lastReviewEventId);
  // No prior review for this knowledge point → application default first probe
  // (族里 created_at 最早根题; behaviour-equivalent to the pre-ADR-0030
  // created_at-ASC 首选 — firstForKnowledge IS that ordering).
  if (!lastQuestionId) {
    return firstForKnowledge(dbHandle, knowledgeId, usedQuestionIds);
  }

  const lastQuestion = await readQuestion(dbHandle, lastQuestionId);
  // Last question row vanished (hard-deleted) → no kind to route on → application
  // default first probe (most conservative; matches the recall fallback 序).
  if (!lastQuestion) {
    return firstForKnowledge(dbHandle, knowledgeId, usedQuestionIds);
  }

  const cls = rotationClassForKind(lastQuestion.kind as QuestionKindT);

  if (cls === 'recall') {
    // Original-question repeat: re-present the same question iff it is still
    // non-draft, still tagged K, and not already used this page.
    const stillTagsK = (lastQuestion.knowledge_ids ?? []).includes(knowledgeId);
    if (isNonDraft(lastQuestion) && stillTagsK && !usedQuestionIds.has(lastQuestion.id)) {
      usedQuestionIds.add(lastQuestion.id);
      return toProbe(lastQuestion);
    }
    // Deleted / demoted to draft / unlabelled K / already used → fallback.
    return firstForKnowledge(dbHandle, knowledgeId, usedQuestionIds);
  }

  // application — variant-family rotation.
  const familyRoot = lastQuestion.root_question_id ?? lastQuestion.id;
  const family = (await readFamily(dbHandle, familyRoot, knowledgeId)).filter(
    (row) => !usedQuestionIds.has(row.id),
  );
  if (family.length === 0) {
    // Family minus used is empty → fall back to K's first 未用 non-draft 题.
    return firstForKnowledge(dbHandle, knowledgeId, usedQuestionIds);
  }

  const ordered = sortFamily(family);
  const idx = ordered.findIndex((row) => row.id === lastQuestion.id);
  // Q_last 之后的下一个, 环绕. Q_last not in family (deleted / unlabelled K /
  // already used) → idx === -1 → take the 序首 (ordered[0]).
  const chosen = idx >= 0 ? ordered[(idx + 1) % ordered.length] : ordered[0];
  usedQuestionIds.add(chosen.id);
  return toProbe(chosen);
}
