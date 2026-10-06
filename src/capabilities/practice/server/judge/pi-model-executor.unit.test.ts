import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  GroupEvidence,
  QuestionPart,
  ResponseSlot,
  ScoringUnit,
  SlotResponse,
} from '@/core/schema/assessment';
import { AssessmentRuleDecision } from '@/core/schema/assessment/model-decision';
import type { Db } from '@/db/client';
import { AgentRunError } from '@/server/ai/agent-run-error';
import type { RunTaskCtx, RunTaskResult } from '@/server/ai/runner';
import { prepareAssessmentModelInput } from '@/server/assessment/assessment-model-assets';
import { createPiModelExecutor } from '@/server/assessment/pi-model-executor';
import {
  assessmentDigest as digest,
  nativeAssessmentFixture as fixture,
} from '../../../../../tests/fixtures/assessment-native-model';

import synth18 from '../../../../../tests/fixtures/yuk1323-synth18.json';

const db = { $client: {} } as unknown as Db;
const signal = () => new AbortController().signal;
const decision = () => ({
  kind: 'rule',
  rule_id: 'r1',
  points_awarded: 5,
  confidence: 0.97,
  feedback_md: '相加消去水速，单位正确。',
  evidence_citations: [{ slot_id: 's1', quote: '相加得2v=30' }],
});
function result(output: unknown, cost: number | undefined = 0.004): RunTaskResult {
  return {
    task_run_id: 'run-native',
    text: JSON.stringify(output),
    finishReason: 'success',
    usage: { inputTokens: 240, outputTokens: 32 },
    cost_usd: cost,
    cost_basis: cost === undefined ? 'unknown' : 'estimated',
    cost_ref: 'pi-catalog:xiaomi/mimo-v2.5',
  };
}
function setup(output: unknown = decision()) {
  const runTask = vi.fn(async (_kind: string, _input: unknown, ctx: RunTaskCtx) => {
    await ctx.beforeProviderQuery?.({
      taskRunId: ctx.taskRunId ?? '',
      provider: 'xiaomi',
      model: 'mimo-v2.5',
    });
    return result(output);
  });
  const loadAsset = vi.fn(async () => null);
  const options = {
    db,
    deadlineAt: Date.now() + 30_000,
    maxCostUsdMicros: 20_000,
    runTask,
    loadAsset,
  };
  return { options, runTask, loadAsset, port: createPiModelExecutor(options) };
}

