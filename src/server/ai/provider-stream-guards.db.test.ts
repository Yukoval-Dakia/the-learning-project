import { type ServerResponse, createServer } from 'node:http';
import { agentLoop } from '@earendil-works/pi-agent-core';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import { ai_task_runs, cost_ledger, system_config } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { __setPiAdapterForTests } from './execution-adapter';
import { PiAgentAdapter } from './pi-agent-adapter';
import { createLoomPiModels } from './pi-models';
import { runTask } from './runner';

const kind = 'QuestionAdmissionSolveTask';
const input = {
  mode: 'solve',
  parts: [{ part_id: 'p', prompt_md: '1+1=?' }],
  units: [
    {
      scoring_unit_id: 'u',
      part_id: 'p',
      kind: 'blank',
      printed_points: null,
      blank: { format: 'text' },
    },
  ],
};
const submitted = JSON.stringify({
  scoring_unit_id: 'u',
  status: 'solved',
  answer: { kind: 'blank_text', accepted: ['2'] },
  equivalent_forms: [],
  typical_wrong: [],
});
const override = { provider: 'opencode-go' as const, model: 'deepseek-v4.1-flash' };
let stop: (() => Promise<void>) | undefined;
let sends = 0;
function event(
  response: ServerResponse,
  delta: unknown,
  finish_reason: string | null = null,
  output = 5,
) {
  response.write(
    `data: ${JSON.stringify({ id: 'offline', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 100, completion_tokens: output, total_tokens: 100 + output } } : {}) })}\n\n`,
  );
}
async function serve(reply: (response: ServerResponse, body: Record<string, unknown>) => void) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    sends++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    reply(response, JSON.parse(Buffer.concat(chunks).toString()));
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
    PROVIDER_STREAM_IDLE_MS: 150,
    CLAUDE_CODE_MAX_RETRIES: 0,
    'lane.global.provider': override.provider,
    'lane.global.model': override.model,
  });
});
afterEach(async () => {
  await stop?.();
  resetTestConfig();
  __setPiAdapterForTests(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// @invariant concurrency: a sent stalled tool turn cannot replay an earlier write or create a second paid attempt.
// @fails-if idle termination is retryable or partial tool arguments reach execution, duplicating the config increment or ledger row.
it('fails a keep-alive-only partial tool turn after a committed write without resending', async () => {
  await serve((response, body) => {
    const tools = body.tools as { function: { name: string } }[];
    const writerName = tools.find((tool) => tool.function.name.includes('write_once'))?.function
      .name;
    if (!writerName) throw new Error('writer missing from actual wire');
    event(response, {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: `call-${sends}`,
          type: 'function',
          function: { name: writerName, arguments: sends === 1 ? '{}' : '{"unfinished":' },
        },
      ],
    });
    if (sends === 1) {
      event(response, {}, 'tool_calls');
      response.end('data: [DONE]\n\n');
    } else {
      const timer = setInterval(() => response.write(': keep-alive\n\n'), 20);
      response.on('close', () => clearInterval(timer));
    }
  });
  await expect(
    runTask('CopilotTask', 'synthetic write then continue', {
      db: testDb(),
      enableTransientRetry: true,
      allowedTools: ['write_once'],
      piToolMounts: [
        {
          type: 'custom',
          tools: [
            {
              name: 'write_once',
              label: 'Write',
              description: 'Synthetic durable increment',
              parameters: { type: 'object', properties: {} },
              execute: async () => {
                await testDb()
                  .insert(system_config)
                  .values({
                    key: 'guard-replay-proof',
                    value: 1,
                    updated_by: 'offline',
                    created_at: new Date(),
                    updated_at: new Date(),
                  })
                  .onConflictDoUpdate({
                    target: system_config.key,
                    set: { value: sql`to_jsonb(${system_config.value}::int + 1)` },
                  });
                return { content: [{ type: 'text', text: 'written' }], details: {} };
              },
            },
          ],
        },
      ],
    }),
  ).rejects.toMatchObject({
    subtype: 'error_during_execution',
    errors: expect.arrayContaining([expect.stringContaining('provider_stream_idle')]),
  });
  expect(sends).toBe(2);
  expect(
    (await testDb().select().from(system_config)).find((row) => row.key === 'guard-replay-proof')
      ?.value,
  ).toBe(1);
  expect(await testDb().select().from(ai_task_runs)).toMatchObject([{ status: 'failure' }]);
  expect(await testDb().select().from(cost_ledger)).toMatchObject([
    { outcome: 'failed_permanent' },
  ]);
});

// @invariant grading: an output ceiling never accepts even valid-looking structured answers; continuous slow data remains admissible.
// @fails-if a length terminal is treated as success or the idle timer measures total duration instead of data-byte gaps.
it('accepts slow continuous structured data but rejects capped structured output before submission', async () => {
  let capped = false;
  let cappedTurns = 0;
  await serve((response, body) => {
    const tools = body.tools as { function: { name: string } }[];
    if (capped) {
      cappedTurns++;
      expect(body.max_tokens ?? body.max_completion_tokens).toBe(cappedTurns === 1 ? 64 : 32);
    }
    const argumentsText = capped && cappedTurns === 2 ? submitted.replace('"u"', '"v"') : submitted;
    event(response, {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: 'submit',
          type: 'function',
          function: { name: tools[0].function.name, arguments: '' },
        },
      ],
    });
    let offset = 0;
    const timer = setInterval(() => {
      event(response, {
        tool_calls: [
          { index: 0, function: { arguments: argumentsText.slice(offset, offset + 30) } },
        ],
      });
      offset += 30;
      if (offset >= argumentsText.length) {
        clearInterval(timer);
        event(
          response,
          {},
          capped && cappedTurns === 2 ? 'length' : 'tool_calls',
          capped ? 32 : 10,
        );
        response.end('data: [DONE]\n\n');
      }
    }, 40);
    response.on('close', () => clearInterval(timer));
  });
  const normal = await runTask(kind, input, { db: testDb(), override, judgeRetryPolicy: 'none' });
  expect(normal.structured_output).toMatchObject({
    units: [{ scoring_unit_id: 'u', status: 'solved' }],
  });
  capped = true;
  setTestConfig({ [`task.${kind}.output_cap_tokens`]: 64 });
  await expect(
    runTask(
      kind,
      { ...input, units: [...input.units, { ...input.units[0], scoring_unit_id: 'v' }] },
      { db: testDb(), override, judgeRetryPolicy: 'none' },
    ),
  ).rejects.toMatchObject({
    errors: expect.arrayContaining([expect.stringContaining('output_cap_exceeded')]),
  });
  expect(sends).toBe(3);
  expect(await testDb().select().from(ai_task_runs)).toHaveLength(2);
  expect(await testDb().select().from(cost_ledger)).toHaveLength(2);
});
