import { knowledge, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
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
    domain: 'yuwen',
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
  const id = createId();
  await writeEvent(testDb(), {
    id,
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
  return id;
}

async function seedExperimentalEvent(input: {
  id: string;
  action: string;
  subjectId?: string;
  causedByEventId?: string | null;
  createdAt: Date;
}) {
  await writeEvent(testDb(), {
    id: input.id,
    session_id: null,
    actor_kind: 'system',
    actor_ref: 'burnin_fixture',
    action: input.action,
    subject_kind: 'event',
    subject_id: input.subjectId ?? input.id,
    outcome: 'success',
    payload: {
      fixture: 'YUK-832',
      nested: {
        proof: ['exact-action', 'causal-family', 'bounded-window'],
        ambiguity: 'the id may contain attempt without being action=attempt',
      },
    },
    caused_by_event_id: input.causedByEventId ?? null,
    created_at: input.createdAt,
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
    expect(output.match_semantics.action).toBe('exact');
  });

  it('matches event id and action exactly rather than inferring action from an id prefix', async () => {
    const at = new Date('2026-07-31T00:31:14.848Z');
    await seedAttempt('attempt_exact');
    await seedExperimentalEvent({
      id: 'input_attempt_yuk792_canary_b',
      action: 'experimental:self_authored_gate_input',
      createdAt: at,
    });
    await seedExperimentalEvent({
      id: 'attempt_shadow',
      action: 'experimental:attempt_shadow',
      createdAt: at,
    });

    const exactAction = await queryEventsTool.execute(ctx(), {
      filter: { action: 'attempt', limit: 50 },
    });
    expect(exactAction.events.map((row) => row.id)).toEqual(['attempt_exact']);
    expect(exactAction.match_semantics.action).toBe('exact');

    const exactId = await queryEventsTool.execute(ctx(), {
      filter: { eventId: 'input_attempt_yuk792_canary_b' },
    });
    expect(exactId.events).toHaveLength(1);
    expect(exactId.events[0]).toMatchObject({
      id: 'input_attempt_yuk792_canary_b',
      action: 'experimental:self_authored_gate_input',
      created_at: at.toISOString(),
    });
    expect(exactId.events[0].dispatch_seq).toBeTypeOf('number');
    expect(exactId.match_semantics.event_id).toBe('exact');
  });

  it('projects correction state so an exact read cannot present retracted evidence as active', async () => {
    await seedAttempt('attempt_with_retracted_judge');
    const judgeId = await seedJudge('attempt_with_retracted_judge');
    await writeEvent(testDb(), {
      id: 'correction_retract_judge',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: judgeId,
      outcome: 'success',
      payload: {
        correction_kind: 'retract',
        reason_md: 'The attribution used incomplete evidence and must not be treated as current.',
        affected_refs: [{ kind: 'question', id: 'q1' }],
      },
      created_at: new Date(),
    });

    const output = await queryEventsTool.execute(ctx(), { filter: { eventId: judgeId } });
    expect(output.events).toEqual([
      expect.objectContaining({
        id: judgeId,
        action: 'judge',
        correction_state: 'retracted',
        correction_event_id: 'correction_retract_judge',
        replacement_event_id: null,
      }),
    ]);
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
    expect(output.relation_applied).toMatchObject({
      kind: 'direct_children',
      parent_event_id: 'att_chain',
      status: 'applied',
    });
    expect(output.match_semantics.caused_by).toBe('direct_children_only');
  });

  it('reads causal siblings from their shared non-null parent without treating grandchildren as siblings', async () => {
    const at = new Date('2026-07-31T02:51:12.154Z');
    await seedExperimentalEvent({
      id: 'review_root',
      action: 'experimental:review_root',
      createdAt: at,
    });
    await seedExperimentalEvent({
      id: 'judge_child',
      action: 'experimental:judge_child',
      causedByEventId: 'review_root',
      createdAt: at,
    });
    await seedExperimentalEvent({
      id: 'checkpoint_theta',
      action: 'experimental:grading_checkpoint_theta',
      causedByEventId: 'review_root',
      createdAt: at,
    });
    await seedExperimentalEvent({
      id: 'checkpoint_fsrs',
      action: 'experimental:grading_checkpoint_fsrs',
      causedByEventId: 'review_root',
      createdAt: at,
    });
    await seedExperimentalEvent({
      id: 'snapshot_fsrs',
      action: 'experimental:state_snapshot_fixture',
      causedByEventId: 'checkpoint_fsrs',
      createdAt: at,
    });

    const siblings = await queryEventsTool.execute(ctx(), {
      filter: { siblingOfEventId: 'judge_child', limit: 50 },
    });
    expect(siblings.events.map((row) => row.id)).toEqual(['checkpoint_fsrs', 'checkpoint_theta']);
    expect(siblings.relation_applied).toEqual({
      kind: 'siblings',
      focal_event_id: 'judge_child',
      parent_event_id: 'review_root',
      status: 'applied',
    });
    expect(siblings.match_semantics.sibling).toBe('same_non_null_parent_excludes_focal');

    const judgeChildren = await queryEventsTool.execute(ctx(), {
      filter: { causedByEventId: 'judge_child', limit: 50 },
    });
    expect(judgeChildren.events).toEqual([]);
    expect(judgeChildren.coverage.complete_for_window).toBe(true);

    const checkpointChildren = await queryEventsTool.execute(ctx(), {
      filter: { causedByEventId: 'checkpoint_fsrs', limit: 50 },
    });
    expect(checkpointChildren.events.map((row) => row.id)).toEqual(['snapshot_fsrs']);

    const rootHasNoSiblings = await queryEventsTool.execute(ctx(), {
      filter: { siblingOfEventId: 'review_root' },
    });
    expect(rootHasNoSiblings.events).toEqual([]);
    expect(rootHasNoSiblings.relation_applied.status).toBe('focal_has_no_parent');
  });

  it('paginates a same-timestamp bounded window with a stable dispatch-sequence keyset', async () => {
    const at = new Date('2026-08-01T08:00:00.000Z');
    for (let index = 0; index < 23; index += 1) {
      await seedExperimentalEvent({
        id: `audit_event_${String(index).padStart(2, '0')}`,
        action: 'experimental:bounded_audit_fixture',
        createdAt: at,
      });
    }

    const first = await queryEventsTool.execute(ctx(), {
      filter: { action: 'experimental:bounded_audit_fixture', limit: 10 },
    });
    expect(first.events).toHaveLength(10);
    expect(first.coverage).toMatchObject({
      returned_count: 10,
      limit: 10,
      has_more: true,
      complete_for_window: false,
    });
    expect(first.coverage.next_cursor).not.toBeNull();

    // A legitimate backfill after page 1 has an older created_at but a newer
    // dispatch_seq. It must not enter this already-started enumeration.
    await seedExperimentalEvent({
      id: 'audit_event_backfilled_later',
      action: 'experimental:bounded_audit_fixture',
      createdAt: new Date(at.getTime() - 1),
    });

    const second = await queryEventsTool.execute(ctx(), {
      filter: { action: 'experimental:bounded_audit_fixture', limit: 10 },
      cursor: first.coverage.next_cursor ?? undefined,
    });
    const third = await queryEventsTool.execute(ctx(), {
      filter: { action: 'experimental:bounded_audit_fixture', limit: 10 },
      cursor: second.coverage.next_cursor ?? undefined,
    });
    expect(second.events).toHaveLength(10);
    expect(second.coverage.has_more).toBe(true);
    expect(third.events).toHaveLength(3);
    expect(third.coverage).toMatchObject({ has_more: false, complete_for_window: true });

    const ids = [...first.events, ...second.events, ...third.events].map((row) => row.id);
    expect(ids).toHaveLength(23);
    expect(new Set(ids).size).toBe(23);
    expect(ids).toEqual([...ids].sort().reverse());
    expect(ids).not.toContain('audit_event_backfilled_later');

    await expect(
      queryEventsTool.execute(ctx(), {
        filter: { action: 'experimental:different_filter', limit: 10 },
        cursor: first.coverage.next_cursor ?? undefined,
      }),
    ).rejects.toThrow('same event filters');
  });

  it('pins the sinceDays window in the cursor when wall-clock time advances between pages', async () => {
    const at = new Date('2026-08-01T12:00:00.000Z');
    for (let index = 0; index < 3; index += 1) {
      await seedExperimentalEvent({
        id: `clock_page_${index}`,
        action: 'experimental:clock_window_fixture',
        createdAt: at,
      });
    }

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-08-02T00:00:00.000Z'));
      const first = await queryEventsTool.execute(ctx(), {
        filter: { action: 'experimental:clock_window_fixture', sinceDays: 1, limit: 1 },
      });
      expect(first.coverage.has_more).toBe(true);

      vi.setSystemTime(new Date('2026-08-03T00:00:00.000Z'));
      const second = await queryEventsTool.execute(ctx(), {
        filter: { action: 'experimental:clock_window_fixture', sinceDays: 1, limit: 1 },
        cursor: first.coverage.next_cursor ?? undefined,
      });
      expect(second.events).toHaveLength(1);
      expect(second.coverage.observed_at).toBe(first.coverage.observed_at);
      expect(second.coverage.window_start).toBe(first.coverage.window_start);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses observed_at as a hard upper bound instead of returning future-dated evidence', async () => {
    await seedExperimentalEvent({
      id: 'observed_before',
      action: 'experimental:observation_boundary_fixture',
      createdAt: new Date('2026-08-01T23:59:59.000Z'),
    });
    await seedExperimentalEvent({
      id: 'future_after_observation',
      action: 'experimental:observation_boundary_fixture',
      createdAt: new Date('2026-08-03T00:00:00.000Z'),
    });

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-08-02T00:00:00.000Z'));
      const output = await queryEventsTool.execute(ctx(), {
        filter: { action: 'experimental:observation_boundary_fixture', limit: 50 },
      });
      expect(output.events.map((row) => row.id)).toEqual(['observed_before']);
      expect(output.coverage.observed_at).toBe('2026-08-02T00:00:00.000Z');
      expect(output.coverage.complete_for_window).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
        match_semantics: {
          action: 'exact',
          event_id: 'exact',
          caused_by: 'direct_children_only',
          sibling: 'same_non_null_parent_excludes_focal',
        },
        relation_applied: { kind: 'none', status: 'not_requested' },
        coverage: {
          returned_count: 3,
          limit: 20,
          has_more: false,
          complete_for_window: true,
          next_cursor: null,
          order: 'created_at_desc_dispatch_seq_desc_id_desc',
          observed_at: '2026-08-01T08:00:00.000Z',
          observed_dispatch_seq: 42,
          window_start: '2026-07-25T08:00:00.000Z',
        },
      },
    );
    expect(summary).toContain('events');
    expect(summary).toContain('3 rows');
    expect(summary).toContain('action=attempt');
    expect(summary).toContain('since≤7d');
  });

  it('contract: effect / costClass / mirrorEvent', () => {
    expect(queryEventsTool.inputSchema).toBeInstanceOf(z.ZodObject);
    expect(queryEventsTool.effect).toBe('read');
    expect(queryEventsTool.costClass).toBe('local');
    expect(queryEventsTool.mirrorEvent).toBe('when_user_visible');
  });
});
