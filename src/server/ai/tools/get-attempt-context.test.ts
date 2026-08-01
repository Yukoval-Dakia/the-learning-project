import { knowledge, learning_record, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { getAttemptContextTool } from './get-attempt-context';
import type { ToolContext } from './types';

function ctx(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_gac',
    callerActor: { kind: 'agent', ref: 'agent:copilot' },
  };
}

function fsrsState(due: Date) {
  return {
    due: due.toISOString(),
    stability: 4.2,
    difficulty: 6.1,
    elapsed_days: 3,
    scheduled_days: 7,
    learning_steps: 0,
    reps: 4,
    lapses: 1,
    state: 'review',
    last_review: new Date(due.getTime() - 86_400_000).toISOString(),
  };
}

async function seedAttemptScenario(attemptId: string, qid = 'q1') {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id: 'k_xuci',
    name: '虚词',
    domain: 'yuwen',
    created_at: now,
    updated_at: now,
  });
  await db.insert(question).values({
    id: qid,
    kind: 'short_answer',
    prompt_md: `prompt for ${qid}`,
    reference_md: 'reference for q1',
    source: 'manual',
    knowledge_ids: ['k_xuci'],
    created_at: now,
    updated_at: now,
  });
  await writeEvent(db, {
    id: attemptId,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: qid,
    outcome: 'failure',
    payload: {
      answer_md: 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: ['k_xuci'],
    },
    created_at: now,
  });
  await writeEvent(db, {
    id: createId(),
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'AttributionTask',
    action: 'judge',
    subject_kind: 'event',
    subject_id: attemptId,
    outcome: 'success',
    caused_by_event_id: attemptId,
    payload: {
      cause: {
        primary_category: 'concept',
        secondary_categories: ['method'],
        analysis_md: 'mixup of zhi usage',
        confidence: 0.82,
      },
      referenced_knowledge_ids: ['k_xuci'],
    },
    created_at: now,
  });
}

