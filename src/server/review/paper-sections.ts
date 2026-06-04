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

/**
 * Resolve the section list for a paper, preferring the U5 top-level `sections`
 * and falling back to the U4 `session_meta.sections`. Returns [] when neither
 * is present (a flat quiz with no structured plan).
 *
 * Note: this returns the raw stored shape (already Zod-parsed when read via
 * Artifact.parse(); the session_meta fallback is a loose record). Callers that
 * need the validated ToolStateSection shape should parse the result.
 */
export function readPaperSections(toolState: ToolStateLike): ToolStateSectionT[] {
  if (!toolState) return [];
  if (Array.isArray(toolState.sections) && toolState.sections.length > 0) {
    return toolState.sections;
  }
  const meta = toolState.session_meta as { sections?: unknown } | null | undefined;
  const metaSections = meta?.sections;
  if (Array.isArray(metaSections)) {
    return metaSections as ToolStateSectionT[];
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
