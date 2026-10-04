// YUK-1049 — Jev ModelUnitExecutorPort adapter unit tests (no DB).
//
// Only the wire transport is stubbed (fetchImpl); @/server/ai/log is mocked
// so lifecycle writers never touch Postgres — the REAL lifecycle state
// machine still drives admission/timeout/terminal accounting.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logMocks = vi.hoisted(() => ({
  started: vi.fn(async (_db: unknown, _row: unknown) => {}),
  terminal: vi.fn(async (_db: unknown, _row: unknown) => true),
  retried: vi.fn(async (_db: unknown, _id: string) => true),
  tool: vi.fn(async () => 'tool-log-id'),
}));

vi.mock('@/server/ai/log', () => ({
  writeAiTaskRunStarted: logMocks.started,
  writeAiTaskAttemptFinished: logMocks.terminal,
  writeAiTaskRunRetried: logMocks.retried,
  writeToolCallLog: logMocks.tool,
}));

import type {
  ModelExecutorRequest,
  ModelUnitOutcomeT,
  ScoringUnitT,
  SlotResponseT,
} from '@/core/schema/assessment';
import { createJevModelExecutor } from './jev-model-executor';

const DEADLINE = Date.now() + 60_000;

function textEntry(text: string): SlotResponseT {
  return { slot_id: 's1', kind: 'text', text_md: text };
}

function ruleUnit(overrides: Partial<ScoringUnitT> = {}): ScoringUnitT {
  return {
    scoring_unit_id: 'u1',
    slot_refs: ['s1'],
    material_refs: [],
    evidence_slot_refs: [],
    requires_group_evidence: false,
    criterion: {
      kind: 'rule_reference',
      rule_id: 'r1',
      statement_md: 'Award full marks when the final answer is 4.',
      source: 'official',
    },
    points: 5,
    ...overrides,
  };
}

function request(overrides: Partial<ModelExecutorRequest> = {}): ModelExecutorRequest {
  return {
    submission_id: 'sub_1',
    evaluation_group_id: 'grp_1',
    revision_id: 'rev_1',
    attempt: 1,
    scoring_unit_id: 'u1',
    executor: {
      kind: 'model_executor',
      task_kind: 'JevScoringDecisionTask',
      admitted_slice_id: 'slice_en_short_answer_v1',
    },
    unit: ruleUnit(),
    question_parts: [
      { part_id: 'p1', prompt_md: '解方程：2x+3=11，写出移项步骤。', material_ids: [] },
    ],
    response_slots: [{ slot_id: 's1', part_id: 'p1', kind: 'text', math_preview: true }],
    slot_responses: [textEntry('x = 4')],
    group_evidence: [],
    materials: [],
    spent_cost_usd_micros: 0,
    ...overrides,
  };
}

function responseJson(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

function jevOk(
  noul: number,
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number },
) {
  return {
    model: 'typesafe/jev-1.13-20260917',
    provider: 'TypeSafe',
    answers: { u1: { type: 'noul', noul } },
    ...(usage === undefined
      ? { usage: { input_tokens: 100, output_tokens: 8, cost: 4.2e-6 } }
      : { usage }),
  };
}

