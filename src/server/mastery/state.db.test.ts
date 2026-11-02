// B1-W1 (ADR-0035) — mastery_state single-owner + θ̂ 接线层 db tests.

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { knowledge, mastery_state, question } from '@/db/schema';
import { updateThetaForAttempt } from '@/kernel/records/mastery-state';
import { resetDb } from '../../../tests/helpers/db';

async function seedKnowledge(id: string) {
  const now = new Date();
  await db
    .insert(knowledge)
    .values({
      id,
      name: `K-${id}`,
      domain: 'yuwen',
      parent_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

async function seedQuestion(id: string, knowledgeIds: string[], difficulty = 3) {
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `Prompt ${id}`,
    reference_md: null,
    knowledge_ids: knowledgeIds,
    difficulty,
    source: 'manual',
    variant_depth: 0,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function readState(knowledgeId: string) {
  const rows = await db
    .select()
    .from(mastery_state)
    .where(
      and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, knowledgeId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

// A2 (YUK-434) — seed a root knowledge node with an explicit domain (the canonical
describe('updateThetaForAttempt', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('single KC, correct answer: θ̂ rises, counts advance, evidence increments', async () => {
    const k = createId();
    const q = createId();
    await seedKnowledge(k);
    await seedQuestion(q, [k]);

    await db.transaction(async (tx) => {
      await updateThetaForAttempt(tx, {
        knowledgeIds: [k],
        questionId: q,
        outcome: 1,
        difficulty: 3, // → b=0 proxy
        attemptEventId: newId(),
        now: new Date(),
      });
    });

    const row = await readState(k);
    expect(row).not.toBeNull();
    expect(row?.theta_hat).toBeGreaterThan(0); // correct → θ̂ up
    expect(row?.evidence_count).toBe(1);
    expect(row?.success_count).toBe(1);
    expect(row?.fail_count).toBe(0);
  });
});
