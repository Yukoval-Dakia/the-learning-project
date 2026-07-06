import { describe, expect, it, vi } from 'vitest';

import {
  semanticJudgeOutput as semanticOutput,
  solverOutput,
} from '../../../tests/helpers/solve-check-fixtures';
import { teachingQualityOutput } from '../../../tests/helpers/teaching-quality-fixtures';
import {
  CHECK_SETS_BY_TIER,
  SOLVE_CHECK_SEMANTIC_THRESHOLD,
  SOLVE_CHECK_TIER34_VETO,
  type SolveCheckQuestion,
  type SolveCheckResult,
  TEACHING_QUALITY_TIER34_VETO,
  type TeachingQualityQuestion,
  type TeachingQualityResult,
  checksForTier,
  normalizeAnswer,
  runSolveCheck,
  runTeachingQualityCheck,
  solveCheckBlocks,
  teachingQualityBlocks,
} from './verify-framework';

// ---------- tier → check-set config ----------

describe('CHECK_SETS_BY_TIER / checksForTier', () => {
  it('tier 1 authentic uses a minimal trusted check set (no solve_check)', () => {
    expect(checksForTier(1)).not.toContain('solve_check');
    expect(checksForTier(1)).toContain('structure_completeness');
  });

  it('tier 2 sourced requires source_consistency + solve_check + dedup', () => {
    expect(checksForTier(2)).toEqual(
      expect.arrayContaining(['source_consistency', 'solve_check', 'dedup']),
    );
  });

  it('tier 3 material requires material_grounding + solve_check + kind_conformance + teaching_quality', () => {
    expect(checksForTier(3)).toEqual(
      expect.arrayContaining([
        'material_grounding',
        'solve_check',
        'kind_conformance',
        'teaching_quality',
      ]),
    );
  });

  it('tier 4 generated keeps legacy checks and adds kind_conformance + solve_check + teaching_quality', () => {
    expect(checksForTier(4)).toEqual(
      expect.arrayContaining([
        'grounding',
        'copy_safety',
        'knowledge_hit',
        'kind_conformance',
        'solve_check',
        'teaching_quality',
      ]),
    );
  });

  it('tier 1/2 do NOT carry teaching_quality (入池前审题闸 is tier3/4 only)', () => {
    expect(checksForTier(1)).not.toContain('teaching_quality');
    expect(checksForTier(2)).not.toContain('teaching_quality');
  });

  it('every tier includes structure_completeness', () => {
    for (const tier of [1, 2, 3, 4] as const) {
      expect(CHECK_SETS_BY_TIER[tier]).toContain('structure_completeness');
    }
  });
});

// ---------- normalizeAnswer ----------

describe('normalizeAnswer', () => {
  it('strips whitespace and case while preserving meaningful punctuation/symbols', () => {
    expect(normalizeAnswer('  A. 公元前 202 年! ')).toBe(normalizeAnswer('a.公元前202年!'));
  });

  it('treats full-width and ASCII whitespace alike', () => {
    expect(normalizeAnswer('公元前　202')).toBe(normalizeAnswer('公元前 202'));
  });

  it('preserves mathematical and symbolic answer content', () => {
    expect(normalizeAnswer('1/2')).not.toBe(normalizeAnswer('12'));
    expect(normalizeAnswer('√')).toBe('√');
    expect(normalizeAnswer('x = -1')).toBe(normalizeAnswer('x=-1'));
  });
});

// ---------- solve-check helpers ----------
// solverOutput / semanticOutput now come from tests/helpers/solve-check-fixtures (YUK-554
// review R1/R2 — shared with quiz_verify.test.ts).

const fakeProfile = {
  id: 'wenyan',
  // runSemanticJudge's builder reads displayName / languageStyle off subjectProfile.
  full: { id: 'wenyan', displayName: '文言文', languageStyle: 'classical' },
};

const exactQuestion: SolveCheckQuestion = {
  id: 'q1',
  kind: 'choice',
  prompt_md: '汉朝建立于哪一年？',
  reference_md: '公元前 202 年',
  choices_md: ['公元前 202 年', '公元前 221 年'],
  judge_kind_override: 'exact',
  rubric_json: null,
  knowledge_ids: ['k_han'],
  metadata: null,
};

