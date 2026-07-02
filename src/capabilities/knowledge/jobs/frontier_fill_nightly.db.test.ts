// B3 frontier (YUK-349 scope #3, PR-2) — empty-frontier prerequisite bootstrap
// fill. Every test injects a FAKE runTaskFn via the DI seam so NO real LLM is
// called. The load-bearing assertions:
//   1. PROPOSE-ONLY — proposals become `propose` events, ZERO live knowledge_edge rows.
//   2. SWALLOW-SAFE — an LLM/parse fault → proposed:0, no throw.
//   3. COST CAP — > FRONTIER_FILL_MAX_PROPOSALS output is clamped.
//   4. SPARSITY GATE — a non-empty frontier → no-op, fake runTaskFn NOT called.
//   5. PRE-LLM DB FAULT — a pre-LLM read fault RETHROWS (not swallowed).
//   6. DEDUP — an already-pending (from,to,prerequisite) pair is skipped.

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createKnowledgeEdge } from '@/capabilities/knowledge/server/edges';
import { db } from '@/db/client';
import { event, knowledge, knowledge_edge, mastery_state } from '@/db/schema';
import { writeAiProposal } from '@/server/proposals/writer';
import { resetDb } from '../../../../tests/helpers/db';
import { FRONTIER_FILL_MAX_PROPOSALS, runFrontierFillAndWrite } from './frontier_fill_nightly';

async function seedKnowledge(ids: string[], domain = 'math'): Promise<void> {
  const now = new Date();
  await db.insert(knowledge).values(
    ids.map((id) => ({
      id,
      name: `KC ${id.slice(0, 4)}`,
      domain,
      parent_id: null,
      created_at: now,
      updated_at: now,
    })),
  );
}

async function countLiveEdges(): Promise<number> {
  const rows = await db.select({ id: knowledge_edge.id }).from(knowledge_edge);
  return rows.length;
}

async function proposeEvents(): Promise<
  Array<{ from: string; to: string; relation_type: string; weight: number }>
> {
  const rows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
  return rows.map((r) => {
    const p = r.payload as Record<string, unknown>;
    return {
      from: p.from_knowledge_id as string,
      to: p.to_knowledge_id as string,
      relation_type: p.relation_type as string,
      weight: p.weight as number,
    };
  });
}

