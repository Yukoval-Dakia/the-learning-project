import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { event, job_events, learning_session } from '@/db/schema';
import { getEventById, getEventChain } from '@/kernel/events';
import type { DomainTool } from '@/kernel/tools/types';
import { executeDomainToolCall } from '@/server/ai/tools/mcp-bridge';
import { writeJobEvent } from '@/server/events/writer';
import { regenerateMemoryBrief } from '@/server/memory/brief';
import { authorizeMemoryIngestReplay } from '@/server/memory/memory-ingest-recovery-store';
import { dispatchMemoryReconcile } from '@/server/memory/memory-reconcile-handoff';
import {
  buildMemoryEventIngestHandler,
  buildMemoryReconcileHandler,
} from '@/server/memory/triggers';
import {
  clearAgentSdkSessionId,
  getAgentSdkSessionId,
  setAgentSdkSessionId,
} from '@/server/session/conversation';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { memoryClientMock } from '../../../../tests/helpers/memory-client-mock';
import {
  reconcileCopilotDurableRun,
  runCopilotRun,
  writeSuccessfulTerminalProjection,
} from '../jobs/copilot_run';
import { writeCopilotReply, writeTeachingCopilotReply } from './conversation-writes';
import { createCopilotExecutionOwner } from './copilot-execution';
import { assembleCopilotRunInput } from './copilot-run-input';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from './copilot-run-status';
import {
  isCopilotWorkerSessionOwned,
  registerCopilotWorkerSession,
} from './copilot-worker-session';
import { acceptedCopilotDerivationPolicy } from './derivation-policy';
import { hashCopilotDurableInput, reserveCopilotDurableAcceptance } from './durable-dispatch';
import { queryEventsTool } from './tools/query-events';
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

  it('rejects source/job/queued policy and original body mismatches before execution', async () => {
    const data = await accept('answer_only');
    await expect(
      acceptedCopilotDerivationPolicy(testDb(), { ...data, derivation_policy: 'allow' }),
    ).rejects.toThrow('accepted source');
    await expect(
      acceptedCopilotDerivationPolicy(testDb(), {
        ...data,
        ambient: { route: '/changed-after-acceptance' },
      }),
    ).rejects.toThrow('acceptance policy mismatch');
    await expect(
      acceptedCopilotDerivationPolicy(testDb(), {
        ...data,
        user_message: 'silently changed original text',
      }),
    ).rejects.toThrow('accepted source');
    await testDb()
      .update(job_events)
      .set({ payload: { session_id: sessionId, derivation_policy: 'allow', job_data: data } })
      .where(eq(job_events.business_id, data.run_id));
    await expect(acceptedCopilotDerivationPolicy(testDb(), data)).rejects.toThrow(
      'acceptance policy mismatch',
    );
  });

  it('blocks teaching before materialization and blocks independent teaching commit', async () => {
    const data = await accept('answer_only');
    const skill = {
      skill: 'teaching' as const,
      ref: { kind: 'learning_item', id: 'li_exploration' },
    };
    const delivered = { ...data, skill_context: skill };
    // Freeze this exact body as a malicious but valid accepted request.
    await testDb()
      .update(job_events)
      .set({
        payload: { session_id: sessionId, derivation_policy: 'answer_only', job_data: delivered },
      })
      .where(eq(job_events.business_id, data.run_id));
    const teaching = vi.fn();
    await runCopilotRun({
      db: testDb(),
      data: delivered,
      runTeachingSkillFn: teaching,
      resolveCopilotRunInputFn: (db, params) =>
        assembleCopilotRunInput(db, params, { resolveLearnerStateHeaderFn: async () => header }),
    });
    expect(teaching).not.toHaveBeenCalled();
    await assertRestrictedLifecycle(data.run_id);
    await expect(
      writeTeachingCopilotReply(testDb(), {
        sessionId,
        userAskEventId: data.run_id,
        actorRef: 'agent:copilot',
        skillContext: skill,
        skillResult: {
          kind: 'end',
          suggested_next: 'end',
          task_run_id: 'teaching_bypass',
          text_md: message,
        },
        now: new Date(),
      }),
    ).rejects.toThrow('不创建教学练习');
  });

  it('guards direct tools by fixed name and effect; null-session mirrors inherit the accepted root', async () => {
    const data = await accept('answer_only');
    const execute = vi.fn(async (_ctx, input: { query: string }) => ({ excerpt: input.query }));
    const tool: DomainTool<{ query: string }, { excerpt: string }> = {
      name: 'query_knowledge',
      effect: 'read',
      description: 'read fixture',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ excerpt: z.string() }),
      costClass: 'local',
      execute,
      summarize: () => '已有知识：含参边界与反例',
      mirrorEvent: 'always',
    };
    const ctx = {
      db: testDb(),
      taskRunId: 'root_tool_fixture',
      callerActor: { kind: 'agent' as const, ref: 'agent:copilot' },
      causedByEventId: data.run_id,
    };
    await executeDomainToolCall(tool, { query: message }, { ctx });
    expect(execute).toHaveBeenCalledOnce();
    for (const denied of [
      { name: 'author_artifact', effect: 'write' as const },
      { name: 'generate_question_candidate', effect: 'read' as const },
      { name: 'query_knowledge', effect: 'propose' as const },
      { name: 'present_primary_view', effect: 'control' as const },
    ]) {
      const result = await executeDomainToolCall(
        { ...tool, ...denied },
        { query: message },
        { ctx },
      );
      expect(JSON.stringify(result)).toContain('仅用于本次回答');
    }
    expect(execute).toHaveBeenCalledOnce();
    const mirrors = await testDb().select().from(event).where(eq(event.action, 'tool_use'));
    expect(mirrors).toHaveLength(5);
    for (const mirror of mirrors) {
      expect(mirror.session_id).toBeNull();
      expect(mirror.payload.derivation_policy).toBe('answer_only');
      expect(mirror.ingest_at).not.toBeNull();
      expect(mirror.affected_scopes).toEqual([]);
    }
    const allowed = await accept('allow', '日常学习：建立可复验的计划。');
    await executeDomainToolCall(
      { ...tool, name: 'author_artifact', effect: 'write' },
      { query: message },
      { ctx: { ...ctx, causedByEventId: allowed.run_id } },
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('keeps ordinary→restricted→ordinary history visible while filtering cold/replay/validator/compaction and correction references', async () => {
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
    expect(JSON.stringify(input.validator_context_history)).toContain('日常回答');
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

  it('excludes restricted evidence from generic AI readers, brief input and evidence; raw lookup stays visible', async () => {
    const restricted = await accept('answer_only');
    const reply = await writeCopilotReply(testDb(), {
      sessionId,
      userAskEventId: restricted.run_id,
      replyText: message,
      actorRef: 'agent:copilot',
      taskRunId: 'brief_restricted',
      now: new Date(),
    });
    const ordinary = await accept('allow', '日常学习：长期复验安排必须依据独立作答。');
    expect(await getEventById(testDb(), reply.replyEventId)).not.toBeNull();
    expect(await getEventById(testDb(), reply.replyEventId, { forDerivation: true })).toBeNull();
    const chain = await getEventChain(testDb(), restricted.run_id);
    expect(chain.caused_events).toHaveLength(1);
    const query = await queryEventsTool.execute(
      {
        db: testDb(),
        taskRunId: 'reader_fixture',
        callerActor: { kind: 'agent', ref: 'agent:copilot' },
      },
      { filter: { eventId: restricted.run_id } },
    );
    expect(query.events).toEqual([]);
    const generate = vi.fn(async (input) => {
      expect(input.events.map((e: { id: string }) => e.id)).not.toContain(restricted.run_id);
      return {
        recent_week_md: '日常证据摘要',
        recent_months_md: '',
        long_term_md: '',
        recent_week_evidence_ids: [restricted.run_id, ordinary.run_id],
        recent_months_evidence_ids: [reply.replyEventId],
        long_term_evidence_ids: [restricted.run_id],
      };
    });
    const { row } = await regenerateMemoryBrief({ db: testDb(), scopeKey: 'global', generate });
    expect(row.recent_week_evidence_ids).toEqual([ordinary.run_id]);
    expect(row.recent_months_evidence_ids).toEqual([]);
    expect(row.long_term_evidence_ids).toEqual([]);
    await expect(
      authorizeMemoryIngestReplay(testDb(), {
        sourceEventId: restricted.run_id,
        requestId: randomUUID(),
        expectedFenceId: 'fake-fence',
        operator: 'test:authorized-owner',
        allowPaidReplay: true,
        reason: 'Attempt to recover an input that explicitly forbids derivation.',
      }),
    ).rejects.toThrow('operator replay requires');
  });

  it('publishes ordinary cursor before terminal, clears restricted cursor at the execution fence and leaves the successor intact on replay', async () => {
    const ordinary = await accept('allow', '日常资料：定义域需要独立复验。');
    const assemble: NonNullable<Parameters<typeof runCopilotRun>[0]['resolveCopilotRunInputFn']> = (
      db,
      params,
    ) => assembleCopilotRunInput(db, params, { resolveLearnerStateHeaderFn: async () => header });
    await runCopilotRun({
      db: testDb(),
      data: ordinary,
      executeCopilotTurnFn: silentOwner,
      resolveCopilotRunInputFn: assemble,
      writeSuccessfulTerminalProjectionFn: async (db, projection, events) => {
        expect(await getAgentSdkSessionId(db, sessionId)).toBe('pi:restricted_candidate');
        await writeSuccessfulTerminalProjection(db, projection, events);
      },
    });
    const restricted = await accept('answer_only');
    const execute = vi.fn<NonNullable<Parameters<typeof runCopilotRun>[0]['executeCopilotTurnFn']>>(
      async (db, turn, policy) => {
        expect(await getAgentSdkSessionId(db, sessionId)).toBeNull();
        expect(isCopilotWorkerSessionOwned(sessionId, 'pi:restricted_candidate')).toBe(false);
        expect(policy.resumeSessionId).toBeUndefined();
        return silentOwner(db, turn, policy);
      },
    );
    await runCopilotRun({
      db: testDb(),
      data: restricted,
      executeCopilotTurnFn: execute,
      resolveCopilotRunInputFn: assemble,
    });
    const next = await accept('allow', '日常学习：只使用本条新提交的反例证据。');
    await runCopilotRun({
      db: testDb(),
      data: next,
      executeCopilotTurnFn: silentOwner,
      resolveCopilotRunInputFn: assemble,
    });
    await runCopilotRun({ db: testDb(), data: restricted, executeCopilotTurnFn: execute });
    expect(execute).toHaveBeenCalledOnce();
    expect(await getAgentSdkSessionId(testDb(), sessionId)).toBe('pi:restricted_candidate');
    expect(isCopilotWorkerSessionOwned(sessionId, 'pi:restricted_candidate')).toBe(true);
  });

  it('late cursor cleanup cannot erase a successor cursor', async () => {
    await setAgentSdkSessionId(testDb(), sessionId, 'pi:successor');
    await clearAgentSdkSessionId(testDb(), sessionId, 'pi:old_owned');
    expect(await getAgentSdkSessionId(testDb(), sessionId)).toBe('pi:successor');
  });
});
