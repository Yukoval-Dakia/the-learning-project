// YUK-573 (Deliverable 2) — judge-calibration disagreement sampling, db tests.
//
// The REPORT-ONLY red line is adversarially pinned here (design doc §5/§7):
// the sampler may write ONLY `experimental:judge_calibration_sample` +
// `experimental:judge_calibration_run_summary` events — never judge/correct/
// attempt/review events, never mastery_state / item_calibration / snapshot
// rows. Seeds go through direct db.insert(event) (rejudge.db.test.ts
// precedent); the re-judge LLM is an injected runTaskInner stub so the REAL
// judgeAnswer pipeline runs end-to-end with zero network.
import { event, item_calibration, mastery_state, question } from '@/db/schema';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  JUDGE_CALIBRATION_RUN_SUMMARY_ACTION,
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

function stepsOutput(): string {
  return JSON.stringify({
    extracted_steps: [{ idx: 0, content: '2x=84', verdict: 'correct', comment: 'ok' }],
    extracted_final_answer: '42',
    signal_verdicts: [{ signal_idx: 0, verdict: 'correct', comment: '命中' }],
    final_answer_match: true,
    final_answer_comment: '正确。',
    confidence: 0.9,
  });
}

interface SeedOpts {
  route: 'semantic' | 'steps' | 'multimodal_direct' | 'exact';
  priorOutcome: 'correct' | 'partial' | 'incorrect' | 'unsupported';
  /** 'present' → answer_image_refs: [] ; 'absent' → key missing (pre-persistence row). */
  imageRefsKey?: 'present' | 'absent';
  /** 'absent' → NEITHER answer_md NOR user_response_md key (pre-persistence row). */
  textKey?: 'present' | 'absent';
  createdAt?: Date;
  answerMd?: string;
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
    metadata: {},
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

async function runSummaryEvents() {
  return testDb()
    .select()
    .from(event)
    .where(eq(event.action, JUDGE_CALIBRATION_RUN_SUMMARY_ACTION));
}

describe('runJudgeCalibrationSample', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('(a) records a disagreement observation with full payload + run summary', async () => {
    const { questionId, attemptEventId, judgeEventId } = await seedJudgedAttempt({
      route: 'semantic',
      priorOutcome: 'correct',
    });
    const runTaskInner = vi.fn(async () => ({
      task_run_id: 'run-syn-1',
      text: semanticOutput('incorrect'),
    }));

    const result = await runJudgeCalibrationSample(testDb(), mkCfg(), { runTaskInner });

    expect(result).toMatchObject({
      sampled: 1,
      agreed: 0,
      disagreed: 1,
      skipped: 0,
      skipped_unsupported: 0,
      errors: 0,
    });

    const rows = await sampleEvents();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.subject_kind).toBe('event');
    expect(row?.subject_id).toBe(judgeEventId);
    expect(row?.caused_by_event_id).toBe(judgeEventId);
    expect(row?.actor_kind).toBe('system');
    expect(row?.actor_ref).toBe('judge_calibration');
    expect(row?.task_run_id).toBe('run-syn-1');
    // ingest_at prefilled — memory-outbox opt-out (red line).
    expect(row?.ingest_at).not.toBeNull();

    const payload = row?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      original_outcome: 'correct',
      rejudge_outcome: 'incorrect',
      agreed: false,
      bit_agreed: false,
      original_judge_event_id: judgeEventId,
      question_id: questionId,
      answer_event_id: attemptEventId,
      rejudge_route: 'semantic',
      rejudge_provider: 'anthropic-sub',
      rejudge_model: 'claude-opus-4-8',
      rejudge_task_run_id: 'run-syn-1',
      original_provider: 'unknown',
    });
    expect(payload.rejudge_raw_output).toContain('复判反馈');
    expect(typeof payload.same_lane_suspected).toBe('boolean');
    expect(payload).toHaveProperty('vision_judge_provider_at_sample');
    expect(payload).toHaveProperty('ai_provider_override_at_sample');
    expect(typeof payload.sampled_at).toBe('string');

