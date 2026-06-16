// YUK-361 Phase 4 (Task 9) — hybrid 运行时 store 层行为：夜间预产 composeNightly 幂等 +
// 作答后有界增量重排 reRankAfterAnswer 的不变量（②③④ + positivity）。
//
// LLM **永不命中 live endpoint**——全程注入 mock runTaskFn（composeDeps.runTaskFn）。
// 增量重排走纯统计 sampler（不调 LLM），rng 注入 seeded 确定化 Poisson 抽样。

import {
  event,
  item_calibration,
  mastery_state,
  material_fsrs_state,
  mistake_variant,
  practice_stream_item,
  question,
  selection_observation,
} from '@/db/schema';
import { createId } from '@paralleldrive/cuid2';
import { and, asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  advanceStreamItem,
  collectComposerInputs,
  composeNightly,
  getStream,
  reRankAfterAnswer,
} from './stream-store';

const TODAY = new Date().toLocaleDateString('sv-SE');

// rng：< 1 全选（Poisson Bernoulli 必入，配合 π_i>0）；== 1 全不选。
const RNG_ALWAYS_SELECT = () => 0;

async function insertQuestion(opts: {
  id?: string;
  kind?: string;
  knowledgeIds?: string[];
  difficulty?: number;
}): Promise<string> {
  const qid = opts.id ?? createId();
  const now = new Date();
  await testDb()
    .insert(question)
    .values({
      id: qid,
      kind: opts.kind ?? 'choice',
      prompt_md: '题干',
      reference_md: 'B',
      knowledge_ids: opts.knowledgeIds ?? [],
      difficulty: opts.difficulty ?? 3,
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
  return qid;
}

async function seedDueQuestion(opts: { dueOffsetMs?: number } = {}): Promise<string> {
  const qid = await insertQuestion({ kind: 'choice' });
  const now = new Date();
  const offset = opts.dueOffsetMs ?? 3600_000;
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
      due_at: new Date(now.getTime() - offset),
      last_review_event_id: null,
      updated_at: now,
    });
  return qid;
}

/**
 * 非到期变体候选：parent 近期 failure + active mistake_variant 指向变体题。
 * 给变体题挂 KC + mastery_state + item_calibration.b → candidate-signals 算得出 MFI。
 * @returns { variantId, kc }（kc 用于测受影响 KC 触发）。
 */
async function seedVariantCandidate(opts: { kind?: string; kc?: string } = {}): Promise<{
  variantId: string;
  kc: string;
}> {
  const kc = opts.kc ?? createId();
  const parentId = await insertQuestion({ kind: 'choice' });
  const variantId = await insertQuestion({
    kind: opts.kind ?? 'choice',
    knowledgeIds: [kc],
    difficulty: 3,
  });
  const now = new Date();
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
  await testDb().insert(mastery_state).values({
    id: createId(),
    subject_kind: 'knowledge',
    subject_id: kc,
    theta_hat: 0,
    evidence_count: 5,
    success_count: 3,
    fail_count: 2,
    theta_precision: 4,
    updated_at: now,
  });
  await testDb().insert(item_calibration).values({
    id: createId(),
    question_id: variantId,
    b: 0, // θ̂=b=0 → MFI 取最大 0.25（非零权重）。
    track: 'hard',
    source: 'llm_prior',
    created_at: now,
    updated_at: now,
  });
  return { variantId, kc };
}

async function rowsForDate(date: string) {
  return testDb()
    .select()
    .from(practice_stream_item)
    .where(eq(practice_stream_item.date, date))
    .orderBy(asc(practice_stream_item.position));
}

