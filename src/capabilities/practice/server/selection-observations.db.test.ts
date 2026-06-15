// YUK-361 Phase 1（观测先行）— selection_observation writer DB 测试。
// 断言来自 roadmap §Task5 Step3：拒 prob 0 / 持久化 selected 题带 signals JSON /
// 按 date+ref_id 查得到。

import {
  getSelectionObservations,
  recordSelectionObservation,
} from '@/capabilities/practice/server/selection-observations';
import { selection_observation } from '@/db/schema';
import { ApiError } from '@/server/http/errors';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

const db = testDb();

beforeEach(() => resetDb());

describe('recordSelectionObservation', () => {
  it('rejects inclusion_probability = 0（合法概率护栏，慢热资产不可污染）', async () => {
    await expect(
      recordSelectionObservation(db, {
        date: '2026-06-16',
        refKind: 'question',
        refId: 'q-zero',
        policy: 'legacy',
        selected: true,
        inclusionProbability: 0,
        signals: {},
      }),
    ).rejects.toBeInstanceOf(ApiError);

    // 拒后无行落库。
    const rows = await db
      .select()
      .from(selection_observation)
      .where(eq(selection_observation.ref_id, 'q-zero'));
    expect(rows).toHaveLength(0);
  });

  it('rejects inclusion_probability > 1', async () => {
    await expect(
      recordSelectionObservation(db, {
        date: '2026-06-16',
        refKind: 'question',
        refId: 'q-over',
        policy: 'legacy',
        selected: true,
        inclusionProbability: 1.5,
        signals: {},
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('rejects negative inclusion_probability', async () => {
    await expect(
      recordSelectionObservation(db, {
        date: '2026-06-16',
        refKind: 'paper',
        refId: 'p-neg',
        policy: 'legacy',
        selected: false,
        inclusionProbability: -0.1,
        signals: {},
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('persists a selected question with signals JSON', async () => {
    const signals = {
      role: 'diagnostic',
      thetaHat: 0.5,
      thetaPrecision: 4,
      b: 0.2,
      mfiScore: 0.24,
    };
    const id = await recordSelectionObservation(db, {
      date: '2026-06-16',
      streamItemId: 'si-1',
      refKind: 'question',
      refId: 'q-selected',
      policy: 'legacy',
      selected: true,
      inclusionProbability: 0.42,
      signals,
    });
    expect(id).toBeTruthy();

    const rows = await db
      .select()
      .from(selection_observation)
      .where(eq(selection_observation.id, id));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.date).toBe('2026-06-16');
    expect(row.stream_item_id).toBe('si-1');
    expect(row.ref_kind).toBe('question');
    expect(row.ref_id).toBe('q-selected');
    expect(row.policy).toBe('legacy');
    expect(row.selected).toBe(true);
    expect(row.inclusion_probability).toBeCloseTo(0.42, 5);
    expect(row.signals).toEqual(signals);
    expect(row.created_at).toBeInstanceOf(Date);
  });

  it('accepts inclusion_probability = 1 (upper bound inclusive)', async () => {
    const id = await recordSelectionObservation(db, {
      date: '2026-06-16',
      refKind: 'question',
      refId: 'q-due',
      policy: 'legacy',
      selected: true,
      inclusionProbability: 1,
      signals: { role: 'due' },
    });
    const rows = await db
      .select()
      .from(selection_observation)
      .where(eq(selection_observation.id, id));
    expect(rows[0].inclusion_probability).toBe(1);
  });

  it('stream_item_id defaults to null when omitted (候选层观测)', async () => {
    const id = await recordSelectionObservation(db, {
      date: '2026-06-16',
      refKind: 'question',
      refId: 'q-no-stream',
      policy: 'legacy',
      selected: false,
      inclusionProbability: 0.1,
      signals: {},
    });
    const rows = await db
      .select()
      .from(selection_observation)
      .where(eq(selection_observation.id, id));
    expect(rows[0].stream_item_id).toBeNull();
    expect(rows[0].selected).toBe(false);
  });
});

describe('getSelectionObservations', () => {
  it('can query by date and ref_id', async () => {
    await recordSelectionObservation(db, {
      date: '2026-06-16',
      refKind: 'question',
      refId: 'q-a',
      policy: 'legacy',
      selected: true,
      inclusionProbability: 0.3,
      signals: { mfiScore: 0.2 },
    });
    // 不同 date 同 ref — 不应被同 ref 查询误捞。
    await recordSelectionObservation(db, {
      date: '2026-06-15',
      refKind: 'question',
      refId: 'q-a',
      policy: 'legacy',
      selected: true,
      inclusionProbability: 0.3,
      signals: {},
    });
    // 同 date 不同 ref — 不应被同 date+ref 查询误捞。
    await recordSelectionObservation(db, {
      date: '2026-06-16',
      refKind: 'question',
      refId: 'q-b',
      policy: 'legacy',
      selected: false,
      inclusionProbability: 0.1,
      signals: {},
    });

    const got = await getSelectionObservations(db, '2026-06-16', 'q-a');
    expect(got).toHaveLength(1);
    expect(got[0].ref_id).toBe('q-a');
    expect(got[0].date).toBe('2026-06-16');
    expect(got[0].signals).toEqual({ mfiScore: 0.2 });
  });
});
