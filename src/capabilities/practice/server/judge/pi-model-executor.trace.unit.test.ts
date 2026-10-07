import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/db/client';
import { __setTraceExporterForTests, traceOperation } from '@/server/ai/laminar-tracing';
import { memoryTraceExporter, traceField } from '@/server/ai/laminar-tracing.test-support';
import type { RunTaskCtx, RunTaskResult } from '@/server/ai/runner';
import { createPiModelExecutor } from '@/server/assessment/pi-model-executor';
import {
  assessmentDigest,
  nativeAssessmentFixture,
} from '../../../../../tests/fixtures/assessment-native-model';

const privateText = 'PRIVATE_LEARNER_CONTEXT_SENTINEL';
const privateFeedback = 'PRIVATE_PROVIDER_OUTPUT_FEEDBACK_SENTINEL';
const privatePending = 'PRIVATE_PENDING_DETAIL_SENTINEL';
const privateId = 'PRIVATE_REVISION_ID_SENTINEL';
const db = { $client: {} } as unknown as Db;
const decision = () => ({
  kind: 'rule',
  rule_id: 'r1',
  points_awarded: 0,
  confidence: 0.98,
  feedback_md: privateFeedback,
  evidence_citations: [{ slot_id: 's1', quote: privateText }],
});

function setup(output: unknown = decision()) {
  const input = nativeAssessmentFixture();
  input.revision_id = privateId;
  input.question_parts[0].prompt_md = `PRIVATE_QUESTION_SENTINEL ${'长题面。'.repeat(100)}`;
  input.slot_responses = [{ kind: 'text', slot_id: 's1', text_md: privateText }];
  if (input.unit.criterion.kind === 'rule_reference')
    input.unit.criterion.statement_md = 'PRIVATE_RUBRIC_SENTINEL';
  input.review_context = {
    appeal_event_id: 'PRIVATE_APPEAL_ID_SENTINEL',
    prior_evaluation_id: 'PRIVATE_EVALUATION_ID_SENTINEL',
    reason_md: 'PRIVATE_APPEAL_TEXT_SENTINEL',
  };
  const material = 'PRIVATE_MATERIAL_SENTINEL';
  input.materials[0].content_md = material;
  input.materials[0].asset.digest = assessmentDigest(material);
  const response: RunTaskResult = {
    task_run_id: 'run-safe-existing-metadata',
    text: JSON.stringify(output),
    finishReason: 'success',
    usage: { inputTokens: 240, outputTokens: 32 },
    cost_usd: 0.004,
    cost_basis: 'estimated',
    cost_ref: 'pi-catalog:xiaomi/mimo-v2.5',
  };
  // Only the provider/DB runner boundary is replaced. Consume the production
  // executor's actual ctx content with the same trace wrapper used by runTask.
  const runTask = vi.fn(async (_kind: string, _input: unknown, ctx: RunTaskCtx) =>
    traceOperation(
      'task.run',
      { task_kind: 'AssessmentRuleJudgeTask' },
      async () => {
        await ctx.beforeProviderQuery?.({
          taskRunId: ctx.taskRunId ?? '',
          provider: 'xiaomi',
          model: 'mimo-v2.5',
        });
        return response;
      },
      { signal: ctx.signal, content: ctx.laminarContent },
    ),
  );
  const imageBytes = Buffer.from('PRIVATE_IMAGE_BYTES_SENTINEL');
  input.materials.push({
    material_id: 'PRIVATE_IMAGE_ID_SENTINEL',
    kind: 'figure',
    asset: { asset_id: 'PRIVATE_IMAGE_ASSET_SENTINEL', digest: assessmentDigest(imageBytes) },
  });
  const port = createPiModelExecutor({
    db,
    deadlineAt: Date.now() + 30_000,
    maxCostUsdMicros: 20_000,
    runTask,
    loadAsset: vi.fn(async () => ({ bytes: imageBytes, mime_type: 'image/png' })),
  });
  return { port, input, runTask };
}