const openQuestion: SolveCheckQuestion = {
  id: 'q2',
  kind: 'translation',
  prompt_md: '翻译：学而时习之',
  reference_md: '学习并按时温习它',
  choices_md: null,
  judge_kind_override: 'semantic',
  rubric_json: null,
  knowledge_ids: ['k_lunyu'],
  metadata: null,
};

const fakeDb = {} as never;

// ---------- solveCheckBlocks (YUK-538 / YUK-554 — per-axis veto seam) ----------

describe('solveCheckBlocks (tier3/4 per-axis veto)', () => {
  const fail = (compared_by: SolveCheckResult['compared_by']): SolveCheckResult => ({
    verdict: 'fail',
    compared_by,
    reason: 'r',
  });

  it('defaults to SOLVE_CHECK_TIER34_VETO (both axes veto a fail)', () => {
    expect(SOLVE_CHECK_TIER34_VETO.semantic).toBe(true);
    expect(SOLVE_CHECK_TIER34_VETO.normalize).toBe(true);
    expect(solveCheckBlocks(fail('semantic'))).toBe(true);
    expect(solveCheckBlocks(fail('normalize'))).toBe(true);
  });

  it('flag-off retreat: normalize:false lets an exact fail through WITHOUT touching semantic veto', () => {
    // THE core Q1 assertion — the exact false-veto can be disabled independently.
    expect(solveCheckBlocks(fail('normalize'), { semantic: true, normalize: false })).toBe(false);
    // ...while the semantic veto still fires.
    expect(solveCheckBlocks(fail('semantic'), { semantic: true, normalize: false })).toBe(true);
  });

  it('semantic:false disables ONLY the semantic veto; normalize still blocks', () => {
    expect(solveCheckBlocks(fail('semantic'), { semantic: false, normalize: true })).toBe(false);
    expect(solveCheckBlocks(fail('normalize'), { semantic: false, normalize: true })).toBe(true);
  });

  it('never blocks on a non-fail verdict (R2 conservative)', () => {
    for (const compared_by of ['semantic', 'normalize', 'none'] as const) {
      expect(solveCheckBlocks({ verdict: 'pass', compared_by, reason: 'r' })).toBe(false);
      expect(solveCheckBlocks({ verdict: 'unsupported', compared_by, reason: 'r' })).toBe(false);
    }
  });

  it("never blocks when compared_by='none' even on a fail (defensive)", () => {
    expect(solveCheckBlocks(fail('none'))).toBe(false);
  });
});

