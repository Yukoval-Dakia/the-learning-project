import { createServer } from 'node:http';
import { agentLoop } from '@earendil-works/pi-agent-core';
import { asc } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import { ai_task_runs, cost_ledger } from '@/db/schema';
import { __setPiAdapterForTests } from '@/server/ai/execution-adapter';
import { PiAgentAdapter } from '@/server/ai/pi-agent-adapter';
import { createLoomPiModels } from '@/server/ai/pi-models';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { TAGGING_MAX_PAID_SENDS, runTaggingTask } from './tagging';

// Only the provider is replaced: an offline HTTP server speaks the real wire protocol,
// while runTask packing, the pi adapter and the attempt/ledger writers all run for real.
const override = { provider: 'opencode-go' as const, model: 'deepseek-v4.1-flash' };
const VALID = JSON.stringify({ suggestions: [], overall_confidence: 0.2, reasoning: '无匹配' });
let stop: (() => Promise<void>) | undefined;
let sends = 0;

async function serveReplies(replies: string[]): Promise<void> {
  const server = createServer(async (request, response) => {
    for await (const _ of request) {
      // drain the request body
    }
    const text = replies[sends] ?? VALID;
    sends++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: unknown, finish_reason: string | null) =>
      response.write(
        `data: ${JSON.stringify({
          id: 'offline',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason }],
          ...(finish_reason
            ? { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }
            : {}),
        })}\n\n`,
      );
    chunk({ role: 'assistant', content: text }, null);
    chunk({}, 'stop');
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stop = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture address');
  const models = await createLoomPiModels();
  const model = models.getModel(override.provider, override.model);
  if (!model) throw new Error('offline protocol model unavailable');
  vi.spyOn(models, 'getModel').mockReturnValue({
    ...model,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  });
  __setPiAdapterForTests(new PiAgentAdapter({ models, agentLoop }));
}

beforeEach(async () => {
  await resetDb();
  sends = 0;
  vi.stubEnv('OPENCODE_API_KEY', 'offline-invalid-key');
  setTestConfig({
    CLAUDE_CODE_MAX_RETRIES: 0,
    'lane.global.provider': override.provider,
    'lane.global.model': override.model,
  });
});
afterEach(async () => {
  await stop?.();
  stop = undefined;
  resetTestConfig();
  __setPiAdapterForTests(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// @invariant grading: a tagging reply that breaks the output contract settles as a billed failure, never a success, and resends stay within the paid cap.
// @fails-if markAiTaskRunOutputInvalid is not called, so ai_task_runs/cost_ledger keep status=success for unusable text, or the caller resends past TAGGING_MAX_PAID_SENDS.
it.each([
  {
    name: 'one malformed reply, then a valid one: tagged after one resend',
    replies: ['这道题考查一次函数', VALID],
    outcome: 'tagged',
    runs: [
      { status: 'failure', finish_reason: 'model_output_invalid', ledger: 'failed_permanent' },
      { status: 'success', ledger: 'success' },
    ],
  },
  {
    name: 'malformed at the cap: unknown, no further paid send',
    replies: ['not json', '{"suggestions":"x"}', VALID],
    outcome: 'unknown',
    runs: [
      { status: 'failure', finish_reason: 'model_output_invalid', ledger: 'failed_permanent' },
      { status: 'failure', finish_reason: 'model_output_invalid', ledger: 'failed_permanent' },
    ],
  },
])('$name', async ({ replies, outcome, runs }) => {
  await serveReplies(replies);
  const result = await runTaggingTask({
    db: testDb(),
    questionMd: '已知 y = 2x + 1，求 x = 3 时 y 的值。',
    knowledgeHint: null,
    ctx: { override },
  });

  expect(result.outcome).toBe(outcome);
  expect(sends).toBe(runs.length);
  expect(sends).toBeLessThanOrEqual(TAGGING_MAX_PAID_SENDS);
  const runRows = await testDb().select().from(ai_task_runs).orderBy(asc(ai_task_runs.started_at));
  const ledgerRows = await testDb().select().from(cost_ledger);
  expect(runRows).toHaveLength(runs.length);
  runRows.forEach((row, index) => {
    const expected = runs[index];
    const ledger = ledgerRows.filter((entry) => entry.task_run_id === row.id);
    expect(row.status).toBe(expected?.status);
    expect(ledger.map((entry) => entry.outcome)).toEqual([expected?.ledger]);
    if (expected?.finish_reason !== undefined) {
      expect(row.finish_reason).toBe(expected.finish_reason);
      expect(row.error_message).toMatch(/^model_output_invalid: /);
    }
    // The provider reply was billed; the flip keeps usage and cost exactly as settled.
    expect(row.usage_json).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(row.cost_usd).toBe(ledger[0]?.cost);
    expect(row.cost_basis).not.toBe('unknown');
  });
});
