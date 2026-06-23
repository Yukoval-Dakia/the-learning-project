// YUK-471 Wave 0 — `collectCascadeFromCheckpoint` recursive-CTE collector tests.
//
// This is the repo's FIRST `WITH RECURSIVE`. The collector reverse-traverses the
// `caused_by_event_id` edge from a checkpoint event to gather every DOWNSTREAM
// event that (transitively) was caused by it — the set a later cascade-revert
// orchestrator must compensate, in reverse-dependency order.
//
// Blueprint: `getEventChain` (queries.ts:943-977) does ONE reverse hop with the
// `ne(action,'correct')` trap (queries.ts:963) — compensation events must NOT be
// swept back into the cascade. This collector generalises that to N levels with
// cycle / depth / node-cap guards.
//
// Partition: db (seeds the `event` table → imports tests/helpers/db). Matches
// allTestInclude's `src/**/*.test.ts` and is NOT in fastTestInclude → db config.

import { newId } from '@/core/ids';
import { event } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { collectCascadeFromCheckpoint } from './cascade';

// Local helper to build the `eq(event.id, …)` predicate.
function eqId(id: string) {
  return eq(event.id, id);
}

// Direct insert (test fixture; ADR-0005 single-owner applies to production code —
// see tests/helpers/event-seed.ts header). We need free-form `caused_by` wiring
// (including a deliberate cycle for the guard test) that writeEvent's parse
// barrier would otherwise constrain.
async function seedEvent(opts: {
  id?: string;
  action?: string;
  caused_by_event_id?: string | null;
  created_at?: Date;
}): Promise<string> {
  const db = testDb();
  const id = opts.id ?? newId();
  await db.insert(event).values({
    id,
    session_id: null,
    actor_kind: 'system',
    actor_ref: 'test',
    action: opts.action ?? 'attempt',
    subject_kind: 'event',
    subject_id: id,
    outcome: null,
    payload: {},
    caused_by_event_id: opts.caused_by_event_id ?? null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: opts.created_at ?? new Date(),
  });
  return id;
}

describe('collectCascadeFromCheckpoint (recursive CTE)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // Test 20 — collects downstream via caused_by; root EXCLUDED (§6.4).
  it('collects downstream events via caused_by, excluding the checkpoint root', async () => {
    const db = testDb();
    const a = await seedEvent({ action: 'attempt' });
    const b = await seedEvent({ action: 'judge', caused_by_event_id: a });
    const c = await seedEvent({ action: 'propose', caused_by_event_id: b });

    const result = await collectCascadeFromCheckpoint(db, a);

    expect(result.truncated).toBe(false);
    const ids = result.nodes.map((n) => n.id);
    // root A is the checkpoint; collector returns downstream only.
    expect(ids).not.toContain(a);
    expect(ids).toEqual(expect.arrayContaining([b, c]));
    expect(ids).toHaveLength(2);
  });

  // Test 21 — excludes action='correct' children (the compensation trap).
  it("excludes action='correct' children (compensation events)", async () => {
    const db = testDb();
    const a = await seedEvent({ action: 'attempt' });
    const b = await seedEvent({ action: 'judge', caused_by_event_id: a });
    // A `correct` compensation event also points back to A via caused_by.
    const c = await seedEvent({ action: 'correct', caused_by_event_id: a });

    const result = await collectCascadeFromCheckpoint(db, a);
    const ids = result.nodes.map((n) => n.id);

    expect(ids).toContain(b);
    expect(ids).not.toContain(c);
  });

  // Test 21b — a `correct` node must not act as a bridge: anything caused_by a
  // `correct` event is unreachable through it (the recursion never visits it).
  it('does not traverse THROUGH a correct node to its descendants', async () => {
    const db = testDb();
    const a = await seedEvent({ action: 'attempt' });
    const c = await seedEvent({ action: 'correct', caused_by_event_id: a });
    const d = await seedEvent({ action: 'judge', caused_by_event_id: c });

    const result = await collectCascadeFromCheckpoint(db, a);
    const ids = result.nodes.map((n) => n.id);

    expect(ids).not.toContain(c);
    expect(ids).not.toContain(d); // unreachable: only path is through the correct node
  });

  // Test 22 — cycle guard terminates (path-array `id = ANY(path)` cutoff).
  it('terminates on a caused_by cycle without infinite loop', async () => {
    const db = testDb();
    // Construct a deliberate cycle A -> B -> A via bad data. The two-step insert
    // is required because each row references the other.
    const a = await seedEvent({ action: 'attempt' });
    const b = await seedEvent({ action: 'judge', caused_by_event_id: a });
    // Now point A back at B, closing the loop.
    await db.update(event).set({ caused_by_event_id: b }).where(eqId(a));

    const result = await collectCascadeFromCheckpoint(db, a);
    const ids = result.nodes.map((n) => n.id);

    // B reachable from A; A itself is the root (excluded) and the cycle cutoff
    // prevents revisiting it → finite set, no hang.
    expect(ids).toContain(b);
    // A appears as a downstream node only via the cycle B->A; the cycle guard
    // must stop before re-expanding A's children endlessly. The set is finite.
    expect(result.truncated).toBe(false);
    expect(result.nodes.length).toBeLessThanOrEqual(2);
  });

  // Test 23 — depth limit 64 caps the traversal.
  it('caps traversal at depth 64', async () => {
    const db = testDb();
    // Build a linear chain of length 70 (root + 69 downstream). With a hard depth
    // cap of 64, only 64 downstream levels are reachable → truncated.
    const ids: string[] = [];
    let prev: string | null = null;
    for (let i = 0; i < 70; i++) {
      const id = await seedEvent({ action: 'judge', caused_by_event_id: prev });
      ids.push(id);
      prev = id;
    }
    const root = ids[0];

    const result = await collectCascadeFromCheckpoint(db, root);

    // Depth cap reached on a chain deeper than 64 → honest-reject (truncated).
    expect(result.truncated).toBe(true);
  });

  // Test 24 — node cap → truncated=true (refuse; return no half set).
  it('returns truncated=true when the node cap is exceeded', async () => {
    const db = testDb();
    const root = await seedEvent({ action: 'attempt' });
    // Fan out many direct children below a small node cap.
    for (let i = 0; i < 10; i++) {
      await seedEvent({ action: 'judge', caused_by_event_id: root });
    }

    const result = await collectCascadeFromCheckpoint(db, root, { nodeCap: 5 });

    expect(result.truncated).toBe(true);
    // Honest-reject: no half set is returned.
    expect(result.nodes).toHaveLength(0);
  });

  // Test 25 — outer ORDER BY depth DESC (reverse-dependency order; Codex fix ④).
  it('orders nodes by depth DESC (deepest first)', async () => {
    const db = testDb();
    const a = await seedEvent({ action: 'attempt' });
    const b = await seedEvent({ action: 'judge', caused_by_event_id: a });
    const c = await seedEvent({ action: 'propose', caused_by_event_id: b });
    const d = await seedEvent({ action: 'propose', caused_by_event_id: c });

    const result = await collectCascadeFromCheckpoint(db, a);
    const orderedIds = result.nodes.map((n) => n.id);

    // Reverse-dependency: deepest (D, depth 3) before C (2) before B (1).
    expect(orderedIds).toEqual([d, c, b]);
    // depth column must be monotonically non-increasing.
    const depths = result.nodes.map((n) => n.depth);
    for (let i = 1; i < depths.length; i++) {
      expect(depths[i]).toBeLessThanOrEqual(depths[i - 1]);
    }
  });
});
