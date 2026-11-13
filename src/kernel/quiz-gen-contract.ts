import type { DifficultyBand, SupplyTraceV1T } from './supply-contracts';

// quiz_gen job payload contract, owned by the kernel: the producer path
// (capabilities/practice supply dispatcher) and the pg-boss send/jobs surfaces
// (kernel/placement-jobs, the quiz_gen handler) all read the same type without a
// kernel -> capability reverse re-export.

// §3 / §4 — the trigger surface. 'manual' carries a free-form ref_id (we still
// try to resolve it as a knowledge node for the subject profile, but never skip
// the run on a manual trigger). 'knowledge' / 'learning_item' resolve a real row.
export const QUIZ_GEN_TRIGGERS = ['knowledge', 'learning_item', 'manual'] as const;
export type QuizGenTrigger = (typeof QUIZ_GEN_TRIGGERS)[number];

export interface QuizGenJobData {
  trigger: QuizGenTrigger;
  ref_id: string;
  count?: number;
  exact_count?: number;
  placement_starter_claim_id?: string;
  semantic_goal_revision_id?: string;
  // YUK-226 S2-5b F1 — the §3.2 找题次序 pins which tier it asked for (step 3
  // material_grounded vs step 4 closed_book). Absent on a bare manual quiz_gen
  // trigger, in which case the agent free-chooses the method as before.
  generation_method?: 'material_grounded' | 'closed_book';
  // YUK-226 S2-5b F3 — the knowledge node a manual/free-form trigger should attribute
  // produced questions to (the next 找题次序 round keys off this node's pool).
  knowledge_id?: string;
  // YUK-226 S2-5b F4 — the 题型 hint the次序 selected this line for (additive). Threaded
  // into the QuizGenTask input so the agent can target the题型.
  kind?: string;
  objective_only?: boolean;
  kind_required?: boolean;
  // YUK-287 — the supply target's difficulty band (below|near|above|stretch, relative
  // to learner θ̂). Forwarded as requested_difficulty_band into plan/generate inputs so
  // a band-gap target produces band-aimed questions instead of generic difficulty.
  difficulty_band?: DifficultyBand;
  // Inclusive 1–5 span already inverted from `difficulty_band` at the learner's θ̂.
  // null = no ordinal sits in the band. Absent = legacy payload (handler uses θ̂ = 0).
  difficulty_levels?: { min: number; max: number } | null;
  // YUK-287 forwarded this 篇 (composite parent) pin phase-deferred; YUK-1011
  // consumes it: the run produces composite questions (stem+sub_questions
  // structured tree persisted on the parent + question_part child rows).
  composite_parent_only?: boolean;
  // YUK-533 — the full KC set a multi-KC supply target carries (the confusable A↔B pair).
  // knowledge_id stays the PRIMARY attribution anchor (knowledgeIds[0]); knowledge_ids
  // carries the whole pair so a contrast/discrimination item can probe the A-vs-B boundary.
  // The dispatcher forwards it for any multi-KC target that routes to quiz_gen; the handler
  // does not yet read it (contrast-aware generation is not built).
  knowledge_ids?: string[];
  supply_trace?: SupplyTraceV1T;
}
