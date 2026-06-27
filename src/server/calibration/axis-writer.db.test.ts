// YUK-445 (A11) — learner_axis_state batch writer + reader db tests.
//
// hermetic 契约：每个 db 测在 beforeEach resetDb()。
//
// Covers: the pure per-KC reducers (foldResponsesByKc / recoverKcAxis gate + provenance), the
// advisory-locked upsert + read round-trip, and runAxisStateBatch end-to-end (usage gate,
// provenance-gated drift_v, primary-KC attribution, RT/outcome filtering).

import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { event, learner_axis_state, question } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { resetDb } from '../../../tests/helpers/db';
import {
  AXIS_MIN_OBS,
  type AxisAttempt,
  foldResponsesByKc,
  readLearnerAxisStates,
  recoverKcAxis,
  runAxisStateBatch,
  upsertLearnerAxisState,
} from './axis-writer';

const NOW = new Date('2026-06-27T05:40:00+08:00');

async function seedQuestion(id: string, knowledgeIds: string[]): Promise<void> {
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `Prompt ${id}`,
    reference_md: null,
    knowledge_ids: knowledgeIds,
    difficulty: 3,
    source: 'manual',
    draft_status: null,
    variant_depth: 0,
    created_at: NOW,
    updated_at: NOW,
    version: 0,
  });
}

async function seedAttempt(
  questionId: string,
  outcome: 'success' | 'failure' | 'partial' | null,
  payload: Record<string, unknown>,
  createdAt: Date,
  // The writer admits BOTH action='attempt' (paper-submit) and action='review'
  // (solo PfSolo — the primary live RT source for a single-user tool). Default
  // 'attempt'; the review-path tests below seed 'review' explicitly.
  action: 'attempt' | 'review' = 'attempt',
): Promise<void> {
  await db.insert(event).values({
    id: newId(),
    actor_kind: 'user',
    actor_ref: 'self',
    action,
    subject_kind: 'question',
    subject_id: questionId,
    outcome,
    payload,
    created_at: createdAt,
  });
}

async function readAxisRow(subjectId: string) {
  const rows = await db
    .select()
    .from(learner_axis_state)
    .where(eq(learner_axis_state.subject_id, subjectId));
  return rows[0] ?? null;
}

describe('foldResponsesByKc (pure)', () => {
  it('groups by KC, collecting correct-only RTs and total/correct counts', () => {
    const attempts: AxisAttempt[] = [
      { kc: 'a', correct: true, rtSeconds: 0.5 },
      { kc: 'a', correct: false, rtSeconds: 0.9 },
      { kc: 'a', correct: true, rtSeconds: 0.6 },
      { kc: 'b', correct: true, rtSeconds: 0.4 },
    ];
    const m = foldResponsesByKc(attempts);
    expect(m.get('a')).toEqual({ correctRtSeconds: [0.5, 0.6], correctCount: 2, totalCount: 3 });
    expect(m.get('b')).toEqual({ correctRtSeconds: [0.4], correctCount: 1, totalCount: 1 });
  });
});

describe('recoverKcAxis (pure) — usage gate + provenance gate', () => {
  const acc = {
    correctRtSeconds: Array.from({ length: 30 }, (_, i) => 0.5 + (i % 5) * 0.05),
    correctCount: 30,
    totalCount: 40,
  };

  it('returns null below the usage gate', () => {
    expect(recoverKcAxis('a', { ...acc, totalCount: AXIS_MIN_OBS - 1 }, 'adaptive')).toBeNull();
  });

  it('adaptive provenance does NOT persist drift_v (confounded)', () => {
    const r = recoverKcAxis('a', acc, 'adaptive');
    expect(r).not.toBeNull();
    expect(r?.ez.reason).toBe('ok');
    expect(r?.persistDriftV).toBe(false);
    // boundary_a + ter ARE recoverable.
    expect(r?.ez.a).not.toBeNull();
    expect(r?.ez.ter).not.toBeNull();
  });

  it('probe provenance persists drift_v', () => {
    const r = recoverKcAxis('a', acc, 'probe');
    expect(r?.persistDriftV).toBe(true);
    expect(r?.ez.v).not.toBeNull();
  });
});

describe('upsertLearnerAxisState + readLearnerAxisStates', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('inserts then overwrites the same (kind, id) row (slow-varying)', async () => {
    await upsertLearnerAxisState(db, {
      subjectId: 'kc-1',
      driftV: null,
      boundaryA: 0.12,
      ter: 0.3,
      nObs: 35,
      provenance: 'adaptive',
    });
    let got = await readLearnerAxisStates(db, ['kc-1']);
    expect(got.get('kc-1')).toMatchObject({ boundaryA: 0.12, ter: 0.3, nObs: 35, driftV: null });

    await upsertLearnerAxisState(db, {
      subjectId: 'kc-1',
      driftV: 0.2,
      boundaryA: 0.14,
      ter: 0.28,
      nObs: 50,
      provenance: 'probe',
    });
    got = await readLearnerAxisStates(db, ['kc-1']);
    expect(got.size).toBe(1);
    expect(got.get('kc-1')).toMatchObject({
      driftV: 0.2,
      boundaryA: 0.14,
      ter: 0.28,
      nObs: 50,
      provenance: 'probe',
    });

    // single row (overwrite, not append).
    const rows = await db.select().from(learner_axis_state);
    expect(rows.length).toBe(1);
  });

  it('readLearnerAxisStates returns empty for unknown / empty inputs', async () => {
    expect((await readLearnerAxisStates(db, [])).size).toBe(0);
    expect((await readLearnerAxisStates(db, ['nope'])).size).toBe(0);
  });
});

