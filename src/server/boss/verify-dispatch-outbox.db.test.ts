import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  VERIFY_DISPATCH_COMPLETE_ACTION,
  dispatchPendingVerifyIntents,
  writeVerifyDispatchIntent,
} from '@/capabilities/practice/public';
import { db } from '@/db/client';
import { event, question } from '@/db/schema';
import { resetDb } from '../../../tests/helpers/db';

// The un-versioned id the outbox used before intent ids were version-scoped. A stale intent left by
// a different schema version lands here — the same id the synthesizer would reuse if it were not
// version-scoped — so seeding at this id proves the valid replacement does not collide with it.
function _legacyUnscopedIntentId(questionId: string, verifier: 'quiz_verify' | 'source_verify') {
  return `verify-dispatch-intent-${createHash('sha256').update(`${verifier}\0${questionId}`).digest('hex')}`;
}

async function seedQuestion(
  id: string,
  source: 'quiz_gen' | 'web_sourced',
  over: Partial<typeof question.$inferInsert> = {},
) {
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: id,
    source,
    draft_status: 'draft',
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  });
}

async function seedIntent(questionId: string, verifier: 'quiz_verify' | 'source_verify') {
  await writeVerifyDispatchIntent(db, { questionId, verifier });
}

describe('verify dispatch outbox (YUK-700)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('locks intents so concurrent recovery emits one verifier job per question + kind', async () => {
    await Promise.all([seedQuestion('q-c1', 'quiz_gen'), seedQuestion('q-c2', 'quiz_gen')]);
    await Promise.all([seedIntent('q-c1', 'quiz_verify'), seedIntent('q-c2', 'quiz_verify')]);
    const batches: string[][] = [];
    const enqueue = vi.fn(async (_verifier: string, ids: string[]) => {
      batches.push(ids);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    await Promise.all([
      dispatchPendingVerifyIntents(db, { enqueue }),
      dispatchPendingVerifyIntents(db, { enqueue }),
    ]);

    expect(batches.flat().sort()).toEqual(['q-c1', 'q-c2']);
    const completions = await db
      .select({ subjectId: event.subject_id })
      .from(event)
      .where(
        and(
          eq(event.action, VERIFY_DISPATCH_COMPLETE_ACTION),
          inArray(event.subject_id, ['q-c1', 'q-c2']),
        ),
      );
    expect(completions).toHaveLength(2);
  });
});
