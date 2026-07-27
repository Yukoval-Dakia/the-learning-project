// YUK-406 Phase 0 (关系脑 thin slice) — deterministic 取证 (NO LLM).
//
// Aggregates recent failure attempts into (cause_category × knowledge_id) "cells"
// that are candidate CONJECTURES about how the owner thinks. PURE function: the
// caller (research_meeting_nightly job) fetches FailureAttempt[] via
// getFailureAttempts({ since }) and a per-knowledge mastery projection, then hands
// them in. No DB import here so the recurrence/salience math stays unit-testable in
// isolation (mirrors the DepsOverride injection pattern across the agency jobs).
//
// Two gates keep one-off noise out of the surface:
//   - recurrence floor (>= 2 distinct attempts for a cell), and
//   - dedup against already-raised conjecture keys (knownConjectureKeys — for the
//     MVP these are the keys of currently-pending conjecture proposals, so the same
//     cause × KC is not re-proposed while one is still open).
//
// A13 (YUK-440) accountability seam woven in: each cell snapshots `baseline_p` =
// the learner's PFA mastery p(L) for the KC (getMasteryProjection.mastery). The job
// stamps it onto the conjecture as `baseline_p_at_induction` — the number the
// qualitative claim must later beat (scoring/flip is DEFERRED per ADR-0046; the cell
// only carries the snapshot).

import type { CauseCategoryT, CauseSchemaT } from '@/core/schema/event/blocks';
import type { BBoxT, FigureRefT } from '@/core/schema/structured_question';

/** A conjecture must recur across at least this many distinct failure attempts. */
export const CONJECTURE_RECURRENCE_FLOOR = 2;

/**
 * theta_precision below this ⇒ wide SE (thetaSe = 1/√precision) ⇒ low confidence in
 * the θ̂ point estimate ⇒ "probe here". DEFAULT precision is 1 at cold start (a weak
 * 1-unit prior, SE = 1), so a KC barely observed sits below the threshold and is
 * flagged. Placeholder scale until fixed-anchor calibration (ADR-0043); 1.5 ≈ SE 0.82,
 * i.e. flag anything not yet firmly pinned.
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
  /** provenance — the attempt event ids, in first-seen order (→ evidence_refs). */
  evidence_event_ids: string[];
  /** θ̂ for this KC, or null when no mastery row exists (cold start). */
  theta_hat: number | null;
  /** Cumulative Fisher information for θ̂, or null on cold start. */
  theta_precision: number | null;
  /**
   * A13 (YUK-440) baseline: PFA mastery p(L) for this KC (getMasteryProjection.mastery),
   * or null on cold start. The job snapshots this as the conjecture's
   * `baseline_p_at_induction` — the number the qualitative claim must later beat.
   */
  baseline_p: number | null;
  /** true ⇒ low-precision (or unknown) KC: a good place to spend the one probe. */
  probe_here: boolean;
  /** true iff any contributing attempt has an owner-supplied (source:'user') cause. */
  has_owner_cause: boolean;
}

// ── YUK-786 grounding packet ────────────────────────────────────────────────
//
// An EvidenceCell alone is 7 opaque scalars (UUIDs / an enum / numbers): zero
// natural language, zero subject identity. The induction prompt nevertheless
// asks for a DOMAIN-SPECIFIC claim + a whole discriminating question + its
// machine-grading gold reference — so the model had no grounded way to produce
// one and invented the subject. These types carry the first-hand evidence that
// `gatherConjectureEvidence`'s upstream (FailureAttempt) already had and threw
// away when it folded attempts into a cell.
//
// The TYPES live here (this module stays PURE — no DB import); the db-reading
// builder lives in the `enrich` sibling and is called by the nightly job's
// PRE-LLM read stage.

/**
 * One representative failure attempt behind a cell, in the shape the LLM sees.
 * Every learner-authored / question-authored free-text field is already
 * truncated + wrapped in `<untrusted_learner_text>` by the enrich step — the
 * strings here are DATA, never instruction.
 */
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
   * truncated), or null when the question has none. Without it the packet shows
   * what was asked and what the owner wrote but not what "right" was, so the
   * deviation the claim is supposed to be ABOUT is not reconstructable.
   */
  question_reference_md: string | null;
  /** question.choices_md — the complete choice set (each item wrapped + truncated). */
  question_choices_md: string[] | null;
  /** First-class simple image refs for the question, copied from the DB row. */
  question_image_refs: string[];
  /** Structured figure refs for the question, projected to an immutable prompt-safe shape. */
  question_figures: ConjectureEvidenceFigure[];
  /** question_part parent id, or null for a standalone question. */
  parent_question_id: string | null;
  /** parent prompt/shared passage needed to interpret a question_part. */
  parent_question_prompt_md: string | null;
  /** parent reference answer, when present. */
  parent_question_reference_md: string | null;
  /** parent choices, when present (each item wrapped + truncated). */
  parent_question_choices_md: string[] | null;
  /** Parent question image refs, copied from the DB row. */
  parent_question_image_refs: string[];
  /** Parent structured figures, projected to an immutable prompt-safe shape. */
  parent_question_figures: ConjectureEvidenceFigure[];
  /** the learner's own wrong answer (wrapped + truncated). */
  answer_md: string | null;
  /** Image-only or image-bearing learner answer asset refs. */
  answer_image_refs: string[];
  /** YUK-562 process data: the learner's account of HOW they thought. */
  reasoning_trace: string | null;
  /** effective cause category for this attempt (owner cause wins over judge). */
  cause_category: CauseCategoryT | null;
  /** 'user' when the owner attributed it, 'agent' when the judge did. */
  cause_source: 'user' | 'agent' | null;
  /**
   * The written attribution. Both owner notes and upstream judge analysis are
   * generated outside the induction prompt, so enrich truncates and delimits them
   * as untrusted data.
   */
  cause_attribution_md: string | null;
}

