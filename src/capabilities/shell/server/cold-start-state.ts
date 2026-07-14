/**
 * 冷启动不是「没有 active goal」的同义词，而是所有可继续学习的证据都不存在。
 * 这个纯函数是服务端 wire 的唯一判定点，避免 UI 再拼一套易漂移的条件。
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
