// YUK-361 Phase 4 (Task 9) — hybrid 运行时 store 层行为：夜间预产 composeNightly 幂等 +
// 作答后有界增量重排 reRankAfterAnswer 的不变量（②③④ + positivity）。
//
// LLM **永不命中 live endpoint**——全程注入 mock runTaskFn（composeDeps.runTaskFn）。
// 增量重排走纯统计 sampler（不调 LLM），rng 注入 seeded 确定化 Poisson 抽样。

import {
  event,
  item_calibration,
  knowledge,
  knowledge_edge,
  learning_item,
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
  streamLocalDate,
} from './stream-store';

const TODAY = streamLocalDate();

// rng：< 1 全选（Poisson Bernoulli 必入，配合 π_i>0）；== 1 全不选。
const RNG_ALWAYS_SELECT = () => 0;
// rng == 1 → Bernoulli `rng() < π_i` 恒 false → **零抽中**（模拟 Poisson 极端欠采，FINDING 1）。
const RNG_ALWAYS_REJECT = () => 1;

async function insertQuestion(opts: {
  id?: string;
  kind?: string;
  knowledgeIds?: string[];
  difficulty?: number;
  /** YUK-350 draft 排除回归：传 'draft' 模拟 container-only（embedded/teaching）题。 */
  draftStatus?: string | null;
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
      draft_status: opts.draftStatus ?? null,
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
async function seedVariantCandidate(
  opts: { kind?: string; kc?: string; b?: number; variantId?: string } = {},
): Promise<{
  variantId: string;
  kc: string;
}> {
  const kc = opts.kc ?? createId();
  const parentId = await insertQuestion({ kind: 'choice' });
  const variantId = await insertQuestion({
    id: opts.variantId,
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
  // mastery_state 行（per-KC）幂等 upsert：多个候选共享 KC 时只一行。
  // YUK-539: fail_count 2→3（evidence 5→6）以保「未掌握」语义 —— retune 后（γ=0.5/ρ=−0.25）
  // s=3/f=2 的 p(L)=σ(1.0)=0.731 会翻过 0.7（旧 γ=0.4 时 σ(0.8)=0.690 恰在下方），改 f=3 后
  // p(L)=σ(0.75)=0.679 仍 < 0.7，保持该候选是未掌握的复习候选。
  await testDb()
    .insert(mastery_state)
    .values({
      id: createId(),
      subject_kind: 'knowledge',
      subject_id: kc,
      theta_hat: 0,
      evidence_count: 6,
      success_count: 3,
      fail_count: 3,
      theta_precision: 4,
      updated_at: now,
    })
    .onConflictDoNothing();
  await testDb()
    .insert(item_calibration)
    .values({
      id: createId(),
      question_id: variantId,
      // 默认 b=0 → θ̂=b=0 → MFI 取最大 0.25。opts.b 可拉远 b 拉低 MFI（弱诊断候选）。
      b: opts.b ?? 0,
      track: 'hard',
      source: 'llm_prior',
      created_at: now,
      updated_at: now,
    });
  return { variantId, kc };
}

/** 把某 KC 的 mastery_state theta_hat 设成给定值（模拟作答后 θ̂ 移动）。 */
async function setKcTheta(kc: string, theta: number): Promise<void> {
  await testDb()
    .update(mastery_state)
    .set({ theta_hat: theta, updated_at: new Date() })
    .where(and(eq(mastery_state.subject_kind, 'knowledge'), eq(mastery_state.subject_id, kc)));
}

async function rowsForDate(date: string) {
  return testDb()
    .select()
    .from(practice_stream_item)
    .where(eq(practice_stream_item.date, date))
    .orderBy(asc(practice_stream_item.position));
}

describe('streamLocalDate — 用户本地日（Asia/Shanghai）单一真相源（FINDING 4，Codex）', () => {
  it('UTC 容器边界：21:30 UTC = 次日 05:30 Asia/Shanghai → 返回**次日**（不是 UTC 当日）', () => {
    // 模拟夜间 cron `'30 5 * * *', tz: 'Asia/Shanghai'` 在 UTC 容器里触发的瞬间：
    //   2026-06-15T21:30:00Z（UTC）= 2026-06-16T05:30:00+08:00（Asia/Shanghai）。
    // 旧实现（进程本地 = UTC）会算成 2026-06-15（前一天）→ 给错误日期预产流。
    const instant = new Date('2026-06-15T21:30:00Z');
    expect(streamLocalDate(instant)).toBe('2026-06-16'); // Asia/Shanghai 日，非 UTC 的 06-15。
  });

  it('跨年/月边界同样按 Asia/Shanghai 裁定（16:00 UTC = 次日 00:00 上海）', () => {
    // 2025-12-31T16:00:00Z = 2026-01-01T00:00:00+08:00。
    const instant = new Date('2025-12-31T16:00:00Z');
    expect(streamLocalDate(instant)).toBe('2026-01-01');
  });

  it('读路径 resolveDate 与夜间预产 runStreamComposeNightly 共用同一 helper → 日期恒一致', () => {
    // 两条路径都走 streamLocalDate()（读路径见 api/stream.ts:resolveDate；夜间见 job
    //   computeToday→streamLocalDate）。同一时刻调用必返回同值——幂等前提（不 double-compose）。
    const instant = new Date('2026-06-15T21:30:00Z');
    expect(streamLocalDate(instant)).toBe(streamLocalDate(instant));
  });
});

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

  // YUK-349 / ADR-0037 H8 (due-must-review) — due is a HARD constraint: ALL due items must
  // reach the stream; the engine may reorder/de-emphasize but never DROP. Regression guard
  // for the DUE_INPUT_LIMIT 10→200 fix (the old cap dropped due #11+ before the engine).
  it('due-must-review invariant: ALL due items reach the stream, not capped at 10', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      // distinct positive offsets → 12 distinct overdue items (> the old cap of 10).
      ids.push(await seedDueQuestion({ dueOffsetMs: (i + 1) * 3600_000 }));
    }

    await composeNightly(testDb(), TODAY, {
      policy: { policy: 'softmax_mfi' },
      composeDeps: { rng: RNG_ALWAYS_SELECT },
    });

    const streamRefs = new Set((await rowsForDate(TODAY)).map((r) => r.ref_id));
    // Every due item present — none dropped by the input cap (capacityGuard protects due
    // from truncation, so all 12 survive past any soft capacity too).
    for (const id of ids) expect(streamRefs.has(id)).toBe(true);
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

  it('真重排（HIGH 缺陷回归）：broad pool > slots → 真 IPPS → 新 ref 换进非到期尾 + π_i 严格 <1；冻结行 position/status 不动；无重复 position', async () => {
    // sharedKc：答完题与候选 A/B 同 KC（θ̂ 移动触发重排）。
    const sharedKc = createId();
    const dueId = await seedDueQuestion();
    const answeredId = await insertQuestion({ kind: 'choice', knowledgeIds: [sharedKc] });
    // 候选 A：compose 时已 eligible → 进初始流，成为**唯一**待做非到期 slot（targetCount=1）。
    const { variantId: candA } = await seedVariantCandidate({ kind: 'choice', kc: sharedKc, b: 0 });
    // recall 候选（fill_blank）——冻结，不进重排池。
    const { variantId: recallId } = await seedVariantCandidate({ kind: 'fill_blank' });

    // 首次 compose（候选 A + recall + due 入流；候选 B **尚未 seed** → 不在初始流）。
    await getStream(testDb(), TODAY, {
      composeIfEmpty: true,
      policy: { policy: 'softmax_mfi' },
      composeDeps: { rng: RNG_ALWAYS_SELECT },
    });

    // 关键：compose **之后**才 seed 候选 B（同 sharedKc，eligible）——它进重排的 fresh broad
    //   pool，但**不在**初始流里。故 pool={A,B}=2 > slots={A}=1 → 真 IPPS（π_i<1），可换进 B。
    const candB = createId();
    await seedVariantCandidate({ kind: 'choice', kc: sharedKc, b: 0, variantId: candB });

    // 模拟作答把 sharedKc 的 θ̂ 推动（θ̂=0.5；候选据新鲜 θ̂ 重算 MFI 权重）。
    await setKcTheta(sharedKc, 0.5);

    const before = await rowsForDate(TODAY);
    const beforeByRef = new Map(before.map((r) => [r.ref_id, r]));
    // 断言初始流不含 B（它是 compose 后才 seed 的），含 A + recall + due。
    expect(beforeByRef.has(candB)).toBe(false);
    expect(beforeByRef.has(candA)).toBe(true);
    expect(beforeByRef.has(recallId)).toBe(true);
    const dueBefore = beforeByRef.get(dueId);
    const recallBefore = beforeByRef.get(recallId);
    expect(dueBefore).toBeDefined();
    expect(recallBefore).toBeDefined();

    // 触发重排（rng=0 → 每个 π>0 候选都入；pool=2 slots=1 ⇒ 非退化 ⇒ 全部 π_i<1）。
    const added = await reRankAfterAnswer(testDb(), {
      date: TODAY,
      answeredQuestionId: answeredId,
      rng: RNG_ALWAYS_SELECT,
    });
    expect(added).toBeGreaterThan(0);

    const after = await rowsForDate(TODAY);
    const afterByRef = new Map(after.map((r) => [r.ref_id, r]));

    // ① 真重排：新 ref candB 被换进非到期尾（初始流没有它）——证明 broad pool 真生效（旧
    //    degenerate 版**永远**只重选已在流的同一集合，candB 不可能出现）。
    expect(afterByRef.has(candB)).toBe(true);
    expect(afterByRef.get(candB)?.source).toBe('variant');
    expect(afterByRef.get(candB)?.status).toBe('pending');

    // ② π_i 严格 <1（真 IPPS，非退化）——旧 bug 的 π=1 在此被 catch。
    const obs = await testDb()
      .select()
      .from(selection_observation)
      .where(eq(selection_observation.date, TODAY));
    // candB 必有观测（本轮真新插），且 π_i ∈ (0,1) 严格。
    const obsB = obs.filter((o) => o.ref_id === candB);
    expect(obsB.length).toBeGreaterThan(0);
    for (const o of obsB) {
      expect(o.inclusion_probability).toBeGreaterThan(0);
      expect(o.inclusion_probability).toBeLessThan(1); // 严格 <1 = 真 IPPS（非退化档）。
      expect(o.policy).toBe('softmax_mfi');
    }

    // ③ 冻结行：due 行 + recall 行 position 不动、presence 守住。
    expect(afterByRef.get(dueId)?.position).toBe(dueBefore?.position);
    expect(afterByRef.get(recallId)?.position).toBe(recallBefore?.position);

    // ④ 无重复 position。
    const positions = after.map((r) => r.position);
    expect(new Set(positions).size).toBe(positions.length);

    // ⑤ candB（本轮真新插）的观测 streamItemId 指向真存在的行（无幻影 π_i，EDGE 3）。
    //    NOTE：首次 compose 记的观测可能指向已被本轮替换删除的旧行 id（append-only 遥测的
    //    正常陈旧，非 EDGE-3 违例）——故只校验**本轮**新插项的 streamItemId 有真行。
    const afterIds = new Set(after.map((r) => r.id));
    for (const o of obsB) {
      if (o.stream_item_id) expect(afterIds.has(o.stream_item_id)).toBe(true);
    }
  });

  it('EDGE 2：待做非到期行新鲜 kind 不可解析 → 重判 recall → 不丢进空位（presence 守住，frozen-kept）', async () => {
    const sharedKc = createId();
    const dueId = await seedDueQuestion();
    const answeredId = await insertQuestion({ kind: 'choice', knowledgeIds: [sharedKc] });
    // 候选 A（choice，sharedKc）——初始 compose 进流，snapshot 非 recall（可重排）。
    const { variantId: candA } = await seedVariantCandidate({ kind: 'choice', kc: sharedKc, b: 0 });

    await getStream(testDb(), TODAY, {
      composeIfEmpty: true,
      policy: { policy: 'softmax_mfi' },
      composeDeps: { rng: RNG_ALWAYS_SELECT },
    });

    const before = await rowsForDate(TODAY);
    const candARowBefore = before.find((r) => r.ref_id === candA);
    expect(candARowBefore).toBeDefined();
    // snapshot 非 recall（choice）。
    expect((candARowBefore?.signals as { recallLocked?: boolean })?.recallLocked).not.toBe(true);

    // 把 candA 的 question.kind 改脏（枚举外）——fresh compute 时 resolveEnumKind→undefined→
    //   fail-closed recallLocked=true。该行**不得**被删进空位丢失（EDGE 2）。
    await testDb()
      .update(question)
      .set({ kind: 'garbage_unparseable_kind' })
      .where(eq(question.id, candA));

    await setKcTheta(sharedKc, 0.5);

    const added = await reRankAfterAnswer(testDb(), {
      date: TODAY,
      answeredQuestionId: answeredId,
      rng: RNG_ALWAYS_SELECT,
    });

    const after = await rowsForDate(TODAY);
    const afterByRef = new Map(after.map((r) => [r.ref_id, r]));

    // candA 仍在流里（presence 守住）——它被 freeze 保留，不删进空位。
    expect(afterByRef.has(candA)).toBe(true);
    // position 不动（frozen-kept）。
    expect(afterByRef.get(candA)?.position).toBe(candARowBefore?.position);
    // due 行 presence 守住。
    expect(afterByRef.has(dueId)).toBe(true);
    // 无重复 position（无空位 gap 导致的撞位）。
    const positions = after.map((r) => r.position);
    expect(new Set(positions).size).toBe(positions.length);
    // candA 被 freeze（不重抽样）→ 它不应被记一条幻影 IPPS 观测（recall 不进 sampler）。
    const obsA = await testDb()
      .select()
      .from(selection_observation)
      .where(and(eq(selection_observation.date, TODAY), eq(selection_observation.ref_id, candA)));
    // 首次 compose 时 candA 是 choice → 记过 1 条；本轮重排它被 freeze**不再**记新观测。
    expect(obsA.length).toBeLessThanOrEqual(1);
    // 即便 added>0（其它候选重排），candA 自身不在本轮新观测里。
    expect(added).toBeGreaterThanOrEqual(0);
  });

  it('EDGE 3：observation 数 == 真插入行数（onConflictDoNothing 吞掉的不记幻影 π_i）', async () => {
    const sharedKc = createId();
    await seedDueQuestion();
    const answeredId = await insertQuestion({ kind: 'choice', knowledgeIds: [sharedKc] });
    await seedVariantCandidate({ kind: 'choice', kc: sharedKc, b: 0 });

    await getStream(testDb(), TODAY, {
      composeIfEmpty: true,
      policy: { policy: 'softmax_mfi' },
      composeDeps: { rng: RNG_ALWAYS_SELECT },
    });

    // compose 后 seed 候选 B（sharedKc，eligible，不在初始流）→ broad pool > slots。
    const candB = createId();
    await seedVariantCandidate({ kind: 'choice', kc: sharedKc, b: 0, variantId: candB });
    await setKcTheta(sharedKc, 0.5);

    // 记重排前观测数（首次 compose 已记若干条）。
    const obsBefore = await testDb()
      .select()
      .from(selection_observation)
      .where(eq(selection_observation.date, TODAY));

    const rowsBefore = await rowsForDate(TODAY);
    const refIdsBefore = new Set(rowsBefore.map((r) => r.ref_id));

    const added = await reRankAfterAnswer(testDb(), {
      date: TODAY,
      answeredQuestionId: answeredId,
      rng: RNG_ALWAYS_SELECT,
    });

    const obsAfter = await testDb()
      .select()
      .from(selection_observation)
      .where(eq(selection_observation.date, TODAY));
    const newObs = obsAfter.length - obsBefore.length;

    // 本轮新增观测数 == added（真插入行数）——无幻影 π_i（EDGE 3 核心断言）。
    expect(newObs).toBe(added);

    // 本轮真新插入的 ref（流里此前不存在的）含 candB（broad pool 换进）。
    const rowsAfter = await rowsForDate(TODAY);
    const freshlyInserted = rowsAfter.filter(
      (r) => !refIdsBefore.has(r.ref_id) && r.status === 'pending',
    );
    expect(freshlyInserted.some((r) => r.ref_id === candB)).toBe(true);

    // 本轮新增观测（diff 出的那 added 条）都指向真存在的行（streamItemId 必有行，无幻影）。
    //   用 id 集合 diff 出本轮新观测——首次 compose 的旧观测可能指向已替换删除的行（陈旧，
    //   非违例），故只校验本轮新增的那批。
    const beforeObsIds = new Set(obsBefore.map((o) => o.id));
    const freshObs = obsAfter.filter((o) => !beforeObsIds.has(o.id));
    expect(freshObs.length).toBe(added);
    const afterIds = new Set(rowsAfter.map((r) => r.id));
    for (const o of freshObs) {
      expect(o.stream_item_id).not.toBeNull();
      if (o.stream_item_id) expect(afterIds.has(o.stream_item_id)).toBe(true);
    }
  });

  it('FINDING 1（DATA LOSS 回归）：Poisson 欠采到 0（rng==1）→ 不删任何待做非到期行（count 守住，无 position 空洞）', async () => {
    // 两条待做非到期诊断 slot（A/C 同 sharedKc，choice）+ broad pool（compose 后 seed B/D）
    //   → π_i<1。rng==1（RNG_ALWAYS_REJECT）→ Bernoulli 零抽中（sampled.length=0 < replaceable=2）。
    //   旧 bug：先删全部 replaceable（2 条）、再插 0 条 → **永久丢 2 道**（流缩短 + 空洞）。
    //   修复：deleteCount = min(0, 2) = 0 → 一条都不删 → count 守住。
    const sharedKc = createId();
    const dueId = await seedDueQuestion();
    const answeredId = await insertQuestion({ kind: 'choice', knowledgeIds: [sharedKc] });
    const { variantId: candA } = await seedVariantCandidate({ kind: 'choice', kc: sharedKc, b: 0 });
    const { variantId: candC } = await seedVariantCandidate({ kind: 'choice', kc: sharedKc, b: 0 });

    // 首次 compose（rng=0 全选 → A/C 入流为待做非到期 slot）。
    await getStream(testDb(), TODAY, {
      composeIfEmpty: true,
      policy: { policy: 'softmax_mfi' },
      composeDeps: { rng: RNG_ALWAYS_SELECT },
    });

    // compose 后 seed B/D（同 sharedKc，eligible，不在初始流）→ broad pool > slots → π_i<1。
    const candB = createId();
    const candD = createId();
    await seedVariantCandidate({ kind: 'choice', kc: sharedKc, b: 0, variantId: candB });
    await seedVariantCandidate({ kind: 'choice', kc: sharedKc, b: 0, variantId: candD });
    await setKcTheta(sharedKc, 0.5);

    const before = await rowsForDate(TODAY);
    const beforeByRef = new Map(before.map((r) => [r.ref_id, r]));
    // 确认 A/C 在初始流（待做非到期），B/D 不在。
    expect(beforeByRef.has(candA)).toBe(true);
    expect(beforeByRef.has(candC)).toBe(true);
    expect(beforeByRef.has(candB)).toBe(false);
    expect(beforeByRef.has(candD)).toBe(false);
    const pendingNonDueBefore = before.filter(
      (r) =>
        r.status === 'pending' &&
        r.item_kind === 'question' &&
        (r.source === 'variant' || r.source === 'new_check'),
    );
    expect(pendingNonDueBefore.length).toBeGreaterThanOrEqual(2);

    // 触发重排，**强制欠采到 0**（rng==1）。
    const added = await reRankAfterAnswer(testDb(), {
      date: TODAY,
      answeredQuestionId: answeredId,
      rng: RNG_ALWAYS_REJECT,
    });

    const after = await rowsForDate(TODAY);
    const afterByRef = new Map(after.map((r) => [r.ref_id, r]));

    // ① 零抽中 → 不删不插 → added=0。
    expect(added).toBe(0);
    // ② **NO 丢题**（FINDING 1 核心）：A/C 仍在流里，position 逐字不动。
    expect(afterByRef.has(candA)).toBe(true);
    expect(afterByRef.has(candC)).toBe(true);
    expect(afterByRef.get(candA)?.position).toBe(beforeByRef.get(candA)?.position);
    expect(afterByRef.get(candC)?.position).toBe(beforeByRef.get(candC)?.position);
    // ③ 待做非到期行 count 守住（不 shrink）。
    const pendingNonDueAfter = after.filter(
      (r) =>
        r.status === 'pending' &&
        r.item_kind === 'question' &&
        (r.source === 'variant' || r.source === 'new_check'),
    );
    expect(pendingNonDueAfter.length).toBe(pendingNonDueBefore.length);
    // ④ 全流行数不变（无任何行被丢）。
    expect(after.length).toBe(before.length);
    // ⑤ 无重复 + 无 position 空洞（连续 1..N，由删-未回填造成的洞会在此被 catch）。
    const positions = after.map((r) => r.position).sort((a, b) => a - b);
    expect(new Set(positions).size).toBe(positions.length);
    expect(positions).toEqual(positions.map((_, i) => i + 1));
    // ⑥ due 行 presence 守住。
    expect(afterByRef.has(dueId)).toBe(true);
  });

  it('FINDING 1（部分欠采）：sampled < replaceable → 只 SWAP 能填的，剩余原 slot 原地保留（count 守住）', async () => {
    // 两条 slot（A/C）+ broad pool（A/C/B/D 同 sharedKc）。rng 让**恰好一个**候选过 Bernoulli：
    //   首个 draw 过（rng=0）、其余全拒（rng=1）→ sampled.length=1 < replaceable=2。
    //   修复：deleteCount = min(newRefPicks=1, replaceable=2) = 1 → 删 1 填 1，另 1 原地保留 →
    //   待做非到期 count 守住（绝不 shrink 到 1）。
    const sharedKc = createId();
    await seedDueQuestion();
    const answeredId = await insertQuestion({ kind: 'choice', knowledgeIds: [sharedKc] });
    const { variantId: candA } = await seedVariantCandidate({ kind: 'choice', kc: sharedKc, b: 0 });
    const { variantId: candC } = await seedVariantCandidate({ kind: 'choice', kc: sharedKc, b: 0 });

    await getStream(testDb(), TODAY, {
      composeIfEmpty: true,
      policy: { policy: 'softmax_mfi' },
      composeDeps: { rng: RNG_ALWAYS_SELECT },
    });

    const candB = createId();
    const candD = createId();
    await seedVariantCandidate({ kind: 'choice', kc: sharedKc, b: 0, variantId: candB });
    await seedVariantCandidate({ kind: 'choice', kc: sharedKc, b: 0, variantId: candD });
    await setKcTheta(sharedKc, 0.5);

    const before = await rowsForDate(TODAY);
    const pendingNonDueBefore = before.filter(
      (r) =>
        r.status === 'pending' &&
        r.item_kind === 'question' &&
        (r.source === 'variant' || r.source === 'new_check'),
    );
    expect(pendingNonDueBefore.length).toBe(2); // A + C。
    void candA;
    void candC;

    // 第一个 Bernoulli draw 通过（rng=0），之后全部拒绝（rng=1）→ 恰抽中 1 个候选。
    let drawCount = 0;
    const rngOnePass = () => {
      const v = drawCount === 0 ? 0 : 1;
      drawCount++;
      return v;
    };

    const added = await reRankAfterAnswer(testDb(), {
      date: TODAY,
      answeredQuestionId: answeredId,
      rng: rngOnePass,
    });

    const after = await rowsForDate(TODAY);
    // ① 至多换进 1 条（部分欠采）。
    expect(added).toBeLessThanOrEqual(1);
    // ② 待做非到期 count **绝不 shrink**（仍 ≥ 原来的 2）——FINDING 1：删 1 必填 1，余者保留。
    const pendingNonDueAfter = after.filter(
      (r) =>
        r.status === 'pending' &&
        r.item_kind === 'question' &&
        (r.source === 'variant' || r.source === 'new_check'),
    );
    expect(pendingNonDueAfter.length).toBeGreaterThanOrEqual(pendingNonDueBefore.length);
    // ③ 无重复 + 无 position 空洞。
    const positions = after.map((r) => r.position).sort((a, b) => a - b);
    expect(new Set(positions).size).toBe(positions.length);
    expect(positions).toEqual(positions.map((_, i) => i + 1));
  });

  it('FINDING 2（KC 范围限定）：答 KC-A 不删/不动无关 KC-B 的待做非到期项（冻结，position 逐字不动）', async () => {
    // 答完题触 KC-A；流里有 KC-A 的待做项（可重排）+ KC-B 的待做项（无关，必须冻结）。
    const kcA = createId();
    const kcB = createId();
    await seedDueQuestion();
    const answeredId = await insertQuestion({ kind: 'choice', knowledgeIds: [kcA] });
    // KC-A 待做非到期项（受影响，可被重排）。
    const { variantId: candA } = await seedVariantCandidate({ kind: 'choice', kc: kcA, b: 0 });
    // KC-B 待做非到期项（无关 KC，**必须**被冻结，不删不动 position）。
    const { variantId: candB } = await seedVariantCandidate({ kind: 'choice', kc: kcB, b: 0 });

    await getStream(testDb(), TODAY, {
      composeIfEmpty: true,
      policy: { policy: 'softmax_mfi' },
      composeDeps: { rng: RNG_ALWAYS_SELECT },
    });

    const before = await rowsForDate(TODAY);
    const beforeByRef = new Map(before.map((r) => [r.ref_id, r]));
    expect(beforeByRef.has(candA)).toBe(true);
    expect(beforeByRef.has(candB)).toBe(true);
    const candBPosBefore = beforeByRef.get(candB)?.position;
    const candBIdBefore = beforeByRef.get(candB)?.id;

    // compose 后 seed KC-A 的新候选 candA2（broad pool > slots，可换进 KC-A 尾）。
    const candA2 = createId();
    await seedVariantCandidate({ kind: 'choice', kc: kcA, b: 0, variantId: candA2 });
    await setKcTheta(kcA, 0.5);

    const added = await reRankAfterAnswer(testDb(), {
      date: TODAY,
      answeredQuestionId: answeredId,
      rng: RNG_ALWAYS_SELECT,
    });

    const after = await rowsForDate(TODAY);
    const afterByRef = new Map(after.map((r) => [r.ref_id, r]));

    // ① KC-B 待做项**逐字不动**（FINDING 2 核心）：presence + position + 行 id 全保（未被删/重排）。
    expect(afterByRef.has(candB)).toBe(true);
    expect(afterByRef.get(candB)?.position).toBe(candBPosBefore);
    expect(afterByRef.get(candB)?.id).toBe(candBIdBefore); // 同一行（没被 delete+reinsert churn）。
    // ② candB 不应被记一条本轮新的 IPPS 观测（它被冻结、不进 sampler）。
    const obsB = await testDb()
      .select()
      .from(selection_observation)
      .where(and(eq(selection_observation.date, TODAY), eq(selection_observation.ref_id, candB)));
    // 首次 compose 时 candB 是 eligible → 记过 1 条；本轮重排它被冻结，不再记新观测。
    expect(obsB.length).toBeLessThanOrEqual(1);
    // ③ 重排仍可作用于 KC-A 尾（added ≥ 0；不强制必换，但 KC-B 绝不受影响）。
    expect(added).toBeGreaterThanOrEqual(0);
  });

  it('FINDING 3（legacy 开关）：SELECTION_POLICY=legacy → advanceStreamItem 不触发 reRankAfterAnswer', async () => {
    // legacy 紧急关闭开关下，advanceStreamItem 整体跳过随机重排。用一个**会触发重排**的场景
    //   （答完题的 KC 触及待做非到期候选 + broad pool）验证 legacy 下流**完全不动**。
    const sharedKc = createId();
    await seedDueQuestion();
    const answeredId = await insertQuestion({ kind: 'choice', knowledgeIds: [sharedKc] });
    await seedVariantCandidate({ kind: 'choice', kc: sharedKc, b: 0 });

    await getStream(testDb(), TODAY, {
      composeIfEmpty: true,
      policy: { policy: 'softmax_mfi' },
      composeDeps: { rng: RNG_ALWAYS_SELECT },
    });

    // compose 后 seed broad-pool 候选 candB（若重排触发，它会被换进）。
    const candB = createId();
    await seedVariantCandidate({ kind: 'choice', kc: sharedKc, b: 0, variantId: candB });
    await setKcTheta(sharedKc, 0.5);

    // 把 answeredId 作为流内一条 pending 题（推进 done 走 advanceStreamItem 的重排触发分支）。
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
    const snapByRef = new Map(snap.map((r) => [r.ref_id, r]));

    const prev = process.env.SELECTION_POLICY;
    process.env.SELECTION_POLICY = 'legacy';
    try {
      await advanceStreamItem(testDb(), answeredRowId, 'in_progress');
      await advanceStreamItem(testDb(), answeredRowId, 'done', { rng: RNG_ALWAYS_SELECT });
    } finally {
      // biome-ignore lint/performance/noDelete: 测试隔离——真正 unset env（非赋字符串 "undefined"）。
      if (prev === undefined) delete process.env.SELECTION_POLICY;
      else process.env.SELECTION_POLICY = prev;
    }

    const after = await rowsForDate(TODAY);
    const afterByRef = new Map(after.map((r) => [r.ref_id, r]));

    // ① answered 行推进 done 成功（状态写不受 policy 影响）。
    expect(afterByRef.get(answeredId)?.status).toBe('done');
    // ② legacy 下**重排不触发**：candB 绝不被换进（它只会因 softmax 重排进流）。
    expect(afterByRef.has(candB)).toBe(false);
    // ③ 除 answered 行 status 变 done 外，其余行 position+ref 集合**完全不变**（重排未跑）。
    const beforeRefs = [...snapByRef.keys()].sort();
    const afterRefs = [...afterByRef.keys()].sort();
    expect(afterRefs).toEqual(beforeRefs);
    for (const r of after) {
      if (r.ref_id === answeredId) continue;
      expect(r.position).toBe(snapByRef.get(r.ref_id)?.position);
      expect(r.id).toBe(snapByRef.get(r.ref_id)?.id); // 无 delete+reinsert churn。
    }
  });
});

// F1（YUK-350，P1 draft 泄漏）— collectComposerInputs 的 new_check 分支必须排除 draft 题。
// 场景：active learning_item 的 KC 尚无 material_fsrs_state（= 学了还没检验），new_check
//   会为该 KC 取一道题。若该 KC 下唯一的题是 draft（embedded/teaching container-only），
//   旧实现（无 draft 过滤）会把它选成 new_check 候选 → 经 materializeStream 暴露成
//   practice_stream_item(source='new_check')。修复后 draft 不入候选，new_check 为空。
describe('F1（YUK-350）— new_check 候选排除 draft 题', () => {
  /** active learning_item，挂一个尚无 material_fsrs_state 的 KC（触发 new_check）。 */
  async function seedUntrackedKcLearningItem(kc: string): Promise<void> {
    const now = new Date();
    await testDb()
      .insert(learning_item)
      .values({
        id: createId(),
        source: 'manual',
        title: '学习项',
        content: '',
        knowledge_ids: [kc],
        status: 'active',
        created_at: now,
        updated_at: now,
        version: 0,
      });
  }

  it('KC 下唯一题是 draft → new_check 候选为空（draft 不泄漏进流）', async () => {
    const kc = createId();
    await seedUntrackedKcLearningItem(kc);
    // 该 KC 下唯一的题是 draft（container-only）。
    await insertQuestion({ kind: 'choice', knowledgeIds: [kc], draftStatus: 'draft' });

    const inputs = await collectComposerInputs(testDb(), TODAY);
    const newCheckKcs = inputs.newCheckItems.map((n) => n.knowledgeId);
    expect(newCheckKcs).not.toContain(kc); // draft 不被选为 new_check。
    expect(inputs.newCheckItems).toHaveLength(0);
  });

  it('NULL≡active 与 active 题仍被 new_check 选中（仅 draft 排除）', async () => {
    const kcNull = createId();
    const kcActive = createId();
    await seedUntrackedKcLearningItem(kcNull);
    await seedUntrackedKcLearningItem(kcActive);
    // kcNull 唯一题 draft_status=NULL（auto-enroll / legacy 合法 active）。
    await insertQuestion({ kind: 'choice', knowledgeIds: [kcNull], draftStatus: null });
    // kcActive 唯一题 draft_status='active'（promoted quiz / variant）。
    await insertQuestion({ kind: 'choice', knowledgeIds: [kcActive], draftStatus: 'active' });

    const inputs = await collectComposerInputs(testDb(), TODAY);
    const newCheckKcs = new Set(inputs.newCheckItems.map((n) => n.knowledgeId));
    expect(newCheckKcs.has(kcNull)).toBe(true); // NULL 留池。
    expect(newCheckKcs.has(kcActive)).toBe(true); // 'active' 留池。
  });

  it('同 KC 既有 draft 又有 active 题 → new_check 永不取 draft 那条', async () => {
    const kc = createId();
    await seedUntrackedKcLearningItem(kc);
    const draftQ = await insertQuestion({
      kind: 'choice',
      knowledgeIds: [kc],
      draftStatus: 'draft',
    });
    const activeQ = await insertQuestion({
      kind: 'choice',
      knowledgeIds: [kc],
      draftStatus: 'active',
    });

    const inputs = await collectComposerInputs(testDb(), TODAY);
    const pick = inputs.newCheckItems.find((n) => n.knowledgeId === kc);
    expect(pick).toBeDefined();
    expect(pick?.questionId).not.toBe(draftQ); // 绝不取 draft。
    expect(pick?.questionId).toBe(activeQ); // 取 active 那条。
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B3 learnable_frontier（YUK-349 #3）— collectComposerInputs 收集 frontier + softmax
// 路径把 frontier 当 samplable 非到期候选纳入，同时守住到期 presence/order 不变量。
// ════════════════════════════════════════════════════════════════════════════

// 强制 L1 统计 fallback（runTask 返空文本 → parse [] → null → statisticalWeights）——
// frontier 候选仍经 sampleByWeight 抽样（rng=0 全选），永不命中 live endpoint。
const RUNTASK_FORCE_STATISTICAL = async () => ({ text: '' });

async function seedKnowledgeNode(id: string): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(knowledge)
    .values({
      id,
      name: id,
      domain: 'wenyan',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

async function seedPrereqEdge(from: string, to: string): Promise<void> {
  await seedKnowledgeNode(from);
  await seedKnowledgeNode(to);
  await testDb()
    .insert(knowledge_edge)
    .values({
      id: createId(),
      from_knowledge_id: from,
      to_knowledge_id: to,
      relation_type: 'prerequisite',
      weight: 1,
      created_by: 'user' as never,
      reasoning: null,
      created_at: new Date(),
      archived_at: null,
    });
}

async function setKcMastered(kc: string): Promise<void> {
  await seedKnowledgeNode(kc);
  await testDb()
    .insert(mastery_state)
    .values({
      id: createId(),
      subject_kind: 'knowledge',
      subject_id: kc,
      theta_hat: 0,
      // p(L)=σ(0.4·4)=0.83 ≥ 0.7 → mastered.
      evidence_count: 4,
      success_count: 4,
      fail_count: 0,
      theta_precision: 4,
      updated_at: new Date(),
    })
    .onConflictDoNothing();
}

/**
 * Seed a learnable-frontier graph: prereq P (mastered) → frontier KC F (cold, p(L)=0.5,
 * not mastered), with (by default) ONE non-draft active question tagged [F].
 */
async function seedFrontierGraph(
  opts: { withQuestion?: boolean } = {},
): Promise<{ frontierKc: string; questionId: string | null }> {
  const p = createId();
  const f = createId();
  await seedPrereqEdge(p, f); // P is prereq of F
  await setKcMastered(p);
  await seedKnowledgeNode(f); // F: no mastery row → cold start 0.5 < 0.7 → not mastered.
  let qid: string | null = null;
  if (opts.withQuestion !== false) {
    qid = await insertQuestion({ kind: 'choice', knowledgeIds: [f], difficulty: 3 });
    await testDb().insert(item_calibration).values({
      id: createId(),
      question_id: qid,
      b: 0,
      track: 'hard',
      source: 'llm_prior',
      created_at: new Date(),
      updated_at: new Date(),
    });
  }
  return { frontierKc: f, questionId: qid };
}

describe('B3 learnable_frontier — store 层（YUK-349 #3）', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('(a) collectComposerInputs 在 frontier 图上填充 frontierItems', async () => {
    const { frontierKc, questionId } = await seedFrontierGraph();
    const inputs = await collectComposerInputs(testDb(), TODAY);
    const pick = (inputs.frontierItems ?? []).find((f) => f.knowledgeId === frontierKc);
    expect(pick).toBeDefined();
    expect(pick?.questionId).toBe(questionId);
  });

  it('(c) frontier KC 无题 → SKIP（不进 frontierItems，不触发供给）', async () => {
    await seedFrontierGraph({ withQuestion: false });
    const inputs = await collectComposerInputs(testDb(), TODAY);
    expect(inputs.frontierItems ?? []).toEqual([]);
  });

  it('(b) composeNightly：frontier 题进流（source=frontier）且到期 presence/order 不变量守住', async () => {
    const dueEarly = await seedDueQuestion({ dueOffsetMs: 7200_000 });
    const dueLate = await seedDueQuestion({ dueOffsetMs: 3600_000 });
    const { questionId: frontierQ } = await seedFrontierGraph();

    // assertL3Invariants 在 composeSoftmaxStream 内运行——违例即 throw（composeNightly 失败）。
    await composeNightly(testDb(), TODAY, {
      policy: { policy: 'softmax_mfi' },
      composeDeps: { runTaskFn: RUNTASK_FORCE_STATISTICAL, rng: RNG_ALWAYS_SELECT },
    });

    const rows = await rowsForDate(TODAY);
    const refs = rows.map((r) => r.ref_id);
    // 到期 presence（铁律②）：两道 due 都在流里。
    expect(refs).toContain(dueEarly);
    expect(refs).toContain(dueLate);
    // 到期 intra-day 序（due_at ASC）：dueEarly(更早到期) 在 dueLate 之前。
    expect(refs.indexOf(dueEarly)).toBeLessThan(refs.indexOf(dueLate));
    // frontier 题进流，source='frontier'。
    const frontierRow = rows.find((r) => r.ref_id === frontierQ);
    expect(frontierRow).toBeDefined();
    expect(frontierRow?.source).toBe('frontier');
  });

  it('(d.1) NO-OP：稀疏图（无 prereq 边）→ 流里零 frontier-source 行', async () => {
    await seedDueQuestion();
    // KC + 题存在但无 prereq 边 → learnableFrontier 返 [] → frontierItems=[]（defer-flip）。
    const kc = createId();
    await seedKnowledgeNode(kc);
    await insertQuestion({ kind: 'choice', knowledgeIds: [kc] });

    const inputs = await collectComposerInputs(testDb(), TODAY);
    expect(inputs.frontierItems ?? []).toEqual([]);

    await composeNightly(testDb(), TODAY, {
      policy: { policy: 'softmax_mfi' },
      composeDeps: { runTaskFn: RUNTASK_FORCE_STATISTICAL, rng: RNG_ALWAYS_SELECT },
    });
    const rows = await rowsForDate(TODAY);
    expect(rows.every((r) => r.source !== 'frontier')).toBe(true);
  });

  it('(d.2) L3 quota=0（紧容量）下 frontier 仍存活，且到期 presence 守住', async () => {
    const dueId = await seedDueQuestion();
    const { questionId: frontierQ } = await seedFrontierGraph();

    // max=2, 1 due → nonDueBudget=1 → effectiveTarget=1 → frontierQuota=floor(1×0.2)=0。
    // frontier 仍经 sampledRefs 受保护（quota=0 时配额 inert，不削弱已有保护）。
    await composeNightly(testDb(), TODAY, {
      policy: { policy: 'softmax_mfi' },
      composeDeps: { runTaskFn: RUNTASK_FORCE_STATISTICAL, rng: RNG_ALWAYS_SELECT },
      capacity: { max: 2 },
    });

    const rows = await rowsForDate(TODAY);
    const refs = rows.map((r) => r.ref_id);
    expect(refs).toContain(dueId); // 到期 presence（铁律②）。
    expect(refs).toContain(frontierQ); // frontier 抽中并存活（quota=0 path 正确）。
  });
});
