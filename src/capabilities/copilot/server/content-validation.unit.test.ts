import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  containsLearningQuestion,
  copilotLearningContentRequiresValidation,
  extractCopilotLearningContent,
  reviewCopilotLearningContent,
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

  it('does not classify completed report claims as learning questions', () => {
    const report = '### A01：是否已证明无跨 subject 的后续 probe / review？';

    expect(containsLearningQuestion(report)).toBe(false);
    expect(copilotLearningContentRequiresValidation(report)).toBe(false);
  });

  it('accepts the versioned real report without invoking a learning validator', async () => {
    const evidence = JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'docs/planning/evidence/2026-09-06-claim-context-actual.json'),
        'utf8',
      ),
    ) as { records: Array<{ exact_head: string; cases: Array<{ terminal_output: string }> }> };
    const report = evidence.records.find(
      (record) => record.exact_head === 'a1f72e94ca803b61576fa01a17e80420b96f63a6',
    )?.cases[0]?.terminal_output;
    expect(report).toBeTruthy();

    let validatorCalls = 0;
    const result = await reviewCopilotLearningContent(report ?? '', '', 'report-960', {
      db: {} as never,
      runTaskFn: async () => {
        validatorCalls += 1;
        throw new Error('report must not invoke learning validation');
      },
    });

    expect(result).toEqual({ replyText: report, passed: true });
    expect(validatorCalls).toBe(0);
  });

  it('keeps a real teaching instruction when it follows a completed report claim', () => {
    const mixed = '是否已证明 P？请证明 Q？';

    expect(containsLearningQuestion(mixed)).toBe(true);
    expect(copilotLearningContentRequiresValidation(mixed)).toBe(true);
  });

  it.each(['是否已证明 P？', '是否已经证明 P？', '这个结论证明了？'])(
    'ignores completed instructional wording: %s',
    (reportQuestion) => {
      expect(containsLearningQuestion(reportQuestion)).toBe(false);
    },
  );

  it('keeps an active instruction after a multiline report question', () => {
    expect(containsLearningQuestion('是否已经证明 P？\n\n请计算 Q？')).toBe(true);
  });

  it('does not let completed wording bypass explicit question protections', () => {
    expect(containsLearningQuestion('题目：是否已证明 P？')).toBe(true);
    expect(containsLearningQuestion('1. 是否已证明 P？')).toBe(true);
  });

  it('keeps HTML assessments protected even when visible prose is a report', async () => {
    let validatorCalls = 0;
    const result = await reviewCopilotLearningContent('是否已证明 P？', '', 'html-assessment-960', {
      db: {} as never,
      additionalVisibleText: '<p>答案：323</p>',
      runTaskFn: async () => {
        validatorCalls += 1;
        throw new Error('manifest-free assessment must fail before provider work');
      },
    });

    expect(result.passed).toBe(false);
    expect(validatorCalls).toBe(0);
  });

  it.each(['证明 1+1=2？', '请计算三角形面积？', '能否证明这个命题？'])(
    'keeps active instructional questions: %s',
    (question) => {
      expect(containsLearningQuestion(question)).toBe(true);
    },
  );

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

  it('does not treat configuration assignments or a factual numeric table as a solution', () => {
    const reply = [
      '运行参数：',
      'version = 4',
      'timeout = 30',
      '',
      '| 套餐 | 价格 |',
      '| --- | ---: |',
      '| 基础版 | 20 |',
      '| 专业版 | 50 |',
    ].join('\n');

    expect(copilotLearningContentRequiresValidation(reply)).toBe(false);
  });

  it('does not mistake a diagnostic step count in table data for a computation header', () => {
    const reply = [
      '已读取两个 probe 的直接子事件；未查询孙代，不能裁决整条链是否终止。',
      '| 维度 | Chain B | Chain C |',
      '| --- | --- | --- |',
      '| downstream child 1 | intervention_preparation_failed (seq=31) | intervention_activated (seq=38), 3-step diagnostics |',
      '| downstream child 2 | prediction_score (seq=46) | prediction_score (seq=47) |',
      '隐藏字段不支持完全同构或唯一差异；当前 due 行为 0，但 queued/in_progress 均未观测。',
    ].join('\n');

    expect(copilotLearningContentRequiresValidation(reply)).toBe(false);
  });

  it.each(['迭代步数', 'Step', 'Iteration'])(
    'requires validation for a numeric %s table',
    (label) => {
      const reply = [`| ${label} | x |`, '| --- | ---: |', '| 1 | 0.5 |', '| 2 | 0.25 |'].join(
        '\n',
      );

      expect(copilotLearningContentRequiresValidation(reply)).toBe(true);
    },
  );

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
