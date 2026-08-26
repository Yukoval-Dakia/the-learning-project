// YUK-739 — consumer routing tests: judge/prompt/normalization consumers must
// read rating/cause semantics from the SubjectProfile policy, not from local
// mirrors. Covers ≥2 subjects with meaningfully different semantics (math vs
// physics vs yuwen vocabulary) plus historical/undeclared fallback behavior.

import { describe, expect, it } from 'vitest';
import { getTaskSystemPrompt } from '@/ai/task-prompts';
import { ratingFromCoarseOutcome } from '@/capabilities/practice/server/judge-rating';
import { judgeResultToRatingAdvice } from '@/capabilities/practice/server/rating-advisor';
import type { JudgeResultV2T } from '@/core/schema/capability';
import { UNIVERSAL_RATING_FROM_OUTCOME } from '@/core/schema/profile-decl';
import { mathProfile } from '@/subjects/math/profile';
import { physicsProfile } from '@/subjects/physics/profile';
import type { SubjectProfile } from '@/subjects/profile-schema';
import { yuwenProfile } from '@/subjects/yuwen/profile';
import { parseAttributionOutput } from './attribution';

type CoarseOutcome = JudgeResultV2T['coarse_outcome'];

const ATTRIBUTION_JSON_HEAD = '{"secondary_categories":[],"analysis_md":"x","confidence":0.9';

function attributionText(primary: string): string {
  return `${ATTRIBUTION_JSON_HEAD},"primary_category":"${primary}"}`;
}

describe('parseAttributionOutput routes the meta-cause prior through the profile (YUK-739)', () => {
  it('defaults meta_cause from the math profile declared prior (calculation → execution_slip)', () => {
    const out = parseAttributionOutput(attributionText('calculation'), mathProfile);
    expect(out.meta_cause).toBe('execution_slip');
  });

  it('defaults meta_cause from the yuwen profile declared prior (grammar → rule_misapplication)', () => {
    const out = parseAttributionOutput(attributionText('grammar'), yuwenProfile);
    expect(out.meta_cause).toBe('rule_misapplication');
  });

  it('defaults meta_cause from the physics profile declared prior (unit → representation_failure)', () => {
    const out = parseAttributionOutput(attributionText('unit'), physicsProfile);
    expect(out.meta_cause).toBe('representation_failure');
  });

  it('an explicit null prior stays null (other is deliberately non-diagnostic)', () => {
    const out = parseAttributionOutput(attributionText('other'), mathProfile);
    expect(out.meta_cause).toBeNull();
  });

  it('a judge-provided meta_cause is never overridden by the prior', () => {
    const text = `${ATTRIBUTION_JSON_HEAD},"primary_category":"calculation","meta_cause":"retrieval_failure"}`;
    const out = parseAttributionOutput(text, mathProfile);
    expect(out.meta_cause).toBe('retrieval_failure');
  });

  it('a profile whose categories declare no prior falls back to null (legacy unknown-id behavior)', () => {
    const undeclared: SubjectProfile = {
      ...mathProfile,
      causeCategories: mathProfile.causeCategories.map(({ id, label }) => ({ id, label })),
    };
    const out = parseAttributionOutput(attributionText('calculation'), undeclared);
    expect(out.meta_cause).toBeNull();
  });
});

describe('attribution prompt renders the profile-owned prior list (YUK-739)', () => {
  it('math prompt lists the declared priors with the legacy rendering', () => {
    const prompt = getTaskSystemPrompt('AttributionTask', mathProfile);
    expect(prompt).toContain('- calculation → execution_slip');
    expect(prompt).toContain('- concept → flawed_model');
    expect(prompt).toContain('- other → null');
  });

  it('yuwen prompt lists its own vocabulary, not math semantics', () => {
    const prompt = getTaskSystemPrompt('AttributionTask', yuwenProfile);
    expect(prompt).toContain('- grammar → rule_misapplication');
    expect(prompt).toContain('- word_meaning → rule_misapplication');
    expect(prompt).not.toContain('calculation');
  });

  it('physics prompt lists its own vocabulary', () => {
    const prompt = getTaskSystemPrompt('AttributionTask', physicsProfile);
    expect(prompt).toContain('- computation → execution_slip');
    expect(prompt).toContain('- unit → representation_failure');
    expect(prompt).not.toContain('unit_error');
  });
});

describe('ratingFromCoarseOutcome routes through the profile rating policy (YUK-739)', () => {
  it('universal behavior is preserved when no profile is supplied', () => {
    expect(ratingFromCoarseOutcome('correct')).toBe('good');
    expect(ratingFromCoarseOutcome('partial')).toBe('hard');
    expect(ratingFromCoarseOutcome('incorrect')).toBe('again');
    expect(ratingFromCoarseOutcome('unsupported')).toBeNull();
  });

  it('built-in subjects inherit the universal map', () => {
    for (const profile of [yuwenProfile, mathProfile, physicsProfile]) {
      for (const outcome of Object.keys(UNIVERSAL_RATING_FROM_OUTCOME) as CoarseOutcome[]) {
        expect(ratingFromCoarseOutcome(outcome, profile)).toBe(
          UNIVERSAL_RATING_FROM_OUTCOME[outcome],
        );
      }
    }
  });

  it('a per-subject override actually changes the mapping (routing, not hardcoding)', () => {
    const strictPartial: SubjectProfile = {
      ...mathProfile,
      ratingPolicy: {
        outcomeToRating: { ...UNIVERSAL_RATING_FROM_OUTCOME, partial: 'again' },
      },
    };
    expect(ratingFromCoarseOutcome('partial', strictPartial)).toBe('again');
    expect(ratingFromCoarseOutcome('partial', mathProfile)).toBe('hard');
  });

  it('a null profile falls back to the universal map', () => {
    expect(ratingFromCoarseOutcome('correct', null)).toBe('good');
  });
});

