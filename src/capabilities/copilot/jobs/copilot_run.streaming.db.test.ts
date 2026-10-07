import { createHash } from 'node:crypto';
import {
  type Api,
  type AssistantMessage,
  type Model,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilities } from '@/capabilities';
import { ai_task_runs, event, learning_session, tool_call_log } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { __setPiAdapterForTests } from '@/server/ai/execution-adapter';
import { type PiAdapterDeps, PiAgentAdapter } from '@/server/ai/pi-agent-adapter';
import { registerCapabilityTools } from '@/server/ai/tools/register-capability-tools';
import { computeReplay } from '@/server/events/sse_replay';
import { writeJobEvent } from '@/server/events/writer';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from '../server/copilot-run-status';
import { createCopilotRunView, foldCopilotRunFrames } from '../ui/subtask-events';
import { runCopilotRun } from './copilot_run';

beforeAll(() => registerCapabilityTools(capabilities));
beforeEach(() => resetDb());
afterEach(() => {
  __setPiAdapterForTests(undefined);
  vi.unstubAllEnvs();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const model: Model<Api> = {
  id: 'deepseek-v4-pro',
  name: 'offline stream fixture',
  provider: 'opencode-go',
  api: 'openai-completions',
  baseUrl: 'https://offline.invalid',
  input: ['text'],
  contextWindow: 262_144,
  maxTokens: 32_768,
  reasoning: true,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
};

function message(text: string, turn: number): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'opencode-go',
    model: model.id,
    responseId: `offline-${turn}`,
    usage: {
      input: 120,
      output: 45,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 180,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
    },
    stopReason: 'stop',
    timestamp: 1_700_000_000_000 + turn,
  };
}

async function frames(runId: string) {
  const replay = await computeReplay(testDb(), {
    businessTable: COPILOT_RUN_TABLE,
    businessId: runId,
    lastEventId: 0,
  });
  return replay.map((row) => ({
    event_id: row.id,
    event_type: row.event_type,
    payload: row.payload,
  }));
}

