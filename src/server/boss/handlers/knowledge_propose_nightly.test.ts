import { createId } from '@paralleldrive/cuid2';
import { describe, expect, it, vi } from 'vitest';

import { db } from '@/db/client';
import { event, knowledge, question } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { runKnowledgeProposeNightly } from './knowledge_propose_nightly';

describe('knowledge_propose_nightly handler', () => {
  it('processes recent failure attempts via runProposeAndWrite (per-attempt try-catch)', async () => {
    // Seed knowledge node so propose has a tree
    const kId = createId();
    const now = new Date();
    await db.insert(knowledge).values({
      id: kId,
      name: 'TestKnowledge',
      domain: 'wenyan',
      parent_id: null,
      created_at: now,
      updated_at: now,
    });

    // Seed question + attempt event (within 24h window)
    const qId = createId();
    await db.insert(question).values({
      id: qId,
      kind: 'short_answer',
      prompt_md: 'test prompt',
      reference_md: null,
      source: 'manual',
      created_at: now,
      updated_at: now,
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
      payload: {
        answer_md: 'wrong',
        answer_image_refs: [],
        referenced_knowledge_ids: [kId],
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: now,
    });

    // Mock runTaskFn that returns valid propose output
    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        proposals: [{ name: 'NewSubNode', parent_id: kId, reasoning: 'because reasons' }],
      }),
    }));

    const result = await runKnowledgeProposeNightly(db, { runTaskFn });
    expect(result.processed).toBeGreaterThanOrEqual(1);
    expect(runTaskFn).toHaveBeenCalled();

    // Verify propose event written (event-based proposals post-Step-9)
    const proposals = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge')));
    const ours = proposals.find(
      (p) =>
        typeof p.payload === 'object' &&
        p.payload !== null &&
        (p.payload as { name?: string }).name === 'NewSubNode',
    );
    expect(ours).toBeTruthy();

    // Cleanup
    if (ours?.id) {
      await db.delete(event).where(eq(event.id, ours.id));
    }
    await db.delete(event).where(eq(event.id, attemptId));
    await db.delete(question).where(eq(question.id, qId));
    await db.delete(knowledge).where(eq(knowledge.id, kId));
  });

  it('skips failure attempts older than 24 hours', async () => {
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48h ago

    const qId = createId();
    await db.insert(question).values({
      id: qId,
      kind: 'short_answer',
      prompt_md: 'old prompt',
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
      payload: {
        answer_md: 'wrong',
        answer_image_refs: [],
        referenced_knowledge_ids: [],
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: oldDate,
    });

    const runTaskFn = vi.fn(async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: '{"proposals":[]}',
    }));
    const result = await runKnowledgeProposeNightly(db, { runTaskFn });

    // The old event shouldn't be picked up
    const callsForOldAttempt = runTaskFn.mock.calls.filter((c) =>
      JSON.stringify(c[1]).includes(qId),
    );
    expect(callsForOldAttempt.length).toBe(0);
    expect(result.processed).toBe(0);

    await db.delete(event).where(eq(event.id, attemptId));
    await db.delete(question).where(eq(question.id, qId));
  });
});
