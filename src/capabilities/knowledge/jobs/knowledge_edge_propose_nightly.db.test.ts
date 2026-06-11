import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db/client';
import { event, knowledge, question } from '@/db/schema';
import { resetDb } from '../../../../tests/helpers/db';
import { runKnowledgeEdgeProposeNightly } from './knowledge_edge_propose_nightly';

describe('knowledge_edge_propose_nightly handler', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns empty stats when no failure attempts in window', async () => {
    const runTaskFn = vi.fn(async () => ({ text: '{"proposals":[]}' }));
    const result = await runKnowledgeEdgeProposeNightly(db, { runTaskFn });
    expect(result.attempts_considered).toBe(0);
    expect(result.proposed).toBe(0);
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('runs propose pass once across the batch of recent failures', async () => {
    const k1 = createId();
    const k2 = createId();
    const now = new Date();
    await db.insert(knowledge).values([
      {
        id: k1,
        name: 'K1',
        domain: 'math',
        parent_id: null,
        created_at: now,
        updated_at: now,
      },
      {
        id: k2,
        name: 'K2',
        domain: 'math',
        parent_id: null,
        created_at: now,
        updated_at: now,
      },
    ]);

    // P5.4 §5-Q5 / YUK-175 — the batch path now runs the L1 rubric floor before
    // a live write. A `related_to` edge needs STRONG (≥2 same-pattern in-window
    // judge-backed failures) endpoint-touching evidence, so seed two judge-backed
    // failures referencing k1/k2 with the same cause category.
    const qIds = [createId(), createId()];
    const attemptIds = [createId(), createId()];
    for (let i = 0; i < 2; i++) {
      await db.insert(question).values({
        id: qIds[i],
        kind: 'short_answer',
        prompt_md: 'p',
        reference_md: null,
        knowledge_ids: [k1, k2],
        source: 'manual',
        created_at: now,
        updated_at: now,
      });
      await db.insert(event).values({
        id: attemptIds[i],
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: qIds[i],
        outcome: 'failure',
        payload: {
          answer_md: 'w',
          answer_image_refs: [],
          referenced_knowledge_ids: [k1, k2],
        },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: now,
      });
      await db.insert(event).values({
        id: `judge_${attemptIds[i]}`,
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'attribution',
        action: 'judge',
        subject_kind: 'event',
        subject_id: attemptIds[i],
        outcome: 'success',
        payload: {
          cause: {
            primary_category: 'concept',
            secondary_categories: [],
            analysis_md: '反复混淆 K1 与 K2。',
            confidence: 0.9,
          },
          referenced_knowledge_ids: [k1, k2],
        },
        caused_by_event_id: attemptIds[i],
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date(now.getTime() + 500),
      });
    }

    const runTaskFn = vi.fn(async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: k1,
            to_knowledge_id: k2,
            relation_type: 'related_to',
            weight: 0.6,
            reasoning: `attempt ${attemptIds[0]} judge cause concept：K1/K2 反复失败。`,
          },
        ],
      }),
    }));

    const result = await runKnowledgeEdgeProposeNightly(db, { runTaskFn });
    expect(result.attempts_considered).toBe(2);
    expect(result.proposed).toBe(1);
    expect(result.folded_rubric_rejected).toBe(0);
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect(runTaskFn.mock.calls[0]?.[2]).toMatchObject({
      subjectProfile: { id: 'math' },
    });

    // Verify event written
    const events = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ours = events.find((e) => {
      const p = e.payload as { from_knowledge_id?: string; to_knowledge_id?: string };
      return p.from_knowledge_id === k1 && p.to_knowledge_id === k2;
    });
    expect(ours).toBeTruthy();

    // Cleanup
    if (ours?.id) {
      await db.delete(event).where(eq(event.id, ours.id));
    }
    for (let i = 0; i < 2; i++) {
      await db.delete(event).where(eq(event.id, `judge_${attemptIds[i]}`));
      await db.delete(event).where(eq(event.id, attemptIds[i]));
      await db.delete(question).where(eq(question.id, qIds[i]));
    }
    await db.delete(knowledge).where(eq(knowledge.id, k1));
    await db.delete(knowledge).where(eq(knowledge.id, k2));
  });

  it('skips failure attempts older than 24h', async () => {
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const qId = createId();
    await db.insert(question).values({
      id: qId,
      kind: 'short_answer',
      prompt_md: 'p',
      reference_md: null,
      source: 'manual',
      created_at: oldDate,
      updated_at: oldDate,
    });
    const attemptId = createId();
    await db.insert(event).values({
      id: attemptId,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: qId,
      outcome: 'failure',
      payload: { answer_md: 'w', answer_image_refs: [], referenced_knowledge_ids: [] },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: oldDate,
    });

    const runTaskFn = vi.fn(async () => ({ text: '{"proposals":[]}' }));
    const result = await runKnowledgeEdgeProposeNightly(db, { runTaskFn });
    expect(result.attempts_considered).toBe(0);
    expect(runTaskFn).not.toHaveBeenCalled();

    await db.delete(event).where(eq(event.id, attemptId));
    await db.delete(question).where(eq(question.id, qId));
  });
});
