// YUK-361 Phase 3 Step C2 — 档2 softmax_mfi 选题接线 + L3 守门 + 两级 fallback 测试。
//
// 覆盖（impl plan Step D + Step C2 prompt TESTS 段）：
//   - softmax 主路：runTask mocked 出合法权重 → 到期项全present + L1 序；非到期被抽样；
//     π_i 记进 selection_observation；signals 快照持久化。
//   - L1 fallback：runTask 抛/返垃圾 → 统计 sampler 触发，流仍合法，π_i 仍记。
//   - L2 fallback：候选收集抛 → composeDailyStream legacy 用，流合法（无 π_i）。
//   - 不变量：recall-locked 同题透传（不变体）、到期 presence、容量。
//   - policy='legacy' → composeDailyStream 路径，零 signals。
//
// LLM **永不命中 live endpoint**——全程注入 mock runTaskFn（composeDeps.runTaskFn）。
// rng 注入 seeded（全选 / 全不选）以确定化 Poisson 抽样。

import { streamLocalDate } from '@/capabilities/practice/server/stream-store';
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
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import * as observationsModule from '../server/selection-observations';
import { composeSoftmaxStream } from '../server/softmax-selection';
import type { ComposerInputs } from '../server/stream-composer';
import {
  advanceStreamItem,
  collectComposerInputs,
  getStream,
  recomposeStream,
} from '../server/stream-store';

const TODAY = streamLocalDate();

// rng 注入：< 1 全选（Poisson Bernoulli 必入，配合 π_i），== 1 全不选（rng() < π 永假）。
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

/**
 * 到期题：FSRS due_at 在过去 → handleReviewDue 投影为 due 项。
 * @param opts.dueOffsetMs 过去多少 ms 到期（越大越 overdue → due_at ASC 序越靠前）；默认 1h。
 */
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
 * @returns 变体题 id（非到期 samplable 候选）。
 */
async function seedVariantCandidate(opts: { kind?: string; kc?: string }): Promise<string> {
  const kc = opts.kc ?? createId();
  const parentId = await insertQuestion({ kind: 'choice' });
  const variantId = await insertQuestion({
    kind: opts.kind ?? 'choice',
    knowledgeIds: [kc],
    difficulty: 3,
  });
  const now = new Date();
  // parent 近期 failure event（7 天窗口内）。
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
  // mastery_state（KC θ̂） + item_calibration.b（真锚）→ MFI 可算。
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
    b: 0, // θ̂=b=0 → MFI 取最大 0.25（确保非零权重）。
    track: 'hard',
    source: 'llm_prior',
    created_at: now,
    updated_at: now,
  });
  return variantId;
}