describe('runSolveCheck — exact path (normalize compare)', () => {
  it('passes when the solver answer matches the reference (normalized)', async () => {
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('公元前202年') }));
    const result = await runSolveCheck(exactQuestion, { runTaskFn, profile: fakeProfile });
    expect(result.verdict).toBe('pass');
    expect(result.compared_by).toBe('normalize');
    expect(runTaskFn).toHaveBeenCalledWith(
      'SolutionGenerateTask',
      expect.anything(),
      expect.anything(),
    );
  });

  it('passes when an answer_equivalent matches', async () => {
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('foo', ['公元前 202 年']) }));
    const result = await runSolveCheck(exactQuestion, { runTaskFn, profile: fakeProfile });
    expect(result.verdict).toBe('pass');
  });

  it('passes choice answers by matching option labels and option text', async () => {
    const labelOnly = vi.fn(async () => ({ text: solverOutput('A') }));
    await expect(
      runSolveCheck(exactQuestion, { runTaskFn: labelOnly, profile: fakeProfile }),
    ).resolves.toMatchObject({ verdict: 'pass' });

    const labeledText = vi.fn(async () => ({ text: solverOutput('A. 公元前202年') }));
    await expect(
      runSolveCheck(exactQuestion, { runTaskFn: labeledText, profile: fakeProfile }),
    ).resolves.toMatchObject({ verdict: 'pass' });
  });

  it('fails when the solver answer disagrees with the reference', async () => {
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('公元前 221 年') }));
    const result = await runSolveCheck(exactQuestion, { runTaskFn, profile: fakeProfile });
    expect(result.verdict).toBe('fail');
    expect(result.solver_final_answer).toBe('公元前 221 年');
  });

  it('does NOT feed the question reference answer back to the solver as a hint', async () => {
    const runTaskFn = vi.fn(async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: solverOutput('公元前202年'),
    }));
    await runSolveCheck(exactQuestion, { runTaskFn, profile: fakeProfile });
    const input = runTaskFn.mock.calls[0][1] as Record<string, unknown>;
    expect(input.existing_answers_hint).toBeNull();
    expect(input.choices_md).toEqual(exactQuestion.choices_md);
    expect(input.prompt_md).toBe(exactQuestion.prompt_md);
  });

  it('routes a subject choice kind (single_choice) with choices_md through the exact path (F1 structural)', async () => {
    // History/学科 题型 expose kinds like 'single_choice' that the canonical
    // QuestionKind enum does not, but a persisted choices_md makes the item
    // structurally exact (mirrors route-resolve.ts). No judge_kind_override here.
    const singleChoice: SolveCheckQuestion = {
      ...exactQuestion,
      kind: 'single_choice',
      judge_kind_override: null,
    };
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('公元前 221 年') }));
    const result = await runSolveCheck(singleChoice, { runTaskFn, profile: fakeProfile });
    // A wrong reference answer is now CAUGHT (would have been a conservative semantic
    // pass / skip before F1).
    expect(result.verdict).toBe('fail');
    expect(result.compared_by).toBe('normalize');
  });

  it('compares against the structured rubric final_answer, not the worked-solution prose (F2)', async () => {
    // solution-generate writes the structured answer to rubric_json.reference_solution
    // while reference_md holds the full worked solution. Exact compare must use the
    // structured final answer, otherwise it compares against an entire paragraph and
    // falsely fails.
    const workedSolution: SolveCheckQuestion = {
      ...exactQuestion,
      reference_md: '我们先回顾汉朝的建立背景，刘邦在垓下之战后……因此最终答案是公元前 202 年。',
      rubric_json: {
        criteria: [],
        reference_solution: {
          expected_signals: ['汉朝建立年份'],
          final_answer: '公元前 202 年',
          answer_equivalents: [],
        },
      },
    };
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('公元前202年') }));
    const result = await runSolveCheck(workedSolution, { runTaskFn, profile: fakeProfile });
    expect(result.verdict).toBe('pass');
    expect(result.compared_by).toBe('normalize');
  });

  it('matches a rubric answer_equivalent in the exact path (F2)', async () => {
    const withEquivalents: SolveCheckQuestion = {
      ...exactQuestion,
      reference_md: '冗长的解题过程……',
      rubric_json: {
        criteria: [],
        reference_solution: {
          expected_signals: ['s'],
          final_answer: '公元前 202 年',
          answer_equivalents: ['前 202 年'],
        },
      },
    };
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('前202年') }));
    const result = await runSolveCheck(withEquivalents, { runTaskFn, profile: fakeProfile });
    expect(result.verdict).toBe('pass');
  });

  it('threads a solverModelOverride into ctx (OF-4 model 异源 seam)', async () => {
    const runTaskFn = vi.fn(async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: solverOutput('公元前202年'),
    }));
    await runSolveCheck(exactQuestion, {
      runTaskFn,
      profile: fakeProfile,
      solverModelOverride: 'mimo-v2.5',
    });
    const ctx = runTaskFn.mock.calls[0][2] as Record<string, unknown>;
    // PR #312 验证轮 V4：生产 runner 只读 ctx.override.model（resolveTaskProvider），
    // 裸 ctx.model 是死旋钮——断言真接线形态。
    expect((ctx.override as { model?: string }).model).toBe('mimo-v2.5');
    expect(ctx.model).toBeUndefined();
  });
});

