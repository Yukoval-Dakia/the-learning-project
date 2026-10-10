// listActiveGoalsWithResolvedScope DB test — YUK-603 (v2 contract §5.3 read path).
//
// The four goal-strand readers (coach_daily / dreaming_nightly / due-list rerank /
// learner-state) consumed listActiveGoals' FROZEN scope column directly — no live tier at
// all — so a subject goal's pinned [seed:*:root] scope silently no-op'd all of them. They
// now default to THIS resolved read: explicit → frozen passthrough; subject_live →
// resolveSubjectKnowledgeIds per DISTINCT subject (one resolve per subject, Map-deduped).

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { goal } from '@/db/schema';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { createManualGoal } from './commands';
import { updateGoalStatus } from './queries';

const db = testDb();

beforeEach(() => resetDb());

const now = new Date();
const kBase = {
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  created_at: now,
  updated_at: now,
  version: 0,
};

describe('goal mutation command concurrency (YUK-952)', () => {
  it('orders mutations by ownership even when the later owner receives an older request timestamp', async () => {
    const start = new Date('2026-09-01T00:00:00Z');
    const goalId = await createManualGoal(db, {
      title: '时序相反但两次意图都应保留',
      scope_knowledge_ids: ['kc-a', 'kc-b'],
      sequence_hint: 2,
      now: start,
    });
    await updateGoalStatus(db, goalId, 'done', new Date(start.getTime() + 2_000));
    await updateGoalStatus(db, goalId, 'dormant', new Date(start.getTime() + 1_000));
    const [row] = await db.select().from(goal).where(eq(goal.id, goalId));
    expect(row).toMatchObject({ status: 'dormant', version: 2 });
    expect(row.updated_at.getTime()).toBeGreaterThan(start.getTime() + 2_000);
  });
});
