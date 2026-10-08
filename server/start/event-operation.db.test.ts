import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventCorrectionBodySchema, readEventDetail } from '@/capabilities/observability/public';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { CODE_CONTRACT_EPOCH, gateContractEpoch } from '@/server/contract-epoch/rules';
import { resetDb, testDb } from '../../tests/helpers/db';
import { buildHonoApp } from '../app';
import {
  runAuthenticatedStartEventCorrection,
  runAuthenticatedStartEventDetail,
} from './event-read';
import { eventCorrectionInput, eventNow, eventPayload } from './event-test-fixtures';

// PREPARED ONLY: parent executes in the isolated DB lane. No author DB/runtime acceptance.
const scope = vi.hoisted((): { database?: Db | Tx } => ({}));
vi.mock('@/db/client', async () => {
  const { testDb } = await import('../../tests/helpers/db');
  return {
    get db() {
      return scope.database ?? testDb();
    },
  };
});
const ctx = (reason?: 'preparing' | 'ready') => ({
  api: buildHonoApp([], {
    epochGate: async () => {
      const verdict = gateContractEpoch({ epoch: CODE_CONTRACT_EPOCH, state: reason ?? 'active' });
      return { ...verdict, state: verdict.marker.state, epoch: verdict.marker.epoch };
    },
  }),
});
const request = (token: string | undefined = 'event-db-token') =>
  new Request('http://isolated.test/_serverFn/event', {
    headers: token === undefined ? {} : { 'x-internal-token': token },
  });
const detail = (database: Db | Tx, id: string) =>
  runAuthenticatedStartEventDetail(ctx(), request(), { id }, { database });
const correct = (database: Db | Tx, id: string, input: unknown = eventCorrectionInput) =>
  runAuthenticatedStartEventCorrection(
    ctx(),
    request(),
    { id, input },
    { database, now: eventNow },
  );
