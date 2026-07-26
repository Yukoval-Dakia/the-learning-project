// YUK-786 — conjecture induction GROUNDING: turn the deterministic (but opaque)
// EvidenceCell into an evidence packet a domain-specific claim can actually be
// induced FROM.
//
// The problem this closes: `gatherConjectureEvidence` folds FailureAttempt[]
// into cells and keeps only `attempt_event_id` in `evidence_event_ids`. Every
// piece of natural language the upstream reader already carried —
// `question_id`, `answer_md`, `judge.cause` — was dropped, and the KC arrived at
// the LLM as a bare UUID with no subject tag. The induction prompt still asks
// for a domain-specific claim + a whole discriminating probe + its grading gold,
// and `ConjectureDraft.probe_md` is `min(1)` (no "insufficient evidence" exit),
// so the model could only invent the subject and the misconception.
//
// This module is the READ half (it needs `db`); the shape it fills lives in the
// PURE `evidence` sibling so that module keeps its no-IO unit-testability. The
// nightly 例会 job calls this in its PRE-LLM read stage, AFTER the top-K salience
// cap — so the query fan-out is bounded by K cells × SAMPLES_PER_CELL attempts,
// not by the whole 14-day failure window.
//
// Untrusted-text discipline: question prompts, learner answers, reasoning traces
// and written attributions are all authored outside the system prompt, so every
// one of them is truncated + `<untrusted_learner_text>`-delimited through the
// SAME helpers the evidence MCP read tools use (scout spec §2 — one
// implementation, not two).

import { batchResolveEffectiveDomains } from '@/capabilities/knowledge/public';
import { FigureRef } from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import { effectiveCauseForFailureAttempt } from '@/server/events/cause-policy';
import type { FailureAttempt } from '@/server/events/queries';
import { resolveKnownSubjectId, resolveSubjectProfile } from '@/subjects/profile';
import { inArray } from 'drizzle-orm';

import type {
  ConjectureEvidenceFigure,
  ConjectureEvidenceSample,
  EnrichedEvidenceCell,
  EvidenceCell,
} from '@/capabilities/agency/server/conjecture/evidence';
import { UNTRUSTED_TEXT_CHAR_CAP, wrapTruncatedLearnerText } from '@/kernel/untrusted-text';

type DbLike = Db | Tx;

type QuestionContextRow = Pick<
  typeof question.$inferSelect,
  | 'id'
  | 'prompt_md'
  | 'reference_md'
  | 'choices_md'
  | 'parent_question_id'
  | 'image_refs'
  | 'figures'
>;

const QUESTION_CONTEXT_FIELDS = {
  id: question.id,
  prompt_md: question.prompt_md,
  reference_md: question.reference_md,
  choices_md: question.choices_md,
  parent_question_id: question.parent_question_id,
  image_refs: question.image_refs,
  figures: question.figures,
};

/**
 * Representative attempts carried per cell. The cell's `recurrence_count` is the
 * full tally (>= 2) and stays authoritative; this caps only how many attempts
 * are QUOTED to the model. 3 is enough to show a repeated pattern rather than a
 * one-off, while keeping the packet inside the induction budget: at most
 * RESEARCH_MEETING_MAX_CONJECTURES(3) × 3 samples × 3 text fields × 2000 chars.
 */
export const CONJECTURE_EVIDENCE_SAMPLES_PER_CELL = 3;
/** Prompt-packet bounds; refs are identifiers, not image bytes. */
export const CONJECTURE_EVIDENCE_IMAGE_REFS_PER_FIELD = 20;
export const CONJECTURE_EVIDENCE_FIGURES_PER_FIELD = 20;
export const CONJECTURE_EVIDENCE_ASSET_REF_CHAR_CAP = 512;

export interface EnrichEvidenceCellsInput {
  /** the top-K salient cells (post recurrence floor + dedup + salience cap). */
  cells: EvidenceCell[];
  /** the failure attempts the cells were folded from (the job already has them). */
  failures: FailureAttempt[];
  /** attempt_event_id → YUK-562 process-data self-report, when present. */
  reasoningTraceByAttemptId?: ReadonlyMap<string, string | null>;
  /** override the per-cell quote cap (tests). */
  samplesPerCell?: number;
}

/**
 * Attach the grounding packet (KC name + subject identity + first-hand attempt
 * samples) to each cell. Rows that cannot be resolved degrade to `null` fields
 * rather than throwing: absent evidence is itself signal the model must see, and
 * a missing question row must not take down the whole nightly run.
 */
