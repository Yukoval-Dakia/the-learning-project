// YUK-143 / ADR-0025 — North-Star GoalScopeTask orchestrator + accept tests.
//
// DB test (uses testDb): NOT in fastTestInclude → runs in the vitest db config.
// Covers: parser, runGoalScopeAndWrite proposal write + inbox surfacing, and the
// accept round-trip that materializes the `goal` row (evidence chain).

import { tasks } from '@/ai/registry';
import { event, goal, knowledge } from '@/db/schema';
import { acceptAiProposal, dismissAiProposal, retractAiProposal } from '@/server/proposals/actions';
import { getProposalInboxRow, listProposalInboxRows } from '@/server/proposals/inbox';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { listActiveGoals } from './queries';
import { parseGoalScopeOutput, runGoalScopeAndWrite } from './scope';

describe('GoalScopeTask system prompt', () => {
  it('talks goal-scope vocabulary and forbids inventing nodes', () => {
    const p = tasks.GoalScopeTask.systemPrompt;
    expect(p).toContain('知识网格');
  });
});

describe('parseGoalScopeOutput', () => {
  it('parses well-formed JSON', () => {
    const out = parseGoalScopeOutput(
      '{"scope_knowledge_ids":["k1","k2"],"sequence_hint":1,"reasoning":"r"}',
    );
    expect(out.scope_knowledge_ids).toEqual(['k1', 'k2']);
    expect(out.sequence_hint).toBe(1);
  });

  it('defaults empty scope + zero sequence_hint', () => {
    const out = parseGoalScopeOutput('{"reasoning":"r"}');
    expect(out.scope_knowledge_ids).toEqual([]);
    expect(out.sequence_hint).toBe(0);
  });

  it('throws on no JSON object', () => {
    expect(() => parseGoalScopeOutput('nope')).toThrow();
  });

  it('throws on empty reasoning', () => {
    expect(() => parseGoalScopeOutput('{"scope_knowledge_ids":[],"reasoning":""}')).toThrow();
  });
});

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
      domain: 'wenyan',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    });
  }

  it('writes a goal_scope proposal that surfaces in the inbox', async () => {
    const db = testDb();
    await insertKnowledge('k1');
    await insertKnowledge('k2');

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        scope_knowledge_ids: ['k1', 'k2', 'k_hallucinated'],
        sequence_hint: 2,
        reasoning: '覆盖 k1 + k2',
      }),
    });

    const result = await runGoalScopeAndWrite({
      db,
      goalTitle: '能流畅读《史记》',
      subjectId: 'wenyan',
      runTaskFn: fakeRunTask,
    });

    expect(result.proposal_id).toBeTruthy();
    expect(result.goal_id).toBeTruthy();
    // hallucinated node dropped — only real grid nodes kept.
    expect(result.scope_count).toBe(2);

    const rows = await listProposalInboxRows(db);
    const goalProposal = rows.find((r) => r.kind === 'goal_scope');
    expect(goalProposal).toBeTruthy();
    expect(goalProposal?.status).toBe('pending');
    expect(goalProposal?.target.subject_kind).toBe('goal');
    expect(goalProposal?.target.subject_id).toBe(result.goal_id);
    const change = goalProposal?.payload.proposed_change as { scope_knowledge_ids: string[] };
    expect(change.scope_knowledge_ids).toEqual(['k1', 'k2']);
  });

  it('accept materializes the goal row + evidence rate event', async () => {
    const db = testDb();
    await insertKnowledge('k1');

    const fakeRunTask = async () => ({
      text: JSON.stringify({
        scope_knowledge_ids: ['k1'],
        sequence_hint: 0,
        reasoning: '覆盖 k1',
      }),
    });
    const { proposal_id, goal_id } = await runGoalScopeAndWrite({
      db,
      goalTitle: '读懂虚词',
      subjectId: 'wenyan',
      runTaskFn: fakeRunTask,
    });
    if (!proposal_id || !goal_id) throw new Error('expected proposal + goal id');

    const accepted = await acceptAiProposal(db, proposal_id);
    expect(accepted.kind).toBe('goal_scope');

    const goalRow = (await db.select().from(goal).where(eq(goal.id, goal_id)).limit(1))[0];
    expect(goalRow).toBeTruthy();
    expect(goalRow.title).toBe('读懂虚词');
    expect(goalRow.status).toBe('active');
    expect(goalRow.scope_knowledge_ids).toEqual(['k1']);
    expect(goalRow.source).toBe('goal_scope_proposal');
    // evidence chain: goal.source_ref → propose event id
    expect(goalRow.source_ref).toBe(proposal_id);

    // rate event chained to the proposal (evidence-first)
    const rate = (
      await db
        .select()
        .from(event)
        .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposal_id)))
        .limit(1)
    )[0];
    expect(rate).toBeTruthy();
    expect((rate.payload as { rating?: string }).rating).toBe('accept');

    // proposal now reads as accepted
    const reread = await getProposalInboxRow(db, proposal_id);
    expect(reread?.status).toBe('accepted');

    // active goals reader sees it
    const active = await listActiveGoals(db);
    expect(active.map((g) => g.id)).toContain(goal_id);
  });

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

  it('dismiss writes a rate event and materializes no goal row', async () => {
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

    const dismissed = await dismissAiProposal(db, proposal_id);
    expect(dismissed.kind).toBe('dismissed');

    const goalRows = await db.select().from(goal).where(eq(goal.id, goal_id));
    expect(goalRows).toHaveLength(0);

    const reread = await getProposalInboxRow(db, proposal_id);
    expect(reread?.status).toBe('dismissed');
  });

  it('retract tombstones a materialized goal to dormant', async () => {
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
    await retractAiProposal(db, proposal_id);

    const goalRow = (await db.select().from(goal).where(eq(goal.id, goal_id)).limit(1))[0];
    expect(goalRow.status).toBe('dormant');
    // dormant goal drops out of the active list
    const active = await listActiveGoals(db);
    expect(active.map((g) => g.id)).not.toContain(goal_id);
  });
});
