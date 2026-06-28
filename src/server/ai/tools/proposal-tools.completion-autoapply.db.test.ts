// YUK-521 (A4 强度轴 / ADR-0039 A 档 strength tier) — completion 的 A 档 auto-apply
// 端到端 DB 测：命中（cold-start）/ 熔断 tripped 退回 B / apply 失败留 pending / 二次
// 幂等。纯 off-by-one 熔断数学在 ../../proposals/decide-breaker.unit.test.ts；这里走
// 真 acceptAiProposal 物化 + 真 event log + 真 learning_item 行。

import { event, knowledge, learning_item } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import * as actionsModule from '@/server/proposals/actions';
import { VERDICT_AUTOAPPLY_MAX } from '@/server/proposals/decide-breaker';
import { getProposalInboxRow } from '@/server/proposals/inbox';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { proposeLearningItemCompletionTool } from './proposal-tools';
import type { ToolContext } from './types';

// Module-load mocks (mirror proposal-tools.test.ts / fixtures.test.ts): proposal-tools
// transitively pulls the runner + Agent SDK. The completion tool's execute path uses
// neither, but the imports must resolve to harmless stubs.
const mockRunner = vi.hoisted(() => ({ runTask: vi.fn() }));
vi.mock('@/server/ai/runner', () => ({ runTask: mockRunner.runTask }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((opts: unknown) => ({ type: 'sdk', instance: opts })),
  tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => ({
    name,
    handler,
  })),
}));

const BASE = new Date('2026-05-28T00:00:00.000Z');

function ctx(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_a4',
    callerActor: { kind: 'agent', ref: 'agent:maintenance' },
  };
}

async function seedItem(id: string, status: string): Promise<void> {
  const db = testDb();
  await db.insert(knowledge).values({
    id: 'k_zhi',
    name: '之',
    domain: 'wenyan',
    created_at: BASE,
    updated_at: BASE,
  });
  await db.insert(learning_item).values({
    id,
    source: 'manual',
    title: id,
    content: 'content',
    knowledge_ids: ['k_zhi'],
    status,
    created_at: BASE,
    updated_at: BASE,
  });
}

// Seed N `rate` verdict events inside the breaker window (real now). The breaker
// counts event.action='rate' with created_at >= now - 1h.
async function seedRecentRateEvents(n: number): Promise<void> {
  const db = testDb();
  const now = Date.now();
  for (let i = 0; i < n; i += 1) {
    await writeEvent(db, {
      id: `seed_rate_${i}`,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: `seed_proposal_${i}`,
      outcome: 'success',
      payload: { rating: 'accept' },
      created_at: new Date(now - i * 1000),
    });
  }
}

async function autoApplyEvents(itemId: string, action: string) {
  return testDb()
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(and(eq(event.action, action), eq(event.subject_id, itemId)));
}

describe('completion A-tier auto-apply (YUK-521)', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cold-start (breaker ok): auto-applies, completes the item, writes the autoapply anchor', async () => {
    const db = testDb();
    await seedItem('li_a', 'in_progress');

    const out = await proposeLearningItemCompletionTool.execute(ctx(), {
      learning_item_id: 'li_a',
      triggering_signals: ['check_all_passed'],
      reasoning: 'cold start',
    });

    expect(out.status).toBe('proposed');
    expect(out.auto_applied).toBe(true);
    const proposalId = out.proposal_id as string;

    // item materialized to done.
    const item = (
      await db
        .select({ status: learning_item.status })
        .from(learning_item)
        .where(eq(learning_item.id, 'li_a'))
    )[0];
    expect(item.status).toBe('done');

    // the proposal is no longer pending (it was accepted).
    const proposal = await getProposalInboxRow(db, proposalId);
    expect(proposal?.status).not.toBe('pending');

    // the A-tier read-model anchor exists, carrying the proposal id + breaker snapshot.
    const anchors = await autoApplyEvents('li_a', 'experimental:completion_autoapply');
    expect(anchors).toHaveLength(1);
    const payload = anchors[0]?.payload as { proposal_id?: string; level?: string };
    expect(payload?.proposal_id).toBe(proposalId);
    expect(payload?.level).toBe('ok');

    // per-proposal idempotency: re-accepting the SAME proposal is a no-op.
    const replay = await actionsModule.acceptAiProposal(db, proposalId);
    expect((replay as { idempotent?: boolean }).idempotent).toBe(true);
    const itemAfter = (
      await db
        .select({ status: learning_item.status })
        .from(learning_item)
        .where(eq(learning_item.id, 'li_a'))
    )[0];
    expect(itemAfter.status).toBe('done');
  });

  it('breaker tripped: falls back to B-tier (item stays in_progress, proposal pending), records skip', async () => {
    const db = testDb();
    await seedItem('li_b', 'in_progress');
    await seedRecentRateEvents(VERDICT_AUTOAPPLY_MAX);

    const out = await proposeLearningItemCompletionTool.execute(ctx(), {
      learning_item_id: 'li_b',
      triggering_signals: ['check_all_passed'],
      reasoning: 'storm',
    });

    expect(out.status).toBe('proposed');
    expect(out.auto_applied).toBe(false);
    const proposalId = out.proposal_id as string;

    // item untouched — auto-apply was diverted.
    const item = (
      await db
        .select({ status: learning_item.status })
        .from(learning_item)
        .where(eq(learning_item.id, 'li_b'))
    )[0];
    expect(item.status).toBe('in_progress');

    // proposal stays pending (B-tier: a human accepts it in the inbox).
    const proposal = await getProposalInboxRow(db, proposalId);
    expect(proposal?.status).toBe('pending');

    // skip is observable with the breaker reason.
    const skips = await autoApplyEvents('li_b', 'experimental:completion_autoapply_skipped');
    expect(skips).toHaveLength(1);
    expect((skips[0]?.payload as { reason?: string }).reason).toBe('breaker_tripped');

    // cooldown dedup still works because the proposal is pending.
    const dup = await proposeLearningItemCompletionTool.execute(ctx(), {
      learning_item_id: 'li_b',
      triggering_signals: ['check_all_passed'],
      reasoning: 'again',
    });
    expect(dup.status).toBe('skipped:duplicate_pending');
  });

  it('apply error: surfaces a skip, leaves the proposal pending, never throws out of the tool', async () => {
    const db = testDb();
    await seedItem('li_c', 'in_progress');
    const spy = vi
      .spyOn(actionsModule, 'acceptAiProposal')
      .mockRejectedValueOnce(new Error('materialization boom'));

    const out = await proposeLearningItemCompletionTool.execute(ctx(), {
      learning_item_id: 'li_c',
      triggering_signals: ['check_all_passed'],
      reasoning: 'apply fails',
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(out.status).toBe('proposed');
    expect(out.auto_applied).toBe(false);
    const proposalId = out.proposal_id as string;

    // item untouched, proposal pending (the apply threw before writing the rate event).
    const item = (
      await db
        .select({ status: learning_item.status })
        .from(learning_item)
        .where(eq(learning_item.id, 'li_c'))
    )[0];
    expect(item.status).toBe('in_progress');
    const proposal = await getProposalInboxRow(db, proposalId);
    expect(proposal?.status).toBe('pending');

    // skip event records the apply_error reason.
    const skips = await autoApplyEvents('li_c', 'experimental:completion_autoapply_skipped');
    expect(skips).toHaveLength(1);
    expect((skips[0]?.payload as { reason?: string }).reason).toBe('apply_error');
  });
});
