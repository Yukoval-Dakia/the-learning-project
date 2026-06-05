import { describe, expect, it, vi } from 'vitest';

import {
  CHECK_SETS_BY_TIER,
  SOLVE_CHECK_SEMANTIC_THRESHOLD,
  type SolveCheckQuestion,
  checksForTier,
  normalizeAnswer,
  runSolveCheck,
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

function solverOutput(finalAnswer: string, equivalents: string[] = []): string {
  return JSON.stringify({
    reference_solution: {
      expected_signals: ['s'],
      final_answer: finalAnswer,
      answer_equivalents: equivalents,
    },
    worked_solution_md: 'work',
    confidence: 0.9,
  });
}

function semanticOutput(outcome: 'correct' | 'partial' | 'incorrect', confidence: number): string {
  return JSON.stringify({
    score: outcome === 'incorrect' ? 0 : outcome === 'partial' ? 0.5 : 0.9,
    coarse_outcome: outcome,
    confidence,
    feedback_md: 'fb',
    evidence_json: { matched_points: [], missing_points: [] },
  });
}

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
    expect(ctx.model).toBe('mimo-v2.5');
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

  it('returns unsupported when the question has no reference answer', async () => {
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('x') }));
    const result = await runSolveCheck(
      { ...exactQuestion, reference_md: null },
      { runTaskFn, profile: fakeProfile },
    );
    expect(result.verdict).toBe('unsupported');
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
