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
import { isPoolVisible, notDraftPredicate } from '@/db/predicates';
import { event, question } from '@/db/schema';
import { and, inArray, sql } from 'drizzle-orm';

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

// YUK-716 — bulk-prefetched inputs for a whole page of due knowledge points, so the
// per-KC probe selection runs as pure in-memory computation instead of 2-3 serial
// round-trips per KC (the /api/review/due N+1). Three batch reads back these maps.
export interface ProbeSelectionPrefetch {
  // last_review_event_id → the question id presented at that review (event.subject_id).
  lastQuestionIdByEventId: Map<string, string>;
  // last-reviewed question rows (routing + lineage cols), keyed by id. NO draft filter —
  // mirrors the single readQuestion, which reads any row regardless of draft_status.
  questionRowById: Map<string, QuestionRow>;
  // per due-KC: its pool-visible (non-draft) questions, sorted (created_at ASC, id ASC) —
  // the exact firstForKnowledge ordering. Family reads filter this same bucket in memory.
  kcQuestions: Map<string, QuestionRow[]>;
}

/**
 * YUK-716 — prefetch every DB input {@link selectProbeFromPrefetch} needs for a batch of due
 * knowledge points in THREE reads total (independent of KC count):
 *   1. last-review event → presented question id (one `inArray` over event ids);
 *   2. the last-reviewed question rows (one `inArray` over those question ids, no draft filter);
 *   3. every non-draft question containing ANY of the due KCs (one containment scan), bucketed
 *      per KC in (created_at, id) order.
 *
 * Bucket (3) is the superset for BOTH fallback paths: a family member must be tagged the due
 * KC (readFamily's `knowledgeContains(K)`), so it always appears in that KC's bucket — the
 * family read becomes an in-memory filter of the bucket by `root_question_id`/`id`.
 */
export async function prefetchProbeSelection(
  dbHandle: Db,
  inputs: Array<{ knowledgeId: string; lastReviewEventId: string | null }>,
): Promise<ProbeSelectionPrefetch> {
  const eventIds = Array.from(
    new Set(inputs.map((i) => i.lastReviewEventId).filter((id): id is string => id !== null)),
  );
  const lastQuestionIdByEventId = new Map<string, string>();
  if (eventIds.length > 0) {
    const rows = await dbHandle
      .select({ id: event.id, subject_id: event.subject_id })
      .from(event)
      .where(inArray(event.id, eventIds));
    for (const r of rows) lastQuestionIdByEventId.set(r.id, r.subject_id);
  }

  const lastQuestionIds = Array.from(new Set(lastQuestionIdByEventId.values()));
  const questionRowById = new Map<string, QuestionRow>();
  if (lastQuestionIds.length > 0) {
    const rows = (await dbHandle
      .select(QUESTION_PROJECTION)
      .from(question)
      .where(inArray(question.id, lastQuestionIds))) as QuestionRow[];
    for (const r of rows) questionRowById.set(r.id, r);
  }

  const knowledgeIds = Array.from(new Set(inputs.map((i) => i.knowledgeId)));
  const kcQuestions = new Map<string, QuestionRow[]>();
  if (knowledgeIds.length > 0) {
    // OR-of-containments over the due KC set, PARENTHESISED so it composes with the
    // non-draft predicate as `notDraft AND (c1 OR c2 …)` (drizzle's `and` would otherwise
    // fold the bare OR chain at the wrong precedence).
    const containment = sql`(${sql.join(
      knowledgeIds.map((kc) => knowledgeContains(kc)),
      sql` OR `,
    )})`;
    const rows = (await dbHandle
      .select(QUESTION_PROJECTION)
      .from(question)
      .where(and(notDraftPredicate(question.draft_status), containment))
      .orderBy(question.created_at, question.id)) as QuestionRow[];
    const dueKcSet = new Set(knowledgeIds);
    for (const r of rows) {
      for (const kc of r.knowledge_ids ?? []) {
        if (!dueKcSet.has(kc)) continue;
        const bucket = kcQuestions.get(kc);
        if (bucket) bucket.push(r);
        else kcQuestions.set(kc, [r]);
      }
    }
  }

  return { lastQuestionIdByEventId, questionRowById, kcQuestions };
}

// K 下首个未用 non-draft 题, created_at ASC, id ASC — the shared fallback序 used by
// both branches (matches the pre-ADR-0030 fallback ordering exactly).
//
// Pure over the prefetched (created_at, id)-sorted bucket: `.find(unused)` returns the first
// AVAILABLE question directly, so a knowledge point whose leading questions are all already
// used this page still surfaces one past that prefix (the CodeRabbit F1 invariant — the
// bucket is the FULL list, never a `.limit(N)` page).
function firstForKnowledgePure(
  kcQuestions: Map<string, QuestionRow[]>,
  knowledgeId: string,
  usedQuestionIds: Set<string>,
): SelectedProbe | null {
  const rows = kcQuestions.get(knowledgeId) ?? [];
  const chosen = rows.find((row) => !usedQuestionIds.has(row.id));
  if (!chosen) return null;
  usedQuestionIds.add(chosen.id);
  return toProbe(chosen);
}