async function denied(call: Promise<unknown>, status: number) {
  const result: unknown = await call.catch((e: unknown) => e);
  if (!(result instanceof Response)) throw new Error('Expected shaped Response');
  expect(result.status).toBe(status);
  return result.json();
}
async function seed(database: Db | Tx, id: string, parent?: string) {
  await writeEvent(database, {
    id,
    actor_kind: 'agent',
    actor_ref: 'run_original',
    action: 'experimental:event_detail_fixture',
    subject_kind: 'question',
    subject_id: 'q1',
    outcome: 'partial',
    payload: eventPayload,
    caused_by_event_id: parent,
    task_run_id: 'task_original',
    cost_micro_usd: 0,
    created_at: eventNow,
  });
}
async function frozenBytes(database: Db | Tx, ids: string[]) {
  return database.execute(
    sql`select id, to_jsonb(event)::text as original_bytes from event where ${inArray(event.id, ids)} order by id`,
  );
}
async function snapshot(database: Db | Tx) {
  const tables = await database.execute<{ name: string }>(
    sql`select tablename as name from pg_tables where schemaname='public' order by tablename`,
  );
  const result: Record<string, unknown> = {};
  for (const { name } of tables)
    result[name] = await database.execute(
      sql`select count(*)::text as count, md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as digest from ${sql.identifier(name)} t`,
    );
  return result;
}
beforeEach(async () => {
  vi.stubEnv('INTERNAL_TOKEN', 'event-db-token');
  scope.database = undefined;
  await resetDb();
});
afterEach(() => {
  scope.database = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('authenticated Start event operations on real Db/Tx', () => {
  it('reads a rich uncommitted cause/effects/multiple-correction chain only through Tx, writes nothing, and rolls back', async () => {
    const database = testDb();
    const initial = await snapshot(database);
    const rollback = new Error('intentional rollback');
    await expect(
      database.transaction(async (tx) => {
        await seed(tx, 'cause');
        await seed(tx, 'focus', 'cause');
        await seed(tx, 'effect1', 'focus');
        await seed(tx, 'effect2', 'focus');
        const first = await correct(tx, 'focus');
        const second = await correct(tx, 'focus', {
          ...eventCorrectionInput,
          correction_kind: 'mark_wrong',
        });
        const before = await snapshot(tx);
        const original = await frozenBytes(tx, ['focus']);
        expect(await denied(detail(database, 'focus'), 404)).toMatchObject({ error: 'not_found' });
        const result = await detail(tx, ' focus ');
        expect(result).toEqual(await readEventDetail(tx, 'focus'));
        expect(result.event.payload).toEqual(eventPayload);
        expect(result.event.created_at).toBe(eventNow.toISOString());
        expect(result.event.cost_micro_usd).toBe(0);
        expect(result.event.dispatch_seq).toBeGreaterThan(0);
        expect(result.chain.caused_by?.id).toBe('cause');
        expect(result.chain.caused_events.map((row) => row.id).sort()).toEqual([
          'effect1',
          'effect2',
        ]);
        expect(result.chain.corrections.map((row) => row.id)).toEqual([
          second.correction_event_id,
          first.correction_event_id,
        ]);
        expect(result.correction_status).toEqual({
          state: 'marked_wrong',
          correction_event_id: second.correction_event_id,
          replacement_event_id: null,
        });
        expect(await frozenBytes(tx, ['focus'])).toEqual(original);
        expect(await snapshot(tx)).toEqual(before);
        expect(await snapshot(database)).toEqual(initial);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await snapshot(database)).toEqual(initial);
  });
  it('appends four correction kinds at tied timestamps, preserves original bytes, prepares writer metadata, and isolates pending effects', async () => {
    const database = testDb();
    const rollback = new Error('intentional correction rollback');
    await expect(
      database.transaction(async (tx) => {
        await seed(tx, 'focus');
        await seed(tx, 'replacement');
        const original = await frozenBytes(tx, ['focus', 'replacement']);
        const receipts: string[] = [];
        for (const kind of ['retract', 'mark_wrong', 'restore', 'supersede'] as const) {
          const input = {
            ...eventCorrectionInput,
            correction_kind: kind,
            ...(kind === 'supersede' ? { replacement_event_id: 'replacement' } : {}),
          };
          const receipt = await correct(tx, 'focus', input);
          receipts.push(receipt.correction_event_id);
          expect(receipt).toEqual({
            correction_event_id: receipt.correction_event_id,
            status: 201,
            canonicalLocation: `/api/events/${encodeURIComponent(receipt.correction_event_id)}`,
          });
          const persisted = (
            await tx.select().from(event).where(eq(event.id, receipt.correction_event_id))
          )[0];
          expect(persisted).toMatchObject({
            actor_kind: 'user',
            actor_ref: 'self',
            action: 'correct',
            subject_kind: 'event',
            subject_id: 'focus',
            outcome: 'success',
            caused_by_event_id: 'focus',
            payload: EventCorrectionBodySchema.parse(input),
            created_at: eventNow,
            ingest_at: null,
          });
          expect(persisted.affected_scopes).toContain('global');
          expect(persisted.dispatch_seq).toBeGreaterThan(0);
          expect(await frozenBytes(tx, ['focus', 'replacement'])).toEqual(original);
          const result = await detail(tx, 'focus');
          expect(result.chain.corrections.map((row) => row.id)).toEqual([...receipts].reverse());
          expect(result.chain.caused_events).toEqual([]);
          expect(result.correction_status).toEqual(
            kind === 'restore'
              ? { state: 'active', correction_event_id: null, replacement_event_id: null }
              : {
                  state:
                    kind === 'retract'
                      ? 'retracted'
                      : kind === 'mark_wrong'
                        ? 'marked_wrong'
                        : 'superseded',
                  correction_event_id: receipt.correction_event_id,
                  replacement_event_id: kind === 'supersede' ? 'replacement' : null,
                },
          );
          expect(await database.select().from(event)).toEqual([]);
        }
        expect(new Set(receipts).size).toBe(4);
        const fresh = await correct(tx, 'focus', {
          ...eventCorrectionInput,
          correction_kind: 'restore',
        });
        expect(receipts).not.toContain(fresh.correction_event_id);
        expect(await frozenBytes(tx, ['focus', 'replacement'])).toEqual(original);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await database.select().from(event)).toEqual([]);
  });
  it('keeps whole-table no-write rejection for denied/fenced/malformed/missing input and replacement rules', async () => {
    const database = testDb();
    await seed(database, 'focus');
    const before = await snapshot(database);
    const sequences = await database.execute(
      sql`select sequencename,last_value from pg_sequences where schemaname='public' order by sequencename`,
    );
    for (const operation of [
      runAuthenticatedStartEventDetail,
      runAuthenticatedStartEventCorrection,
    ]) {
      for (const token of ['', 'wrong'])
        await denied(operation(ctx(), request(token), null, { database }), 401);
      await denied(
        operation(ctx(), new Request('http://isolated.test/_serverFn/event'), null, { database }),
        401,
      );
      for (const phase of ['preparing', 'ready'] as const)
        await denied(operation(ctx(phase), request(), null, { database }), 503);
      for (const input of [null, {}, { id: ' ' }])
        await denied(operation(ctx(), request(), input, { database }), 400);
    }
    await denied(detail(database, 'missing'), 404);
    await denied(correct(database, 'missing'), 404);
    for (const input of [
      null,
      { ...eventCorrectionInput, reason_md: ' ' },
      { ...eventCorrectionInput, reason_md: 'x'.repeat(2001) },
      { ...eventCorrectionInput, affected_refs: [] },
      { ...eventCorrectionInput, correction_kind: 'supersede' },
      { ...eventCorrectionInput, replacement_event_id: 'replacement' },
    ])
      await denied(correct(database, 'focus', input), 400);
    expect(await snapshot(database)).toEqual(before);
    expect(
      await database.execute(
        sql`select sequencename,last_value from pg_sequences where schemaname='public' order by sequencename`,
      ),
    ).toEqual(sequences);
  });
  it('corrupt focal/causal/correction data remains500 and appends nothing', async () => {
    const database = testDb();
    const corrupt = (
      id: string,
      overrides: Partial<typeof event.$inferInsert> = {},
    ): typeof event.$inferInsert => ({
      id,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'failure',
      payload: { answer_md: 42 },
      created_at: eventNow,
      ...overrides,
    });
    await database.insert(event).values(corrupt('corrupt'));
    await seed(database, 'with_corrupt_cause', 'corrupt');
    await seed(database, 'with_corrupt_correction');
    await database.insert(event).values(
      corrupt('bad_correction', {
        action: 'correct',
        subject_kind: 'event',
        subject_id: 'with_corrupt_correction',
        caused_by_event_id: 'with_corrupt_correction',
        payload: { correction_kind: 'supersede', affected_refs: [], reason_md: '' },
      }),
    );
    const before = await snapshot(database);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const id of ['corrupt', 'with_corrupt_cause', 'with_corrupt_correction'])
        expect(await denied(detail(database, id), 500)).toEqual({
          error: 'internal_error',
          message: 'Internal Server Error',
        });
      expect(await denied(correct(database, 'corrupt'), 500)).toEqual({
        error: 'internal_error',
        message: 'Internal Server Error',
      });
    } finally {
      log.mockRestore();
    }
    expect(await snapshot(database)).toEqual(before);
  });
});
