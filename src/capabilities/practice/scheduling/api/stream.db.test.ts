// M2 (YUK-316) — 流 API 行为：lazy compose（仅今日）、状态机推进、双日隔离、
// recompose 保留非 pending 项。composer 混排规则本体在 stream-composer.unit.test.ts。

import { createId } from '@paralleldrive/cuid2';
import { and, asc, eq, isNull } from 'drizzle-orm';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  event,
  knowledge,
  learning_session,
  material_fsrs_state,
  practice_stream_item,
  question,
} from '@/db/schema';
import { contractIntegrityDigest } from '@/kernel/records/assessment-normalization';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import { __resetRateLimitForTests } from '@/kernel/request-rate-limit';
import { resetDb, testDb } from '../../../../../tests/helpers/db';

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

import {
  getPracticeStream,
  recomposePracticeStream,
  updatePracticeStreamItem,
} from '../server/stream-operations';
import { composeNightly } from '../server/stream-store';
import { GET, PATCH } from './stream';
import { PracticeStreamResponseSchema } from './stream-contracts';

async function insertDueQuestion(dueAt: Date): Promise<string> {
  const qid = await seedScopedQuestion({ knowledgeId: createId() });
  await testDb()
    .insert(material_fsrs_state)
    .values({
      id: createId(),
      subject_kind: 'question',
      subject_id: qid,
      state: {
        due: dueAt,
        stability: 1,
        difficulty: 5,
        scheduled_days: 1,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        state: 'review' as const,
        last_review: dueAt,
      },
      due_at: dueAt,
      last_review_event_id: null,
      updated_at: dueAt,
    });
  return qid;
}

/** 学习者真实作答活动（actor_kind='user'）——学习日裁定的唯一活动信号来源。 */
async function insertLearnerAttempt(
  at: Date,
  questionId: string,
  streamItemId?: string,
  generatedBy?: string,
) {
  await testDb()
    .insert(event)
    .values({
      id: createId(),
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: questionId,
      outcome: 'success',
      payload: {
        ...(streamItemId ? { stream_item_id: streamItemId } : {}),
        ...(generatedBy ? { generated_by: generatedBy } : {}),
      },
      created_at: at,
    });
}

function dailyRows(date: string) {
  return testDb()
    .select()
    .from(practice_stream_item)
    .where(and(eq(practice_stream_item.date, date), isNull(practice_stream_item.session_id)))
    .orderBy(asc(practice_stream_item.position));
}

/** Directly seed one stream row on a specific date (no compose path — explicit
 * dates never lazy-compose; these partition rows model existing history). */