// ---------- A1 (YUK-554 review) — reference_md fallback candidates ----------
//
// quiz_gen rows carry no rubric_json.reference_solution (and are never backfilled), so the
// exact compare falls back to reference_md — typically「答案+解析」prose. Without the A1
// candidates this shape was a near-guaranteed false fail; these tests lock the mitigation.
describe('runSolveCheck — A1 fallback candidates (答案+解析 reference_md)', () => {
  const fillBlank: SolveCheckQuestion = {
    id: 'q_a1',
    kind: 'fill_blank',
    prompt_md: '「之」在此句中作____。',
    reference_md: '代词。此处之作代词。',
    choices_md: null,
    judge_kind_override: 'exact',
    rubric_json: null,
    knowledge_ids: ['k_zhi'],
    metadata: null,
  };

  it('passes when the solver gives the bare answer against 答案+解析 (first-sentence candidate)', async () => {
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));
    const result = await runSolveCheck(fillBlank, { runTaskFn, profile: fakeProfile });
    expect(result.verdict).toBe('pass');
    expect(result.compared_by).toBe('normalize');
  });

  it('still fails on a genuine disagreement against the same reference shape', async () => {
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('助词') }));
    const result = await runSolveCheck(fillBlank, { runTaskFn, profile: fakeProfile });
    expect(result.verdict).toBe('fail');
    expect(result.compared_by).toBe('normalize');
  });

  it('passes via the first-line candidate on a multi-line 答案+解析 reference', async () => {
    const multiLine = { ...fillBlank, reference_md: '代词\n解析：「之」指代所学的内容。' };
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));
    const result = await runSolveCheck(multiLine, { runTaskFn, profile: fakeProfile });
    expect(result.verdict).toBe('pass');
  });

  it('trailing sentence punctuation does not fail a bare-answer match (both directions)', async () => {
    // reference carries a trailing 。, solver answers bare:
    const refPunct = { ...fillBlank, prompt_md: '西汉定都于____。', reference_md: '长安。' };
    await expect(
      runSolveCheck(refPunct, {
        runTaskFn: vi.fn(async () => ({ text: solverOutput('长安') })),
        profile: fakeProfile,
      }),
    ).resolves.toMatchObject({ verdict: 'pass' });
    // reference bare, solver carries a trailing 。:
    const refBare = { ...refPunct, reference_md: '长安' };
    await expect(
      runSolveCheck(refBare, {
        runTaskFn: vi.fn(async () => ({ text: solverOutput('长安。') })),
        profile: fakeProfile,
      }),
    ).resolves.toMatchObject({ verdict: 'pass' });
  });

  it('never truncates decimals (sentence split excludes ASCII "." — 3 ≠ 3.14)', async () => {
    const decimal = { ...fillBlank, prompt_md: '圆周率约等于____。', reference_md: '3.14' };
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('3') }));
    const result = await runSolveCheck(decimal, { runTaskFn, profile: fakeProfile });
    expect(result.verdict).toBe('fail');
  });
});

// ---------- EFF-1 (YUK-554 review) — cost/provenance threading ----------

describe('runSolveCheck — EFF-1 cost/provenance threading', () => {
  it('captures the solver leg task_run_id + cost_usd on the exact path', async () => {
    const runTaskFn = vi.fn(async () => ({
      text: solverOutput('公元前202年'),
      task_run_id: 'tr_solver',
      cost_usd: 0.012,
    }));
    const result = await runSolveCheck(exactQuestion, { runTaskFn, profile: fakeProfile });
    expect(result.verdict).toBe('pass');
    expect(result.task_run_ids).toEqual(['tr_solver']);
    expect(result.cost_usd).toBeCloseTo(0.012);
  });

  it('captures BOTH legs (solver + judge) on the semantic path, cost summed', async () => {
    const runTaskFn = vi.fn(async (kind: string) => {
      if (kind === 'SolutionGenerateTask') {
        return { text: solverOutput('独立答案'), task_run_id: 'tr_solver', cost_usd: 0.01 };
      }
      if (kind === 'SemanticJudgeTask') {
        return { text: semanticOutput('correct', 0.9), task_run_id: 'tr_judge', cost_usd: 0.02 };
      }
      throw new Error(`unexpected task ${kind}`);
    });
    const result = await runSolveCheck(openQuestion, {
      runTaskFn,
      profile: fakeProfile,
      db: fakeDb,
    });
    expect(result.compared_by).toBe('semantic');
    expect(result.task_run_ids).toEqual(['tr_solver', 'tr_judge']);
    expect(result.cost_usd).toBeCloseTo(0.03);
  });

  it('omits provenance fields when the runner reports none ({ text }-only mock)', async () => {
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('公元前202年') }));
    const result = await runSolveCheck(exactQuestion, { runTaskFn, profile: fakeProfile });
    expect(result.task_run_ids).toBeUndefined();
    expect(result.cost_usd).toBeUndefined();
  });
});