/** The db-resolved context an {@link EvidenceCell} is missing. */
export interface EvidenceCellEnrichment {
  /** knowledge.name — human-readable, wrapped + truncated as untrusted text. */
  knowledge_name: string | null;
  /** canonical subject id resolved from knowledge.domain, or null when untagged. */
  subject_id: string | null;
  /** the subject's display name (e.g. 语文), or null when untagged. */
  subject_display_name: string | null;
  /**
   * Representative first-hand evidence samples, capped; may be empty when rows are missing.
   * On an enriched cell, `evidence_event_ids` / `recurrence_count` are narrowed to ALL
   * reproducible attempts even when only the first few samples carry prompt text.
   */
  samples: ConjectureEvidenceSample[];
}

/** An {@link EvidenceCell} carrying its grounding packet (YUK-786). */
export type EnrichedEvidenceCell = EvidenceCell & EvidenceCellEnrichment;

export type ConjectureEvidenceImageSource = 'question' | 'parent_question' | 'answer';

/**
 * One image occurrence in the stable multimodal packet order:
 * child question → shared parent question → learner answer, per sample.
 */
export interface ConjectureEvidenceAssetRef {
  asset_id: string;
  attempt_event_id: string;
  source: ConjectureEvidenceImageSource;
}

/**
 * One unique asset plus every evidence occurrence that points at it.
 *
 * The bytes are sent once per induction sample; `occurrences` preserves the semantic roles
 * without duplicating the same base64 block for every attempt/source pair.
 */
export interface LoadedConjectureEvidenceImage {
  asset_id: string;
  occurrences: Array<Omit<ConjectureEvidenceAssetRef, 'asset_id'>>;
  /** base64 without a data: prefix (the runner also accepts URL/Uint8Array). */
  data: string;
  mediaType: string;
}

/**
 * Collect image occurrences in the same order the model will receive them.
 * Figure refs and simple refs within one sample/source can point at the same asset, so that
 * occurrence is deduped. The same bytes in another attempt or semantic role remain separate
 * manifest entries; collapsing them would erase that the learner reused a question image in
 * their answer (or that the asset recurred across attempts).
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
 * Keep only fields conjecture evidence actually consumes. The job's legacy
 * `FailureAttempt` reader is structurally assignable to this contract, so the
 * agency domain stays independently testable without importing `@/server/*`.
 */
export interface ConjectureFailureAttempt {
  attempt_event_id: string;
  question_id: string;
  answer_md: string | null;
  answer_image_refs: string[];
  referenced_knowledge_ids: string[];
  created_at: Date;
  judge?: {
    cause: CauseSchemaT;
    created_at: Date;
  };
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
  /** Recent failure attempts (caller fetched via getFailureAttempts({ since })). */
  failures: ConjectureFailureAttempt[];
  /** knowledge_id → mastery projection (caller resolved via getMasteryProjection). */
  masteryByKnowledgeId: ReadonlyMap<string, ConjectureMasteryProjection>;
  /** dedup: conjectureKey(...) values already raised — skip these cells. */
  knownConjectureKeys: Set<string>;
}

interface CellAccumulator {
  cause_category: CauseCategoryT;
  knowledge_id: string;
  /** distinct attempt ids, insertion-ordered (Map preserves first-seen order). */
  attemptIds: Map<string, true>;
  hasOwnerCause: boolean;
}

export interface EffectiveConjectureCause {
  source: 'user' | 'agent';
  primary_category: CauseCategoryT;
  analysis_md: string | null;
  user_notes: string | null;
}

/**
 * Conjecture-local effective-cause projection: owner attribution wins over the
 * upstream judge. This deliberately mirrors the legacy read policy while
 * returning only the fields induction consumes.
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

  // 1. Fan each failure out across (effective cause_category × each referenced KC).
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
        } satisfies CellAccumulator);
      cell.attemptIds.set(failure.attempt_event_id, true); // Map ⇒ distinct, ordered
      if (isOwnerCause) cell.hasOwnerCause = true;
      acc.set(key, cell);
    }
  }

  // 2. Keep cells at/above the recurrence floor, skip already-known, attach mastery.
  const cells: EvidenceCell[] = [];
  for (const [key, cell] of acc) {
    if (cell.attemptIds.size < CONJECTURE_RECURRENCE_FLOOR) continue;
    if (knownConjectureKeys.has(key)) continue; // dedup against pending conjectures
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
    });
  }

  // 3. Salience-first deterministic order: recurrence DESC, probe_here first, key ASC.
  cells.sort(
    (a, b) =>
      b.recurrence_count - a.recurrence_count ||
      Number(b.probe_here) - Number(a.probe_here) ||
      a.key.localeCompare(b.key),
  );
  return cells;
}