// The variant family of `familyRoot` still tagged K and non-draft, filtered in memory from
// the due-KC bucket. Family = { q ∈ bucket(K) : root_question_id = familyRoot OR id = familyRoot }.
// bucket(K) already enforces "non-draft AND tagged K", so this matches the readFamily SQL set.
function readFamilyPure(
  kcQuestions: Map<string, QuestionRow[]>,
  familyRoot: string,
  knowledgeId: string,
): QuestionRow[] {
  const rows = kcQuestions.get(knowledgeId) ?? [];
  return rows.filter((row) => row.root_question_id === familyRoot || row.id === familyRoot);
}

/**
 * Pick the deterministic probe question for a due knowledge point (ADR-0030), PURE over a
 * {@link ProbeSelectionPrefetch}. Byte-identical selection to the pre-YUK-716 per-KC DB walk —
 * it is a straight in-memory translation of the same routing/fallback branches.
 *
 * Routing key = the kind of the question presented at the knowledge point's LAST review.
 * NULL last review → application default (first probe).
 *
 * - recall: re-present the last question (FSRS measures THIS recall item). If it was deleted /
 *   demoted to draft / unlabelled K / already used → fall back to K's first non-draft question.
 * - application: rotate within the last question's root_question_id family, taking the next
 *   member after the last (wrapping the ring). A family of one degrades to an original-repeat.
 *
 * Mutates `usedQuestionIds` (adds the chosen id) so a question surfaces at most once per due
 * page (cross-knowledge dedup). Callers thread ONE shared set through the page in order — the
 * used-set is the only state, so a sequential loop over prefetched inputs is order-identical
 * to the old sequential DB loop.
 */
export function selectProbeFromPrefetch(
  prefetch: ProbeSelectionPrefetch,
  input: {
    knowledgeId: string;
    lastReviewEventId: string | null;
    usedQuestionIds: Set<string>;
  },
): SelectedProbe | null {
  const { knowledgeId, lastReviewEventId, usedQuestionIds } = input;
  const { kcQuestions } = prefetch;

  const lastQuestionId = lastReviewEventId
    ? (prefetch.lastQuestionIdByEventId.get(lastReviewEventId) ?? null)
    : null;
  // No prior review for this knowledge point → application default first probe
  // (族里 created_at 最早根题; firstForKnowledge IS that ordering).
  if (!lastQuestionId) {
    return firstForKnowledgePure(kcQuestions, knowledgeId, usedQuestionIds);
  }

  const lastQuestion = prefetch.questionRowById.get(lastQuestionId) ?? null;
  // Last question row vanished (hard-deleted) → no kind to route on → application
  // default first probe (most conservative; matches the recall fallback 序).
  if (!lastQuestion) {
    return firstForKnowledgePure(kcQuestions, knowledgeId, usedQuestionIds);
  }

  const cls = rotationClassForKind(lastQuestion.kind as QuestionKindT);

  if (cls === 'recall') {
    // Original-question repeat: re-present the same question iff it is still
    // non-draft, still tagged K, and not already used this page.
    const stillTagsK = (lastQuestion.knowledge_ids ?? []).includes(knowledgeId);
    if (isPoolVisible(lastQuestion) && stillTagsK && !usedQuestionIds.has(lastQuestion.id)) {
      usedQuestionIds.add(lastQuestion.id);
      return toProbe(lastQuestion);
    }
    // Deleted / demoted to draft / unlabelled K / already used → fallback.
    return firstForKnowledgePure(kcQuestions, knowledgeId, usedQuestionIds);
  }

  // application — variant-family rotation.
  const familyRoot = lastQuestion.root_question_id ?? lastQuestion.id;
  const family = readFamilyPure(kcQuestions, familyRoot, knowledgeId).filter(
    (row) => !usedQuestionIds.has(row.id),
  );
  if (family.length === 0) {
    // Family minus used is empty → fall back to K's first 未用 non-draft 题.
    return firstForKnowledgePure(kcQuestions, knowledgeId, usedQuestionIds);
  }

  const ordered = sortFamily(family);
  const idx = ordered.findIndex((row) => row.id === lastQuestion.id);
  // Q_last 之后的下一个, 环绕. Q_last not in family (deleted / unlabelled K /
  // already used) → idx === -1 → take the 序首 (ordered[0]).
  const chosen = idx >= 0 ? ordered[(idx + 1) % ordered.length] : ordered[0];
  usedQuestionIds.add(chosen.id);
  return toProbe(chosen);
}

/**
 * Single-KC entry point (ADR-0030) — prefetch this one KC's inputs, then run the pure selection
 * core. Preserved for direct callers/tests; the batch `/api/review/due` path calls
 * {@link prefetchProbeSelection} ONCE for the whole page and loops {@link selectProbeFromPrefetch}.
 */
export async function pickProbeForKnowledge(
  dbHandle: Db,
  input: {
    knowledgeId: string;
    lastReviewEventId: string | null;
    usedQuestionIds: Set<string>;
  },
): Promise<SelectedProbe | null> {
  const prefetch = await prefetchProbeSelection(dbHandle, [
    { knowledgeId: input.knowledgeId, lastReviewEventId: input.lastReviewEventId },
  ]);
  return selectProbeFromPrefetch(prefetch, input);
}
