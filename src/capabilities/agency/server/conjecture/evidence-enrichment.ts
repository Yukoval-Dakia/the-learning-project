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
// nightly 例会 job calls this in its PRE-LLM read stage for salience-ordered cell
// batches. Each read round is bounded by the still-empty sample slots; invalid
// mutable/missing contexts are filtered before the quote cap and later attempts
// refill those slots instead of being hidden behind a bad prefix.
//
// Untrusted-text discipline: question prompts, learner answers, reasoning traces
// and written attributions are all authored outside the system prompt, so every
// one of them is truncated + `<untrusted_learner_text>`-delimited through the
// SAME helpers the evidence MCP read tools use (scout spec §2 — one
// implementation, not two).

import { batchResolveEffectiveDomains } from '@/capabilities/knowledge/public';
import { QUESTION_EDIT_ACTION } from '@/core/schema/event/experimental';
import { FigureRef } from '@/core/schema/structured_question';
import type { Db, Tx } from '@/db/client';
import { event, knowledge, question } from '@/db/schema';
import { resolveKnownSubjectId, resolveSubjectProfile } from '@/subjects/profile';
import { and, eq, gte, inArray } from 'drizzle-orm';

import {
  type ConjectureEvidenceFigure,
  type ConjectureEvidenceSample,
  type ConjectureFailureAttempt,
  type EnrichedEvidenceCell,
  type EvidenceCell,
  effectiveCauseForConjectureFailure,
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
  | 'created_at'
  | 'updated_at'
>;

const QUESTION_CONTEXT_FIELDS = {
  id: question.id,
  prompt_md: question.prompt_md,
  reference_md: question.reference_md,
  choices_md: question.choices_md,
  parent_question_id: question.parent_question_id,
  image_refs: question.image_refs,
  figures: question.figures,
  created_at: question.created_at,
  updated_at: question.updated_at,
};

/**
 * Representative attempts carried per cell. The cell's `recurrence_count` is the
 * full tally (>= 2) and stays authoritative; this caps only how many attempts
 * are QUOTED to the model. 3 is enough to show a repeated pattern rather than a
 * one-off, while keeping the packet inside the induction budget: at most
 * RESEARCH_MEETING_MAX_CONJECTURES(3) × 3 samples × 3 text fields × 2000 chars.
 */
export const CONJECTURE_EVIDENCE_SAMPLES_PER_CELL = 3;
/** Prompt-packet bounds; the real bytes are loaded later at the job composition seam. */
export const CONJECTURE_EVIDENCE_CHOICES_PER_FIELD = 20;
export const CONJECTURE_EVIDENCE_IMAGE_REFS_PER_FIELD = 20;
export const CONJECTURE_EVIDENCE_FIGURES_PER_FIELD = 20;
export const CONJECTURE_EVIDENCE_ASSET_REF_CHAR_CAP = 512;
/** Keep validation reads bounded while still checking every attempt behind the recurrence tally. */
const CONJECTURE_EVIDENCE_VALIDATION_BATCH_PER_CELL = 20;

export interface EnrichEvidenceCellsInput {
  /** a salience-ordered cell batch (post recurrence floor + dedup). */
  cells: EvidenceCell[];
  /** the failure attempts the cells were folded from (the job already has them). */
  failures: ConjectureFailureAttempt[];
  /** attempt_event_id → YUK-562 process-data self-report, when present. */
  reasoningTraceByAttemptId?: ReadonlyMap<string, string | null>;
  /** override the per-cell quote cap (tests). */
  samplesPerCell?: number;
}

async function loadEvidenceSampleBatch(
  db: DbLike,
  failures: ConjectureFailureAttempt[],
  traceByAttemptId: ReadonlyMap<string, string | null>,
): Promise<Map<string, ConjectureEvidenceSample>> {
  if (failures.length === 0) return new Map();
  const questionIds = [...new Set(failures.map((failure) => failure.question_id))];
  const questionRows = await db
    .select(QUESTION_CONTEXT_FIELDS)
    .from(question)
    .where(inArray(question.id, questionIds));
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
  const allQuestionIds = [
    ...new Set([...questionRows, ...parentQuestionRows].map((row) => row.id)),
  ];
  const earliestAttemptAt = failures.reduce<Date | null>(
    (earliest, failure) =>
      earliest === null || failure.created_at < earliest ? failure.created_at : earliest,
    null,
  );
  const editRows =
    allQuestionIds.length > 0 && earliestAttemptAt !== null
      ? await db
          .select({ question_id: event.subject_id, created_at: event.created_at })
          .from(event)
          .where(
            and(
              eq(event.action, QUESTION_EDIT_ACTION),
              eq(event.subject_kind, 'question'),
              inArray(event.subject_id, allQuestionIds),
              gte(event.created_at, earliestAttemptAt),
            ),
          )
      : [];

  const questionById = new Map(
    [...questionRows, ...parentQuestionRows].map((row) => [row.id, row]),
  );
  const editsByQuestionId = new Map<string, Date[]>();
  for (const row of editRows) {
    const edits = editsByQuestionId.get(row.question_id) ?? [];
    edits.push(row.created_at);
    editsByQuestionId.set(row.question_id, edits);
  }
  const samples = new Map<string, ConjectureEvidenceSample>();
  for (const failure of failures) {
    const sample = toEvidenceSample(failure, questionById, traceByAttemptId, editsByQuestionId);
    if (sample !== null) samples.set(failure.attempt_event_id, sample);
  }
  return samples;
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

  const candidatesByCellKey = new Map<string, ConjectureFailureAttempt[]>();
  for (const cell of cells) {
    const candidates: ConjectureFailureAttempt[] = [];
    for (const attemptId of cell.evidence_event_ids) {
      const failure = failureByAttemptId.get(attemptId);
      if (failure) candidates.push(failure);
    }
    candidatesByCellKey.set(cell.key, candidates);
  }

  const knowledgeIds = [...new Set(cells.map((cell) => cell.knowledge_id))];
  const [knowledgeRows, effectiveDomains] = await Promise.all([
    knowledgeIds.length > 0
      ? db
          .select({ id: knowledge.id, name: knowledge.name })
          .from(knowledge)
          .where(inArray(knowledge.id, knowledgeIds))
      : Promise.resolve([]),
    // The subject axis is the node's EFFECTIVE domain, not its raw column: a
    // child KC normally carries domain=null and inherits the subject from an
    // ancestor. Reading `knowledge.domain` directly would report "subject
    // unknown" for exactly the common case and silently drop the whole run back
    // to the neutral profile — i.e. it would undo this ticket's subject
    // grounding on most cells. One query for all ids (YUK-716 batch twin).
    batchResolveEffectiveDomains(db, knowledgeIds),
  ]);

  const knowledgeById = new Map(knowledgeRows.map((row) => [row.id, row]));
  const samplesByCellKey = new Map<string, ConjectureEvidenceSample[]>(
    cells.map((cell) => [cell.key, []]),
  );
  const reproducibleIdsByCellKey = new Map<string, string[]>(cells.map((cell) => [cell.key, []]));
  const nextCandidateByCellKey = new Map<string, number>(cells.map((cell) => [cell.key, 0]));

  // Validate every contributing attempt so recurrence/provenance stays truthful, but retain only
  // the first `samplesPerCell` prompt-text samples. Rounds keep query fan-out bounded while an
  // invalid/missing prefix advances instead of permanently hiding later reproducible attempts.
  while (true) {
    const roundByCellKey = new Map<string, ConjectureFailureAttempt[]>();
    let candidatesRead = 0;
    for (const cell of cells) {
      const candidates = candidatesByCellKey.get(cell.key) ?? [];
      const offset = nextCandidateByCellKey.get(cell.key) ?? 0;
      const batch = candidates.slice(
        offset,
        offset + CONJECTURE_EVIDENCE_VALIDATION_BATCH_PER_CELL,
      );
      if (batch.length === 0) continue;
      roundByCellKey.set(cell.key, batch);
      nextCandidateByCellKey.set(cell.key, offset + batch.length);
      candidatesRead += batch.length;
    }
    if (candidatesRead === 0) break;

    const roundFailuresById = new Map<string, ConjectureFailureAttempt>();
    for (const failure of [...roundByCellKey.values()].flat()) {
      roundFailuresById.set(failure.attempt_event_id, failure);
    }
    const samplesByAttemptId = await loadEvidenceSampleBatch(
      db,
      [...roundFailuresById.values()],
      traceByAttemptId,
    );
    for (const [cellKey, batch] of roundByCellKey) {
      const samples = samplesByCellKey.get(cellKey) ?? [];
      const reproducibleIds = reproducibleIdsByCellKey.get(cellKey) ?? [];
      for (const failure of batch) {
        const sample = samplesByAttemptId.get(failure.attempt_event_id);
        if (sample === undefined) continue;
        reproducibleIds.push(failure.attempt_event_id);
        if (samples.length < samplesPerCell) samples.push(sample);
      }
      samplesByCellKey.set(cellKey, samples);
      reproducibleIdsByCellKey.set(cellKey, reproducibleIds);
    }
  }

  return cells.map((cell) => {
    const kc = knowledgeById.get(cell.knowledge_id);
    // `resolveKnownSubjectId` (NOT `resolveSubjectProfile`) decides identity: an
    // untagged / unknown domain must read as "subject unknown", never silently
    // inherit the default profile — a fabricated subject label is exactly the
    // failure this ticket exists to stop.
    const subjectId = resolveKnownSubjectId(effectiveDomains.get(cell.knowledge_id) ?? null);
    const reproducibleEventIds = reproducibleIdsByCellKey.get(cell.key) ?? [];
    return {
      ...cell,
      recurrence_count: reproducibleEventIds.length,
      evidence_event_ids: reproducibleEventIds,
      knowledge_name: wrapTruncatedLearnerText(kc?.name ?? null, UNTRUSTED_TEXT_CHAR_CAP),
      subject_id: subjectId,
      subject_display_name:
        subjectId === null ? null : resolveSubjectProfile(subjectId).displayName,
      samples: samplesByCellKey.get(cell.key) ?? [],
    };
  });
}

function wrapTextList(values: string[] | null | undefined): string[] | null {
  if (values == null) return null;
  return values
    .slice(0, CONJECTURE_EVIDENCE_CHOICES_PER_FIELD)
    .map((value) => wrapTruncatedLearnerText(value, UNTRUSTED_TEXT_CHAR_CAP));
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
  cause: ReturnType<typeof effectiveCauseForConjectureFailure>,
): string | null {
  if (cause === null) return null;
  if (cause.user_notes !== null) {
    return wrapTruncatedLearnerText(cause.user_notes, UNTRUSTED_TEXT_CHAR_CAP);
  }
  return wrapTruncatedLearnerText(cause.analysis_md, UNTRUSTED_TEXT_CHAR_CAP);
}

function toEvidenceSample(
  failure: ConjectureFailureAttempt,
  questionById: ReadonlyMap<string, QuestionContextRow>,
  traceByAttemptId: ReadonlyMap<string, string | null>,
  editsByQuestionId: ReadonlyMap<string, Date[]>,
): ConjectureEvidenceSample | null {
  const q = questionById.get(failure.question_id);
  if (!q) return null;
  const parent = q?.parent_question_id ? questionById.get(q.parent_question_id) : undefined;
  const wasEditedAtOrAfterAttempt = (questionId: string | null | undefined): boolean =>
    questionId !== null &&
    questionId !== undefined &&
    (editsByQuestionId.get(questionId) ?? []).some(
      (editedAt) => editedAt.getTime() >= failure.created_at.getTime(),
    );
  const wasMutatedAtOrAfterAttempt = (row: QuestionContextRow | undefined): boolean =>
    row !== undefined &&
    row.updated_at.getTime() > row.created_at.getTime() &&
    row.updated_at.getTime() >= failure.created_at.getTime();
  // Never pair a historical answer with a mutable question row the learner did
  // not see. Until YUK-804 persists the full question snapshot on every attempt
  // path, omit samples whose child or shared parent changed at/after submission.
  if (
    wasEditedAtOrAfterAttempt(q.id) ||
    wasEditedAtOrAfterAttempt(q.parent_question_id) ||
    wasMutatedAtOrAfterAttempt(q) ||
    wasMutatedAtOrAfterAttempt(parent)
  ) {
    return null;
  }
  const cause = effectiveCauseForConjectureFailure(failure);
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
    // which case `cause_attribution_md` is null and this is the only correctness
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
    cause_attribution_md: causeText,
  };
}
