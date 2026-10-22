// Deterministic conjecture evidence (NO LLM). Folds recent failure attempts into
// (cause_category × knowledge_id) "cells" that are candidate conjectures. PURE: the
// caller fetches FailureAttempt[] and mastery, so the recurrence/salience math stays
// unit-testable without DB.
//
// Two gates keep one-off noise out:
//   - recurrence floor (>= 2 distinct attempts for a cell), and
//   - dedup against already-raised conjecture keys (knownConjectureKeys).
//
// Each cell snapshots `baseline_p` = the learner's PFA mastery p(L) for the KC — the
// number the qualitative claim must later beat.

import type { CauseCategoryT, CauseSchemaT } from '@/core/schema/event/blocks';
import type { AttemptQuestionSnapshotT } from '@/core/schema/question-evidence-snapshot';
import type { BBoxT, FigureRefT } from '@/core/schema/structured_question';

export const CONJECTURE_RECURRENCE_FLOOR = 2;

/**
 * theta_precision below this ⇒ wide SE (thetaSe = 1/√precision) ⇒ low confidence in
 * the θ̂ point estimate ⇒ "probe here". Cold start has precision 1 (weak 1-unit
 * prior, SE = 1), so a barely observed KC is flagged. Placeholder scale until
 * fixed-anchor calibration; 1.5 ≈ SE 0.82.
 */
export const LOW_PRECISION_THRESHOLD = 1.5;

/** Stable dedup / sort key for a (cause_category, knowledge_id) conjecture cell. */
export function conjectureKey(causeCategory: CauseCategoryT, knowledgeId: string): string {
  return `${causeCategory}::${knowledgeId}`;
}

export interface EvidenceCell {
  /** conjectureKey(cause_category, knowledge_id) — stable dedup / sort key. */
  key: string;
  cause_category: CauseCategoryT;
  knowledge_id: string;
  /** Distinct failure attempts contributing to this cell (>= CONJECTURE_RECURRENCE_FLOOR). */
  recurrence_count: number;
  /** Attempt event ids in first-seen order (→ evidence_refs). */
  evidence_event_ids: string[];
  /** θ̂ for this KC, or null when no mastery row exists (cold start). */
  theta_hat: number | null;
  /** Cumulative Fisher information for θ̂, or null on cold start. */
  theta_precision: number | null;
  /**
   * PFA mastery p(L) for this KC, or null on cold start. Snapshotted as the
   * conjecture's `baseline_p_at_induction` — the number the claim must later beat.
   */
  baseline_p: number | null;
  /** true ⇒ low-precision (or unknown) KC: a good place to spend the one probe. */
  probe_here: boolean;
  /** true iff any contributing attempt has an owner-supplied (source:'user') cause. */
  has_owner_cause: boolean;
  /**
   * 至少一条贡献 attempt 的【原始判】≠【effective 判】（contested verdict / 改判）。
   * 供 induction 区分「稳定的错误归因证据」与「争议判改判后的证据」；缺原始判不视为 contested。
   */
  has_contested_verdict: boolean;
}

// ── First-hand grounding packet ─────────────────────────────────────────────
//
// An EvidenceCell alone is opaque scalars, while the induction prompt asks for a
// domain-specific claim plus a whole discriminating probe and its grading gold.
// These types carry the first-hand evidence. They live here to keep this module
// PURE; the db-reading builder is in the `enrich` sibling.

export interface ConjectureEvidenceFigure {
  asset_id: string;
  role: FigureRefT['role'];
  source_page_index: number;
  source_bbox: BBoxT;
  attached_to_index: string;
  attach_confidence: FigureRefT['attach_confidence'];
}

export interface ConjectureEvidenceSample {
  attempt_event_id: string;
  question_id: string;
  /** question.prompt_md — what was actually asked (wrapped + truncated). */
  question_prompt_md: string | null;
  /**
   * question.reference_md — the GOLD answer to that question (wrapped +
   * truncated), or null when absent. Without it the deviation the claim is about
   * is not reconstructable.
   */
  question_reference_md: string | null;
  /** question.choices_md — the full choice set (each item wrapped + truncated). */
  question_choices_md: string[] | null;
  /** First-class simple image refs for the question. */
  question_image_refs: string[];
  /** Structured figure refs, projected to an immutable prompt-safe shape. */
  question_figures: ConjectureEvidenceFigure[];
  /** question_part parent id, or null for a standalone question. */
  parent_question_id: string | null;
  /** parent prompt/shared passage needed to interpret a question_part. */
  parent_question_prompt_md: string | null;
  parent_question_reference_md: string | null;
  /** Parent choices (each item wrapped + truncated). */
  parent_question_choices_md: string[] | null;
  parent_question_image_refs: string[];
  parent_question_figures: ConjectureEvidenceFigure[];
  /** The learner's own wrong answer (wrapped + truncated). */
  answer_md: string | null;
  /** Image-only or image-bearing learner answer asset refs. */
  answer_image_refs: string[];
  /** Process data: the learner's account of HOW they thought. */
  reasoning_trace: string | null;
  /** Effective cause category for this attempt (owner cause wins over judge). */
  cause_category: CauseCategoryT | null;
  /** 'user' when the owner attributed it, 'agent' when the judge did. */
  cause_source: 'user' | 'agent' | null;
  /**
   * The written attribution. Both owner notes and upstream judge analysis are
   * generated outside the induction prompt, so enrich delimits them as untrusted data.
   */
  cause_attribution_md: string | null;
}

