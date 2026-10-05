// YUK-376 — LLaSA 模拟作答 → b 反推（纯函数）unit tests。
//
// fixture 刻意接近生产真实输出形态：长作答文本（markdown/LaTeX）、插值档位、
// 非单调波动、删失（全对/全错）、覆盖度不足——不允许退化成单字段 happy path。

import { describe, expect, it } from 'vitest';

import { invertLlasaSimulation } from './item-prior-llasa';
import type { ItemPriorLlasaDraftT, ItemPriorLlasaResponseT } from './schema/item_prior';

const TIERS = [-2, -1, 0, 1, 2] as const;

/** 构造一档两名学生的作答；answer 带真实长度的 markdown/LaTeX 噪声。 */
function tierResponses(
  theta: number,
  correctFlags: [boolean, boolean],
  flavor: 'math' | 'prose' = 'math',
): ItemPriorLlasaResponseT[] {
  const body =
    flavor === 'math'
      ? '设事件 $A$ 与 $B$ 相互独立，$P(A)=0.4$，$P(B)=0.5$。该生写出 $P(A\\cup B)=P(A)+P(B)-P(A)P(B)=0.4+0.5-0.2=0.7$ 的完整推导，并在草稿中检查了 $A\\cap B$ 的独立性条件是否成立，最终给出数值答案并标注了置信说明。'
      : '该生先复述题干要求，再逐条对照文本中的证据句，组织了一段约两百字的分析作答，包含对关键词含义的解释、对上下文因果链的推断，以及一个自我修正（先写下一个宽泛结论，随后用更精确的表述替换）。';
  return correctFlags.map((correct, i) => ({
    theta_level: theta,
    student_answer_md: `${body}（学生 ${i + 1} 的作答变体：${correct ? '推到正确结论' : '在中间步骤出现符号/概念性错误，给出错误终值'}）`,
    correct,
    note: correct
      ? '正确：关键步骤齐全，未踩典型坑'
      : '错误：混淆了独立与互斥的概念边界 / 漏掉定义域检查',
  }));
}

function draft(
  responses: ItemPriorLlasaResponseT[],
  reasoning = '分水岭观察',
): ItemPriorLlasaDraftT {
  return { simulated_responses: responses, reasoning };
}

describe('invertLlasaSimulation', () => {
  it('inverts a clean monotone ladder to an interior b near the 0.5 crossing', () => {
    // θ=-2,-1 全错；θ=0 一对一错；θ=1,2 全对 → p̂=[0,0,0.5,1,1]，1PL 交叉点在 θ=0。
    const d = draft([
      ...tierResponses(-2, [false, false]),
      ...tierResponses(-1, [false, false]),
      ...tierResponses(0, [true, false]),
      ...tierResponses(1, [true, true]),
      ...tierResponses(2, [true, true]),
    ]);
    const out = invertLlasaSimulation(d);
    expect(out.censored).toBeNull();
    expect(out.monotone).toBe(true);
    expect(out.prior.b_logit).toBeGreaterThan(-0.3);
    expect(out.prior.b_logit).toBeLessThan(0.3);
    expect(out.prior.confidence).toBeCloseTo(0.8, 5); // 0.65 interior + 0.15 monotone
    expect(out.prior.reasoning).toContain('分水岭');
    expect(out.prior.reasoning).toContain('θ=-2:0/2');
    expect(out.tiers).toHaveLength(5);
    expect(out.tiers[2]).toMatchObject({ theta: 0, correct: 1, total: 2, p_hat: 0.5 });
  });

  it('shifts b negative when weaker tiers start answering correctly', () => {
    // θ=-2 一对一错、其余全对 → 交叉点低于 -2 与 -1 之间 → b 明显为负。
    const d = draft([
      ...tierResponses(-2, [true, false]),
      ...tierResponses(-1, [true, true]),
      ...tierResponses(0, [true, true]),
      ...tierResponses(1, [true, true]),
      ...tierResponses(2, [true, true]),
    ]);
    const out = invertLlasaSimulation(d);
    expect(out.censored).toBeNull();
    expect(out.prior.b_logit).toBeLessThan(-1.5);
    expect(out.prior.b_logit).toBeGreaterThan(-3);
  });

  it('censors high when every simulated student fails', () => {
    const d = draft(TIERS.flatMap((t) => tierResponses(t, [false, false])));
    const out = invertLlasaSimulation(d);
    expect(out.censored).toBe('high');
    expect(out.prior.b_logit).toBe(3); // max θ + 1
    expect(out.prior.confidence).toBeLessThan(0.6); // 删失压置信
    expect(out.prior.reasoning).toContain('删失');
  });

  it('censors low when every simulated student succeeds', () => {
    const d = draft(TIERS.flatMap((t) => tierResponses(t, [true, true], 'prose')));
    const out = invertLlasaSimulation(d);
    expect(out.censored).toBe('low');
    expect(out.prior.b_logit).toBe(-3); // min θ − 1
    expect(out.prior.confidence).toBeLessThan(0.6);
  });

  it('penalizes non-monotone response patterns', () => {
    // θ=0 全对但 θ=1 全错（反常翻转）→ 非单调 → confidence 低于同形单调。
    const d = draft([
      ...tierResponses(-2, [false, false]),
      ...tierResponses(-1, [false, false]),
      ...tierResponses(0, [true, true]),
      ...tierResponses(1, [false, false]),
      ...tierResponses(2, [true, true]),
    ]);
    const out = invertLlasaSimulation(d);
    expect(out.monotone).toBe(false);
    expect(out.censored).toBeNull();
    expect(out.prior.confidence).toBeCloseTo(0.5, 5); // 0.65 − 0.15
  });

  it('throws when distinct tier coverage is below the minimum', () => {
    // 只有 3 个档（< LLASA_MIN_TIERS=4）→ 反推无形状信息，硬拒。
    const d = draft([
      ...tierResponses(-1, [false, false]),
      ...tierResponses(0, [true, false]),
      ...tierResponses(1, [true, true]),
    ]);
    expect(() => invertLlasaSimulation(d)).toThrow(/insufficient tier coverage/);
  });

  it('accepts interpolated theta levels and counts them toward coverage', () => {
    // 模型给出插值档（-1.5 / 0.5）——仍是合法观测点，按实际 θ 聚合进 MLE。
    const d = draft([
      ...tierResponses(-2, [false, false]),
      {
        theta_level: -1.5,
        student_answer_md: '半截推导后放弃',
        correct: false,
        note: '卡在第二步',
      },
      { theta_level: -0.5, student_answer_md: '方向对但终值错', correct: false, note: '符号错' },
      ...tierResponses(0.5, [true, true]),
      ...tierResponses(1.5, [true, true]),
    ]);
    const out = invertLlasaSimulation(d);
    expect(out.tiers).toHaveLength(5); // -2, -1.5, -0.5, 0.5, 1.5
    expect(out.prior.b_logit).toBeGreaterThan(-1);
    expect(out.prior.b_logit).toBeLessThan(1);
  });

  it('keeps b_logit inside the shared [-6,6] ItemPriorDraft bound', () => {
    const d = draft(TIERS.flatMap((t) => tierResponses(t, [false, false])));
    const out = invertLlasaSimulation(d);
    expect(out.prior.b_logit).toBeLessThanOrEqual(6);
    expect(out.prior.b_logit).toBeGreaterThanOrEqual(-6);
  });
});
