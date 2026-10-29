// Calibration-sample unit seam: the only proof the DB lane cannot reach — the
// shared judge entry's classification of unsupported and unknown-score partial
// faces. Every other contract (gate, operation, staged core, shared store) is
// proven on real Postgres by calibration-sample-durable-operation.db.test.ts.

import { describe, expect, it, vi } from 'vitest';

import { db } from '@/db/client';
import { writeEvent } from '@/kernel/events';
import { mathProfile } from '@/subjects/math/profile';
import { type CalibrationWorkSetItem } from './calibration-sample-durable-operation';
import { judgeAnswer, unsupportedResult } from './judge/question-contract';
import type {
  JudgeCalibrationConfig,
  JudgeCalibrationRejudgeFace,
} from './judge-calibration-sample-core';

vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/kernel/events', () => ({ writeEvent: vi.fn() }));

const CFG: JudgeCalibrationConfig = {
  rejudgeProvider: 'anthropic-sub',
  rejudgeModel: 'claude-opus-4-8',
  batchMax: 5,
  windowDays: 7,
};

const FROZEN_QUESTION: JudgeCalibrationRejudgeFace['question'] = {
  id: 'q_1',
  kind: 'short_answer',
  prompt_md: '两件同价商品总计84元，求单件价格并解释方程与单位。'.repeat(30),
  reference_md: '设单件价格为x元，则2x=84，因此x=42元。'.repeat(30),
  rubric_json: {
    criteria: [{ name: 'equation', weight: 1, descriptor: '两件总价与单件价格对应' }],
    required_points: ['2x=84', '42元'],
  },
  choices_md: null,
  judge_kind_override: null,
  knowledge_ids: ['k_math_1', 'k_math_2'],
  metadata: { source_context: { ambiguity: ['总价不是单价'], paragraphs: ['条件', '推导'] } },
};

const ITEM: CalibrationWorkSetItem = {
  judgeEventId: 'evt_judge_1',
  answerEventId: 'evt_answer_1',
  questionId: 'q_1',
  judgeRoute: 'judge.v2.open',
  priorOutcome: 'correct',
  answerMd: '一段足够长的历史作答文本，含嵌套结构与边界情况',
  studentImageRefs: [],
  question: FROZEN_QUESTION,
  subjectProfile: structuredClone(mathProfile),
  judgeCreatedAt: '2026-10-10T08:00:00.000Z',
};

const semanticText = JSON.stringify({
  score: 0.5,
  coarse_outcome: 'partial',
  confidence: 0.8,
  feedback_md: '方程正确，但需要说明单件单位。'.repeat(30),
  evidence_json: { matched_points: ['2x=84'], missing_points: ['单位'] },
});

describe('released core seams (real exports, no DB)', () => {
  // @invariant data: unsupported and unknown-score partials cannot become calibration observations
  // @fails-if extraction loses either skip condition; the shared entry returns a rejudged outcome
  it('classifies unsupported and unknown-score partials without manufacturing a judged receipt', async () => {
    const core = await import('./judge-calibration-sample-core');
    const judgeFn: typeof judgeAnswer = async () => ({
      route: 'semantic',
      modelAttempted: false,
      result: unsupportedResult('semantic', '无法评分', { reason: 'invalid_rubric' }),
    });
    expect(
      await core.judgeCalibrationPreparedFace(
        CFG,
        { ...ITEM, studentImageRefs: [...ITEM.studentImageRefs] },
        { db, judgeFn, runTaskInner: async () => ({ text: semanticText }) },
      ),
    ).toEqual({ kind: 'unsupported' });
    expect(
      await core.judgeCalibrationPreparedFace(
        CFG,
        { ...ITEM, studentImageRefs: [...ITEM.studentImageRefs] },
        {
          db,
          judgeFn: async (input) => {
            const invoked = await judgeFn(input);
            return {
              ...invoked,
              result: {
                ...invoked.result,
                coarse_outcome: 'partial_unknown',
                score: null,
                partial_units: [{ scoring_unit_id: 'u_match', correct_count: 2, total_count: 3 }],
              },
            };
          },
          runTaskInner: async () => ({ text: semanticText }),
        },
      ),
    ).toEqual({ kind: 'unsupported' });
    expect(writeEvent).not.toHaveBeenCalled();
  });
});
