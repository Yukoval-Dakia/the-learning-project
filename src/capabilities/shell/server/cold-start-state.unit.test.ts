import { describe, expect, it } from 'vitest';
import { type ColdStartEvidence, buildColdStartState } from './cold-start-state';

const EMPTY_EVIDENCE: ColdStartEvidence = {
  active_goal: false,
  goal_history: false,
  knowledge: false,
  question: false,
  source_material: false,
  artifact: false,
  review_due: false,
  pending_attribution: false,
  practice_stream: false,
  proposal: false,
  learning_session: false,
  user_event: false,
};

describe('buildColdStartState', () => {
  it('只在所有学习证据都不存在时判为空', () => {
    expect(buildColdStartState(EMPTY_EVIDENCE)).toEqual({
      is_empty: true,
      evidence: EMPTY_EVIDENCE,
    });
  });

  it.each(Object.keys(EMPTY_EVIDENCE) as Array<keyof ColdStartEvidence>)(
    '%s 单一证据也足以退出冷启动',
    (signal) => {
      const evidence = { ...EMPTY_EVIDENCE, [signal]: true };
      expect(buildColdStartState(evidence).is_empty).toBe(false);
    },
  );
});
