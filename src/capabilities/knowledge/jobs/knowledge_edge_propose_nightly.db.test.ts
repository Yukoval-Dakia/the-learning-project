import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db/client';
import { event, knowledge, question } from '@/db/schema';
import { resetDb } from '../../../../tests/helpers/db';
import {
  loadEdgeProposeWatermark,
  runKnowledgeEdgeProposeNightly,
  writeEdgeProposeWatermark,
} from './knowledge_edge_propose_nightly';

describe('knowledge_edge_propose_nightly handler', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns empty stats when no failure attempts in window', async () => {
    const runTaskFn = vi.fn(async () => ({ text: '{"proposals":[]}' }));
    const result = await runKnowledgeEdgeProposeNightly(db, { runTaskFn });
    expect(result.attempts_considered).toBe(0);
    expect(result.proposed).toBe(0);
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('runs propose pass once across the batch of recent failures', async () => {
    const k1 = createId();
    const k2 = createId();
    const now = new Date();
    await db.insert(knowledge).values([
      {
        id: k1,
        name: 'K1',
        domain: 'math',
        parent_id: null,
        created_at: now,
        updated_at: now,
      },
      {
        id: k2,
        name: 'K2',
        domain: 'math',
        parent_id: null,
        created_at: now,
        updated_at: now,
      },
    ]);

    // P5.4 §5-Q5 / YUK-175 — the batch path now runs the L1 rubric floor before
    // a live write. A `related_to` edge needs STRONG (≥2 same-pattern in-window
    // judge-backed failures) endpoint-touching evidence, so seed two judge-backed
    // failures referencing k1/k2 with the same cause category.
    const qIds = [createId(), createId()];
    const attemptIds = [createId(), createId()];
    for (let i = 0; i < 2; i++) {
      await db.insert(question).values({
        id: qIds[i],
        kind: 'short_answer',
        prompt_md: 'p',
        reference_md: null,
        knowledge_ids: [k1, k2],
        source: 'manual',
        created_at: now,
        updated_at: now,
      });
      await db.insert(event).values({
        id: attemptIds[i],
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: qIds[i],
        outcome: 'failure',
        payload: {
          answer_md: 'w',
          answer_image_refs: [],
          referenced_knowledge_ids: [k1, k2],
        },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: now,
      });
      await db.insert(event).values({
        id: `judge_${attemptIds[i]}`,
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'attribution',
        action: 'judge',
        subject_kind: 'event',
        subject_id: attemptIds[i],
        outcome: 'success',
        payload: {
          cause: {
            primary_category: 'concept',
            secondary_categories: [],
            analysis_md: '反复混淆 K1 与 K2。',
            confidence: 0.9,
          },
          referenced_knowledge_ids: [k1, k2],
        },
        caused_by_event_id: attemptIds[i],
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date(now.getTime() + 500),
      });
    }

    const runTaskFn = vi.fn(async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: JSON.stringify({
        proposals: [
          {
            from_knowledge_id: k1,
            to_knowledge_id: k2,
            relation_type: 'related_to',
            weight: 0.6,
            reasoning: `attempt ${attemptIds[0]} judge cause concept：K1/K2 反复失败。`,
          },
        ],
      }),
    }));

    const result = await runKnowledgeEdgeProposeNightly(db, { runTaskFn });
    expect(result.attempts_considered).toBe(2);
    expect(result.proposed).toBe(1);
    expect(result.folded_rubric_rejected).toBe(0);
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect(runTaskFn.mock.calls[0]?.[2]).toMatchObject({
      subjectProfile: { id: 'math' },
    });

    // Verify event written
    const events = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ours = events.find((e) => {
      const p = e.payload as { from_knowledge_id?: string; to_knowledge_id?: string };
      return p.from_knowledge_id === k1 && p.to_knowledge_id === k2;
    });
    expect(ours).toBeTruthy();

    // Cleanup
    if (ours?.id) {
      await db.delete(event).where(eq(event.id, ours.id));
    }
    for (let i = 0; i < 2; i++) {
      await db.delete(event).where(eq(event.id, `judge_${attemptIds[i]}`));
      await db.delete(event).where(eq(event.id, attemptIds[i]));
      await db.delete(question).where(eq(question.id, qIds[i]));
    }
    await db.delete(knowledge).where(eq(knowledge.id, k1));
    await db.delete(knowledge).where(eq(knowledge.id, k2));
  });

  it('skips failure attempts older than 24h', async () => {
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const qId = createId();
    await db.insert(question).values({
      id: qId,
      kind: 'short_answer',
      prompt_md: 'p',
      reference_md: null,
      source: 'manual',
      created_at: oldDate,
      updated_at: oldDate,
    });
    const attemptId = createId();
    await db.insert(event).values({
      id: attemptId,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: qId,
      outcome: 'failure',
      payload: { answer_md: 'w', answer_image_refs: [], referenced_knowledge_ids: [] },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: oldDate,
    });

    const runTaskFn = vi.fn(async () => ({ text: '{"proposals":[]}' }));
    const result = await runKnowledgeEdgeProposeNightly(db, { runTaskFn });
    expect(result.attempts_considered).toBe(0);
    expect(runTaskFn).not.toHaveBeenCalled();

    await db.delete(event).where(eq(event.id, attemptId));
    await db.delete(question).where(eq(question.id, qId));
  });
});

