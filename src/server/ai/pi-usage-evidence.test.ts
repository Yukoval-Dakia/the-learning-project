import { normalizeContext } from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import { expect, it, vi } from 'vitest';
import { resolveAttemptCostTruth } from './attempt-cost';
import { piAssistantToSdkFrame, piTerminalResultFrame } from './pi-agent-adapter';
import { withPiUsageEvidence } from './pi-usage-evidence';
import { createSdkTerminalEvidenceCollector } from './sdk-terminal';

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
it.each([
  undefined,
  { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  { prompt_tokens: 260, completion_tokens: 80, total_tokens: 340 },
])('distinguishes raw usage evidence %j through the real pi driver', async (usage) => {
  const fetch = vi.fn(
    async () =>
      new Response(
        `${[
          {
            id: 'offline-response',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'mimo-v2.5',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'Final answer' },
                finish_reason: null,
              },
            ],
          },
          {
            id: 'offline-response',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'mimo-v2.5',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          },
          ...(usage === undefined ? [] : [{ id: 'offline-response', choices: [], usage }]),
        ]
          .map((x) => `data: ${JSON.stringify(x)}\n\n`)
          .join('')}data: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
  );
  const observer = vi.fn();
  const events = await withPiUsageEvidence(
    (m, c, o) => stream(m as typeof model, c, o),
    model,
    normalizeContext({ messages: [{ role: 'user', content: 'Answer', timestamp: 1 }] }),
    { apiKey: 'offline-fixture', fetch, onProviderStreamEvent: observer },
  );
  const eventTypes: string[] = [];
  for await (const event of events) eventTypes.push(event.type);
  expect(eventTypes).toContain('done');
  const message = await events.result();
  expect(message.stopReason).toBe('stop');
  expect(fetch).toHaveBeenCalledOnce();
  const assistant = piAssistantToSdkFrame(message, 'offline-session');
  const terminal = piTerminalResultFrame({
    messages: [message],
    model,
    sessionId: 'offline-session',
    durationMs: 10,
    numTurns: 1,
    aborted: false,
  });
  const collector = createSdkTerminalEvidenceCollector();
  collector.observeAssistant(assistant as import('./sdk-types').SDKAssistantMessage);
  const evidence = collector.fromResult(terminal as import('./sdk-types').SDKResultMessage);
  const cost = resolveAttemptCostTruth({
    provider: 'xiaomi',
    model: 'mimo-v2.5',
    tokens: evidence.tokenCounts,
    tokensObserved: evidence.tokenUsageObserved,
    reportedCostUsd: evidence.costUsd,
  });
  expect(observer).toHaveBeenCalled();
  expect(cost.basis).toBe(usage === undefined ? 'unknown' : 'estimated');
  expect(evidence.tokenUsageObserved).toBe(usage !== undefined);
  if (usage?.total_tokens === 0) expect(cost.amountUsd).toBe(0);
});
