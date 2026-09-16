import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuestionAuthorDraft, normalizeAuthorStructured } from '@/core/schema/question_author';
import type { QuizVerificationResultT } from '@/core/schema/quiz_gen';
import { knowledge } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { validateLearningContent } from './learning-content-validation';

beforeEach(async () => {
  await resetDb();
  await testDb().insert(knowledge).values({
    id: 'k_distribution',
    name: '整数乘法与分配律',
    domain: 'math',
    created_at: new Date(),
    updated_at: new Date(),
  });
});

function candidate() {
  const draft = QuestionAuthorDraft.parse({
    kind: 'computation',
    difficulty: 1,
    knowledge_ids: ['k_distribution'],
    structured: {
      id: 'author-placeholder',
      role: 'standalone',
      prompt_text: '利用分配律计算 104×5，并解释各项的意义。',
      answers: ['520'],
      analysis: '104×5=(100+4)×5=100×5+4×5=500+20=520。分配律保留每个加项的乘数5。',
    },
    rubric_json: {
      criteria: [{ name: 'distribution', weight: 1, descriptor: '正确拆分、分别相乘并合并' }],
      required_points: ['拆分104', '分别乘5', '合并结果'],
    },
    choices_md: null,
  });
  const normalized = normalizeAuthorStructured(draft.structured);
  return {
    content: {
      subjectId: 'math',
      questions: [
        {
          id: 'preview-1',
          kind: draft.kind,
          prompt_md: normalized.prompt_md,
          reference_md: normalized.reference_md,
          choices_md: null,
          knowledge_ids: draft.knowledge_ids,
          rubric_json: draft.rubric_json,
        },
      ],
    },
    observedQuestion: {
      input: {
        seed_mode: 'knowledge',
        knowledge_ids: ['k_distribution'],
        requested_kind: 'computation',
        difficulty: 1,
      },
      output: {
        text: JSON.stringify(draft),
        subject_id: 'math',
        task_run_id: 'author-1',
        cost_usd: null,
        cost_basis: 'unknown',
        cost_ref: 'not_invoiced',
        finish_reason: 'end_turn',
      },
    },
  };
}

const contentResult: QuizVerificationResultT = {
  grounding: {
    verdict: 'pass',
    basis: 'closed_world_givens',
    note: '可以直接用分配律检验104×5=520；不依赖外部事实。',
  },
  knowledge_hit: { verdict: 'pass', note: '实际知识范围是整数乘法与分配律。' },
  copy_safety: { verdict: 'unknown' },
  overall: 'needs_review',
  summary_md: '计算及知识命中通过；没有来源比较语料，原创性未观测。',
  confidence: 0.99,
};

// YUK-993 — a realistic RemoteMcpEvidencePacket entry: one actually executed
// remote-MCP search call of this turn (reply-finalization.ts capture shape),
// long enough and structured like a real Exa response so the corroboration the
// gate relies on is exercised end-to-end, not on a stub.
function remoteEvidencePacket() {
  return [
    {
      tool_name: 'mcp__exa__web_search_exa',
      tool_use_id: 'call_distributive_law_lookup',
      root_call: true,
      input: { query: '乘法分配律 整数 a×(b+c)=a×b+a×c 定义', numResults: 3 },
      output: [
        {
          type: 'text',
          text: 'Title: 乘法分配律 — 数学百科\nURL: https://example.edu/wiki/distributive_law\n对于任意整数 a、b、c，a×(b+c)=a×b+a×c。例：104×5=(100+4)×5=500+20=520。分配律保持每个加项被同一乘数相乘。',
        },
        {
          type: 'text',
          text: 'Title: Distributive property over integer addition\nURL: https://example.edu/ref/distributive\nThe distributive law a(b+c)=ab+ac holds in any ring, including the integers.',
        },
      ],
    },
  ];
}

function runner(result: QuizVerificationResultT) {
  return vi.fn(async (kind: string, _input: unknown) => {
    if (kind === 'QuizVerifyTask') return { text: JSON.stringify(result), task_run_id: 'verify-1' };
    if (kind === 'SolutionGenerateTask')
      return {
        text: JSON.stringify({
          reference_solution: {
            final_answer: '520',
            expected_signals: ['104=100+4', '分别乘5再相加'],
            answer_equivalents: [],
          },
          worked_solution_md: '(100+4)×5=500+20=520。',
          confidence: 0.99,
        }),
        task_run_id: 'solve-1',
      };
    if (kind === 'SemanticJudgeTask')
      return {
        text: JSON.stringify({
          score: 1,
          coarse_outcome: 'correct',
          confidence: 0.99,
          feedback_md: '独立解法和答案等价',
          evidence_json: { matched_points: ['分配律', '520'], missing_points: [] },
        }),
        task_run_id: 'compare-1',
      };
    if (kind === 'TeachingQualityTask')
      return {
        text: JSON.stringify({
          clarity: { verdict: 'pass', reason: '条件完整' },
          unique_answer: { verdict: 'pass', reason: '整数乘法答案唯一' },
          summary: '适合检验分配律',
        }),
        task_run_id: 'teach-1',
      };
    throw new Error(`unexpected task ${kind}`);
  });
}

