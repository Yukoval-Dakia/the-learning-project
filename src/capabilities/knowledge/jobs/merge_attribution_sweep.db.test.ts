// YUK-544 — merge_attribution_sweep db tests: two-phase census + bounded auto-repair.
// Seeds drift the way the residual async-grading race produces it (archived loser KC + surfaces
// still keyed to it), then asserts: repair completes via the shared repair path, the forensic
// `experimental:merge_attribution_repaired` event lands, the post-repair census is zero, a second
// run is a no-op (idempotent), and the hard cap defers the overflow to the next (converging) run.
// Review-round coverage (YUK-544): per-winner throw isolation (A1), the census→repair TOCTOU
// winner-liveness re-verify (C1, via the onBeforeRepairPhase test seam), and the WARN water level (S1).

import { db } from '@/db/client';
import { event, knowledge, mastery_state, misconception_edge, question } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../../../../tests/helpers/db';
import { runMergeAttributionSweep } from './merge_attribution_sweep';

async function insertK(id: string, opts: { archived?: boolean; mergedFrom?: string[] } = {}) {
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: id,
    domain: 'wenyan',
    parent_id: null,
    merged_from: opts.mergedFrom ?? [],
    proposed_by_ai: false,
    approval_status: 'approved',
    archived_at: opts.archived ? now : null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}
async function insertQ(id: string, kids: string[]) {
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: 'p',
    knowledge_ids: kids,
    source: 'test',
    created_at: now,
    updated_at: now,
  });
}

async function repairEvents() {
  return db.select().from(event).where(eq(event.action, 'experimental:merge_attribution_repaired'));
}