describe('runSolveCheck — conservative non-fail behaviour (R2)', () => {
  it('returns unsupported (NOT fail) when the solver throws', async () => {
    const runTaskFn = vi.fn(async () => {
      throw new Error('solver outage');
    });
    const result = await runSolveCheck(exactQuestion, { runTaskFn, profile: fakeProfile });
    expect(result.verdict).toBe('unsupported');
    expect(result.compared_by).toBe('none');
  });

  it('returns unsupported when the solver output has no JSON', async () => {
    const runTaskFn = vi.fn(async () => ({ text: 'no json here' }));
    const result = await runSolveCheck(exactQuestion, { runTaskFn, profile: fakeProfile });
    expect(result.verdict).toBe('unsupported');
  });

  it('returns unsupported when the solver final_answer is empty', async () => {
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('') }));
    const result = await runSolveCheck(exactQuestion, { runTaskFn, profile: fakeProfile });
    expect(result.verdict).toBe('unsupported');
  });

  it('returns unsupported when the question has no reference answer — WITHOUT spending the solver call (EFF-3)', async () => {
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('x') }));
    const result = await runSolveCheck(
      { ...exactQuestion, reference_md: null },
      { runTaskFn, profile: fakeProfile },
    );
    expect(result.verdict).toBe('unsupported');
    // EFF-3 (YUK-554 review) — the no-reference check is hoisted before the solver call:
    // the verdict is 'unsupported' regardless, so the LLM call must not be spent.
    expect(runTaskFn).not.toHaveBeenCalled();
  });
});

