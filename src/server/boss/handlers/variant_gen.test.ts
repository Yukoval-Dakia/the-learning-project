// Task #17 — variant_gen handler tests.

import { event, knowledge, mistake_variant, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { runAttributionAndWriteJudgeEvent } from '@/server/knowledge/attribute';
import { resolveSubjectProfile } from '@/subjects/profile';
import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runVariantGen } from './variant_gen';

const VALID_VARIANT_OUTPUT = JSON.stringify({
  prompt_md: '辨析下列句中「之」的用法：「师道之不传也久矣」。',
  reference_md: '主谓之间，取消句子独立性。',
  difficulty: 3,
  reasoning: '针对用户混淆主谓间与结构助词的概念错误，再出一道主谓间例子。',
});

async function seedQuestion(opts: {
  id: string;
  source?: string;
  variant_depth?: number;
  root_question_id?: string | null;
}) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id: opts.id,
    kind: 'short_answer',
    prompt_md: '「之」在「古之学者必有师」中的用法',
    reference_md: '结构助词，相当于"的"',
    source: opts.source ?? 'manual',
    knowledge_ids: ['k_xuci'],
    variant_depth: opts.variant_depth ?? 0,
    root_question_id: opts.root_question_id ?? null,
    created_at: now,
    updated_at: now,
  });
}

async function seedFailureAttempt(attemptId: string, qid: string) {
  await writeEvent(testDb(), {
    id: attemptId,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: qid,
    outcome: 'failure',
    payload: {
      answer_md: '助词，主谓间',
      answer_image_refs: [],
      referenced_knowledge_ids: ['k_xuci'],
    },
    created_at: new Date(),
  });
}

async function seedJudgeForAttempt(attemptId: string, category: string, domain = 'wenyan') {
  // Use runAttributionAndWriteJudgeEvent so the chained-event shape stays
  // consistent with production write path.
  const runTaskFn = vi.fn(async () => ({
    text: JSON.stringify({
      primary_category: category,
      secondary_categories: [],
      analysis_md: '...',
      confidence: 0.8,
    }),
  }));
  await runAttributionAndWriteJudgeEvent({
    db: testDb(),
    attemptEventId: attemptId,
    input: {
      prompt_md: 'p',
      reference_md: 'r',
      wrong_answer_md: 'w',
      knowledge_context: [],
    },
    referencedKnowledgeIds: ['k_xuci'],
    runTaskFn,
    subjectProfile: resolveSubjectProfile(domain),
  });
}

async function seedRawJudgeForAttempt(attemptId: string, category: string) {
  await writeEvent(testDb(), {
    id: createId(),
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'attribution',
    action: 'judge',
    subject_kind: 'event',
    subject_id: attemptId,
    outcome: 'success',
    payload: {
      cause: {
        primary_category: category,
        secondary_categories: [],
        analysis_md: '...',
        confidence: 0.8,
      },
      referenced_knowledge_ids: ['k_xuci'],
    },
    caused_by_event_id: attemptId,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(),
  });
}

async function seedUserCauseForAttempt(attemptId: string, category: string, notes = 'manual fix') {
  await writeEvent(testDb(), {
    id: createId(),
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:user_cause',
    subject_kind: 'event',
    subject_id: attemptId,
    outcome: 'success',
    payload: {
      primary_category: category,
      user_notes: notes,
    },
    caused_by_event_id: attemptId,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(),
  });
}

async function seedKnowledge(domain = 'wenyan') {
  await testDb().insert(knowledge).values({
    id: 'k_xuci',
    name: '虚词',
    domain,
    parent_id: null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: new Date(),
    updated_at: new Date(),
    version: 0,
  });
}

