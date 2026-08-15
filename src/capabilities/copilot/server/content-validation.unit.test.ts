import { describe, expect, it } from 'vitest';

import {
  extractCopilotLearningContent,
  validateCopilotLearningContent,
} from './content-validation';

describe('validateCopilotLearningContent', () => {
  it('removes the machine-readable validation manifest from a direct reply', () => {
    const extracted = extractCopilotLearningContent(
      '题目草稿\n<!--copilot_learning_content:{"subject_id":"math","questions":[{"id":"q1","kind":"computation","prompt_md":"求 1+1","reference_md":"2","choices_md":null,"rubric_json":{}}]}-->',
    );

    expect(extracted.text).toBe('题目草稿');
    expect(extracted.content?.questions).toHaveLength(1);
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
      independent_solution: { status: 'solved' },
      teaching_quality: { verdict: 'fail' },
    });
  });
});