export async function enrichEvidenceCells(
  db: DbLike,
  input: EnrichEvidenceCellsInput,
): Promise<EnrichedEvidenceCell[]> {
  const { cells, failures } = input;
  if (cells.length === 0) return [];
  const samplesPerCell = input.samplesPerCell ?? CONJECTURE_EVIDENCE_SAMPLES_PER_CELL;
  const traceByAttemptId = input.reasoningTraceByAttemptId ?? new Map<string, string | null>();

  const failureByAttemptId = new Map(failures.map((f) => [f.attempt_event_id, f]));

  // Pick the representative attempts FIRST so the question fetch is bounded by
  // the quote cap, not by the cell's full recurrence tally.
  const quotedByCellKey = new Map<string, FailureAttempt[]>();
  for (const cell of cells) {
    const quoted: FailureAttempt[] = [];
    for (const attemptId of cell.evidence_event_ids) {
      if (quoted.length >= samplesPerCell) break;
      const failure = failureByAttemptId.get(attemptId);
      if (failure) quoted.push(failure);
    }
    quotedByCellKey.set(cell.key, quoted);
  }

  const knowledgeIds = [...new Set(cells.map((cell) => cell.knowledge_id))];
  const questionIds = [
    ...new Set([...quotedByCellKey.values()].flat().map((failure) => failure.question_id)),
  ];

  const [knowledgeRows, questionRows, effectiveDomains] = await Promise.all([
    knowledgeIds.length > 0
      ? db
          .select({ id: knowledge.id, name: knowledge.name })
          .from(knowledge)
          .where(inArray(knowledge.id, knowledgeIds))
      : Promise.resolve([]),
    questionIds.length > 0
      ? db.select(QUESTION_CONTEXT_FIELDS).from(question).where(inArray(question.id, questionIds))
      : Promise.resolve([]),
    // The subject axis is the node's EFFECTIVE domain, not its raw column: a
    // child KC normally carries domain=null and inherits the subject from an
    // ancestor. Reading `knowledge.domain` directly would report "subject
    // unknown" for exactly the common case and silently drop the whole run back
    // to the neutral profile — i.e. it would undo this ticket's subject
    // grounding on most cells. One query for all ids (YUK-716 batch twin).
    batchResolveEffectiveDomains(db, knowledgeIds),
  ]);

  const parentQuestionIds = [
    ...new Set(
      questionRows.map((row) => row.parent_question_id).filter((id): id is string => id !== null),
    ),
  ];
  const parentQuestionRows: QuestionContextRow[] =
    parentQuestionIds.length > 0
      ? await db
          .select(QUESTION_CONTEXT_FIELDS)
          .from(question)
          .where(inArray(question.id, parentQuestionIds))
      : [];

  const knowledgeById = new Map(knowledgeRows.map((row) => [row.id, row]));
  const questionById = new Map(
    [...questionRows, ...parentQuestionRows].map((row) => [row.id, row]),
  );

  return cells.map((cell) => {
    const kc = knowledgeById.get(cell.knowledge_id);
    // `resolveKnownSubjectId` (NOT `resolveSubjectProfile`) decides identity: an
    // untagged / unknown domain must read as "subject unknown", never silently
    // inherit the default profile — a fabricated subject label is exactly the
    // failure this ticket exists to stop.
    const subjectId = resolveKnownSubjectId(effectiveDomains.get(cell.knowledge_id) ?? null);
    return {
      ...cell,
      knowledge_name: wrapTruncatedLearnerText(kc?.name ?? null, UNTRUSTED_TEXT_CHAR_CAP),
      subject_id: subjectId,
      subject_display_name:
        subjectId === null ? null : resolveSubjectProfile(subjectId).displayName,
      samples: (quotedByCellKey.get(cell.key) ?? []).map((failure) =>
        toEvidenceSample(failure, questionById, traceByAttemptId),
      ),
    };
  });
}

function wrapTextList(values: string[] | null | undefined): string[] | null {
  if (values == null) return null;
  return values.map((value) => wrapTruncatedLearnerText(value, UNTRUSTED_TEXT_CHAR_CAP));
}

function safeImageRefs(values: string[] | null | undefined): string[] {
  if (values == null) return [];
  return values
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0)
    .slice(0, CONJECTURE_EVIDENCE_IMAGE_REFS_PER_FIELD)
    .map((value) => value.slice(0, CONJECTURE_EVIDENCE_ASSET_REF_CHAR_CAP));
}