describe('real Pi loop → runner → execution → durable job stream', () => {
  it.each(['complete', 'cancel'] as const)(
    'persists partial provider text before message_end and %s with replay replacement',
    async (outcome) => {
      // Only the provider is scripted. The installed agentLoop, tool bridge,
      // usage collector, finalizer, job writer and stream reducer all run here.
      vi.stubEnv('OPENCODE_API_KEY', 'sk-offline-fixture');
      const runId = `copilot_user_ask_real_stream_${outcome}`;
      const sessionId = `session_real_stream_${outcome}`;
      const release = deferred();
      const first = deferred();
      const provisional = '先核对历史。题目：计算 17×19？\n';
      const visibleFinal = '解：17×20−17=323。\n答案：323。';
      const marker = '<!--copilot_learning_content:{"private":"legacy protocol"}-->';
      let calls = 0;
      const streamSimple = vi.fn<NonNullable<PiAdapterDeps['models']>['streamSimple']>(
        (_model, _context, options) => {
          calls += 1;
          const turn = calls;
          const stream = createAssistantMessageEventStream();
          void (async () => {
            const current = message(turn === 1 ? provisional : visibleFinal + marker, turn);
            stream.push({ type: 'start', partial: current });
            stream.push({
              type: 'thinking_delta',
              contentIndex: 1,
              delta: 'PRIVATE_REASONING',
              partial: current,
            });
            stream.push({
              type: 'text_delta',
              contentIndex: 0,
              delta: turn === 1 ? provisional : '解：17×20−17=323。\n',
              partial: current,
            });
            if (turn === 1) {
              first.resolve();
              await release.promise;
              if (options?.signal?.aborted) {
                current.stopReason = 'aborted';
                stream.push({
                  type: 'text_delta',
                  contentIndex: 0,
                  delta: 'late cancelled text',
                  partial: current,
                });
                stream.push({ type: 'error', reason: 'aborted', error: current });
                return;
              }
              current.content.push(
                {
                  type: 'toolCall',
                  id: 'read_asks',
                  name: 'mcp__loom__query_events',
                  arguments: { filter: { action: 'experimental:copilot_user_ask', limit: 3 } },
                },
                {
                  type: 'toolCall',
                  id: 'read_replies',
                  name: 'mcp__loom__query_events',
                  arguments: { filter: { action: 'experimental:copilot_reply', limit: 3 } },
                },
              );
              current.stopReason = 'toolUse';
            } else {
              for (const delta of [
                '答案：323。<!--copilot_',
                'learning_content:{"private":"legacy protocol"}-->',
              ])
                stream.push({ type: 'text_delta', contentIndex: 0, delta, partial: current });
            }
            stream.push({
              type: 'done',
              reason: current.stopReason === 'toolUse' ? 'toolUse' : 'stop',
              message: current,
            });
          })();
          return stream;
        },
      );
      __setPiAdapterForTests(
        new PiAgentAdapter({ models: { getModel: () => model, streamSimple } }),
      );
      await testDb()
        .insert(learning_session)
        .values({ id: sessionId, type: 'conversation', status: 'active', entrypoint: 'copilot' });
      await writeEvent(testDb(), {
        id: runId,
        session_id: sessionId,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'experimental:copilot_user_ask',
        subject_kind: 'query',
        subject_id: runId,
        payload: { surface: 'copilot', user_message: '核对历史后计算 17×19，并解释各步。' },
        created_at: new Date(),
      });
      const params = {
        db: testDb(),
        data: {
          run_id: runId,
          session_id: sessionId,
          user_message: '核对历史后计算 17×19，并解释各步。',
          triggered_by: 'chat' as const,
        },
        modelBinding: { provider: 'opencode-go' as const, model: model.id },
        copilotSubagentEnabled: false,
        resolveCopilotRunInputFn: async () => ({
          surface: 'copilot' as const,
          triggered_by: 'chat' as const,
          user_message: '核对历史后计算 17×19，并解释各步。',
          conversation_history: [],
          proposal_feedback: [],
          correction_contract: {
            available_prior_turn_ids: [],
            prior_turn_summaries: {},
            required_fields: ['prior_turn_id', 'changed', 'retained', 'uncertain'] as const,
          },
        }),
      };
      let settled = false;
      const running = runCopilotRun(params).then((result) => {
        settled = true;
        return result;
      });
      try {
        await first.promise;
        await vi.waitFor(async () => {
          expect(
            (await frames(runId)).some((frame) => frame.event_type === COPILOT_RUN_EVENTS.DELTA),
          ).toBe(true);
        });
        expect(settled).toBe(false);
        expect(calls).toBe(1);
        const before = await frames(runId);
        const disconnected = foldCopilotRunFrames(createCopilotRunView(), before);
        expect(disconnected.replyText).toBe(provisional);
        expect(disconnected.phase).toBe('running');
        expect(before.some((frame) => frame.event_type === COPILOT_RUN_EVENTS.REPLY)).toBe(false);
        if (outcome === 'cancel') {
          await writeJobEvent(testDb(), {
            business_table: COPILOT_RUN_TABLE,
            business_id: runId,
            event_type: COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
            payload: { requested_by: 'user' },
          });
          // Real cross-process cancellation polling reaches the provider signal.
          await vi.waitFor(
            () => expect(streamSimple.mock.calls[0]?.[2]?.signal?.aborted).toBe(true),
            { timeout: 3_000 },
          );
        }
        release.resolve();
        const result = await running;
        const all = await frames(runId);
        const replayed = foldCopilotRunFrames(disconnected, [...before, ...all]);
        expect(JSON.stringify(all)).not.toMatch(
          /PRIVATE_REASONING|legacy protocol|copilot_learning_content|late cancelled text/,
        );
        if (outcome === 'complete') {
          expect(result).toMatchObject({ status: 'done', reply: visibleFinal });
          expect(calls).toBe(2);
          expect(
            all
              .filter((frame) => frame.event_type === COPILOT_RUN_EVENTS.DELTA)
              .map((frame) => frame.payload.text)
              .join(''),
          ).toBe(provisional + visibleFinal);
          expect(replayed.replyText).toBe(visibleFinal);
          expect(replayed.phase).toBe('completed');
          const tools = await testDb().select().from(tool_call_log);
          expect(tools.filter((tool) => tool.tool_name === 'query_events')).toHaveLength(2);
          const [attempt] = await testDb()
            .select()
            .from(ai_task_runs)
            .where(eq(ai_task_runs.id, `copilot_run_tool_${runId}`));
          expect(attempt?.usage_json?.outputTokens).toBe(90);
          // Every emitted final receipt binds the authoritative bytes, not the draft.
          const replies = await testDb()
            .select()
            .from(event)
            .where(eq(event.action, 'experimental:copilot_reply'));
          expect(replies[0]?.payload).toMatchObject({
            reply_finalization: {
              protocol_version: 2,
              reply_sha256: createHash('sha256').update(visibleFinal).digest('hex'),
            },
          });
        } else {
          expect(result.status).toBe('cancelled');
          expect(calls).toBe(1);
          const [attempt] = await testDb()
            .select()
            .from(ai_task_runs)
            .where(eq(ai_task_runs.id, `copilot_run_tool_${runId}`));
          expect(attempt?.usage_json?.outputTokens).toBe(45);
          const cancel = all.find(
            (frame) => frame.event_type === COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
          );
          expect(
            all.some(
              (frame) =>
                frame.event_type === COPILOT_RUN_EVENTS.DELTA &&
                frame.event_id > (cancel?.event_id ?? 0),
            ),
          ).toBe(false);
          expect(replayed.phase).toBe('failed');
          expect(replayed.replyText).not.toBe(provisional);
        }
        const count = all.length;
        expect(await runCopilotRun(params)).toEqual(result);
        expect(await frames(runId)).toHaveLength(count);
        expect(calls).toBe(outcome === 'complete' ? 2 : 1);
      } finally {
        release.resolve();
        await running;
      }
    },
  );
});
