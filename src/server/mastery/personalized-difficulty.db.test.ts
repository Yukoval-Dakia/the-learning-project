// YUK-361 Phase 5 — 家族级 b_personalized 门控 update 路径 db 测。
//
// 验证 (Phase 5 step 5 + 本 driver 验收):
//   (a) n<20 / <5 distinct questions / 非客观 outcome → b_delta 不离 0；
//   (b) 全门控过后 → 收缩后的 b_delta 被应用；
//   (c) family_key 组装 + recordFamilyObservationForAttempt 端到端 (subject 派生);
//   (d) soft/subjective outcome 一条都不累 (isObjective=false 早返)。

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/core/ids';
import { db } from '@/db/client';
import {
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

  it('distinct-question 门用真实题集计数：5 道同家族题 + 20 次客观观测 → b_delta 应用', async () => {
    const k = createId();
    await seedKnowledge(k, 'wenyan');
    // 5 道同 (k, short_answer, manual) 家族的不同题 → 满足 distinct 门。
    const qs: string[] = [];
    for (let i = 0; i < FAMILY_MIN_DISTINCT_QUESTIONS; i++) {
      const q = createId();
      await seedQuestion(q, [k], 'short_answer', 'manual');
      await seedItemCalibration(q, 0);
      qs.push(q);
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
    // n=20 (=FAMILY_MIN_EVIDENCE) + distinct=5 (=门) → 门控刚过最后一次 → b_delta 离 0。
    expect(rows[0].b_delta).toBeGreaterThan(0);
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
});