function safeFigures(values: unknown): ConjectureEvidenceFigure[] {
  if (!Array.isArray(values)) return [];
  const figures: ConjectureEvidenceFigure[] = [];
  for (const value of values) {
    if (figures.length >= CONJECTURE_EVIDENCE_FIGURES_PER_FIELD) break;
    const parsed = FigureRef.safeParse(value);
    if (!parsed.success) continue;
    const assetId = parsed.data.asset_id.trim().slice(0, CONJECTURE_EVIDENCE_ASSET_REF_CHAR_CAP);
    const attachedToIndex = parsed.data.attached_to_index
      .trim()
      .slice(0, CONJECTURE_EVIDENCE_ASSET_REF_CHAR_CAP);
    if (assetId.length === 0 || attachedToIndex.length === 0) continue;
    figures.push({
      asset_id: assetId,
      role: parsed.data.role,
      source_page_index: parsed.data.source_page_index,
      source_bbox: { ...parsed.data.source_bbox },
      attached_to_index: attachedToIndex,
      attach_confidence: parsed.data.attach_confidence,
    });
  }
  return figures;
}

function causeAnalysisText(
  cause: ReturnType<typeof effectiveCauseForFailureAttempt>,
): string | null {
  if (cause === null) return null;
  if (cause.user_notes !== null) {
    return wrapTruncatedLearnerText(cause.user_notes, UNTRUSTED_TEXT_CHAR_CAP);
  }
  return wrapTruncatedLearnerText(cause.analysis_md, UNTRUSTED_TEXT_CHAR_CAP);
}

function toEvidenceSample(
  failure: FailureAttempt,
  questionById: ReadonlyMap<string, QuestionContextRow>,
  traceByAttemptId: ReadonlyMap<string, string | null>,
): ConjectureEvidenceSample {
  const q = questionById.get(failure.question_id);
  const parent = q?.parent_question_id ? questionById.get(q.parent_question_id) : undefined;
  const cause = effectiveCauseForFailureAttempt(failure);
  // Owner notes and upstream judge analysis occupy the same slot — the effective
  // cause policy decides which one has the last word on attribution. Both are
  // generated outside this prompt, so both receive the same explicit data boundary.
  const causeText = causeAnalysisText(cause);
  return {
    attempt_event_id: failure.attempt_event_id,
    question_id: failure.question_id,
    question_prompt_md: wrapTruncatedLearnerText(q?.prompt_md ?? null, UNTRUSTED_TEXT_CHAR_CAP),
    // The GOLD answer for the question that was failed. Without it the packet
    // shows what was asked and what the owner wrote but not what "right" was,
    // so neither the model nor a blind reviewer can say HOW the answer deviated
    // — and the induction is asked for a claim about that deviation. Especially
    // load-bearing when the owner supplied only a cause category (no notes), in
    // which case `cause_analysis_md` is null and this is the only correctness
    // signal in the sample.
    question_reference_md: wrapTruncatedLearnerText(
      q?.reference_md ?? null,
      UNTRUSTED_TEXT_CHAR_CAP,
    ),
    question_choices_md: wrapTextList(q?.choices_md),
    question_image_refs: safeImageRefs(q?.image_refs),
    question_figures: safeFigures(q?.figures),
    parent_question_id: q?.parent_question_id ?? null,
    parent_question_prompt_md: wrapTruncatedLearnerText(
      parent?.prompt_md ?? null,
      UNTRUSTED_TEXT_CHAR_CAP,
    ),
    parent_question_reference_md: wrapTruncatedLearnerText(
      parent?.reference_md ?? null,
      UNTRUSTED_TEXT_CHAR_CAP,
    ),
    parent_question_choices_md: wrapTextList(parent?.choices_md),
    parent_question_image_refs: safeImageRefs(parent?.image_refs),
    parent_question_figures: safeFigures(parent?.figures),
    answer_md: wrapTruncatedLearnerText(failure.answer_md, UNTRUSTED_TEXT_CHAR_CAP),
    answer_image_refs: safeImageRefs(failure.answer_image_refs),
    reasoning_trace: wrapTruncatedLearnerText(
      traceByAttemptId.get(failure.attempt_event_id) ?? null,
      UNTRUSTED_TEXT_CHAR_CAP,
    ),
    cause_category: cause?.primary_category ?? null,
    cause_source: cause?.source ?? null,
    cause_analysis_md: causeText,
  };
}