/** The db-resolved context an {@link EvidenceCell} is missing. */
export interface EvidenceCellEnrichment {
  /** knowledge.name — human-readable, wrapped + truncated as untrusted text. */
  knowledge_name: string | null;
  /** Canonical subject id from the KC's effective domain, or null when untagged. */
  subject_id: string | null;
  /** The subject's display name (e.g. 语文), or null when untagged. */
  subject_display_name: string | null;
  /**
   * Representative first-hand samples, capped; may be empty when rows are missing.
   * On an enriched cell, `evidence_event_ids` / `recurrence_count` are narrowed to ALL
   * reproducible attempts even when only the first few samples carry prompt text.
   */
  samples: ConjectureEvidenceSample[];
}

/** An {@link EvidenceCell} carrying its grounding packet. */
export type EnrichedEvidenceCell = EvidenceCell & EvidenceCellEnrichment;

export type ConjectureEvidenceImageSource = 'question' | 'parent_question' | 'answer';

/**
 * One image occurrence in the stable packet order: child question → shared parent
 * question → learner answer, per sample.
 */
export interface ConjectureEvidenceAssetRef {
  asset_id: string;
  attempt_event_id: string;
  source: ConjectureEvidenceImageSource;
}

/**
 * One unique asset plus every evidence occurrence that points at it. The bytes are
 * sent once per induction sample; `occurrences` preserves semantic roles without
 * duplicating the same base64 block for every attempt/source pair.
 */
export interface LoadedConjectureEvidenceImage {
  asset_id: string;
  occurrences: Array<Omit<ConjectureEvidenceAssetRef, 'asset_id'>>;
  /** base64 without a data: prefix (the runner also accepts Uint8Array). */
  data: string;
  mediaType: string;
}

/**
 * Collect image occurrences in the order the model receives them. Figure refs and
 * simple refs within one sample/source are deduped; the same asset in another attempt
 * or semantic role stays separate so reuse is not erased.
 */
export function collectConjectureEvidenceAssetRefs(
  cell: EnrichedEvidenceCell,
): ConjectureEvidenceAssetRef[] {
  const refs: ConjectureEvidenceAssetRef[] = [];
  const seen = new Set<string>();
  const append = (
    assetIds: readonly string[],
    attemptEventId: string,
    source: ConjectureEvidenceImageSource,
  ) => {
    for (const assetId of assetIds) {
      const occurrenceKey = `${attemptEventId}\u0000${source}\u0000${assetId}`;
      if (seen.has(occurrenceKey)) continue;
      seen.add(occurrenceKey);
      refs.push({ asset_id: assetId, attempt_event_id: attemptEventId, source });
    }
  };

  for (const sample of cell.samples) {
    append(
      [...sample.question_image_refs, ...sample.question_figures.map((figure) => figure.asset_id)],
      sample.attempt_event_id,
      'question',
    );
    append(
      [
        ...sample.parent_question_image_refs,
        ...sample.parent_question_figures.map((figure) => figure.asset_id),
      ],
      sample.attempt_event_id,
      'parent_question',
    );
    append(sample.answer_image_refs, sample.attempt_event_id, 'answer');
  }
  return refs;
}

/**
 * Agency-owned, read-only projection of the legacy failure stream.
 *
 * Keep only fields conjecture evidence consumes. The legacy `FailureAttempt`
 * reader is structurally assignable to this contract, so the agency domain stays
 * testable without importing `@/server/*`.
 */
export interface ConjectureFailureAttempt {
  attempt_event_id: string;
  question_id: string;
  answer_md: string | null;
  answer_image_refs: string[];
  referenced_knowledge_ids: string[];
  /** Immutable on new attempt events; absent/null for legacy and review rows. */
  question_snapshot?: AttemptQuestionSnapshotT | null;
  created_at: Date;
  judge?: {
    cause: CauseSchemaT;
    created_at: Date;
  };
  /**
   * 双轨裁决：`judge` 是 effective 判；本字段是原始执行收据侧 earliest judge（首判，
   * 未链解析）。原始判与 effective 判走不同轨时，该 attempt 的归因证据是可争的。
   */
  original_judge?: {
    cause: CauseSchemaT;
    created_at: Date;
  } | null;
  user_cause?: {
    primary_category: CauseCategoryT;
    user_notes: string | null;
    created_at: Date;
  };
}