afterEach(() => __setTraceExporterForTests());

function summary(attributes: Record<string, string | number | boolean>, direction: string) {
  return JSON.parse(String(attributes[`lmnr.span.${direction}`])).summary;
}

function expectPrivateDataAbsent(records: unknown) {
  const exported = JSON.stringify(records);
  for (const sentinel of [
    privateText,
    privateFeedback,
    privatePending,
    privateId,
    'PRIVATE_QUESTION_SENTINEL',
    'PRIVATE_RUBRIC_SENTINEL',
    'PRIVATE_MATERIAL_SENTINEL',
    'PRIVATE_APPEAL',
    'PRIVATE_EVALUATION',
    'PRIVATE_IMAGE_BYTES_SENTINEL',
    Buffer.from('PRIVATE_IMAGE_BYTES_SENTINEL').toString('base64'),
    'PRIVATE_IMAGE_ID_SENTINEL',
    'PRIVATE_IMAGE_ASSET_SENTINEL',
    'PRIVATE_LEVEL_SENTINEL',
  ])
    expect(exported).not.toContain(sentinel);
}

describe('native assessment production trace summaries', () => {
  it('labels scored zero as a learner score with successful grading execution, without claiming correctness', async () => {
    const { exporter, records } = memoryTraceExporter();
    __setTraceExporterForTests(exporter);
    const { port, input, runTask } = setup();
    const outcome = await port(input);
    expect(outcome).toMatchObject({ kind: 'scored', points_awarded: 0 });
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(records.map((record) => record.name)).toEqual([
      'assessment.execute',
      'task.run',
      'assessment.parse',
    ]);
    for (const record of records) {
      expect(summary(record.attributes, 'input')).toContain('Agent role: assessment grader');
      expect(summary(record.attributes, 'input')).toContain('learner');
      expect(record.ends).toBe(1);
      expect(record.attributes[traceField('execution_outcome')]).toBe('success');
    }
    expect(summary(records[0].attributes, 'input')).toContain('"points_maximum":5');
    const accepted = summary(records[0].attributes, 'output');
    expect(accepted).toContain('"assessment_outcome":"scored"');
    expect(accepted).toContain('"points_awarded":0');
    expect(accepted).toContain('Zero awarded points are not an execution failure');
    expect(accepted).toContain('does not establish grading correctness');
    expect(summary(records[1].attributes, 'output')).toContain(
      'domain validation is still pending',
    );
    expect(summary(records[2].attributes, 'output')).toContain('"decision_kind":"rule"');
    expect(records[1].parent).toBe(records[0].context);
    expect(records[2].parent).toBe(records[0].context);
    expectPrivateDataAbsent(records);
  });

  it('keeps typed pending distinct from scored zero and from execution error', async () => {
    const { exporter, records } = memoryTraceExporter();
    __setTraceExporterForTests(exporter);
    const { port, input, runTask } = setup({
      kind: 'pending',
      detail: privatePending,
      evidence_citations: [{ slot_id: 's1', quote: privateText }],
    });
    expect(await port(input)).toMatchObject({
      kind: 'pending',
      pending: { reason: 'insufficient_evidence', detail: privatePending },
    });
    expect(runTask).toHaveBeenCalledTimes(1);
    const held = summary(records[0].attributes, 'output');
    expect(held).toContain('"assessment_outcome":"pending"');
    expect(held).toContain('"pending_reason":"insufficient_evidence"');
    expect(held).not.toContain('points_awarded');
    expect(held).toContain('Pending awards no score');
    expect(records[0].attributes[traceField('execution_outcome')]).toBe('success');
    expect(records[0].attributes[traceField('business_outcome')]).toBe('pending');
    expect(summary(records[2].attributes, 'output')).toContain('"decision_kind":"pending"');
    expect(records.every((record) => record.ends === 1)).toBe(true);
    expectPrivateDataAbsent(records);
  });

  it('marks malformed provider output as execution error while retaining an unresolved assessment', async () => {
    const { exporter, records } = memoryTraceExporter();
    __setTraceExporterForTests(exporter);
    const { port, input, runTask } = setup({ private: privateFeedback });
    expect(await port(input)).toMatchObject({
      kind: 'pending',
      pending: { reason: 'infra_failure' },
    });
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(records[0].attributes[traceField('execution_outcome')]).toBe('error');
    expect(records[1].attributes[traceField('execution_outcome')]).toBe('success');
    expect(records[2].attributes[traceField('execution_outcome')]).toBe('error');
    expect(summary(records[0].attributes, 'output')).toContain('"pending_reason":"infra_failure"');
    expect(records[2].attributes['lmnr.span.output']).toBeUndefined();
    expect(records.every((record) => record.ends === 1)).toBe(true);
    expectPrivateDataAbsent(records);
  });

  it('describes a holistic result without exporting the matched level or descriptors', async () => {
    const { exporter, records } = memoryTraceExporter();
    __setTraceExporterForTests(exporter);
    const { port, input } = setup({
      kind: 'level',
      level_id: 'PRIVATE_LEVEL_SENTINEL',
      confidence: 0.8,
      feedback_md: privateFeedback,
      evidence_citations: [{ slot_id: 's1', quote: privateText }],
    });
    input.unit.points = null;
    input.unit.criterion = {
      kind: 'holistic_level',
      levels: [{ level_id: 'PRIVATE_LEVEL_SENTINEL', rank: 0, descriptor_md: privateText }],
    };
    expect(await port(input)).toMatchObject({ kind: 'scored', points_awarded: null });
    expect(summary(records[0].attributes, 'input')).toContain('"criterion_kind":"holistic_level"');
    expect(summary(records[0].attributes, 'output')).toContain('"points_awarded":null');
    expectPrivateDataAbsent(records);
  });

  it('keeps an over-cap decision pending after a successful parse', async () => {
    const { exporter, records } = memoryTraceExporter();
    __setTraceExporterForTests(exporter);
    const { port, input } = setup({ ...decision(), points_awarded: 6 });
    expect(await port(input)).toMatchObject({
      kind: 'pending',
      pending: { reason: 'unjudgeable' },
    });
    expect(summary(records[0].attributes, 'output')).not.toContain('points_awarded');
    expect(summary(records[0].attributes, 'output')).toContain('"pending_reason":"unjudgeable"');
    expect(
      records.every((record) => record.attributes[traceField('execution_outcome')] === 'success'),
    ).toBe(true);
    expectPrivateDataAbsent(records);
  });

  it('holds missing materials before invoking the model without exporting their identity', async () => {
    const { exporter, records } = memoryTraceExporter();
    __setTraceExporterForTests(exporter);
    const { port, input, runTask } = setup();
    input.materials[0].asset.digest = assessmentDigest('wrong digest');
    expect(await port(input)).toMatchObject({
      kind: 'pending',
      pending: { reason: 'missing_materials' },
    });
    expect(runTask).not.toHaveBeenCalled();
    expect(records).toHaveLength(1);
    expect(summary(records[0].attributes, 'output')).toContain(
      '"pending_reason":"missing_materials"',
    );
    expect(summary(records[0].attributes, 'output')).not.toContain('points_awarded');
    expectPrivateDataAbsent(records);
  });

  it('preserves exactly-once execution with tracing disabled or a failed exporter', async () => {
    for (const failExporter of [false, true]) {
      __setTraceExporterForTests(
        failExporter
          ? {
              start: () => {
                throw new Error(privateText);
              },
              flush: async () => {},
            }
          : undefined,
      );
      const { port, input, runTask } = setup();
      expect(await port(input)).toMatchObject({ kind: 'scored', points_awarded: 0 });
      expect(runTask).toHaveBeenCalledTimes(1);
      if (!failExporter) expect(runTask.mock.calls[0][2].laminarContent).toBeUndefined();
    }
  });
});
