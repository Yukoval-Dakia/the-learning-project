import { knowledge, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { queryEventsTool } from './query-events';
import type { ToolContext } from './types';

function ctx(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_qe',
    callerActor: { kind: 'agent', ref: 'agent:copilot' },
  };
}

async function seedBaseGraph() {
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
    id: 'q1',
    kind: 'short_answer',
    prompt_md: 'p',
    reference_md: 'r',
    source: 'manual',
    knowledge_ids: ['k_xuci'],
    created_at: now,
    updated_at: now,
  });
}

async function seedAttempt(id: string, outcome: 'success' | 'failure' = 'failure') {
  await writeEvent(testDb(), {
    id,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q1',
    outcome,
    payload: {
      answer_md: 'a',
      answer_image_refs: [],
      referenced_knowledge_ids: ['k_xuci'],
    },
    created_at: new Date(),
  });
}

async function seedJudge(attemptId: string) {
  await writeEvent(testDb(), {
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
        secondary_categories: [],
        analysis_md: 'agent says concept',
        confidence: 0.8,
      },
      referenced_knowledge_ids: ['k_xuci'],
    },
    created_at: new Date(),
  });
}

describe('queryEventsTool', () => {
  beforeEach(async () => {
    await resetDb();
    await seedBaseGraph();
  });

  it('returns recent events with default 20-limit when no filter', async () => {
    await seedAttempt('att_1');
    await seedAttempt('att_2');
    const output = await queryEventsTool.execute(ctx(), {});
    expect(output.total).toBe(2);
    expect(output.events.every((e) => e.action === 'attempt')).toBe(true);
    expect(output.filter_applied.limit).toBe(20);
  });

  it('filters by action', async () => {
    await seedAttempt('att_1');
    await seedJudge('att_1');
    const output = await queryEventsTool.execute(ctx(), { filter: { action: 'judge' } });
    expect(output.total).toBe(1);
    expect(output.events[0].action).toBe('judge');
    expect(output.events[0].caused_by_event_id).toBe('att_1');
  });

  it('filters by actorKind', async () => {
    await seedAttempt('att_1');
    await seedJudge('att_1');
    const output = await queryEventsTool.execute(ctx(), { filter: { actorKind: 'agent' } });
    expect(output.total).toBe(1);
    expect(output.events[0].actor_kind).toBe('agent');
  });

  it('filters by causedByEventId (chain navigation)', async () => {
    await seedAttempt('att_chain');
    await seedJudge('att_chain');
    const output = await queryEventsTool.execute(ctx(), {
      filter: { causedByEventId: 'att_chain' },
    });
    expect(output.total).toBe(1);
    expect(output.events[0].caused_by_event_id).toBe('att_chain');
    expect(output.filter_applied.causedByEventId).toBe('att_chain');
  });

  it('caps limit at 50 via Zod', async () => {
    await expect(queryEventsTool.execute(ctx(), { filter: { limit: 100 } })).rejects.toThrow();
  });

  it('summarize formats folded line', () => {
    const summary = queryEventsTool.summarize(
      { filter: { action: 'attempt', sinceDays: 7 } },
      {
        events: [],
        total: 3,
        filter_applied: { limit: 20 } as Record<string, unknown>,
      },
    );
    expect(summary).toContain('events');
    expect(summary).toContain('3 rows');
    expect(summary).toContain('action=attempt');
    expect(summary).toContain('since≤7d');
  });

  it('contract: effect / costClass / mirrorEvent', () => {
    expect(queryEventsTool.effect).toBe('read');
    expect(queryEventsTool.costClass).toBe('local');
    expect(queryEventsTool.mirrorEvent).toBe('when_user_visible');
  });
});