describe('runAxisStateBatch — end-to-end', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // Seed `total` attempts on a question (primary KC), `correct` of them success with varied RTs.
  // `action` selects the event action ('attempt' = paper-submit, 'review' = solo PfSolo); both
  // are admitted by the writer. `actions` (mutually exclusive with `action`) interleaves a
  // per-index action sequence so a single KC can mix attempt + review responses.
  async function seedKcAttempts(
    kc: string,
    correct: number,
    total: number,
    opts: {
      withRt?: boolean;
      action?: 'attempt' | 'review';
      actions?: ('attempt' | 'review')[];
    } = {},
  ): Promise<string> {
    const withRt = opts.withRt ?? true;
    const qid = `q-${kc}`;
    await seedQuestion(qid, [kc]);
    for (let i = 0; i < total; i++) {
      const isCorrect = i < correct;
      // vary correct RTs deterministically so VRT > 0 (0.45–0.75 s).
      const durationMs = withRt ? 450 + (i % 7) * 50 : undefined;
      const payload: Record<string, unknown> =
        durationMs === undefined ? {} : { duration_ms: durationMs };
      const action = opts.actions
        ? opts.actions[i % opts.actions.length]
        : (opts.action ?? 'attempt');
      await seedAttempt(
        qid,
        isCorrect ? 'success' : 'failure',
        payload,
        new Date(NOW.getTime() + i * 1000),
        action,
      );
    }
    return qid;
  }

  it('adaptive batch writes boundary_a + ter, leaves drift_v NULL, records n_obs', async () => {
    await seedKcAttempts('kc-live', 30, 40); // Pc = 0.75, 30 correct RTs
    const res = await runAxisStateBatch(db); // provenance defaults to 'adaptive'
    expect(res.written).toBe(1);
    expect(res.kcsSeen).toBe(1);

    const row = await readAxisRow('kc-live');
    expect(row).not.toBeNull();
    expect(row?.provenance).toBe('adaptive');
    expect(row?.n_obs).toBe(40);
    expect(row?.boundary_a).not.toBeNull();
    expect(row?.ter).not.toBeNull();
    // A11 hard boundary: drift_v confounded in the adaptive flow.
    expect(row?.drift_v).toBeNull();
  });

  it('probe batch persists drift_v', async () => {
    await seedKcAttempts('kc-probe', 30, 40);
    await runAxisStateBatch(db, { provenance: 'probe' });
    const row = await readAxisRow('kc-probe');
    expect(row?.provenance).toBe('probe');
    expect(row?.drift_v).not.toBeNull();
  });

  it('usage-gates: a KC below AXIS_MIN_OBS gets no row', async () => {
    await seedKcAttempts('kc-thin', 8, 10); // below gate
    const res = await runAxisStateBatch(db);
    expect(res.written).toBe(0);
    expect(await readAxisRow('kc-thin')).toBeNull();
  });

  it('ignores attempts without an RT (paper attempts) — they never reach the gate', async () => {
    await seedKcAttempts('kc-nort', 30, 40, { withRt: false });
    const res = await runAxisStateBatch(db);
    // No RT-bearing attempts → KC never accumulates → not even seen.
    expect(res.written).toBe(0);
    expect(await readAxisRow('kc-nort')).toBeNull();
  });

  it('attributes to the question primary KC and isolates distinct KCs', async () => {
    await seedKcAttempts('kc-x', 30, 40);
    await seedKcAttempts('kc-y', 10, 12); // below gate
    const res = await runAxisStateBatch(db);
    expect(res.written).toBe(1);
    expect(await readAxisRow('kc-x')).not.toBeNull();
    expect(await readAxisRow('kc-y')).toBeNull();
  });

  // The PRIMARY live RT source for a single-user tool is solo PfSolo, which emits
  // action='review' (submit.ts:539) carrying payload.duration_ms (mapped from the UI's
  // latency_ms, submit.ts:564) — NOT action='attempt' (that's the paper-submit path,
  // paper-submit.ts:545). The writer admits BOTH (inArray(action, ['attempt','review'])).
  // This proves the review path reaches the gate and lands an axis row end-to-end — i.e. the
  // feature's main live source is genuinely non-dead code, not only the paper attempt path.
  it('recovers an axis row from solo review-action RTs (primary live source)', async () => {
    await seedKcAttempts('kc-review', 30, 40, { action: 'review' });
    const res = await runAxisStateBatch(db);
    expect(res.written).toBe(1);
    expect(res.kcsSeen).toBe(1);

    const row = await readAxisRow('kc-review');
    expect(row).not.toBeNull();
    expect(row?.n_obs).toBe(40);
    expect(row?.boundary_a).not.toBeNull();
    expect(row?.ter).not.toBeNull();
    // adaptive flow → drift_v stays confounded/NULL regardless of action source.
    expect(row?.drift_v).toBeNull();
  });

  it('pools attempt + review responses for the same KC into one axis row', async () => {
    // Interleave attempt/review across the 40 responses on a single KC; the reducer is
    // action-agnostic post-query, so all RT-bearing responses fold into one accumulator.
    await seedKcAttempts('kc-mixed', 30, 40, { actions: ['attempt', 'review'] });
    const res = await runAxisStateBatch(db);
    expect(res.written).toBe(1);
    expect(res.kcsSeen).toBe(1);

    const row = await readAxisRow('kc-mixed');
    expect(row).not.toBeNull();
    expect(row?.n_obs).toBe(40); // all 40 (both actions) pooled
    expect(row?.boundary_a).not.toBeNull();
    expect(row?.ter).not.toBeNull();
  });
});
