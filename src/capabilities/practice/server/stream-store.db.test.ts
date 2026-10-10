// YUK-361 Phase 4 (Task 9) — hybrid 运行时 store 层行为：夜间预产 composeNightly 幂等 +
// 作答后有界增量重排 reRankAfterAnswer 的不变量（②③④ + positivity）。
//
// LLM **永不命中 live endpoint**——全程注入 mock runTaskFn（composeDeps.runTaskFn）。
// 增量重排走纯统计 sampler（不调 LLM），rng 注入 seeded 确定化 Poisson 抽样。

import { createId } from '@paralleldrive/cuid2';
import { and, asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
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
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { composeNightly, getStream, reRankAfterAnswer, streamLocalDate } from './stream-store';

const TODAY = streamLocalDate();

// rng：< 1 全选（Poisson Bernoulli 必入，配合 π_i>0）；== 1 全不选。
const RNG_ALWAYS_SELECT = () => 0;

async function insertQuestion(opts: {
  id?: string;
  kind?: string;
  knowledgeIds?: string[];
  difficulty?: number;
  /** YUK-350 draft 排除回归：传 'draft' 模拟 container-only（embedded/teaching）题。 */
  draftStatus?: string | null;
  source?: string;
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
      source: opts.source ?? 'manual',
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

async function seedDueQuestion(
  opts: { dueOffsetMs?: number; source?: string } = {},
): Promise<string> {
  const qid = await insertQuestion({ kind: 'choice', source: opts.source });
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
    actor_ref: 'self',
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

describe('Task 9 夜间预产 composeNightly（YUK-361 Phase 4）', () => {
  beforeEach(async () => {
    await resetDb();
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
});
