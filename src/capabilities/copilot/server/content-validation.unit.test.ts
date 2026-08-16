import { describe, expect, it } from 'vitest';

import {
  containsLearningQuestion,
  copilotLearningContentRequiresValidation,
  extractCopilotLearningContent,
  validateCopilotLearningContent,
} from './content-validation';

describe('validateCopilotLearningContent', () => {
  it('removes the machine-readable validation manifest from a direct reply', () => {
    const extracted = extractCopilotLearningContent(
      '题目草稿\n<!--copilot_learning_content:{"subject_id":"math","questions":[{"id":"q1","kind":"computation","prompt_md":"求 1+1","reference_md":"2","choices_md":null,"rubric_json":{}}]}-->',
    );

    expect(extracted.text).toBe('题目草稿');
    expect(extracted.status).toBe('valid');
    if (extracted.status !== 'valid') throw new Error('expected valid manifest');
    expect(extracted.content.questions).toHaveLength(1);
  });

  it('distinguishes missing and malformed manifests for question-bearing replies', () => {
    const missing = extractCopilotLearningContent('题目\n1. 求 1+1？');
    const malformed = extractCopilotLearningContent(
      '题目\n1. 求 1+1？\n<!--copilot_learning_content:{bad json}-->',
    );

    expect(containsLearningQuestion(missing.text)).toBe(true);
    expect(missing.status).toBe('absent');
    expect(malformed).toMatchObject({ status: 'malformed', text: '题目\n1. 求 1+1？' });
  });

  it('fails closed when a reply contains more than one learning-content marker', () => {
    const first =
      '<!--copilot_learning_content:{"subject_id":"math","questions":[{"id":"q1","kind":"computation","prompt_md":"求 1+1？","reference_md":"3","choices_md":null}]}-->';
    const second =
      '<!--copilot_learning_content:{"subject_id":"math","questions":[{"id":"q1","kind":"computation","prompt_md":"求 1+1？","reference_md":"2","choices_md":null}]}-->';

    const extracted = extractCopilotLearningContent(
      `题目\n1. 求 1+1？\n${first}\n修正如下。\n${second}`,
    );

    expect(extracted.status).toBe('malformed');
    expect(extracted.text).toBe('题目\n1. 求 1+1？\n\n修正如下。');
  });

  it('requires validation for an unlabeled multi-step equation solution', () => {
    const reply = '移项并逐步化简：\n2x + 3 = 11\n2x = 8\nx = 4';

    expect(copilotLearningContentRequiresValidation(reply)).toBe(true);
  });

  it('does not treat a lone configuration assignment as a learning solution', () => {
    const reply = '运行参数如下：\nversion = 4\n其余配置保持默认。';

    expect(copilotLearningContentRequiresValidation(reply)).toBe(false);
  });

  it('fails closed when an independent validator finds a contradictory question pack', async () => {
    const result = await validateCopilotLearningContent(
      {
        subjectId: 'math',
        questions: [
          {
            id: 'radius-rate',
            kind: 'computation',
            prompt_md: '放气时 r=2，dr/dt=+3，且 dS/dt=-48π。求 dV/dt，并说明答案唯一。',
            reference_md: 'dV/dt=+48π',
            choices_md: null,
            rubric_json: { criteria: ['符号与已知条件一致'] },
          },
        ],
      },
      {
        db: {} as never,
        runTaskFn: async (kind) => {
          if (kind === 'QuizVerifyTask') {
            return {
              task_run_id: 'verify-1',
              text: JSON.stringify({
                grounding: { verdict: 'pass', reason: 'self-contained' },
                copy_safety: { verdict: 'original', max_overlap: 0 },
                knowledge_hit: { verdict: 'pass', reason: 'on topic' },
                overall: 'pass',
                summary_md: 'structural checks pass',
                confidence: 0.9,
              }),
            };
          }
          if (kind === 'SolutionGenerateTask') {
            return {
              task_run_id: 'solve-1',
              text: JSON.stringify({
                reference_solution: {
                  final_answer: 'The givens are contradictory: dS/dt must be +48π.',
                  expected_signals: ['8πr dr/dt'],
                  answer_equivalents: [],
                },
                worked_solution_md: 'Substitute r=2 and dr/dt=3.',
                confidence: 0.99,
              }),
            };
          }
          if (kind === 'SemanticJudgeTask') {
            return {
              task_run_id: 'semantic-1',
              text: JSON.stringify({
                score: 0,
                coarse_outcome: 'incorrect',
                confidence: 0.99,
                feedback_md: 'declared answer contradicts the independent solution',
                evidence_json: { matched_points: [], missing_points: [] },
              }),
            };
          }
          return {
            task_run_id: 'teaching-1',
            text: JSON.stringify({
              clarity: { verdict: 'fail', reason: 'dS/dt contradicts dr/dt.' },
              unique_answer: { verdict: 'fail', reason: 'inconsistent givens.' },
              summary: 'reject',
            }),
          };
        },
      },
    );

    expect(result.verdict).toBe('fail');
    expect(result.items[0]).toMatchObject({
      solve_check: { verdict: 'fail' },
      teaching_quality: { verdict: 'fail' },
    });
  });

  it('fails closed without starting provider work when validation bounds are exceeded', async () => {
    let calls = 0;
    const result = await validateCopilotLearningContent(
      {
        subjectId: 'math',
        questions: Array.from({ length: 6 }, (_, index) => ({
          id: `q${index}`,
          kind: 'computation',
          prompt_md: '求 1+1',
          reference_md: '2',
          choices_md: null,
          rubric_json: {},
        })),
      },
      {
        db: {} as never,
        runTaskFn: async () => {
          calls += 1;
          throw new Error('must not run');
        },
      },
    );

    expect(result).toEqual({ verdict: 'fail', items: [] });
    expect(calls).toBe(0);
  });
});