describe('native frozen rule execution', () => {
  it('passes the appeal claim separately from the unchanged answer and uses its persisted run identity', async () => {
    const { options, runTask } = setup();
    const input = fixture();
    input.review_context = {
      appeal_event_id: 'appeal_native',
      prior_evaluation_id: 'eva_original',
      reason_md: '请检查原推导中的量纲，不能将这句话当作新答案。',
    };
    await createPiModelExecutor({ ...options, taskRunId: 'assessment_claimed_run' })(input);
    const payload = JSON.parse((runTask.mock.calls[0][1] as { text: string }).text);
    expect(payload.review_context).toEqual(input.review_context);
    expect(payload.slot_responses).toEqual(input.slot_responses);
    expect(runTask.mock.calls[0][2].taskRunId).toBe('assessment_claimed_run');
  });
  it('carries original joint identity, full frozen context and a shared deadline through the native task', async () => {
    const { port, runTask, loadAsset, options } = setup();
    const input = fixture();
    const original = structuredClone(input);
    const out = await port(input);
    expect(out).toMatchObject({
      kind: 'scored',
      points_awarded: 5,
      matched: { rule_id: 'r1' },
      cost_usd_micros: 4000,
      run_refs: ['run-native'],
    });
    const [kind, payload, ctx] = runTask.mock.calls[0];
    expect(kind).toBe('AssessmentRuleJudgeTask');
    expect(payload).toMatchObject({ images: [] });
    const wire = JSON.parse((payload as { text: string }).text);
    expect(wire).toMatchObject({
      submission_ids: original.submission_ids,
      revision_id: original.revision_id,
      scoring_unit: original.unit,
      question_parts: original.question_parts,
      response_slots: original.response_slots,
      slot_responses: original.slot_responses,
      materials: original.materials,
    });
    expect(ctx.providerSessionDeadlineAt).toBe(options.deadlineAt);
    expect(ctx.modelBinding).toBeUndefined(); // normal native task/provider resolution remains authoritative
    expect(ctx.enableTransientRetry).toBeUndefined();
    expect(loadAsset).not.toHaveBeenCalled();
    expect(input).toEqual(original);
  });
  it('preserves explicit published partial credit without a normalized score clamp', async () => {
    const { port } = setup({ ...decision(), points_awarded: 2 });
    expect(await port(fixture())).toMatchObject({ kind: 'scored', points_awarded: 2 });
  });
  it('keeps a holistic level ordinal-only and refuses invented points', async () => {
    const input = fixture();
    input.unit.points = null;
    input.unit.criterion = {
      kind: 'holistic_level',
      levels: [
        { level_id: 'L1', rank: 0, descriptor_md: '只列方程' },
        { level_id: 'L2', rank: 1, descriptor_md: '完整推导和单位' },
      ],
    };
    const { points_awarded: _points, rule_id: _rule, ...support } = decision();
    const { port } = setup({ ...support, kind: 'level', level_id: 'L2' });
    expect(await port(input)).toMatchObject({
      kind: 'scored',
      points_awarded: null,
      matched: { level_id: 'L2' },
    });
    expect(
      await setup({ ...support, kind: 'level', level_id: 'L2', points_awarded: 5 }).port(input),
    ).toMatchObject({ kind: 'pending', cost_usd_micros: 4000, run_refs: ['run-native'] });
  });
  it.each([
    { ...decision(), rule_id: 'invented-rule' },
    { ...decision(), points_awarded: 6 },
    { ...decision(), evidence_citations: [{ slot_id: 'unissued-slot' }] },
    { ...decision(), evidence_citations: [{ evidence_id: 'unsubmitted-photo' }] },
    { ...decision(), evidence_citations: [{ slot_id: 's1', quote: '伪造的引语' }] },
    { ...decision(), evidence_citations: [{}] },
    { ...decision(), evidence_citations: [] },
    { ...decision(), weights: { invented: 0.5 } },
  ])(
    'holds unsupported model evidence/score without losing paid provenance: %j',
    async (output) => {
      const { port } = setup(output);
      expect(await port(fixture())).toMatchObject({
        kind: 'pending',
        cost_usd_micros: 4000,
        run_refs: ['run-native'],
      });
    },
  );
  it('uses explicit pending instead of a zero score', async () => {
    expect(
      await setup({ kind: 'pending', detail: '无法区分手写的正负号' }).port(fixture()),
    ).toMatchObject({
      kind: 'pending',
      pending: { reason: 'insufficient_evidence' },
      run_refs: ['run-native'],
    });
  });
  it.each(['unadmitted', 'wrong_task', 'no_cap', 'zero_cap', 'expired'] as const)(
    'does not invoke assets or pi when %s',
    async (kind) => {
      const input = fixture();
      const { options, runTask, loadAsset } = setup();
      if (kind === 'unadmitted') input.executor.admitted_slice_id = null;
      if (kind === 'wrong_task') input.executor.task_kind = 'JevScoringDecisionTask';
      if (kind === 'no_cap') delete input.executor.max_cost_usd_micros;
      if (kind === 'zero_cap') input.executor.max_cost_usd_micros = 0;
      if (kind === 'expired') options.deadlineAt = Date.now() - 1;
      expect(await createPiModelExecutor(options)(input)).toMatchObject({
        kind: 'pending',
        run_refs: [],
      });
      expect(runTask).not.toHaveBeenCalled();
      expect(loadAsset).not.toHaveBeenCalled();
    },
  );
  it('charges the admitted reservation for unknown cost, including failed paid attempts', async () => {
    const { options } = setup();
    options.runTask.mockImplementationOnce(async () => ({
      ...result(decision()),
      cost_usd: undefined,
      cost_basis: 'unknown',
    }));
    expect(await createPiModelExecutor(options)(fixture())).toMatchObject({
      cost_usd_micros: 20_000,
    });
    options.runTask.mockImplementationOnce(async (_kind, _input, ctx) => {
      await ctx.beforeProviderQuery?.({
        taskRunId: 'failed',
        provider: 'xiaomi',
        model: 'mimo-v2.5',
      });
      throw new AgentRunError({
        kind: 'AssessmentRuleJudgeTask',
        taskRunId: 'failed',
        subtype: 'api_error_result',
        apiErrorStatus: 503,
        errors: ['fixture'],
      });
    });
    expect(await createPiModelExecutor(options)(fixture())).toMatchObject({
      kind: 'pending',
      run_refs: ['failed'],
      cost_usd_micros: 20_000,
    });
  });
  it('preserves an actual over-cap cost while holding the judgment', async () => {
    const { options } = setup();
    options.runTask.mockResolvedValueOnce(result(decision(), 0.03));
    expect(await createPiModelExecutor(options)(fixture())).toMatchObject({
      kind: 'pending',
      cost_usd_micros: 30_000,
    });
  });
  it('pre-abort makes no model call; in-flight abort forwards to the runner and preserves its paid reservation', async () => {
    const { options, runTask } = setup();
    const ac = new AbortController();
    ac.abort();
    expect(await createPiModelExecutor(options)(fixture(), ac.signal)).toMatchObject({
      kind: 'pending',
      run_refs: [],
    });
    expect(runTask).not.toHaveBeenCalled();
    const active = new AbortController();
    let observed: AbortSignal | undefined;
    options.runTask.mockImplementationOnce(async (_kind, _input, ctx) => {
      observed = ctx.signal;
      await ctx.beforeProviderQuery?.({
        taskRunId: ctx.taskRunId ?? '',
        provider: 'xiaomi',
        model: 'mimo-v2.5',
      });
      active.abort();
      return new Promise<RunTaskResult>(() => {});
    });
    expect(await createPiModelExecutor(options)(fixture(), active.signal)).toMatchObject({
      kind: 'pending',
      cost_usd_micros: 20_000,
      run_refs: [expect.any(String)],
    });
    expect(observed?.aborted).toBe(true);
  });
});

