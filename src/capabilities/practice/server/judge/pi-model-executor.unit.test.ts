import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@/db/client';
import { AgentRunError } from '@/server/ai/agent-run-error';
import type { RunTaskCtx, RunTaskResult } from '@/server/ai/runner';
import { prepareAssessmentModelInput } from '@/server/assessment/assessment-model-assets';
import { createPiModelExecutor } from '@/server/assessment/pi-model-executor';
import {
  assessmentDigest as digest,
  nativeAssessmentFixture as fixture,
} from '../../../../../tests/fixtures/assessment-native-model';

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
