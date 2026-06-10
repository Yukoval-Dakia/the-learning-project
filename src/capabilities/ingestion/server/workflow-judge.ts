/**
 * WorkflowJudge — T-OC slice 3 (YUK-145, OC-4).
 *
 * See `docs/superpowers/specs/2026-05-29-t-oc-ocr-rebuild-design.md` (OC-4) +
 * `docs/superpowers/plans/2026-05-30-yuk145-toc-slice3-lane.md` §6 + ADR-0026.
 *
 * Per spec §7 Q1 + §8 (single-user → YAGNI), this is a DETERMINISTIC single-pass
 * confidence aggregator, NOT a second LLM / multi-agent vote. It combines the
 * extraction confidence (from extraction) with the TaggingTask confidence and
 * decides whether a captured block can be auto-enrolled (high confidence) or must
 * fall through to the existing human review (low confidence / no suggestions).
 *
 * The combined confidence is the WEAKEST LINK — `min(extraction, tagging)` — so
 * either a shaky structure OR a shaky tagging forces human review. Conservative
 * by construction; the threshold itself is configurable
 * (workflow-judge-config.ts) and the whole auto path is OFF by default.
 */
import type { z } from 'zod';

import type { QuestionKind } from '@/core/schema/business';
import type { TaggingOutputT, WorkflowJudgeResultT } from '@/core/schema/tagging';

type QuestionKindT = z.infer<typeof QuestionKind>;

export interface RunWorkflowJudgeInput {
  /** question_block.extraction_confidence (0..1). Always 1.0 from extraction. */
  extractionConfidence: number;
  /** TaggingTask output for this block (already grid-filtered by the invoker). */
  tagging: TaggingOutputT;
  /** Route 'auto' only when combined confidence >= this (autoEnrollThreshold). */
  threshold: number;
  /**
   * Default difficulty for the prefilled question (1-5). The route is deferred
   * difficulty-judging out of scope; the import default is 3.
   */
  defaultDifficulty?: number;
  /**
   * Default question_kind for the prefilled question. Slice 3 does not run a
   * kind classifier (DEFERRED); callers pass the subject's safe default.
   */
  defaultQuestionKind?: QuestionKindT;
}

/**
 * Runs the deterministic WorkflowJudge. Returns the route decision + the fields
 * the auto-enroll path prefills when routing 'auto'.
 *
 * `outcome` is always `'unanswered'` (item/material) — the SAFEST signal: a
 * captured exam question with no graded answer is item-bank, never a fabricated
 * attempt. Grading the handwritten answer to produce success/partial/failure is
 * a separate EnrollTask (spec §3) DEFERRED beyond slice 3.
 */
export function runWorkflowJudge(input: RunWorkflowJudgeInput): WorkflowJudgeResultT {
  const extraction = clamp01(input.extractionConfidence);
  const tagging = clamp01(input.tagging.overall_confidence);
  // Weakest-link: the route is only as confident as its shakiest input.
  const confidence = Math.min(extraction, tagging);

  const knowledgeIds = input.tagging.suggestions.map((s) => s.knowledge_id);
  const hasSuggestions = knowledgeIds.length > 0;

  // 'auto' requires BOTH: combined confidence over the bar AND at least one
  // surviving knowledge suggestion (nothing to enroll against otherwise).
  const route: WorkflowJudgeResultT['route'] =
    confidence >= input.threshold && hasSuggestions ? 'auto' : 'review';

  const reasoning =
    route === 'auto'
      ? `auto: combined confidence ${confidence.toFixed(2)} >= ${input.threshold} with ${knowledgeIds.length} knowledge suggestion(s)`
      : !hasSuggestions
        ? 'review: no surviving knowledge suggestions'
        : `review: combined confidence ${confidence.toFixed(2)} < ${input.threshold}`;

  return {
    route,
    confidence,
    prefilled: {
      knowledge_ids: knowledgeIds,
      // unanswered = item/material; see fn doc. No fabricated attempt.
      outcome: 'unanswered',
      difficulty: clampDifficulty(input.defaultDifficulty ?? 3),
      question_kind: input.defaultQuestionKind ?? 'reading',
    },
    reasoning,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function clampDifficulty(value: number): number {
  const n = Math.round(Number.isFinite(value) ? value : 3);
  return Math.min(5, Math.max(1, n));
}
