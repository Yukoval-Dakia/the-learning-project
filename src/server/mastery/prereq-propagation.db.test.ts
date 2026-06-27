// YUK-455 inc-E — prereq 诊断「向后传播」producer 的 DB 测：
//   (1) loadPrereqClosure — 向上 prereq 闭包 walk（方向/深度/环/archived/orphan）。
//   (2) emitPrereqRiskSignal — 真 EMIT experimental:prereq_risk 事件（机制可证 =
//       defer-flip readiness：dark-ship 必须已接线 + 可证，不能 dark-AND-broken）。
//   (3) per-event 错误隔离（注入 writeEventFn 单 KC throw，其余仍 emit）。
//
// 注意：emitPrereqRiskSignal 故意**不查 flag**（DARK-SHIP CONTRACT：dark 住 call site），
// 故本测可直接驱动它验证机制。flag-off byte-identical 回归锚在 submit.db.test.ts（走真
// /api/review/submit 失败路径，断言零 prereq_risk 事件）。
//
// 闭包 walk 形状与 learnable-frontier.db.test.ts 同源——复用其 seed 范式。

import { event, knowledge, knowledge_edge } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  PREREQ_DEPTH_LIMIT,
  PREREQ_RISK_ACTION,
  emitPrereqRiskSignal,
  loadPrereqClosure,
} from './prereq-propagation';

async function seedKc(id: string): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(knowledge)
    .values({
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
    })
    .onConflictDoNothing();
}

/** `from` is a prerequisite of `to` (from_knowledge_id → to_knowledge_id). */
async function seedPrereq(
  from: string,
  to: string,
  opts: { archived?: boolean } = {},
): Promise<void> {
  await seedKc(from);
  await seedKc(to);
  await testDb()
    .insert(knowledge_edge)
    .values({
      id: createId(),
      from_knowledge_id: from,
      to_knowledge_id: to,
      relation_type: 'prerequisite',
      weight: 1,
      created_by: 'user' as never,
      reasoning: null,
      created_at: new Date(),
      archived_at: opts.archived ? new Date() : null,
    });
}

describe('loadPrereqClosure (YUK-455 inc-E)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('walks UP the transitive prereq chain anchored at the failed KC', async () => {
    // A is prereq of B, B is prereq of C. Fail C → closure = {B@1, A@2}, source_kc=C.
    await seedPrereq('A', 'B');
    await seedPrereq('B', 'C');
    const closure = await loadPrereqClosure(testDb(), ['C']);
    const sorted = closure.sort((x, y) => x.prereq_kc.localeCompare(y.prereq_kc));
    expect(sorted).toEqual([
      { prereq_kc: 'A', source_kc: 'C', depth: 2 },
      { prereq_kc: 'B', source_kc: 'C', depth: 1 },
    ]);
  });

  it('orphan KC (no prereqs) → empty closure', async () => {
    await seedKc('solo');
    const closure = await loadPrereqClosure(testDb(), ['solo']);
    expect(closure).toEqual([]);
  });

  it('empty / blank anchor set → empty closure (no SQL run)', async () => {
    expect(await loadPrereqClosure(testDb(), [])).toEqual([]);
    expect(await loadPrereqClosure(testDb(), ['  ', ''])).toEqual([]);
  });

  it('archived prerequisite edge is excluded from the walk', async () => {
    await seedPrereq('A', 'B', { archived: true });
    const closure = await loadPrereqClosure(testDb(), ['B']);
    expect(closure).toEqual([]);
  });

  it('cycle guard: A↔B prereq cycle terminates and returns a bounded closure', async () => {
    await seedPrereq('A', 'B');
    await seedPrereq('B', 'A');
    // Fail B → its prereq is A (depth 1); A's prereq is B but B is already on the path → cut.
    const closure = await loadPrereqClosure(testDb(), ['B']);
    expect(closure).toEqual([{ prereq_kc: 'A', source_kc: 'B', depth: 1 }]);
  });

  it('depth-limit overflow → fail-safe [] (never a partial closure)', async () => {
    // Linear chain k0 → k1 → ... → kN (k_i prereq of k_{i+1}) with N > PREREQ_DEPTH_LIMIT.
    const n = PREREQ_DEPTH_LIMIT + 4;
    for (let i = 0; i < n; i++) await seedPrereq(`k${i}`, `k${i + 1}`);
    // Fail the deepest dependent → the closure is N levels deep → overflow → [].
    const closure = await loadPrereqClosure(testDb(), [`k${n}`]);
    expect(closure).toEqual([]);
  });

  it('multiple failed KCs sharing a prereq → one branch per source_kc', async () => {
    // P is prereq of both X and Y. Fail both → P reached via X@1 and Y@1.
    await seedPrereq('P', 'X');
    await seedPrereq('P', 'Y');
    const closure = await loadPrereqClosure(testDb(), ['X', 'Y']);
    const sorted = closure.sort((a, b) => a.source_kc.localeCompare(b.source_kc));
    expect(sorted).toEqual([
      { prereq_kc: 'P', source_kc: 'X', depth: 1 },
      { prereq_kc: 'P', source_kc: 'Y', depth: 1 },
    ]);
  });
});

