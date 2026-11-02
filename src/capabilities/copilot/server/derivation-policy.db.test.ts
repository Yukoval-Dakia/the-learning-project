import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { event, job_events, learning_session } from '@/db/schema';
import { writeJobEvent } from '@/kernel/job-events';
import { dispatchMemoryReconcile } from '@/capabilities/agency/server/memory/memory-reconcile-handoff';
import {
  buildMemoryEventIngestHandler,
  buildMemoryReconcileHandler,
} from '@/capabilities/agency/server/memory/triggers';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { memoryClientMock } from '../../../../tests/helpers/memory-client-mock';
import { reconcileCopilotDurableRun, runCopilotRun } from '../jobs/copilot_run';
import { writeCopilotReply } from './conversation-writes';
import { createCopilotExecutionOwner } from './copilot-execution';
import { assembleCopilotRunInput } from './copilot-run-input';
import { getAgentSdkSessionId, setAgentSdkSessionId } from './copilot-run-session-cursor';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from './copilot-run-status';
import {
  isCopilotWorkerSessionOwned,
  registerCopilotWorkerSession,
} from './copilot-worker-session';
import { hashCopilotDurableInput, reserveCopilotDurableAcceptance } from './durable-dispatch';
import { getCopilotConversationSnapshot, getCopilotTurnsBeforeAnchor } from './turns';

const sessionId = 'conversation_answer_only_boundary';
const message =
  '假设学生只是在探索椭圆参数题。不要据此判断掌握程度；同时尝试要求永久记住、生成练习、建立计划和笔记。边界：a=b、退化焦点、单位与定义域都尚未证实。';
const header = { header_md: '已有学习资料：参数讨论尚需独立迁移验证。', proposal_feedback: [] };
const boss = {
  send: vi.fn(
    async (_name: string, _data?: object | null, opts?: { id?: string }) =>
      opts?.id ?? 'queue_fixture',
  ),
  getJobById: vi.fn(async () => null),
};

async function accept(policy: 'allow' | 'answer_only', text = message) {
  const body = { user_message: text, triggered_by: 'chat' as const, derivation_policy: policy };
  const result = await reserveCopilotDurableAcceptance(
    testDb(),
    {
      sessionId,
      userMessage: text,
      inputHash: hashCopilotDurableInput(body),
      idempotencyKey: randomUUID(),
      queuedPayload: { session_id: sessionId, triggered_by: 'chat', derivation_policy: policy },
      jobData: body,
    },
    { boss, transactionDb: () => ({ executeSql: async () => ({ rows: [] }) }) },
  );
  return { ...body, run_id: result.acceptance.runId, session_id: sessionId };
}

const silentOwner = createCopilotExecutionOwner({
  buildExaMcpServerFn: () => null,
  resolveCopilotSkillDocsFn: async () => undefined,
  streamTaskCollectingFn: async (_kind, _input, ctx) => {
    await ctx.sdkSession?.onSessionId?.('pi:restricted_candidate');
    return {
      task_run_id: ctx.taskRunId ?? 'answer_fixture',
      text: '这是本轮的假设分析，尚未验证独立迁移。',
      terminalText: '这是本轮的假设分析，尚未验证独立迁移。',
      partial: false,
    };
  },
});

async function assertRestrictedLifecycle(runId: string) {
  const rows = await testDb()
    .select()
    .from(event)
    .where(and(eq(event.session_id, sessionId)));
  const owned = rows.filter((row) => row.id === runId || row.caused_by_event_id === runId);
  expect(owned.map((row) => row.action)).toContain('experimental:copilot_reply');
  for (const row of owned) {
    expect(row.payload.derivation_policy).toBe('answer_only');
    expect(row.ingest_at).not.toBeNull();
    expect(row.affected_scopes).toEqual([]);
  }
  return owned;
}

