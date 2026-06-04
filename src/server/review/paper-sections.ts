// U5 (YUK-203) — U4 forward-compat read shim (§4.8).
//
// U4's `write_review_plan` parked the structured plan inside
// `tool_state.session_meta.sections`. U5 promotes `sections[]` to the top level
// of `tool_state` (ToolStateT v2, §4.3) at write time AND keeps the session_meta
// copy during the transition window. This shim reads BOTH shapes uniformly so a
// paper consumer doesn't branch on era.
//
// Removal trigger: when no U4-era (session_meta-only) paper remains, i.e. after
// the artifact scan window rolls past the U4 merge date.

import type { ToolStateSectionT } from '@/core/schema/business';

type ToolStateLike =
  | {
      question_ids?: string[];
      sections?: ToolStateSectionT[] | null;
      session_meta?: { sections?: unknown } | null | Record<string, unknown>;
    }
  | null
  | undefined;

// U4 ReviewPlanSection shape as written by write_review_plan (review-plan-tools.ts).
// knowledge_ids (not knowledge_focus), feedback_policy/adaptation_policy are
// unknown/optional. Must be normalized before returning as ToolStateSectionT.
type U4Section = {
  knowledge_ids?: string[];
  feedback_policy?: unknown;
  adaptation_policy?: unknown;
  assignments?: Array<{
    question_id?: string;
    part_ref?: string;
    primary_knowledge_id?: string;
    secondary_knowledge_ids?: string[];
    selection_reason?: string;
    review_profile_snapshot?: unknown;
  }>;
};

/**
 * Normalize a U4 session_meta section (ReviewPlanSection shape) into the
 * promoted U5 ToolStateSectionT shape. Field mapping mirrors toToolStateSections
 * in review-plan-tools.ts: knowledge_ids → knowledge_focus, with safe defaults.
 */
function normalizeU4Section(raw: U4Section): ToolStateSectionT {
  return {
    knowledge_focus: Array.isArray(raw.knowledge_ids) ? raw.knowledge_ids : [],
    feedback_policy: typeof raw.feedback_policy === 'string' ? raw.feedback_policy : 'immediate',
    adaptation_policy: typeof raw.adaptation_policy === 'string' ? raw.adaptation_policy : 'none',
    assignments: Array.isArray(raw.assignments)
      ? raw.assignments.map((a) => ({
          question_id: a.question_id ?? '',
          ...(a.part_ref !== undefined ? { part_ref: a.part_ref } : {}),
          primary_knowledge_id: a.primary_knowledge_id ?? '',
          secondary_knowledge_ids: Array.isArray(a.secondary_knowledge_ids)
            ? a.secondary_knowledge_ids
            : [],
          selection_reason: a.selection_reason ?? '',
          review_profile_snapshot:
            a.review_profile_snapshot && typeof a.review_profile_snapshot === 'object'
              ? (a.review_profile_snapshot as Record<string, unknown>)
              : {},
        }))
      : [],
  };
}

/**
 * Resolve the section list for a paper, preferring the U5 top-level `sections`
 * and falling back to the U4 `session_meta.sections`. Returns [] when neither
 * is present (a flat quiz with no structured plan).
 *
 * The session_meta legacy path NORMALIZES the U4 ReviewPlanSection shape
 * (knowledge_ids → knowledge_focus, etc.) before returning. Top-level sections
 * are already in the promoted U5 shape and returned as-is.
 */
export function readPaperSections(toolState: ToolStateLike): ToolStateSectionT[] {
  if (!toolState) return [];
  if (Array.isArray(toolState.sections) && toolState.sections.length > 0) {
    return toolState.sections;
  }
  const meta = toolState.session_meta as { sections?: unknown } | null | undefined;
  const metaSections = meta?.sections;
  if (Array.isArray(metaSections)) {
    return (metaSections as U4Section[]).map(normalizeU4Section);
  }
  return [];
}

export interface ResolvedSlotAssignment {
  questionId: string;
  partRef: string | null;
  primaryKnowledgeId: string | null;
  secondaryKnowledgeIds: string[];
  /** the owning section's feedback_policy (drives the visibility gate) */
  feedbackPolicy: string | null;
}

/**
 * Find the assignment for a slot (question_id + optional part_ref) in a paper's
 * tool_state. Returns the resolved knowledge + the owning section's
 * feedback_policy so the paper submit handler can FSRS-key on the primary
 * knowledge and apply the visibility gate server-side (the client never supplies
 * these — they come from the auditable plan). Returns null when the slot is not
 * in the plan.
 */
export function resolveSlotAssignment(
  toolState: ToolStateLike,
  questionId: string,
  partRef?: string | null,
): ResolvedSlotAssignment | null {
  const target = partRef ?? null;
  for (const section of readPaperSections(toolState)) {
    for (const a of section.assignments) {
      if (a.question_id === questionId && (a.part_ref ?? null) === target) {
        return {
          questionId,
          partRef: target,
          primaryKnowledgeId: a.primary_knowledge_id ?? null,
          secondaryKnowledgeIds: a.secondary_knowledge_ids ?? [],
          feedbackPolicy: section.feedback_policy ?? null,
        };
      }
    }
  }
  return null;
}