describe('frontier_fill_nightly — empty-frontier prerequisite bootstrap', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // ── 1. PROPOSE-ONLY red line ──────────────────────────────────────────────
  it('writes propose events on an empty frontier and NEVER a live knowledge_edge row', async () => {
    const [k1, k2, k3] = [createId(), createId(), createId()];
    await seedKnowledge([k1, k2, k3]);

    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: k1,
            to_knowledge_id: k2,
            relation_type: 'prerequisite',
            weight: 0.9,
            reasoning: 'k1 先于 k2',
          },
          {
            from_knowledge_id: k1,
            to_knowledge_id: k3,
            relation_type: 'prerequisite',
            weight: 0.9,
            reasoning: 'k1 先于 k3',
          },
        ],
      }),
    }));

    const result = await runFrontierFillAndWrite(db, { runTaskFn });

    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect(result.proposed).toBe(2);
    expect(result.skipped_dense).toBe(0);

    // PROPOSE-ONLY: two propose events, ZERO live edge rows.
    const events = await proposeEvents();
    expect(events).toHaveLength(2);
    expect(await countLiveEdges()).toBe(0);

    // relation_type FORCED to prerequisite + LOW temp weight regardless of LLM output.
    for (const e of events) {
      expect(e.relation_type).toBe('prerequisite');
      expect(e.weight).toBe(0.4);
    }
    expect(new Set(events.map((e) => e.to))).toEqual(new Set([k2, k3]));
  });

  // ── 2. SWALLOW-SAFE LLM half ──────────────────────────────────────────────
  it('swallows an LLM/runner fault → proposed:0, no throw, no live edge', async () => {
    const [k1, k2] = [createId(), createId()];
    await seedKnowledge([k1, k2]);

    const runTaskFn = vi.fn(async () => {
      throw new Error('simulated LLM failure');
    });

    const result = await runFrontierFillAndWrite(db, { runTaskFn });
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect(result.proposed).toBe(0);
    expect(await proposeEvents()).toHaveLength(0);
    expect(await countLiveEdges()).toBe(0);
  });

  // ── 3. COST CAP ───────────────────────────────────────────────────────────
  it('clamps to FRONTIER_FILL_MAX_PROPOSALS writes when the model returns more', async () => {
    // Feed cap + 2 distinct, valid proposals. The job's write-side clamp must
    // stop at the cap (skipped_over_cap accounts for the overflow), and ONLY the
    // cap-many propose events land — still ZERO live edges.
    const overflow = 2;
    const targets = Array.from({ length: FRONTIER_FILL_MAX_PROPOSALS + overflow }, () =>
      createId(),
    );
    const source = createId();
    await seedKnowledge([source, ...targets]);

    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        proposals: targets.map((t) => ({
          from_knowledge_id: source,
          to_knowledge_id: t,
          relation_type: 'prerequisite',
          weight: 0.9,
          reasoning: 'bootstrap',
        })),
      }),
    }));

    const result = await runFrontierFillAndWrite(db, { runTaskFn });
    expect(result.proposed).toBe(FRONTIER_FILL_MAX_PROPOSALS);
    expect(result.skipped_over_cap).toBe(overflow);
    expect(await proposeEvents()).toHaveLength(FRONTIER_FILL_MAX_PROPOSALS);
    expect(await countLiveEdges()).toBe(0);
  });

  // ── 4. SPARSITY GATE ──────────────────────────────────────────────────────
  it('no-ops (skipped_dense) when the learnable frontier is non-empty — fake NOT called', async () => {
    const [prereq, dependent] = [createId(), createId()];
    await seedKnowledge([prereq, dependent]);

    // A live prerequisite edge prereq → dependent makes `dependent` a frontier
    // candidate; mastering `prereq` (success=4/evidence=4 → p(L)=σ(0.5·4)=0.88 ≥ 0.7 AND
    // evidence 4 ≥ FRONTIER_MASTERY_MIN_EVIDENCE — YUK-539: the old success=3/evidence=3
    // fixture is exactly the "3 lucky corrects" shape the evidence floor now rejects) while
    // `dependent` stays cold-start (0.5) puts `dependent` ON the frontier.
    await createKnowledgeEdge(db, {
      from_knowledge_id: prereq,
      to_knowledge_id: dependent,
      relation_type: 'prerequisite',
      weight: 1,
      reasoning: 'seed',
      actor_kind: 'user',
      actor_ref: 'self',
    });
    await db.insert(mastery_state).values({
      id: createId(),
      subject_id: prereq,
      success_count: 4,
      fail_count: 0,
      evidence_count: 4,
    });

    const runTaskFn = vi.fn(async () => ({ text: '{"proposals":[]}' }));
    const result = await runFrontierFillAndWrite(db, { runTaskFn });

    expect(result.skipped_dense).toBe(1);
    expect(result.proposed).toBe(0);
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  // ── 5. PRE-LLM DB FAULT rethrows (not swallowed) ──────────────────────────
  it('rethrows a pre-LLM DB read fault (not swallowed behind proposed:0)', async () => {
    const runTaskFn = vi.fn(async () => ({ text: '{"proposals":[]}' }));
    // The frontier read (learnableFrontier) calls db.execute first; force it to
    // throw to simulate a retryable DB fault on the pre-LLM read.
    const throwingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'execute') {
          return () => {
            throw new Error('simulated DB fault');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;

    await expect(runFrontierFillAndWrite(throwingDb, { runTaskFn })).rejects.toThrow(
      'simulated DB fault',
    );
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  // ── 6. DEDUP — already-pending pair is skipped ────────────────────────────
  it('skips a (from,to,prerequisite) pair that already has a pending proposal', async () => {
    const [k1, k2] = [createId(), createId()];
    await seedKnowledge([k1, k2]);

    // Seed an existing pending prerequisite proposal for (k1 → k2). No live edge,
    // so the frontier stays empty and k2 still lacks prereq coverage.
    await writeAiProposal(db, {
      actor_ref: 'dreaming',
      outcome: 'success',
      payload: {
        kind: 'knowledge_edge',
        target: { subject_kind: 'knowledge_edge', subject_id: null },
        reason_md: 'pre-existing pending',
        evidence_refs: [],
        proposed_change: {
          edge_op: 'create',
          from_knowledge_id: k1,
          to_knowledge_id: k2,
          relation_type: 'prerequisite',
          weight: 0.4,
        },
        cooldown_key: `knowledge_edge:${k1}|${k2}|prerequisite`,
      },
    });

    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: k1,
            to_knowledge_id: k2,
            relation_type: 'prerequisite',
            weight: 0.9,
            reasoning: 'dup',
          },
        ],
      }),
    }));

    const result = await runFrontierFillAndWrite(db, { runTaskFn });
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect(result.proposed).toBe(0);
    expect(result.skipped_duplicate_pending).toBe(1);
    // Still exactly ONE propose event (the pre-seeded one) — no new write.
    expect(await proposeEvents()).toHaveLength(1);
    expect(await countLiveEdges()).toBe(0);
  });

  // ── 7. OVERFLOW ≢ COLD-START (YUK-514 Finding 1) ──────────────────────────
  it('no-ops (skipped_overflow) when the frontier closure OVERFLOWS — fake NOT called', async () => {
    // An `overflow` resolution means the closure tripped the depth / node-cap fail-safe →
    // the graph is DENSE, not cold-start → the job must NOT bootstrap. Inject the
    // discriminant via the DI seam (no need to seed a 10k-tuple closure).
    const [k1, k2] = [createId(), createId()];
    await seedKnowledge([k1, k2]);

    const runTaskFn = vi.fn(async () => ({ text: '{"proposals":[]}' }));
    const result = await runFrontierFillAndWrite(db, {
      runTaskFn,
      resolveFrontierFn: async () => ({ kind: 'overflow' as const, ids: [] }),
    });

    expect(result.skipped_overflow).toBe(1);
    expect(result.skipped_dense).toBe(0);
    expect(result.proposed).toBe(0);
    expect(runTaskFn).not.toHaveBeenCalled();
    expect(await proposeEvents()).toHaveLength(0);
    expect(await countLiveEdges()).toBe(0);
  });

  // ── 8. `from` EXISTENCE = knowledge table, NOT truncated snapshot (Finding 2) ──
  it('validates `from` against the knowledge table (a real KC is kept; a phantom id is dropped)', async () => {
    // Empty frontier (no edges) → bootstrap proceeds. The model returns two proposals:
    // one whose `from` is a REAL seeded KC, one whose `from` is a non-existent id. The
    // DB-existence check keeps the real one and drops only the phantom (skipped_invalid),
    // independent of any tree-snapshot truncation.
    const [src, t1, t2] = [createId(), createId(), createId()];
    await seedKnowledge([src, t1, t2]);

    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: src,
            to_knowledge_id: t1,
            relation_type: 'prerequisite',
            weight: 0.9,
            reasoning: 'real from → kept',
          },
          {
            from_knowledge_id: 'phantom-kc-not-in-db',
            to_knowledge_id: t2,
            relation_type: 'prerequisite',
            weight: 0.9,
            reasoning: 'phantom from → dropped',
          },
        ],
      }),
    }));

    const result = await runFrontierFillAndWrite(db, { runTaskFn });
    expect(result.proposed).toBe(1);
    expect(result.skipped_invalid).toBe(1);

    const events = await proposeEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ from: src, to: t1 });
    expect(await countLiveEdges()).toBe(0);
  });
});
