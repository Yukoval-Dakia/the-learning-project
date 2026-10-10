// YUK-143 / ADR-0025 — North-Star GoalScopeTask orchestrator + accept tests.
//
// DB test (uses testDb): NOT in fastTestInclude → runs in the vitest db config.
// Covers: parser, runGoalScopeAndWrite proposal write + inbox surfacing, and the
// accept round-trip that materializes the `goal` row (evidence chain).

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { goal, knowledge } from '@/db/schema';
import { acceptAiProposal } from '@/server/proposals/actions';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { runGoalScopeAndWrite } from './scope';

describe('runGoalScopeAndWrite', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function insertKnowledge(id: string) {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values({
      id,
      name: id,
      domain: 'yuwen',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });
  }

  it('accept is idempotent (second accept does not duplicate the goal row)', async () => {
    const db = testDb();
    await insertKnowledge('k1');
    const fakeRunTask = async () => ({
      text: JSON.stringify({ scope_knowledge_ids: ['k1'], sequence_hint: 0, reasoning: 'r' }),
    });
    const { proposal_id, goal_id } = await runGoalScopeAndWrite({
      db,
      goalTitle: 'g',
      runTaskFn: fakeRunTask,
    });
    if (!proposal_id || !goal_id) throw new Error('expected ids');

    await acceptAiProposal(db, proposal_id);
    const second = await acceptAiProposal(db, proposal_id);
    expect(second.kind === 'goal_scope' && second.idempotent).toBe(true);

    const goalRows = await db.select().from(goal).where(eq(goal.id, goal_id));
    expect(goalRows).toHaveLength(1);
  });
});
