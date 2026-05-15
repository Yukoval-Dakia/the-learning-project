import { createId } from '@paralleldrive/cuid2';
import { describe, expect, it, vi } from 'vitest';

import { db } from '@/db/client';
import { dreaming_proposal, knowledge, mistake, question } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { runKnowledgeProposeNightly } from './knowledge_propose_nightly';

describe('knowledge_propose_nightly handler', () => {
  it('processes recent mistakes via runProposeAndWrite (per-mistake try-catch)', async () => {
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

    // Seed question + mistake (created now → within 24h window)
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
    const mId = createId();
    await db.insert(mistake).values({
      id: mId,
      question_id: qId,
      wrong_answer_md: 'wrong',
      source: 'manual',
      knowledge_ids: [kId],
      created_at: now,
      updated_at: now,
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

    // Verify proposal written
    const proposals = await db.select().from(dreaming_proposal);
    const ours = proposals.find(
      (p) =>
        typeof p.payload === 'object' &&
        p.payload !== null &&
        (p.payload as { name?: string }).name === 'NewSubNode',
    );
    expect(ours).toBeTruthy();

    // Cleanup
    await db.delete(dreaming_proposal).where(eq(dreaming_proposal.id, ours?.id ?? ''));
    await db.delete(mistake).where(eq(mistake.id, mId));
    await db.delete(question).where(eq(question.id, qId));
    await db.delete(knowledge).where(eq(knowledge.id, kId));
  });

  it('skips mistakes older than 24 hours', async () => {
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
    const mId = createId();
    await db.insert(mistake).values({
      id: mId,
      question_id: qId,
      wrong_answer_md: 'wrong',
      source: 'manual',
      knowledge_ids: [],
      created_at: oldDate,
      updated_at: oldDate,
    });

    // Force update created_at to bypass default
    await db.execute(
      sql`UPDATE mistake SET created_at = ${oldDate.toISOString()} WHERE id = ${mId}`,
    );

    const runTaskFn = vi.fn(async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: '{"proposals":[]}',
    }));
    const result = await runKnowledgeProposeNightly(db, { runTaskFn });

    // The old mistake shouldn't be picked up
    const callsForOldMistake = runTaskFn.mock.calls.filter((c) =>
      JSON.stringify(c[1]).includes(mId),
    );
    expect(callsForOldMistake.length).toBe(0);
    expect(result.processed).toBe(0);

    await db.delete(mistake).where(eq(mistake.id, mId));
    await db.delete(question).where(eq(question.id, qId));
  });
});
