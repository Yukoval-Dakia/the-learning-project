// A9 (YUK-438) — step-grading θ wiring db tests.

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stepGradingFlag = { enabled: false };

vi.mock('@/capabilities/practice/server/step-grading-config', () => ({
  get STEP_GRADING_EVIDENCE_ENABLED() {
    return stepGradingFlag.enabled;
  },
  STEP_GRADING_JUDGE_CONFIDENCE_FLOOR: 0.5,
}));

import { newId } from '@/core/ids';
import type { JudgeResultV2T } from '@/core/schema/capability';
import { db } from '@/db/client';
import { item_calibration, knowledge, mastery_state, question } from '@/db/schema';
import { resetDb } from '../../../tests/helpers/db';
import { getMasteryState } from './state';
import {
  applyStepGradingThetaUpdates,
  isStepGradingJudgeCalibrated,
  updateThetaForAttemptWithOptionalStepGrading,
} from './step-grading-theta';

async function seedKnowledge(id: string) {
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: `K-${id}`,
    domain: 'math',
    parent_id: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

function stepsJudgeResult(
  verdicts: Array<'correct' | 'partial' | 'wrong' | 'skipped'>,
): JudgeResultV2T {
  return {
    score_meaning: 'steps_v1_weighted',
    coarse_outcome: 'partial',
    score: 0.5,
    confidence: 0.9,
    capability_ref: { id: 'steps', version: '1.0.0' },
    feedback_md: 'steps',
    evidence_json: {
      signal_verdicts: verdicts.map((verdict, signal_idx) => ({
        signal_idx,
        verdict,
        comment: '',
      })),
    },
  };
}

describe('isStepGradingJudgeCalibrated', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it('returns false without item_calibration row', async () => {
    const qid = newId();
    await seedKnowledge('kc1');
    const now = new Date();
    await db.insert(question).values({
      id: qid,
      prompt_md: 'p',
      kind: 'derivation',
      source: 'manual',
      difficulty: 3,
      knowledge_ids: ['kc1'],
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await db.transaction(async (tx) => {
      expect(await isStepGradingJudgeCalibrated(tx, qid)).toBe(false);
    });
  });

  it('returns true when hard-track calibration has b + confidence >= floor', async () => {
    const qid = newId();
    await seedKnowledge('kc1');
    const now = new Date();
    await db.insert(question).values({
      id: qid,
      prompt_md: 'p',
      kind: 'derivation',
      source: 'manual',
      difficulty: 3,
      knowledge_ids: ['kc1'],
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await db.insert(item_calibration).values({
      id: createId(),
      question_id: qid,
      b: 0.2,
      confidence: 0.6,
      track: 'hard',
      source: 'llm_prior',
      created_at: now,
      updated_at: now,
    });
    await db.transaction(async (tx) => {
      expect(await isStepGradingJudgeCalibrated(tx, qid)).toBe(true);
    });
  });
});

describe('applyStepGradingThetaUpdates', () => {
  beforeEach(async () => {
    await resetDb();
    stepGradingFlag.enabled = false;
  });
  afterEach(async () => {
    await resetDb();
    stepGradingFlag.enabled = false;
  });

  it('increments evidence_count once per rubric step', async () => {
    const kc = 'kc-step-mult';
    const qid = newId();
    await seedKnowledge(kc);
    const now = new Date();
    await db.insert(question).values({
      id: qid,
      prompt_md: 'p',
      kind: 'derivation',
      source: 'manual',
      difficulty: 3,
      knowledge_ids: [kc],
      created_at: now,
      updated_at: now,
      version: 0,
    });

    await db.transaction(async (tx) => {
      await applyStepGradingThetaUpdates(
        tx,
        {
          knowledgeIds: [kc],
          questionId: qid,
          difficulty: 3,
          attemptEventId: newId(),
          now,
        },
        [
          { signal_idx: 0, verdict: 'correct', continuousCredit: 1 },
          { signal_idx: 1, verdict: 'partial', continuousCredit: 0.5 },
          { signal_idx: 2, verdict: 'wrong', continuousCredit: 0 },
        ],
      );
    });

    const row = await getMasteryState(db, kc);
    expect(row?.evidence_count).toBe(3);
    expect(row?.success_count).toBe(2); // correct + partial(0.5)
    expect(row?.fail_count).toBe(1);
  });
});

describe('updateThetaForAttemptWithOptionalStepGrading', () => {
  beforeEach(async () => {
    await resetDb();
    stepGradingFlag.enabled = false;
  });
  afterEach(async () => {
    await resetDb();
    stepGradingFlag.enabled = false;
  });

  it('flag OFF — single binary update (evidence_count=1) even with step verdicts', async () => {
    const kc = 'kc-flag-off';
    const qid = newId();
    await seedKnowledge(kc);
    const now = new Date();
    await db.insert(question).values({
      id: qid,
      prompt_md: 'p',
      kind: 'derivation',
      source: 'manual',
      difficulty: 3,
      knowledge_ids: [kc],
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await db.insert(item_calibration).values({
      id: createId(),
      question_id: qid,
      b: 0,
      confidence: 0.9,
      track: 'hard',
      source: 'llm_prior',
      created_at: now,
      updated_at: now,
    });

    await db.transaction(async (tx) => {
      await updateThetaForAttemptWithOptionalStepGrading(
        tx,
        {
          knowledgeIds: [kc],
          questionId: qid,
          outcome: 1,
          difficulty: 3,
          attemptEventId: newId(),
          now,
        },
        stepsJudgeResult(['correct', 'wrong', 'partial']),
      );
    });

    const row = await getMasteryState(db, kc);
    expect(row?.evidence_count).toBe(1);
  });

  it('flag ON + calibrated — N step updates replace single binary', async () => {
    stepGradingFlag.enabled = true;
    const kc = 'kc-flag-on';
    const qid = newId();
    await seedKnowledge(kc);
    const now = new Date();
    await db.insert(question).values({
      id: qid,
      prompt_md: 'p',
      kind: 'derivation',
      source: 'manual',
      difficulty: 3,
      knowledge_ids: [kc],
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await db.insert(item_calibration).values({
      id: createId(),
      question_id: qid,
      b: 0,
      confidence: 0.9,
      track: 'hard',
      source: 'llm_prior',
      created_at: now,
      updated_at: now,
    });

    await db.transaction(async (tx) => {
      await updateThetaForAttemptWithOptionalStepGrading(
        tx,
        {
          knowledgeIds: [kc],
          questionId: qid,
          outcome: 1,
          difficulty: 3,
          attemptEventId: newId(),
          now,
        },
        stepsJudgeResult(['correct', 'wrong']),
      );
    });

    const row = await getMasteryState(db, kc);
    expect(row?.evidence_count).toBe(2);

    const msRows = await db.select().from(mastery_state).where(eq(mastery_state.subject_id, kc));
    expect(msRows).toHaveLength(1);
  });
});
