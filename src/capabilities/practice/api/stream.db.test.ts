// M2 (YUK-316) — 流 API 行为：lazy compose（仅今日）、状态机推进、双日隔离、
// recompose 保留非 pending 项。composer 混排规则本体在 stream-composer.unit.test.ts。

import { streamLocalDate } from '@/capabilities/practice/server/stream-store';
import {
  event,
  item_calibration,
  knowledge,
  learning_session,
  mastery_state,
  material_fsrs_state,
  mistake_variant,
  practice_stream_item,
  question,
  selection_observation,
} from '@/db/schema';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import { createId } from '@paralleldrive/cuid2';
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { GET, PATCH, POST } from './stream';
import {
  PracticeStreamItemUpdatedResponseSchema,
  PracticeStreamRecomposedResponseSchema,
  PracticeStreamResponseSchema,
} from './stream-contracts';

const TODAY = streamLocalDate();

async function seedDueQuestion(): Promise<string> {
  const qid = createId();
  const now = new Date();
  await testDb().insert(question).values({
    id: qid,
    kind: 'choice',
    prompt_md: '下列「之」用作取独的是？',
    reference_md: 'B',
    knowledge_ids: [],
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    figures: [],
    image_refs: [],
    structured: null,
    metadata: {},
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await markQuestionDue(qid);
  return qid;
}

async function markQuestionDue(qid: string): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(material_fsrs_state)
    .values({
      id: createId(),
      subject_kind: 'question',
      subject_id: qid,
      state: {
        due: now,
        stability: 1,
        difficulty: 5,
        scheduled_days: 1,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        state: 'review' as const,
        last_review: now,
      },
      due_at: new Date(now.getTime() - 3600_000),
      last_review_event_id: null,
      updated_at: now,
    });
}

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

/**
 * 非到期变体候选（samplable）：parent 近期 failure + active mistake_variant 指向变体题，
 * 变体题挂 KC + mastery_state + item_calibration.b → candidate-signals 算得出 MFI。
 * @returns 变体题 id。
 */
async function seedVariantCandidate(): Promise<string> {
  const kc = createId();
  const now = new Date();
  const parentId = createId();
  const variantId = createId();
  for (const [id, kids] of [
    [parentId, []],
    [variantId, [kc]],
  ] as Array<[string, string[]]>) {
    await testDb().insert(question).values({
      id,
      kind: 'choice',
      prompt_md: '题干',
      reference_md: 'B',
      knowledge_ids: kids,
      difficulty: 3,
      source: 'manual',
      variant_depth: 0,
      figures: [],
      image_refs: [],
      structured: null,
      metadata: {},
      created_at: now,
      updated_at: now,
      version: 0,
    });
  }
  await testDb().insert(mistake_variant).values({
    id: createId(),
    parent_question_id: parentId,
    variant_question_id: variantId,
    status: 'active',
    failure_reasons: [],
    created_at: now,
    updated_at: now,
  });
  await testDb().insert(event).values({
    id: createId(),
    actor_kind: 'user',
    actor_ref: 'me',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: parentId,
    outcome: 'failure',
    payload: {},
    created_at: now,
  });
  // YUK-539: fail_count 2→3（evidence 5→6）以保「未掌握」语义 —— retune 后（γ=0.5/ρ=−0.25）
  // s=3/f=2 的 p(L)=σ(1.0)=0.731 会翻过 0.7，改 f=3 后 p(L)=σ(0.75)=0.679 仍 < 0.7。
  await testDb().insert(mastery_state).values({
    id: createId(),
    subject_kind: 'knowledge',
    subject_id: kc,
    theta_hat: 0,
    evidence_count: 6,
    success_count: 3,
    fail_count: 3,
    theta_precision: 4,
    updated_at: now,
  });
  await testDb().insert(item_calibration).values({
    id: createId(),
    question_id: variantId,
    b: 0,
    track: 'hard',
    source: 'llm_prior',
    created_at: now,
    updated_at: now,
  });
  return variantId;
}

function getReq(date?: string): Request {
  const qs = date ? `?date=${date}` : '';
  return new Request(`http://t/api/practice/stream${qs}`);
}

describe('practice stream API', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRateLimitForTests();
    runTaskMock.mockClear();
  });

  afterEach(() => vi.unstubAllEnvs());

  it('GET today lazy-composes from due signal and persists the stream', async () => {
    const qid = await seedDueQuestion();
    const res = await GET(getReq('today'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      date: string;
      items: Array<{
        ref_id: string;
        source: string;
        status: string;
        position: number;
        estimated_minutes: number;
      }>;
      budget: { pace: string; minutes: number };
      progress: {
        done: number;
        total: number;
        estimated_total_minutes: number;
        estimated_remaining_minutes: number;
      };
      opening_line: string;
    };
    PracticeStreamResponseSchema.parse(body);
    expect(body.date).toBe(TODAY);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0].ref_id).toBe(qid);
    expect(body.items[0].source).toBe('decay');
    expect(body.items[0].status).toBe('pending');
    expect(body.budget).toEqual({ pace: 'medium', minutes: 20 });
    expect(body.items[0].estimated_minutes).toBe(2);
    expect(body.progress).toEqual({
      done: 0,
      total: body.items.length,
      estimated_total_minutes: 2,
      estimated_remaining_minutes: 2,
    });

    // 第二次 GET 读到的是同一份物化流（不重复 compose）。
    const res2 = await GET(getReq());
    const body2 = (await res2.json()) as { items: Array<{ ref_id: string }> };
    expect(body2.items.map((i) => i.ref_id)).toEqual(body.items.map((i) => i.ref_id));
  });

  it('零行为变更：composeDailyStream 不写 signals → 物化行 signals 默认 {}（YUK-361 Phase 1）', async () => {
    // 承重保证：本 lane 只加 signals 存储列，不接进选题；composer 不产 signals，
    // materializeStream `it.signals ?? {}` 必须让每行落 {}（非 null、非缺省漂移）。
    await seedDueQuestion();
    const res = await GET(getReq('today'));
    expect(res.status).toBe(200);
    const rows = await testDb()
      .select()
      .from(practice_stream_item)
      .where(eq(practice_stream_item.date, TODAY));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.signals).toEqual({});
    }
  });

  it('GET a past date never lazy-composes (历史日期不凭空生流)', async () => {
    await seedDueQuestion();
    const res = await GET(getReq('2020-01-01'));
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
    const rows = await testDb()
      .select()
      .from(practice_stream_item)
      .where(eq(practice_stream_item.date, '2020-01-01'));
    expect(rows).toHaveLength(0);
  });

  it('YUK-535: GET ?kc creates a recoverable scoped session without composing or leaking the daily stream', async () => {
    const kc = createId();
    const scopedQuestion = await seedScopedQuestion({
      knowledgeId: kc,
      knowledgeName: '判断句',
    });
    await seedScopedQuestion({ knowledgeId: kc, draftStatus: 'draft' });
    // The same question is also due in the daily stream; the two partitions must be able to
    // materialize independent rows/progress for one ref_id.
    await markQuestionDue(scopedQuestion);

    const scopedRes = await GET(
      new Request(`http://t/api/practice/stream?date=today&kc=${encodeURIComponent(kc)}`),
    );
    expect(scopedRes.status).toBe(200);
    const scoped = PracticeStreamResponseSchema.parse(await scopedRes.json());
    expect(scoped.scope).toMatchObject({
      kind: 'knowledge',
      id: kc,
      label: '判断句',
    });
    expect(scoped.scope?.session_id).toBeTruthy();
    expect(scoped.items.map((item) => item.ref_id)).toEqual([scopedQuestion]);
    expect(scoped.items[0]).toMatchObject({ source: 'on_demand', status: 'pending' });
    expect(scoped.opening_line).toContain('判断句');
    expect(runTaskMock).not.toHaveBeenCalled();

    const sessionRows = await testDb()
      .select({ scope: learning_session.scope_knowledge_ids })
      .from(learning_session)
      .where(eq(learning_session.id, scoped.scope?.session_id as string));
    expect(sessionRows).toEqual([{ scope: [kc] }]);
    const dailyBefore = await testDb()
      .select()
      .from(practice_stream_item)
      .where(and(eq(practice_stream_item.date, TODAY), isNull(practice_stream_item.session_id)));
    expect(dailyBefore).toEqual([]);

    // Completing the only scoped item closes the same review-session envelope.
    const completed = await PATCH(
      new Request('http://t/api/practice/stream/items/scoped', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'done' }),
      }),
      { id: scoped.items[0].id },
    );
    expect(completed.status).toBe(200);
    const [closedSession] = await testDb()
      .select({ status: learning_session.status })
      .from(learning_session)
      .where(eq(learning_session.id, scoped.scope?.session_id as string));
    expect(closedSession?.status).toBe('completed');

    // Reload resolves the same server-owned session and the same materialized item.
    const scopedAgain = PracticeStreamResponseSchema.parse(
      await (await GET(new Request(`http://t/api/practice/stream?date=today&kc=${kc}`))).json(),
    );
    expect(scopedAgain.scope?.session_id).toBe(scoped.scope?.session_id);
    expect(scopedAgain.items.map((item) => item.id)).toEqual(scoped.items.map((item) => item.id));
    expect(scopedAgain.items[0].status).toBe('done');

    // The independent scoped partition must not suppress normal daily lazy-compose.
    const daily = PracticeStreamResponseSchema.parse(await (await GET(getReq('today'))).json());
    expect(daily.scope).toBeNull();
    const dailyCopy = daily.items.find((item) => item.ref_id === scopedQuestion);
    expect(dailyCopy).toBeDefined();
    expect(dailyCopy?.id).not.toBe(scoped.items[0].id);
  });

  it('YUK-535: scoped GET rejects an unknown KC instead of showing a deceptive empty session', async () => {
    const res = await GET(new Request('http://t/api/practice/stream?date=today&kc=missing-kc'));
    expect(res.status).toBe(404);
  });

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

  it('PATCH advances item status and rejects illegal transitions (done 是终态)', async () => {
    await seedDueQuestion();
    const seeded = (await (await GET(getReq())).json()) as { items: Array<{ id: string }> };
    const itemId = seeded.items[0].id;

    const patch = (status: string) =>
      PATCH(
        new Request(`http://t/api/practice/stream/items/${itemId}`, {
          method: 'PATCH',
          body: JSON.stringify({ status }),
        }),
        { id: itemId },
      );

    const inProgress = await patch('in_progress');
    expect(inProgress.status).toBe(200);
    PracticeStreamItemUpdatedResponseSchema.parse(await inProgress.json());
    expect((await patch('done')).status).toBe(200);
    // done → pending 非法
    const illegal = await patch('pending');
    expect(illegal.status).toBe(409);

    const view = (await (await GET(getReq())).json()) as { progress: { done: number } };
    expect(view.progress.done).toBe(1);
  });

  it('skipped 可捡回（skipped → pending）', async () => {
    await seedDueQuestion();
    const seeded = (await (await GET(getReq())).json()) as { items: Array<{ id: string }> };
    const itemId = seeded.items[0].id;
    const patch = (status: string) =>
      PATCH(new Request('http://t/x', { method: 'PATCH', body: JSON.stringify({ status }) }), {
        id: itemId,
      });
    expect((await patch('skipped')).status).toBe(200);
    expect((await patch('pending')).status).toBe(200);
  });

  it('POST recompose keeps non-pending rows and re-adds from signals without duplicating refs', async () => {
    const qid = await seedDueQuestion();
    const seeded = (await (await GET(getReq())).json()) as { items: Array<{ id: string }> };
    const itemId = seeded.items[0].id;
    // 做完第一项
    await PATCH(
      new Request('http://t/x', { method: 'PATCH', body: JSON.stringify({ status: 'done' }) }),
      { id: itemId },
    );

    const res = await POST(
      new Request('http://t/api/practice/stream/recompose', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      added: number;
      items: Array<{ ref_id: string; status: string }>;
    };
    PracticeStreamRecomposedResponseSchema.parse(body);
    // done 行保留；同 ref 不重复排入（date+ref 唯一）
    const sameRef = body.items.filter((i) => i.ref_id === qid);
    expect(sameRef).toHaveLength(1);
    expect(sameRef[0].status).toBe('done');
  });

  it('POST recompose is bounded by the shared AI request limiter', async () => {
    vi.stubEnv('AI_RATE_LIMIT_MAX', '1');
    vi.stubEnv('AI_RATE_LIMIT_WINDOW_MS', '60000');

    const makeRequest = () =>
      POST(
        new Request('http://t/api/practice/stream/recompose', {
          method: 'POST',
          body: JSON.stringify({}),
        }),
      );
    expect((await makeRequest()).status).toBe(200);
    const blocked = await makeRequest();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('G1 (review)：真实路由 GET /api/practice/stream 在有非到期候选时命中 LLM 软选题路径（runTask mocked）', async () => {
    // 种一个 samplable 非到期变体候选 → 真实路由 lazy-compose 走 softmax_mfi（默认 policy）
    //   → tryLlmOrchestration → defaultRunTaskFn → import('@/server/ai/runner') runTask（mocked）。
    await seedDueQuestion();
    const variantId = await seedVariantCandidate();

    // mock runTask 出该候选的合法权重（绝不命中 live endpoint）。
    runTaskMock.mockImplementation(async (kind: string) => {
      expect(kind).toBe('SelectionOrchestratorTask');
      return {
        text: JSON.stringify({
          candidates: [{ refId: variantId, weight: 2, role: 'diagnostic', reason: 'x' }],
        }),
      };
    });

    const res = await GET(getReq('today'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ ref_id: string }> };

    // 证明生产路由真到达了 LLM 编排器（这是旧 route 测试的盲点：只 seed due → samplable=0）。
    expect(runTaskMock).toHaveBeenCalledTimes(1);
    expect(runTaskMock.mock.calls[0][0]).toBe('SelectionOrchestratorTask');

    // 候选被软选题路径抽进流（rng 默认 Math.random，π_i 由 weights 决定；这里只断言路径
    //   被命中——候选可能被抽中也可能不被抽中，断言聚焦「LLM 路径已执行」+「π_i 被记」）。
    const obs = await testDb()
      .select()
      .from(selection_observation)
      .where(eq(selection_observation.date, TODAY));
    // 软选题路径执行 ⇒ policy=softmax_mfi 的观测（若候选被抽中）。至少证明路径未走 legacy。
    for (const o of obs) {
      expect(o.policy).toBe('softmax_mfi');
      expect(o.inclusion_probability).toBeGreaterThan(0);
      expect(o.inclusion_probability).toBeLessThanOrEqual(1);
    }
    // 到期项始终 present（无论候选抽中与否）。
    expect(body.items.length).toBeGreaterThan(0);
  });

  // YUK-558 C8① — route 级 e2e determinism：GET compose → 快照选集 → 删物化流(+观测行) → 再 GET
  // → 断选集逐位相同。seed = buildSeededSelectionRng(TODAY, 'compose', TODAY) 两次 GET 同三元组 ⇒
  // 同 rng ⇒ 同 seeded 抽样序列。含 samplable 非到期候选（走 softmax_mfi seeded 抽样，非仅确定性
  // decay），runTask mock 出确定性权重（绝不命中 live endpoint）。route 的 3 行 seed 接线（GET
  // composeDeps.rng）由本测端到端覆盖。
  it('YUK-558 C8① — route-level GET compose is reproducible bit-for-bit (seeded sampler)', async () => {
    await seedDueQuestion();
    const variantId = await seedVariantCandidate();
    runTaskMock.mockImplementation(async (kind: string) => {
      expect(kind).toBe('SelectionOrchestratorTask');
      return {
        text: JSON.stringify({
          candidates: [{ refId: variantId, weight: 2, role: 'diagnostic', reason: 'x' }],
        }),
      };
    });

    // 第一次 GET：lazy compose + 持久化选集。
    const res1 = await GET(getReq('today'));
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { items: Array<{ ref_id: string }> };
    const selection1 = body1.items.map((i) => i.ref_id);
    expect(selection1.length).toBeGreaterThan(0);

    // 删物化流 + 观测行 → 强制第二次 GET 从头重 compose（否则只读既存流，不重抽）。
    await testDb().delete(practice_stream_item).where(eq(practice_stream_item.date, TODAY));
    await testDb().delete(selection_observation).where(eq(selection_observation.date, TODAY));

    // 第二次 GET：同 date ⇒ 同 seed ⇒ 逐位相同选集（seeded 抽样可重构）。
    const res2 = await GET(getReq('today'));
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { items: Array<{ ref_id: string }> };
    const selection2 = body2.items.map((i) => i.ref_id);
    expect(selection2).toEqual(selection1);
  });
});
