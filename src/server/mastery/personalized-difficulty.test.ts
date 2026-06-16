// YUK-361 Phase 5 — 家族级 b_personalized 纯函数单测（shrinkage / family_key /
// 客观路由分类 / 隐含难度残差）。无 DB——门控 update 路径的 db 测在
// personalized-difficulty.db.test.ts。

import { describe, expect, it } from 'vitest';

import { DIFFICULTY_PROXY_WEIGHT, expectedScore } from '@/core/theta';
import {
  FAMILY_MIN_DISTINCT_QUESTIONS,
  FAMILY_MIN_EVIDENCE,
  SHRINKAGE_PRIOR_STRENGTH,
  effectiveFamilyB,
  familyKey,
  impliedDifficultyResidual,
  isObjectiveJudgeRoute,
  shrinkFamilyDelta,
  shrinkageFactor,
} from './personalized-difficulty';

describe('shrinkFamilyDelta', () => {
  it('n=0 → 0 (无证据完全收缩到先验)', () => {
    expect(shrinkFamilyDelta(1.5, 0)).toBe(0);
    expect(shrinkFamilyDelta(-3, 0)).toBe(0);
  });

  it('n<0 → 0 (防御性)', () => {
    expect(shrinkFamilyDelta(1.5, -5)).toBe(0);
  });

  it('n = priorStrength → 0.5·raw (证据等于先验强度，半收缩)', () => {
    const raw = 0.8;
    expect(shrinkFamilyDelta(raw, SHRINKAGE_PRIOR_STRENGTH)).toBeCloseTo(0.5 * raw, 10);
    // 显式 priorStrength
    expect(shrinkFamilyDelta(raw, 20, 20)).toBeCloseTo(0.4, 10);
  });

  it('n → ∞ → raw (证据压倒先验，趋向裸估计)', () => {
    const raw = 1.2;
    // 大 n 下 shrink 接近 raw
    expect(shrinkFamilyDelta(raw, 1_000_000)).toBeCloseTo(raw, 3);
    // 单调逼近：n 越大越接近 raw
    const s100 = shrinkFamilyDelta(raw, 100);
    const s1000 = shrinkFamilyDelta(raw, 1000);
    expect(s1000).toBeGreaterThan(s100);
    expect(s1000).toBeLessThan(raw);
  });

  it('收缩因子 = n/(n+priorStrength)，与 shrinkFamilyDelta 一致', () => {
    expect(shrinkageFactor(0)).toBe(0);
    expect(shrinkageFactor(20, 20)).toBeCloseTo(0.5, 10);
    expect(shrinkFamilyDelta(2, 30, 10)).toBeCloseTo(shrinkageFactor(30, 10) * 2, 10);
  });

  it('收缩因子单调递增 (越多证据越信任 raw)', () => {
    let prev = -1;
    for (const n of [0, 1, 5, 20, 50, 200]) {
      const f = shrinkageFactor(n);
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
  });
});

describe('familyKey', () => {
  it('组装 subject:primaryKnowledge:kind:source，不含 question id', () => {
    expect(familyKey('math', 'k_abc', 'short_answer', 'manual')).toBe(
      'math:k_abc:short_answer:manual',
    );
  });

  it('不同 subject / kind / source 产生不同 key', () => {
    const base = familyKey('math', 'k1', 'mcq', 'manual');
    expect(familyKey('wenyan', 'k1', 'mcq', 'manual')).not.toBe(base);
    expect(familyKey('math', 'k1', 'short_answer', 'manual')).not.toBe(base);
    expect(familyKey('math', 'k1', 'mcq', 'ingestion')).not.toBe(base);
  });

  it('同 (subject,knowledge,kind,source) 的不同题 → 同一家族 key (家族绕道核心)', () => {
    // 题 A 和题 B 共享同一 primary knowledge + kind + source → 同家族。
    const a = familyKey('math', 'k_quad', 'mcq', 'manual');
    const b = familyKey('math', 'k_quad', 'mcq', 'manual');
    expect(a).toBe(b);
  });
});

describe('isObjectiveJudgeRoute', () => {
  it('exact / keyword 是客观路由', () => {
    expect(isObjectiveJudgeRoute('exact')).toBe(true);
    expect(isObjectiveJudgeRoute('keyword')).toBe(true);
  });

  it('LLM/soft 路由非客观', () => {
    for (const r of ['semantic', 'rubric', 'steps', 'multimodal_direct', 'ai_flexible']) {
      expect(isObjectiveJudgeRoute(r)).toBe(false);
    }
  });

  it('unit_dimension 有意排除 (混 LLM fallback，保守)', () => {
    expect(isObjectiveJudgeRoute('unit_dimension')).toBe(false);
  });

  it('null / undefined / 未知 → 非客观', () => {
    expect(isObjectiveJudgeRoute(null)).toBe(false);
    expect(isObjectiveJudgeRoute(undefined)).toBe(false);
    expect(isObjectiveJudgeRoute('bogus')).toBe(false);
  });
});

describe('impliedDifficultyResidual', () => {
  it('答错 (outcome=0) → 正残差 (题比锚显得更难 → b 应上调)', () => {
    // θ=b 时 p=0.5；答错 → residual = −(0−0.5)/0.25 = +2，clamp 到 +2。
    const r = impliedDifficultyResidual(0, 0, 0);
    expect(r).toBeGreaterThan(0);
  });

  it('答对 (outcome=1) → 负残差 (题比锚显得更容易 → b 应下调)', () => {
    const r = impliedDifficultyResidual(0, 0, 1);
    expect(r).toBeLessThan(0);
  });

  it('θ≫b 答对 → 残差接近 0 (符合预测，无意外)', () => {
    // 高能力学习者答对一道简单题，p≈1，残差 ≈ 0。
    const r = impliedDifficultyResidual(4, 0, 1);
    expect(Math.abs(r)).toBeLessThan(0.5);
  });

  it('量级 clamp 到 ±2 (单次极端 surprise 不独占家族均值)', () => {
    // 极端：高能力答错一道极易题 → 大 surprise，但 clamp 住。
    const r = impliedDifficultyResidual(5, -5, 0);
    expect(r).toBeLessThanOrEqual(2.0);
    expect(r).toBeGreaterThanOrEqual(-2.0);
  });

  it('Fisher floor 防 p→0/1 处除零爆掉', () => {
    // p≈0 (θ≪b) 答对——分母被 floor，不 NaN/Infinity。
    const r = impliedDifficultyResidual(-10, 10, 1);
    expect(Number.isFinite(r)).toBe(true);
  });
});

describe('effectiveFamilyB', () => {
  it('familyRow=null → 原样返回 b_anchor (无该家族行)', () => {
    expect(effectiveFamilyB(0.7, null)).toBe(0.7);
  });

  it('b_anchor + b_delta (家族调整后的有效 b)', () => {
    const row = {
      family_key: 'k',
      b_delta: 0.3,
      evidence_count: 40,
      confidence: 0.67,
      calibrated_n: 21,
    };
    expect(effectiveFamilyB(0.7, row)).toBeCloseTo(1.0, 10);
  });

  it('b_delta=0 (门控未过) → 不改 b (与原锚相等)', () => {
    const row = { family_key: 'k', b_delta: 0, evidence_count: 5, confidence: 0, calibrated_n: 0 };
    expect(effectiveFamilyB(0.7, row)).toBe(0.7);
  });

  it('负 b_delta 下调有效 b', () => {
    const row = {
      family_key: 'k',
      b_delta: -0.4,
      evidence_count: 50,
      confidence: 0.71,
      calibrated_n: 31,
    };
    expect(effectiveFamilyB(1.0, row)).toBeCloseTo(0.6, 10);
  });
});

describe('门控阈值常量 (sanity)', () => {
  it('阈值是正的合理值', () => {
    expect(FAMILY_MIN_EVIDENCE).toBeGreaterThanOrEqual(20);
    expect(FAMILY_MIN_DISTINCT_QUESTIONS).toBeGreaterThanOrEqual(5);
    expect(SHRINKAGE_PRIOR_STRENGTH).toBeGreaterThan(0);
  });

  it('弱锚降权常量从 theta 复用 (单一真相)', () => {
    expect(DIFFICULTY_PROXY_WEIGHT).toBe(0.3);
    // expectedScore 仍是 1PL ICC（residual 估计的地基）。
    expect(expectedScore(0, 0)).toBeCloseTo(0.5, 10);
  });
});
