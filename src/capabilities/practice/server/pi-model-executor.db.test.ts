import { normalizeContext } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import { ai_task_runs, cost_ledger, source_asset } from '@/db/schema';
import {
  type ExecutionAdapterStartupArgs,
  type RunnerMessage,
  __setPiAdapterForTests,
} from '@/server/ai/execution-adapter';
import {
  createAssessmentAssetLoader,
  prepareAssessmentModelInput,
} from '@/server/assessment/assessment-model-assets';
import {
  assessmentDigest as digest,
  nativeAssessmentFixture as fixture,
} from '../../../../tests/fixtures/assessment-native-model';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { resolveModelExecutor } from './judge/evaluate-submission';

const r2 = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/server/r2', () => ({ getR2: () => r2 }));
let captured: ExecutionAdapterStartupArgs | undefined;
let capturedPrompt: unknown;
let frames: RunnerMessage[];
const query = vi.fn();
const defaultOutput = () => ({
  kind: 'rule',
  rule_id: 'r1',
  points_awarded: 5,
  confidence: 0.98,
  feedback_md: '两式相加，方程与单位正确。',
  evidence_citations: [{ slot_id: 's1', quote: '相加得2v=30' }],
});
const success = (output: unknown = defaultOutput()) =>
  ({
    type: 'result',
    source: 'pi',
    subtype: 'success',
    result: JSON.stringify(output),
    stop_reason: 'end_turn',
    usage: { input_tokens: 260, output_tokens: 80 },
    total_cost_usd: 0.002,
  }) as RunnerMessage;

beforeEach(async () => {
  await resetDb();
  resetTestConfig();
  vi.stubEnv('XIAOMI_API_KEY', 'offline-fixture');
  vi.stubEnv('AI_PROVIDER_OVERRIDE', '');
  vi.stubEnv('AI_PROVIDER_MODEL', '');
  captured = undefined;
  capturedPrompt = undefined;
  query.mockReset();
  r2.get.mockReset();
  frames = [success()];
  __setPiAdapterForTests({
    id: 'pi',
    startup: async (args) => {
      captured = args;
      return {
        query: (prompt) => {
          capturedPrompt = prompt;
          query();
          return (async function* () {
            if (typeof prompt === 'string') capturedPrompt = prompt;
            else {
              const messages = [];
              for await (const message of prompt) messages.push(message);
              capturedPrompt = messages;
            }
            yield* frames;
          })();
        },
        close: async () => {},
      };
    },
  });
});
afterEach(() => {
  __setPiAdapterForTests(undefined);
  resetTestConfig();
  vi.unstubAllEnvs();
});
const port = () => {
  const executor = resolveModelExecutor(testDb(), {
    kind: 'pi',
    deadline_at: Date.now() + 30_000,
    max_cost_usd_micros: 20_000,
  });
  if (!executor) throw new Error('native executor missing');
  return executor;
};

