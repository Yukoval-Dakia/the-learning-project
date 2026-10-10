// M2 (YUK-316) — 流 API 行为：lazy compose（仅今日）、状态机推进、双日隔离、
// recompose 保留非 pending 项。composer 混排规则本体在 stream-composer.unit.test.ts。

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { streamLocalDate } from '@/capabilities/practice/server/stream-store';
import { knowledge, learning_session, question } from '@/db/schema';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import { resetDb, testDb } from '../../../../tests/helpers/db';

// G1 (review)：route 永不传 composeDeps，production lazy-compose 走 defaultRunTaskFn →
//   动态 import('@/server/ai/runner') runTask。mock 该模块证明**真实路由**能命中 LLM 软
//   选题路径（且绝不命中 live endpoint）。只有 samplable 非到期候选在场时才会触发——
//   其余 due-only 测试 samplable=0，runTask 不被调，mock 无副作用。
const runTaskMock = vi.fn(async (_kind: string, _input: unknown, _ctx: unknown) => ({
  text: '',
}));
vi.mock('@/server/ai/runner', () => ({
  runTask: (...args: unknown[]) =>
    (runTaskMock as unknown as (...a: unknown[]) => unknown)(...args),
}));

import { GET, PATCH } from './stream';
import { PracticeStreamResponseSchema } from './stream-contracts';

const TODAY = streamLocalDate();

async function seedScopedQuestion(input: {
  knowledgeId: string;
  knowledgeName?: string;
  draftStatus?: string | null;
}): Promise<string> {
  const now = new Date();
  await testDb()
    .insert(knowledge)
    .values({
      id: input.knowledgeId,
      name: input.knowledgeName ?? input.knowledgeId,
      domain: 'yuwen',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
  const qid = createId();
  await testDb()
    .insert(question)
    .values({
      id: qid,
      kind: 'choice',
      prompt_md: '专项题',
      reference_md: 'B',
      knowledge_ids: [input.knowledgeId],
      difficulty: 3,
      source: 'manual',
      draft_status: input.draftStatus ?? null,
      variant_depth: 0,
      figures: [],
      image_refs: [],
      structured: null,
      metadata: {},
      created_at: now,
      updated_at: now,
      version: 0,
    });
  return qid;
}

describe('practice stream API', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRateLimitForTests();
    runTaskMock.mockClear();
  });

  afterEach(() => vi.unstubAllEnvs());

  it('YUK-535: concurrent scoped opens share one session and concurrent last answers close it once', async () => {
    const kc = createId();
    await seedScopedQuestion({ knowledgeId: kc, knowledgeName: '并发专项' });
    await seedScopedQuestion({ knowledgeId: kc, knowledgeName: '并发专项' });
    const requestUrl = `http://t/api/practice/stream?date=today&kc=${encodeURIComponent(kc)}`;

    const opened = await Promise.all([GET(new Request(requestUrl)), GET(new Request(requestUrl))]);
    const streams = await Promise.all(
      opened.map(async (response) => PracticeStreamResponseSchema.parse(await response.json())),
    );
    expect(streams[0].scope?.session_id).toBe(streams[1].scope?.session_id);
    expect(streams[0].items.map((item) => item.id)).toEqual(
      streams[1].items.map((item) => item.id),
    );
    expect(streams[0].items).toHaveLength(2);
    const scopedSessions = (await testDb().select().from(learning_session)).filter(
      (session) =>
        session.type === 'review' &&
        session.scope_knowledge_ids?.length === 1 &&
        session.scope_knowledge_ids[0] === kc,
    );
    expect(scopedSessions).toHaveLength(1);

    const completionResponses = await Promise.all(
      streams[0].items.map((item) =>
        PATCH(
          new Request(`http://t/api/practice/stream/items/${item.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'done' }),
          }),
          { id: item.id },
        ),
      ),
    );
    expect(completionResponses.map((response) => response.status)).toEqual([200, 200]);
    const sessionId = streams[0].scope?.session_id as string;
    const [session] = await testDb()
      .select({ status: learning_session.status })
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(session?.status).toBe('completed');
  });
});
