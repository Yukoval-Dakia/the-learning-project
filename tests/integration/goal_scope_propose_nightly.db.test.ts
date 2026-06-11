// Station 2B / YUK-186 — nightly goal-scope propose handler DB integration test.
//
// Spec: docs/superpowers/specs/2026-06-01-station2b-goal-trigger-design.md
//   §Test plan + §Validation-on-synthetic.
//
// All stubbed runTaskFn → zero token, deterministic. Drives the producer trigger
// against the Station-1 synthetic seed (wenyan knowledge nodes whose mastery view
// reads weak: evidence_count<3 → 0.5 < 0.55), so the mastery-based selector picks
// 'wenyan' as the candidate domain. Then exercises the dedup gates / cap /
// failure-swallow against hand-built substrate.
//
// `*.db.test.ts` under tests/** lands in the db partition (allTestInclude minus
// fastTestInclude); it imports the testDb helper, so it must NOT be a unit test.

import {
  buildGoalScopeProposeNightlyHandler,
  hasWeakNodeInDomain,
  runGoalScopeProposeNightly,
} from '@/capabilities/agency/jobs/goal_scope_propose_nightly';
import { listActiveGoals } from '@/capabilities/agency/server/goals/queries';
import { runGoalScopeAndWrite } from '@/capabilities/agency/server/goals/scope';
import { event, goal } from '@/db/schema';
import { acceptAiProposal, retractAiProposal } from '@/server/proposals/actions';
import { listProposalInboxRows } from '@/server/proposals/inbox';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runSeed } from '../../scripts/seed-synthetic';
import { resetDb, testDb } from '../helpers/db';

// A deterministic GoalScopeTask stub: returns a well-formed scope output. The
// hallucinated id is filtered out inside runGoalScopeAndWrite (id-subset filter).
function stubGoalScopeRunTask(scopeIds: string[] = []) {
  return vi.fn(async () => ({
    text: JSON.stringify({
      scope_knowledge_ids: scopeIds,
      sequence_hint: 1,
      reasoning: '夜间巩固薄弱区',
    }),
  }));
}

describe('hasWeakNodeInDomain (pure filter — FIX-6 no-weak path)', () => {
  it('returns true when a node in the domain has mastery < 0.55', () => {
    const tree = [
      { effective_domain: 'wenyan', mastery: 0.9 },
      { effective_domain: 'wenyan', mastery: 0.4 },
    ];
    expect(hasWeakNodeInDomain(tree, 'wenyan')).toBe(true);
  });

  it('treats a null-mastery node as weak (neutral 0.5 < 0.55)', () => {
    const tree = [{ effective_domain: 'wenyan', mastery: null }];
    expect(hasWeakNodeInDomain(tree, 'wenyan')).toBe(true);
  });

  it('returns false when every domain node is mastered (>= 0.55)', () => {
    // FIX-6: the all-mastered case the synthetic seed cannot drive (seed nodes
    // with evidence_count<3 read 0.5 < 0.55). Asserted on the pure helper.
    const tree = [
      { effective_domain: 'wenyan', mastery: 0.55 },
      { effective_domain: 'wenyan', mastery: 0.8 },
    ];
    expect(hasWeakNodeInDomain(tree, 'wenyan')).toBe(false);
  });

  it('ignores nodes from other domains', () => {
    const tree = [
      { effective_domain: 'math', mastery: 0.1 },
      { effective_domain: 'wenyan', mastery: 0.9 },
    ];
    expect(hasWeakNodeInDomain(tree, 'wenyan')).toBe(false);
  });
});

