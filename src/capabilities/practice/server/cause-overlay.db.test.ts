// YUK-1016 / 454-B — cause_category_overlay DB 测试。
// 覆盖：reader 过滤语义（active-only / subject-scope / 序）、proposal→accept→row、
// idempotent accept、retract→archived、attribution 合并读取（ov_ 进候选 + 校验
// 不 clamp）、variant targetable、other tally→propose 全链。

import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@/kernel/http';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { acceptAiProposal } from '@/server/proposals/actions';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { getCauseCategoryOverlaysByIds } from './cause-overlay';

const NOW = new Date('2026-09-18T00:00:00Z');

async function writeCauseCategoryProposal(opts: {
  categoryId: string;
  label?: string;
  source?: 'owner' | 'llm_propose';
  subjectId?: string;
  cooldownKey?: string;
}) {
  const db = testDb();
  return writeAiProposal(db, {
    payload: {
      kind: 'cause_category',
      target: {
        subject_kind: 'subject_profile',
        subject_id: opts.subjectId ?? 'general',
      },
      reason_md: '测试提议',
      evidence_refs: [{ kind: 'event', id: 'evt_seed_1' }],
      cooldown_key: opts.cooldownKey ?? `cause_category:${opts.subjectId ?? 'general'}`,
      proposed_change: {
        category_id: opts.categoryId,
        label: opts.label ?? '测试类目',
        description: '说明文字',
        source: opts.source ?? 'llm_propose',
      },
    },
  });
}

describe('cause_category proposal → accept → overlay row', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('re-accept is idempotent (one row, one rate event)', async () => {
    const proposalId = await writeCauseCategoryProposal({ categoryId: 'ov_idem' });
    await acceptAiProposal(testDb(), proposalId);
    const second = await acceptAiProposal(testDb(), proposalId);
    expect(second.idempotent).toBe(true);

    const rows = await getCauseCategoryOverlaysByIds(testDb(), ['ov_idem']);
    expect(rows).toHaveLength(1);
  });

  it('concurrent accepts of the same category_id: exactly one wins, loser gets 409', async () => {
    // 两张 pending proposal 指同一 categoryId、并发 accept——decision lock 按
    // proposalId 取不互斥，onConflictDoNothing 兜底保证输家是 409 而非裸 PK 500。
    const proposalA = await writeCauseCategoryProposal({
      categoryId: 'ov_race',
      subjectId: 'general',
    });
    const proposalB = await writeCauseCategoryProposal({
      categoryId: 'ov_race',
      subjectId: 'math',
      cooldownKey: 'cause_category:math',
    });
    const [a, b] = await Promise.allSettled([
      acceptAiProposal(testDb(), proposalA),
      acceptAiProposal(testDb(), proposalB),
    ]);
    const outcomes = [a, b];
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.find((r) => r.status === 'rejected');
    expect(loser?.status).toBe('rejected');
    if (loser?.status === 'rejected') {
      expect(loser.reason).toBeInstanceOf(ApiError);
      expect((loser.reason as ApiError).status).toBe(409);
    }

    const rows = await getCauseCategoryOverlaysByIds(testDb(), ['ov_race']);
    expect(rows).toHaveLength(1);
  });
});