describe('getAttemptContextTool', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns full context for an existing failure attempt', async () => {
    await seedAttemptScenario('att_full');
    const output = await getAttemptContextTool.execute(ctx(), { attemptEventId: 'att_full' });
    expect(output.lookup).toMatchObject({
      status: 'found',
      requested_event_id: 'att_full',
      observed: { event_id: 'att_full', action: 'attempt', outcome: 'failure' },
    });
    expect(output.attempt?.event_id).toBe('att_full');
    expect(output.attempt?.question_id).toBe('q1');
    expect(output.attempt?.action).toBe('attempt');
    expect(output.question?.id).toBe('q1');
    expect(output.question_availability).toBe('found');
    expect(output.question?.knowledge_ids).toEqual(['k_xuci']);
    expect(output.cause?.primary_category).toBe('concept');
    expect(output.cause?.source).toBe('agent');
    expect(output.cause?.event_id).toBeTruthy();
    expect(output.timeline.length).toBeGreaterThanOrEqual(1);
    expect(output.timeline[0].kind).toBe('attempt');
    expect(output.timeline_scope).toBe('same_question_context_noncausal');
    expect(output.causal_neighborhood.relation_semantics).toBe('direct_children_only');
    expect(output.causal_neighborhood.direct_children.map((row) => row.action)).toContain('judge');
  });

  it('distinguishes an absent id from an unsupported exact event without fabricating an attempt', async () => {
    const output = await getAttemptContextTool.execute(ctx(), {
      attemptEventId: 'nope',
    });
    expect(output.lookup).toEqual({
      requested_event_id: 'nope',
      status: 'not_found',
      observed: null,
    });
    expect(output.attempt).toBeNull();
    expect(output.question).toBeNull();
    expect(output.question_availability).toBe('not_resolved');
    expect(output.cause).toBeNull();
    expect(output.timeline).toEqual([]);
    expect(output.timeline_coverage).toMatchObject({ has_more: null, complete: null });
    expect(output.linked_records).toEqual([]);
    expect(output.causal_neighborhood.coverage).toMatchObject({
      total_direct_children: null,
      has_more: null,
      complete: null,
    });

    await writeEvent(testDb(), {
      id: 'attempt_named_probe',
      session_id: null,
      actor_kind: 'system',
      actor_ref: 'burnin_fixture',
      action: 'experimental:attempt_named_probe',
      subject_kind: 'event',
      subject_id: 'attempt_named_probe',
      outcome: 'success',
      payload: {
        fixture: 'YUK-832',
        realistic_nested_input: { rubric: ['identity', 'action'], evidence_count: 17 },
      },
      created_at: new Date('2026-08-01T02:00:00.000Z'),
    });
    const unsupported = await getAttemptContextTool.execute(ctx(), {
      attemptEventId: 'attempt_named_probe',
    });
    expect(unsupported.lookup).toMatchObject({
      status: 'unsupported_event',
      observed: {
        event_id: 'attempt_named_probe',
        action: 'experimental:attempt_named_probe',
        subject_kind: 'event',
        subject_id: 'attempt_named_probe',
        caused_by_event_id: null,
        created_at: '2026-08-01T02:00:00.000Z',
        correction_state: 'active',
        correction_event_id: null,
        replacement_event_id: null,
      },
    });
    expect(unsupported.attempt).toBeNull();
  });

  it('reports an inactive exact attempt with its correction identity instead of hiding it', async () => {
    await seedAttemptScenario('att_retracted', 'q_retracted');
    await writeEvent(testDb(), {
      id: 'correct_att_retracted',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'att_retracted',
      outcome: 'success',
      payload: {
        correction_kind: 'retract',
        reason_md: 'This was a duplicated offline submission, not a real learner attempt.',
        affected_refs: [{ kind: 'question', id: 'q_retracted' }],
      },
      created_at: new Date('2026-08-01T02:30:00.000Z'),
    });

    const output = await getAttemptContextTool.execute(ctx(), {
      attemptEventId: 'att_retracted',
    });
    expect(output.lookup).toMatchObject({
      status: 'inactive',
      observed: {
        event_id: 'att_retracted',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q_retracted',
        correction_state: 'retracted',
        correction_event_id: 'correct_att_retracted',
        replacement_event_id: null,
      },
    });
    expect(output.lookup.observed?.created_at).not.toBe(new Date(0).toISOString());
    expect(output.attempt).toBeNull();
  });

  it('reads a successful review and its real judge/checkpoint family with bounded coverage', async () => {
    const db = testDb();
    const base = new Date('2026-08-01T03:00:00.000Z');
    await db.insert(knowledge).values({
      id: 'k_probability',
      name: '条件概率',
      domain: 'math',
      created_at: base,
      updated_at: base,
    });
    await db.insert(question).values({
      id: 'q_bayes',
      kind: 'short_answer',
      prompt_md: '某检测灵敏度 0.95、特异度 0.90、先验患病率 0.01，阳性后的后验概率是多少？',
      reference_md: '用 Bayes：0.0095 / (0.0095 + 0.099) ≈ 8.76%。',
      source: 'manual',
      knowledge_ids: ['k_probability'],
      created_at: base,
      updated_at: base,
    });
    await writeEvent(db, {
      id: 'review_bayes',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'review',
      subject_kind: 'question',
      subject_id: 'q_bayes',
      outcome: 'success',
      payload: {
        fsrs_rating: 'good',
        fsrs_subject_kind: 'knowledge',
        fsrs_subject_ids: ['k_probability'],
        fsrs_state_after: fsrsState(new Date('2026-08-08T03:00:00.000Z')),
        fsrs_state_after_by_subject: [
          {
            subject_kind: 'knowledge',
            subject_id: 'k_probability',
            state: fsrsState(new Date('2026-08-08T03:00:00.000Z')),
            due_at: new Date('2026-08-08T03:00:00.000Z'),
          },
        ],
        user_response_md: '约 8.8%，因为假阳性基数远大于真阳性。',
        answer_image_refs: ['r2://answers/bayes-worked-derivation.webp'],
        referenced_knowledge_ids: ['k_probability'],
        duration_ms: 94_000,
        reasoning_trace: '先把一万人分组，再数真阳性和假阳性，避免混淆条件方向。',
      },
      created_at: base,
    });
    await writeEvent(db, {
      id: 'review_bayes:judge',
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'AttributionTask',
      action: 'judge',
      subject_kind: 'event',
      subject_id: 'review_bayes',
      outcome: 'success',
      caused_by_event_id: 'review_bayes',
      payload: {
        cause: {
          primary_category: 'concept',
          secondary_categories: [],
          analysis_md: 'Correctly reverses the conditioning direction and checks base rates.',
          confidence: 0.94,
        },
        referenced_knowledge_ids: ['k_probability'],
        coarse_outcome: 'correct',
        score: 0.94,
      },
      created_at: base,
    });
    await writeEvent(db, {
      id: 'review_bayes:checkpoint:fsrs',
      session_id: null,
      actor_kind: 'system',
      actor_ref: 'attempt_snapshot',
      action: 'experimental:grading_checkpoint',
      subject_kind: 'event',
      subject_id: 'review_bayes',
      outcome: 'success',
      caused_by_event_id: 'review_bayes',
      payload: { attempt_event_id: 'review_bayes', segment: 'fsrs' },
      created_at: base,
    });
    await writeEvent(db, {
      id: 'review_bayes:snapshot:fsrs',
      session_id: null,
      actor_kind: 'system',
      actor_ref: 'attempt_snapshot',
      action: 'experimental:state_snapshot',
      subject_kind: 'event',
      subject_id: 'review_bayes',
      outcome: 'success',
      caused_by_event_id: 'review_bayes:checkpoint:fsrs',
      payload: {
        attempt_event_id: 'review_bayes',
        theta_snapshots: [],
        fsrs_snapshots: [
          {
            subject_kind: 'knowledge',
            subject_id: 'k_probability',
            before: fsrsState(new Date('2026-08-01T03:00:00.000Z')),
            after: fsrsState(new Date('2026-08-08T03:00:00.000Z')),
          },
        ],
      },
      created_at: base,
    });
    await writeEvent(db, {
      id: 'correct_review_bayes_judge',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'review_bayes:judge',
      outcome: 'success',
      payload: {
        correction_kind: 'mark_wrong',
        reason_md: 'The score was produced before the final evidence packet was available.',
        affected_refs: [{ kind: 'question', id: 'q_bayes' }],
      },
      created_at: new Date(base.getTime() + 1),
    });
    for (let index = 0; index < 8; index += 1) {
      await writeEvent(db, {
        id: `bayes_history_${index}`,
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: 'q_bayes',
        outcome: index % 3 === 0 ? 'failure' : 'success',
        payload: {
          answer_md: `历史解法 ${index}: 用 ${10_000 + index * 100} 人频数表核验。`,
          answer_image_refs: [],
          referenced_knowledge_ids: ['k_probability'],
          duration_ms: 45_000 + index * 1_000,
        },
        created_at: new Date(base.getTime() - (index + 1) * 60_000),
      });
    }

    const output = await getAttemptContextTool.execute(ctx(), {
      attemptEventId: 'review_bayes',
      timelineLimit: 5,
      causalLimit: 2,
    });
    expect(output.lookup).toMatchObject({ status: 'found', observed: { action: 'review' } });
    expect(output.attempt).toMatchObject({
      event_id: 'review_bayes',
      action: 'review',
      outcome: 'success',
      answer_md: '约 8.8%，因为假阳性基数远大于真阳性。',
      answer_image_refs: ['r2://answers/bayes-worked-derivation.webp'],
      fsrs: {
        rating: 'good',
        subject_kind: 'knowledge',
        subject_ids: ['k_probability'],
      },
    });
    expect(output.attempt?.fsrs?.state_after_by_subject).toEqual([
      expect.objectContaining({
        subject_kind: 'knowledge',
        subject_id: 'k_probability',
        due_at: '2026-08-08T03:00:00.000Z',
        state: expect.objectContaining({
          due: '2026-08-08T03:00:00.000Z',
          stability: 4.2,
          difficulty: 6.1,
        }),
      }),
    ]);
    expect(output.causal_neighborhood.direct_children.every((row) => row.dispatch_seq > 0)).toBe(
      true,
    );
    expect(output.causal_neighborhood.parent).toBeNull();
    expect(output.causal_neighborhood.coverage).toMatchObject({
      returned_count: 2,
      total_direct_children: 2,
      has_more: false,
      complete: true,
    });
    expect(output.causal_neighborhood.direct_children).toEqual([
      expect.objectContaining({
        event_id: 'review_bayes:checkpoint:fsrs',
        action: 'experimental:grading_checkpoint',
        evidence: {
          kind: 'grading_checkpoint',
          attempt_event_id: 'review_bayes',
          segment: 'fsrs',
        },
      }),
      expect.objectContaining({
        event_id: 'review_bayes:judge',
        action: 'judge',
        evidence: {
          kind: 'judge',
          score: 0.94,
          coarse_outcome: 'correct',
          referenced_knowledge_ids: ['k_probability'],
        },
        correction_state: 'marked_wrong',
        correction_event_id: 'correct_review_bayes_judge',
        replacement_event_id: null,
      }),
    ]);
    const familyDispatch = [
      output.lookup.observed?.dispatch_seq,
      ...output.causal_neighborhood.direct_children.map((row) => row.dispatch_seq).reverse(),
    ];
    expect(familyDispatch.every((value) => typeof value === 'number')).toBe(true);
    expect(familyDispatch).toEqual([...familyDispatch].sort((a, b) => Number(a) - Number(b)));
    expect(output.causal_neighborhood.direct_children.map((row) => row.event_id)).not.toContain(
      'review_bayes:snapshot:fsrs',
    );
    expect(output.timeline).toHaveLength(5);
    expect(output.timeline_coverage).toMatchObject({
      returned_count: 5,
      has_more: true,
      complete: false,
    });
    expect(output.timeline_scope).toBe('same_question_context_noncausal');

    const checkpoint = await getAttemptContextTool.execute(ctx(), {
      attemptEventId: 'review_bayes:checkpoint:fsrs',
    });
    expect(checkpoint.lookup).toMatchObject({
      status: 'unsupported_event',
      observed: {
        action: 'experimental:grading_checkpoint',
        caused_by_event_id: 'review_bayes',
        evidence: {
          kind: 'grading_checkpoint',
          attempt_event_id: 'review_bayes',
          segment: 'fsrs',
        },
      },
    });
    expect(checkpoint.causal_neighborhood.direct_children).toEqual([
      expect.objectContaining({
        event_id: 'review_bayes:snapshot:fsrs',
        caused_by_event_id: 'review_bayes:checkpoint:fsrs',
        evidence: expect.objectContaining({
          kind: 'state_snapshot',
          attempt_event_id: 'review_bayes',
          fsrs_snapshots: [
            expect.objectContaining({
              subject_kind: 'knowledge',
              subject_id: 'k_probability',
              before: expect.objectContaining({ due: '2026-08-01T03:00:00.000Z' }),
              after: expect.objectContaining({ due: '2026-08-08T03:00:00.000Z' }),
            }),
          ],
        }),
      }),
    ]);
  });

  it('joins linked LearningRecord entries via attempt_event_id', async () => {
    await seedAttemptScenario('att_with_record');
    const db = testDb();
    const now = new Date();
    await db.insert(learning_record).values({
      id: createId(),
      kind: 'mistake',
      title: 'why did I miss this?',
      content_md: '我把助词当成了实词',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'attempt',
      processing_status: 'raw',
      subject_id: 'yuwen',
      knowledge_ids: ['k_xuci'],
      question_id: 'q1',
      attempt_event_id: 'att_with_record',
      created_at: now,
      updated_at: now,
    });

    const output = await getAttemptContextTool.execute(ctx(), {
      attemptEventId: 'att_with_record',
    });
    expect(output.linked_records).toHaveLength(1);
    expect(output.linked_records[0].kind).toBe('mistake');
    expect(output.linked_records[0].title).toBe('why did I miss this?');
  });

  it('summarize folds attempt id + cause + counts', () => {
    const summary = getAttemptContextTool.summarize(
      { attemptEventId: 'att_abcdef123' },
      {
        lookup: {
          requested_event_id: 'att_abcdef123',
          status: 'found',
          observed: {
            event_id: 'att_abcdef123',
            dispatch_seq: 42,
            action: 'attempt',
            subject_kind: 'question',
            subject_id: 'q_zzz12345',
            outcome: 'failure',
            caused_by_event_id: null,
            created_at: '2026-08-01T00:00:00.000Z',
            evidence: null,
            correction_state: 'active',
            correction_event_id: null,
            replacement_event_id: null,
          },
        },
        attempt: {
          event_id: 'att_abcdef123',
          dispatch_seq: 42,
          action: 'attempt',
          outcome: 'failure',
          question_id: 'q_zzz12345',
          answer_md: null,
          answer_image_refs: [],
          referenced_knowledge_ids: [],
          created_at: '2026-08-01T00:00:00.000Z',
          fsrs: null,
        },
        question: null,
        question_availability: 'not_found',
        cause: {
          source: 'agent',
          event_id: 'judge_1',
          primary_category: 'memory',
          secondary_categories: [],
          analysis_md: null,
          user_notes: null,
          confidence: null,
        },
        timeline: [],
        timeline_scope: 'same_question_context_noncausal',
        timeline_coverage: {
          returned_count: 0,
          limit: 10,
          has_more: false,
          complete: true,
        },
        causal_neighborhood: {
          parent: null,
          direct_children: [],
          relation_semantics: 'direct_children_only',
          coverage: {
            returned_count: 0,
            limit: 20,
            total_direct_children: 0,
            has_more: false,
            complete: true,
          },
        },
        linked_records: [],
      },
    );
    expect(summary).toContain('att_abcd');
    expect(summary).toContain('cause=memory');
  });

  it('contract: read / local / mirrorEvent=when_user_visible', () => {
    expect(getAttemptContextTool.effect).toBe('read');
    expect(getAttemptContextTool.costClass).toBe('local');
    expect(getAttemptContextTool.mirrorEvent).toBe('when_user_visible');
  });
});