describe('runVariantGen', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns skipped:attempt_not_found when attempt event missing', async () => {
    const runTaskFn = vi.fn();
    const result = await runVariantGen({
      db: testDb(),
      attemptEventId: 'no_such',
      runTaskFn,
    });
    expect(result.status).toBe('skipped:attempt_not_found');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('returns skipped:not_a_failure_attempt for success events', async () => {
    const db = testDb();
    await seedQuestion({ id: 'q1' });
    const attemptId = createId();
    await writeEvent(db, {
      id: attemptId,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'success',
      payload: { answer_md: 'right', answer_image_refs: [], referenced_knowledge_ids: [] },
      created_at: new Date(),
    });

    const runTaskFn = vi.fn();
    const result = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
    expect(result.status).toBe('skipped:not_a_failure_attempt');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('returns skipped:no_judge_yet when chained judge event missing', async () => {
    const db = testDb();
    await seedQuestion({ id: 'q1' });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');

    const runTaskFn = vi.fn();
    const result = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
    expect(result.status).toBe('skipped:no_judge_yet');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('returns skipped:cause_not_targetable for carelessness cause', async () => {
    const db = testDb();
    await seedKnowledge();
    await seedQuestion({ id: 'q1' });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');
    await seedJudgeForAttempt(attemptId, 'carelessness');

    const runTaskFn = vi.fn();
    const result = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
    expect(result.status).toBe('skipped:cause_not_targetable');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('returns skipped:variant_chain_terminus when parent is itself a variant', async () => {
    const db = testDb();
    await seedKnowledge();
    await seedQuestion({ id: 'q1', source: 'mistake_variant', variant_depth: 1 });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');
    await seedJudgeForAttempt(attemptId, 'concept');

    const runTaskFn = vi.fn();
    const result = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
    // variant_chain_terminus checked before max_depth
    expect(result.status).toBe('skipped:variant_chain_terminus');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('returns skipped:max_depth when parent depth >= 1', async () => {
    const db = testDb();
    await seedKnowledge();
    await seedQuestion({ id: 'q1', source: 'manual', variant_depth: 1 });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');
    await seedJudgeForAttempt(attemptId, 'concept');

    const runTaskFn = vi.fn();
    const result = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
    expect(result.status).toBe('skipped:max_depth');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('proposes a depth=1 variant on the happy path', async () => {
    const db = testDb();
    await seedKnowledge();
    await seedQuestion({ id: 'q1' });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');
    await seedJudgeForAttempt(attemptId, 'concept');

    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({
      text: VALID_VARIANT_OUTPUT,
    }));
    const result = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
    expect(result.status).toBe('proposed');
    expect(result.proposal_id).toBeTruthy();
    expect(runTaskFn).toHaveBeenCalledTimes(1);

    const proposal = (
      await db
        .select()
        .from(event)
        .where(eq(event.id, result.proposal_id ?? ''))
    )[0];
    const aiProposal = (
      proposal.payload as {
        ai_proposal?: { kind?: string; proposed_change?: Record<string, unknown> };
      }
    ).ai_proposal;
    expect(aiProposal?.kind).toBe('variant_question');
    expect(aiProposal?.proposed_change).toMatchObject({
      source_question_id: 'q1',
      source_attempt_event_id: attemptId,
      variant_depth: 1,
      parent_variant_id: 'q1',
      root_question_id: 'q1',
      knowledge_ids: ['k_xuci'],
      difficulty: 3,
    });
    const questions = await db.select().from(question);
    expect(questions).toHaveLength(1);
  });

  it('passes the first knowledge subject profile to VariantGenTask', async () => {
    const db = testDb();
    await seedKnowledge('math');
    await seedQuestion({ id: 'q1' });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');
    await seedJudgeForAttempt(attemptId, 'concept');

    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({
      text: VALID_VARIANT_OUTPUT,
    }));
    await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });

    const ctx = runTaskFn.mock.calls[0]?.[2] as unknown as { subjectProfile?: { id: string } };
    expect(ctx.subjectProfile?.id).toBe('math');
  });

  it('generates a math variant when the judge cause is unit_error', async () => {
    const db = testDb();
    await seedKnowledge('math');
    await seedQuestion({ id: 'q1' });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');
    await seedJudgeForAttempt(attemptId, 'unit_error', 'math');

    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({
      text: JSON.stringify({
        prompt_md: '把 120 cm 换算成 m 后代入公式。',
        reference_md: '120 cm = 1.2 m，再代入公式计算。',
        difficulty: 2,
        reasoning: '针对单位换算错误，保持同一核心方法并改变数值。',
      }),
    }));

    const result = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });

    expect(result.status).toBe('proposed');
    const input = runTaskFn.mock.calls[0]?.[1] as {
      cause?: { primary_category?: string };
    };
    expect(input.cause?.primary_category).toBe('unit_error');
  });

  it('uses active user cause before the agent judge for variant targeting', async () => {
    const db = testDb();
    await seedKnowledge();
    await seedQuestion({ id: 'q1' });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');
    await seedJudgeForAttempt(attemptId, 'carelessness');
    await seedUserCauseForAttempt(attemptId, 'concept', '用户确认是概念混淆');

    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({
      text: VALID_VARIANT_OUTPUT,
    }));

    const result = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });

    expect(result.status).toBe('proposed');
    const input = runTaskFn.mock.calls[0]?.[1] as {
      cause?: { primary_category?: string; analysis_md?: string };
    };
    expect(input.cause).toMatchObject({
      primary_category: 'concept',
      analysis_md: '用户确认是概念混淆',
    });
  });

  it('uses the subject profile, not a global skip list, for time_pressure variants', async () => {
    const db = testDb();
    await seedKnowledge('math');
    await seedQuestion({ id: 'q1' });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');
    await seedRawJudgeForAttempt(attemptId, 'time_pressure');

    const runTaskFn = vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({
      text: JSON.stringify({
        prompt_md: '限时完成同类计算，先写关键步骤再代入。',
        reference_md: '在限定时间内完成核心步骤并给出答案。',
        difficulty: 2,
        reasoning: 'math profile treats time pressure as targetable pacing practice.',
      }),
    }));

    const result = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });

    expect(result.status).toBe('proposed');
    const input = runTaskFn.mock.calls[0]?.[1] as {
      cause?: { primary_category?: string };
    };
    expect(input.cause?.primary_category).toBe('time_pressure');
  });

  it('returns skipped:already_has_variant on re-run (idempotency)', async () => {
    const db = testDb();
    await seedKnowledge();
    await seedQuestion({ id: 'q1' });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');
    await seedJudgeForAttempt(attemptId, 'concept');

    const runTaskFn = vi.fn(async () => ({ text: VALID_VARIANT_OUTPUT }));
    const first = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
    expect(first.status).toBe('proposed');

    const second = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
    expect(second.status).toBe('skipped:already_has_variant');
    // LLM called only once
    expect(runTaskFn).toHaveBeenCalledTimes(1);
  });

  it('propagates an existing root_question_id (preserves variant lineage)', async () => {
    const db = testDb();
    await seedKnowledge();
    // Note: this is a synthetic edge case — we set root_question_id≠id on a
    // depth-0 question to verify the handler doesn't overwrite it. In
    // production, depth-0 questions always have root_question_id=null and
    // depth>=1 questions are blocked by max_depth.
    await seedQuestion({ id: 'q1', root_question_id: 'q_root' });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');
    await seedJudgeForAttempt(attemptId, 'concept');

    const runTaskFn = vi.fn(async () => ({ text: VALID_VARIANT_OUTPUT }));
    const result = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
    expect(result.status).toBe('proposed');
    const proposal = (
      await db
        .select()
        .from(event)
        .where(eq(event.id, result.proposal_id ?? ''))
    )[0];
    const aiProposal = (
      proposal.payload as { ai_proposal?: { proposed_change?: Record<string, unknown> } }
    ).ai_proposal;
    expect(aiProposal?.proposed_change?.root_question_id).toBe('q_root');
  });

  it('writes a draft mistake_variant row alongside the proposal (YUK-17)', async () => {
    const db = testDb();
    await seedKnowledge();
    await seedQuestion({ id: 'q1' });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');
    await seedJudgeForAttempt(attemptId, 'concept');

    const runTaskFn = vi.fn(async () => ({ text: VALID_VARIANT_OUTPUT }));
    const result = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });

    expect(result.status).toBe('proposed');
    expect(result.mistake_variant_id).toBeTruthy();
    expect(result.proposal_id).toBeTruthy();

    const mvRows = await db
      .select()
      .from(mistake_variant)
      .where(eq(mistake_variant.id, result.mistake_variant_id ?? ''));
    expect(mvRows).toHaveLength(1);
    expect(mvRows[0]).toMatchObject({
      parent_question_id: 'q1',
      variant_question_id: null,
      proposal_event_id: result.proposal_id,
      status: 'draft',
      cause_category: 'concept',
      failure_reasons: [],
    });
  });

  it('returns skipped:variants_max_reached when 3 in-flight rows already exist (YUK-17)', async () => {
    const db = testDb();
    await seedKnowledge();
    await seedQuestion({ id: 'q1' });
    // Seed 3 in-flight mistake_variant rows directly (mix of draft+active).
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      await db.insert(mistake_variant).values({
        id: `mv_${i}`,
        parent_question_id: 'q1',
        variant_question_id: i === 0 ? `q_existing_${i}` : null,
        proposal_event_id: `p_existing_${i}`,
        status: i === 0 ? 'active' : 'draft',
        failure_reasons: [],
        cause_category: 'concept',
        created_at: now,
        updated_at: now,
      });
    }
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');
    await seedJudgeForAttempt(attemptId, 'concept');

    const runTaskFn = vi.fn();
    const result = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
    expect(result.status).toBe('skipped:variants_max_reached');
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('still proposes when in-flight count is 2 (variants_max headroom)', async () => {
    const db = testDb();
    await seedKnowledge();
    await seedQuestion({ id: 'q1' });
    const now = new Date();
    for (let i = 0; i < 2; i++) {
      await db.insert(mistake_variant).values({
        id: `mv_${i}`,
        parent_question_id: 'q1',
        variant_question_id: null,
        proposal_event_id: `p_existing_${i}`,
        status: 'draft',
        failure_reasons: [],
        cause_category: 'concept',
        created_at: now,
        updated_at: now,
      });
    }
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');
    await seedJudgeForAttempt(attemptId, 'concept');

    const runTaskFn = vi.fn(async () => ({ text: VALID_VARIANT_OUTPUT }));
    const result = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
    expect(result.status).toBe('proposed');
    const finalRows = await db
      .select()
      .from(mistake_variant)
      .where(eq(mistake_variant.parent_question_id, 'q1'));
    expect(finalRows).toHaveLength(3);
  });

  it('broken / dismissed rows do not count toward variants_max', async () => {
    const db = testDb();
    await seedKnowledge();
    await seedQuestion({ id: 'q1' });
    const now = new Date();
    // 3 historical rows, all terminal — should not block a fresh proposal.
    await db.insert(mistake_variant).values([
      {
        id: 'mv_old_1',
        parent_question_id: 'q1',
        status: 'broken',
        failure_reasons: ['off target'],
        proposal_event_id: 'p_old_1',
        variant_question_id: 'q_old_1',
        created_at: now,
        updated_at: now,
      },
      {
        id: 'mv_old_2',
        parent_question_id: 'q1',
        status: 'dismissed',
        failure_reasons: [],
        proposal_event_id: 'p_old_2',
        variant_question_id: null,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'mv_old_3',
        parent_question_id: 'q1',
        status: 'dismissed',
        failure_reasons: [],
        proposal_event_id: 'p_old_3',
        variant_question_id: null,
        created_at: now,
        updated_at: now,
      },
    ]);
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');
    await seedJudgeForAttempt(attemptId, 'concept');

    const runTaskFn = vi.fn(async () => ({ text: VALID_VARIANT_OUTPUT }));
    const result = await runVariantGen({ db, attemptEventId: attemptId, runTaskFn });
    expect(result.status).toBe('proposed');
  });

  it('throws when LLM output is not valid JSON', async () => {
    const db = testDb();
    await seedKnowledge();
    await seedQuestion({ id: 'q1' });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');
    await seedJudgeForAttempt(attemptId, 'concept');

    const runTaskFn = vi.fn(async () => ({ text: 'not json' }));
    await expect(runVariantGen({ db, attemptEventId: attemptId, runTaskFn })).rejects.toThrow(
      /parseVariantOutput/,
    );
  });
});

