// YUK-299 — runner outputFormat seam: zero-regression + structured_output
// three-state read.
//
// Pure no-DB unit, same justification as the sibling stream-cancel.test.ts /
// runner.stream-collect.test.ts: @anthropic-ai/claude-agent-sdk and
// @/server/ai/log are vi.mock'd and `db` is an untouched stub, so no live
// Postgres is needed. (The sibling runner.test.ts drives the real ai/log writers
// against a container → db partition.) MUST be enumerated in fastTestInclude
// (vitest.shared.ts): src/server/ai/** has no unit glob, so without the entry the
// db config's src/**/*.test.ts glob would sweep it into the testcontainer
// partition.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the options the runner hands the SDK + let a test pick which result
// message the mocked query emits (success-with/without structured_output, or an
// error subtype).
const mockSdk = vi.hoisted(() => ({
  capturedOptions: undefined as unknown,
  messages: [] as unknown[],
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(({ options }: { options: unknown }) => {
    mockSdk.capturedOptions = options;
    return (async function* () {
      for (const m of mockSdk.messages) yield m;
    })();
  }),
  createSdkMcpServer: vi.fn(() => ({ type: 'sdk', name: '', instance: {} })),
  tool: vi.fn((name: string, description: string) => ({ name, description })),
}));

// ai/log writers are the only DB-touching calls inside runTask; stub them so no
// real client is needed and we can assert their call args are unchanged.
const logMock = vi.hoisted(() => ({
  started: vi.fn(async (_db: unknown, _row: unknown) => {}),
  finished: vi.fn(async (_db: unknown, _row: unknown) => {}),
  cost: vi.fn(async (_db: unknown, _row: unknown) => {}),
  tool: vi.fn(async (_db: unknown, _row: unknown) => 'tool-log-id'),
}));

vi.mock('@/server/ai/log', () => ({
  writeAiTaskRunStarted: logMock.started,
  writeAiTaskRunFinished: logMock.finished,
  writeCostLedger: logMock.cost,
  writeToolCallLog: logMock.tool,
}));

import type { JsonSchemaOutputFormat } from '@anthropic-ai/claude-agent-sdk';
import { runTask } from './runner';

// Minimal db stub — never dereferenced because every ai/log writer is mocked.
const fakeDb = {} as never;

function successResult(opts: { text?: string; structured_output?: unknown } = {}) {
  const base: Record<string, unknown> = {
    type: 'result',
    subtype: 'success',
    result: opts.text ?? 'ok',
    stop_reason: 'end_turn',
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
  };
  if ('structured_output' in opts) base.structured_output = opts.structured_output;
  return base;
}

function errorResult(subtype: string) {
  return { type: 'result', subtype };
}

const SAMPLE_OUTPUT_FORMAT: JsonSchemaOutputFormat = {
  type: 'json_schema',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
};

// AttributionTask is an un-migrated, no-tool task — a representative baseline for
// the zero-regression assertions (it never sets ctx.outputFormat).
const UNMIGRATED_KIND = 'AttributionTask';

describe('runTask — YUK-299 outputFormat seam', () => {
  beforeEach(() => {
    mockSdk.capturedOptions = undefined;
    mockSdk.messages = [];
    logMock.started.mockClear();
    logMock.finished.mockClear();
    logMock.cost.mockClear();
    logMock.tool.mockClear();
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT write outputFormat onto Options when ctx.outputFormat is omitted (zero regression)', async () => {
    mockSdk.messages = [successResult()];

    await runTask(UNMIGRATED_KIND, { question: 'q', wrong_answer: 'a' }, { db: fakeDb });

    const opts = mockSdk.capturedOptions as Record<string, unknown>;
    expect('outputFormat' in opts).toBe(false);
  });

  it('keeps the un-migrated Options key set stable (no field drift from the const refactor)', async () => {
    mockSdk.messages = [successResult()];

    await runTask(UNMIGRATED_KIND, { question: 'q', wrong_answer: 'a' }, { db: fakeDb });

    const opts = mockSdk.capturedOptions as Record<string, unknown>;
    // The exact Options key set buildQueryOptions emits with no outputFormat.
    // Guards the literal→const+mutate refactor against accidental field add/drop.
    const EXPECTED_KEYS = [
      'model',
      'systemPrompt',
      'abortController',
      'env',
      'tools',
      'mcpServers',
      'maxTurns',
      'permissionMode',
      'allowDangerouslySkipPermissions',
      'persistSession',
      'cwd',
      'skills',
    ].sort();
    expect(Object.keys(opts).sort()).toEqual(EXPECTED_KEYS);
    // settingSources must stay OMITTED (pre-existing invariant, re-asserted here).
    expect('settingSources' in opts).toBe(false);
  });

  it('threads ctx.outputFormat through to Options.outputFormat when set', async () => {
    mockSdk.messages = [successResult()];

    await runTask(
      UNMIGRATED_KIND,
      { question: 'q', wrong_answer: 'a' },
      { db: fakeDb, outputFormat: SAMPLE_OUTPUT_FORMAT },
    );

    const opts = mockSdk.capturedOptions as { outputFormat?: unknown };
    expect(opts.outputFormat).toEqual(SAMPLE_OUTPUT_FORMAT);
  });

  it('passes through structured_output when the success result carries it (state A)', async () => {
    const payload = { verdict: 'pass', confidence: 0.9 };
    mockSdk.messages = [successResult({ structured_output: payload })];

    const result = await runTask(UNMIGRATED_KIND, { q: 1 }, { db: fakeDb });

    expect(result.structured_output).toEqual(payload);
  });

  it('leaves structured_output undefined when the success result omits it (state C — endpoint fallback)', async () => {
    mockSdk.messages = [successResult()];

    const result = await runTask(UNMIGRATED_KIND, { q: 1 }, { db: fakeDb });

    expect(result.structured_output).toBeUndefined();
  });

  it('throws + warns on error_max_structured_output_retries (state B)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSdk.messages = [errorResult('error_max_structured_output_retries')];

    await expect(runTask(UNMIGRATED_KIND, { q: 1 }, { db: fakeDb })).rejects.toThrow(
      /error_max_structured_output_retries/,
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('structured-output retries exhausted'),
      expect.objectContaining({ task_run_id: expect.any(String) }),
    );
  });

  it('does NOT warn on an unrelated error subtype (warn is structured-output specific)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockSdk.messages = [errorResult('error_max_turns')];

    await expect(runTask(UNMIGRATED_KIND, { q: 1 }, { db: fakeDb })).rejects.toThrow(
      /error_max_turns/,
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('keeps the 留痕 write calls unchanged on the structured-output success path (约束②)', async () => {
    mockSdk.messages = [successResult({ structured_output: { verdict: 'pass' } })];

    await runTask(UNMIGRATED_KIND, { q: 1 }, { db: fakeDb });

    // started + finished(success) + cost ledger each called exactly once, and the
    // finished/cost args carry NO new structured_output field (seam does not log it).
    expect(logMock.started).toHaveBeenCalledTimes(1);
    expect(logMock.finished).toHaveBeenCalledTimes(1);
    expect(logMock.cost).toHaveBeenCalledTimes(1);
    const finishedArgs = logMock.finished.mock.calls[0][1] as Record<string, unknown>;
    expect('structured_output' in finishedArgs).toBe(false);
    expect(finishedArgs.status).toBe('success');
    const costArgs = logMock.cost.mock.calls[0][1] as Record<string, unknown>;
    expect('structured_output' in costArgs).toBe(false);
  });
});
