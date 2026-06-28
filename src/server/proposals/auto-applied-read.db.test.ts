// YUK-521 (A4 强度轴) — A 档 auto-applied 读模型 DB 测：autoapply 锚 → 行投影
// （title join / level / applied_at）+ reverted join（correct retract 痕）+ 列表窗口过滤
// + 当前熔断快照透传。

import { learning_item } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { AUTO_APPLIED_LIST_WINDOW_MS, getAutoAppliedDigest } from './auto-applied-read';
import { VERDICT_AUTOAPPLY_MAX } from './decide-breaker';

const BASE = new Date('2026-05-28T00:00:00.000Z');

async function seedItem(id: string, title: string): Promise<void> {
  await testDb().insert(learning_item).values({
    id,
    source: 'manual',
    title,
    content: 'content',
    knowledge_ids: [],
    status: 'done',
    created_at: BASE,
    updated_at: BASE,
  });
}

async function seedAutoApply(
  proposalId: string,
  itemId: string,
  createdAt: Date,
  level = 'ok',
): Promise<void> {
  await writeEvent(testDb(), {
    id: `aa_${proposalId}`,
    actor_kind: 'agent',
    actor_ref: 'completion_autoapply',
    action: 'experimental:completion_autoapply',
    subject_kind: 'learning_item',
    subject_id: itemId,
    outcome: 'success',
    payload: { proposal_id: proposalId, learning_item_id: itemId, level, applied: 1, cap: 30 },
    created_at: createdAt,
  });
}

async function seedRetract(proposalId: string, createdAt: Date): Promise<void> {
  await writeEvent(testDb(), {
    id: `correct_${proposalId}`,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'correct',
    subject_kind: 'event',
    subject_id: proposalId,
    outcome: 'success',
    payload: {
      correction_kind: 'retract',
      reason_md: 'undone from inbox',
      affected_refs: [{ kind: 'open_inquiry', id: proposalId }],
    },
    created_at: createdAt,
  });
}

describe('getAutoAppliedDigest (YUK-521)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('projects autoapply anchors → rows with title/level, newest first', async () => {
    const now = new Date(BASE.getTime() + AUTO_APPLIED_LIST_WINDOW_MS);
    await seedItem('li_1', '主谓取独');
    await seedItem('li_2', '宾语前置');
    await seedAutoApply('prop_1', 'li_1', new Date(now.getTime() - 60_000), 'ok');
    await seedAutoApply('prop_2', 'li_2', new Date(now.getTime() - 30_000), 'warned');

    const digest = await getAutoAppliedDigest(testDb(), { now });
    expect(digest.rows.map((r) => r.proposal_id)).toEqual(['prop_2', 'prop_1']); // desc by created_at
    const r1 = digest.rows.find((r) => r.proposal_id === 'prop_1');
    expect(r1?.title).toBe('主谓取独');
    expect(r1?.learning_item_id).toBe('li_1');
    expect(r1?.level).toBe('ok');
    expect(r1?.reverted).toBe(false);
    expect(digest.rows.find((r) => r.proposal_id === 'prop_2')?.level).toBe('warned');
  });

  it('marks reverted when a matching correct(retract) event exists', async () => {
    const now = new Date(BASE.getTime() + AUTO_APPLIED_LIST_WINDOW_MS);
    await seedItem('li_r', '已撤销项');
    await seedAutoApply('prop_r', 'li_r', new Date(now.getTime() - 120_000));
    await seedRetract('prop_r', new Date(now.getTime() - 60_000));

    const digest = await getAutoAppliedDigest(testDb(), { now });
    const row = digest.rows.find((r) => r.proposal_id === 'prop_r');
    expect(row?.reverted).toBe(true);
  });

  it('excludes autoapply anchors older than the list window', async () => {
    const now = new Date(BASE.getTime() + 10 * AUTO_APPLIED_LIST_WINDOW_MS);
    await seedItem('li_old', '远古项');
    // applied well before the window start.
    await seedAutoApply(
      'prop_old',
      'li_old',
      new Date(now.getTime() - AUTO_APPLIED_LIST_WINDOW_MS - 60_000),
    );

    const digest = await getAutoAppliedDigest(testDb(), { now });
    expect(digest.rows.find((r) => r.proposal_id === 'prop_old')).toBeUndefined();
  });

  it('surfaces the current breaker snapshot (tripped when rate events flood the window)', async () => {
    const now = new Date();
    for (let i = 0; i < VERDICT_AUTOAPPLY_MAX; i += 1) {
      await writeEvent(testDb(), {
        id: `rate_${i}`,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'rate',
        subject_kind: 'event',
        subject_id: `p_${i}`,
        outcome: 'success',
        payload: { rating: 'accept' },
        created_at: new Date(now.getTime() - i * 1000),
      });
    }
    const digest = await getAutoAppliedDigest(testDb(), { now });
    expect(digest.breaker.tripped).toBe(true);
    expect(digest.breaker.cap).toBe(VERDICT_AUTOAPPLY_MAX);
    expect(digest.breaker.applied).toBeGreaterThanOrEqual(VERDICT_AUTOAPPLY_MAX);
  });
});
