// ADR-0038 决定#2 — plan-then-generate: Phase-1 plan artifact + machine gate.
//
// docs/adr/0038-unified-verify-contract-plan-then-generate.md 决定#2 first bullet:
// quiz generation runs in TWO phases — first a question PLAN (which knowledge
// point, what kind, and for objective kinds the standard-answer anchor) as a
// machine-checkable artifact, then the question faces generated FROM the accepted
// plan. This module is the deterministic half: it parses the plan LLM output into
// the strict QuizGenPlan schema and validates it against the run's pins and the
// REAL knowledge graph (the caller reads live node ids — this module stays pure
// so the unit car can exercise it without a DB).
//
// A rejected plan regenerates (bounded, with the rejection reasons fed back) or
// fails closed — it must never proceed to generation.

import { QUIZ_PLAN_OBJECTIVE_KINDS, QuizGenPlan, type QuizGenPlanT } from '@/core/schema/quiz_gen';
import { parseJsonObjectLoose } from '@/server/ai/json-extract';
import { kindsMatch } from '@/subjects/question-kind';

// Bounded regeneration budget for the plan phase (initial attempt + 1 retry).
// Keep small: every attempt is a paid LLM call, and a persistently invalid plan
// means the run fails closed regardless.
export const QUIZ_PLAN_MAX_ATTEMPTS = 2;

// The supply-side pins the plan must honour (mirrors RunQuizGenParams' kind /
// method fields — the 找题次序's hard constraints move up from persist-time to
// plan-gate time so a violating plan is rejected BEFORE burning the generation call).
export interface PlanGatePins {
  kind?: string;
  kindRequired?: boolean;
  objectiveOnly?: boolean;
  generationMethod?: 'material_grounded' | 'closed_book';
}

export type PlanParseResult = { ok: true; plan: QuizGenPlanT } | { ok: false; reasons: string[] };

// Lenient extract + strict schema parse (mirrors the quiz_gen parseOutput repair
// belt — mimo emits the same unescaped-quote failure class on plan outputs).
// Never throws: a parse failure is a gate rejection with reasons, so the retry
// loop treats it exactly like a semantic rejection.
export function parsePlanOutput(text: string): PlanParseResult {
  let extracted: ReturnType<typeof parseJsonObjectLoose>;
  try {
    extracted = parseJsonObjectLoose(text, 'quiz_plan parseOutput');
  } catch (e) {
    return {
      ok: false,
      reasons: [`quiz_plan parseOutput: JSON.parse failed: ${(e as Error).message}`],
    };
  }
  if (extracted === null) {
    return { ok: false, reasons: ['quiz_plan parseOutput: no JSON object found in text'] };
  }
  const parsed = QuizGenPlan.safeParse(extracted.json);
  if (!parsed.success) {
    return {
      ok: false,
      reasons: [
        `quiz_plan schema invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      ],
    };
  }
  return { ok: true, plan: parsed.data };
}

// Deterministic pin conformance. Same vocabulary normalization as the persist-time
// checks (kindsMatch: 'calculation' pin ↔ 'computation' plan, etc.), so the plan
// gate and the persist gate can never disagree on what matches.
export function checkPlanPins(plan: QuizGenPlanT, pins: PlanGatePins): string[] {
  const reasons: string[] = [];
  const kindPinned = (pins.kindRequired || pins.objectiveOnly) && pins.kind;
  plan.items.forEach((item, index) => {
    if (kindPinned && !kindsMatch(item.kind, pins.kind as string)) {
      const constraint = pins.objectiveOnly ? 'objective-only' : 'required';
      reasons.push(
        `quiz_plan item ${index + 1} plans kind '${item.kind}' which does not match ${constraint} kind '${pins.kind}'`,
      );
    }
  });
  if (pins.generationMethod && plan.generation_method !== pins.generationMethod) {
    // The 找题次序 pin is a hard tier constraint: the generation-phase assertion
    // already rejects a wrong-tier OUTPUT, so the gate rejects a wrong-tier PLAN
    // before the generation call can burn on it. An UNPINNED run keeps free choice.
    reasons.push(
      `quiz_plan plans generation_method '${plan.generation_method}' but the run pins '${pins.generationMethod}'`,
    );
  }
  return reasons;
}

// Real knowledge-point existence: every planned knowledge_id must be a live,
// unarchived node. The caller passes the live id set it read from the knowledge
// table (same filter as the persist-time attribution guard).
export function checkPlanKnowledgeIds(
  plan: QuizGenPlanT,
  liveKnowledgeIds: ReadonlySet<string>,
): string[] {
  const reasons: string[] = [];
  plan.items.forEach((item, index) => {
    if (!liveKnowledgeIds.has(item.knowledge_id)) {
      reasons.push(
        `quiz_plan item ${index + 1} targets unknown or archived knowledge_id '${item.knowledge_id}'`,
      );
    }
  });
  return reasons;
}

// Anchor sanity is schema-level (objective kinds require a non-empty
// answer_anchor — QuizGenPlanItem.superRefine). Re-exposed for consumers that
// want the objective-kind predicate without importing the schema internals.
export { QUIZ_PLAN_OBJECTIVE_KINDS };
