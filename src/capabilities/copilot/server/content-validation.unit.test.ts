import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY,
  containsLearningQuestion,
  copilotLearningContentRequiresValidation,
  extractCopilotLearningContent,
  reviewCopilotLearningContent,
} from './content-validation';
import { validateLearningContent as validatePreparedLearningContent } from './practice-port';

describe('validatePreparedLearningContent', () => {
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

  it.each(['是否已证明 P？', '是否已经证明 P？', '是否已经计算出本批指标？'])(
    'ignores completed instructional wording: %s',
    (reportQuestion) => {
      expect(containsLearningQuestion(reportQuestion)).toBe(false);
    },
  );

  it.each([
    '欧几里得证明了什么？',
    '小明计算了什么？',
    '他选择了哪个答案？',
    '谁已经证明这个命题？',
    '是否已证明了什么结论？',
  ])('keeps an unlabelled question about completed work protected: %s', async (text) => {
    expect(containsLearningQuestion(text)).toBe(true);
    const result = await reviewCopilotLearningContent(text, '', 'completed-work-question', {
      db: {} as never,
      runTaskFn: async () => {
        throw new Error('missing manifest must fail before paid validation');
      },
    });
    expect(result.passed).toBe(false);
  });

  it('keeps an active instruction after a multiline report question', () => {
    expect(containsLearningQuestion('是否已经证明 P？\n\n请计算 Q？')).toBe(true);
  });

  it('preserves the existing boundary for an embedded rhetorical question with prose after it', () => {
    expect(containsLearningQuestion('为什么选择这个方案？因为预算有限。')).toBe(false);
    expect(containsLearningQuestion('是否已证明 P？请证明 Q？')).toBe(true);
  });

  it.each([
    '请计算 2+2？答案是 4。',
    'Solve 2+2? The answer is 4.',
    '是否已证明 P？请计算 2+2？答案是 4。',
    'Can you solve 2+2? The answer is 5.',
    '你能计算 2+2 吗？答案是 5。',
    'Could you please prove this identity? The proof is below.',
    '请帮我判断这个答案正确吗？答案是正确。',
  ])('validates a direct instruction even with its answer on the same line: %s', async (text) => {
    expect(containsLearningQuestion(text)).toBe(true);
    let validatorCalls = 0;
    const result = await reviewCopilotLearningContent(text, '', 'inline-instruction-answer', {
      db: {} as never,
      runTaskFn: async () => {
        validatorCalls += 1;
        throw new Error('missing manifest must fail before paid validation');
      },
    });
    expect(result.passed).toBe(false);
    expect(validatorCalls).toBe(0);
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
    const result = await validatePreparedLearningContent(
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
                grounding: {
                  verdict: 'pass',
                  reason: 'self-contained',
                  basis: 'closed_world_givens',
                },
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
    const result = await validatePreparedLearningContent(
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

  it('forwards the turn’s executed remote tool evidence into the QuizVerify task input only when present', async () => {
    const manifest =
      '题目：求 1+1？\n<!--copilot_learning_content:{"subject_id":"math","questions":[{"id":"q1","kind":"computation","prompt_md":"求 1+1","reference_md":"2","choices_md":null,"rubric_json":{}}]}-->';
    const packet = [
      {
        tool_name: 'mcp__exa__web_search_exa',
        tool_use_id: 'call_9cea61a7cc314aa5a35c04a8',
        root_call: true,
        input: { query: 'derivative of e^x proof' },
        output: [{ type: 'text', text: 'Title: Proof…' }],
      },
    ];
    const quizInputs: Array<Record<string, unknown>> = [];
    const runTaskFn = async (kind: string, input: unknown) => {
      if (kind === 'QuizVerifyTask') {
        quizInputs.push(input as Record<string, unknown>);
        return {
          task_run_id: 'verify-evidence',
          text: JSON.stringify({
            grounding: { verdict: 'pass', basis: 'closed_world_givens', note: 'self-contained' },
            copy_safety: { verdict: 'original', max_overlap: 0 },
            knowledge_hit: { verdict: 'pass', note: 'on topic' },
            overall: 'pass',
            summary_md: 'structural checks pass',
            confidence: 0.9,
          }),
        };
      }
      if (kind === 'SolutionGenerateTask') {
        return {
          task_run_id: 'solve-evidence',
          text: JSON.stringify({
            reference_solution: {
              final_answer: '2',
              expected_signals: ['1+1'],
              answer_equivalents: ['2'],
            },
            worked_solution_md: '1+1=2',
            confidence: 0.99,
          }),
        };
      }
      if (kind === 'SemanticJudgeTask') {
        return {
          task_run_id: 'judge-evidence',
          text: JSON.stringify({
            score: 1,
            coarse_outcome: 'correct',
            confidence: 0.99,
            feedback_md: 'matches reference',
            evidence_json: { matched_points: [], missing_points: [] },
          }),
        };
      }
      return {
        task_run_id: 'teaching-evidence',
        text: JSON.stringify({
          clarity: { verdict: 'pass', reason: 'clear' },
          unique_answer: { verdict: 'pass', reason: 'unique' },
          summary: 'pass',
        }),
      };
    };

    const forwarded = await reviewCopilotLearningContent(manifest, '', 'evidence-forward', {
      db: {} as never,
      runTaskFn,
      remoteToolEvidence: packet,
    });
    expect(forwarded.passed).toBe(true);
    expect(quizInputs[0]?.remote_tool_evidence).toEqual(packet);

    const withoutEvidence = await reviewCopilotLearningContent(manifest, '', 'evidence-absent', {
      db: {} as never,
      runTaskFn,
    });
    expect(withoutEvidence.passed).toBe(true);
    expect(quizInputs[1]).not.toHaveProperty('remote_tool_evidence');
  });

  it('admits executed_remote_evidence content only with the executed packet, and never leaks an unreviewed candidate', async () => {
    const manifest =
      '题目：根据最新统计，2024 年全球可再生能源发电量占比约为多少？\n<!--copilot_learning_content:{"subject_id":"general","questions":[{"id":"q1","kind":"fill_blank","prompt_md":"根据最新统计，2024 年全球可再生能源发电量占比约为多少？","reference_md":"约 30%（IEA 2024 年报告口径）","choices_md":null,"rubric_json":{}}]}-->';
    const packet = [
      {
        tool_name: 'mcp__exa__web_search_exa',
        tool_use_id: 'call_renewables_2024',
        root_call: true,
        input: { query: '2024 global renewable electricity generation share IEA', numResults: 3 },
        output: [
          {
            type: 'text',
            text: 'Title: IEA Renewables 2024\nURL: https://example.org/iea-renewables-2024\nRenewable sources accounted for roughly 30% of global electricity generation in 2024.',
          },
        ],
      },
    ];
    const runTaskFn = async (kind: string, _input: unknown) => {
      if (kind === 'QuizVerifyTask') {
        return {
          task_run_id: 'verify-remote',
          text: JSON.stringify({
            grounding: {
              verdict: 'pass',
              basis: 'executed_remote_evidence',
              note: 'exa 返回的 IEA 2024 统计独立佐证了参考答案。',
            },
            copy_safety: { verdict: 'original', max_overlap: 0 },
            knowledge_hit: { verdict: 'pass', note: '考查可核验的统计事实' },
            overall: 'pass',
            summary_md: '远程检索佐证通过',
            confidence: 0.9,
          }),
        };
      }
      if (kind === 'SolutionGenerateTask') {
        return {
          task_run_id: 'solve-remote',
          text: JSON.stringify({
            reference_solution: {
              final_answer: '约 30%',
              expected_signals: ['可再生能源占比'],
              answer_equivalents: ['30%'],
            },
            worked_solution_md: '据 IEA 2024 口径约为 30%。',
            confidence: 0.9,
          }),
        };
      }
      if (kind === 'SemanticJudgeTask') {
        return {
          task_run_id: 'judge-remote',
          text: JSON.stringify({
            score: 1,
            coarse_outcome: 'correct',
            confidence: 0.95,
            feedback_md: 'solver answer matches the reference',
            evidence_json: { matched_points: ['约 30%'], missing_points: [] },
          }),
        };
      }
      return {
        task_run_id: 'teaching-remote',
        text: JSON.stringify({
          clarity: { verdict: 'pass', reason: '题干清晰' },
          unique_answer: { verdict: 'pass', reason: '答案唯一' },
          summary: 'pass',
        }),
      };
    };

    // Corroborated by the executed packet AND cleared by review → admitted,
    // and the candidate text is released.
    const admitted = await reviewCopilotLearningContent(manifest, '', 'evidence-admit', {
      db: {} as never,
      runTaskFn,
      remoteToolEvidence: packet,
    });
    expect(admitted.passed).toBe(true);
    expect(admitted.replyText).toContain('可再生能源发电量占比');
    expect(admitted.replyText).toContain('独立内容验证：通过');

    // Same judge claim but NO executed packet → basis unsupported → fail
    // closed, and the unreviewed candidate must not leak into the reply.
    const blocked = await reviewCopilotLearningContent(manifest, '', 'evidence-blocked', {
      db: {} as never,
      runTaskFn,
    });
    expect(blocked.passed).toBe(false);
    expect(blocked.replyText).toBe(COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY);
    expect(blocked.replyText).not.toContain('可再生能源发电量占比');
    expect(blocked.replyText).not.toContain('约 30%');
  });
});