describe('original assets, not captions or mutable references', () => {
  it('includes byte-verified prompt and student images in declared order with their original identities', async () => {
    const input = fixture();
    const prompt = new Uint8Array([137, 80, 78, 71, 1]);
    const student = new Uint8Array([137, 80, 78, 71, 2]);
    input.materials.push({
      material_id: 'circuit',
      kind: 'figure',
      asset: { asset_id: 'diagram', digest: digest(prompt) },
      caption: '必须查看原图',
    });
    input.group_evidence = [
      {
        target: { scope: 'all_units' },
        evidence: {
          evidence_id: 'work-page',
          kind: 'image',
          asset: { asset_id: 'page', digest: digest(student) },
          mime_type: 'image/png',
          bytes: student.length,
          uploaded_at: '2026-10-04T12:00:00Z',
        },
      },
    ];
    const load = vi.fn(async (ref: { asset_id: string }) => ({
      bytes: ref.asset_id === 'diagram' ? prompt : student,
      mime_type: 'image/png',
    }));
    const prepared = await prepareAssessmentModelInput(input, load, signal());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('fixture failed');
    expect(prepared.input.images.map((item) => Buffer.from(item.data, 'base64'))).toEqual([
      Buffer.from(prompt),
      Buffer.from(student),
    ]);
    expect(JSON.parse(prepared.input.text).image_manifest).toMatchObject([
      { index: 0, material_id: 'circuit', asset: { asset_id: 'diagram' } },
      { index: 1, evidence_id: 'work-page', asset: { asset_id: 'page' } },
    ]);
  });
  it.each(['digest', 'bytes', 'mime', 'missing'] as const)(
    'rejects original evidence %s mismatch before a model call',
    async (kind) => {
      const input = fixture();
      const bytes = new Uint8Array([1, 2, 3]);
      input.group_evidence = [
        {
          target: { scope: 'all_units' },
          evidence: {
            evidence_id: 'original',
            kind: 'image',
            asset: { asset_id: 'page', digest: digest(bytes) },
            mime_type: 'image/png',
            bytes: bytes.length,
            uploaded_at: '2026-10-04T12:00:00Z',
          },
        },
      ];
      const load = vi.fn(async () =>
        kind === 'missing'
          ? null
          : {
              bytes:
                kind === 'digest'
                  ? new Uint8Array([9, 2, 3])
                  : kind === 'bytes'
                    ? new Uint8Array([1, 2])
                    : bytes,
              mime_type: kind === 'mime' ? 'image/jpeg' : 'image/png',
            },
      );
      expect(await prepareAssessmentModelInput(input, load, signal())).toMatchObject({
        ok: false,
        pending: { reason: 'unreadable_evidence', evidence_ids: ['original'] },
      });
    },
  );
  it.each(['audio', 'video', 'pdf'] as const)(
    'holds unsupported original %s even with a transcript',
    async (kind) => {
      const input = fixture();
      input.materials = [
        {
          material_id: 'source',
          kind,
          content_md: '不能冒充原始发音/时序的转写',
          asset: { asset_id: 'source', digest: digest('original') },
        },
      ];
      const load = vi.fn(async () => null);
      expect(await prepareAssessmentModelInput(input, load, signal())).toMatchObject({ ok: false });
      expect(load).not.toHaveBeenCalled();
    },
  );
  it.each(['question', 'rule', 'answer', 'material'] as const)(
    'holds unbound inline original images in %s',
    async (where) => {
      const input = fixture();
      const md = '![circuit][img]\n\n[img]: https://example.test/original.png';
      if (where === 'question') input.question_parts[0].prompt_md = md;
      if (where === 'rule' && input.unit.criterion.kind === 'rule_reference')
        input.unit.criterion.statement_md = md;
      if (where === 'answer') input.slot_responses = [{ kind: 'text', slot_id: 's1', text_md: md }];
      if (where === 'material')
        input.materials = [
          {
            ...input.materials[0],
            content_md: md,
            asset: { asset_id: 'inline', digest: digest(md) },
          },
        ];
      const { options, runTask } = setup();
      expect(await createPiModelExecutor(options)(input)).toMatchObject({ kind: 'pending' });
      expect(runTask).not.toHaveBeenCalled();
    },
  );
  it('uses original UTF-8 plaintext evidence, and refuses changed inline material bytes', async () => {
    const input = fixture();
    const text = '原始证明：令速度为v。\n两式相加，水速抵消。';
    const bytes = new TextEncoder().encode(text);
    input.group_evidence = [
      {
        target: { scope: 'all_units' },
        evidence: {
          evidence_id: 'proof',
          kind: 'plaintext',
          asset: { asset_id: 'proof', digest: digest(bytes) },
          mime_type: 'text/plain',
          bytes: bytes.length,
          uploaded_at: '2026-10-04T12:00:00Z',
        },
      },
    ];
    const load = vi.fn(async () => ({ bytes, mime_type: 'text/plain' }));
    const prepared = await prepareAssessmentModelInput(input, load, signal());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('fixture failed');
    expect(JSON.parse(prepared.input.text).text_evidence).toEqual([{ evidence_id: 'proof', text }]);
    input.materials[0].content_md += '\n后来篡改';
    expect(await prepareAssessmentModelInput(input, load, signal())).toMatchObject({
      ok: false,
      pending: { reason: 'missing_materials', material_ids: ['table'] },
    });
  });
});