describe('runAttributionFollowup → enqueueVariantGen wiring', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('invokes enqueueVariantGen with the attempt id after a successful run', async () => {
    const { runAttributionFollowup } = await import('./attribution_followup');
    const db = testDb();
    await seedKnowledge();
    await seedQuestion({ id: 'q1' });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');

    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        primary_category: 'concept',
        secondary_categories: [],
        analysis_md: '...',
        confidence: 0.8,
      }),
    }));
    const enqueueVariantGen = vi.fn(async () => {});

    const result = await runAttributionFollowup({
      db,
      attemptEventId: attemptId,
      runTaskFn,
      enqueueVariantGen,
    });
    expect(result.status).toBe('attempted');
    expect(enqueueVariantGen).toHaveBeenCalledWith(attemptId);

    // The judge event chained off the attempt was indeed written
    const judges = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'judge'),
          eq(event.subject_kind, 'event'),
          eq(event.caused_by_event_id, attemptId),
        ),
      );
    expect(judges).toHaveLength(1);
  });

  it('does not invoke enqueueVariantGen when attempt is skipped', async () => {
    const { runAttributionFollowup } = await import('./attribution_followup');
    const enqueueVariantGen = vi.fn(async () => {});
    const runTaskFn = vi.fn();

    const result = await runAttributionFollowup({
      db: testDb(),
      attemptEventId: 'no_such',
      runTaskFn,
      enqueueVariantGen,
    });
    expect(result.status).toBe('skipped:attempt_not_found');
    expect(enqueueVariantGen).not.toHaveBeenCalled();
  });

  it('swallows enqueue errors (attribution result still succeeds)', async () => {
    const { runAttributionFollowup } = await import('./attribution_followup');
    const db = testDb();
    await seedKnowledge();
    await seedQuestion({ id: 'q1' });
    const attemptId = createId();
    await seedFailureAttempt(attemptId, 'q1');

    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        primary_category: 'concept',
        secondary_categories: [],
        analysis_md: '...',
        confidence: 0.8,
      }),
    }));
    const enqueueVariantGen = vi.fn(async () => {
      throw new Error('boss not reachable');
    });

    const result = await runAttributionFollowup({
      db,
      attemptEventId: attemptId,
      runTaskFn,
      enqueueVariantGen,
    });
    expect(result.status).toBe('attempted');
    expect(enqueueVariantGen).toHaveBeenCalled();
  });
});