describe('Task 9 夜间预产 composeNightly（YUK-361 Phase 4）', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('为今天预产流，物化行 added_by=composer_nightly', async () => {
    const dueId = await seedDueQuestion();

    const added = await composeNightly(testDb(), TODAY, {
      policy: { policy: 'softmax_mfi' },
      composeDeps: { rng: RNG_ALWAYS_SELECT },
    });
    expect(added).toBeGreaterThan(0);

    const rows = await rowsForDate(TODAY);
    expect(rows.map((r) => r.ref_id)).toContain(dueId);
    // 夜间预产的行全部标 composer_nightly（区分于用户首读 composer_live）。
    for (const r of rows) expect(r.added_by).toBe('composer_nightly');
  });

  it('幂等：composeNightly 跑两次不 double-compose（第二次 no-op，added=0、行数不变）', async () => {
    await seedDueQuestion();

    const first = await composeNightly(testDb(), TODAY, {
      policy: { policy: 'softmax_mfi' },
      composeDeps: { rng: RNG_ALWAYS_SELECT },
    });
    expect(first).toBeGreaterThan(0);
    const rowsAfterFirst = await rowsForDate(TODAY);

    const second = await composeNightly(testDb(), TODAY, {
      policy: { policy: 'softmax_mfi' },
      composeDeps: { rng: RNG_ALWAYS_SELECT },
    });
    // 双重检查命中（已物化）→ no-op。
    expect(second).toBe(0);
    const rowsAfterSecond = await rowsForDate(TODAY);
    expect(rowsAfterSecond.length).toBe(rowsAfterFirst.length);
  });

  it('幂等：夜间预产后用户首读 lazy-compose 命中双重检查 no-op（不 double-compose）', async () => {
    const dueId = await seedDueQuestion();

    // 夜间预产先跑。
    const nightlyAdded = await composeNightly(testDb(), TODAY, {
      policy: { policy: 'softmax_mfi' },
      composeDeps: { rng: RNG_ALWAYS_SELECT },
    });
    expect(nightlyAdded).toBeGreaterThan(0);
    const rowsAfterNightly = await rowsForDate(TODAY);

    // 用户首读 lazy-compose（composeIfEmpty）——应命中双重检查 no-op（流非空）。
    const view = await getStream(testDb(), TODAY, {
      composeIfEmpty: true,
      policy: { policy: 'softmax_mfi' },
      composeDeps: { rng: RNG_ALWAYS_SELECT },
    });
    expect(view.items.map((i) => i.ref_id)).toContain(dueId);

    const rowsAfterRead = await rowsForDate(TODAY);
    // 行数不变（lazy 没 double-compose），且仍标 composer_nightly（夜产的行未被覆盖）。
    expect(rowsAfterRead.length).toBe(rowsAfterNightly.length);
    for (const r of rowsAfterRead) expect(r.added_by).toBe('composer_nightly');
  });
});

