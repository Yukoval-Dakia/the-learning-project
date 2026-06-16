// YUK-361 Phase 6 (Task 11) — active-PPI 重标定 db 测。
//
// 验证：
//   (A) recordDifficultyCalibrationLabel —— π_i join（只 softmax_mfi selected 观测）/
//       非客观判分 skip / partial skip / θ-before 入 theta_snapshot / 无真 π_i skip /
//       去重（同 attempt 不重复）/ SAVEPOINT 隔离（label 写错不回滚主 attempt）。
//   (B) recalibrateQuestion —— 标签 < 阈值 → no-op（b_calib 保持 NULL，数据闸）；
//       ≥ 阈值 → b_calib firm-up（PPI++ AIPW）；无锚 → no_anchor no-op。
//   (C) effectiveB end-to-end —— b_calib NULL → 退回 b_anchor；set → 用 b_calib。

import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { recordSelectionObservation } from '@/capabilities/practice/server/selection-observations';
import { newId } from '@/core/ids';
import { db } from '@/db/client';
import {
  difficulty_calibration_label,
  item_calibration,
  practice_stream_item,
  question,
} from '@/db/schema';
import { resetDb } from '../../../tests/helpers/db';
import {
  RECALIBRATION_MIN_LABELS,
  effectiveB,
  impliedBLabel,
  recalibrateQuestion,
  recordDifficultyCalibrationLabel,
} from './recalibration';

// FINDING #3：π_i join 按作答本地日（Asia/Shanghai）等值 join selection_observation.date。
// 用一个**固定**的作答时刻让测试确定（不随真实日期漂移），并按同一时区公式派生它对应的
// 本地日（与 recalibration.ts attemptLocalDate / stream-store.ts streamLocalDate 同度量）。
const ATTEMPT_NOW = new Date('2026-06-16T08:00:00+08:00'); // = 2026-06-16 Asia/Shanghai
const ATTEMPT_LOCAL_DATE = ATTEMPT_NOW.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

function now() {
  return ATTEMPT_NOW;
}

async function seedQuestion(id: string, difficulty = 3) {
  await db.insert(question).values({
    id,
    kind: 'short_answer',
    prompt_md: `Prompt ${id}`,
    reference_md: null,
    knowledge_ids: [],
    difficulty,
    source: 'manual',
    variant_depth: 0,
    created_at: now(),
    updated_at: now(),
    version: 0,
  });
}

async function seedItemCalibration(questionId: string, b: number) {
  await db.insert(item_calibration).values({
    id: newId(),
    question_id: questionId,
    b,
    b_anchor: b,
    confidence: 0.5,
    track: 'hard',
    source: 'llm_prior',
    created_at: now(),
    updated_at: now(),
  });
}

/**
 * 物化一个当天的 practice_stream_item slot（softmax 选题落地态），返回行 id。
 * matched-stream-slot gate（Codex P2）要求观测引用一个真 slot，故 hook 的 happy path
 * 需要一个真物化 slot 存在。
 */
let _streamPos = 0;
async function seedStreamSlot(questionId: string, date = ATTEMPT_LOCAL_DATE) {
  const id = newId();
  await db.insert(practice_stream_item).values({
    id,
    date,
    position: _streamPos++,
    item_kind: 'question',
    ref_id: questionId,
    source: 'decay',
    status: 'done',
    reasoning: 'test slot',
    added_by: 'composer_live',
    signals: {},
    created_at: now(),
    updated_at: now(),
  });
  return id;
}

/**
 * 写一条 softmax_mfi selected 观测（真 π_i），供 label hook join。date 默认 = 作答本地日。
 * 默认**同时物化一个真 slot 并把观测 stream_item_id 钉到它**（matched-stream-slot gate，
 * Codex P2 happy path）。传 `streamItemId: null` 可显式造「候选层观测（无真 slot）」用于
 * 否定测；传一个不存在的 id 可造「slot 已被删/重排回填后陈旧」用于否定测。
 */