describe('native assessment through real runner and durable lifecycle', () => {
  it('assembles pi, preserves frozen input and persists exactly one native attempt/cost row', async () => {
    const input = fixture();
    const out = await port()(input);
    expect(out).toMatchObject({ kind: 'scored', points_awarded: 5 });
    expect(query).toHaveBeenCalledOnce();
    expect(captured?.options.model).toBe('mimo-v2.5');
    expect(JSON.stringify(capturedPrompt)).toContain('rev-original');
    expect(JSON.stringify(capturedPrompt)).toContain('sub-second');
    const runs = await testDb().select().from(ai_task_runs);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      task_kind: 'AssessmentRuleJudgeTask',
      status: 'success',
      provider: 'xiaomi',
      model: 'mimo-v2.5',
      cost_basis: 'estimated',
    });
    expect(runs[0].input_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(out.run_refs).toEqual([runs[0].id]);
    expect(out.cost_usd_micros).toBe(Math.ceil(Number(runs[0].cost_usd) * 1_000_000));
    const costs = await testDb()
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_run_id, runs[0].id));
    expect(costs).toHaveLength(1);
    expect(costs[0].cost_basis).toBe('estimated');
  });
  it('holds a malformed score while retaining the paid attempt and its actual cost', async () => {
    frames = [success({ ...defaultOutput(), points_awarded: 999 })];
    const out = await port()(fixture());
    expect(out).toMatchObject({ kind: 'pending' });
    const runs = await testDb().select().from(ai_task_runs);
    expect(runs).toHaveLength(1);
    expect(out.run_refs).toEqual([runs[0].id]);
    expect(out.cost_usd_micros).toBeGreaterThan(0);
  });
  it('failure is one attempt, charged conservatively, and never silently retried', async () => {
    setTestConfig({
      'task.AssessmentRuleJudgeTask.provider': 'anthropic',
      'task.AssessmentRuleJudgeTask.model': 'claude-opus-4-8',
    });
    vi.stubEnv('ANTHROPIC_API_KEY', 'offline-fixture');

    frames = [
      {
        type: 'result',
        source: 'pi',
        subtype: 'error_during_execution',
        errors: ['offline failure fixture'],
      } as RunnerMessage,
    ];
    const out = await port()(fixture());
    expect(out).toMatchObject({ kind: 'pending', cost_usd_micros: 20_000 });
    expect(query).toHaveBeenCalledOnce();
    const runs = await testDb().select().from(ai_task_runs);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'failure',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      cost_basis: 'unknown',
      cost_usd: null,
    });
    expect(out.run_refs).toEqual([runs[0].id]);
  });
  it('missing MiMo usage remains unknown in the shared ledger', async () => {
    setTestConfig({
      'task.AssessmentRuleJudgeTask.provider': 'xiaomi',
      'task.AssessmentRuleJudgeTask.model': 'mimo-v2.5',
    });
    vi.stubEnv('ANTHROPIC_API_KEY', 'offline-fixture');

    frames = [
      {
        type: 'result',
        source: 'pi',
        subtype: 'error_during_execution',
        usage_observed: false,
        usage: { input_tokens: 0, output_tokens: 0 },
        total_cost_usd: 0,
        errors: ['offline failure fixture'],
      } as RunnerMessage,
    ];
    const out = await port()(fixture());
    expect(out).toMatchObject({ kind: 'pending', cost_usd_micros: 20_000 });
    expect(query).toHaveBeenCalledOnce();
    const runs = await testDb().select().from(ai_task_runs);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'failure',
      provider: 'xiaomi',
      model: 'mimo-v2.5',
      cost_basis: 'unknown',
      cost_usd: null,
    });
    expect(out.run_refs).toEqual([runs[0].id]);
  });
  it('keeps explicitly observed zero usage as an estimated zero, not unknown', async () => {
    frames = [
      {
        ...success(),
        usage: { input_tokens: 0, output_tokens: 0 },
        total_cost_usd: 0,
      } as RunnerMessage,
    ];
    const out = await port()(fixture());
    expect(out).toMatchObject({ kind: 'scored', cost_usd_micros: 0 });
    const runs = await testDb().select().from(ai_task_runs);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ cost_basis: 'estimated', cost_usd: 0 });
  });
  it('a missing published cap creates no task run', async () => {
    const input = fixture();
    delete input.executor.max_cost_usd_micros;
    expect(await port()(input)).toMatchObject({ kind: 'pending', run_refs: [] });
    expect(await testDb().select().from(ai_task_runs)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('default frozen asset loader uses database identity and original bytes', () => {
  it('requires both stored metadata and fetched content to match the frozen digest', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const sha = digest(bytes);
    await testDb()
      .insert(source_asset)
      .values({
        id: 'figure-original',
        kind: 'image',
        storage_key: 'frozen/figure',
        mime_type: 'image/png',
        byte_size: bytes.length,
        sha256: sha.slice(7),
        created_at: new Date(),
      });
    r2.get.mockResolvedValue(bytes);
    const input = fixture();
    input.materials.push({
      material_id: 'diagram',
      kind: 'figure',
      asset: { asset_id: 'figure-original', digest: sha },
    });
    const load = createAssessmentAssetLoader(testDb());
    const signal = new AbortController().signal;
    expect(await prepareAssessmentModelInput(input, load, signal)).toMatchObject({
      ok: true,
      input: { images: [{ mediaType: 'image/png', data: Buffer.from(bytes).toString('base64') }] },
    });
    r2.get.mockResolvedValue(new Uint8Array([137, 80, 78, 71, 9, 2, 3]));
    expect(await prepareAssessmentModelInput(input, load, signal)).toMatchObject({
      ok: false,
      pending: { reason: 'missing_materials' },
    });
    await testDb()
      .update(source_asset)
      .set({ sha256: 'a'.repeat(64) })
      .where(eq(source_asset.id, 'figure-original'));
    r2.get.mockClear();
    expect(await prepareAssessmentModelInput(input, load, signal)).toMatchObject({ ok: false });
    expect(r2.get).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});

it('independent failure must retain observed over-cap actual cost', async () => {
  frames = [
    {
      type: 'result',
      source: 'pi',
      subtype: 'error_during_execution',
      usage_observed: true,
      usage: { input_tokens: 1000000, output_tokens: 100000 },
      total_cost_usd: 1,
      errors: ['provider stream failed after billed tokens'],
    } as RunnerMessage,
  ];
  const out = await port()(fixture());
  const runs = await testDb().select().from(ai_task_runs);
  expect(runs).toHaveLength(1);
  const actual = Math.ceil(Number(runs[0].cost_usd) * 1000000);
  expect(actual).toBeGreaterThan(20000);
  expect(out.cost_usd_micros).toBe(actual);
});

import { stream as nativeStream } from '@earendil-works/pi-ai/api/openai-completions';
import { evaluateSubmissionCore } from '@/core/schema/assessment/evaluation';
import { piTerminalResultFrame } from '@/server/ai/pi-agent-adapter';

it('independent failed cost blocks the next unit after plan cap is exceeded', async () => {
  frames = [
    {
      type: 'result',
      source: 'pi',
      subtype: 'error_during_execution',
      usage_observed: true,
      usage: { input_tokens: 1000000, output_tokens: 100000 },
      total_cost_usd: 1,
      errors: ['provider stream failed after billed tokens'],
    } as RunnerMessage,
  ];
  const f = fixture();
  const now = '2026-10-04T12:00:00Z';
  const revision: import('@/core/schema/assessment').PublishedQuestionRevisionT = {
    revision_id: f.revision_id,
    group_id: 'qgroup',
    revision_ordinal: 1,
    integrity_digest: 'sha256:fixture',
    published_at: now,
    supersedes_revision_id: null,
    structure: { group_id: 'qgroup', parts: f.question_parts, materials: f.materials },
    response_spec: { slots: f.response_slots },
    scoring_basis: {
      units: [f.unit, { ...f.unit, scoring_unit_id: 'u2' }],
      aggregation: { kind: 'sum' },
      blank_scores_zero: true,
    },
    execution_plan: {
      plan_version: 1,
      assignments: [{ scoring_unit_ids: ['u1', 'u2'], executor: f.executor }],
      escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'human_review' },
      max_total_cost_usd_micros: 40000,
    },
  };
  const out = await evaluateSubmissionCore({
    evaluation_id: 'eval-budget',
    attempt: 1,
    revision,
    submission: {
      submission_id: f.submission_id,
      issuance_id: 'iss-budget',
      revision_id: f.revision_id,
      evaluation_group_id: f.evaluation_group_id,
      idempotency_key: 'budget-key',
      submitted_at: now,
      response_set: { entries: f.slot_responses },
      group_evidence: [],
    },
    model_executor: port(),
  });
  const runs = await testDb().select().from(ai_task_runs);
  expect(query).toHaveBeenCalledTimes(1);
  expect(runs).toHaveLength(1);
  expect(out.spent_cost_usd_micros).toBe(Math.ceil(Number(runs[0].cost_usd) * 1_000_000));
});
it('independent successful real pi missing usage reserves budget in real runner', async () => {
  const model: import('@earendil-works/pi-ai').Model<'openai-completions'> = {
    id: 'mimo-v2.5',
    name: 'MiMo',
    provider: 'xiaomi',
    api: 'openai-completions',
    reasoning: false,
    baseUrl: 'https://offline.invalid',
    input: ['text'],
    contextWindow: 100000,
    maxTokens: 1000,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0 },
  };
  const fetch = vi.fn(
    async () =>
      new Response(
        `${[
          {
            id: 'offline',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'mimo-v2.5',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: JSON.stringify(defaultOutput()) },
                finish_reason: null,
              },
            ],
          },
          {
            id: 'offline',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'mimo-v2.5',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          },
        ]
          .map((x) => `data: ${JSON.stringify(x)}\n\n`)
          .join('')}data: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
  );
  const message = await nativeStream(
    model,
    normalizeContext({ messages: [{ role: 'user', content: 'Answer', timestamp: 1 }] }),
    { apiKey: 'offline-fixture', fetch },
  ).result();
  expect(message.stopReason).toBe('stop');
  const terminal = piTerminalResultFrame({
    messages: [message],
    model,
    sessionId: 'offline-session',
    durationMs: 10,
    numTurns: 1,
    aborted: false,
  });
  if (!terminal) throw new Error('expected terminal');
  frames = [terminal];
  const out = await port()(fixture());
  const runs = await testDb().select().from(ai_task_runs);
  expect.soft(out.cost_usd_micros).toBe(20000);
  expect.soft(runs[0].cost_basis).toBe('unknown');
  expect.soft(runs[0].cost_usd).toBeNull();
});