/** Minimal mastery projection consumed by the conjecture salience calculation. */
export interface ConjectureMasteryProjection {
  theta_hat: number;
  theta_precision: number;
  mastery: number;
}

export interface GatherConjectureEvidenceInput {
  /** Recent failure attempts. */
  failures: ConjectureFailureAttempt[];
  /** knowledge_id → mastery projection. */
  masteryByKnowledgeId: ReadonlyMap<string, ConjectureMasteryProjection>;
  /** Dedup: conjectureKey(...) values already raised — skip these cells. */
  knownConjectureKeys: Set<string>;
}

interface CellAccumulator {
  cause_category: CauseCategoryT;
  knowledge_id: string;
  /** Distinct attempt ids, insertion-ordered (Map preserves first-seen order). */
  attemptIds: Map<string, true>;
  hasOwnerCause: boolean;
  /** 至少一条贡献 attempt 的原始判 ≠ effective 判（改判 contested）。 */
  hasContestedVerdict: boolean;
}

export interface EffectiveConjectureCause {
  source: 'user' | 'agent';
  primary_category: CauseCategoryT;
  analysis_md: string | null;
  user_notes: string | null;
}

/**
 * Conjecture-local effective-cause projection: owner attribution wins over the
 * upstream judge. Deliberately mirrors the legacy read policy; returns only the
 * fields induction consumes.
 */
export function effectiveCauseForConjectureFailure(
  failure: ConjectureFailureAttempt,
): EffectiveConjectureCause | null {
  if (failure.user_cause) {
    return {
      source: 'user',
      primary_category: failure.user_cause.primary_category,
      analysis_md: null,
      user_notes: failure.user_cause.user_notes,
    };
  }
  if (failure.judge) {
    return {
      source: 'agent',
      primary_category: failure.judge.cause.primary_category,
      analysis_md: failure.judge.cause.analysis_md,
      user_notes: null,
    };
  }
  return null;
}

export function gatherConjectureEvidence(input: GatherConjectureEvidenceInput): EvidenceCell[] {
  const { failures, masteryByKnowledgeId, knownConjectureKeys } = input;

  // Fan each failure out across (effective cause_category × each referenced KC).
  const acc = new Map<string, CellAccumulator>();
  for (const failure of failures) {
    const cause = effectiveCauseForConjectureFailure(failure);
    if (cause === null) continue; // no active cause — cannot attribute a conjecture
    const isOwnerCause = cause.source === 'user';
    for (const knowledgeId of failure.referenced_knowledge_ids) {
      const key = conjectureKey(cause.primary_category, knowledgeId);
      const cell =
        acc.get(key) ??
        ({
          cause_category: cause.primary_category,
          knowledge_id: knowledgeId,
          attemptIds: new Map<string, true>(),
          hasOwnerCause: false,
          hasContestedVerdict: false,
        } satisfies CellAccumulator);
      cell.attemptIds.set(failure.attempt_event_id, true); // Map ⇒ distinct, ordered
      if (isOwnerCause) cell.hasOwnerCause = true;
      // 双轨：原始判存在且分类 ≠ effective 分类时，视为 contested。
      if (
        failure.original_judge &&
        failure.original_judge.cause.primary_category !== cause.primary_category
      ) {
        cell.hasContestedVerdict = true;
      }
      acc.set(key, cell);
    }
  }

  // Keep cells at/above the recurrence floor, skip already-known, attach mastery.
  const cells: EvidenceCell[] = [];
  for (const [key, cell] of acc) {
    if (cell.attemptIds.size < CONJECTURE_RECURRENCE_FLOOR) continue;
    if (knownConjectureKeys.has(key)) continue;
    const mastery = masteryByKnowledgeId.get(cell.knowledge_id) ?? null;
    const thetaHat = mastery?.theta_hat ?? null;
    const thetaPrecision = mastery?.theta_precision ?? null;
    const baselineP = mastery?.mastery ?? null;
    // Unknown mastery (cold start) is itself a reason to probe; otherwise probe when
    // precision is low (thetaSe(precision) is wide).
    const probeHere = thetaPrecision === null ? true : thetaPrecision < LOW_PRECISION_THRESHOLD;
    cells.push({
      key,
      cause_category: cell.cause_category,
      knowledge_id: cell.knowledge_id,
      recurrence_count: cell.attemptIds.size,
      evidence_event_ids: [...cell.attemptIds.keys()],
      theta_hat: thetaHat,
      theta_precision: thetaPrecision,
      baseline_p: baselineP,
      probe_here: probeHere,
      has_owner_cause: cell.hasOwnerCause,
      has_contested_verdict: cell.hasContestedVerdict,
    });
  }

  // Salience-first deterministic order: recurrence DESC, probe_here first, key ASC.
  cells.sort(
    (a, b) =>
      b.recurrence_count - a.recurrence_count ||
      Number(b.probe_here) - Number(a.probe_here) ||
      a.key.localeCompare(b.key),
  );
  return cells;
}
