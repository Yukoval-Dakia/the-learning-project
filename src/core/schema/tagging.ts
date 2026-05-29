/**
 * TaggingTask + WorkflowJudge schemas — T-OC slice 3 (YUK-145, OC-4).
 *
 * See `docs/superpowers/specs/2026-05-29-t-oc-ocr-rebuild-design.md` (OC-4) +
 * `docs/superpowers/plans/2026-05-30-yuk145-toc-slice3-lane.md` + ADR-0026.
 *
 * TaggingTask is a single-shot structured-output AI task (NOT multimodal): it
 * looks at an extracted question's text + an optional knowledge_hint + a
 * knowledge-grid snapshot, and suggests which knowledge_ids the question covers,
 * each with a confidence. These are pure I/O contracts; the runtime invoker
 * lives in `src/server/ingestion/tagging.ts` and the route decision in
 * `src/server/ingestion/workflow-judge.ts`.
 */
import { z } from 'zod';

import { QuestionKind } from './business';

// ---------- TaggingTask input (what the LLM receives) ----------

/** One knowledge-grid node the tagger may choose from (anti-hallucination). */
export const TaggingGridNode = z.object({
  id: z.string().min(1),
  name: z.string(),
  /** Hierarchy path (root → leaf names) for disambiguation. */
  path: z.array(z.string()).default([]),
});
export type TaggingGridNodeT = z.infer<typeof TaggingGridNode>;

/** One typed mesh edge for relational context (prerequisite / contrasts_with…). */
export const TaggingGridEdge = z.object({
  from_knowledge_id: z.string().min(1),
  to_knowledge_id: z.string().min(1),
  relation_type: z.string().min(1),
});
export type TaggingGridEdgeT = z.infer<typeof TaggingGridEdge>;

export const TaggingInput = z.object({
  /** The extracted question text (derived from question_block.structured). */
  question_md: z.string().min(1),
  /** Soft hint carried from extraction (question_block.knowledge_hint). */
  knowledge_hint: z.string().nullable().default(null),
  /** The candidate knowledge grid the tagger MUST pick ids from. */
  grid: z.object({
    nodes: z.array(TaggingGridNode),
    edges: z.array(TaggingGridEdge).default([]),
  }),
});
export type TaggingInputT = z.infer<typeof TaggingInput>;

// ---------- TaggingTask output (the LLM's structured JSON) ----------

export const TaggingSuggestion = z.object({
  /** MUST be one of grid.nodes[].id — invented ids are filtered out by the invoker. */
  knowledge_id: z.string().min(1),
  /** Per-suggestion confidence 0..1. */
  confidence: z.number().min(0).max(1),
  reasoning: z.string().default(''),
});
export type TaggingSuggestionT = z.infer<typeof TaggingSuggestion>;

export const TaggingOutput = z.object({
  suggestions: z.array(TaggingSuggestion).default([]),
  /** Overall confidence in the tagging as a whole (gates the WorkflowJudge). */
  overall_confidence: z.number().min(0).max(1),
  reasoning: z.string().default(''),
});
export type TaggingOutputT = z.infer<typeof TaggingOutput>;

// ---------- WorkflowJudge output (deterministic single-pass aggregate) ----------
//
// WorkflowJudge is NOT a second LLM (spec §7 Q1 — single-user, YAGNI). It is a
// deterministic aggregator over extraction_confidence (from extraction) +
// TaggingTask confidence, producing a route decision + prefilled fields the
// auto-enroll path consumes. See src/server/ingestion/workflow-judge.ts.

export const WorkflowJudgeRoute = z.enum(['auto', 'review']);
export type WorkflowJudgeRouteT = z.infer<typeof WorkflowJudgeRoute>;

/**
 * The fields the auto-enroll path prefills when routing 'auto'. `outcome`
 * defaults to 'unanswered' (item/material) — the SAFEST signal: a captured exam
 * question with no graded answer is item-bank, never a fabricated attempt. The
 * full outcome-judging (grading the handwritten answer) is out of slice-3 scope.
 */
export const WorkflowJudgePrefilled = z.object({
  knowledge_ids: z.array(z.string().min(1)),
  outcome: z.enum(['failure', 'success', 'partial', 'unanswered']),
  difficulty: z.number().int().min(1).max(5),
  question_kind: QuestionKind,
});
export type WorkflowJudgePrefilledT = z.infer<typeof WorkflowJudgePrefilled>;

export const WorkflowJudgeResult = z.object({
  route: WorkflowJudgeRoute,
  /** Combined confidence (weakest-link of extraction + tagging). */
  confidence: z.number().min(0).max(1),
  prefilled: WorkflowJudgePrefilled,
  reasoning: z.string().default(''),
});
export type WorkflowJudgeResultT = z.infer<typeof WorkflowJudgeResult>;