describe('Task 9 作答后有界增量重排 reRankAfterAnswer（YUK-361 Phase 4）', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('不变量全集：done/in_progress/skipped 保 position+status；due 保 L1 序+presence；recall 不变；pending 非到期可变；无重复 position；π_i 记入', async () => {
    // 共享 KC：让答完的题与待重排候选触及同一 KC（θ̂ 移动 → 重排触发）。
    const sharedKc = createId();
    const d1 = await seedDueQuestion({ dueOffsetMs: 4 * 3600_000 }); // 更 overdue → L1 在前
    const d2 = await seedDueQuestion({ dueOffsetMs: 1 * 3600_000 });
    // 答完的题（带 sharedKc）——它推进 done 后驱动重排。
    const answeredId = await insertQuestion({ kind: 'choice', knowledgeIds: [sharedKc] });
    // 待重排的非到期诊断候选（同 sharedKc → 受影响）。
    const { variantId: vAffected } = await seedVariantCandidate({ kind: 'choice', kc: sharedKc });
    // recall-locked 候选（fill_blank）——确定性透传，不得被重排。
    const { variantId: recallId } = await seedVariantCandidate({ kind: 'fill_blank' });

    const runTaskFn = async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: JSON.stringify({
        candidates: [
          { refId: vAffected, weight: 3, role: 'diagnostic', arrangement: 1, reason: 'x' },
        ],
      }),
    });

    // 首次 compose 流（含 due + 非到期候选 + recall + answered 不在流里——它是单独答的题）。
    // 把 answeredId 作为一条 new_check 项塞进流，便于推进 done 触发重排。
    await getStream(testDb(), TODAY, {
      composeIfEmpty: true,
      policy: { policy: 'softmax_mfi' },
      composeDeps: { runTaskFn, rng: RNG_ALWAYS_SELECT },
    });
    // 手动追加 answeredId 为流内一条 pending 题（模拟它在流里被作答）。
    const beforeRows = await rowsForDate(TODAY);
    const maxPos = beforeRows.reduce((m, r) => Math.max(m, r.position), 0);
    const answeredRowId = createId();
    await testDb()
      .insert(practice_stream_item)
      .values({
        id: answeredRowId,
        date: TODAY,
        position: maxPos + 1,
        item_kind: 'question',
        ref_id: answeredId,
        source: 'new_check',
        status: 'pending',
        reasoning: 'self-check',
        added_by: 'composer_live',
        signals: {},
        created_at: new Date(),
        updated_at: new Date(),
      });

    // 抓「冻结」快照：due 行 + recall 行 + 一条手工置 in_progress 的 due 行。
    const dueOrder = (await collectComposerInputs(testDb(), TODAY)).dueItems.map(
      (d) => d.questionId,
    );
    // 把 d2（晚到期）置 in_progress（冻结），断言它 position+status 不被重排动。
    const snapBefore = await rowsForDate(TODAY);
    const d2Row = snapBefore.find((r) => r.ref_id === d2);
    expect(d2Row).toBeDefined();
    await testDb()
      .update(practice_stream_item)
      .set({ status: 'in_progress' })
      .where(eq(practice_stream_item.id, d2Row?.id as string));

    // 冻结快照（in_progress d2 / due d1 / recall / 受影响候选的 position）。
    const frozenSnap = await rowsForDate(TODAY);
    const d1Before = frozenSnap.find((r) => r.ref_id === d1);
    const d2Before = frozenSnap.find((r) => r.ref_id === d2);
    const recallBefore = frozenSnap.find((r) => r.ref_id === recallId);
    expect(d1Before?.status).toBe('pending');
    expect(d2Before?.status).toBe('in_progress');
    expect(recallBefore).toBeDefined();

    // 推进 answered 到 done → 触发增量重排（答完题的 sharedKc θ̂ 视为已动；重排受影响候选）。
    await advanceStreamItem(testDb(), answeredRowId, 'in_progress');
    await advanceStreamItem(testDb(), answeredRowId, 'done', { rng: RNG_ALWAYS_SELECT });

    const after = await rowsForDate(TODAY);
    const byRef = new Map(after.map((r) => [r.ref_id, r]));

    // ① done 行：保 position + status。
    const answeredAfter = after.find((r) => r.id === answeredRowId);
    expect(answeredAfter?.status).toBe('done');
    expect(answeredAfter?.position).toBe(maxPos + 1);

    // ② in_progress 行（d2）：保 position + status（冻结，未被重排碰）。
    expect(byRef.get(d2)?.status).toBe('in_progress');
    expect(byRef.get(d2)?.position).toBe(d2Before?.position);

    // ③ due presence + L1 相对序（d1 仍在、相对序仍 [d1, d2]）。
    for (const d of dueOrder) expect(byRef.has(d)).toBe(true);
    const refsOrdered = after.map((r) => r.ref_id);
    const dueSet = new Set(dueOrder);
    expect(refsOrdered.filter((r) => dueSet.has(r))).toEqual(dueOrder);
    // d1 position 冻结（due 行不被重排移位）。
    expect(byRef.get(d1)?.position).toBe(d1Before?.position);

    // ④ recall 行不变（position + presence；同题透传）。
    expect(byRef.has(recallId)).toBe(true);
    expect(byRef.get(recallId)?.position).toBe(recallBefore?.position);

    // ⑤ 无重复 position。
    const positions = after.map((r) => r.position);
    expect(new Set(positions).size).toBe(positions.length);

    // ⑥ 受影响 pending 非到期候选仍在流里（被重抽样落库——可换新行 id，但 ref 在）。
    expect(byRef.has(vAffected)).toBe(true);

    // ⑦ π_i 记入 selection_observation（重排对重抽样项记真 π_i，positivity）。
    const obs = await testDb()
      .select()
      .from(selection_observation)
      .where(
        and(eq(selection_observation.date, TODAY), eq(selection_observation.ref_id, vAffected)),
      );
    // 至少一条（首次 compose 1 条 + 重排可能再记 1 条）；全部 π_i ∈ (0,1]、policy=softmax_mfi。
    expect(obs.length).toBeGreaterThan(0);
    for (const o of obs) {
      expect(o.policy).toBe('softmax_mfi');
      expect(o.inclusion_probability).toBeGreaterThan(0);
      expect(o.inclusion_probability).toBeLessThanOrEqual(1);
    }
  });

  it('bounded no-op：答完题的 KC 不触及任何待做非到期诊断项 → 重排不动流（行数+position 不变）', async () => {
    // 答完题用一个孤立 KC；待做候选用另一个 KC——θ̂ 移动不触及候选 → no-op。
    const isolatedKc = createId();
    await seedDueQuestion();
    const { variantId: unrelated } = await seedVariantCandidate({ kind: 'choice' }); // 不同 KC
    const answeredId = await insertQuestion({ kind: 'choice', knowledgeIds: [isolatedKc] });

    const runTaskFn = async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: JSON.stringify({
        candidates: [
          { refId: unrelated, weight: 2, role: 'diagnostic', arrangement: 1, reason: 'x' },
        ],
      }),
    });

    await getStream(testDb(), TODAY, {
      composeIfEmpty: true,
      policy: { policy: 'softmax_mfi' },
      composeDeps: { runTaskFn, rng: RNG_ALWAYS_SELECT },
    });

    const beforeRows = await rowsForDate(TODAY);
    const maxPos = beforeRows.reduce((m, r) => Math.max(m, r.position), 0);
    const answeredRowId = createId();
    await testDb()
      .insert(practice_stream_item)
      .values({
        id: answeredRowId,
        date: TODAY,
        position: maxPos + 1,
        item_kind: 'question',
        ref_id: answeredId,
        source: 'new_check',
        status: 'pending',
        reasoning: 'self-check',
        added_by: 'composer_live',
        signals: {},
        created_at: new Date(),
        updated_at: new Date(),
      });

    const snap = await rowsForDate(TODAY);

    await advanceStreamItem(testDb(), answeredRowId, 'in_progress');
    const added = await reRankAfterAnswer(testDb(), {
      date: TODAY,
      answeredQuestionId: answeredId,
      rng: RNG_ALWAYS_SELECT,
    });

    // no-op：θ̂(isolatedKc) 移动不触及 unrelated（KC 不同）→ 不重排。
    expect(added).toBe(0);
    const after = await rowsForDate(TODAY);
    expect(after.length).toBe(snap.length);
    // 每行 position 逐字不动。
    const beforeByRef = new Map(snap.map((r) => [r.ref_id, r.position]));
    for (const r of after) expect(r.position).toBe(beforeByRef.get(r.ref_id));
  });

  it('no-op：答完题无 knowledge_ids → 无受影响 KC 锚点 → reRankAfterAnswer 直接返回 0', async () => {
    await seedDueQuestion();
    const answeredId = await insertQuestion({ kind: 'choice', knowledgeIds: [] }); // 无 KC

    await getStream(testDb(), TODAY, {
      composeIfEmpty: true,
      policy: { policy: 'softmax_mfi' },
      composeDeps: { rng: RNG_ALWAYS_SELECT },
    });
    const before = await rowsForDate(TODAY);

    const added = await reRankAfterAnswer(testDb(), {
      date: TODAY,
      answeredQuestionId: answeredId,
      rng: RNG_ALWAYS_SELECT,
    });
    expect(added).toBe(0);
    const after = await rowsForDate(TODAY);
    expect(after.length).toBe(before.length);
  });
});