// YUK-583 — watermark 续扫 replaces the lossy 24h rolling window. These tests pin the
// four failure modes the design calls out: (①) an event that fell between the last
// cursor and the 24h window is scanned, not dropped; (②) a吞错夜 (swallowed pipeline
// error) does NOT advance the cursor; (③) a successful batch with ZERO proposals STILL
// advances (空区间 fix) and is not re-scanned; (④) a backlog > scan limit pages across
// runs without loss or duplication. Each would FAIL against the old 24h-window code.
describe('knowledge_edge_propose_nightly watermark 续扫 (YUK-583)', () => {
  const HOUR_MS = 60 * 60 * 1000;
  let K1: string;

  beforeEach(async () => {
    await resetDb();
    // Non-empty tree so runEdgeProposeAndWrite reaches the LLM call (an empty tree
    // short-circuits BEFORE runTaskFn).
    K1 = createId();
    const now = new Date();
    await db.insert(knowledge).values({
      id: K1,
      name: 'K1',
      domain: 'math',
      parent_id: null,
      created_at: now,
      updated_at: now,
    });
  });

  async function seedFailureAttempt(createdAt: Date): Promise<string> {
    const qId = createId();
    const attemptId = createId();
    await db.insert(question).values({
      id: qId,
      kind: 'short_answer',
      prompt_md: 'p',
      reference_md: null,
      knowledge_ids: [K1],
      source: 'manual',
      created_at: createdAt,
      updated_at: createdAt,
    });
    await db.insert(event).values({
      id: attemptId,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: qId,
      outcome: 'failure',
      payload: { answer_md: 'w', answer_image_refs: [], referenced_knowledge_ids: [K1] },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: createdAt,
    });
    return attemptId;
  }

  // Captures the attempt_event_ids handed to the LLM each call (order-preserving), and
  // declines to propose anything so no rubric/topology processing runs.
  function capturingRunTask() {
    const batches: string[][] = [];
    const fn = vi.fn(async (_kind: string, input: unknown, _ctx: unknown) => {
      const recent = (input as { recent_failures: Array<{ attempt_event_id: string }> })
        .recent_failures;
      batches.push(recent.map((r) => r.attempt_event_id));
      return { text: '{"proposals":[]}' };
    });
    return { fn, batches };
  }

  it('① scans a failure that fell between the last cursor and the 24h window (lossy-window fix)', async () => {
    const now = Date.now();
    // Cursor 72h ago; the failure is 36h ago — AFTER the cursor but OLDER than the 24h
    // window the legacy code scanned, so that window silently dropped it forever.
    await writeEdgeProposeWatermark(db, {
      last_processed_at: new Date(now - 72 * HOUR_MS),
      last_processed_event_id: 'seed-cursor',
    });
    const lost = await seedFailureAttempt(new Date(now - 36 * HOUR_MS));

    const { fn, batches } = capturingRunTask();
    const result = await runKnowledgeEdgeProposeNightly(db, { runTaskFn: fn });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(batches[0]).toContain(lost);
    expect(result.attempts_considered).toBe(1);
  });

  it('② does NOT advance the cursor on a吞错夜 (swallowed error), and re-scans next run', async () => {
    const now = Date.now();
    await writeEdgeProposeWatermark(db, {
      last_processed_at: new Date(now - 72 * HOUR_MS),
      last_processed_event_id: 'seed-cursor',
    });
    const attempt = await seedFailureAttempt(new Date(now - 10 * HOUR_MS));

    // runTaskFn throws → runEdgeProposeAndWrite SWALLOWS it → ok:false.
    const throwing = vi.fn(async () => {
      throw new Error('simulated LLM outage');
    });
    const failed = await runKnowledgeEdgeProposeNightly(db, { runTaskFn: throwing });
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(failed.proposed).toBe(0);

    // Cursor unchanged — still the seeded 72h-ago anchor, NOT advanced to `attempt`.
    const afterFail = await loadEdgeProposeWatermark(db);
    expect(afterFail?.last_processed_event_id).toBe('seed-cursor');

    // Healthy next run re-scans the same attempt, then advances.
    const { fn, batches } = capturingRunTask();
    await runKnowledgeEdgeProposeNightly(db, { runTaskFn: fn });
    expect(batches[0]).toContain(attempt);
    const afterOk = await loadEdgeProposeWatermark(db);
    expect(afterOk?.last_processed_event_id).toBe(attempt);
  });

  it('③ advances on a successful ZERO-proposal batch and does not re-scan it (空区间 fix)', async () => {
    const now = Date.now();
    await writeEdgeProposeWatermark(db, {
      last_processed_at: new Date(now - 72 * HOUR_MS),
      last_processed_event_id: 'seed-cursor',
    });
    const attempt = await seedFailureAttempt(new Date(now - 10 * HOUR_MS));

    // Batch is processed but the LLM proposes nothing (proposed === 0).
    const { fn: run1, batches: b1 } = capturingRunTask();
    const r1 = await runKnowledgeEdgeProposeNightly(db, { runTaskFn: run1 });
    expect(b1[0]).toContain(attempt);
    expect(r1.proposed).toBe(0);

    // Advanced despite zero proposals (gate is "batch processed", not "proposed > 0").
    const wm = await loadEdgeProposeWatermark(db);
    expect(wm?.last_processed_event_id).toBe(attempt);

    // Next run: nothing after the cursor → vacuum, no LLM call, not re-scanned.
    const { fn: run2 } = capturingRunTask();
    const r2 = await runKnowledgeEdgeProposeNightly(db, { runTaskFn: run2 });
    expect(run2).not.toHaveBeenCalled();
    expect(r2.attempts_considered).toBe(0);
  });

  it('④ pages a backlog larger than the scan limit across runs without loss or duplication', async () => {
    const now = Date.now();
    await writeEdgeProposeWatermark(db, {
      last_processed_at: new Date(now - 72 * HOUR_MS),
      last_processed_event_id: 'seed-cursor',
    });
    // Three failures, strictly increasing created_at, all after the cursor.
    const a1 = await seedFailureAttempt(new Date(now - 30 * HOUR_MS));
    const a2 = await seedFailureAttempt(new Date(now - 20 * HOUR_MS));
    const a3 = await seedFailureAttempt(new Date(now - 10 * HOUR_MS));

    const { fn, batches } = capturingRunTask();
    // scanLimit 2 → run 1 reads the OLDEST 2 (a1, a2), advances to a2.
    await runKnowledgeEdgeProposeNightly(db, { runTaskFn: fn, scanLimit: 2 });
    expect(batches[0]).toEqual([a1, a2]);

    // Run 2 continues from a2 → reads a3.
    await runKnowledgeEdgeProposeNightly(db, { runTaskFn: fn, scanLimit: 2 });
    expect(batches[1]).toEqual([a3]);

    // Run 3 → vacuum (nothing after a3), no LLM call.
    await runKnowledgeEdgeProposeNightly(db, { runTaskFn: fn, scanLimit: 2 });
    expect(fn).toHaveBeenCalledTimes(2);

    // Union across runs = all three, exactly once each (no loss, no duplication).
    expect([...batches[0], ...batches[1]]).toEqual([a1, a2, a3]);
  });
});