describe('runGoalScopeProposeNightly (DB integration)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('happy path: seed → cron → a goal_scope proposal lands in the inbox', async () => {
    const db = testDb();
    await runSeed(db);

    const stub = stubGoalScopeRunTask();
    const result = await runGoalScopeProposeNightly(db, { runTaskFn: stub });

    expect(result.considered).toBe(1);
    expect(result.proposed).toBe(1);
    expect(result.proposal_id).toBeTruthy();
    expect(stub).toHaveBeenCalledTimes(1); // cap = 1

    const rows = await listProposalInboxRows(db);
    const goalProposals = rows.filter((r) => r.kind === 'goal_scope');
    expect(goalProposals).toHaveLength(1);
    expect(goalProposals[0].status).toBe('pending');
    expect(goalProposals[0].target.subject_kind).toBe('goal');
    const change = goalProposals[0].payload.proposed_change as { subject_id?: string };
    expect(change.subject_id).toBe('wenyan');
  });

  it('end-to-end chain: cron → accept → goal materialized → listActiveGoals non-empty', async () => {
    const db = testDb();
    await runSeed(db);

    const result = await runGoalScopeProposeNightly(db, { runTaskFn: stubGoalScopeRunTask() });
    expect(result.proposal_id).toBeTruthy();
    if (!result.proposal_id) throw new Error('expected proposal id');

    const accepted = await acceptAiProposal(db, result.proposal_id);
    expect(accepted.kind).toBe('goal_scope');

    const active = await listActiveGoals(db);
    expect(active.length).toBeGreaterThan(0);
    expect(active.some((g) => g.subject_id === 'wenyan')).toBe(true);
  });

  it('dedup gate-2: a live goal for the subject → skip, no new proposal', async () => {
    const db = testDb();
    await runSeed(db);

    // Materialize an active goal for wenyan via the real producer→accept path.
    const seeded = await runGoalScopeAndWrite({
      db,
      goalTitle: 'existing wenyan goal',
      subjectId: 'wenyan',
      runTaskFn: stubGoalScopeRunTask(),
    });
    if (!seeded.proposal_id) throw new Error('expected seed proposal id');
    await acceptAiProposal(db, seeded.proposal_id);
    expect((await listActiveGoals(db)).some((g) => g.subject_id === 'wenyan')).toBe(true);

    const stub = stubGoalScopeRunTask();
    const result = await runGoalScopeProposeNightly(db, { runTaskFn: stub });

    expect(result.considered).toBe(1);
    expect(result.skipped_existing_goal).toBe(1);
    expect(result.proposed).toBe(0);
    expect(stub).not.toHaveBeenCalled();
    // only the one (accepted) proposal exists — no new pending one
    const pending = (await listProposalInboxRows(db)).filter(
      (r) => r.kind === 'goal_scope' && r.status === 'pending',
    );
    expect(pending).toHaveLength(0);
  });

  it('dedup gate-3: a PENDING goal_scope proposal → skip; only one inbox row', async () => {
    const db = testDb();
    await runSeed(db);

    // First run lands a pending proposal.
    const first = await runGoalScopeProposeNightly(db, { runTaskFn: stubGoalScopeRunTask() });
    expect(first.proposed).toBe(1);

    // Second run WITHOUT accepting → pending dedup skips.
    const stub = stubGoalScopeRunTask();
    const second = await runGoalScopeProposeNightly(db, { runTaskFn: stub });
    expect(second.considered).toBe(1);
    expect(second.skipped_pending).toBe(1);
    expect(second.proposed).toBe(0);
    expect(stub).not.toHaveBeenCalled();

    const goalRows = (await listProposalInboxRows(db)).filter((r) => r.kind === 'goal_scope');
    expect(goalRows).toHaveLength(1);
  });

  it('accept→dormant→re-propose: an ACCEPTED proposal does NOT block re-propose (caused_by_event_id-only rate query, FIX-1)', async () => {
    const db = testDb();
    await runSeed(db);

    // Land a proposal, accept it, then tombstone the materialized goal to
    // 'dormant' (the accept→dormant path) so gate-2 (live goal) no longer covers
    // wenyan — isolating the gate-3 caused_by_event_id behavior.
    const first = await runGoalScopeProposeNightly(db, { runTaskFn: stubGoalScopeRunTask() });
    if (!first.proposal_id) throw new Error('expected first proposal id');
    await acceptAiProposal(db, first.proposal_id);

    // The goal accept rate event is subject_kind:'event' (accept.ts:121). A
    // subject_kind='goal' filter on the rate query would match ZERO rows and
    // mis-read this accepted propose as still-pending. Confirm the rate exists
    // and is subject_kind 'event' (the load-bearing divergence).
    const rate = (
      await db
        .select()
        .from(event)
        .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, first.proposal_id)))
        .limit(1)
    )[0];
    expect(rate).toBeTruthy();
    expect(rate.subject_kind).toBe('event');

    // Tombstone the goal to dormant directly (the accept→dormant path) so gate-2
    // (live goal) no longer covers wenyan — isolating the gate-3
    // caused_by_event_id behavior. (The goal id is the reserved target.subject_id,
    // not the proposal event id, so key on subject_id.)
    await db.update(goal).set({ status: 'dormant' }).where(eq(goal.subject_id, 'wenyan'));
    expect((await listActiveGoals(db)).some((g) => g.subject_id === 'wenyan')).toBe(false);

    // Re-propose must NOT be blocked: the accepted propose has a chained rate, so
    // it is decided (not pending) and drops out of loadPendingGoalScopeSubjects.
    const stub = stubGoalScopeRunTask();
    const second = await runGoalScopeProposeNightly(db, { runTaskFn: stub });
    expect(second.skipped_pending).toBe(0);
    expect(second.proposed).toBe(1);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('retract→re-propose: a RETRACTED pending proposal does NOT block re-propose (chained `correct` clears pending, FIX-3)', async () => {
    const db = testDb();
    await runSeed(db);

    // Land a PENDING proposal (never accepted), then retract it. retractAiProposal
    // writes a `correct` event (subject_kind:'event', caused_by_event_id=propose)
    // and NO `rate`. Without FIX-3 (chained-`correct` arm) the retracted propose
    // would mis-read as still-pending and lock wenyan out of re-propose forever.
    const first = await runGoalScopeProposeNightly(db, { runTaskFn: stubGoalScopeRunTask() });
    if (!first.proposal_id) throw new Error('expected first proposal id');

    await retractAiProposal(db, first.proposal_id, { reason_md: 'noise' });

    // Confirm the retract wrote a `correct` event chained to the propose and that
    // it is subject_kind:'event' (the load-bearing divergence FIX-3 relies on).
    const correction = (
      await db
        .select()
        .from(event)
        .where(and(eq(event.action, 'correct'), eq(event.caused_by_event_id, first.proposal_id)))
        .limit(1)
    )[0];
    expect(correction).toBeTruthy();
    expect(correction.subject_kind).toBe('event');

    // No live goal exists (the proposal was never accepted), so gate-2 is clear.
    expect((await listActiveGoals(db)).some((g) => g.subject_id === 'wenyan')).toBe(false);

    // Re-propose must NOT be blocked: the retracted propose has a chained `correct`
    // so it is decided (not pending) and drops out of loadPendingGoalScopeSubjects.
    const stub = stubGoalScopeRunTask();
    const second = await runGoalScopeProposeNightly(db, { runTaskFn: stub });
    expect(second.skipped_pending).toBe(0);
    expect(second.proposed).toBe(1);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('no-op: no weak nodes in any known domain → skipped_no_weak, proposed 0, stub not called', async () => {
    const db = testDb();
    // Empty DB — no seed, no knowledge nodes. The mastery-based selector finds no
    // weak node in any KNOWN domain (FIX #1: selection folds in the weak-node
    // gate), so it short-circuits before resolving any candidate.
    const stub = stubGoalScopeRunTask();
    const result = await runGoalScopeProposeNightly(db, { runTaskFn: stub });

    expect(result.considered).toBe(0);
    expect(result.skipped_no_weak).toBe(1);
    expect(result.proposed).toBe(0);
    expect(stub).not.toHaveBeenCalled();
  });

  it('F-1 failure swallow: stub throws → proposed 0, no rethrow from the LLM half', async () => {
    const db = testDb();
    await runSeed(db);

    const stub = vi.fn(async () => {
      throw new Error('simulated LLM outage');
    });
    // runGoalScopeAndWrite's internal try/catch swallows the throw → EMPTY_RESULT.
    const result = await runGoalScopeProposeNightly(db, { runTaskFn: stub });

    expect(result.considered).toBe(1);
    expect(result.proposed).toBe(0);
    expect(result.proposal_id).toBeNull();
    expect(stub).toHaveBeenCalledTimes(1);
    // no goal_scope proposal written
    const goalProposals = (await listProposalInboxRows(db)).filter((r) => r.kind === 'goal_scope');
    expect(goalProposals).toHaveLength(0);
  });

  it('builder rethrows on a pre-LLM DB fault (retryable) — does not swallow', async () => {
    // A handler built against a broken Db whose first read throws should rethrow
    // (pg-boss retries). We simulate by passing a Db proxy whose select throws on
    // the loadTreeSnapshot path (the first pre-LLM read after FIX #1). Simplest: a
    // non-DB object that throws when used — the builder's try/catch must rethrow,
    // not swallow.
    const brokenDb = {
      select() {
        throw new Error('simulated DB fault');
      },
    } as unknown as Parameters<typeof buildGoalScopeProposeNightlyHandler>[0];
    const handler = buildGoalScopeProposeNightlyHandler(brokenDb);
    await expect(handler([] as never)).rejects.toThrow('simulated DB fault');
  });
});
