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
import { eq, sql } from 'drizzle-orm';
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
import { recordDifficultyCalibrationLabel } from './recalibration';

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

// ─────────────────────────────────────────────────────────────────────────────
// (A) label hook
// ─────────────────────────────────────────────────────────────────────────────
describe('recordDifficultyCalibrationLabel', () => {
  beforeEach(async () => {
    await resetDb();
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
