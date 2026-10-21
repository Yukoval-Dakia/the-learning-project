// Compatibility reader for review-plan sections.
// write_review_plan historically parked the structured plan in
// tool_state.session_meta.sections. Current writes promote sections[] to the top level of
// tool_state while keeping the session_meta copy during the transition, so consumers must
// accept both shapes without branching on era.
// The legacy path can go once no session_meta-only paper remains.

import type { ToolStateSectionT } from '@/core/schema/business';

export type ToolStateLike =
  | {
      question_ids?: string[];
      sections?: ToolStateSectionT[] | null;
      session_meta?: { sections?: unknown } | null | Record<string, unknown>;
    }
  | null
  | undefined;

// Legacy ReviewPlanSection shape as written by write_review_plan. knowledge_ids (not
// knowledge_focus), feedback_policy/adaptation_policy are unknown/optional. Must be
// normalized before returning as ToolStateSectionT.
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
 * Normalize a legacy session_meta section into the current ToolStateSectionT shape.
 * The field mapping mirrors toToolStateSections: knowledge_ids → knowledge_focus.
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
 * Resolve the section list for a paper, preferring top-level `sections` and falling back
 * to legacy `session_meta.sections`; [] when neither is present (a flat quiz). Legacy
 * sections are normalized before use; top-level sections are already current.
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

/**
 * Count the paper's canonical answerable slots. Structured papers key a slot by
 * question + part; legacy flat quizzes fall back to their question_ids list.
 * Kept beside readPaperSections so the shelf and stream projections cannot drift.
 */
export function countPaperSlots(toolState: ToolStateLike): number {
  const slotKeys = new Set<string>();
  for (const section of readPaperSections(toolState)) {
    for (const assignment of section.assignments) {
      slotKeys.add(`${assignment.question_id}::${assignment.part_ref ?? ''}`);
    }
  }
  return slotKeys.size > 0 ? slotKeys.size : (toolState?.question_ids?.length ?? 0);
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
 * tool_state. Returns the resolved knowledge and the owning section's feedback_policy so
 * the submit handler can FSRS-key on the primary knowledge and apply the visibility gate
 * server-side; the client never supplies these.
 *
 * Flat-quiz fallback: when there are no structured sections, accept any question_id from
 * tool_state.question_ids. primaryKnowledgeId is null so submitPaperSlot uses the
 * question-keyed FSRS path, and feedbackPolicy defaults to 'immediate'.
 *
 * Returns null only when the slot is not in the plan, so a structurally invalid request
 * receives a 400 rather than being silently skipped.
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

  // Flat-quiz fallback: no structured sections but the question is in the plan.
  // Atomic only (partRef must be null) — flat quizzes have no composite parts.
  const qids = Array.isArray(toolState?.question_ids) ? toolState.question_ids : [];
  if (target === null && qids.includes(questionId)) {
    return {
      questionId,
      partRef: null,
      primaryKnowledgeId: null, // question-keyed FSRS fallback
      secondaryKnowledgeIds: [],
      feedbackPolicy: 'immediate',
    };
  }

  return null;
}
