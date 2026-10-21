/**
 * Cold start means no usable learning evidence exists, not merely no active goal.
 * This is the single server-side decision point, so the UI does not build a drifting copy.
 */
export interface ColdStartEvidence {
  active_goal: boolean;
  goal_history: boolean;
  knowledge: boolean;
  question: boolean;
  source_material: boolean;
  artifact: boolean;
  review_due: boolean;
  pending_attribution: boolean;
  practice_stream: boolean;
  proposal: boolean;
  learning_session: boolean;
  user_event: boolean;
}

export interface ColdStartState {
  is_empty: boolean;
  evidence: ColdStartEvidence;
}

export function buildColdStartState(evidence: ColdStartEvidence): ColdStartState {
  return {
    is_empty: !Object.values(evidence).some(Boolean),
    evidence,
  };
}
