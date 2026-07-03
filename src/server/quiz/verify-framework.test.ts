import { describe, expect, it, vi } from 'vitest';

import {
  semanticJudgeOutput as semanticOutput,
  solverOutput,
} from '../../../tests/helpers/solve-check-fixtures';
import {
  CHECK_SETS_BY_TIER,
  SOLVE_CHECK_SEMANTIC_THRESHOLD,
  SOLVE_CHECK_TIER34_VETO,
  type SolveCheckQuestion,
  type SolveCheckResult,
  checksForTier,
  normalizeAnswer,
  runSolveCheck,
  solveCheckBlocks,
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

  it('tier 3 material requires material_grounding + solve_check + kind_conformance', () => {
    expect(checksForTier(3)).toEqual(
      expect.arrayContaining(['material_grounding', 'solve_check', 'kind_conformance']),
    );
  });

  it('tier 4 generated keeps legacy checks and adds kind_conformance + solve_check', () => {
    expect(checksForTier(4)).toEqual(
      expect.arrayContaining([
        'grounding',
        'copy_safety',
        'knowledge_hit',
        'kind_conformance',
        'solve_check',
      ]),
    );
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