describe('runSolveCheck — open path (SemanticJudge, conservative)', () => {
  // The injected runTaskFn handles BOTH the solver call and the SemanticJudge call;
  // dispatch on the task kind.
  function dispatch(solverAnswer: string, semantic: string) {
    return vi.fn(async (kind: string) => {
      if (kind === 'SolutionGenerateTask') return { text: solverOutput(solverAnswer) };
      if (kind === 'SemanticJudgeTask') return { text: semantic };
      throw new Error(`unexpected task ${kind}`);
    });
  }

  it('passes when SemanticJudge says correct', async () => {
    const runTaskFn = dispatch('学习并适时复习', semanticOutput('correct', 0.9));
    const result = await runSolveCheck(openQuestion, {
      runTaskFn,
      profile: fakeProfile,
      db: fakeDb,
    });
    expect(result.verdict).toBe('pass');
    expect(result.compared_by).toBe('semantic');
  });

  it('fails ONLY on a confident incorrect verdict', async () => {
    const runTaskFn = dispatch('完全无关的答案', semanticOutput('incorrect', 0.95));
    const result = await runSolveCheck(openQuestion, {
      runTaskFn,
      profile: fakeProfile,
      db: fakeDb,
    });
    expect(result.verdict).toBe('fail');
  });

  it('PASSES on an incorrect verdict BELOW the confidence threshold (宁漏过不误杀)', async () => {
    const lowConfidence = SOLVE_CHECK_SEMANTIC_THRESHOLD - 0.1;
    const runTaskFn = dispatch('有歧义的答案', semanticOutput('incorrect', lowConfidence));
    const result = await runSolveCheck(openQuestion, {
      runTaskFn,
      profile: fakeProfile,
      db: fakeDb,
    });
    expect(result.verdict).toBe('pass');
  });

  it('passes on a partial verdict regardless of confidence', async () => {
    const runTaskFn = dispatch('部分正确', semanticOutput('partial', 0.99));
    const result = await runSolveCheck(openQuestion, {
      runTaskFn,
      profile: fakeProfile,
      db: fakeDb,
    });
    expect(result.verdict).toBe('pass');
  });

  it('routes explicit keyword overrides through the conservative semantic path, not exact compare', async () => {
    const runTaskFn = dispatch('包含关键词的较长答案', semanticOutput('correct', 0.9));
    const result = await runSolveCheck(
      { ...exactQuestion, judge_kind_override: 'keyword' },
      { runTaskFn, profile: fakeProfile, db: fakeDb },
    );
    expect(result.verdict).toBe('pass');
    expect(result.compared_by).toBe('semantic');
    expect(runTaskFn).toHaveBeenCalledWith(
      'SemanticJudgeTask',
      expect.anything(),
      expect.anything(),
    );
  });

  it('is conservative (unsupported) for an open question when no db handle is passed', async () => {
    const runTaskFn = dispatch('x', semanticOutput('incorrect', 0.99));
    const result = await runSolveCheck(openQuestion, { runTaskFn, profile: fakeProfile });
    expect(result.verdict).toBe('unsupported');
    expect(result.compared_by).toBe('none');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// YUK-578 — teaching_quality VerifyCheck (入池前审题闸)
//
// MINI GOLDEN SET (校准纪律, aligns with YUK-573): these fixtures pin the parser +
// decision mapping for the three teaching-quality axes — 题干清晰度 / 唯一正解性 /
// 干扰项诊断力(仅选择题). Any change to the TeachingQualityTask prompt (registry.ts) or
// this output contract (tests/helpers/teaching-quality-fixtures.ts) MUST be re-validated
// against this set before shipping. mocked-LLM output drives parser + verdict + veto.
// ─────────────────────────────────────────────────────────────────────────────

const choiceQuestionTQ: TeachingQualityQuestion = {
  id: 'tq_choice',
  kind: 'choice',
  prompt_md: '「学而时习之」中「之」的词性是？',
  reference_md: '代词',
  choices_md: ['代词', '助词', '动词', '连词'],
  rubric_json: null,
};

const openQuestionTQ: TeachingQualityQuestion = {
  id: 'tq_open',
  kind: 'short_answer',
  prompt_md: '用你自己的话解释「之」作主谓间助词的作用。',
  reference_md: '「之」用在主谓之间，取消句子独立性。',
  choices_md: null,
  rubric_json: { required_points: ['取消句子独立性'] },
};

describe('teachingQualityBlocks (tier3/4 per-axis veto seam)', () => {
  const result = (axes: {
    clarity?: 'pass' | 'fail';
    unique?: 'pass' | 'fail';
    distractor?: 'pass' | 'fail' | 'skipped';
  }): TeachingQualityResult => {
    const clarity = axes.clarity ?? 'pass';
    const unique = axes.unique ?? 'pass';
    const distractor = axes.distractor ?? 'skipped';
    const anyFail = clarity === 'fail' || unique === 'fail' || distractor === 'fail';
    return {
      verdict: anyFail ? 'fail' : 'pass',
      clarity: { verdict: clarity, reason: 'c' },
      unique_answer: { verdict: unique, reason: 'u' },
      distractor_power: { verdict: distractor, reason: 'd' },
      reason: 'r',
    };
  };

  it('defaults to TEACHING_QUALITY_TIER34_VETO (all three axes veto a fail)', () => {
    expect(TEACHING_QUALITY_TIER34_VETO.clarity).toBe(true);
    expect(TEACHING_QUALITY_TIER34_VETO.unique_answer).toBe(true);
    expect(TEACHING_QUALITY_TIER34_VETO.distractor_power).toBe(true);
    expect(teachingQualityBlocks(result({ clarity: 'fail' }))).toBe(true);
    expect(teachingQualityBlocks(result({ unique: 'fail' }))).toBe(true);
    expect(teachingQualityBlocks(result({ distractor: 'fail' }))).toBe(true);
  });

  it('never blocks on a non-fail overall verdict (R2 conservative)', () => {
    expect(teachingQualityBlocks(result({}))).toBe(false); // all pass
    const unsupported: TeachingQualityResult = {
      verdict: 'unsupported',
      clarity: { verdict: 'skipped', reason: 'c' },
      unique_answer: { verdict: 'skipped', reason: 'u' },
      distractor_power: { verdict: 'skipped', reason: 'd' },
      reason: 'no signal',
    };
    expect(teachingQualityBlocks(unsupported)).toBe(false);
  });

  it('flag-off retreat: distractor_power:false lets a distractor fail through, keeping clarity/unique veto', () => {
    const flags = { clarity: true, unique_answer: true, distractor_power: false };
    // owner may downgrade the generalized distractor axis to report-only WITHOUT losing
    // the clarity/unique-answer gate (mirrors solve_check's per-axis switchability).
    expect(teachingQualityBlocks(result({ distractor: 'fail' }), flags)).toBe(false);
    expect(teachingQualityBlocks(result({ clarity: 'fail' }), flags)).toBe(true);
    expect(teachingQualityBlocks(result({ unique: 'fail' }), flags)).toBe(true);
  });

  it('clarity:false disables ONLY the clarity veto; other axes still block', () => {
    const flags = { clarity: false, unique_answer: true, distractor_power: true };
    expect(teachingQualityBlocks(result({ clarity: 'fail' }), flags)).toBe(false);
    expect(teachingQualityBlocks(result({ unique: 'fail' }), flags)).toBe(true);
  });
});

describe('runTeachingQualityCheck — mini golden set (parser + decision mapping)', () => {
  it('clear good question (all axes pass) → verdict pass', async () => {
    const runTaskFn = vi.fn(async () => ({ text: teachingQualityOutput({}) }));
    const result = await runTeachingQualityCheck(choiceQuestionTQ, {
      runTaskFn,
      profile: fakeProfile,
    });
    expect(result.verdict).toBe('pass');
    expect(result.clarity.verdict).toBe('pass');
    expect(result.unique_answer.verdict).toBe('pass');
    expect(result.distractor_power.verdict).toBe('pass');
    expect(teachingQualityBlocks(result)).toBe(false);
    expect(runTaskFn).toHaveBeenCalledWith(
      'TeachingQualityTask',
      expect.anything(),
      expect.anything(),
    );
  });

  it('ambiguous stem (clarity fail) → verdict fail, blocks promotion', async () => {
    const runTaskFn = vi.fn(async () => ({ text: teachingQualityOutput({ clarity: 'fail' }) }));
    const result = await runTeachingQualityCheck(choiceQuestionTQ, {
      runTaskFn,
      profile: fakeProfile,
    });
    expect(result.verdict).toBe('fail');
    expect(result.clarity.verdict).toBe('fail');
    expect(teachingQualityBlocks(result)).toBe(true);
  });

  it('a second plausible answer (unique_answer fail) → verdict fail, blocks promotion', async () => {
    const runTaskFn = vi.fn(async () => ({
      text: teachingQualityOutput({ uniqueAnswer: 'fail' }),
    }));
    const result = await runTeachingQualityCheck(choiceQuestionTQ, {
      runTaskFn,
      profile: fakeProfile,
    });
    expect(result.verdict).toBe('fail');
    expect(result.unique_answer.verdict).toBe('fail');
    expect(teachingQualityBlocks(result)).toBe(true);
  });

  it('choice question with no-diagnostic-power distractors (distractor fail) → verdict fail, flagged', async () => {
    const runTaskFn = vi.fn(async () => ({
      text: teachingQualityOutput({ distractorPower: 'fail' }),
    }));
    const result = await runTeachingQualityCheck(choiceQuestionTQ, {
      runTaskFn,
      profile: fakeProfile,
    });
    expect(result.verdict).toBe('fail');
    expect(result.distractor_power.verdict).toBe('fail');
    expect(teachingQualityBlocks(result)).toBe(true);
  });

  it('non-choice question SKIPS the distractor axis (code-side, even if the LLM emits a distractor fail)', async () => {
    // The LLM erroneously returns a distractor fail, but the question has no choices → the
    // code forces distractor_power to skipped, so it never contributes to the verdict.
    const runTaskFn = vi.fn(async () => ({
      text: teachingQualityOutput({ distractorPower: 'fail' }),
    }));
    const result = await runTeachingQualityCheck(openQuestionTQ, {
      runTaskFn,
      profile: fakeProfile,
    });
    expect(result.distractor_power.verdict).toBe('skipped');
    expect(result.verdict).toBe('pass');
    expect(teachingQualityBlocks(result)).toBe(false);
  });

  it('rubric tolerance declaration satisfies unique-answer (rubric threaded to the judge input)', async () => {
    const withTolerance: TeachingQualityQuestion = {
      ...openQuestionTQ,
      rubric_json: {
        required_points: ['取消句子独立性'],
        answer_equivalents: ['取独', '取消独立性'],
        tolerance_note: '任一等价表述均视为正解',
      },
    };
    // The judge sees the tolerance declaration and returns unique_answer=pass.
    const runTaskFn = vi.fn(async (_kind: string, _input: unknown, _ctx: unknown) => ({
      text: teachingQualityOutput({ uniqueAnswer: 'pass' }),
    }));
    const result = await runTeachingQualityCheck(withTolerance, {
      runTaskFn,
      profile: fakeProfile,
    });
    expect(result.verdict).toBe('pass');
    expect(result.unique_answer.verdict).toBe('pass');
    // the rubric (carrying the tolerance declaration) must reach the judge so it CAN honor it.
    const input = runTaskFn.mock.calls[0][1] as Record<string, unknown>;
    expect(input.rubric_json).toMatchObject({ tolerance_note: '任一等价表述均视为正解' });
  });

  it('choice question with an ABSENT distractor verdict → distractor skipped (non-blocking)', async () => {
    // choice question, but the LLM omitted distractor_power → do not fabricate a fail.
    const runTaskFn = vi.fn(async () => ({
      text: teachingQualityOutput({ distractorPower: null }),
    }));
    const result = await runTeachingQualityCheck(choiceQuestionTQ, {
      runTaskFn,
      profile: fakeProfile,
    });
    expect(result.distractor_power.verdict).toBe('skipped');
    expect(result.verdict).toBe('pass');
  });
});

describe('runTeachingQualityCheck — conservative non-blocking behaviour (R2)', () => {
  it('returns unsupported (NOT fail) when the task throws', async () => {
    const runTaskFn = vi.fn(async () => {
      throw new Error('teaching-quality outage');
    });
    const result = await runTeachingQualityCheck(choiceQuestionTQ, {
      runTaskFn,
      profile: fakeProfile,
    });
    expect(result.verdict).toBe('unsupported');
    expect(teachingQualityBlocks(result)).toBe(false);
  });

  it('returns unsupported when the output has no JSON object', async () => {
    const runTaskFn = vi.fn(async () => ({ text: 'no json here' }));
    const result = await runTeachingQualityCheck(choiceQuestionTQ, {
      runTaskFn,
      profile: fakeProfile,
    });
    expect(result.verdict).toBe('unsupported');
    // OCR (PR #716) — extractJsonObject's shared parse-failure error must name the CALLER
    // (check + task kind), not the solve_check call site it also serves. Regression guard
    // against the two call sites' labels being conflated again.
    expect(result.reason).toContain('teaching-quality: TeachingQualityTask');
    expect(result.reason).not.toContain('solve-check');
    expect(result.reason).not.toContain('SolutionGenerateTask');
  });

  it('returns unsupported when a mandatory axis (clarity/unique_answer) is missing', async () => {
    // A malformed output missing clarity → no trustworthy signal → unsupported, non-blocking.
    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({ unique_answer: { verdict: 'pass' }, summary: 's' }),
    }));
    const result = await runTeachingQualityCheck(choiceQuestionTQ, {
      runTaskFn,
      profile: fakeProfile,
    });
    expect(result.verdict).toBe('unsupported');
    expect(teachingQualityBlocks(result)).toBe(false);
  });

  it('captures task_run_id + cost_usd when the runner reports them', async () => {
    const runTaskFn = vi.fn(async () => ({
      text: teachingQualityOutput({}),
      task_run_id: 'tr_tq',
      cost_usd: 0.004,
    }));
    const result = await runTeachingQualityCheck(choiceQuestionTQ, {
      runTaskFn,
      profile: fakeProfile,
    });
    expect(result.task_run_ids).toEqual(['tr_tq']);
    expect(result.cost_usd).toBeCloseTo(0.004);
  });
});