describe('Practice learner-visible release policy', () => {
  it('admits confirmed closed-book content without claiming unobserved originality or changing the pool verdict', async () => {
    const fixture = candidate();
    const runTaskFn = runner(contentResult);
    const result = await validateLearningContent(fixture.content, {
      db: testDb(),
      runTaskFn,
      observedQuestion: fixture.observedQuestion,
    });
    expect(result).toMatchObject({
      verdict: 'pass',
      copy_comparison: 'not_observed',
      items: [{ question_content: { overall: 'needs_review', admitted: true } }],
    });
    expect(contentResult.copy_safety.verdict).toBe('unknown');
    const verifyInput = runTaskFn.mock.calls.find(([kind]) => kind === 'QuizVerifyTask')?.[1];
    expect(verifyInput).toMatchObject({
      knowledge_context: [{ id: 'k_distribution', name: '整数乘法与分配律' }],
      generation_method: 'closed_book',
      validation_mode: 'release_strict',
      validation_purpose: 'learning_content',
      source_refs: [],
      self_copy_safety: null,
    });
    expect(runTaskFn.mock.calls).toHaveLength(4);
  });

  it('admits executed_remote_evidence content when the forwarded calls corroborate and review passes', async () => {
    const fixture = candidate();
    const remoteToolEvidence = remoteEvidencePacket();
    const runTaskFn = runner({
      ...contentResult,
      grounding: {
        verdict: 'pass',
        basis: 'executed_remote_evidence',
        note: 'exa 返回的分配律定义与 104×5 例证独立佐证了题面解法方向。',
      },
      copy_safety: { verdict: 'original', max_overlap: 0.02 },
      overall: 'pass',
      summary_md: '远程检索返回佐证事实；措辞与检索结果不重合。',
    });
    const result = await validateLearningContent(fixture.content, {
      db: testDb(),
      runTaskFn,
      observedQuestion: fixture.observedQuestion,
      remoteToolEvidence,
    });
    expect(result).toMatchObject({
      verdict: 'pass',
      items: [{ question_content: { overall: 'pass', admitted: true } }],
    });
    const verifyInput = runTaskFn.mock.calls.find(([kind]) => kind === 'QuizVerifyTask')?.[1];
    expect(verifyInput).toMatchObject({
      remote_tool_evidence: remoteToolEvidence,
      validation_purpose: 'learning_content',
      validation_mode: 'release_strict',
    });
  });

  it.each([
    ['no evidence was forwarded', undefined],
    ['the forwarded packet is empty', []],
    // Codex PR #1407 P1 — the packet lists FAILED calls too (failure entries
    // carry no output); a failures-only packet corroborates nothing, so the
    // basis stays unsupported even though the array is non-empty.
    [
      'every forwarded call failed (failure entries only)',
      [
        {
          tool_name: 'mcp__exa__web_search_exa',
          tool_use_id: 'call_failed_lookup',
          root_call: true,
          input: { query: '乘法分配律 定义', numResults: 3 },
          failure: { error: 'exa request timed out', is_interrupt: false },
        },
      ],
    ],
  ] satisfies Array<[string, unknown]>)(
    'blocks executed_remote_evidence basis when %s',
    async (_name, remoteToolEvidence) => {
      const fixture = candidate();
      const result = await validateLearningContent(fixture.content, {
        db: testDb(),
        runTaskFn: runner({
          ...contentResult,
          grounding: {
            verdict: 'pass',
            basis: 'executed_remote_evidence',
            note: '声称由远程检索佐证，但本输入没有对应执行证据。',
          },
          copy_safety: { verdict: 'original', max_overlap: 0 },
          overall: 'pass',
          summary_md: 'judge claims remote grounding without a packet.',
        }),
        observedQuestion: fixture.observedQuestion,
        ...(remoteToolEvidence !== undefined ? { remoteToolEvidence } : {}),
      });
      expect(result.verdict).toBe('fail');
      expect(result.items[0]).toMatchObject({
        question_content: { status: 'completed', admitted: false },
      });
    },
  );

  it('does not leak a remote-evidence candidate the review left unresolved', async () => {
    // Judge corroborated the facts against the executed calls but could NOT clear
    // originality (copy_safety 'unknown' + overall 'needs_review'). Because a
    // non-empty packet WAS in context, this must not ride the source-free
    // copyOnlyReview passthrough — the unreviewed candidate stays unadmitted.
    const fixture = candidate();
    const result = await validateLearningContent(fixture.content, {
      db: testDb(),
      runTaskFn: runner({
        ...contentResult,
        grounding: {
          verdict: 'pass',
          basis: 'executed_remote_evidence',
          note: '检索输出佐证事实断言。',
        },
        summary_md: '事实由本轮检索佐证；与检索文本的原创性比对未裁决。',
      }),
      observedQuestion: fixture.observedQuestion,
      remoteToolEvidence: remoteEvidencePacket(),
    });
    expect(result.verdict).toBe('fail');
    expect(result.items[0]?.question_content).toMatchObject({
      status: 'completed',
      overall: 'needs_review',
      admitted: false,
    });
  });

  it.each([
    ['missing basis', { ...contentResult, grounding: { verdict: 'pass', note: 'no basis' } }],
    [
      'unsupported source refs',
      {
        ...contentResult,
        grounding: { verdict: 'pass', basis: 'source_refs', note: 'no actual refs' },
      },
    ],
    [
      'unsupported material',
      {
        ...contentResult,
        grounding: { verdict: 'pass', basis: 'material', note: 'no actual material' },
      },
    ],
    [
      'insufficient facts',
      {
        ...contentResult,
        grounding: { verdict: 'unclear', basis: 'insufficient', note: '无法核对具体引文' },
      },
    ],
    [
      'too close despite overall pass',
      { ...contentResult, copy_safety: { verdict: 'too_close' }, overall: 'pass' },
    ],
    [
      'failed grounding despite overall pass',
      {
        ...contentResult,
        grounding: { verdict: 'fail', basis: 'discipline_knowledge', note: '引文与真实作品冲突' },
        overall: 'pass',
      },
    ],
    [
      'uncertain knowledge',
      { ...contentResult, knowledge_hit: { verdict: 'unclear', note: '不在已知范围' } },
    ],
    ['failed overall', { ...contentResult, overall: 'fail' }],
    ['inconsistent copy unknown with overall pass', { ...contentResult, overall: 'pass' }],
  ] satisfies Array<[string, QuizVerificationResultT]>)('blocks %s', async (_name, output) => {
    const fixture = candidate();
    expect(
      (
        await validateLearningContent(fixture.content, {
          db: testDb(),
          runTaskFn: runner(output),
          observedQuestion: fixture.observedQuestion,
        })
      ).verdict,
    ).toBe('fail');
  });

  it.each(['changed visible answer', 'wrong subject', 'missing source material'])(
    'rejects %s before any paid validation',
    async (name) => {
      const fixture = candidate();
      const runTaskFn = runner(contentResult);
      if (name === 'changed visible answer') fixture.content.questions[0].reference_md = '521';
      if (name === 'wrong subject') fixture.observedQuestion.output.subject_id = 'yuwen';
      if (name === 'missing source material') fixture.observedQuestion.input.seed_mode = 'material';
      expect(
        await validateLearningContent(fixture.content, {
          db: testDb(),
          runTaskFn,
          observedQuestion: fixture.observedQuestion,
        }),
      ).toEqual({ verdict: 'fail', items: [] });
      expect(runTaskFn).not.toHaveBeenCalled();
    },
  );

  it('does not infer a source-free generation from a client-shaped question alone', async () => {
    const fixture = candidate();
    expect(
      (
        await validateLearningContent(fixture.content, {
          db: testDb(),
          runTaskFn: runner(contentResult),
        })
      ).verdict,
    ).toBe('fail');
  });

  it.each(['pass', 'fail'] as const)(
    'uses the real bound material and requires its grounding to %s',
    async (verdict) => {
      const fixture = candidate();
      const body =
        '仓库记录：共有104箱，每箱装5件。用分配律把104拆为100与4，分别计算再相加，可以核对总数520。';
      const observedQuestion = {
        ...fixture.observedQuestion,
        input: {
          ...fixture.observedQuestion.input,
          seed_mode: 'material',
          material_body_md: body,
          material_title: '仓库记录',
          material_answer_anchor: {
            canonical_answer: { kind: 'text', value: '520' },
            locator: {
              kind: 'text_span',
              start: 0,
              end: new TextEncoder().encode(body).length,
              exact_text: body,
            },
          },
        },
      };
      const runTaskFn = runner({
        ...contentResult,
        grounding: { verdict: 'pass', basis: 'material', note: '依据实际记录计算' },
        copy_safety: { verdict: 'original' },
        material_grounding: { verdict, note: '检查题目与实际材料关联' },
        overall: 'pass',
      });
      const result = await validateLearningContent(fixture.content, {
        db: testDb(),
        runTaskFn,
        observedQuestion,
      });
      expect(result.verdict).toBe(verdict);
      expect(runTaskFn.mock.calls.find(([kind]) => kind === 'QuizVerifyTask')?.[1]).toMatchObject({
        material: { title: '仓库记录', body_md: body },
        source_refs: [],
        generation_method: 'material_grounded',
      });
    },
  );
});