    // Run summary (复核吸收 3): one per run, counts mirrored, caused_by null.
    const summaries = await runSummaryEvents();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.caused_by_event_id).toBeNull();
    expect(summaries[0]?.ingest_at).not.toBeNull();
    expect(summaries[0]?.payload).toMatchObject({
      sampled: 1,
      agreed: 0,
      disagreed: 1,
      skipped: 0,
      skipped_unsupported: 0,
      errors: 0,
      batch_max: 20,
      window_days: 7,
      rejudge_provider: 'anthropic-sub',
    });
  });

  it('(a2) agreement recorded with bit_agreed nuance (partial vs correct → bit agree)', async () => {
    await seedJudgedAttempt({ route: 'semantic', priorOutcome: 'partial' });
    const runTaskInner = vi.fn(async () => ({
      task_run_id: 'run-syn-2',
      text: semanticOutput('correct'),
    }));

    const result = await runJudgeCalibrationSample(testDb(), mkCfg(), { runTaskInner });
    expect(result.sampled).toBe(1);
    expect(result.disagreed).toBe(1); // exact coarse mismatch…
    const [row] = await sampleEvents();
    const payload = row?.payload as Record<string, unknown>;
    expect(payload.agreed).toBe(false);
    expect(payload.bit_agreed).toBe(true); // …but the θ̂ bit agrees (both 1).
  });

  it('(b) RED LINE — writes nothing beyond sample + run_summary; mastery/calibration untouched', async () => {
    const { judgeEventId } = await seedJudgedAttempt({
      route: 'semantic',
      priorOutcome: 'correct',
    });
    const runTaskInner = vi.fn(async () => ({
      task_run_id: 'run-syn-3',
      text: semanticOutput('correct'),
    }));

    await runJudgeCalibrationSample(testDb(), mkCfg(), { runTaskInner });

    // Event-table action set: exactly the seeds + the two observation actions.
    // NOTE (r3 复核吸收 4①): the re-judge legitimately writes ai_task_runs /
    // cost_ledger rows in production (runTask internals); the red line is
    // scoped to the EVENT table action set + the three learning-state faces.
    const actions = (await testDb().select({ action: event.action }).from(event)).map(
      (r) => r.action,
    );
    expect(actions.sort()).toEqual(
      [
        'attempt',
        'judge',
        JUDGE_CALIBRATION_RUN_SUMMARY_ACTION,
        JUDGE_CALIBRATION_SAMPLE_ACTION,
      ].sort(),
    );
    // Still exactly ONE judge event (the seed) — the sampler never writes judge.
    const judges = await testDb().select().from(event).where(eq(event.action, 'judge'));
    expect(judges).toHaveLength(1);
    expect(judges[0]?.id).toBe(judgeEventId);
    // Learning state faces untouched. NOTE: θ̂/FSRS snapshots are EVENTS in
    // this codebase (experimental:state_snapshot / grading_checkpoint,
    // ADR-0044), not a table — the action-set equality above already excludes
    // them structurally; these explicit zero-counts close the stated
    // "mastery/item_calibration/snapshot 三面" contract (review finding 1).
    const snapshotActions = (await testDb().select({ action: event.action }).from(event)).filter(
      (r) =>
        r.action === 'experimental:state_snapshot' ||
        r.action === 'experimental:grading_checkpoint',
    );
    expect(snapshotActions).toHaveLength(0);
    expect(await testDb().select().from(mastery_state)).toHaveLength(0);
    expect(await testDb().select().from(item_calibration)).toHaveLength(0);
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

  it('(c3) appeal caused_by collision does NOT block sampling (action-filtered dedup)', async () => {
    const { judgeEventId } = await seedJudgedAttempt({
      route: 'semantic',
      priorOutcome: 'correct',
    });
    // An appeal event also anchors caused_by = judge event id (§1.2). A bare
    // caused_by dedup would misread this as "already sampled" — the load-bearing
    // deviation from rejudge's bare dedup is the action filter.
    await testDb()
      .insert(event)
      .values({
        id: createId(),
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'experimental:appeal_request',
        subject_kind: 'event',
        subject_id: judgeEventId,
        outcome: null,
        payload: { reason_md: '不服' },
        caused_by_event_id: judgeEventId,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date(),
      });
    const runTaskInner = vi.fn(async () => ({
      task_run_id: 'run-syn-5',
      text: semanticOutput('correct'),
    }));

    const result = await runJudgeCalibrationSample(testDb(), mkCfg(), { runTaskInner });
    expect(result.sampled).toBe(1);
  });

  it('(d) BATCH_MAX caps per-run spend', async () => {
    await seedJudgedAttempt({ route: 'semantic', priorOutcome: 'correct' });
    await seedJudgedAttempt({ route: 'semantic', priorOutcome: 'correct' });
    await seedJudgedAttempt({ route: 'semantic', priorOutcome: 'correct' });
    const runTaskInner = vi.fn(async () => ({
      task_run_id: 'run-syn-6',
      text: semanticOutput('correct'),
    }));

    const first = await runJudgeCalibrationSample(testDb(), mkCfg({ batchMax: 2 }), {
      runTaskInner,
    });
    expect(first.sampled).toBe(2);
    expect(runTaskInner).toHaveBeenCalledTimes(2);

    const second = await runJudgeCalibrationSample(testDb(), mkCfg({ batchMax: 2 }), {
      runTaskInner,
    });
    expect(second.sampled).toBe(1);
    expect(await sampleEvents()).toHaveLength(3);
  });

  it('(e) per-task override wins the vision-route env override (S5 spread order)', async () => {
    vi.stubEnv('VISION_JUDGE_PROVIDER', 'xiaomi');
    await seedJudgedAttempt({ route: 'steps', priorOutcome: 'correct' });
    const seenCtx: unknown[] = [];
    const runTaskInner = vi.fn(async (_kind: string, _input: unknown, ctx: unknown) => {
      seenCtx.push(ctx);
      return { task_run_id: 'run-syn-7', text: stepsOutput() };
    });

    const result = await runJudgeCalibrationSample(testDb(), mkCfg(), { runTaskInner });

    expect(result.sampled).toBe(1);
    expect(seenCtx).toHaveLength(1);
    const override = (seenCtx[0] as { override?: { provider?: string; model?: string } }).override;
    // steps-judge injects override: visionJudgeProviderOverride() ('xiaomi'
    // here) into ctx at its call site — the rejudge wrapper's own override
    // literal MUST come after ...ctx in the spread, so the second lane wins.
    expect(override?.provider).toBe('anthropic-sub');
    expect(override?.model).toBe('claude-opus-4-8');
  });

  it('(g) unsupported re-judge → skipped_unsupported, NEVER an agreed=false row (MF3②)', async () => {
    await seedJudgedAttempt({ route: 'semantic', priorOutcome: 'correct' });
    const runTaskInner = vi.fn(async () => ({
      task_run_id: 'run-syn-8',
      text: '不是 JSON 的输出',
    }));

    const result = await runJudgeCalibrationSample(testDb(), mkCfg(), { runTaskInner });

    expect(result.skipped_unsupported).toBe(1);
    expect(result.sampled).toBe(0);
    expect(result.disagreed).toBe(0);
    expect(await sampleEvents()).toHaveLength(0);
    // Run summary still reports the systematic-skip signal (复核吸收 3).
    const summaries = await runSummaryEvents();
    expect(summaries[0]?.payload).toMatchObject({ sampled: 0, skipped_unsupported: 1 });
  });

  it('(h) vision sample without answer_image_refs key → skipped, no re-judge (MF2)', async () => {
    await seedJudgedAttempt({
      route: 'steps',
      priorOutcome: 'correct',
      imageRefsKey: 'absent',
    });
    const runTaskInner = vi.fn(async () => ({ task_run_id: 'x', text: stepsOutput() }));

    const result = await runJudgeCalibrationSample(testDb(), mkCfg(), { runTaskInner });

    expect(result.skipped).toBe(1);
    expect(result.sampled).toBe(0);
    expect(runTaskInner).not.toHaveBeenCalled();
    expect(await sampleEvents()).toHaveLength(0);
  });

  it('(h2) answer payload with NEITHER text key → skipped_missing_input, no re-judge (OCR major 2)', async () => {
    // Pre-persistence row: the original judge saw the submitted text, but the
    // payload never persisted it — the re-judge information face cannot be
    // reconstructed. Re-judging with '' would manufacture false disagreements.
    await seedJudgedAttempt({
      route: 'semantic',
      priorOutcome: 'correct',
      textKey: 'absent',
    });
    const runTaskInner = vi.fn(async () => ({ task_run_id: 'x', text: semanticOutput('correct') }));

    const result = await runJudgeCalibrationSample(testDb(), mkCfg(), { runTaskInner });

    expect(result.skipped_missing_input).toBe(1);
    expect(result.sampled).toBe(0);
    expect(runTaskInner).not.toHaveBeenCalled();
    expect(await sampleEvents()).toHaveLength(0);
    // Run summary carries the new counter (mass-skip discriminator).
    const summaries = await runSummaryEvents();
    expect(summaries[0]?.payload).toMatchObject({ skipped_missing_input: 1 });
  });

  it('(h3) text key PRESENT but empty → same information face, re-judge proceeds', async () => {
    // '' persisted means the original judge also judged the empty submission —
    // the faces match, so the pair is a legitimate calibration observation.
    await seedJudgedAttempt({
      route: 'semantic',
      priorOutcome: 'incorrect',
      answerMd: '',
    });
    const runTaskInner = vi.fn(async () => ({
      task_run_id: 'run-syn-h3',
      text: semanticOutput('incorrect'),
    }));

    const result = await runJudgeCalibrationSample(testDb(), mkCfg(), { runTaskInner });

    expect(result.sampled).toBe(1);
    expect(result.skipped_missing_input).toBe(0);
    expect(runTaskInner).toHaveBeenCalledTimes(1);
  });

  it('(i) deterministic routes are whitelisted OUT (exact never sampled — MF4①)', async () => {
    await seedJudgedAttempt({ route: 'exact', priorOutcome: 'correct' });
    const runTaskInner = vi.fn(async () => ({ task_run_id: 'x', text: '' }));

    const result = await runJudgeCalibrationSample(testDb(), mkCfg(), { runTaskInner });

    expect(result.sampled).toBe(0);
    expect(runTaskInner).not.toHaveBeenCalled();
  });

  it('(j) newest judge per answer wins — superseded original never double-sampled (MF4②)', async () => {
    const { attemptEventId, judgeEventId } = await seedJudgedAttempt({
      route: 'semantic',
      priorOutcome: 'incorrect',
      createdAt: new Date(Date.now() - 60_000),
    });
    // A newer judge on the SAME answer event (appeal overturn shape).
    const newerJudgeId = createId();
    await testDb()
      .insert(event)
      .values({
        id: newerJudgeId,
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'rejudge',
        action: 'judge',
        subject_kind: 'event',
        subject_id: attemptEventId,
        outcome: 'success',
        payload: {
          cause: {
            primary_category: 'other',
            secondary_categories: [],
            analysis_md: '<overturn>',
            confidence: 0.8,
          },
          coarse_outcome: 'correct',
          score: 0.9,
          judge_route: 'semantic',
          capability_ref: { id: 'semantic', version: '1.0.0' },
          profile_version: '1.0.0',
        },
        caused_by_event_id: createId(),
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date(),
      });
    const runTaskInner = vi.fn(async () => ({
      task_run_id: 'run-syn-9',
      text: semanticOutput('correct'),
    }));

    const result = await runJudgeCalibrationSample(testDb(), mkCfg(), { runTaskInner });

    expect(result.sampled).toBe(1);
    const rows = await sampleEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.caused_by_event_id).toBe(newerJudgeId);
    expect(rows[0]?.caused_by_event_id).not.toBe(judgeEventId);
  });

  it('(k) window excludes judges older than windowDays', async () => {
    await seedJudgedAttempt({
      route: 'semantic',
      priorOutcome: 'correct',
      createdAt: new Date(Date.now() - 8 * 24 * 3600 * 1000),
    });
    const runTaskInner = vi.fn(async () => ({ task_run_id: 'x', text: '' }));

    const result = await runJudgeCalibrationSample(testDb(), mkCfg({ windowDays: 7 }), {
      runTaskInner,
    });

    expect(result.sampled).toBe(0);
    expect(runTaskInner).not.toHaveBeenCalled();
  });

  it('(l) same_lane_suspected flags an anthropic-sub-collapsed lane (MF5)', async () => {
    vi.stubEnv('AI_PROVIDER_OVERRIDE', 'anthropic-sub');
    await seedJudgedAttempt({ route: 'semantic', priorOutcome: 'correct' });
    const runTaskInner = vi.fn(async () => ({
      task_run_id: 'run-syn-10',
      text: semanticOutput('correct'),
    }));

    await runJudgeCalibrationSample(testDb(), mkCfg(), { runTaskInner });

    const [row] = await sampleEvents();
    const payload = row?.payload as Record<string, unknown>;
    expect(payload.same_lane_suspected).toBe(true);
    expect(payload.ai_provider_override_at_sample).toBe('anthropic-sub');
  });
});
