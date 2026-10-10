import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copilot_continuation, event, job_events, subagent_run } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { writeCopilotReply } from './conversation-writes';
import { acquireCopilotExecutionSettlementLock } from './copilot-run-coordination';
import * as mailbox from './subagent-mailbox';

// These operational tables are intentionally outside resetDb's domain list.
async function clearMailboxFixtures() {
  await testDb().delete(copilot_continuation);
  await testDb().delete(subagent_run);
  await testDb().delete(job_events);
}
beforeEach(clearMailboxFixtures);
afterEach(clearMailboxFixtures);

async function seedParent(input: { id: string; sessionId: string; action?: string }) {
  await writeEvent(testDb(), {
    id: input.id,
    session_id: input.sessionId,
    actor_kind: 'user',
    actor_ref: 'user:self',
    action: input.action ?? 'experimental:copilot_user_ask',
    subject_kind: 'query',
    subject_id: input.id,
    outcome: null,
    payload: { user_message: 'Compare two long derivations and verify every causal claim.' },
  });
}

describe('Copilot subagent mailbox', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it.each(['start', 'terminal'] as const)(
    'fences concurrent native %s behind the parent outcome commit',
    async (delivery) => {
      const sessionId = `native_fenced_${delivery}`;
      const parentTurnEventId = `ask_fenced_${delivery}`;
      const parentTaskRunId = `root_fenced_${delivery}`;
      await seedParent({ id: parentTurnEventId, sessionId });
      const started = await mailbox.recordNativeSubagentStarted(testDb(), {
        sessionId,
        parentTurnEventId,
        parentTaskRunId,
        sdkTaskId: 'native_original',
        objective: '交叉核对三份材料的来源、反例和未覆盖边界，逐项保留不确定性。',
      });
      if (!started) throw new Error('native fixture was not admitted');
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const parentCommit = testDb().transaction(async (tx) => {
        await acquireCopilotExecutionSettlementLock(tx, parentTurnEventId);
        await writeCopilotReply(tx, {
          sessionId,
          userAskEventId: parentTurnEventId,
          taskRunId: parentTaskRunId,
          actorRef: 'agent:copilot',
          replyText: '已停止这次运行。',
          outcome: 'failure',
          durableFailure: { reason: 'cancelled', error: 'owner requested Stop' },
          now: new Date(),
        });
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const late =
        delivery === 'start'
          ? mailbox.recordNativeSubagentStarted(testDb(), {
              sessionId,
              parentTurnEventId,
              parentTaskRunId,
              sdkTaskId: 'native_late_new',
              objective: '迟到的创建不应在已提交父终态后继续写入。',
            })
          : mailbox.settleNativeSubagentRun(testDb(), {
              sessionId,
              parentTurnEventId,
              sdkTaskId: 'native_original',
              outcome: { status: 'succeeded', result: '迟到的成功消息不能覆盖已取消的父回合。' },
            });
      try {
        await vi.waitFor(
          async () => {
            const waiters = await testDb().execute(sql`SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event = 'advisory' AND state = 'active'`);
            expect(waiters.length).toBeGreaterThan(0);
          },
          { timeout: 5_000, interval: 10 },
        );
      } finally {
        release.resolve();
        await parentCommit;
        await Promise.allSettled([late]);
      }
      const lateResult = await late;
      if (delivery === 'start') expect(lateResult).toBeNull();
      else expect(lateResult?.status).toBe('cancelled');
      await mailbox.reconcileNativeSubagentsForParent(testDb(), sessionId, parentTurnEventId);
      const rows = await testDb().select().from(subagent_run);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('cancelled');
      expect(await testDb().select().from(copilot_continuation)).toEqual([]);
      expect(
        await testDb()
          .select()
          .from(event)
          .where(eq(event.action, 'experimental:subagent_run_settled')),
      ).toHaveLength(1);
    },
  );
});