describe('YUK-1323 structured original citations and pending compatibility', () => {
  it('accepts the saved synth-18 projection through native execution, preserving its real zero', async () => {
    const input = {
      ...fixture(),
      ...synth18.request,
      executor: { ...fixture().executor, admitted_slice_id: 'offline-regression-only' },
      unit: ScoringUnit.parse(synth18.request.unit),
      question_parts: synth18.request.question_parts.map((item) => QuestionPart.parse(item)),
      response_slots: synth18.request.response_slots.map((item) => ResponseSlot.parse(item)),
      slot_responses: synth18.request.slot_responses.map((item) => SlotResponse.parse(item)),
      group_evidence: synth18.request.group_evidence.map((item) => GroupEvidence.parse(item)),
    };
    expect(createHash('sha256').update(synth18.output_text).digest('hex')).toBe(
      synth18.output_digest,
    );
    const output = AssessmentRuleDecision.parse(JSON.parse(synth18.output_text));
    const { options, runTask } = setup(output);
    runTask.mockResolvedValue({ ...result(output), text: synth18.output_text });
    const before = structuredClone(input);
    expect(await createPiModelExecutor(options)(input)).toMatchObject({
      kind: 'scored',
      points_awarded: 0,
      evidence_citations: output.kind === 'rule' ? output.evidence_citations : [],
    });
    expect(input).toEqual(before);
  });

  const source = JSON.stringify({
    background: {
      text: 'v=15',
      fabricated_ungraded_notes: [{ label: 'not an answer', counts: [100, 200] }],
    },
    final_answer: {
      text: 'v=12',
      ordered: [2, 3, 5],
      amount: 12,
      offset: 0,
      confirmed: false,
      missing: null,
      blank: '   ',
    },
  });
  it.each([
    ['same paths, formatted projection', '{ "final_answer": { "amount": 12, "text": "v=12" } }'],
    ['ordered array', '{"final_answer":{"ordered":[2,3,5]}}'],
    ['typed zero', '{"final_answer":{"offset":0}}'],
    [
      'complete array of objects',
      '{"background":{"fabricated_ungraded_notes":[{"label":"not an answer","counts":[100,200]}]}}',
    ],
    ['typed false', '{"final_answer":{"confirmed":false}}'],
    ['ordinary exact substring', 'v=12'],
  ])('accepts %s', async (_label, quote) => {
    const input = fixture();
    input.slot_responses = [{ kind: 'text', slot_id: 's1', text_md: source }];
    expect(
      await setup({ ...decision(), evidence_citations: [{ slot_id: 's1', quote }] }).port(input),
    ).toMatchObject({ kind: 'scored' });
  });
  it.each([
    ['changed value', '{"final_answer":{"text":"v=15"}}'],
    [
      'relocated background leaf',
      '{"final_answer":{"fabricated_ungraded_notes":[{"label":"not an answer","counts":[100,200]}]}}',
    ],
    [
      'one real leaf plus fabricated context',
      '{"final_answer":{"text":"v=12","explanation":"verified"}}',
    ],
    ['changed key path', '{"text":"v=12"}'],
    ['missing path', '{"final_answer":{"absent":12}}'],
    ['reordered array', '{"final_answer":{"ordered":[5,3,2]}}'],
    ['truncated array', '{"final_answer":{"ordered":[2,3]}}'],
    [
      'partial object in array',
      '{"background":{"fabricated_ungraded_notes":[{"label":"not an answer"}]}}',
    ],
    ['coerced number', '{"final_answer":{"amount":"12"}}'],
    ['coerced boolean', '{"final_answer":{"confirmed":0}}'],
    ['primitive root', '"v=12" '],
    ['empty quote', ''],
    ['whitespace quote', '   '],
    ['empty object', '{ }'],
    ['empty nested object', '{"final_answer":{ }}'],
    ['empty array', '{"final_answer":{"ordered":[]}}'],
    ['null only', '{"final_answer":{"missing":null}}'],
    ['blank only', '{"final_answer":{"blank":"   "}}'],
  ])('rejects %s without converting it to a score', async (_label, quote) => {
    const input = fixture();
    input.slot_responses = [{ kind: 'text', slot_id: 's1', text_md: source }];
    expect(
      await setup({ ...decision(), evidence_citations: [{ slot_id: 's1', quote }] }).port(input),
    ).toMatchObject({ kind: 'pending', pending: { reason: 'unjudgeable' } });
  });
  it.each([
    [
      '{"final_answer":{"amount":9007199254740992},"background":"ungraded"}',
      '{"final_answer":{"amount":9007199254740993}}',
    ],
    [
      '{"final_answer":{"amount":0.1},"background":"ungraded"}',
      '{"final_answer":{"amount":0.10000000000000001}}',
    ],
  ])('rejects lossy JSON numeric equality: %s', async (text_md, quote) => {
    const input = fixture();
    input.slot_responses = [{ kind: 'text', slot_id: 's1', text_md }];
    expect(
      await setup({ ...decision(), evidence_citations: [{ slot_id: 's1', quote }] }).port(input),
    ).toMatchObject({ kind: 'pending', pending: { reason: 'unjudgeable' } });
  });
  it('accepts an exact numeric value written in another JSON notation', async () => {
    const input = fixture();
    input.slot_responses = [
      {
        kind: 'text',
        slot_id: 's1',
        text_md: '{"background":"ungraded","final_answer":{"amount":1.2e1}}',
      },
    ];
    expect(
      await setup({
        ...decision(),
        evidence_citations: [{ slot_id: 's1', quote: '{"final_answer":{"amount":12.0}}' }],
      }).port(input),
    ).toMatchObject({ kind: 'scored' });
  });

  it.each(['wrong-slot', 'unissued-slot', 'missing-response', 'non-json-source'])(
    'rejects %s citations',
    async (mode) => {
      const input = fixture();
      input.slot_responses = [
        {
          kind: 'text',
          slot_id: 's1',
          text_md: mode === 'non-json-source' ? `Background: ${source}` : source,
        },
      ];
      if (mode === 'missing-response') input.slot_responses = [];
      if (mode === 'wrong-slot')
        input.slot_responses.push({ kind: 'text', slot_id: 's2', text_md: 'other answer' });
      const slot_id = mode === 'wrong-slot' ? 's2' : mode === 'unissued-slot' ? 'unissued' : 's1';
      expect(
        await setup({
          ...decision(),
          evidence_citations: [{ slot_id, quote: '{"final_answer":{"amount":12}}' }],
        }).port(input),
      ).toMatchObject({ kind: 'pending' });
    },
  );

  it.each([true, false])(
    'checks a structured citation against original plaintext asset bytes: %s',
    async (valid) => {
      const input = fixture();
      const bytes = new TextEncoder().encode(source);
      input.group_evidence = [
        {
          target: { scope: 'all_units' },
          evidence: {
            evidence_id: 'structured-proof',
            kind: 'plaintext',
            asset: { asset_id: 'proof', digest: digest(bytes) },
            mime_type: 'text/plain',
            bytes: bytes.length,
            uploaded_at: '2026-10-04T12:00:00Z',
          },
        },
      ];
      const { options } = setup({
        ...decision(),
        evidence_citations: [
          {
            evidence_id: 'structured-proof',
            quote: JSON.stringify({ final_answer: { amount: valid ? 12 : 15 } }),
          },
        ],
      });
      const outcome = await createPiModelExecutor({
        ...options,
        loadAsset: async () => ({ bytes, mime_type: 'text/plain' }),
      })(input);
      expect(outcome.kind).toBe(valid ? 'scored' : 'pending');
    },
  );

  // Synthetic reproducer of synth-30's observed unrecognized_keys error.
  // Its original raw output was lost by the temporary diagnostic and is unavailable.
  const pendingReproducer = {
    kind: 'pending',
    detail: 'Two equally asserted final alternatives conflict.',
  };
  it.each([
    pendingReproducer,
    { ...pendingReproducer, evidence_citations: [{ slot_id: 's1', quote: '相加得2v=30' }] },
    { ...pendingReproducer, evidence_citations: [] },
  ])(
    'accepts typed pending with optional citations but discards them from the domain outcome: %j',
    async (output) => {
      expect(AssessmentRuleDecision.parse(output)).toEqual(output);
      expect(await setup(output).port(fixture())).toEqual({
        kind: 'pending',
        pending: { reason: 'insufficient_evidence', detail: pendingReproducer.detail },
        run_refs: ['run-native'],
        cost_usd_micros: 4000,
      });
    },
  );
  it.each([
    { ...pendingReproducer, evidence_citations: 'not an array' },
    { ...pendingReproducer, evidence_citations: [{ slot_id: 12 }] },
    { ...pendingReproducer, evidence_citations: [{ slot_id: 's1', quote: 12 }] },
    { ...pendingReproducer, evidence_citations: [{}] },
    { ...pendingReproducer, evidence_citations: [{ slot_id: 's1', fabricated: true }] },
    ...[
      'points_awarded',
      'rule_id',
      'level_id',
      'confidence',
      'feedback_md',
      'weights',
      'probe_signature_match',
    ].map((field) => ({ ...pendingReproducer, [field]: 0 })),
  ])('rejects malformed pending citations and forbidden scoring fields: %j', async (output) => {
    expect(AssessmentRuleDecision.safeParse(output).success).toBe(false);
    expect(await setup(output).port(fixture())).toMatchObject({
      kind: 'pending',
      pending: { reason: 'infra_failure' },
    });
  });
});
