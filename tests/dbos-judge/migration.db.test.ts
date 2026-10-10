import { eq, sql } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { lockJudgeRun, writeJudgeReceipt } from '@/capabilities/practice/server/judge-operational';
import { readJudgeRunPermanent } from '@/capabilities/practice/server/judge-run-observation';
import { JudgeOperationalEvent } from '@/core/schema/event/judge-operational-events';
import { event } from '@/db/schema';
import { readJudgeFamilyControl } from '@/server/durable/judge-family';
import { resetDb, testDb } from '../helpers/db';
import { dispatchFrozenJudge, resetJudgeControl } from './support';

beforeEach(async () => {
  await resetDb();
  await resetJudgeControl(testDb());
});
it('0118 retains one control row, exact unique receipt indexes and immutable operational rows', async () => {
  const control = await readJudgeFamilyControl(testDb());
  expect(control.phase).toBe('pg-boss');
  expect(control.epoch).toBe(0);
  await expect(
    testDb().execute(
      sql`insert into judge_run_control select 2,incarnation,epoch,phase,phase_changed_at,null from judge_run_control`,
    ),
  ).rejects.toThrow();
  const indexes = await testDb().execute(
    sql`select indexname from pg_indexes where schemaname='public' and indexname like 'judge_%'`,
  );
  expect(indexes.map((i) => i.indexname)).toEqual(
    expect.arrayContaining([
      'judge_binding_key_uq',
      'judge_binding_attempt_uq',
      'judge_reservation_slot_uq',
      'judge_send_uq',
      'judge_rejection_uq',
      'judge_acceptance_uq',
      'judge_disposition_run_uq',
    ]),
  );
  const f = await dispatchFrozenJudge(testDb(), {
    checkRateLimit: () => 1,
    boss: { send: async (_n, _d, o) => o?.id ?? null },
  });
  const before = await testDb().select().from(event).where(eq(event.id, f.input.reservation_id));
  const immutableReceiptError = {
    cause: { code: 'P0001', message: 'judge operational receipts are immutable' },
  };
  await expect(
    testDb().execute(
      sql`update event set payload=payload||'{}'::jsonb where id=${f.input.reservation_id}`,
    ),
  ).rejects.toMatchObject(immutableReceiptError);
  await expect(
    testDb().delete(event).where(eq(event.id, f.input.reservation_id)),
  ).rejects.toMatchObject(immutableReceiptError);
  expect(await testDb().select().from(event).where(eq(event.id, f.input.reservation_id))).toEqual(
    before,
  );
});
it('duplicate-ID writer reads, parses and compares immutable payload and replays its recorded timestamp', async () => {
  const f = await dispatchFrozenJudge(testDb(), {
      checkRateLimit: () => 1,
      boss: { send: async (_n, _d, o) => o?.id ?? null },
    }),
    [row] = await testDb().select().from(event).where(eq(event.id, f.input.reservation_id));
  if (!row) throw new Error('reservation');
  const receipt = JudgeOperationalEvent.parse(row);
  await testDb().transaction(async (tx) => {
    await lockJudgeRun(tx, f.runId);
    const replay = await writeJudgeReceipt(tx, row.id, receipt, new Date('2029-01-01'));
    expect(replay.createdAt).toEqual(row.created_at);
  });
  if (receipt.action !== 'experimental:judge_delivery_reserved')
    throw new Error('reservation schema');
  await expect(
    testDb().transaction((tx) =>
      writeJudgeReceipt(tx, row.id, {
        ...receipt,
        payload: { ...receipt.payload, delivery_id: 'conflicting-engine-identity' },
      }),
    ),
  ).rejects.toThrow('Immutable judge receipt conflict');
});
it('ordinary archive receipts lack the matching control incarnation and cannot revive execution', async () => {
  const f = await dispatchFrozenJudge(testDb(), {
    checkRateLimit: () => 1,
    boss: { send: async (_n, _d, o) => o?.id ?? null },
  });
  await testDb().execute(sql`update judge_run_control set incarnation=gen_random_uuid()`);
  expect((await readJudgeRunPermanent(testDb(), f.runId)).kind).toBe('unmapped');
});
