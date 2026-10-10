// YUK-573 (Deliverable 2) — judge-calibration disagreement sampling, db tests.
//
// The REPORT-ONLY red line is adversarially pinned here (design doc §5/§7):
// the sampler may write ONLY `experimental:judge_calibration_sample` +
// `experimental:judge_calibration_run_summary` events — never judge/correct/
// attempt/review events, never mastery_state / item_calibration / snapshot
// rows. Seeds go through direct db.insert(event) (rejudge.db.test.ts
// precedent); the re-judge LLM is an injected runTaskInner stub so the REAL
// judgeAnswer pipeline runs end-to-end with zero network.

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { event, question } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  JUDGE_CALIBRATION_SAMPLE_ACTION,
  type JudgeCalibrationConfig,
  runJudgeCalibrationSample,
  writeJudgeCalibrationSampleEvent,
} from './judge-calibration-sample-core';

function mkCfg(overrides: Partial<JudgeCalibrationConfig> = {}): JudgeCalibrationConfig {
  return {
    rejudgeProvider: 'anthropic-sub',
    rejudgeModel: 'claude-opus-4-8',
    batchMax: 20,
    windowDays: 7,
    ...overrides,
  };
}

function semanticOutput(coarse: 'correct' | 'partial' | 'incorrect'): string {
  return JSON.stringify({
    score: coarse === 'correct' ? 0.9 : coarse === 'partial' ? 0.5 : 0,
    coarse_outcome: coarse,
    confidence: 0.8,
    feedback_md: '复判反馈。',
    evidence_json: { matched_points: [], missing_points: [] },
  });
}

interface SeedOpts {
  route: 'semantic' | 'steps' | 'multimodal_direct' | 'exact' | 'unit_dimension';
  priorOutcome: 'correct' | 'partial' | 'incorrect' | 'unsupported';
  /** 'present' → answer_image_refs: [] ; 'absent' → key missing (pre-persistence row). */
  imageRefsKey?: 'present' | 'absent';
  /** 'absent' → NEITHER answer_md NOR user_response_md key (pre-persistence row). */
  textKey?: 'present' | 'absent';
  createdAt?: Date;
  answerMd?: string;
  /** YUK-769 (i2) — unit_dimension needs reference_value/reference_unit metadata. */
  metadata?: Record<string, unknown>;
}

async function seedJudgedAttempt(opts: SeedOpts): Promise<{
  questionId: string;
  attemptEventId: string;
  judgeEventId: string;
}> {
  const db = testDb();
  const now = opts.createdAt ?? new Date();
  const questionId = createId();
  const stepsRubric = {
    criteria: [{ name: 'correctness', weight: 1, descriptor: 'steps' }],
    reference_solution: {
      expected_signals: ['列出方程 2x=84'],
      final_answer: '42',
      answer_equivalents: [],
    },
  };
  await db.insert(question).values({
    id: questionId,
    kind: opts.route === 'steps' ? 'derivation' : 'short_answer',
    prompt_md: '（测试）题面',
    reference_md: '（测试）参考',
    rubric_json:
      opts.route === 'steps'
        ? stepsRubric
        : {
            criteria: [{ name: 'correctness', weight: 1, descriptor: '要点' }],
            required_points: ['要点'],
          },
    choices_md: null,
    // 显式 set（audit:draft-status 站点纪律）：测试种子题不进练习池语义之外。
    draft_status: null,
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    figures: [],
    image_refs: [],
    structured: null,
    metadata: opts.metadata ?? {},
    created_at: now,
    updated_at: now,
    version: 0,
  });

  const attemptEventId = createId();
  const answerPayload: Record<string, unknown> =
    (opts.textKey ?? 'present') === 'present'
      ? { answer_md: opts.answerMd ?? '2x=84，所以 42' }
      : {};
  if ((opts.imageRefsKey ?? 'present') === 'present') {
    answerPayload.answer_image_refs = [];
  }
  await db.insert(event).values({
    id: attemptEventId,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: questionId,
    outcome: 'failure',
    payload: answerPayload,
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
  });

  const judgeEventId = createId();
  await db.insert(event).values({
    id: judgeEventId,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'paper_judge',
    action: 'judge',
    subject_kind: 'event',
    subject_id: attemptEventId,
    outcome: 'success',
    payload: {
      cause: {
        primary_category: 'other',
        secondary_categories: [],
        analysis_md: '<seed>',
        confidence: 0.7,
      },
      coarse_outcome: opts.priorOutcome,
      score: 0.4,
      judge_route: opts.route,
      capability_ref: { id: opts.route, version: '1.0.0' },
      profile_version: '1.0.0',
    },
    caused_by_event_id: attemptEventId,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: now,
  });

  return { questionId, attemptEventId, judgeEventId };
}

async function sampleEvents() {
  return testDb().select().from(event).where(eq(event.action, JUDGE_CALIBRATION_SAMPLE_ACTION));
}

describe('runJudgeCalibrationSample', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('(c) idempotent across runs — second run samples nothing new', async () => {
    await seedJudgedAttempt({ route: 'semantic', priorOutcome: 'correct' });
    const runTaskInner = vi.fn(async () => ({
      task_run_id: 'run-syn-4',
      text: semanticOutput('correct'),
    }));

    const first = await runJudgeCalibrationSample(testDb(), mkCfg(), { runTaskInner });
    const second = await runJudgeCalibrationSample(testDb(), mkCfg(), { runTaskInner });

    expect(first.sampled).toBe(1);
    expect(second.sampled).toBe(0);
    expect(await sampleEvents()).toHaveLength(1);
  });

  it('(c2) DB-enforced idempotency — duplicate sample write reports duplicate (23505 path)', async () => {
    const { questionId, attemptEventId, judgeEventId } = await seedJudgedAttempt({
      route: 'semantic',
      priorOutcome: 'correct',
    });
    const base = {
      originalJudgeEventId: judgeEventId,
      questionId,
      answerEventId: attemptEventId,
      priorOutcome: 'correct' as const,
      rejudgeOutcome: 'incorrect' as const,
      rejudgeRoute: 'semantic',
      rejudgeConfidence: 0.8,
      rejudgeProvider: 'anthropic-sub',
      rejudgeModel: 'claude-opus-4-8',
      rejudgeTaskRunId: null,
      rejudgeRawOutput: null,
      visionJudgeProviderAtSample: null,
      aiProviderOverrideAtSample: null,
      sameLaneSuspected: false,
      now: new Date(),
    };
    expect(await writeJudgeCalibrationSampleEvent(testDb(), base)).toBe('written');
    // Same caused_by judge id again — the partial unique index must reject it
    // even though the event PK differs (mid-batch redeliver double-write).
    expect(await writeJudgeCalibrationSampleEvent(testDb(), base)).toBe('duplicate');
    expect(await sampleEvents()).toHaveLength(1);
  });
});