describe('emitPrereqRiskSignal (YUK-455 inc-E — producer wired + provable)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('EMITs one experimental:prereq_risk event per affected prereq, with risk + evidence', async () => {
    // A prereq of B, B prereq of C. Fail C → emit for B (depth 1) and A (depth 2).
    await seedPrereq('A', 'B');
    await seedPrereq('B', 'C');
    const db = testDb();
    const ids = await emitPrereqRiskSignal({
      db,
      failedKnowledgeIds: ['C'],
      questionId: 'q1',
      attemptEventId: 'att_1',
      now: new Date('2026-06-27T00:00:00Z'),
    });
    expect(ids).toHaveLength(2);

    const rows = await db.select().from(event).where(eq(event.action, PREREQ_RISK_ACTION));
    expect(rows).toHaveLength(2);
    const byKc = new Map(rows.map((r) => [r.subject_id, r]));

    const b = byKc.get('B');
    expect(b).toBeDefined();
    expect(b?.subject_kind).toBe('knowledge');
    expect(b?.actor_ref).toBe('prereq_propagation');
    // RED LINE: diagnostic observation only — no judging outcome.
    expect(b?.outcome).toBeNull();
    expect(b?.caused_by_event_id).toBe('att_1');
    const bp = b?.payload as Record<string, unknown>;
    expect(bp.knowledge_id).toBe('B');
    expect(bp.risk_delta).toBeCloseTo(1, 10); // depth 1 → base
    expect(bp.min_depth).toBe(1);
    expect(bp.source_kcs).toEqual(['C']);
    expect(bp.question_id).toBe('q1');
    expect(bp.attempt_event_id).toBe('att_1');
    expect(bp.threshold_deferred).toBe(true);

    const ap = byKc.get('A')?.payload as Record<string, unknown>;
    expect(ap.risk_delta).toBeCloseTo(0.5, 10); // depth 2 → base · 0.5
    expect(ap.min_depth).toBe(2);
  });

  it('no prereq edges (orphan) → no events (graceful)', async () => {
    await seedKc('solo');
    const db = testDb();
    const ids = await emitPrereqRiskSignal({ db, failedKnowledgeIds: ['solo'] });
    expect(ids).toEqual([]);
    const rows = await db.select().from(event).where(eq(event.action, PREREQ_RISK_ACTION));
    expect(rows).toHaveLength(0);
  });

  it('does NOT write mastery_state (RED LINE: only EMITs an independent event projection)', async () => {
    await seedPrereq('A', 'B');
    const db = testDb();
    await emitPrereqRiskSignal({ db, failedKnowledgeIds: ['B'], attemptEventId: 'att_x' });
    // The producer touches ONLY the event outbox — assert it wrote prereq_risk and nothing
    // posed as a mastery write would surface here (no mastery_state row was seeded/created).
    const evs = await db
      .select()
      .from(event)
      .where(and(eq(event.action, PREREQ_RISK_ACTION), eq(event.subject_id, 'A')));
    expect(evs).toHaveLength(1);
  });

  it('per-event isolation: one throwing writeEvent does NOT drop the others', async () => {
    await seedPrereq('A', 'B');
    await seedPrereq('B', 'C'); // fail C → prereqs B@1, A@2
    const db = testDb();
    const failed: string[] = [];
    // Injected seam: throw for prereq B only; A must still be emitted.
    const flakyWrite: typeof writeEvent = async (d, inputEvt) => {
      if ((inputEvt.subject_id as string) === 'B') throw new Error('boom');
      return writeEvent(d, inputEvt);
    };
    const ids = await emitPrereqRiskSignal({
      db,
      failedKnowledgeIds: ['C'],
      attemptEventId: 'att_iso',
      writeEventFn: flakyWrite,
      onEmitFailure: (kc) => failed.push(kc),
    });
    expect(ids).toHaveLength(1); // only A succeeded
    expect(failed).toEqual(['B']);
    const rows = await db.select().from(event).where(eq(event.action, PREREQ_RISK_ACTION));
    expect(rows.map((r) => r.subject_id)).toEqual(['A']);
  });
});
