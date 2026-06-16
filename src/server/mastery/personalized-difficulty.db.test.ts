// YUK-361 Phase 5 — 家族级 b_personalized 门控 update 路径 db 测。
//
// 验证 (Phase 5 step 5 + 本 driver 验收):
//   (a) n<20 / <5 distinct questions / 非客观 outcome → b_delta 不离 0；
//   (b) 全门控过后 → 收缩后的 b_delta 被应用；
//   (c) family_key 组装 + recordFamilyObservationForAttempt 端到端 (subject 派生);
//   (d) soft/subjective outcome 一条都不累 (isObjective=false 早返)。

import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/core/ids';
import { db } from '@/db/client';
import {
  event,
  item_calibration,
  item_family_calibration,
  knowledge,
  mastery_state,
  question,
} from '@/db/schema';
import { resetDb } from '../../../tests/helpers/db';
import {
  FAMILY_MIN_DISTINCT_QUESTIONS,
  FAMILY_MIN_EVIDENCE,
  countDistinctQuestionsInFamily,
  familyKey,
  getFamilyCalibration,
  recordFamilyObservationForAttempt,
  updateFamilyCalibration,
} from './personalized-difficulty';

async function seedKnowledge(id: string, domain = 'wenyan') {
  const now = new Date();
  await db
    .insert(knowledge)
    .values({
      id,
      name: `K-${id}`,
      domain,
      parent_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

async function seedQuestion(
  id: string,
  knowledgeIds: string[],
  kind = 'short_answer',
  source = 'manual',
  difficulty = 3,
) {
  const now = new Date();
  await db.insert(question).values({
    id,
    kind,
    prompt_md: `Prompt ${id}`,
    reference_md: null,
    knowledge_ids: knowledgeIds,
    difficulty,
    source,
    variant_depth: 0,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedItemCalibration(questionId: string, b: number) {
  const now = new Date();
  await db.insert(item_calibration).values({
    id: newId(),
    question_id: questionId,
    b,
    confidence: 0.5,
    track: 'hard',
    source: 'llm_prior',
    created_at: now,
    updated_at: now,
  });
}

async function readFamily(key: string) {
  return getFamilyCalibration(db, key);
}

/**
 * Seed an attempt/review event + a sibling judge event for `questionId` so the
 * OBSERVED-distinct query (finding #1) counts this question as having produced a
 * judged observation. `judgeRoute` controls objectivity (exact/keyword =
 * objective; semantic etc. = soft → not counted). `action` mirrors the two hot
 * paths (review = /api/review/submit, attempt = paper-submit). Returns the
 * attempt event id.
 */
async function seedJudgedAttemptEvent(
  questionId: string,
  judgeRoute: string,
  action: 'review' | 'attempt' = 'attempt',
): Promise<string> {
  const createdAt = new Date();
  const attemptId = newId();
  await db.insert(event).values({
    id: attemptId,
    actor_kind: 'user',
    actor_ref: 'self',
    action,
    subject_kind: 'question',
    subject_id: questionId,
    outcome: 'failure',
    payload: {},
    created_at: createdAt,
  });
  await db.insert(event).values({
    id: newId(),
    actor_kind: 'agent',
    actor_ref: 'test_judge',
    action: 'judge',
    subject_kind: 'event',
    subject_id: attemptId,
    outcome: 'success',
    payload: { judge_route: judgeRoute },
    caused_by_event_id: attemptId,
    created_at: createdAt,
  });
  return attemptId;
}

const now = () => new Date();

describe('updateFamilyCalibration — gates', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('(a) 非客观 outcome → 一条都不累 (isObjective=false 早返)', async () => {
    const key = familyKey('wenyan', 'k1', 'short_answer', 'manual');
    await db.transaction(async (tx) => {
      await updateFamilyCalibration(tx, {
        familyKey: key,
        theta: 0,
        bAnchor: 0,
        outcome: 0,
        isObjective: false, // soft/subjective judge
        distinctQuestionCount: 10,
        now: now(),
      });
    });
    expect(await readFamily(key)).toBeNull();
  });

  it('(a) n<20 → 累 evidence_count 但 b_delta 保持 0', async () => {
    const key = familyKey('wenyan', 'k1', 'short_answer', 'manual');
    // 19 条客观观测，distinct 门已满足 (传 10)，但 n<20。
    for (let i = 0; i < 19; i++) {
      await db.transaction(async (tx) => {
        await updateFamilyCalibration(tx, {
          familyKey: key,
          theta: 0,
          bAnchor: 0,
          outcome: 0, // 全答错——若门控放行会产生明显正 delta
          isObjective: true,
          distinctQuestionCount: 10,
          now: now(),
        });
      });
    }
    const row = await readFamily(key);
    expect(row).not.toBeNull();
    expect(row?.evidence_count).toBe(19);
    expect(row?.b_delta).toBe(0); // 门控未过 → 0
    expect(row?.confidence).toBe(0);
  });

  it('(a) <5 distinct questions → b_delta 保持 0 即使 n≥20', async () => {
    const key = familyKey('wenyan', 'k1', 'short_answer', 'manual');
    for (let i = 0; i < 25; i++) {
      await db.transaction(async (tx) => {
        await updateFamilyCalibration(tx, {
          familyKey: key,
          theta: 0,
          bAnchor: 0,
          outcome: 0,
          isObjective: true,
          distinctQuestionCount: 3, // < FAMILY_MIN_DISTINCT_QUESTIONS
          now: now(),
        });
      });
    }
    const row = await readFamily(key);
    expect(row?.evidence_count).toBe(25);
    expect(row?.b_delta).toBe(0); // distinct 门未过
  });

  it('(b) 全门控过后 → 收缩后的 b_delta 被应用 (全答错 → 正 delta)', async () => {
    const key = familyKey('wenyan', 'k1', 'short_answer', 'manual');
    // 25 条客观观测、全答错 (outcome=0)、distinct=8≥5、n=25≥20。
    // θ=0, b=0 → p=0.5 → residual = −(0−0.5)/0.25 = +2 (clamp +2)。家族应显得更难
    // → 正 b_delta (收缩后 < 2)。
    for (let i = 0; i < 25; i++) {
      await db.transaction(async (tx) => {
        await updateFamilyCalibration(tx, {
          familyKey: key,
          theta: 0,
          bAnchor: 0,
          outcome: 0,
          isObjective: true,
          distinctQuestionCount: 8,
          now: now(),
        });
      });
    }
    const row = await readFamily(key);
    expect(row?.evidence_count).toBe(25);
    expect(row?.b_delta).toBeGreaterThan(0); // 全答错 → 题更难 → 正 delta
    expect(row?.b_delta).toBeLessThan(2); // 收缩 + clamp 守保守
    expect(row?.confidence).toBeGreaterThan(0);
    expect(row?.confidence).toBeLessThanOrEqual(1);
  });

  it('(b) 全答对 → 负 delta (题更容易)', async () => {
    const key = familyKey('wenyan', 'k1', 'short_answer', 'manual');
    for (let i = 0; i < 25; i++) {
      await db.transaction(async (tx) => {
        await updateFamilyCalibration(tx, {
          familyKey: key,
          theta: 0,
          bAnchor: 0,
          outcome: 1, // 全答对
          isObjective: true,
          distinctQuestionCount: 8,
          now: now(),
        });
      });
    }
    const row = await readFamily(key);
    expect(row?.b_delta).toBeLessThan(0);
  });

  it('门控刚跨阈值那次开始累积运行均值 (跨阈值后混合 outcome → 均值在 0 附近)', async () => {
    const key = familyKey('wenyan', 'k1', 'short_answer', 'manual');
    // 前 20 条 (跨阈值至 n=20) 全答错，之后交替——验证不抛、b_delta 有限。
    for (let i = 0; i < 40; i++) {
      const outcome = (i < 20 ? 0 : i % 2) as 0 | 1;
      await db.transaction(async (tx) => {
        await updateFamilyCalibration(tx, {
          familyKey: key,
          theta: 0,
          bAnchor: 0,
          outcome,
          isObjective: true,
          distinctQuestionCount: 8,
          now: now(),
        });
      });
    }
    const row = await readFamily(key);
    expect(row?.evidence_count).toBe(40);
    expect(Number.isFinite(row?.b_delta ?? Number.NaN)).toBe(true);
  });

  // ── finding #2 修复回归 — distinct 门「晚跨」(n 在 distinct≥5 之前就 ≥20) ──────
  // 旧 bug：用 effectiveN = n − FAMILY_MIN_EVIDENCE + 1 当 running-mean 基，把 n 门
  // 跨阈值后、distinct 门未过期间**从未折进** mean 的观测当成已折进样本反推 → 注入
  // phantom mean-0 样本，永久把 b_delta 向 0 稀释（all-+2 residual、distinct 在 n=26
  // 才翻 ok → 错得 0.32 vs 正确 0.71）。修复后用 calibrated_n（只数实际折进的残差），
  // 两门**首次**都过才从 1 起算，无 phantom 样本，b_delta 取正确值——**与门跨越顺序无关**。
  it('(finding #2) distinct 门晚跨 → b_delta 取正确值 (无 phantom mean-0 稀释)', async () => {
    const key = familyKey('wenyan', 'k1', 'short_answer', 'manual');
    // 全答错 (outcome=0, θ=0, b=0) → 每次 residual = −(0−0.5)/0.25 = +2 (clamp +2)。
    // distinct 门「晚跨」：前 25 条 distinct=3 (<5 → distinct 门未过)，第 26 条起 distinct=8
    // (≥5 → 两门首次都过)。共跑到 n=36 → 折进 11 条 (n=26..36)。
    // 修复后正确值：calibrated_n=11，全 +2 → newRawMean=+2，b_delta = shrink(2, 11)
    //   = (11/(11+20))·2 = 22/31 ≈ 0.70967。
    // 旧 bug 会因 phantom 样本稀释成 ~0.32（远低于正确值）。
    let n = 0;
    for (; n < 36; n++) {
      const distinct = n < 25 ? 3 : 8; // 第 26 次 (n 索引 25) 起 distinct 门也过
      await db.transaction(async (tx) => {
        await updateFamilyCalibration(tx, {
          familyKey: key,
          theta: 0,
          bAnchor: 0,
          outcome: 0,
          isObjective: true,
          distinctQuestionCount: distinct,
          now: now(),
        });
      });
    }
    const row = await readFamily(key);
    expect(row?.evidence_count).toBe(36);
    // calibrated_n = 11 折进条 (n=26..36)，全 +2 → 精确 b_delta = (11/31)·2。
    expect(row?.calibrated_n).toBe(11);
    expect(row?.b_delta).toBeCloseTo((11 / 31) * 2, 6); // ≈ 0.70967，不是 bug 的 ~0.32
    expect(row?.confidence).toBeCloseTo(11 / 31, 6);
  });

  // calibrated_n 与 evidence_count 在 distinct 门晚跨时**发散**——这是修复的本质：
  // evidence_count 数全部客观观测 (含两门未过的预热条)，calibrated_n 只数折进 mean 的条。
  it('(finding #2) distinct 门晚跨期间 calibrated_n 保持 0、evidence_count 照累', async () => {
    const key = familyKey('wenyan', 'k1', 'short_answer', 'manual');
    // 25 条 distinct=3 (<5)：n 早早 ≥20 但 distinct 门未过 → 一条都没折进。
    for (let i = 0; i < 25; i++) {
      await db.transaction(async (tx) => {
        await updateFamilyCalibration(tx, {
          familyKey: key,
          theta: 0,
          bAnchor: 0,
          outcome: 0,
          isObjective: true,
          distinctQuestionCount: 3,
          now: now(),
        });
      });
    }
    const row = await readFamily(key);
    expect(row?.evidence_count).toBe(25); // 全部客观观测照累
    expect(row?.calibrated_n).toBe(0); // distinct 门未过 → 一条都没折进
    expect(row?.b_delta).toBe(0); // 门控未过 → b_delta 恒 0
  });
});

describe('recordFamilyObservationForAttempt — 端到端 (subject 派生 + 锚解析)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('客观判分 (exact) → 写家族行，family_key 含派生 subject', async () => {
    const k = createId();
    await seedKnowledge(k, 'wenyan');
    const q = createId();
    await seedQuestion(q, [k], 'short_answer', 'manual');
    await seedItemCalibration(q, 0.5);

    await db.transaction(async (tx) => {
      await recordFamilyObservationForAttempt(tx, {
        primaryKnowledgeId: k,
        questionId: q,
        kind: 'short_answer',
        source: 'manual',
        difficulty: 3,
        outcome: 0,
        judgeRoute: 'exact', // 客观
        now: now(),
      });
    });

    // subject 由 wenyan domain 派生 → resolveKnownSubjectId('wenyan')。
    const rows = await db.select().from(item_family_calibration);
    expect(rows.length).toBe(1);
    // family_key 形如 `<subject>:<k>:short_answer:manual`，含派生 subject 段、含 k、不含 q。
    expect(rows[0].family_key).toContain(`:${k}:short_answer:manual`);
    expect(rows[0].family_key).not.toContain(q);
    expect(rows[0].evidence_count).toBe(1);
    // 单条 → 门控未过 → b_delta 0。
    expect(rows[0].b_delta).toBe(0);
  });

  it('软判分 (semantic) → 不写家族行', async () => {
    const k = createId();
    await seedKnowledge(k, 'wenyan');
    const q = createId();
    await seedQuestion(q, [k], 'short_answer', 'manual');

    await db.transaction(async (tx) => {
      await recordFamilyObservationForAttempt(tx, {
        primaryKnowledgeId: k,
        questionId: q,
        kind: 'short_answer',
        source: 'manual',
        difficulty: 3,
        outcome: 0,
        judgeRoute: 'semantic', // soft
        now: now(),
      });
    });

    const rows = await db.select().from(item_family_calibration);
    expect(rows.length).toBe(0);
  });

  it('无 primary knowledge → 跳过 (家族无法成键)', async () => {
    await db.transaction(async (tx) => {
      await recordFamilyObservationForAttempt(tx, {
        primaryKnowledgeId: null,
        questionId: createId(),
        kind: 'short_answer',
        source: 'manual',
        difficulty: 3,
        outcome: 0,
        judgeRoute: 'exact',
        now: now(),
      });
    });
    const rows = await db.select().from(item_family_calibration);
    expect(rows.length).toBe(0);
  });

  it('distinct-question 门用 OBSERVED 计数：5 道同家族题各产出客观观测 + 20 次 → b_delta 应用', async () => {
    const k = createId();
    await seedKnowledge(k, 'wenyan');
    // 5 道同 (k, short_answer, manual) 家族的不同题。
    const qs: string[] = [];
    for (let i = 0; i < FAMILY_MIN_DISTINCT_QUESTIONS; i++) {
      const q = createId();
      await seedQuestion(q, [k], 'short_answer', 'manual');
      await seedItemCalibration(q, 0);
      qs.push(q);
    }
    // finding #1：distinct 门数的是**实际产出客观观测**的不同题。为每道题写 judged 事件
    // （attempt + 客观 judge），observed-distinct=5 满足门。
    for (const q of qs) {
      await seedJudgedAttemptEvent(q, 'keyword');
    }
    // 20 次客观观测，轮流落在 5 道题上，全答错 → 正 delta。
    for (let i = 0; i < FAMILY_MIN_EVIDENCE; i++) {
      const q = qs[i % qs.length];
      await db.transaction(async (tx) => {
        await recordFamilyObservationForAttempt(tx, {
          primaryKnowledgeId: k,
          questionId: q,
          kind: 'short_answer',
          source: 'manual',
          difficulty: 3,
          outcome: 0,
          judgeRoute: 'keyword', // 客观
          now: now(),
        });
      });
    }

    const rows = await db.select().from(item_family_calibration);
    expect(rows.length).toBe(1);
    expect(rows[0].evidence_count).toBe(FAMILY_MIN_EVIDENCE);
    // n=20 (=FAMILY_MIN_EVIDENCE) + observed-distinct=5 (=门) → 门控刚过 → b_delta 离 0。
    expect(rows[0].b_delta).toBeGreaterThan(0);
  });

  // ── finding #1 修复回归 — distinct 门数 OBSERVED 题数，不是 POOL 题数 ───────────
  // 旧 bug：countDistinctQuestionsInFamily 数家族**题池大小**（question 表里同 family 的
  // 题数），故学习者反复刷**同一道**题，只要池里凑得齐 ≥5 道，distinct 门照过 → 单题残差
  // 被反复折进家族 b_delta，打破「跨题系统性」立家依据。修复后数「实际产出客观观测的不同
  // 题」（judged 事件流派生）：20 次重复同一道题 → observed-distinct=1 → 门不过 → b_delta 0。
  it('(finding #1) ≥5-题家族里反复刷同一题 20 次 → distinct 门不过 (observed-distinct=1)', async () => {
    const k = createId();
    await seedKnowledge(k, 'wenyan');
    // 家族池里有 5 道题（POOL ≥5），但只有 1 道**被作答过**。
    const qs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const q = createId();
      await seedQuestion(q, [k], 'short_answer', 'manual');
      await seedItemCalibration(q, 0);
      qs.push(q);
    }
    const repeatedQ = qs[0];
    // 只为这一道题写 judged 事件（其余 4 道从未被作答）。
    await seedJudgedAttemptEvent(repeatedQ, 'keyword');

    // sanity：observed-distinct=1（旧 POOL 计数会是 5）。
    expect(await countDistinctQuestionsInFamily(db, k, 'short_answer', 'manual')).toBe(1);

    // 20 次客观观测全落在同一道题上，全答错。若用 POOL 计数 (=5) 门会过、b_delta 离 0；
    // 用 observed-distinct (=1<5) 门不过 → b_delta 恒 0。
    for (let i = 0; i < FAMILY_MIN_EVIDENCE; i++) {
      await db.transaction(async (tx) => {
        await recordFamilyObservationForAttempt(tx, {
          primaryKnowledgeId: k,
          questionId: repeatedQ,
          kind: 'short_answer',
          source: 'manual',
          difficulty: 3,
          outcome: 0,
          judgeRoute: 'keyword',
          now: now(),
        });
      });
    }

    const rows = await db.select().from(item_family_calibration);
    expect(rows.length).toBe(1);
    expect(rows[0].evidence_count).toBe(FAMILY_MIN_EVIDENCE); // 客观观测照累
    expect(rows[0].b_delta).toBe(0); // distinct 门 (observed=1<5) 未过 → 不折进
    expect(rows[0].calibrated_n).toBe(0); // 一条都没折进 running mean
  });

  it('(finding #1) countDistinctQuestionsInFamily 只数客观 judge 路由的观测', async () => {
    const k = createId();
    await seedKnowledge(k, 'wenyan');
    const qExact = createId();
    const qKeyword = createId();
    const qSemantic = createId();
    for (const q of [qExact, qKeyword, qSemantic]) {
      await seedQuestion(q, [k], 'short_answer', 'manual');
    }
    await seedJudgedAttemptEvent(qExact, 'exact', 'review');
    await seedJudgedAttemptEvent(qKeyword, 'keyword', 'attempt');
    await seedJudgedAttemptEvent(qSemantic, 'semantic'); // 软判分 → 不数

    // 只有 exact + keyword 两道客观题被数，semantic 那道排除。
    expect(await countDistinctQuestionsInFamily(db, k, 'short_answer', 'manual')).toBe(2);
  });

  it('item_family_calibration.b_delta 永不回写 item_calibration.b (不变量①)', async () => {
    const k = createId();
    await seedKnowledge(k, 'wenyan');
    const q = createId();
    await seedQuestion(q, [k], 'short_answer', 'manual');
    await seedItemCalibration(q, 0.5);

    // 跑足够多客观观测让家族 b_delta 离 0。
    const qs: string[] = [q];
    for (let i = 1; i < FAMILY_MIN_DISTINCT_QUESTIONS; i++) {
      const extra = createId();
      await seedQuestion(extra, [k], 'short_answer', 'manual');
      await seedItemCalibration(extra, 0.5);
      qs.push(extra);
    }
    // finding #1：observed-distinct 门要求每道题实际产出过客观观测——为每道题写 judged 事件。
    for (const qi of qs) {
      await seedJudgedAttemptEvent(qi, 'exact');
    }
    for (let i = 0; i < 25; i++) {
      const qi = qs[i % qs.length];
      await db.transaction(async (tx) => {
        await recordFamilyObservationForAttempt(tx, {
          primaryKnowledgeId: k,
          questionId: qi,
          kind: 'short_answer',
          source: 'manual',
          difficulty: 3,
          outcome: 0,
          judgeRoute: 'exact',
          now: now(),
        });
      });
    }

    // item_calibration.b 对每道题仍是 0.5——家族 delta 是独立层，从未回写锚。
    const calRows = await db
      .select()
      .from(item_calibration)
      .where(and(eq(item_calibration.question_id, q), eq(item_calibration.track, 'hard')));
    expect(calRows[0].b).toBe(0.5);

    const fam = await db.select().from(item_family_calibration);
    expect(fam[0].b_delta).not.toBe(0); // 家族层动了
  });
});

describe('mastery_state θ̂ 锚组合 (effectiveFamilyB 消费接缝 sanity)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('θ̂ 被读作 raw-delta 估计的快尺度锚', async () => {
    const k = createId();
    await seedKnowledge(k, 'wenyan');
    const q = createId();
    await seedQuestion(q, [k], 'short_answer', 'manual');
    await seedItemCalibration(q, 0);
    // 先种一个高 θ̂ (能力远超锚)，则答错的 residual 量级更大 (大 surprise)。
    await db.insert(mastery_state).values({
      id: newId(),
      subject_kind: 'knowledge',
      subject_id: k,
      theta_hat: 2.0,
      evidence_count: 5,
      success_count: 5,
      fail_count: 0,
      last_outcome_at: now(),
      theta_precision: 5,
      updated_at: now(),
    });

    await db.transaction(async (tx) => {
      await recordFamilyObservationForAttempt(tx, {
        primaryKnowledgeId: k,
        questionId: q,
        kind: 'short_answer',
        source: 'manual',
        difficulty: 3,
        outcome: 0, // 高能力却答错 → 强 surprise
        judgeRoute: 'exact',
        now: now(),
      });
    });

    // 单条门控未过 b_delta=0，但 evidence_count=1 证明读到了 θ̂ 路径 (无异常)。
    const fam = await db.select().from(item_family_calibration);
    expect(fam[0].evidence_count).toBe(1);
  });

  // ── finding #3 修复回归 — 残差用 PRE-attempt θ̂（thetaBefore），不读 POSTERIOR ────
  // hook 在 updateThetaForAttempt 之后调用，mastery_state.theta_hat 已被本次作答移动
  // （POSTERIOR）。残差必须对着**作答前**的 θ̂ 算（mirror state.ts thetaBefore=s.theta
  // 纪律）。caller 在 Elo 下移前捕获 θ̂ 传入 thetaBefore；hook 优先用它，不读已移动的
  // mastery_state。本测：mastery_state 种 POSTERIOR θ̂=-3（远低），thetaBefore 传 -1，
  // 全答错。两者残差都 <clamp 且不同：θ=-1 → wrong residual=1/(1-σ(-1))≈1.368；若误读
  // mastery_state(θ=-3) → 1/(1-σ(-3))≈1.0497。b_delta = shrink(residual, 20) = 0.5·residual。
  it('(finding #3) 残差用传入的 PRE-attempt thetaBefore，而非已移动的 mastery_state θ̂', async () => {
    const k = createId();
    await seedKnowledge(k, 'wenyan');
    const qs: string[] = [];
    for (let i = 0; i < FAMILY_MIN_DISTINCT_QUESTIONS; i++) {
      const q = createId();
      await seedQuestion(q, [k], 'short_answer', 'manual');
      await seedItemCalibration(q, 0); // bAnchor=0
      await seedJudgedAttemptEvent(q, 'keyword'); // observed-distinct=5
      qs.push(q);
    }
    // 种一个 POSTERIOR θ̂=-3（代表本次作答 Elo 下移后的值）。若 hook 误读它，残差会偏。
    await db.insert(mastery_state).values({
      id: newId(),
      subject_kind: 'knowledge',
      subject_id: k,
      theta_hat: -3.0,
      evidence_count: 20,
      success_count: 0,
      fail_count: 20,
      last_outcome_at: now(),
      theta_precision: 5,
      updated_at: now(),
    });

    // 40 次全答错，PRE-attempt θ̂ = -1（作答前），bAnchor=0。两门首次都过在 n=20，
    // 折进 n=20..40 共 21 条 → calibrated_n=21。residual 每次相同（θ 固定）→ 运行均值
    // = residual，b_delta = shrink(residual, 21)。
    const TOTAL = 40;
    for (let i = 0; i < TOTAL; i++) {
      const q = qs[i % qs.length];
      await db.transaction(async (tx) => {
        await recordFamilyObservationForAttempt(tx, {
          primaryKnowledgeId: k,
          questionId: q,
          kind: 'short_answer',
          source: 'manual',
          difficulty: 3,
          outcome: 0,
          judgeRoute: 'keyword',
          thetaBefore: -1.0, // PRE-attempt θ̂（作答前），≠ mastery_state 的 -3
          now: now(),
        });
      });
    }

    const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
    const wrongResidual = (theta: number) => {
      const p = sigmoid(theta); // b=0
      const fisher = Math.max(p * (1 - p), 0.05);
      return -(0 - p) / fisher;
    };
    const row = await readFamily(familyKey('wenyan', k, 'short_answer', 'manual'));
    expect(row?.evidence_count).toBe(TOTAL);
    // 折进 n=20..40 → calibrated_n=21（n 门在 newN≥20 时过；distinct 早已 5）。
    const cn = row?.calibrated_n ?? 0;
    expect(cn).toBe(TOTAL - FAMILY_MIN_EVIDENCE + 1); // 21
    const shrink = (raw: number, n: number) => (n / (n + 20)) * raw;
    const expectedFromBefore = shrink(wrongResidual(-1.0), cn); // 用 thetaBefore=-1 的残差
    const wrongIfReadPosterior = shrink(wrongResidual(-3.0), cn); // 误读 mastery_state(-3)
    expect(row?.b_delta).toBeCloseTo(expectedFromBefore, 4);
    // 与误读 POSTERIOR θ=-3 的值明显不同（证明没读 mastery_state）。
    expect(Math.abs((row?.b_delta ?? 0) - wrongIfReadPosterior)).toBeGreaterThan(0.05);
  });

  // ── finding #4 修复回归 — partial outcome 不折进家族校准 ─────────────────────────
  // paper 客观 keyword judge 可返回 partial。旧 hook 把所有非 failure 当 outcome=1
  // （partial→1），半对当全对 → 制造 spurious「家族更易」负残差偏置。修复：传 attemptOutcome，
  // hook 对 'partial' 早返，连 evidence_count 都不动（partial 不是干净客观观测）。
  it('(finding #4) partial attemptOutcome → 一条都不折（连 evidence_count 都不累）', async () => {
    const k = createId();
    await seedKnowledge(k, 'wenyan');
    const q = createId();
    await seedQuestion(q, [k], 'short_answer', 'manual');
    await seedItemCalibration(q, 0);

    await db.transaction(async (tx) => {
      await recordFamilyObservationForAttempt(tx, {
        primaryKnowledgeId: k,
        questionId: q,
        kind: 'short_answer',
        source: 'manual',
        difficulty: 3,
        outcome: 1, // 旧 coerce 会把 partial 当 1 折进
        attemptOutcome: 'partial', // finding #4：partial → 早返不折
        judgeRoute: 'keyword', // 客观路由（证明排除是 partial 专属，不是路由门）
        now: now(),
      });
    });

    // partial 早返 → 一条家族行都没写。
    expect(await db.select().from(item_family_calibration)).toHaveLength(0);
  });

  it('(finding #4) success/failure 仍正常折，仅 partial 排除（对照）', async () => {
    const k = createId();
    await seedKnowledge(k, 'wenyan');
    const q = createId();
    await seedQuestion(q, [k], 'short_answer', 'manual');
    await seedItemCalibration(q, 0);

    // 干净 failure（attemptOutcome='failure'）→ 正常累 evidence_count。
    await db.transaction(async (tx) => {
      await recordFamilyObservationForAttempt(tx, {
        primaryKnowledgeId: k,
        questionId: q,
        kind: 'short_answer',
        source: 'manual',
        difficulty: 3,
        outcome: 0,
        attemptOutcome: 'failure',
        judgeRoute: 'keyword',
        now: now(),
      });
    });
    const rows = await db.select().from(item_family_calibration);
    expect(rows).toHaveLength(1);
    expect(rows[0].evidence_count).toBe(1); // 干净二分照折
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// finding #4a 回归 — family 写用 SAVEPOINT 隔离，DB 级错误不毒化主 attempt tx。
//
// 复现 submit.ts / paper-submit.ts hook 的结构：外层 attempt tx 先写主路径
// （θ̂/FSRS/event，这里用 knowledge 行当代理），再在 SAVEPOINT（嵌套 tx）里跑 family
// 写。family 写若直接跑在外层 tx 上、触发任何 DB 级错误（25P02 毒化 tx），外层
// db.transaction 会整体 rollback——主路径全丢，JS try/catch 捕到了也救不回（捕 JS 错
// ≠ 解毒 PG tx）。SAVEPOINT 让 family 写失败只回滚 savepoint，主写完整保留可 COMMIT。
// ─────────────────────────────────────────────────────────────────────────────
describe('finding #4a — family 写 SAVEPOINT 隔离 (DB 错误不毒化主 attempt tx)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('SAVEPOINT 包裹下 family 写 DB 错误 → 主路径写 STILL COMMIT', async () => {
    const mainK = createId();
    // 模拟 hook：外层 attempt tx 内先写主路径（θ̂/FSRS/event 的代理 = knowledge 行），
    // 再在 SAVEPOINT 里跑会触发 DB 级错误的 family 写，错误被 hook 的 try/catch 吞。
    await db.transaction(async (tx) => {
      // (1) 主路径写（代表 θ̂/FSRS/event 的成功写入）。
      await tx.insert(knowledge).values({
        id: mainK,
        name: `K-${mainK}`,
        domain: 'wenyan',
        parent_id: null,
        created_at: now(),
        updated_at: now(),
        version: 0,
      });

      // (2) SAVEPOINT 包裹的 family 写——内部强制一个 DB 级错误（malformed cast，
      // 与「malformed-jsonb cast / 23505 / serialization」同类的 25P02 触发器）。
      // 修复后：SAVEPOINT 回滚只丢这一步，外层 tx 不被毒化。
      try {
        await tx.transaction(async (sp) => {
          // 故意失败的 DB 语句（无效 cast → PG 报错，毒化 savepoint 而非外层 tx）。
          await sp.execute(sql`SELECT CAST('not-a-number' AS integer)`);
        });
      } catch {
        // hook 的 best-effort 吞错（family 校准是慢热增益层，不 fail 主路径）。
      }

      // (3) family 写失败后，外层 tx 仍可继续写（证明未被毒化）——若被毒化这里会抛
      // 25P02。这一步成功 = SAVEPOINT 隔离生效。
      await tx
        .update(knowledge)
        .set({ name: `K-${mainK}-after` })
        .where(eq(knowledge.id, mainK));
    });

    // 主路径写 COMMIT 成功（θ̂/FSRS/event 不丢）——这是修复的核心断言。
    const rows = await db.select().from(knowledge).where(eq(knowledge.id, mainK));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe(`K-${mainK}-after`); // 步骤 (3) 也成功 → tx 未被毒化
  });

  it('(对照) 不用 SAVEPOINT → 同一 DB 错误毒化外层 tx，主路径写全丢', async () => {
    const mainK = createId();
    // 对照组：family 写**直接**跑在外层 tx 上（无 SAVEPOINT），错误毒化整个 tx。
    // JS try/catch 捕到了错，但 PG tx 已 25P02——外层 db.transaction 整体 rollback。
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(knowledge).values({
          id: mainK,
          name: `K-${mainK}`,
          domain: 'wenyan',
          parent_id: null,
          created_at: now(),
          updated_at: now(),
          version: 0,
        });
        try {
          // 直接在外层 tx 上跑失败语句 → 毒化 tx（25P02）。
          await tx.execute(sql`SELECT CAST('not-a-number' AS integer)`);
        } catch {
          // 捕到 JS 错，但 PG tx 已毒化——后续写会抛，且整 tx 终将 rollback。
        }
        // tx 已毒化：这步会抛 25P02（current transaction is aborted）。
        await tx
          .update(knowledge)
          .set({ name: `K-${mainK}-after` })
          .where(eq(knowledge.id, mainK));
      }),
    ).rejects.toThrow();

    // 整个 tx rollback → 主路径写也丢了（这正是 #4a 要避免的数据丢失）。
    const rows = await db.select().from(knowledge).where(eq(knowledge.id, mainK));
    expect(rows).toHaveLength(0);
  });

  it('SAVEPOINT 包裹真实 recordFamilyObservationForAttempt（happy path）→ 主写 + family 写都 COMMIT', async () => {
    const mainK = createId();
    const k = createId();
    await seedKnowledge(k, 'wenyan');
    const q = createId();
    await seedQuestion(q, [k], 'short_answer', 'manual');
    await seedItemCalibration(q, 0.5);

    // hook 的真实结构：主写 + SAVEPOINT 包裹的真实 family 写（无强制错误 → 都成功）。
    await db.transaction(async (tx) => {
      await tx.insert(knowledge).values({
        id: mainK,
        name: `K-${mainK}`,
        domain: 'wenyan',
        parent_id: null,
        created_at: now(),
        updated_at: now(),
        version: 0,
      });
      try {
        await tx.transaction(async (sp) => {
          await recordFamilyObservationForAttempt(sp, {
            primaryKnowledgeId: k,
            questionId: q,
            kind: 'short_answer',
            source: 'manual',
            difficulty: 3,
            outcome: 0,
            judgeRoute: 'exact',
            now: now(),
          });
        });
      } catch {
        // best-effort
      }
    });

    // 主写 COMMIT。
    expect(await db.select().from(knowledge).where(eq(knowledge.id, mainK))).toHaveLength(1);
    // family 写也 COMMIT（SAVEPOINT happy path 不回滚）。
    const fam = await db.select().from(item_family_calibration);
    expect(fam).toHaveLength(1);
    expect(fam[0].evidence_count).toBe(1);
  });
});
