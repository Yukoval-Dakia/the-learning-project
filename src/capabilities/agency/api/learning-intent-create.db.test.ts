import { event } from '@/db/schema';
import { getProposalInboxRow } from '@/server/proposals/inbox';
import { writeLearningItemProposal } from '@/server/proposals/producers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { buildCreateLearningIntentHandler } from './learning-intent-create';

const db = testDb();

beforeEach(() => resetDb());

function request(body: unknown): Request {
  return new Request('http://localhost/api/learning-intents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/learning-intents', () => {
  it('creates a reviewable 3a proposal on an empty knowledge tree', async () => {
    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        knowledge: {
          root: { temp_id: 'root_probability', name: '概率论', domain: 'math' },
          children: [
            { temp_id: 'probability_basics', name: '概率基础', domain: 'math' },
            { temp_id: 'random_variables', name: '随机变量', domain: 'math' },
          ],
        },
        hub: { title: '概率论主线', summary_md: '从概率基础走到随机变量。' },
        atomics: [
          {
            knowledge_id: 'probability_basics',
            title: '概率基础',
            one_line_intent: '掌握事件与条件概率。',
          },
          {
            knowledge_id: 'random_variables',
            title: '随机变量',
            one_line_intent: '理解分布与期望。',
          },
        ],
        longs: [],
      }),
      task_run_id: 'run_learning_intent_1',
      cost_usd: 0.00125,
    }));
    const handler = buildCreateLearningIntentHandler({ database: db, runTaskFn });

    const response = await handler(request({ topic: '  概率论  ' }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      topic: '概率论',
      plan_case: '3a_topic_missing',
      hub: { title: '概率论主线' },
    });
    expect(body.atomics).toHaveLength(2);

    const proposal = await getProposalInboxRow(db, body.proposal_id);
    expect(proposal).toMatchObject({
      kind: 'learning_item',
      status: 'pending',
      actor_ref: 'learning_intent',
      task_run_id: 'run_learning_intent_1',
      cost_micro_usd: 1250,
    });
    expect(proposal?.payload.proposed_change).toMatchObject({
      topic: '概率论',
      hub: { title: '概率论主线' },
    });

    const [raw] = await db.select().from(event).where(eq(event.id, body.proposal_id));
    expect(raw.action).toBe('experimental:propose_learning_intent');

    const replay = await handler(request({ topic: '概率论' }));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ proposal_id: body.proposal_id });
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect(await db.select().from(event)).toHaveLength(1);
  });

  it('rejects empty and malformed bodies without writing a proposal', async () => {
    const runTaskFn = vi.fn();
    const handler = buildCreateLearningIntentHandler({ database: db, runTaskFn });

    const empty = await handler(request({ topic: '   ' }));
    expect(empty.status).toBe(400);

    const malformed = await handler(
      new Request('http://localhost/api/learning-intents', {
        method: 'POST',
        body: '{not-json',
      }),
    );
    expect(malformed.status).toBe(400);
    expect(runTaskFn).not.toHaveBeenCalled();
    expect(await db.select().from(event)).toHaveLength(0);
  });

  it('maps LLM-quality failures to 502, not a server 500', async () => {
    // Unparseable outline → planLearningIntent throws llm_parse_failed, an upstream
    // AI-quality fault rather than a server bug (YUK-681 P3-2).
    const runTaskFn = vi.fn(async () => ({
      text: 'not a JSON outline at all',
      task_run_id: 'run_bad_outline',
      cost_usd: 0.0009,
    }));
    const handler = buildCreateLearningIntentHandler({ database: db, runTaskFn });

    const res = await handler(request({ topic: '线性代数' }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'llm_parse_failed' });
    expect(await db.select().from(event)).toHaveLength(0);
  });

  it('reuses a valid same-topic proposal even when a malformed one ranks first (YUK-681 P3-1)', async () => {
    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        knowledge: {
          root: { temp_id: 'root_comb', name: '组合数学', domain: 'math' },
          children: [{ temp_id: 'counting', name: '计数原理', domain: 'math' }],
        },
        hub: { title: '组合数学主线', summary_md: '从计数原理入门。' },
        atomics: [
          { knowledge_id: 'counting', title: '计数原理', one_line_intent: '掌握加法乘法原理。' },
        ],
        longs: [],
      }),
      task_run_id: 'run_comb_1',
      cost_usd: 0.001,
    }));
    const handler = buildCreateLearningIntentHandler({ database: db, runTaskFn });

    // 1st: no same-topic proposal exists → one fresh paid run produces a valid one.
    const first = await handler(request({ topic: '组合数学' }));
    expect(first.status).toBe(200);
    expect(runTaskFn).toHaveBeenCalledTimes(1);

    // Now plant a malformed same-topic pending row (empty atomics fails the public response
    // contract) with a NEWER created_at, so the inbox's `desc(created_at)` ranking places it
    // FIRST — ahead of the valid one. The old `.find` stopped at this first (malformed) row,
    // failed safeParse, and did another paid run; the new loop skips it and restores the valid.
    await writeLearningItemProposal(db, {
      topic: '组合数学',
      reason_md: 'malformed legacy row',
      evidence_refs: [],
      knowledge_node: { kind: 'absent' },
      hub: { title: '组合数学', summary_md: '占位' },
      atomics: [],
      cost_usd: 0,
      created_at: new Date(Date.now() + 60_000),
    });

    // 2nd: malformed ranks first, but the valid same-topic proposal is still restored
    // WITHOUT another paid run (runTaskFn stays at 1; old code would reach 2).
    const second = await handler(request({ topic: '组合数学' }));
    expect(second.status).toBe(200);
    expect(runTaskFn).toHaveBeenCalledTimes(1);
  });
});