function executorOptions(overrides: Record<string, unknown> = {}) {
  return {
    db: {} as never,
    deadlineAt: DEADLINE,
    ruleThreshold: 0.8,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEY', 'test-or-key');
  logMocks.started.mockReset().mockResolvedValue(undefined);
  logMocks.terminal.mockReset().mockResolvedValue(true);
  logMocks.retried.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('createJevModelExecutor — admission boundaries', () => {
  it('unadmitted slice ⇒ unjudgeable pending, no wire call', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const port = createJevModelExecutor(executorOptions({ fetchImpl }));
    const out = await port(
      request({
        executor: {
          kind: 'model_executor',
          task_kind: 'JevScoringDecisionTask',
          admitted_slice_id: null,
        },
      }),
    );
    expect(out).toMatchObject({ kind: 'pending', pending: { reason: 'unjudgeable' } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logMocks.started).not.toHaveBeenCalled();
  });

  it('non-Jev task_kind ⇒ unjudgeable pending, no wire call', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const port = createJevModelExecutor(executorOptions({ fetchImpl }));
    const out = await port(
      request({
        executor: {
          kind: 'model_executor',
          task_kind: 'SemanticJudgeTask',
          admitted_slice_id: 's1',
        },
      }),
    );
    expect(out).toMatchObject({ kind: 'pending', pending: { reason: 'unjudgeable' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('missing OPENROUTER_API_KEY ⇒ advanced executor (separate invocation, same deadline)', async () => {
    vi.unstubAllEnvs();
    delete process.env.OPENROUTER_API_KEY;
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const advanced = vi.fn(
      async () =>
        ({
          kind: 'scored',
          points_awarded: 5,
          matched: { rule_id: 'r1', option_ids: [] },
          evidence_citations: [],
          run_refs: ['adv-run-1'],
        }) satisfies ModelUnitOutcomeT,
    );
    const port = createJevModelExecutor(executorOptions({ fetchImpl, advancedExecutor: advanced }));
    const out = await port(request());
    expect(out).toMatchObject({ kind: 'scored', points_awarded: 5 });
    expect(advanced).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logMocks.started).not.toHaveBeenCalled(); // no Jev attempt row
  });

  it('missing key + no advanced executor ⇒ explicit non-retryable infra_failure', async () => {
    vi.unstubAllEnvs();
    delete process.env.OPENROUTER_API_KEY;
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const port = createJevModelExecutor(executorOptions({ fetchImpl }));
    const out = await port(request());
    expect(out).toMatchObject({
      kind: 'pending',
      pending: { reason: 'infra_failure', retryable: false },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('unsupported criterion (deterministic territory) ⇒ escalate or unjudgeable', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const port = createJevModelExecutor(executorOptions({ fetchImpl }));
    const unit = ruleUnit({
      criterion: { kind: 'numeric_key', expected: 4, tolerance: { kind: 'absolute', value: 0 } },
    });
    const out = await port(request({ unit }));
    expect(out).toMatchObject({ kind: 'pending', pending: { reason: 'unjudgeable' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rule_reference without explicit ruleThreshold ⇒ unjudgeable (no invented default)', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const port = createJevModelExecutor(executorOptions({ fetchImpl, ruleThreshold: undefined }));
    const out = await port(request());
    expect(out).toMatchObject({ kind: 'pending', pending: { reason: 'unjudgeable' } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('attachment-bearing answers ⇒ advanced executor, never a text-only guess', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const advanced = vi.fn(
      async () =>
        ({
          kind: 'scored',
          points_awarded: 5,
          matched: { rule_id: 'r1', option_ids: [] },
          evidence_citations: [],
          run_refs: ['adv-run-1'],
        }) satisfies ModelUnitOutcomeT,
    );
    const port = createJevModelExecutor(executorOptions({ fetchImpl, advancedExecutor: advanced }));
    const openEntry: SlotResponseT = {
      slot_id: 's1',
      kind: 'open',
      text_md: 'see photo',
      evidence: [
        {
          evidence_id: 'ev1',
          kind: 'image',
          asset: { asset_id: 'a1', digest: 'sha256:x' },
          mime_type: 'image/png',
          bytes: 100,
          uploaded_at: '2026-09-26T00:00:00Z',
        },
      ],
    };
    const unit = ruleUnit({ slot_refs: ['s1'], evidence_slot_refs: ['s1'] });
    const out = await port(request({ unit, slot_responses: [openEntry] }));
    expect(out).toMatchObject({ kind: 'scored' });
    expect(advanced).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('createJevModelExecutor — Jev lane', () => {
  it('retains appeal context and the durable claimed run identity', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _options?: RequestInit) =>
      responseJson(jevOk(0.96)),
    );
    const review_context = {
      appeal_event_id: 'appeal_typed',
      prior_evaluation_id: 'eva_original',
      reason_md: 'Reconsider the unit conversion in the original work.',
    };
    const out = await createJevModelExecutor(
      executorOptions({ fetchImpl, taskRunId: 'assessment_claimed_typed' }),
    )(request({ review_context }));
    expect(out.run_refs).toEqual(['assessment_claimed_typed']);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).state.review_context).toEqual(
      review_context,
    );
  });
  it('rule_reference satisfied ⇒ scored with unit points, distribution-shape confidence', async () => {
    const fetchImpl = vi.fn(async () => responseJson(jevOk(0.96))) as unknown as typeof fetch;
    const port = createJevModelExecutor(executorOptions({ fetchImpl }));
    const out = await port(request());
    expect(out).toMatchObject({
      kind: 'scored',
      points_awarded: 5,
      matched: { rule_id: 'r1' },
    });
    // noul=0.96 ⇒ certainty |2·0.96−1| = 0.92 (YUK-1092: distribution-shape
    // certainty, 1 at the extremes / 0 at 0.5 — never its inverse).
    expect(out.kind === 'scored' && out.confidence).toBeCloseTo(0.92, 5);
    expect(out.run_refs[0]).toBeTruthy();
    expect(out.cost_usd_micros).toBe(Math.round(4.2e-6 * 1_000_000));
    const body = JSON.parse(
      String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]?.body),
    );
    expect(body.questions.u1.type).toBe('noul');
    expect(body.questions.u1.criteria.true).toContain('final answer is 4');
    expect(body.state.submission.entries[0].text_md).toBe('x = 4');
    expect(body.state.question).toEqual({
      revision_id: 'rev_1',
      parts: request().question_parts,
      response_slots: request().response_slots,
    });
  });

  it('rule_reference below threshold ⇒ scored 0 (real counter-evidence, not pending)', async () => {
    const fetchImpl = vi.fn(async () => responseJson(jevOk(0.1))) as unknown as typeof fetch;
    const port = createJevModelExecutor(executorOptions({ fetchImpl }));
    const out = await port(request());
    expect(out).toMatchObject({ kind: 'scored', points_awarded: 0 });
    expect(out.kind === 'scored' && out.matched).toBeUndefined();
  });

  it.each([
    { noul: 0, expected: 1 },
    { noul: 0.5, expected: 0 },
    { noul: 1, expected: 1 },
  ])(
    'fallback certainty is distribution shape |2·noul−1| — noul=$noul ⇒ $expected (YUK-1092)',
    async ({ noul, expected }) => {
      const fetchImpl = vi.fn(async () => responseJson(jevOk(noul))) as unknown as typeof fetch;
      const port = createJevModelExecutor(executorOptions({ fetchImpl }));
      const out = await port(request());
      expect(out.kind).toBe('scored');
      expect(out.kind === 'scored' && out.confidence).toBeCloseTo(expected, 10);
    },
  );

  it('holistic_level ⇒ score argmax picks matched.level_id, points stay null', async () => {
    const unit = ruleUnit({
      criterion: {
        kind: 'holistic_level',
        levels: [
          { level_id: 'L1', descriptor_md: 'weak', rank: 0 },
          { level_id: 'L2', descriptor_md: 'ok', rank: 1 },
          { level_id: 'L3', descriptor_md: 'strong', rank: 2 },
        ],
      },
      points: null,
      level_points: { L3: 6 },
    });
    const fetchImpl = vi.fn(async () =>
      responseJson({
        model: 'typesafe/jev-1.13-20260917',
        provider: 'TypeSafe',
        answers: {
          u1: {
            type: 'score',
            score: 1.7,
            probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 },
            confidence: 0.85,
          },
        },
        usage: { input_tokens: 90, output_tokens: 9, cost: 3.8e-6 },
      }),
    ) as unknown as typeof fetch;
    const port = createJevModelExecutor(executorOptions({ fetchImpl }));
    const out = await port(request({ unit }));
    expect(out).toMatchObject({
      kind: 'scored',
      points_awarded: null,
      matched: { level_id: 'L3' },
      confidence: 0.85,
    });
  });

  it('holistic_level without probabilities ⇒ expectation-derived level, no fabricated confidence', async () => {
    const unit = ruleUnit({
      criterion: {
        kind: 'holistic_level',
        levels: [
          { level_id: 'L1', descriptor_md: 'weak', rank: 0 },
          { level_id: 'L2', descriptor_md: 'ok', rank: 1 },
          { level_id: 'L3', descriptor_md: 'strong', rank: 2 },
        ],
      },
      points: null,
    });
    const fetchImpl = vi.fn(async () =>
      responseJson({
        model: 'typesafe/jev-1.13-20260917',
        provider: 'TypeSafe',
        answers: { u1: { type: 'score', score: 1.9 } },
        usage: { input_tokens: 90, output_tokens: 9, cost: 3.8e-6 },
      }),
    ) as unknown as typeof fetch;
    const port = createJevModelExecutor(executorOptions({ fetchImpl }));
    const out = await port(request({ unit }));
    expect(out).toMatchObject({ kind: 'scored', matched: { level_id: 'L3' } });
    expect(
      out.kind === 'scored' && 'confidence' in out ? out.confidence : undefined,
    ).toBeUndefined();
  });

  it('permanent Jev failure (401) ⇒ advanced fallback, else non-retryable pending', async () => {
    const fetchImpl = vi.fn(async () =>
      responseJson({ error: 'unauthorized' }, 401),
    ) as unknown as typeof fetch;
    const advanced = vi.fn(
      async () =>
        ({
          kind: 'scored',
          points_awarded: 0,
          matched: { rule_id: 'r1', option_ids: [] },
          evidence_citations: [],
          run_refs: ['adv-1'],
        }) satisfies ModelUnitOutcomeT,
    );
    const port = createJevModelExecutor(executorOptions({ fetchImpl, advancedExecutor: advanced }));
    const out = await port(request());
    expect(out).toMatchObject({ kind: 'scored' });
    expect(advanced).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no blind retry of 401

    const port2 = createJevModelExecutor(executorOptions({ fetchImpl }));
    const out2 = await port2(request());
    expect(out2).toMatchObject({
      kind: 'pending',
      pending: { reason: 'infra_failure', retryable: false },
    });
  });

  it('advanced fallback failure ⇒ retryable infra_failure (unit unjudged)', async () => {
    const fetchImpl = vi.fn(async () =>
      responseJson({ error: 'unauthorized' }, 401),
    ) as unknown as typeof fetch;
    const advanced = vi.fn(async () => {
      throw new Error('advanced lane exploded');
    });
    const port = createJevModelExecutor(executorOptions({ fetchImpl, advancedExecutor: advanced }));
    const out = await port(request());
    expect(out).toMatchObject({
      kind: 'pending',
      pending: { reason: 'infra_failure', retryable: true },
    });
  });

  it('typed response missing the unit answer ⇒ non-retryable infra_failure', async () => {
    const fetchImpl = vi.fn(async () =>
      responseJson({
        model: 'typesafe/jev-1.13-20260917',
        provider: 'TypeSafe',
        answers: {},
        usage: { input_tokens: 10, output_tokens: 1, cost: 4.2e-7 },
      }),
    ) as unknown as typeof fetch;
    const port = createJevModelExecutor(executorOptions({ fetchImpl }));
    const out = await port(request());
    expect(out).toMatchObject({
      kind: 'pending',
      pending: { reason: 'infra_failure', retryable: false },
    });
  });

  it('shared deadline ABORTS the advanced executor (signal passed, timer cancels — no silent overspend)', async () => {
    vi.unstubAllEnvs();
    delete process.env.OPENROUTER_API_KEY;
    let capturedSignal: AbortSignal | undefined;
    const advanced = vi.fn(
      (_request: ModelExecutorRequest, signal?: AbortSignal) =>
        new Promise<ModelUnitOutcomeT>((_resolve, reject) => {
          capturedSignal = signal;
          signal?.addEventListener('abort', () => reject(new Error('advanced aborted by signal')));
        }),
    );
    const port = createJevModelExecutor(
      executorOptions({ deadlineAt: Date.now() + 40, advancedExecutor: advanced }),
    );
    const out = await port(request());
    expect(advanced).toHaveBeenCalledTimes(1);
    expect(capturedSignal?.aborted).toBe(true);
    expect(out).toMatchObject({
      kind: 'pending',
      pending: { reason: 'infra_failure', retryable: true },
    });
  });

  it("caller's signal merges into the advanced executor's abort signal (pre-aborted ⇒ already aborted)", async () => {
    vi.unstubAllEnvs();
    delete process.env.OPENROUTER_API_KEY;
    const ac = new AbortController();
    ac.abort();
    let capturedSignal: AbortSignal | undefined;
    const advanced = vi.fn(async (_request: ModelExecutorRequest, signal?: AbortSignal) => {
      capturedSignal = signal;
      return {
        kind: 'scored',
        points_awarded: 5,
        matched: { rule_id: 'r1', option_ids: [] },
        evidence_citations: [],
        run_refs: ['adv'],
      } satisfies ModelUnitOutcomeT;
    });
    const port = createJevModelExecutor(
      executorOptions({ advancedExecutor: advanced, signal: ac.signal }),
    );
    await port(request());
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('shared deadline elapsed before advanced start ⇒ non-retryable pending', async () => {
    vi.unstubAllEnvs();
    delete process.env.OPENROUTER_API_KEY;
    const advanced = vi.fn(
      async () =>
        ({
          kind: 'scored',
          points_awarded: 5,
          matched: { rule_id: 'r1', option_ids: [] },
          evidence_citations: [],
          run_refs: ['adv'],
        }) satisfies ModelUnitOutcomeT,
    );
    const port = createJevModelExecutor(
      executorOptions({ deadlineAt: Date.now() - 1, advancedExecutor: advanced }),
    );
    const out = await port(request());
    expect(out).toMatchObject({
      kind: 'pending',
      pending: { reason: 'infra_failure', retryable: false },
    });
    expect(advanced).not.toHaveBeenCalled();
  });
});

describe('frozen question material visibility', () => {
  it.each(['figure', 'audio', 'video', 'pdf', 'passage', 'table', 'plaintext'] as const)(
    'requires an asset-capable executor for %s without readable original bytes',
    async (kind) => {
      const fetchImpl = vi.fn(async () => responseJson(jevOk(0.96))) as unknown as typeof fetch;
      const input = request({
        materials: [
          {
            material_id: 'source',
            kind,
            asset: { asset_id: 'original-asset', digest: 'sha256:frozen' },
            caption: '原图表或音频材料；此说明不是材料的完整内容。',
            alt_text: '对照材料作答',
            ...(['figure', 'audio', 'video', 'pdf'].includes(kind)
              ? { content_md: '只是标题或转写，不能替代原始图像/发音/时序。' }
              : {}),
          },
        ],
      });
      const unavailable = await createJevModelExecutor(executorOptions({ fetchImpl }))(input);
      expect
        .soft(unavailable)
        .toMatchObject({ kind: 'pending', pending: { reason: 'missing_materials' } });
      const advanced = vi.fn(
        async (): Promise<ModelUnitOutcomeT> => ({
          kind: 'pending',
          pending: {
            reason: 'needs_review',
            trigger: 'flagged',
            detail: 'Context transport fixture; no grading performed.',
          },
          run_refs: [],
        }),
      );
      await createJevModelExecutor(executorOptions({ fetchImpl, advancedExecutor: advanced }))(
        input,
      );
      expect.soft(advanced).toHaveBeenCalledWith(input, expect.any(AbortSignal));
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
  it('passes frozen inline text material bytes to Jev unchanged', async () => {
    const content =
      '|航段|距离|时间|\n|顺流|18 km|1 h|\n|逆流|12 km|1 h|\n静水速度按两式相加计算。';
    const fetchImpl = vi.fn(async () => responseJson(jevOk(0.96))) as unknown as typeof fetch;
    const input = request({
      materials: [
        {
          material_id: 'table',
          kind: 'table',
          asset: { asset_id: 'text-asset', digest: 'sha256:table' },
          content_md: content,
        },
      ],
    });
    const advanced = vi.fn();
    await createJevModelExecutor(executorOptions({ fetchImpl, advancedExecutor: advanced }))(input);
    const body = JSON.parse(
      String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]?.body),
    );
    expect(body.state.materials[0].content_md).toBe(content);
    expect(advanced).not.toHaveBeenCalled();
  });
});

describe('inline original images in frozen context', () => {
  const images = [
    '依据电路图判断方向。![原图](https://assets.example/circuit.png)',
    '依据电路图判断方向。![原图][circuit]\n\n[circuit]: https://assets.example/circuit.png "电路"',
    '依据电路图判断方向。![circuit][]\n\n[circuit]: /api/assets/circuit',
    '> 依据电路图判断方向。![circuit]\n\n[circuit]: /api/assets/circuit',
    '[![原图](/api/assets/circuit)](/api/assets/full)',
  ];
  it.each(['prompt', 'material', 'option'] as const)(
    'holds every rendered image form in %s before Jev, or delegates original context',
    async (location) => {
      for (const md of images) {
        const input = request();
        if (location === 'prompt') input.question_parts[0].prompt_md = md;
        if (location === 'material') {
          input.question_parts[0].material_ids = ['inline-circuit'];
          input.materials = [
            {
              material_id: 'inline-circuit',
              kind: 'plaintext',
              asset: { asset_id: 'text1', digest: 'sha256:abc' },
              content_md: md,
            },
          ];
        }
        if (location === 'option') {
          input.response_slots = [
            {
              slot_id: 's1',
              part_id: 'p1',
              kind: 'single_choice',
              options: [
                { option_id: 'opaque_a', label: 'A', text: md },
                { option_id: 'opaque_b', label: 'B', text: '电流逆时针' },
              ],
            },
          ];
          input.slot_responses = [{ slot_id: 's1', kind: 'choice', option_ids: ['opaque_a'] }];
        }
        const original = structuredClone(input);
        const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
          responseJson(jevOk(0.96)),
        );
        const out = await createJevModelExecutor(executorOptions({ fetchImpl }))(input);
        expect.soft(out.kind, `${location}: ${md}`).toBe('pending');
        const advanced = vi.fn(
          async (): Promise<ModelUnitOutcomeT> => ({
            kind: 'pending',
            pending: {
              reason: 'needs_review',
              trigger: 'flagged',
              detail: 'original image required',
            },
            run_refs: [],
          }),
        );
        await createJevModelExecutor(executorOptions({ fetchImpl, advancedExecutor: advanced }))(
          input,
        );
        expect.soft(advanced).toHaveBeenCalledWith(original, expect.any(AbortSignal));
        expect.soft(fetchImpl).not.toHaveBeenCalled();
        expect(input).toEqual(original);
      }
    },
  );
  it.each([
    '解释代码：`![示例](/image.png)`',
    '解释代码：\n\n```markdown\n![示例](/image.png)\n```',
    '解释代码：\n\n    ![示例](/image.png)',
    '转义语法：\\![示例](/image.png)',
    '未解析的引用：![missing]',
    '<img src="/image.png">', // Raw HTML is literal text in the project renderer.
    '[图片链接](/image.png)',
  ])('keeps literal Markdown text gradable: %s', async (md) => {
    const input = request();
    input.question_parts[0].prompt_md = md;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      responseJson(jevOk(0.96)),
    );
    const advanced = vi.fn();
    const out = await createJevModelExecutor(
      executorOptions({ fetchImpl, advancedExecutor: advanced }),
    )(input);
    expect(out.kind).toBe('scored');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(advanced).not.toHaveBeenCalled();
    expect(
      JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)).state.question.parts[0].prompt_md,
    ).toBe(md);
  });
});