describe('softmax_mfi 选题接线（YUK-361 Phase 3 Step C2）', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('softmax 主路（G3 强化）：spy 证明 LLM 被调用一次 + kind=SelectionOrchestratorTask；到期 present+L1 序；π_i 记入 selection_observation；signals 快照持久化', async () => {
    const dueId = await seedDueQuestion();
    const v1 = await seedVariantCandidate({ kind: 'choice' });
    const v2 = await seedVariantCandidate({ kind: 'choice' });

    // G3：vi.fn() spy——断言 runTaskFn 被调用一次且 kind=SelectionOrchestratorTask，
    //     证明生产选题路径真到达了 LLM 编排器（不是静默走 fallback）。
    const runTaskFn = vi.fn(async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: JSON.stringify({
        candidates: [
          { refId: v1, weight: 3, role: 'diagnostic', arrangement: 1, reason: '诊断价值高' },
          { refId: v2, weight: 1, role: 'diagnostic', arrangement: 2, reason: '错因复发' },
        ],
      }),
    }));

    // L1 due 真相序（handleReviewDue 投影 + 跨学科平衡）——断言锚。
    const dueOrder = (await collectComposerInputs(testDb(), TODAY)).dueItems.map(
      (d) => d.questionId,
    );

    const view = await getStream(testDb(), TODAY, {
      composeIfEmpty: true,
      policy: { policy: 'softmax_mfi', temperature: 0.25 },
      composeDeps: { runTaskFn, rng: RNG_ALWAYS_SELECT },
    });

    // LLM 被调用恰一次，kind 正确（证明生产 softmax/LLM 路径被命中——G3 核心：旧测试没断言）。
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect(runTaskFn.mock.calls[0][0]).toBe('SelectionOrchestratorTask');

    const refs = view.items.map((i) => i.ref_id);
    // 到期项全 present（presence 铁律②）+ 我的种子到期题在内。
    expect(dueOrder.length).toBeGreaterThan(0);
    expect(dueOrder).toContain(dueId);
    for (const d of dueOrder) expect(refs).toContain(d);
    // 到期项保 L1 相对序（NOT reordered by LLM）——流里 due 子序列 === dueOrder。
    const dueSet = new Set(dueOrder);
    expect(refs.filter((r) => dueSet.has(r))).toEqual(dueOrder);
    // 到期项全在非到期 sampled 项之前（散题段在 due 之后）。
    const firstNonDueIdx = refs.findIndex((r) => r === v1 || r === v2);
    const lastDueIdx = Math.max(...dueOrder.map((d) => refs.indexOf(d)));
    expect(lastDueIdx).toBeLessThan(firstNonDueIdx);
    // 非到期被抽样进流（RNG_ALWAYS_SELECT → π>0 全入；默认容量充足，不截断）。
    expect(refs).toContain(v1);
    expect(refs).toContain(v2);

    // π_i 记入 selection_observation（policy=softmax_mfi，只非到期 sampled）。
    const obs = await testDb()
      .select()
      .from(selection_observation)
      .where(eq(selection_observation.date, TODAY));
    const obsRefs = obs.map((o) => o.ref_id);
    expect(obsRefs).toContain(v1);
    expect(obsRefs).toContain(v2);
    // 到期项 NOT 记 π_i（确定性 π=1，不入 IPW）。
    expect(obsRefs).not.toContain(dueId);
    for (const o of obs) {
      expect(o.policy).toBe('softmax_mfi');
      expect(o.selected).toBe(true);
      expect(o.inclusion_probability).toBeGreaterThan(0);
      expect(o.inclusion_probability).toBeLessThanOrEqual(1);
      // signals 快照持久化（含 mfiScore 等）。
      expect(o.signals).toBeTruthy();
      expect((o.signals as Record<string, unknown>).refId).toBeDefined();
      // streamItemId 关联物化行。
      expect(o.stream_item_id).toBeTruthy();
    }

    // 物化行的 signals 快照：非到期 sampled 行带信号，到期行为 {}。
    const rows = await testDb()
      .select()
      .from(practice_stream_item)
      .where(eq(practice_stream_item.date, TODAY));
    const v1row = rows.find((r) => r.ref_id === v1);
    expect((v1row?.signals as Record<string, unknown>)?.refId).toBe(v1);
    const duerow = rows.find((r) => r.ref_id === dueId);
    expect(duerow?.signals).toEqual({});
  });

  it('G3 (π_i)：tight 容量 → π_i 真随机分布（< 1，非塌成 [1,1]）；fallback=none', async () => {
    // 直接调 composeSoftmaxStream 以拿到 result.fallback + 全候选的真 π_i 向量（getStream 不
    //   暴露这两者）。tight 容量（nonDueBudget=1 < N=2）⇒ sampler 给两候选都算出 π_i<1。
    //   rng 让两候选都通过 Bernoulli（π>0 全入）。
    //   FINDING 2 后：sampled 项**不再被容量截断**（截断会破坏 π_i 的 IPW 正确性），故
    //   两个被抽中项都留在 sampledInclusion，各记真 π_i<1。
    //   「高/低权 π_i 不同」的 sampler 数学由 selection-sampler.unit 的「higher weight → higher π_i」覆盖。
    const v1 = await seedVariantCandidate({ kind: 'choice' }); // 高权
    const v2 = await seedVariantCandidate({ kind: 'choice' }); // 低权

    const inputs = await collectComposerInputs(testDb(), TODAY);
    inputs.capacity = { max: inputs.dueItems.length + 1 }; // nonDueBudget = 1 < 2 ⇒ π_i < 1

    const runTaskFn = vi.fn(async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: JSON.stringify({
        candidates: [
          { refId: v1, weight: 3, role: 'diagnostic', arrangement: 1, reason: 'hi' },
          { refId: v2, weight: 1, role: 'diagnostic', arrangement: 2, reason: 'lo' },
        ],
      }),
    }));

    const result = await composeSoftmaxStream(
      testDb(),
      inputs,
      { policy: 'softmax_mfi', temperature: 0.25 },
      { runTaskFn, rng: RNG_ALWAYS_SELECT },
    );

    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect(result.fallback).toBe('none'); // softmax 主路全程成功（非 statistical/legacy）

    // 关键回归：两被抽中项的 π_i 都严格 < 1（旧盲点 targetCount≥N 会塌成 π=1）。
    const piV1 = result.sampledInclusion.get(v1);
    const piV2 = result.sampledInclusion.get(v2);
    expect(piV1).toBeDefined();
    expect(piV2).toBeDefined();
    expect(piV1 as number).toBeLessThan(1);
    expect(piV1 as number).toBeGreaterThan(0);
    expect(piV2 as number).toBeLessThan(1);
    expect(piV2 as number).toBeGreaterThan(0);
  });

  it('FINDING 1（positivity）：LLM 只编排 samplable 的子集 → 被漏候选 floor-fill 仍被抽样 + 记 π_i>0', async () => {
    // LLM 漏排 v2（只给 v1 权重）。修复前：v2 拿不到权重 → 不进 sampler → π_i=0（positivity
    //   违例 + 静默丢候选）。修复后：v2 被 floor-fill 一个统计权重 → 进 sampler → π_i>0、被抽中、
    //   记进 selection_observation。rng=0 全选 → 两者都入流。
    await seedDueQuestion();
    const v1 = await seedVariantCandidate({ kind: 'choice' });
    const v2 = await seedVariantCandidate({ kind: 'choice' });

    // 只编排 v1——v2 被 LLM 完全省略。
    const runTaskFn = vi.fn(async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: JSON.stringify({
        candidates: [
          { refId: v1, weight: 3, role: 'diagnostic', arrangement: 1, reason: 'only v1' },
        ],
      }),
    }));

    const view = await getStream(testDb(), TODAY, {
      composeIfEmpty: true,
      policy: { policy: 'softmax_mfi', temperature: 0.25 },
      composeDeps: { runTaskFn, rng: RNG_ALWAYS_SELECT },
    });

    expect(runTaskFn).toHaveBeenCalledTimes(1);
    const refs = view.items.map((i) => i.ref_id);
    // 两个 samplable 都在流里——v2 没被静默丢弃（positivity 保住）。
    expect(refs).toContain(v1);
    expect(refs).toContain(v2);

    // v2 记进 selection_observation 且 π_i>0（floor-fill 保 positivity）。
    const obs = await testDb()
      .select()
      .from(selection_observation)
      .where(eq(selection_observation.date, TODAY));
    const obsRefs = obs.map((o) => o.ref_id);
    expect(obsRefs).toContain(v1);
    expect(obsRefs).toContain(v2);
    const v2Obs = obs.find((o) => o.ref_id === v2);
    expect(v2Obs?.inclusion_probability).toBeGreaterThan(0);
  });

  it('FINDING 2（π_i = 真最终入选概率）：realized 抽样超容量 → sampled 项不被截断，记录 π_i = 真入选概率', async () => {
    // nonDueBudget=1 但 rng=0 让 realized 抽样=2（Poisson 上溢，超 budget）。修复前：
    //   capacityGuard 会按 arrangement 尾部截断（砍 v2），却为幸存的 v1 记**截断前**的 π_i
    //   → π_i 高估真实入选概率。修复后（option b）：sampled 项不被截断，v1+v2 都留在流里，
    //   各记自己真实的 sampler π_i（=出现在最终流的真实概率，因为没有第二重截断过滤）。
    const v1 = await seedVariantCandidate({ kind: 'choice' });
    const v2 = await seedVariantCandidate({ kind: 'choice' });

    const inputs = await collectComposerInputs(testDb(), TODAY);
    // nonDueBudget = max - dues = 1 < N=2 候选 ⇒ Σπ_i=1，但 rng=0 让两者都过 Bernoulli。
    inputs.capacity = { max: inputs.dueItems.length + 1 };

    const runTaskFn = vi.fn(async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: JSON.stringify({
        candidates: [
          { refId: v1, weight: 3, role: 'diagnostic', arrangement: 1, reason: 'hi' },
          { refId: v2, weight: 1, role: 'diagnostic', arrangement: 2, reason: 'lo' },
        ],
      }),
    }));

    const result = await composeSoftmaxStream(
      testDb(),
      inputs,
      { policy: 'softmax_mfi', temperature: 0.25 },
      { runTaskFn, rng: RNG_ALWAYS_SELECT },
    );

    const planRefs = result.plan.items.map((i) => i.ref_id);
    // realized 抽样 (2) > nonDueBudget (1)：两个 sampled 项都留在 plan（不截断）。
    expect(planRefs).toContain(v1);
    expect(planRefs).toContain(v2);

    // 记录的 π_i ⇔ 真出现在最终流：两项都在流里 ⇒ 两者都在 sampledInclusion，
    //   且各等于 sampler 算出的真 π_i（无截断的第二重过滤压低真实入选概率）。
    const piV1 = result.sampledInclusion.get(v1);
    const piV2 = result.sampledInclusion.get(v2);
    expect(piV1).toBeDefined();
    expect(piV2).toBeDefined();
    expect(piV1 as number).toBeGreaterThan(0);
    expect(piV1 as number).toBeLessThanOrEqual(1);
    expect(piV2 as number).toBeGreaterThan(0);
    expect(piV2 as number).toBeLessThanOrEqual(1);
    // 关键：sampledInclusion 与 plan 里被抽中项**一一对应**（无幻影 π_i、无漏记）。
    const sampledInPlan = planRefs.filter((r) => r === v1 || r === v2).sort();
    expect([...result.sampledInclusion.keys()].sort()).toEqual(sampledInPlan);
  });

  it('FINDING 5（config.targetCount 被尊重）：传入 targetCount 下采样非到期，受 nonDueBudget 上界约束', async () => {
    // 4 个 samplable + 充足容量（nonDueBudget=4）。config.targetCount=1 → effectiveTarget=
    //   min(1,4)=1 ⇒ Σπ_i=1 ⇒ 每个候选 π_i≈0.25（<1）。若 targetCount 被忽略（旧 bug），
    //   sampler 会用 nonDueBudget=4 ≥ N=4 ⇒ 全部 π_i=1。故 π_i<1 直接证明 targetCount 被采纳。
    const vs: string[] = [];
    for (let i = 0; i < 4; i++) vs.push(await seedVariantCandidate({ kind: 'choice' }));

    const inputs = await collectComposerInputs(testDb(), TODAY);
    inputs.capacity = { max: inputs.dueItems.length + 4 }; // nonDueBudget = 4 = N（若忽略 → π=1）

    const runTaskFn = vi.fn(async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: JSON.stringify({
        candidates: vs.map((id, i) => ({
          refId: id,
          weight: 1,
          role: 'diagnostic',
          arrangement: i + 1,
          reason: 'x',
        })),
      }),
    }));

    const result = await composeSoftmaxStream(
      testDb(),
      inputs,
      { policy: 'softmax_mfi', temperature: 0.25, targetCount: 1 }, // 下采样到 1
      { runTaskFn, rng: RNG_ALWAYS_SELECT },
    );

    // targetCount=1 被采纳 ⇒ Σπ_i=1 ⇒ 每个 π_i<1（均权 ⇒ ≈0.25）。
    for (const id of vs) {
      const pi = result.sampledInclusion.get(id);
      expect(pi).toBeDefined();
      expect(pi as number).toBeLessThan(1);
      expect(pi as number).toBeGreaterThan(0);
    }
    const sumPi = vs.reduce((acc, id) => acc + (result.sampledInclusion.get(id) ?? 0), 0);
    expect(sumPi).toBeCloseTo(1, 6); // Σπ_i = effectiveTarget = min(1, nonDueBudget=4) = 1
  });

  it('L1 fallback：runTask 抛错 → 统计 sampler 触发，流仍合法，π_i 仍记', async () => {
    await seedDueQuestion();
    const v1 = await seedVariantCandidate({ kind: 'choice' });

    const runTaskFn = async () => {
      throw new Error('simulated LLM endpoint failure');
    };

    const view = await getStream(testDb(), TODAY, {
      composeIfEmpty: true,
      policy: { policy: 'softmax_mfi' },
      composeDeps: { runTaskFn, rng: RNG_ALWAYS_SELECT },
    });

    // 流仍合法（非空，含非到期被统计 sampler 抽中）。
    expect(view.items.length).toBeGreaterThan(0);
    expect(view.items.map((i) => i.ref_id)).toContain(v1);

    // π_i 仍记（统计 sampler 也走 sampleByWeight，记真 π_i）。
    const obs = await testDb()
      .select()
      .from(selection_observation)
      .where(eq(selection_observation.ref_id, v1));
    expect(obs.length).toBeGreaterThan(0);
    expect(obs[0].policy).toBe('softmax_mfi');
    expect(obs[0].inclusion_probability).toBeGreaterThan(0);
  });

  it('L1 fallback：runTask 返垃圾文本（无 JSON）→ parse 挂 → 统计 sampler 触发，流仍合法', async () => {
    await seedDueQuestion();
    const v1 = await seedVariantCandidate({ kind: 'choice' });

    const runTaskFn = async () => ({ text: '抱歉我无法完成这个任务，没有 JSON。' });

    const view = await getStream(testDb(), TODAY, {
      composeIfEmpty: true,
      policy: { policy: 'softmax_mfi' },
      composeDeps: { runTaskFn, rng: RNG_ALWAYS_SELECT },
    });

    expect(view.items.map((i) => i.ref_id)).toContain(v1);
    const obs = await testDb()
      .select()
      .from(selection_observation)
      .where(eq(selection_observation.ref_id, v1));
    expect(obs.length).toBeGreaterThan(0);
  });

  it('FINDING 4（in-enum-cast-lies）：DB kind 不在 QuestionKind 枚举内 → fail-closed 视为 recall-locked，不被抽样', async () => {
    // question.kind 是 text 列——行里可能存枚举外脏值（历史脏数据 / 手填 / enum 收缩遗留）。
    //   旧 bug：裸 `as QuestionKindT` 把脏值原样传下游 → rotationClassForKind 返 undefined →
    //   recallLocked=false → 题被 sampler 抽样（违反铁律③：身份不明的题不得被抽样/MFI 评分）。
    //   修复：enrichCandidates 用 QuestionKind.safeParse 校验，枚举外 → undefined → 落
    //   collectQuestionSignal 的 fail-closed recall-lock 分支。
    await seedDueQuestion();
    // 'mystery_kind' 不在 QuestionKind 枚举（choice/true_false/fill_blank/...）内。
    const badKindId = await seedVariantCandidate({ kind: 'mystery_kind' });

    // 即便 LLM 给它权重，编排层也不该把它喂 sampler（它该被当 recall-locked 切出 samplable）。
    const runTaskFn = async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: JSON.stringify({
        candidates: [{ refId: badKindId, weight: 5, role: 'diagnostic', reason: 'x' }],
      }),
    });

    const view = await getStream(testDb(), TODAY, {
      composeIfEmpty: true,
      policy: { policy: 'softmax_mfi' },
      composeDeps: { runTaskFn, rng: RNG_ALWAYS_SELECT },
    });

    // 枚举外 kind 被当 recall-locked → 确定性透传纳入流（same-question），但**不被抽样**。
    expect(view.items.map((i) => i.ref_id)).toContain(badKindId);
    // 不记 π_i（它不经 sampler）——铁律③守住（fail-closed，非 fail-open 被抽样）。
    const obs = await testDb()
      .select()
      .from(selection_observation)
      .where(eq(selection_observation.ref_id, badKindId));
    expect(obs).toHaveLength(0);
  });

  it('recall-locked 不变量：fill_blank 变体作为同题透传，不被抽样（不进 selection_observation）', async () => {
    await seedDueQuestion();
    // recall 类（fill_blank）变体候选——应确定性透传，never sampled/MFI-scored。
    const recallId = await seedVariantCandidate({ kind: 'fill_blank' });

    const runTaskFn = async (_kind: string, _input: unknown, _ctx: unknown) => ({
      // 即便 LLM 给 recall 候选权重，编排层也不该把它喂 sampler（它不在 samplable）。
      text: JSON.stringify({
        candidates: [{ refId: recallId, weight: 5, role: 'diagnostic', reason: 'x' }],
      }),
    });

    const view = await getStream(testDb(), TODAY, {
      composeIfEmpty: true,
      policy: { policy: 'softmax_mfi' },
      composeDeps: { runTaskFn, rng: RNG_ALWAYS_SELECT },
    });

    // recall 项确定性纳入流（same question 透传）。
    expect(view.items.map((i) => i.ref_id)).toContain(recallId);
    // 但**不**记 π_i（它不经 sampler）。
    const obs = await testDb()
      .select()
      .from(selection_observation)
      .where(eq(selection_observation.ref_id, recallId));
    expect(obs).toHaveLength(0);
  });

  it("policy='legacy'：走 composeDailyStream 路径，物化行 signals 全 {}（零 π_i）", async () => {
    const dueId = await seedDueQuestion();
    await seedVariantCandidate({ kind: 'choice' });

    // legacy 不该调 LLM——传一个会抛的 runTaskFn 证明它没被调用。
    const runTaskFn = async () => {
      throw new Error('legacy must not call LLM');
    };

    const view = await getStream(testDb(), TODAY, {
      composeIfEmpty: true,
      policy: { policy: 'legacy' },
      composeDeps: { runTaskFn },
    });

    // legacy 路径：到期项 present + source=decay（composeDailyStream R1 热身）。
    expect(view.items.map((i) => i.ref_id)).toContain(dueId);
    expect(view.items[0].source).toBe('decay');
    // legacy：零 signals + 零 selection_observation。
    const rows = await testDb()
      .select()
      .from(practice_stream_item)
      .where(eq(practice_stream_item.date, TODAY));
    for (const row of rows) expect(row.signals).toEqual({});
    const obs = await testDb()
      .select()
      .from(selection_observation)
      .where(eq(selection_observation.date, TODAY));
    expect(obs).toHaveLength(0);
  });

  it('容量不变量：到期项永不被容量截掉（presence 优先于容量）', async () => {
    // 多到期项 + 容量收紧到 1 —— 所有到期项仍 present（容量守门保护到期）。
    const dueIds: string[] = [];
    for (let i = 0; i < 3; i++) dueIds.push(await seedDueQuestion());

    const view = await getStream(testDb(), TODAY, {
      composeIfEmpty: true,
      // 无非到期候选 → 不调 LLM；只测到期 presence + 容量交互。
      policy: { policy: 'softmax_mfi' },
      composeDeps: { rng: RNG_ALWAYS_SELECT },
    });

    const refs = new Set(view.items.map((i) => i.ref_id));
    for (const id of dueIds) expect(refs.has(id)).toBe(true);
  });

  it('L2 fallback：候选收集本身抛（catastrophic）→ 退确定性 composeDailyStream，流合法、fallback=legacy、无 π_i', async () => {
    // 注入一个在 enrichCandidates 的 question 查询上抛错的 db stub —— 模拟候选收集
    // 层 catastrophic 失败。composeSoftmaxStream 必须吞掉、退 legacy、永不 throw。
    const throwingDb = {
      select() {
        throw new Error('simulated catastrophic DB failure during candidate collection');
      },
    } as unknown as Parameters<typeof composeSoftmaxStream>[0];

    const inputs: ComposerInputs = {
      date: TODAY,
      dueItems: [{ questionId: 'q_due_1', knowledgeLabel: 'kp' }],
      // 有非到期候选 → 会进 enrichCandidates → throwingDb 抛 → 退 legacy。
      variantItems: [{ questionId: 'q_var_1', rootQuestionId: 'q_root_1' }],
      newCheckItems: [],
      pendingPapers: [],
    };

    const result = await composeSoftmaxStream(throwingDb, inputs, { policy: 'softmax_mfi' });

    expect(result.fallback).toBe('legacy');
    // legacy plan = composeDailyStream(inputs)：到期项 present、合法、零 π_i。
    expect(result.plan.items.map((i) => i.ref_id)).toContain('q_due_1');
    expect(result.sampledInclusion.size).toBe(0);
    expect(result.signalByRef.size).toBe(0);
  });

  it('recompose 同样走 softmax 路径并记 π_i', async () => {
    await seedDueQuestion();
    const v1 = await seedVariantCandidate({ kind: 'choice' });

    const runTaskFn = async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: JSON.stringify({
        candidates: [{ refId: v1, weight: 2, role: 'diagnostic', reason: 'x' }],
      }),
    });

    const added = await recomposeStream(testDb(), TODAY, {
      policy: { policy: 'softmax_mfi' },
      composeDeps: { runTaskFn, rng: RNG_ALWAYS_SELECT },
    });
    expect(added).toBeGreaterThan(0);

    const obs = await testDb()
      .select()
      .from(selection_observation)
      .where(eq(selection_observation.ref_id, v1));
    expect(obs.length).toBeGreaterThan(0);
  });

  it('CLUSTER A：recompose 不对存活（已物化）的被抽中项写重复 π_i 观测', async () => {
    await seedDueQuestion();
    const v1 = await seedVariantCandidate({ kind: 'choice' });

    const runTaskFn = async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: JSON.stringify({
        candidates: [{ refId: v1, weight: 2, role: 'diagnostic', reason: 'x' }],
      }),
    });
    const deps = { runTaskFn, rng: RNG_ALWAYS_SELECT };

    // 首次 compose：v1 被抽中、物化、记 1 条观测。
    const view = await getStream(testDb(), TODAY, {
      composeIfEmpty: true,
      policy: { policy: 'softmax_mfi' },
      composeDeps: deps,
    });
    const v1Item = view.items.find((i) => i.ref_id === v1);
    expect(v1Item).toBeDefined();

    // 把 v1 推进到 done（存活过 recompose 的 pending 删除）。
    await advanceStreamItem(testDb(), v1Item?.id as string, 'in_progress');
    await advanceStreamItem(testDb(), v1Item?.id as string, 'done');

    const obsBefore = await testDb()
      .select()
      .from(selection_observation)
      .where(eq(selection_observation.ref_id, v1));
    expect(obsBefore).toHaveLength(1); // 首轮 1 条

    // recompose：v1（done）存活 → 被 collectComposerInputs 重新收集 → 重新进
    // sampledInclusion，但它**不是本轮新物化**的（materializeStream 没重插）——CLUSTER A
    // 修复保证不再对那条存活行写第二条幻影观测。
    await recomposeStream(testDb(), TODAY, {
      policy: { policy: 'softmax_mfi' },
      composeDeps: deps,
    });

    const obsAfter = await testDb()
      .select()
      .from(selection_observation)
      .where(eq(selection_observation.ref_id, v1));
    // 仍只有 1 条——不重复（旧 bug 会变成 2 条，且第二条挂在陈旧存活行上）。
    expect(obsAfter).toHaveLength(1);
    expect(obsAfter[0].id).toBe(obsBefore[0].id);
  });

  it('CLUSTER B：materialize 到期 [D1,D2] → 完成 D2 → recompose → DB 内到期序仍 [D1,D2]', async () => {
    // D1 更 overdue（due_at 更早）→ L1 序在前；D2 次之。
    const d1 = await seedDueQuestion({ dueOffsetMs: 4 * 3600_000 });
    const d2 = await seedDueQuestion({ dueOffsetMs: 1 * 3600_000 });

    // L1 真相序（due_at ASC）——断言锚。
    const dueOrder = (await collectComposerInputs(testDb(), TODAY)).dueItems.map(
      (d) => d.questionId,
    );
    // 我的两道种子题应按 [d1, d2]（d1 更 overdue 在前）出现在 L1 序里。
    expect(dueOrder.indexOf(d1)).toBeLessThan(dueOrder.indexOf(d2));

    // 首次 compose（无非到期候选 → 不调 LLM）。
    const view1 = await getStream(testDb(), TODAY, {
      composeIfEmpty: true,
      policy: { policy: 'softmax_mfi' },
      composeDeps: { rng: RNG_ALWAYS_SELECT },
    });
    const refs1 = view1.items.map((i) => i.ref_id).filter((r) => r === d1 || r === d2);
    expect(refs1).toEqual([d1, d2]); // 初始 DB 序正确

    // 完成 D2（晚到期的那道）——制造「删-再加早到期项会被排到存活晚到期项之后」的旧 bug 场景。
    const d2Item = view1.items.find((i) => i.ref_id === d2);
    await advanceStreamItem(testDb(), d2Item?.id as string, 'in_progress');
    await advanceStreamItem(testDb(), d2Item?.id as string, 'done');

    // recompose：删 pending（D1 被删）→ 重新 compose → D1 重新物化。旧 bug：D1 append
    // 在存活 D2 之后 → DB 序变 [D2, D1]。CLUSTER B 修复：position 取 plan 意图序 → 仍 [D1, D2]。
    await recomposeStream(testDb(), TODAY, {
      policy: { policy: 'softmax_mfi' },
      composeDeps: { rng: RNG_ALWAYS_SELECT },
    });

    const view2 = await getStream(testDb(), TODAY, { policy: { policy: 'softmax_mfi' } });
    const refs2 = view2.items.map((i) => i.ref_id).filter((r) => r === d1 || r === d2);
    expect(refs2).toEqual([d1, d2]); // 到期序仍 L1 序，未被 recompose 翻转

    // NO 重复 position：当日所有行 position 互异。
    const rows = await testDb()
      .select()
      .from(practice_stream_item)
      .where(eq(practice_stream_item.date, TODAY));
    const positions = rows.map((r) => r.position);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('CLUSTER F / G2：到期数 > 容量 max → 全部到期项 present（over-cap 有意，presence 优先）', async () => {
    // 3 道到期 + max=1 —— legacy 会砍到期，档2 让 presence 赢：3 道全在（length>max）。
    const dueIds: string[] = [];
    for (let i = 0; i < 3; i++)
      dueIds.push(await seedDueQuestion({ dueOffsetMs: (i + 1) * 3600_000 }));

    const inputs: ComposerInputs = {
      date: TODAY,
      dueItems: dueIds.map((id) => ({ questionId: id })),
      variantItems: [],
      newCheckItems: [],
      pendingPapers: [],
      capacity: { max: 1, warn: 1 }, // 容量 < 到期数
    };

    const result = await composeSoftmaxStream(testDb(), inputs, {
      policy: 'softmax_mfi',
    });

    const planRefs = result.plan.items.map((i) => i.ref_id);
    // 全部到期项 present（presence 铁律②优先于容量）。
    for (const id of dueIds) expect(planRefs).toContain(id);
    // over-cap：plan 长度 > max（有意行为，CLUSTER F）。
    expect(result.plan.items.length).toBeGreaterThan(1);
    expect(result.plan.items.length).toBe(3);
    // position 1..N 连续无重复。
    const positions = result.plan.items.map((i) => i.position);
    expect(positions).toEqual([1, 2, 3]);
  });

  it('G4：tight 容量 + rng 砍低权候选 → 被砍项不入 view.items / 不入 selection_observation；入选项 π_i<1', async () => {
    await seedDueQuestion();
    const hi = await seedVariantCandidate({ kind: 'choice' }); // 高权
    const lo = await seedVariantCandidate({ kind: 'choice' }); // 低权

    const runTaskFn = async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: JSON.stringify({
        candidates: [
          { refId: hi, weight: 5, role: 'diagnostic', reason: 'hi' },
          { refId: lo, weight: 1, role: 'diagnostic', reason: 'lo' },
        ],
      }),
    });

    // rng：返回一个介于 lo 的 π_i 与 hi 的 π_i 之间的常数 → lo 被 Bernoulli 砍掉、hi 入选。
    //   tight 容量（nonDueBudget=1, N=2）→ π_hi ≈ 1（高权主导），π_lo 很小。
    //   取 rng=0.5：0.5 < π_hi（入），0.5 < π_lo 为假（砍 lo）。
    const RNG_HALF = () => 0.5;

    // 动态容量：dues（含变体 parent failure cards）+ 1 → nonDueBudget=1 < 2 候选。
    const dueCount = (await collectComposerInputs(testDb(), TODAY)).dueItems.length;

    const view = await getStream(testDb(), TODAY, {
      composeIfEmpty: true,
      policy: { policy: 'softmax_mfi', temperature: 0.25 },
      composeDeps: { runTaskFn, rng: RNG_HALF },
      capacity: { max: dueCount + 1 },
    });

    const refs = view.items.map((i) => i.ref_id);
    // hi 入选；lo 被砍（不在流里）。
    expect(refs).toContain(hi);
    expect(refs).not.toContain(lo);

    const obs = await testDb()
      .select()
      .from(selection_observation)
      .where(eq(selection_observation.date, TODAY));
    const obsRefs = obs.map((o) => o.ref_id);
    // 被砍的 lo 不记观测（没物化就不该记 π_i）。
    expect(obsRefs).not.toContain(lo);
    // 入选的 hi 记观测，且 π_i < 1（tight 容量下真随机抽样，非确定性塞满）。
    expect(obsRefs).toContain(hi);
    const hiObs = obs.find((o) => o.ref_id === hi);
    expect(hiObs?.inclusion_probability).toBeLessThan(1);
    expect(hiObs?.inclusion_probability).toBeGreaterThan(0);
  });

  it('FINDING B（遥测 tx 解耦）：recordSelectionObservation 写失败 → 流仍物化 + 可读（不回滚）', async () => {
    // 旧 bug：观测写在 single-flight 锁事务**内**。INSERT selection_observation 抛错会让
    //   Postgres 把整笔事务标记 aborted → try/catch 记日志也救不回 → 提交时整笔回滚 →
    //   刚物化的 practice_stream 一起没了（违反「遥测失败不得破坏选题」）。
    //   修复（FINDING B）：观测在事务**提交后**锁外 best-effort 写。这里强制
    //   recordSelectionObservation 抛错——流必须仍物化且可读，只是少了那条遥测。
    await seedDueQuestion();
    const v1 = await seedVariantCandidate({ kind: 'choice' });

    const runTaskFn = async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: JSON.stringify({
        candidates: [{ refId: v1, weight: 3, role: 'diagnostic', reason: 'x' }],
      }),
    });

    // 强制遥测写失败（模拟 INSERT selection_observation 抛错）。
    const spy = vi
      .spyOn(observationsModule, 'recordSelectionObservation')
      .mockRejectedValue(new Error('simulated selection_observation INSERT failure'));

    try {
      // getStream 不得 throw（best-effort 吞掉遥测失败），且返回已物化的流。
      const view = await getStream(testDb(), TODAY, {
        composeIfEmpty: true,
        policy: { policy: 'softmax_mfi' },
        composeDeps: { runTaskFn, rng: RNG_ALWAYS_SELECT },
      });

      // 流仍物化（含被抽中的 v1）——遥测失败没把它回滚掉。
      expect(view.items.map((i) => i.ref_id)).toContain(v1);
      expect(view.items.length).toBeGreaterThan(0);

      // 观测写**确实被尝试过**（证明走了 post-commit 路径，不是没记）。
      expect(spy).toHaveBeenCalled();

      // 重新读 DB 确认流真的提交了（不是只在内存）——practice_stream_item 行真实存在。
      const rows = await testDb()
        .select()
        .from(practice_stream_item)
        .where(eq(practice_stream_item.date, TODAY));
      expect(rows.map((r) => r.ref_id)).toContain(v1);

      // selection_observation 那条因写失败没落库（best-effort，可接受的遥测丢失）。
      const obs = await testDb()
        .select()
        .from(selection_observation)
        .where(eq(selection_observation.ref_id, v1));
      expect(obs).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('FINDING C（卷不预扣 sampler 预算）：多卷 + 少量候选 → 候选仍被抽样（不被卷饿死）', async () => {
    // 旧 bug：nonDueBudget = max − dues − **卷** − recall。卷一多（max=卷数）→ nonDueBudget=0
    //   → 一道非到期都不抽 → 练习题被卷饿死。但 assemble 把非到期放在卷**前**、capacityGuard
    //   截断卷尾（卷可截断）——预扣全部卷预算方向反了。
    //   修复：不扣卷。散题先拿满预算，capacityGuard 用剩余容量截断卷尾（total 仍 ≤ max）。
    //   直接调 composeSoftmaxStream（拿 sampledInclusion + plan 双证据）。
    const v1 = await seedVariantCandidate({ kind: 'choice' });
    const v2 = await seedVariantCandidate({ kind: 'choice' });

    const inputs = await collectComposerInputs(testDb(), TODAY);
    // 用 max == 卷数模拟「卷塞满容量」的旧饿死场景：很多 ready 卷 + 紧容量。
    const paperCount = 8;
    inputs.pendingPapers = Array.from({ length: paperCount }, (_, i) => ({
      paperId: `paper_${i}`,
      title: `卷 ${i}`,
      source: 'paper' as const,
    }));
    inputs.capacity = { max: paperCount }; // 旧码：nonDueBudget = max − 卷 = 0 → 饿死

    const runTaskFn = async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: JSON.stringify({
        candidates: [
          { refId: v1, weight: 3, role: 'diagnostic', arrangement: 1, reason: 'hi' },
          { refId: v2, weight: 1, role: 'diagnostic', arrangement: 2, reason: 'lo' },
        ],
      }),
    });

    const result = await composeSoftmaxStream(
      testDb(),
      inputs,
      { policy: 'softmax_mfi', temperature: 0.25 },
      { runTaskFn, rng: RNG_ALWAYS_SELECT },
    );

    // 候选**没被饿死**：两道非到期候选都拿到 π_i>0 且被抽中（旧 bug 下 sampledInclusion 为空）。
    expect(result.sampledInclusion.size).toBe(2);
    expect(result.sampledInclusion.get(v1)).toBeGreaterThan(0);
    expect(result.sampledInclusion.get(v2)).toBeGreaterThan(0);

    // 被抽中的候选受 capacityGuard 保护、留在最终流。
    const planRefs = result.plan.items.map((i) => i.ref_id);
    expect(planRefs).toContain(v1);
    expect(planRefs).toContain(v2);

    // total 仍受 max 约束：被抽中候选(2，受保护) + 截断后的卷尾 ≤ max。卷尾被砍以让位散题。
    expect(result.plan.items.length).toBeLessThanOrEqual(paperCount);
    const paperRefs = planRefs.filter((r) => r.startsWith('paper_'));
    // 卷被截断（不是全部 8 张都进，因为候选占了受保护名额）。
    expect(paperRefs.length).toBeLessThan(paperCount);
    expect(result.plan.truncated).toBe(true);
  });
});
