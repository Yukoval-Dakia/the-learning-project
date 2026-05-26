import { knowledge, learning_record, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
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

async function seedAttemptScenario(attemptId: string, qid = 'q1') {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id: 'k_xuci',
    name: '虚词',
    domain: 'wenyan',
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
    expect(output.attempt.event_id).toBe('att_full');
    expect(output.attempt.question_id).toBe('q1');
    expect(output.question?.id).toBe('q1');
    expect(output.question?.knowledge_ids).toEqual(['k_xuci']);
    expect(output.cause?.primary_category).toBe('concept');
    expect(output.cause?.source).toBe('agent');
    expect(output.timeline.length).toBeGreaterThanOrEqual(1);
    expect(output.timeline[0].kind).toBe('attempt');
  });

  it('returns empty cause / null question when attempt event id does not exist', async () => {
    const output = await getAttemptContextTool.execute(ctx(), {
      attemptEventId: 'nope',
    });
    expect(output.attempt.question_id).toBe('');
    expect(output.question).toBeNull();
    expect(output.cause).toBeNull();
    expect(output.timeline).toEqual([]);
    expect(output.linked_records).toEqual([]);
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
      subject_id: 'wenyan',
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
        attempt: {
          event_id: 'att_abcdef123',
          question_id: 'q_zzz12345',
          answer_md: null,
          answer_image_refs: [],
          referenced_knowledge_ids: [],
          created_at: 'now',
        },
        question: null,
        cause: {
          source: 'agent',
          primary_category: 'memory',
          secondary_categories: [],
          analysis_md: null,
          user_notes: null,
          confidence: null,
        },
        timeline: [],
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
