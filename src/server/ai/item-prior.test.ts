import { describe, expect, it } from 'vitest';

import { parseItemPriorLlasaOutput, parseItemPriorOutput } from './item-prior';

describe('parseItemPriorOutput', () => {
  it('parses a well-formed ItemPriorDraft JSON', () => {
    const draft = parseItemPriorOutput(
      '{"b_logit": 1.2, "confidence": 0.4, "reasoning": "三步推理 + 两个前置概念"}',
    );
    expect(draft.b_logit).toBeCloseTo(1.2, 10);
    expect(draft.confidence).toBeCloseTo(0.4, 10);
    expect(draft.reasoning).toContain('三步推理');
  });

  it('brace-slices surrounding prose / code fences', () => {
    const draft = parseItemPriorOutput(
      'Here is the estimate:\n```json\n{"b_logit": -0.5, "confidence": 0.6, "reasoning": "客观题答案空间受限"}\n```\nDone.',
    );
    expect(draft.b_logit).toBeCloseTo(-0.5, 10);
  });

  it('throws when no JSON object is present', () => {
    expect(() => parseItemPriorOutput('no json here')).toThrow(/no JSON object/);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseItemPriorOutput('{"b_logit": 1.0, "confidence":}')).toThrow(/JSON.parse/);
  });

  it('throws on schema mismatch (missing reasoning)', () => {
    expect(() => parseItemPriorOutput('{"b_logit": 1.0, "confidence": 0.5}')).toThrow(
      /schema invalid/,
    );
  });

  it('throws when confidence is out of [0,1]', () => {
    expect(() =>
      parseItemPriorOutput('{"b_logit": 1.0, "confidence": 1.5, "reasoning": "x"}'),
    ).toThrow(/schema invalid/);
  });
});

// YUK-376 — LLaSA 变体解析 barrier：brace-slice + ItemPriorLlasaDraft + 1PL 反推。
// fixture 覆盖长作答文本、删失形态、覆盖度不足、schema 缺口。

const LLASA_REASONABLE = JSON.stringify({
  simulated_responses: [
    {
      theta_level: -2,
      student_answer_md: '该生把 $P(A\\cup B)$ 直接写成 $P(A)+P(B)=0.9$，漏掉交项。',
      correct: false,
      note: '独立性条件被误用为互斥',
    },
    {
      theta_level: -2,
      student_answer_md:
        '写了两行长推导后给出 $0.7$，但中间把 $P(A\\cap B)$ 当成 $P(A)P(B)$ 之外的项。',
      correct: false,
      note: '过程正确但终值错',
    },
    {
      theta_level: -1,
      student_answer_md: '用容斥写出 $0.4+0.5-P(A\\cap B)$，忘记独立性可拆交项，停在半式。',
      correct: false,
      note: '交项无法求值而放弃',
    },
    {
      theta_level: -1,
      student_answer_md: '列出样本空间后逐格数，最终答对。',
      correct: true,
      note: '枚举法绕开了公式',
    },
    {
      theta_level: 0,
      student_answer_md: '正确写出 $P(A\\cup B)=P(A)+P(B)-P(A)P(B)=0.7$，并注明用了独立性。',
      correct: true,
      note: '公式选择正确',
    },
    {
      theta_level: 0,
      student_answer_md: '同上思路但算错 $0.4 \\times 0.5$，得 $0.72$。',
      correct: false,
      note: '算术失误',
    },
    {
      theta_level: 1,
      student_answer_md: '直接套用独立并事件公式得 $0.7$，过程完整。',
      correct: true,
      note: '一步直达',
    },
    {
      theta_level: 1,
      student_answer_md: '先验证独立性再套公式，得 $0.7$。',
      correct: true,
      note: '带条件核查',
    },
    {
      theta_level: 2,
      student_answer_md: '给出 $0.7$ 并补充了一般化讨论（交项上界）。',
      correct: true,
      note: '超出题目要求',
    },
    {
      theta_level: 2,
      student_answer_md: '心算给出 $0.7$。',
      correct: true,
      note: '简洁正确',
    },
  ],
  reasoning: 'θ≤-1 普遍踩交项坑，θ≥0 起稳定答对，分水岭在 -1 到 0 之间',
});

describe('parseItemPriorLlasaOutput', () => {
  it('parses a well-formed simulation and inverts to an interior b', () => {
    const { simulation, prior, inversion } = parseItemPriorLlasaOutput(LLASA_REASONABLE);
    expect(simulation.simulated_responses).toHaveLength(10);
    expect(inversion.censored).toBeNull();
    // p̂: -2:0/2, -1:1/2, 0:1/2, 1:2/2, 2:2/2 → 交叉点在 -0.5 附近。
    expect(prior.b_logit).toBeGreaterThan(-1.5);
    expect(prior.b_logit).toBeLessThan(0.5);
    expect(prior.confidence).toBeGreaterThan(0.4);
    expect(prior.reasoning).toContain('分水岭');
  });

  it('brace-slices surrounding prose', () => {
    const text = `模拟结果如下：\n${LLASA_REASONABLE}\n以上。`;
    expect(parseItemPriorLlasaOutput(text).prior.b_logit).toBeDefined();
  });

  it('throws when no JSON object is present', () => {
    expect(() => parseItemPriorLlasaOutput('no json here')).toThrow(/no JSON object/);
  });

  it('throws on schema mismatch (empty responses / missing note)', () => {
    expect(() =>
      parseItemPriorLlasaOutput('{"simulated_responses": [], "reasoning": "x"}'),
    ).toThrow(/schema invalid/);
    expect(() =>
      parseItemPriorLlasaOutput(
        '{"simulated_responses": [{"theta_level": 0, "student_answer_md": "a", "correct": true}], "reasoning": "x"}',
      ),
    ).toThrow(/schema invalid/);
  });

  it('throws when tier coverage is insufficient even with enough rows', () => {
    // 5 条但全挤在 2 个档 → invert 侧硬拒（distinct θ < 4）。
    const sparse = JSON.stringify({
      simulated_responses: [0, 0, 0, 1, 1].map((t) => ({
        theta_level: t,
        student_answer_md: '作答内容',
        correct: t === 1,
        note: 'n',
      })),
      reasoning: 'x',
    });
    expect(() => parseItemPriorLlasaOutput(sparse)).toThrow(/insufficient tier coverage/);
  });

  it('surfaces censored priors for unanimous outcomes', () => {
    const allWrong = JSON.stringify({
      simulated_responses: [-2, -1, 0, 1, 2].flatMap((t) => [
        { theta_level: t, student_answer_md: '错误作答 A', correct: false, note: '全错' },
        { theta_level: t, student_answer_md: '错误作答 B', correct: false, note: '全错' },
      ]),
      reasoning: '五档全错，题目极难',
    });
    const { prior, inversion } = parseItemPriorLlasaOutput(allWrong);
    expect(inversion.censored).toBe('high');
    expect(prior.b_logit).toBe(3);
  });
});