async function seedSoftmaxObservation(
  questionId: string,
  pi: number,
  date = ATTEMPT_LOCAL_DATE,
  opts: { streamItemId?: string | null } = {},
): Promise<string | null> {
  let streamItemId: string | undefined;
  if (opts.streamItemId === null) {
    streamItemId = undefined; // candidate-layer observation, no materialized slot.
  } else if (opts.streamItemId !== undefined) {
    streamItemId = opts.streamItemId; // explicit (e.g. a dangling/deleted slot id).
  } else {
    streamItemId = await seedStreamSlot(questionId, date); // default: materialize a real slot.
  }
  await recordSelectionObservation(db, {
    date,
    streamItemId,
    refKind: 'question',
    refId: questionId,
    policy: 'softmax_mfi',
    selected: true,
    inclusionProbability: pi,
    signals: {},
  });
  // Return the slot id (or null for candidate-layer) so callers can thread it into the hook's
  // streamItemId param (YUK-372 L2 — π_i direct-join discriminant).
  return streamItemId ?? null;
}

async function readLabels(questionId: string) {
  return db
    .select()
    .from(difficulty_calibration_label)
    .where(eq(difficulty_calibration_label.question_id, questionId));
}

async function readCalibration(questionId: string) {
  const rows = await db
    .select()
    .from(item_calibration)
    .where(and(eq(item_calibration.question_id, questionId), eq(item_calibration.track, 'hard')))
    .limit(1);
  return rows[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// (A) label hook
// ─────────────────────────────────────────────────────────────────────────────
describe('recordDifficultyCalibrationLabel', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('softmax-selected objective attempt with the answered slot id → writes a label with the direct-join π_i + θ-before', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    const slotId = await seedSoftmaxObservation(q, 0.3);

    await db.transaction(async (tx) => {
      await recordDifficultyCalibrationLabel(tx, {
        questionId: q,
        attemptEventId: createId(),
        difficulty: 3,
        outcome: 0, // wrong
        judgeRoute: 'exact',
        thetaBefore: 0.5,
        now: now(),
        streamItemId: slotId, // YUK-372 L2 — answered slot id → direct π_i join.
      });
    });

    const labels = await readLabels(q);
    expect(labels).toHaveLength(1);
    expect(labels[0].inclusion_probability).toBeCloseTo(0.3, 6);
    expect(labels[0].theta_snapshot).toBeCloseTo(0.5, 6); // θ-before used
    expect(labels[0].outcome).toBe(0);
    // b_label = impliedBLabel(θ-before=0.5, b_anchor=0.5, outcome=0) — anchored IRT reverse.
    expect(labels[0].b_label).toBeCloseTo(impliedBLabel(0.5, 0.5, 0), 6);
    // wrong answer → b_label > b_anchor (题更难).
    expect(labels[0].b_label).toBeGreaterThan(0.5);
  });

  // YUK-372 L2 red-line #2 — the LOAD-BEARING regression sentinel. The question WAS softmax-
  // selected into today's stream (real slot, real π_i), but this attempt arrives with NO
  // streamItemId (e.g. a SAME-DAY standalone/scatter re-answer of the same question via a
  // non-stream path). The hook MUST skip — it must NEVER fall back to the (date, ref)
  // approximation and mis-attach the stream slot's π_i to a non-stream answer. Poisoning the
  // first batch of b_calib with a mis-attributed π_i is unrecoverable (slow asset).
  it('red-line #2: no streamItemId → SKIP even when a same-day softmax slot exists (no (date,ref) fallback)', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    // A real softmax slot + observation exists for the question TODAY (π=0.3).
    await seedSoftmaxObservation(q, 0.3);

    await db.transaction(async (tx) => {
      await recordDifficultyCalibrationLabel(tx, {
        questionId: q,
        attemptEventId: createId(),
        difficulty: 3,
        outcome: 0,
        judgeRoute: 'exact',
        thetaBefore: 0.5,
        now: now(),
        // streamItemId omitted → scatter/non-stream re-answer → MUST skip (no approximation).
      });
    });

    // ZERO labels — the stream slot's π_i was NOT mis-attached.
    expect(await readLabels(q)).toHaveLength(0);
  });

  // YUK-372 L2 — streamItemId points to a slot that is NOT the one the observation references
  // (a different materialized slot of the same question) → no matching observation → skip.
  it('streamItemId mismatched to the observation slot → SKIP', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    // The observation references slot-A (π=0.3).
    await seedSoftmaxObservation(q, 0.3);
    // But the attempt claims a DIFFERENT (unrelated, non-existent) slot id.
    const otherSlot = createId();

    await db.transaction(async (tx) => {
      await recordDifficultyCalibrationLabel(tx, {
        questionId: q,
        attemptEventId: createId(),
        difficulty: 3,
        outcome: 0,
        judgeRoute: 'exact',
        thetaBefore: 0.5,
        now: now(),
        streamItemId: otherSlot, // not slot-A → direct join finds no observation.
      });
    });

    expect(await readLabels(q)).toHaveLength(0);
  });

  // YUK-372 L2 — the answered slot-A exists and the attempt passes slot-A's id, but the only
  // softmax observation references a DIFFERENT slot-B. The direct join on stream_item_id=slot-A
  // finds no observation → skip (do not borrow slot-B's π_i).
  it('observation references a different slot than the answered one → SKIP', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    // Materialize slot-A (the answered slot) but DO NOT write an observation for it.
    const slotA = await seedStreamSlot(q, '2026-06-15'); // a real slot, different date to dodge unique
    // The observation references slot-B (today), π=0.7.
    await seedSoftmaxObservation(q, 0.7);

    await db.transaction(async (tx) => {
      await recordDifficultyCalibrationLabel(tx, {
        questionId: q,
        attemptEventId: createId(),
        difficulty: 3,
        outcome: 0,
        judgeRoute: 'exact',
        thetaBefore: 0.5,
        now: now(),
        streamItemId: slotA, // join on slot-A → no observation references slot-A → skip.
      });
    });

    expect(await readLabels(q)).toHaveLength(0);
  });

  it('non-objective judge route (semantic) → skip (no label, §6)', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    await seedSoftmaxObservation(q, 0.3);

    await db.transaction(async (tx) => {
      await recordDifficultyCalibrationLabel(tx, {
        questionId: q,
        attemptEventId: createId(),
        difficulty: 3,
        outcome: 1,
        judgeRoute: 'semantic', // LLM-backed, subjective → not in b-truth channel
        thetaBefore: 0,
        now: now(),
      });
    });

    expect(await readLabels(q)).toHaveLength(0);
  });

  it('partial outcome → skip (难度反推语义歧义)', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    await seedSoftmaxObservation(q, 0.3);

    await db.transaction(async (tx) => {
      await recordDifficultyCalibrationLabel(tx, {
        questionId: q,
        attemptEventId: createId(),
        difficulty: 3,
        outcome: 1,
        attemptOutcome: 'partial',
        judgeRoute: 'exact',
        thetaBefore: 0,
        now: now(),
      });
    });

    expect(await readLabels(q)).toHaveLength(0);
  });

  it('no softmax observation (legacy/due item, no real π_i) → skip', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    // Materialize a slot so the attempt reaches the π_i join, but write NO observation for it —
    // legacy/due item has no real π_i.
    const slotId = await seedStreamSlot(q);

    await db.transaction(async (tx) => {
      await recordDifficultyCalibrationLabel(tx, {
        questionId: q,
        attemptEventId: createId(),
        difficulty: 3,
        outcome: 0,
        judgeRoute: 'exact',
        thetaBefore: 0,
        now: now(),
        streamItemId: slotId, // slot exists but no softmax_mfi observation → skip.
      });
    });

    expect(await readLabels(q)).toHaveLength(0);
  });

  it('legacy-policy observation does NOT count as real π_i → skip', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    // Materialize the answered slot, but its observation is LEGACY (deterministic, not random).
    const slotId = await seedStreamSlot(q);
    await recordSelectionObservation(db, {
      date: ATTEMPT_LOCAL_DATE,
      streamItemId: slotId,
      refKind: 'question',
      refId: q,
      policy: 'legacy',
      selected: true,
      inclusionProbability: 1, // deterministic placeholder, not a real IPW weight
      signals: {},
    });

    await db.transaction(async (tx) => {
      await recordDifficultyCalibrationLabel(tx, {
        questionId: q,
        attemptEventId: createId(),
        difficulty: 3,
        outcome: 0,
        judgeRoute: 'exact',
        thetaBefore: 0,
        now: now(),
        streamItemId: slotId, // join on slot finds only a legacy (non-softmax_mfi) obs → skip.
      });
    });

    expect(await readLabels(q)).toHaveLength(0);
  });

  it('FINDING #3 — π_i is joined from the answered slot, not a later re-selection of the same question', async () => {
    // Two softmax observations for the SAME question on different slots/dates:
    //   - day-1 (attempt date): π=0.3 on slot-A — the event that PLACED the answered slot.
    //   - day-5 (later):        π=0.7 on slot-B — a later re-selection.
    // The attempt answers slot-A. The direct join on stream_item_id=slot-A MUST use π=0.3
    // (the answered slot's weight), NOT 0.7 (the later re-selection the old ORDER BY DESC took).
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    const slotA = await seedSoftmaxObservation(q, 0.3, ATTEMPT_LOCAL_DATE); // answered slot
    await seedSoftmaxObservation(q, 0.7, '2026-06-20'); // later re-selection, different slot

    await db.transaction(async (tx) => {
      await recordDifficultyCalibrationLabel(tx, {
        questionId: q,
        attemptEventId: createId(),
        difficulty: 3,
        outcome: 0,
        judgeRoute: 'exact',
        thetaBefore: 0,
        now: now(), // = ATTEMPT_NOW → attempt local date = ATTEMPT_LOCAL_DATE
        streamItemId: slotA,
      });
    });

    const labels = await readLabels(q);
    expect(labels).toHaveLength(1);
    // Joined the answered slot's π (0.3), NOT the later re-selection's 0.7.
    expect(labels[0].inclusion_probability).toBeCloseTo(0.3, 6);
    expect(labels[0].inclusion_probability).not.toBeCloseTo(0.7, 2);
  });

  it('FINDING #3 — answered slot has no observation on the attempt date (race-guard date mismatch) → skip', async () => {
    // The attempt's slot id refers to a slot materialized on a DIFFERENT date than the attempt.
    // The redundant date race-guard (slot.date = attempt local date) fails → skip.
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    // Slot + observation are on a date OTHER than the attempt date.
    const otherDaySlot = await seedSoftmaxObservation(q, 0.7, '2026-06-20');

    await db.transaction(async (tx) => {
      await recordDifficultyCalibrationLabel(tx, {
        questionId: q,
        attemptEventId: createId(),
        difficulty: 3,
        outcome: 0,
        judgeRoute: 'exact',
        thetaBefore: 0,
        now: now(), // attempt date = ATTEMPT_LOCAL_DATE ≠ slot's 2026-06-20
        streamItemId: otherDaySlot,
      });
    });

    expect(await readLabels(q)).toHaveLength(0);
  });

  it('Codex P2 — softmax observation with NULL stream_item_id (candidate-layer, no real slot) → skip', async () => {
    // The question WAS softmax-evaluated today, but the observation has no materialized
    // stream slot (stream_item_id NULL — candidate-layer / pre-materialization observation).
    // Even if the attempt passes a (real, separate) slot id, the direct join finds no observation
    // referencing it (the only observation has stream_item_id NULL) → skip.
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    await seedSoftmaxObservation(q, 0.3, ATTEMPT_LOCAL_DATE, { streamItemId: null });
    // A real materialized slot the attempt claims (different date to dodge the (date,ref) unique).
    const slotId = await seedStreamSlot(q);

    await db.transaction(async (tx) => {
      await recordDifficultyCalibrationLabel(tx, {
        questionId: q,
        attemptEventId: createId(),
        difficulty: 3,
        outcome: 0,
        judgeRoute: 'exact',
        thetaBefore: 0,
        now: now(),
        streamItemId: slotId, // join finds no observation referencing this slot → skip.
      });
    });

    expect(await readLabels(q)).toHaveLength(0);
  });

  it('Codex P2 — observation references a stream slot that no longer exists (deleted/recomposed) → skip', async () => {
    // The observation carries a stream_item_id, but that practice_stream_item row was deleted
    // (e.g. a later recompose re-filled the slot). The attempt passes that same (now-dangling) id;
    // the matched-stream-slot race-guard joins the slot and finds none → skip.
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    const danglingId = createId();
    // observation references danglingId, but NO practice_stream_item row exists for it.
    await seedSoftmaxObservation(q, 0.3, ATTEMPT_LOCAL_DATE, { streamItemId: danglingId });

    await db.transaction(async (tx) => {
      await recordDifficultyCalibrationLabel(tx, {
        questionId: q,
        attemptEventId: createId(),
        difficulty: 3,
        outcome: 0,
        judgeRoute: 'exact',
        thetaBefore: 0,
        now: now(),
        streamItemId: danglingId, // obs exists for this id, but no live slot → race-guard skip.
      });
    });

    expect(await readLabels(q)).toHaveLength(0);
  });

  // YUK-372 L2 — the Codex P2 RESIDUAL seam is now CLOSED. The same-day non-stream re-answer
  // case (question softmax-selected into the materialized stream, then answered via a non-stream
  // path) no longer mis-attaches the slot's π_i: the attempt path now threads the answered slot's
  // stream_item_id (or null for non-stream answers), and the hook direct-joins on it / skips when
  // absent (see the red-line #2 sentinel above). No deferred residual remains here.

  it('falls back to weak difficulty anchor when no item_calibration row', async () => {
    const q = createId();
    await seedQuestion(q, 4);
    // NO item_calibration row — anchor falls to difficultyToLogitB(4).
    const slotId = await seedSoftmaxObservation(q, 0.5);

    await db.transaction(async (tx) => {
      await recordDifficultyCalibrationLabel(tx, {
        questionId: q,
        attemptEventId: createId(),
        difficulty: 4,
        outcome: 0,
        judgeRoute: 'keyword',
        thetaBefore: 0,
        now: now(),
        streamItemId: slotId,
      });
    });

    const labels = await readLabels(q);
    expect(labels).toHaveLength(1);
    // b_anchor = difficultyToLogitB(4) = (4-3)*0.85 = 0.85.
    expect(labels[0].b_label).toBeCloseTo(impliedBLabel(0, 0.85, 0), 6);
  });

  it('duplicate attempt_event_id → at most one label (onConflictDoNothing)', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    const slotId = await seedSoftmaxObservation(q, 0.3);
    const eid = createId();

    for (const out of [0, 1] as const) {
      await db.transaction(async (tx) => {
        await recordDifficultyCalibrationLabel(tx, {
          questionId: q,
          attemptEventId: eid,
          difficulty: 3,
          outcome: out,
          judgeRoute: 'exact',
          thetaBefore: 0,
          now: now(),
          streamItemId: slotId,
        });
      });
    }

    expect(await readLabels(q)).toHaveLength(1);
  });

  it('SAVEPOINT isolation — a label-write DB error does NOT roll back the main attempt write', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    await seedSoftmaxObservation(q, 0.3);

    await db.transaction(async (tx) => {
      // (1) main attempt write proxy (θ̂/FSRS/event represented by a question row mutate).
      await tx.update(question).set({ prompt_md: 'main-write' }).where(eq(question.id, q));

      // (2) SAVEPOINT-wrapped label write that forces a DB-level error → poisons only the
      //     savepoint, not the outer tx (mirror the established Phase 5 pattern).
      try {
        await tx.transaction(async (sp) => {
          await sp.execute(sql`SELECT CAST('not-a-number' AS integer)`);
        });
      } catch {
        // hook best-effort swallow.
      }

      // (3) outer tx still writable → not poisoned (would throw 25P02 if it were).
      await tx.update(question).set({ prompt_md: 'main-write-after' }).where(eq(question.id, q));
    });

    const rows = await db.select().from(question).where(eq(question.id, q));
    expect(rows).toHaveLength(1);
    expect(rows[0].prompt_md).toBe('main-write-after'); // step (3) ran → tx survived.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (B) recalibrateQuestion — data-gated firm-up
// ─────────────────────────────────────────────────────────────────────────────
describe('recalibrateQuestion (data-gated AIPW firm-up)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  /** 直接种 N 条标签（绕过 hook，专测重标定数学/门控）。 */
  async function seedLabels(questionId: string, bLabels: number[], pi = 0.5) {
    for (const bl of bLabels) {
      await db.insert(difficulty_calibration_label).values({
        id: newId(),
        question_id: questionId,
        attempt_event_id: createId(),
        theta_snapshot: 0,
        outcome: 0,
        b_label: bl,
        inclusion_probability: pi,
        created_at: now(),
      });
    }
  }

  it('below threshold → no-op (b_calib stays NULL, data gate)', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    await seedLabels(q, Array(RECALIBRATION_MIN_LABELS - 1).fill(1.2));

    const result = await recalibrateQuestion(db, q);
    expect(result.updated).toBe(false);
    expect(result.reason).toBe('below_threshold');
    expect(result.labelCount).toBe(RECALIBRATION_MIN_LABELS - 1);

    const cal = await readCalibration(q);
    expect(cal?.b_calib).toBeNull(); // never firmed up below threshold
    expect(cal?.calibration_n).toBe(0);
  });

  it('at/above threshold → firm-up b_calib via PPI++ AIPW', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5); // b_anchor = 0.5
    // All labels say the true difficulty is ~1.5 (anchor under-estimated). π=0.5 uniform.
    await seedLabels(q, Array(RECALIBRATION_MIN_LABELS).fill(1.5), 0.5);

    const result = await recalibrateQuestion(db, q);
    expect(result.updated).toBe(true);
    expect(result.reason).toBe('ok');
    expect(result.labelCount).toBe(RECALIBRATION_MIN_LABELS);

    const cal = await readCalibration(q);
    expect(cal?.calibration_n).toBe(RECALIBRATION_MIN_LABELS);
    expect(cal?.last_calibrated_at).not.toBeNull();
    expect(cal?.calibration_weight).toBeCloseTo(RECALIBRATION_MIN_LABELS * 0.5, 6); // Σπ_i
    // b_calib should move toward the labels (≈1.5), away from the anchor 0.5.
    expect(cal?.b_calib).not.toBeNull();
    expect(cal?.b_calib as number).toBeGreaterThan(0.5);
    expect(cal?.b_calib as number).toBeCloseTo(1.5, 4);
  });

  it('FINDING #1 — NON-uniform π, all labels agree b=1.5 → b_calib == 1.5 EXACTLY (Hájek self-normalization)', async () => {
    // The bias the old round(Σ1/π) denominator hid: with mixed π, Σ1/π is non-integer, so
    // dividing the IPW correction by round(Σ1/π) (or a materialized Array(N).fill pool) makes
    // the ratio ≠ 1 even when every label says the same true difficulty. The Hájek self-
    // normalized estimator divides by the EXACT Σ(1/π) → the ratio is exactly 1 → b_calib
    // recovers the labels' value EXACTLY, independent of the π distribution.
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5); // b_anchor = 0.5 (under-estimates true 1.5)
    // 12 distinct NON-uniform π values (Σ1/π is non-integer → would trip the old bug).
    const pis = [0.12, 0.34, 0.55, 0.2, 0.8, 0.45, 0.6, 0.15, 0.9, 0.33, 0.5, 0.7];
    expect(pis).toHaveLength(RECALIBRATION_MIN_LABELS); // exactly the threshold
    for (const pi of pis) {
      await db.insert(difficulty_calibration_label).values({
        id: newId(),
        question_id: q,
        attempt_event_id: createId(),
        theta_snapshot: 0,
        outcome: 0,
        b_label: 1.5, // all labels agree the true difficulty is 1.5
        inclusion_probability: pi,
        created_at: now(),
      });
    }
    // Sanity: Σ1/π is genuinely non-integer (so round() would have introduced bias).
    const sumInv = pis.reduce((a, p) => a + 1 / p, 0);
    expect(Math.abs(sumInv - Math.round(sumInv))).toBeGreaterThan(0.1);

    const result = await recalibrateQuestion(db, q);
    expect(result.updated).toBe(true);

    const cal = await readCalibration(q);
    // EXACT recovery (within float eps) — NOT 1.513… that the old round-denominator produced.
    expect(cal?.b_calib as number).toBeCloseTo(1.5, 10);
  });

  it('after firm-up, effectiveB(row) uses b_calib over b_anchor', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    await seedLabels(q, Array(RECALIBRATION_MIN_LABELS).fill(1.5), 0.5);
    await recalibrateQuestion(db, q);

    const cal = await readCalibration(q);
    expect(effectiveB(cal)).toBeCloseTo(cal?.b_calib as number, 6);
    expect(effectiveB(cal)).not.toBeCloseTo(0.5, 2); // not the anchor anymore
  });

  it('FINDING low-1 — single-question constant-anchor mode → λ* == 1 (bad-anchor safety valve inert until Phase 7+)', async () => {
    // In single-question mode the pool predictions are all b_anchor (constant) → Var(m̂)=0 →
    // estimateLambdaStar returns 1. This is NOT a bug: the PPI++ closed form is correct; the
    // auto-degrade valve simply cannot engage with a constant m̂. It activates only once
    // Phase 7+ introduces a NON-constant pool prediction (family/library regression anchor).
    // This assertion exists so a future reader does not assume the valve is live here.
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.5);
    // Labels deliberately VARY a lot (and π non-uniform) — a non-constant m̂ would push λ*<1
    // if the valve were live, but a constant anchor m̂ keeps λ*==1 regardless of label spread.
    await seedLabels(q, [0.2, 2.4, 0.5, 2.1, 0.1, 2.6, 0.3, 2.2, 0.4, 2.5, 0.6, 2.3], 0.5);

    const result = await recalibrateQuestion(db, q);
    expect(result.updated).toBe(true);
    expect(result.lambdaStar).toBe(1); // constant-anchor → Var(m̂)=0 → λ*=1.
  });

  it('no anchor (no item_calibration row) → no_anchor no-op even with labels', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedLabels(q, Array(RECALIBRATION_MIN_LABELS).fill(1.5));

    const result = await recalibrateQuestion(db, q);
    expect(result.updated).toBe(false);
    expect(result.reason).toBe('no_anchor');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (C) effectiveB read-compat end-to-end (column-level)
// ─────────────────────────────────────────────────────────────────────────────
describe('effectiveB read-compat (column-level, end-to-end)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('b_calib NULL → effectiveB falls to b_anchor (NO-OP today)', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.7); // b=0.7, b_anchor=0.7, b_calib=NULL
    const cal = await readCalibration(q);
    expect(cal?.b_calib).toBeNull();
    expect(effectiveB(cal)).toBeCloseTo(0.7, 6);
  });

  it('b_calib set → effectiveB uses b_calib', async () => {
    const q = createId();
    await seedQuestion(q, 3);
    await seedItemCalibration(q, 0.7);
    await db
      .update(item_calibration)
      .set({ b_calib: -0.4 })
      .where(eq(item_calibration.question_id, q));
    const cal = await readCalibration(q);
    expect(effectiveB(cal)).toBeCloseTo(-0.4, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (D) resetDb truncates difficulty_calibration_label (Codex P2 — hermetic contract)
//
// The table has NO enforced FK, so CASCADE never reaches it from another table's
// TRUNCATE — it must be in ALL_TABLES (tests/helpers/db.ts) explicitly, or rows leak
// across tests (currently masked only because tests use unique question ids).
// ─────────────────────────────────────────────────────────────────────────────
describe('resetDb truncates difficulty_calibration_label (ALL_TABLES, Codex P2)', () => {
  it('a label written before resetDb is gone after resetDb', async () => {
    const q = createId();
    await db.insert(difficulty_calibration_label).values({
      id: newId(),
      question_id: q,
      attempt_event_id: createId(),
      theta_snapshot: 0,
      outcome: 0,
      b_label: 1.0,
      inclusion_probability: 0.5,
      created_at: now(),
    });
    const before = await db.select().from(difficulty_calibration_label);
    expect(before.length).toBeGreaterThan(0);

    await resetDb();

    const after = await db.select().from(difficulty_calibration_label);
    expect(after).toHaveLength(0);
  });
});