describe('merge_attribution_sweep (YUK-544 census + bounded auto-repair)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('clean tree: censuses, repairs nothing, writes no event', async () => {
    await insertK('k_into', { mergedFrom: ['k_from'] });
    await insertK('k_from', { archived: true });
    // no surface references k_from → no drift

    const res = await runMergeAttributionSweep(db);
    expect(res.scannedFromIds).toBe(1);
    expect(res.resolved).toBe(1);
    expect(res.driftedFromIds).toBe(0);
    expect(res.repairedFromIds).toBe(0);
    expect(res.surfacesRepaired).toBe(0);
    expect(res.eventsWritten).toBe(0);
    expect(await repairEvents()).toHaveLength(0);
  });

  it('auto-repairs drift, writes the forensic event, re-census is zero, second run is a no-op', async () => {
    await insertK('k_into', { mergedFrom: ['k_from'] });
    await insertK('k_from', { archived: true });
    await insertQ('q1', ['k_from', 'k_x']);
    await db.insert(mastery_state).values({ id: 'ms1', subject_id: 'k_from' });

    const first = await runMergeAttributionSweep(db, { runId: 'run_test_1' });
    expect(first.driftedFromIds).toBe(1);
    expect(first.repairedFromIds).toBe(1);
    expect(first.deferredFromIds).toBe(0);
    expect(first.surfacesRepaired).toBeGreaterThanOrEqual(2); // question + mastery
    expect(first.residualAfterRepair).toBe(0); // zero-assertion holds
    expect(first.eventsWritten).toBe(1);

    // The repair went through the shared repair path: surfaces re-keyed to the winner.
    const q1 = await db.select().from(question).where(eq(question.id, 'q1'));
    expect(q1[0].knowledge_ids).toEqual(['k_into', 'k_x']);
    const msInto = await db
      .select()
      .from(mastery_state)
      .where(eq(mastery_state.subject_id, 'k_into'));
    expect(msInto).toHaveLength(1);

    // Forensic event: from_id / terminal winner / full chain / summary / run id.
    const events = await repairEvents();
    expect(events).toHaveLength(1);
    expect(events[0].actor_ref).toBe('merge_attribution_sweep');
    expect(events[0].subject_kind).toBe('knowledge');
    expect(events[0].subject_id).toBe('k_from');
    const payload = events[0].payload as {
      from_id: string;
      terminal_winner_id: string;
      chain: string[];
      repair_summary: { questions: number; mastery_state: string };
      surfaces_repaired: number;
      sweep_run_id: string;
    };
    expect(payload.from_id).toBe('k_from');
    expect(payload.terminal_winner_id).toBe('k_into');
    expect(payload.chain).toEqual(['k_from', 'k_into']);
    expect(payload.repair_summary.questions).toBe(1);
    // 'renamed' exactly: the from-row exists and the winner has NO mastery row, so the retire
    // re-keys subject_id onto the winner (retireMasteryStateOnMerge; 'frozen' is the both-rows
    // case, 'noop' the no-from-row case — pin the enum so a semantics change fails here).
    expect(payload.repair_summary.mastery_state).toBe('renamed');
    expect(payload.surfaces_repaired).toBe(first.surfacesRepaired);
    expect(payload.sweep_run_id).toBe('run_test_1');

    // Second run: idempotent no-op — nothing drifted, no new event.
    const second = await runMergeAttributionSweep(db);
    expect(second.driftedFromIds).toBe(0);
    expect(second.repairedFromIds).toBe(0);
    expect(second.eventsWritten).toBe(0);
    expect(await repairEvents()).toHaveLength(1);
  });

  it('resolves a multi-hop chain and stamps the FULL hop sequence on the event', async () => {
    await insertK('k_c', { mergedFrom: ['k_b'] }); // live terminal winner
    await insertK('k_b', { archived: true, mergedFrom: ['k_a'] });
    await insertK('k_a', { archived: true });
    await insertQ('q1', ['k_a']);

    const res = await runMergeAttributionSweep(db);
    expect(res.repairedFromIds).toBe(1); // only k_a drifted (k_b has no dangling surface)
    const q1 = await db.select().from(question).where(eq(question.id, 'q1'));
    expect(q1[0].knowledge_ids).toEqual(['k_c']);

    const events = await repairEvents();
    expect(events).toHaveLength(1);
    const payload = events[0].payload as { chain: string[]; terminal_winner_id: string };
    expect(payload.chain).toEqual(['k_a', 'k_b', 'k_c']); // forensic full chain, not flattened
    expect(payload.terminal_winner_id).toBe('k_c');
  });

  it('skips an unresolvable chain (archived-not-merged terminal) — reports, never guesses a repair', async () => {
    await insertK('k_x', { archived: true, mergedFrom: ['k_from'] }); // terminal archived, NOT merged
    await insertK('k_from', { archived: true });
    await insertQ('q1', ['k_from']);

    const res = await runMergeAttributionSweep(db);
    expect(res.skipped).toBe(1);
    expect(res.resolved).toBe(0);
    expect(res.repairedFromIds).toBe(0);
    expect(res.eventsWritten).toBe(0);
    const q1 = await db.select().from(question).where(eq(question.id, 'q1'));
    expect(q1[0].knowledge_ids).toEqual(['k_from']); // untouched
  });

  it('hard cap: repairs only maxRepair from_ids, defers the rest, and converges next run', async () => {
    // One winner absorbed three losers; every loser still has a dangling question surface.
    await insertK('k_into', { mergedFrom: ['k_a', 'k_b', 'k_c'] });
    await insertK('k_a', { archived: true });
    await insertK('k_b', { archived: true });
    await insertK('k_c', { archived: true });
    await insertQ('q_a', ['k_a']);
    await insertQ('q_b', ['k_b']);
    await insertQ('q_c', ['k_c']);

    const first = await runMergeAttributionSweep(db, { maxRepair: 2 });
    expect(first.driftedFromIds).toBe(3);
    expect(first.repairedFromIds).toBe(2); // capped
    expect(first.deferredFromIds).toBe(1); // "剩 1 个下轮"
    expect(first.residualAfterRepair).toBe(0); // the repaired subset itself is clean
    expect(first.eventsWritten).toBe(2);
    expect(await repairEvents()).toHaveLength(2);

    // Next run: idempotent continuation picks up the deferred from_id.
    const second = await runMergeAttributionSweep(db, { maxRepair: 2 });
    expect(second.driftedFromIds).toBe(1);
    expect(second.repairedFromIds).toBe(1);
    expect(second.deferredFromIds).toBe(0);
    expect(second.residualAfterRepair).toBe(0);
    expect(await repairEvents()).toHaveLength(3);

    // All three questions now key to the winner; a third run is fully clean.
    for (const qid of ['q_a', 'q_b', 'q_c']) {
      const row = await db.select().from(question).where(eq(question.id, qid));
      expect(row[0].knowledge_ids).toEqual(['k_into']);
    }
    const third = await runMergeAttributionSweep(db);
    expect(third.driftedFromIds).toBe(0);
    expect(third.repairedFromIds).toBe(0);
  });

  it('A1 winner isolation: a throwing winner rolls back alone — other winners repair + emit events', async () => {
    // Winner A — repairs cleanly.
    await insertK('k_into_a', { mergedFrom: ['k_a'] });
    await insertK('k_a', { archived: true });
    await insertQ('q_a', ['k_a']);
    // Winner B — repair throws DETERMINISTICALLY: the misconception-edge rewrite routes created_by
    // through the AgentRef.parse barrier (proposals.ts, YUK-543 O4); junk jsonb (`by` missing) fails
    // the parse → winner-B tx rolls back whole. The census still counts the edge as drift
    // (countOrphanSurfaces does row counts, no parse), so winner B genuinely enters the repair phase.
    await insertK('k_into_b', { mergedFrom: ['k_b'] });
    await insertK('k_b', { archived: true });
    const now = new Date();
    await db.insert(misconception_edge).values({
      id: 'me_bad',
      from_kind: 'misconception',
      from_id: 'm1',
      to_kind: 'knowledge',
      to_id: 'k_b',
      relation_type: 'caused_by',
      weight: 1,
      created_by: {
        bogus: true,
      } as unknown as (typeof misconception_edge.$inferInsert)['created_by'],
      proposed_by_ai: false,
      created_at: now,
      updated_at: now,
    });

    // Silence the two intentional winner-B failure logs (this test TRIGGERS them; unsilenced they
    // spray a full stack into CI output and read as a real failure). The sweep's behaviour is
    // asserted via result counts + rows, not log output.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await runMergeAttributionSweep(db);
      expect(res.driftedFromIds).toBe(2);
      expect(res.failedWinners).toBe(1); // winner B threw + rolled back
      expect(res.repairedFromIds).toBe(1); // winner A unaffected — no starvation
      expect(res.eventsWritten).toBe(1);
      expect(res.residualAfterRepair).toBe(0); // zero-assert runs over the REPAIRED set only

      // Winner A repaired + evidenced; winner B's surfaces untouched (rollback, not partial write).
      const qa = await db.select().from(question).where(eq(question.id, 'q_a'));
      expect(qa[0].knowledge_ids).toEqual(['k_into_a']);
      const events = await repairEvents();
      expect(events).toHaveLength(1);
      expect(events[0].subject_id).toBe('k_a');
      const me = await db
        .select()
        .from(misconception_edge)
        .where(eq(misconception_edge.id, 'me_bad'));
      expect(me[0].to_id).toBe('k_b');
      expect(me[0].archived_at).toBeNull();

      // Next run: only the failed winner is still drifted; it retries (and fails again on the same
      // poisoned fixture) without touching the already-repaired winner — isolation is run-stable.
      const second = await runMergeAttributionSweep(db);
      expect(second.driftedFromIds).toBe(1);
      expect(second.failedWinners).toBe(1);
      expect(second.repairedFromIds).toBe(0);
      expect(second.eventsWritten).toBe(0);
      expect(await repairEvents()).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('C1 TOCTOU: winner archived between census and repair → deferred, zero writes toward the archived winner', async () => {
    await insertK('k_into', { mergedFrom: ['k_from'] });
    await insertK('k_from', { archived: true });
    await insertQ('q1', ['k_from']);
    await db.insert(mastery_state).values({ id: 'ms1', subject_id: 'k_from' });

    const res = await runMergeAttributionSweep(db, {
      // Simulate a concurrent accept-merge absorbing the winner in the exact census→repair window
      // the in-tx liveness re-verify defends (the seam exists for precisely this test).
      onBeforeRepairPhase: async () => {
        await db
          .update(knowledge)
          .set({ archived_at: new Date() })
          .where(eq(knowledge.id, 'k_into'));
      },
    });
    expect(res.driftedFromIds).toBe(1);
    expect(res.repairedFromIds).toBe(0);
    expect(res.deferredFromIds).toBe(1); // 复用幂等续跑语义 — next run re-resolves the extended chain
    expect(res.failedWinners).toBe(0); // an archived winner is a defer, not a failure
    expect(res.eventsWritten).toBe(0);

    // No partial writes: every surface still references k_from; nothing re-keyed onto the archived winner.
    const q1 = await db.select().from(question).where(eq(question.id, 'q1'));
    expect(q1[0].knowledge_ids).toEqual(['k_from']);
    const ms = await db.select().from(mastery_state).where(eq(mastery_state.subject_id, 'k_from'));
    expect(ms).toHaveLength(1);
    expect(await repairEvents()).toHaveLength(0);
  });

  it('S1 WARN water level: crossing warnDrift logs ELEVATED DRIFT but still repairs (告知-only)', async () => {
    await insertK('k_into', { mergedFrom: ['k_from'] });
    await insertK('k_from', { archived: true });
    await insertQ('q1', ['k_from']);

    const warnSpy = vi.spyOn(console, 'warn');
    try {
      const res = await runMergeAttributionSweep(db, { warnDrift: 0 });
      expect(res.driftedFromIds).toBe(1);
      expect(res.repairedFromIds).toBe(1); // the warning never blocks the self-heal
      expect(
        warnSpy.mock.calls.some((c) => typeof c[0] === 'string' && c[0].includes('ELEVATED DRIFT')),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