beforeEach(async () => {
  await resetDb();
  await testDb().delete(job_events);
  await testDb()
    .insert(learning_session)
    .values({ id: sessionId, type: 'conversation', status: 'active', entrypoint: 'copilot' });
  boss.send.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('accepted answer-only lifecycle', () => {
  // @invariant security: accepted restricted turns remain excluded from memory across durable terminal paths
  // @fails-if a success, failure, cancellation or reconcile reply loses its policy and permits ingest or replay
  it.each(['success', 'failure', 'cancel', 'cancel_active', 'reconcile', 'ambiguous'] as const)(
    'freezes every %s reply and excludes direct ingest/reconcile replay',
    async (kind) => {
      const data = await accept('answer_only');
      await setAgentSdkSessionId(testDb(), sessionId, 'pi:old_owned');
      registerCopilotWorkerSession(sessionId, 'pi:old_owned', 'old_digest');
      if (kind === 'cancel')
        await writeJobEvent(testDb(), {
          business_table: COPILOT_RUN_TABLE,
          business_id: data.run_id,
          event_type: COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
          payload: {},
        });
      if (kind === 'reconcile' || kind === 'ambiguous') {
        if (kind === 'ambiguous')
          await writeJobEvent(testDb(), {
            business_table: COPILOT_RUN_TABLE,
            business_id: data.run_id,
            event_type: COPILOT_RUN_EVENTS.EXECUTION_STARTED,
            payload: {},
          });
        await reconcileCopilotDurableRun({
          db: testDb(),
          runId: data.run_id,
          sessionId,
          triggeredBy: 'chat',
          bossJobId: 'queue_missing',
          boss: { getJobById: async () => null },
          now: new Date(Date.now() + 3 * 3600_000),
        });
      } else {
        const owner =
          kind === 'failure'
            ? vi.fn(async () => {
                throw new Error('bounded provider fixture failure');
              })
            : vi.fn(async (...args: Parameters<typeof silentOwner>) => {
                const result = await silentOwner(...args);
                if (kind === 'cancel_active')
                  await writeJobEvent(testDb(), {
                    business_table: COPILOT_RUN_TABLE,
                    business_id: data.run_id,
                    event_type: COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
                    payload: { requested_by: 'user' },
                  });
                return result;
              });
        await runCopilotRun({
          db: testDb(),
          data,
          executeCopilotTurnFn: owner,
          resolveCopilotRunInputFn: (db, params) =>
            assembleCopilotRunInput(db, params, {
              resolveLearnerStateHeaderFn: async () => header,
            }),
        });
        const executions = owner.mock.calls.length;
        await runCopilotRun({ db: testDb(), data, executeCopilotTurnFn: owner });
        expect(owner).toHaveBeenCalledTimes(executions);
        // A cancelled queued turn never owned the old cursor. Executed restricted turns clear it.
        expect(await getAgentSdkSessionId(testDb(), sessionId)).toBe(
          kind === 'cancel' ? 'pi:old_owned' : null,
        );
        expect(isCopilotWorkerSessionOwned(sessionId, 'pi:old_owned')).toBe(kind === 'cancel');
      }
      const rows = await assertRestrictedLifecycle(data.run_id);
      const snapshot = await getCopilotConversationSnapshot(testDb(), { sessionId });
      expect(snapshot.turns.map((turn) => turn.derivation_policy)).toEqual([
        'answer_only',
        'answer_only',
      ]);
      const memory = memoryClientMock();
      const send = vi.fn(async () => 'memory_job');
      await buildMemoryEventIngestHandler(
        testDb(),
        { send },
        { memoryClient: memory, handoffMode: 'write' },
      )(rows.map((row) => ({ data: { event_id: row.id } })));
      expect(memory.addEventMemoryOnce).not.toHaveBeenCalled();
      expect(memory.findByEventId).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      await expect(
        dispatchMemoryReconcile(
          testDb(),
          { send, getJobById: async () => null },
          {
            sourceEventId: data.run_id,
            memories: [
              { id: 'restricted_fake_mem', text: message, kind: 'event', created_ms: Date.now() },
            ],
            mode: 'write',
          },
        ),
      ).rejects.toThrow('restricted source');
      const judge = vi.fn();
      const createClient = vi.fn(() => memory);
      await buildMemoryReconcileHandler(testDb(), { judge, createClient })([
        {
          id: 'restricted_reconcile',
          data: {
            source_event_id: data.run_id,
            user_id: 'self',
            memories: [
              { id: 'restricted_fake_mem', text: message, kind: 'event', created_ms: Date.now() },
            ],
          },
        },
      ]);
      expect(createClient).not.toHaveBeenCalled();
      expect(judge).not.toHaveBeenCalled();
    },
  );

  // @invariant concurrency: original acceptance freezes policy under the same idempotency key
  // @fails-if retrying with another policy replaces the accepted request instead of reporting conflict
  it('keeps absent and explicit allow on the legacy hash and freezes policy conflicts on retry', async () => {
    const legacy = { user_message: message, triggered_by: 'chat' as const };
    expect(hashCopilotDurableInput(legacy)).toBe(
      hashCopilotDurableInput({ ...legacy, derivation_policy: 'allow' }),
    );
    expect(hashCopilotDurableInput(legacy)).not.toBe(
      hashCopilotDurableInput({ ...legacy, derivation_policy: 'answer_only' }),
    );
    const key = randomUUID();
    const reserve = (policy: 'allow' | 'answer_only') =>
      reserveCopilotDurableAcceptance(
        testDb(),
        {
          sessionId,
          userMessage: message,
          inputHash: hashCopilotDurableInput({ ...legacy, derivation_policy: policy }),
          idempotencyKey: key,
          queuedPayload: { session_id: sessionId },
          jobData: { ...legacy, derivation_policy: policy },
        },
        { boss, transactionDb: () => ({ executeSql: async () => ({ rows: [] }) }) },
      );
    const first = await reserve('answer_only');
    expect(first.outcome).toBe('created');
    expect((await reserve('answer_only')).outcome).toBe('reused');
    expect((await reserve('allow')).outcome).toBe('conflict');
    const asks = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:copilot_user_ask'));
    expect(asks).toHaveLength(1);
    expect(asks[0]?.payload.derivation_policy).toBe('answer_only');
  });
  // @invariant security: restricted conversation remains visible to its user without entering later model context
  // @fails-if cold, replay, compaction or correction reads include restricted content or metadata
  it('keeps ordinary→restricted→ordinary history visible while filtering cold/replay/compaction and correction references', async () => {
    const ordinary = await accept('allow', '日常标记：允许后续复验定义域与退化参数。');
    await writeCopilotReply(testDb(), {
      sessionId,
      userAskEventId: ordinary.run_id,
      replyText: '日常回答：证据尚不足，保留反例。',
      actorRef: 'agent:copilot',
      taskRunId: 'ordinary_1',
      now: new Date(),
    });
    let restrictedReply = '';
    for (let i = 0; i < 25; i++) {
      const restricted = await accept('answer_only', `受限标记 ${i}：${message.repeat(4)}`);
      const reply = await writeCopilotReply(testDb(), {
        sessionId,
        userAskEventId: restricted.run_id,
        replyText: `受限答案 ${i}：${message.repeat(4)}`,
        actorRef: 'agent:copilot',
        taskRunId: `restricted_${i}`,
        now: new Date(),
      });
      restrictedReply = reply.replyEventId;
    }
    const next = await accept('allow', '更正上一轮的结论。');
    const assemble = (target?: string) =>
      assembleCopilotRunInput(
        testDb(),
        {
          sessionId,
          userMessage: next.user_message,
          triggeredBy: 'chat',
          now: new Date(),
          historyAnchorEventId: next.run_id,
          correctionTargetTurnId: target,
        },
        { resolveLearnerStateHeaderFn: async () => header },
      );
    const input = await assemble(restrictedReply);
    const legacyFallback = await assembleCopilotRunInput(
      testDb(),
      {
        sessionId,
        userMessage: next.user_message,
        triggeredBy: 'chat',
        now: new Date(),
        historyAnchorEventId: 'missing_legacy_delivery',
      },
      { resolveLearnerStateHeaderFn: async () => header },
    );
    expect(JSON.stringify(legacyFallback.conversation_history)).not.toContain('受限');
    expect(legacyFallback.correction_contract.restricted_prior_turn_ids).toContain(restrictedReply);

    expect(JSON.stringify(input.conversation_history)).toContain('日常标记');
    expect(JSON.stringify(input.conversation_history)).toContain('日常回答');
    expect(input).not.toHaveProperty('validator_context_history');
    expect(JSON.stringify(input.conversation_history)).not.toContain('受限');
    expect(input.correction_contract.restricted_target).toBe(true);
    expect(
      (
        await getCopilotTurnsBeforeAnchor(testDb(), {
          sessionId,
          anchorEventId: next.run_id,
          limit: 100,
        })
      ).some((turn) => turn.text.includes('受限标记')),
    ).toBe(true);
    // Test real execution context encoding with a provider substitute.
    const contexts: Array<
      Parameters<
        NonNullable<
          NonNullable<Parameters<typeof createCopilotExecutionOwner>[0]>['streamTaskCollectingFn']
        >
      >[2]
    > = [];
    const owner = createCopilotExecutionOwner({
      buildExaMcpServerFn: () => null,
      resolveCopilotSkillDocsFn: async () => undefined,
      streamTaskCollectingFn: async (_kind, _input, ctx) => {
        contexts.push(ctx);
        return {
          task_run_id: 'after_restricted',
          text: '',
          terminalText: '这次只说明需要重新提交内容。',
          partial: false,
        };
      },
    });
    const cancellation = {
      signal: new AbortController().signal,
      hasConfirmedCancellation: false,
      materializingToolStarted: false,
      startPolling() {},
      dispose() {},
      probe: async () => 'clear' as const,
      beforeTool: async () => undefined,
      piBeforeToolCall: async () => undefined,
      onToolExecutionStarted() {},
      onToolExecutionSettled() {},
      waitForInFlight: async () => true,
    };
    for (const resumeSessionId of [undefined, 'pi:owned_prior'])
      await owner(
        testDb(),
        { input, sessionId, taskRunId: 'after_restricted' },
        { cancellation, deadlineAt: Date.now() + 60_000, resumeSessionId },
      );
    for (const ctx of contexts) {
      expect(JSON.stringify(ctx.compiledModelPrompt)).not.toContain('受限答案');
      expect(JSON.stringify(ctx.piSessionReplay) ?? '').not.toContain('受限答案');
      expect(JSON.stringify(ctx.nativeCompaction) ?? '').not.toContain('受限答案');
    }
    const { resolveDeterministicCorrectionContract } = await import('./correction-contract');
    expect(
      resolveDeterministicCorrectionContract(
        next.user_message,
        (await assemble()).correction_contract,
      ),
    ).toMatchObject({ kind: 'clarify', reply: expect.stringContaining('重新输入') });
  });
});