async function insertStreamRow(input: {
  date: string;
  refId: string;
  status: 'pending' | 'in_progress' | 'done' | 'skipped';
  position?: number;
  source?:
    | 'decay'
    | 'variant'
    | 'new_check'
    | 'paper'
    | 'on_demand'
    | 'import'
    | 'frontier'
    | 'intervention';
  addedBy?: 'composer_nightly' | 'composer_live' | 'copilot' | 'user';
  signals?: Record<string, unknown>;
}): Promise<string> {
  const id = createId();
  await testDb()
    .insert(practice_stream_item)
    .values({
      id,
      date: input.date,
      position: input.position ?? 1,
      item_kind: 'question',
      ref_id: input.refId,
      source: input.source ?? 'decay',
      status: input.status,
      reasoning: 'seed',
      added_by: input.addedBy ?? 'composer_live',
      signals: input.signals ?? {},
      created_at: new Date(),
      updated_at: new Date(),
    });
  return id;
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
      choices_md: ['坡度不变，只记录流速', '固定水量，只改变坡度'],
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
  // Scoped stream items require a published, admitted, automatically-servable
  // contract. The deterministic option-set key is declared explicitly — no
  // normalizer reference_md key extraction (owner: no guess-key path).
  const options = [
    { option_id: `opt_${qid}_a`, label: 'A', text: '坡度不变，只记录流速' },
    { option_id: `opt_${qid}_b`, label: 'B', text: '固定水量，只改变坡度' },
  ];
  const contract = {
    structure: {
      group_id: qid,
      materials: [],
      parts: [{ part_id: 'p1', prompt_md: '专项题', material_ids: [] }],
    },
    response_spec: {
      slots: [{ slot_id: 'p1::r', part_id: 'p1', kind: 'single_choice' as const, options }],
    },
    scoring_basis: {
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'option_set_key' as const,
            accepted_option_ids: [`opt_${qid}_b`],
          },
          points: 2,
        },
      ],
      aggregation: { kind: 'sum' as const },
      blank_scores_zero: true,
    },
    execution_plan: {
      plan_version: 1,
      assignments: [
        {
          scoring_unit_ids: ['p1::u'],
          executor: { kind: 'deterministic' as const, comparator: 'exact_option_set' as const },
        },
      ],
      escalation: {
        on_unadmitted_model: 'withhold' as const,
        on_low_confidence: 'human_review' as const,
      },
    },
  };
  const published = await publishQuestionGroup(testDb(), {
    group_id: qid,
    contract: { ...contract, integrity_digest: contractIntegrityDigest(contract) },
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    actorRef: 'test:scoped-stream-publication',
    now,
    admission: {
      state: 'admitted',
      evidence: {
        marking_provenance: 'official',
        verification: { structural_check_passed: true, independent_verification: null },
        model_slice: null,
      },
    },
  });
  if (published.status !== 'published') throw new Error(published.status);
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

  // @invariant data: a still-open practice stream survives calendar midnight on the
  // same learning day, and a genuinely new learning day migrates prior
  // pending/in_progress rows with their identity, status and position — never
  // duplicating a ref, dropping progress, or stranding open work on an unread date.
  // @fails-if resolve "today" by calendar day or by the latest activity's day
  // (post-midnight action flips the partition and recomposes); carry without
  // progress-aware dedupe (a re-materialized ref double-inserts or the carried
  // row loses state); migrate by delete+insert (row id / issuance binding lost).
  it('YUK-2125: 连续夜间练习跨零点不丢流不重复 compose；>4h 不活跃后 pending/in_progress 随新学习日迁入', async () => {
    // 23:50（Asia/Shanghai）开始学习日 D1：懒编排产出当日流。
    const t2350 = new Date('2026-11-13T23:50:00+08:00');
    const t0010 = new Date('2026-11-14T00:10:00+08:00');
    const t0900 = new Date('2026-11-14T09:00:00+08:00');
    const DAY1 = '2026-11-13';
    const DAY2 = '2026-11-14';

    // due_at 钉在 D1 深夜（模拟时刻）：既对首次 compose 到期，也让
    // withdrawStalePendingDueLines 在 D1/D2 读来都判定卡片仍属该学习日。
    const due1 = await insertDueQuestion(t2350);
    const due2 = await insertDueQuestion(t2350);
    const due3 = await insertDueQuestion(t2350);

    const opened = await getPracticeStream(testDb(), { date: 'today' }, { now: t2350 });
    expect(opened.date).toBe(DAY1);
    expect(opened.items.length).toBeGreaterThanOrEqual(3);
    const composeCalls = runTaskMock.mock.calls.length;

    // 做 2 题（23:5x 作答活动），留 1 题 pending + 1 题 in_progress。
    const openItems = opened.items.filter((item) => item.status === 'pending');
    const doneItem = openItems[0];
    const inProgressItem = openItems[1];
    await updatePracticeStreamItem(testDb(), doneItem.id, { status: 'done' });
    await insertLearnerAttempt(t2350, doneItem.ref_id, doneItem.id);
    await insertLearnerAttempt(new Date('2026-11-13T23:58:00+08:00'), inProgressItem.ref_id);
    await updatePracticeStreamItem(testDb(), inProgressItem.id, { status: 'in_progress' });

    // 00:10 继续作答（真实的跨零点练习动作）并刷新：学习日仍未切——
    // 关键断言：解析的是**连续活动段首日**而非「最近一次活动的日历日」，否则
    // 00:10 的作答会把学习日翻到 D2（连续会话被切断）。
    const refreshed = await getPracticeStream(testDb(), { date: 'today' }, { now: t0010 });
    expect(refreshed.date).toBe(DAY1);
    expect(runTaskMock.mock.calls.length).toBe(composeCalls);
    const refreshedById = new Map(refreshed.items.map((item) => [item.id, item.status]));
    expect(refreshedById.get(doneItem.id)).toBe('done');
    expect(refreshedById.get(inProgressItem.id)).toBe('in_progress');
    expect(refreshed.items.length).toBe(opened.items.length);

    // 00:10 真实作答 + 00:20 再刷新：最近一次活动已落在 D2 的日历日，学习日
    // 仍须钉在段首日 D1（连续活动保同一学习日身份）。
    const t0020 = new Date('2026-11-14T00:20:00+08:00');
    await updatePracticeStreamItem(testDb(), inProgressItem.id, { status: 'done' });
    await insertLearnerAttempt(t0010, inProgressItem.ref_id, inProgressItem.id);
    const afterMidnight = await getPracticeStream(testDb(), { date: 'today' }, { now: t0020 });
    expect(afterMidnight.date).toBe(DAY1);
    expect(runTaskMock.mock.calls.length).toBe(composeCalls);
    const afterById = new Map(afterMidnight.items.map((item) => [item.id, item.status]));
    expect(afterById.get(inProgressItem.id)).toBe('done');

    // 第三题保持 in_progress 作为跨日保护对象（已 done 的两行留 D1 历史）。
    const carriedCandidate = openItems[2];
    await updatePracticeStreamItem(testDb(), carriedCandidate.id, { status: 'in_progress' });

    // 09:00（距最近活动 >4h）→ 新学习日 D2：compose 产出新日计划，
    // 旧分区 pending/in_progress 整批迁入 D2（行 id 不变、无重复 ref），done 留在 D1。
    const nextDay = await getPracticeStream(testDb(), { date: 'today' }, { now: t0900 });
    expect(nextDay.date).toBe(DAY2);

    const day1Rows = await dailyRows(DAY1);
    expect(day1Rows.every((row) => row.status === 'done' || row.status === 'skipped')).toBe(true);
    const day2Rows = await dailyRows(DAY2);
    const day2Ids = new Set(day2Rows.map((row) => row.id));
    expect(day2Ids.has(carriedCandidate.id)).toBe(true);
    const remainingPending = openItems.slice(3);
    for (const item of remainingPending) {
      expect(day2Ids.has(item.id)).toBe(true);
    }
    expect(day2Ids.has(doneItem.id)).toBe(false);
    expect(day2Ids.has(inProgressItem.id)).toBe(false);
    const refIds = day2Rows.map((row) => row.ref_id);
    expect(new Set(refIds).size).toBe(refIds.length);
    for (const qid of [due1, due2, due3]) {
      expect(refIds.filter((ref) => ref === qid).length).toBeLessThanOrEqual(1);
    }
    // D2 视图里被迁入的行仍可见且状态保留（保护候选不丢进度）。
    const viewById = new Map(nextDay.items.map((item) => [item.id, item.status]));
    expect(viewById.get(carriedCandidate.id)).toBe('in_progress');

    // 连续活动跨越第二个午夜：D2 深夜 23:00 作答 + D3 00:05 作答，
    // D3 00:15 刷新仍钉在段首日 D2（学习日身份随连续会话延续）。
    const tD2late = new Date('2026-11-14T23:00:00+08:00');
    const tD3early = new Date('2026-11-15T00:05:00+08:00');
    const tD3read = new Date('2026-11-15T00:15:00+08:00');
    const carriedItem = day2Rows.find((row) => row.id === carriedCandidate.id);
    expect(carriedItem).toBeDefined();
    await insertLearnerAttempt(tD2late, carriedCandidate.ref_id, carriedCandidate.id);
    await insertLearnerAttempt(tD3early, carriedCandidate.ref_id, carriedCandidate.id);
    const secondMidnight = await getPracticeStream(testDb(), { date: 'today' }, { now: tD3read });
    expect(secondMidnight.date).toBe(DAY2);

    // 显式历史日期读：不触发学习日裁定、不新 compose、不迁入迁出。
    const composeCallsBeforeHistory = runTaskMock.mock.calls.length;
    const history = await getPracticeStream(testDb(), { date: '2026-11-10' }, { now: tD3read });
    expect(history.date).toBe('2026-11-10');
    expect(history.items).toHaveLength(0);
    expect(runTaskMock.mock.calls.length).toBe(composeCallsBeforeHistory);
    const historyRows = await dailyRows('2026-11-10');
    expect(historyRows).toHaveLength(0);
  });

  // @invariant data: carry-forward resolves a same-ref collision by progress on
  // both sides — a pre-existing target row with zero progress (upload insert,
  // kept recompose survivor) never deletes a carried row that owns the learner's
  // in-flight work or its `iss_stream_<row.id>` binding.
  // @fails-if the collision branch keys deletion only on insert provenance
  // (freshRefs): a no-progress pending target row then deletes the carried
  // in_progress row and offers the same question back as fresh work.
  it('a pending upload row never deletes the carried row that owns in-flight progress', async () => {
    const t2350 = new Date('2026-11-13T23:50:00+08:00');
    const t0900 = new Date('2026-11-14T09:00:00+08:00');
    const DAY1 = '2026-11-13';
    const DAY2 = '2026-11-14';

    // D1: a composed stream row the learner has already opened (in_progress,
    // `iss_stream_<row.id>` binding). due_at pinned to D1 so the row is
    // eligible on the first compose and still counts as open on D2.
    const collisionQ = await insertDueQuestion(t2350);
    await insertDueQuestion(t2350);

    const opened = await getPracticeStream(testDb(), { date: 'today' }, { now: t2350 });
    expect(opened.date).toBe(DAY1);
    const carried = opened.items.find((item) => item.ref_id === collisionQ);
    expect(carried).toBeDefined();
    if (!carried) throw new Error('carried row missing');
    await updatePracticeStreamItem(testDb(), carried.id, { status: 'in_progress' });
    await insertLearnerAttempt(new Date('2026-11-13T23:58:00+08:00'), collisionQ, carried.id);

    // D2 before any compose: the learner's upload batch contains the same ref.
    // Upload dedupe only checks the same-date partition, so a no-progress
    // `source='import'` pending row lands on D2 while the D1 in_progress row
    // still owns the ref. Inserted with the same upload-practice signals the
    // real reconcile path writes (version + batch_id, no existing_stream).
    await testDb()
      .insert(practice_stream_item)
      .values({
        id: createId(),
        date: DAY2,
        position: 1,
        item_kind: 'question',
        ref_id: collisionQ,
        source: 'import',
        status: 'pending',
        reasoning: '刚上传',
        added_by: 'user',
        signals: { upload_practice: { version: 1, batch_id: 'batch-1' } },
        created_at: t0900,
        updated_at: t0900,
      });

    // First read on the new learning day → lazy compose → carry must keep the
    // progress-owning row, not the zero-progress duplicate.
    const nextDay = await getPracticeStream(testDb(), { date: 'today' }, { now: t0900 });
    expect(nextDay.date).toBe(DAY2);
    const viewById = new Map(nextDay.items.map((item) => [item.id, item]));
    expect(viewById.get(carried.id)?.status).toBe('in_progress');
    expect(viewById.get(carried.id)?.ref_id).toBe(collisionQ);

    const day2Rows = await dailyRows(DAY2);
    const collisionRows = day2Rows.filter((row) => row.ref_id === collisionQ);
    expect(collisionRows).toHaveLength(1);
    expect(collisionRows[0]?.id).toBe(carried.id);
    expect(collisionRows[0].status).toBe('in_progress');
  });

  // @invariant concurrency: two compose finalize paths on different days never
  // deadlock — the carry-capable finalize takes the global carry-admission lock
  // before its own target partition lock, so a tx holding G can only wait on
  // partitions held by single-lock writers (which never wait back), and no
  // two-transaction cycle exists.
  // @fails-if the finalize tx takes its target partition lock before the global
  // admission lock: T1 (D6 target) holds G + target-D6 and waits on source D2,
  // T2 (D5 target) holds target-D5 and waits on G — release of the external D2
  // holder then lets T1 take D2 and wait on T2's D5 while T2 waits on T1's G.
  it('cross-partition compose on different days never deadlocks', async () => {
    const D2 = '2026-11-12';
    const D5 = '2026-11-13';
    const D6 = '2026-11-14';

    // Older partition rows on D2 and D5 — the source sets the two concurrent
    // composes contend over. Seeded directly (explicit dates never lazy-compose);
    // draft questions keep the composer from re-selecting these refs into a
    // fresh plan so the carry rows stay the only owners of their refs.
    const d2RowId = await insertStreamRow({
      date: D2,
      refId: await seedScopedQuestion({ knowledgeId: createId(), draftStatus: 'draft' }),
      status: 'in_progress',
    });
    await insertStreamRow({
      date: D5,
      refId: await seedScopedQuestion({ knowledgeId: createId(), draftStatus: 'draft' }),
      status: 'in_progress',
    });
    // Learning-day activity on D5 so the D5 recompose resolves
    // carryForward=true (learning day stays on D5 while `now` is D5-evening).
    const d5Now = new Date('2026-11-13T21:00:00+08:00');
    await insertLearnerAttempt(new Date('2026-11-13T20:00:00+08:00'), createId());

    const testDbUrl = process.env.TEST_DATABASE_URL;
    if (!testDbUrl) throw new Error('TEST_DATABASE_URL not set');
    const blockerDb = postgres(testDbUrl, { max: 1 });
    const probeDb = postgres(testDbUrl, { max: 1 });
    const blocker = await blockerDb.reserve();

    const lockWaiters = async () =>
      probeDb`
        SELECT l.pid, l.mode, l.granted, a.query
        FROM pg_locks l
        JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND NOT l.granted
      `;
    const waitFor = async (cond: () => Promise<boolean>, label: string) => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (await cond()) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`timed out waiting for ${label}`);
    };

    try {
      // External blocker holds stream:compose:D2 — the source partition both
      // carries will contend for.
      await blocker`BEGIN`;
      await blocker`SELECT pg_advisory_xact_lock(hashtext('stream:compose:' || ${D2}))`;

      // D6 nightly runs first: G is free, so it reaches its carry source lock
      // on D2 and queues behind the blocker. Wait until pg_locks actually
      // shows the blocked advisory request before staging T2 — no sleeps.
      const d6 = composeNightly(testDb(), D6);
      await waitFor(async () => (await lockWaiters()).length > 0, 'D6 carry queued on D2');

      // D5 recompose runs second. Under the broken order it would take its
      // target D5 lock then queue on G behind D6; under the fixed order it
      // queues on G before touching D5. Either way it must be waiting on an
      // advisory lock before we release the blocker.
      const d5 = recomposePracticeStream(testDb(), { date: D5 }, { now: d5Now });
      await waitFor(async () => (await lockWaiters()).length > 1, 'D5 queued behind D6');

      // Release D2. Under the broken order D6 acquires D2, then waits on D5's
      // target lock while D5 waits on G — PG's deadlock detector aborts one of
      // them (baseline evidence: d6Result rejected). Under G-first order D5
      // never held D5 while waiting on G, so both serialize and finish.
      await blocker`ROLLBACK`;

      const [d5Result, d6Result] = await Promise.allSettled([d5, d6]);
      expect(d5Result.status, d5Result.status === 'rejected' ? String(d5Result.reason) : '').toBe(
        'fulfilled',
      );
      expect(d6Result.status, d6Result.status === 'rejected' ? String(d6Result.reason) : '').toBe(
        'fulfilled',
      );
    } finally {
      try {
        blocker.release();
      } catch {
        /* reserved sql already ended */
      }
      await blockerDb.end({ timeout: 5 });
      await probeDb.end({ timeout: 5 });
    }

    // D6 composed and carried D2's open row; D5 recomposed cleanly.
    const d6Rows = await dailyRows(D6);
    const allRows = await testDb().select().from(practice_stream_item);
    const d2Row = allRows.find((row) => row.id === d2RowId);
    expect(
      new Set(d6Rows.map((row) => row.id)).has(d2RowId),
      `d2Row should be carried to D6, got date=${d2Row?.date} status=${d2Row?.status}`,
    ).toBe(true);
    const refIds = d6Rows.map((row) => row.ref_id);
    expect(new Set(refIds).size).toBe(refIds.length);
  });

  // @invariant data: only genuine learner activity holds a learning day open.
  // A human-reviewed import/capture is stamped at the learner's action moment
  // (`generated_by='ingestion_capture'` etc.) and counts; a settlement write
  // stamped at workflow-completion time (`generated_by='workflow_judge'`) is
  // not learner activity and must not delay a genuinely new day.
  // @fails-if the streak filter counts workflow_judge (background completion
  // keeps the day open) or excludes every provenance (a user-reviewed 23:50
  // import then fails to hold the same day open past midnight).
  it('activity streak counts human-timed provenance but not workflow_judge settlement', async () => {
    // The learner's last live action was at 19:40; by 00:10 that is >4h ago
    // and cannot hold the day open on its own. A user-reviewed import at
    // 23:50 (`generated_by='ingestion_capture'`, stamped at request time) is
    // the only recent human action — it must keep the same learning day open
    // at 00:10. Then the learner stops; a workflow_judge settlement lands at
    // 00:30 stamped at completion time — at 04:20 the streak must be closed
    // (last genuine activity 23:50 is >4h ago) and the read must see a new
    // day, because the judge write cannot re-open it.
    const t1940 = new Date('2026-11-13T19:40:00+08:00');
    const t2350 = new Date('2026-11-13T23:50:00+08:00');
    const t0010 = new Date('2026-11-14T00:10:00+08:00');
    const t0030 = new Date('2026-11-14T00:30:00+08:00');
    const t0420 = new Date('2026-11-14T04:20:00+08:00');
    const DAY1 = '2026-11-13';
    const DAY2 = '2026-11-14';

    const practiced = await insertDueQuestion(t1940);
    const opened = await getPracticeStream(testDb(), { date: 'today' }, { now: t1940 });
    expect(opened.date).toBe(DAY1);

    // Live learner attempt at 19:40 — too old to hold the day at 00:10 alone.
    await insertLearnerAttempt(t1940, practiced, opened.items[0]?.id);
    // Human-reviewed import/capture at 23:50: real learner action time.
    await insertLearnerAttempt(t2350, practiced, undefined, 'ingestion_capture');

    // 00:10 read: only the 23:50 human action can hold the day open.
    const afterMidnight = await getPracticeStream(testDb(), { date: 'today' }, { now: t0010 });
    expect(afterMidnight.date).toBe(DAY1);

    // Background workflow judge settles at 00:30 — completion-time stamp.
    await insertLearnerAttempt(t0030, practiced, undefined, 'workflow_judge');

    // 04:20 read: streak closed at the 23:50 human action (>4h ago); the
    // judge write must not have re-opened it.
    const morning = await getPracticeStream(testDb(), { date: 'today' }, { now: t0420 });
    expect(morning.date).toBe(DAY2);
  });

  // @invariant data: an explicit `?date=` recompose mutates only that date's
  // partition — historical recompose never drags open rows from still-earlier
  // days into the target, preserving the explicit-date boundary GET already
  // keeps through `isToday`.
  // @fails-if recompose calls carry-forward unconditionally: recomposing D1
  // then moves open D0 rows into D1, editing a partition the caller did not
  // name and silently re-dating protected work.
  it('explicit historical recompose never carries earlier partitions', async () => {
    const D0 = '2026-11-12';
    const D1 = '2026-11-13';

    // D0 stream with a still-open row — the protected work the carry would
    // otherwise drag into D1. Inserted directly: explicit dates never
    // lazy-compose, so a real stream must be seeded. Draft questions keep the
    // composer from re-selecting these refs into the recomposed plan.
    await insertStreamRow({
      date: D0,
      refId: await seedScopedQuestion({ knowledgeId: createId(), draftStatus: 'draft' }),
      status: 'in_progress',
    });
    // D1 gets its own composed stream so recompose has a real target with a
    // pending row to rebuild.
    await insertStreamRow({
      date: D1,
      refId: await seedScopedQuestion({ knowledgeId: createId(), draftStatus: 'draft' }),
      status: 'in_progress',
    });

    const d0Before = await dailyRows(D0);
    const d0IdsBefore = new Set(d0Before.map((row) => row.id));

    // Explicit historical recompose of D1 must leave D0 untouched — the D0
    // in_progress row still owns its date and identity.
    await recomposePracticeStream(testDb(), { date: D1 });
    const d0After = await dailyRows(D0);
    expect(d0After.map((row) => row.id).sort()).toEqual([...d0IdsBefore].sort());
    const d0InProgress = d0After.find((row) => row.status === 'in_progress');
    expect(d0InProgress).toBeDefined();
    if (!d0InProgress) throw new Error('d0 in_progress row missing');
    expect(d0InProgress.date).toBe(D0);

    // And D0's rows did not materialize on D1 either.
    const d1After = await dailyRows(D1);
    for (const id of d0IdsBefore) {
      expect(d1After.some((row) => row.id === id)).toBe(false);
    }
  });
});
