import { eq, sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { copilot_continuation, subagent_run } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { seedLegacySubagentRun } from '../../../../tests/helpers/legacy-subagent';
import { assertCopilotLegacyDrained } from './legacy-drain-readiness';
import { recordNativeSubagentStarted } from './subagent-mailbox';

const queues = [
  'copilot_subagent_run',
  'copilot_continuation',
  'copilot_subagent_run_dlq',
  'copilot_continuation_dlq',
  'copilot_subagent_reconcile',
];
let boss: PgBoss;
async function cleanup() {
  await testDb().delete(copilot_continuation);
  await testDb().delete(subagent_run);
  await testDb().execute(sql`DELETE FROM pgboss.job WHERE name IN
    ('copilot_subagent_run','copilot_continuation','copilot_subagent_run_dlq',
      'copilot_continuation_dlq','copilot_subagent_reconcile')`);
  await boss.unschedule('copilot_subagent_reconcile');
}
beforeAll(async () => {
  boss = new PgBoss({
    connectionString: process.env.TEST_DATABASE_URL,
    supervise: false,
    schedule: false,
  });
  await boss.start();
  for (const name of queues) await boss.createQueue(name, { retryLimit: 2, retryDelay: 30 });
});
beforeEach(async () => {
  await cleanup();
  await resetDb();
});
afterEach(cleanup);
afterAll(async () => {
  await boss.stop();
});

function legacy(status: 'queued' | 'running') {
  return seedLegacySubagentRun(testDb(), {
    sessionId: 'retirement_fixture',
    parentTurnEventId: 'retirement_ask',
    parentTaskRunId: 'retirement_parent',
    launchKey: `historical_${status}`,
    status,
    objective: '核对长材料的多层因果、不同来源、反例及未验证边界；历史运行必须保留以便排空。',
  });
}

describe('retired Copilot execution deployment readiness', () => {
  it.each(['queued', 'running'] as const)(
    'refuses a %s legacy child without changing it',
    async (status) => {
      const { record } = await legacy(status);
      await expect(assertCopilotLegacyDrained(testDb())).rejects.toThrow('legacy drain required');
      const [row] = await testDb()
        .select()
        .from(subagent_run)
        .where(eq(subagent_run.id, record.id));
      expect(row?.status).toBe(status);
      expect(row?.settled_event_id).toBeNull();
    },
  );
  it.each(['pending', 'running'] as const)('refuses a %s continuation', async (status) => {
    const { record } = await legacy('running');
    await testDb()
      .update(subagent_run)
      .set({ status: 'succeeded' })
      .where(eq(subagent_run.id, record.id));
    await testDb().insert(copilot_continuation).values({
      id: 'historical_continuation',
      subagent_run_id: record.id,
      session_id: record.sessionId,
      parent_turn_event_id: record.parentTurnEventId,
      result_event_id: 'historical_result',
      status,
    });
    await expect(assertCopilotLegacyDrained(testDb())).rejects.toThrow('"continuations":1');
    expect((await testDb().select().from(copilot_continuation))[0]?.status).toBe(status);
  });
  it.each(queues)('refuses queued work in %s even with empty domain tables', async (queue) => {
    await boss.send(queue, {
      historical: true,
      nested: { source: 'previous worker', unknown: null },
    });
    await expect(assertCopilotLegacyDrained(testDb())).rejects.toThrow('"jobs":1');
  });
  it('refuses active and retry jobs until the old worker actually settles them', async () => {
    const queue = 'copilot_subagent_run';
    const id = await boss.send(queue, { historical: true });
    if (!id) throw new Error('job was not created');
    await boss.fetch(queue);
    await expect(assertCopilotLegacyDrained(testDb())).rejects.toThrow('"jobs":1');
    await boss.fail(queue, id, { reason: 'synthetic retry' });
    await expect(assertCopilotLegacyDrained(testDb())).rejects.toThrow('"jobs":1');
    const [row] = await testDb().execute<{ state: string }>(
      sql`SELECT state FROM pgboss.job WHERE id=${id}`,
    );
    expect(row?.state).toBe('retry');
  });
  it('refuses an empty but still scheduled legacy recovery queue', async () => {
    await boss.schedule('copilot_subagent_reconcile', '* * * * *');
    await expect(assertCopilotLegacyDrained(testDb())).rejects.toThrow('"schedules":1');
    await boss.unschedule('copilot_subagent_reconcile');
    await expect(assertCopilotLegacyDrained(testDb())).resolves.toBeUndefined();
  });
  it('preserves terminal history and a running native child', async () => {
    const { record } = await legacy('running');
    await testDb()
      .update(subagent_run)
      .set({ status: 'succeeded' })
      .where(eq(subagent_run.id, record.id));
    await testDb().insert(copilot_continuation).values({
      id: 'historical_done',
      subagent_run_id: record.id,
      session_id: record.sessionId,
      parent_turn_event_id: record.parentTurnEventId,
      result_event_id: 'historical_result',
      status: 'succeeded',
    });
    const native = await recordNativeSubagentStarted(testDb(), {
      sessionId: 'native_active',
      parentTurnEventId: 'native_ask',
      parentTaskRunId: 'native_parent',
      sdkTaskId: 'native_child',
      objective:
        'A current parent owns this read-only native child; migration must not guess it dead.',
    });
    const id = await boss.send('copilot_subagent_run', { historical: true });
    if (!id) throw new Error('job was not created');
    await boss.fetch('copilot_subagent_run');
    await boss.complete('copilot_subagent_run', id);
    await expect(assertCopilotLegacyDrained(testDb())).resolves.toBeUndefined();
    expect(
      (
        await testDb()
          .select()
          .from(subagent_run)
          .where(eq(subagent_run.id, native?.id ?? ''))
      )[0]?.status,
    ).toBe('running');
    expect(await testDb().select().from(copilot_continuation)).toHaveLength(1);
    expect(await testDb().execute(sql`SELECT id FROM pgboss.job WHERE id=${id}`)).toHaveLength(1);
  });
});