describe('judgeResultToRatingAdvice routes cause lean + outcome anchors through the profile (YUK-739)', () => {
  const partial04: JudgeResultV2T = {
    coarse_outcome: 'partial',
    score: 0.4,
    score_meaning: 'steps_v1_weighted',
    confidence: 0.8,
    capability_ref: { id: 'steps', version: '1' },
    feedback_md: 'partial credit 0.4',
    evidence_json: {},
  };
  const correct: JudgeResultV2T = {
    coarse_outcome: 'correct',
    score: 1,
    score_meaning: 'correctness',
    confidence: 0.95,
    capability_ref: { id: 'exact', version: '1.0.0' },
    feedback_md: 'ok',
    evidence_json: {},
  };
  const incorrect: JudgeResultV2T = {
    coarse_outcome: 'incorrect',
    score: 0,
    score_meaning: 'correctness',
    confidence: 0.9,
    capability_ref: { id: 'exact', version: '1.0.0' },
    feedback_md: 'wrong',
    evidence_json: {},
  };

  it("math 'carelessness' leans the partial advisory to good", () => {
    const advice = judgeResultToRatingAdvice(partial04, {
      causeCategory: 'carelessness',
      subjectProfile: mathProfile,
    });
    expect(advice.rating).toBe('good');
  });

  it("physics 'careless' (different id, same declared lean) also leans to good", () => {
    const advice = judgeResultToRatingAdvice(partial04, {
      causeCategory: 'careless',
      subjectProfile: physicsProfile,
    });
    expect(advice.rating).toBe('good');
  });

  it("math 'concept' leans the partial advisory to again", () => {
    const advice = judgeResultToRatingAdvice(partial04, {
      causeCategory: 'concept',
      subjectProfile: mathProfile,
    });
    expect(advice.rating).toBe('again');
  });

  it('an id with no declared lean keeps the score-bucket base (no silent inheritance)', () => {
    // 'unit_error' declares no lean under math; under yuwen the id does not even
    // exist. Either way the advisory must not lean.
    const mathAdvice = judgeResultToRatingAdvice(partial04, {
      causeCategory: 'unit_error',
      subjectProfile: mathProfile,
    });
    expect(mathAdvice.rating).toBe('again'); // score 0.4 < 0.5 bucket
    const crossAdvice = judgeResultToRatingAdvice(partial04, {
      causeCategory: 'carelessness',
      subjectProfile: yuwenProfile,
    });
    expect(crossAdvice.rating).toBe('good'); // yuwen declares the lean too
    const unknownId = judgeResultToRatingAdvice(partial04, {
      causeCategory: 'not_a_real_id',
      subjectProfile: mathProfile,
    });
    expect(unknownId.rating).toBe('again');
  });

  it('historical generic cause ids keep their legacy lean (replay compatibility)', () => {
    // `conceptual_error` is a pre-profile CC-1 spec-era id that can sit in
    // persisted user_cause rows; the profile-routed path must keep interpreting
    // it with the lean it always had instead of silently neutralizing it.
    const advice = judgeResultToRatingAdvice(partial04, {
      causeCategory: 'conceptual_error',
      subjectProfile: mathProfile,
    });
    expect(advice.rating).toBe('again');
  });

  it('without a profile the advisor cannot interpret the cause id → no lean, universal anchors', () => {
    // YUK-739: the hard-coded id→lean mirror is gone, so a caller that does not
    // supply the profile gets the neutral score-bucket base instead of guessing
    // subject semantics from the raw id string.
    const advice = judgeResultToRatingAdvice(partial04, { causeCategory: 'carelessness' });
    expect(advice.rating).toBe('again'); // no profile → no lean
    expect(judgeResultToRatingAdvice(correct, {}).rating).toBe('good');
    expect(judgeResultToRatingAdvice(incorrect, {}).rating).toBe('again');
  });

  it('correct/incorrect anchors route through the profile policy', () => {
    const strict: SubjectProfile = {
      ...mathProfile,
      ratingPolicy: {
        outcomeToRating: {
          ...UNIVERSAL_RATING_FROM_OUTCOME,
          correct: 'hard',
          incorrect: 'hard',
        },
      },
    };
    expect(judgeResultToRatingAdvice(correct, { subjectProfile: strict }).rating).toBe('hard');
    expect(judgeResultToRatingAdvice(incorrect, { subjectProfile: strict }).rating).toBe('hard');
  });
});

describe('variant-gen prompt routes cause strategies through the profile (YUK-739)', () => {
  it('declared strategies render with the legacy line format', () => {
    const prompt = getTaskSystemPrompt('VariantGenTask', mathProfile);
    expect(prompt).toContain('- unit_error（单位错误）：改变单位、量纲或换算条件，检查单位一致性');
    expect(prompt).toContain('- calculation（运算错误）：改数据 + 留同样陷阱（验证计算稳定性）');
  });

  it('categories without a declared strategy keep the generic fallback line', () => {
    const prompt = getTaskSystemPrompt('VariantGenTask', physicsProfile);
    // physics only declares the strategy on 'concept' (the one id the legacy
    // id-keyed table covered); everything else keeps the fallback shape.
    expect(prompt).toContain('（单位错误）：围绕「单位错误」设计同知识点、同能力目标的针对性变式');
    expect(prompt).not.toContain('检查单位一致性');
  });

  it('yuwen grammar gets the generic fallback (it never had a table entry)', () => {
    const prompt = getTaskSystemPrompt('VariantGenTask', yuwenProfile);
    expect(prompt).toContain('（语法判断）：围绕「语法判断」设计同知识点、同能力目标的针对性变式');
  });
});
