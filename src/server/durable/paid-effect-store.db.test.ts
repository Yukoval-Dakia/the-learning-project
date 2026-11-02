// Prepared but NOT RUN in this lane (no DB): these cases pin the shared
// paid-effect store/transition contract against the real paid_effect /
// paid_effect_control tables. Parent runs them in the scoped DB loop when
// integrating the protocol (they need the parent-owned migration SQL from
// docs/planning/2026-10-11-yuk1355-paid-effect-protocol.md §6 applied first).
//
// Required proofs (parent plan + P1 R1): one physical-send admission under a
// CAS race, unequal receipt rejection, unresolved claim visible across
// different deliveries/ticks, opposite backend fenced INSIDE the claim,
// failed application never resends, fixed entity-gate predicate (sibling rep
// units parallel; same-unit input change and cross-revision unknown blocked),
// mandatory winner-fence completion, switch blocked on every unfinished
// obligation (including the note_verify claim probe), and the supporting
// contracts (intent idempotence, history preservation, generation fencing).
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  type PaidEffectIdentity,
  computePaidEffectIdentity,
  paidEffectControlLockKey,
} from '@/core/migration/paid-effect-protocol';
import type { Db, Tx } from '@/db/client';
import {
  admitPaidEffectIntent,
  claimPaidEffectSend,
  listPaidEffectObligations,
  readPaidEffect,
  settleExpiredPaidEffectSends,
} from '@/db/paid-effect-store';
import * as schema from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';

const INPUT = { artifact_id: 'a1', sections: [{ kind: 'definition', md: 'x' }] };
const OTHER_INPUT = { artifact_id: 'a1', sections: [{ kind: 'mechanism', md: 'y' }] };

function ident(
  input: unknown,
  overrides: Partial<{ entityRevision: string; unit: string }> = {},
): PaidEffectIdentity {
  return computePaidEffectIdentity({
    family: 'test_family',
    entityId: 'a1',
    entityRevision: overrides.entityRevision ?? 'r0',
    unit: overrides.unit ?? 'verify',
    input,
  });
}

async function admitIntent(
  db: Db,
  identityInput: unknown,
  overrides?: Parameters<typeof ident>[1],
) {
  const identity = ident(identityInput, overrides);
  await db.transaction(async (tx: Tx) => {
    await admitPaidEffectIntent(tx, {
      family: identity.family,
      entityId: identity.entityId,
      entityRevision: identity.entityRevision,
      unit: identity.unit,
      input: identityInput,
    });
  });
  return identity;
}

async function claim(db: Db, identity: PaidEffectIdentity, deliveryId: string, leaseMs = 60_000) {
  return db.transaction((tx: Tx) =>
    claimPaidEffectSend(tx, identity, {
      backend: 'pg-boss',
      deliveryId,
      tickId: `tick-${deliveryId}`,
      leaseExpiresAt: new Date(Date.now() + leaseMs),
    }),
  );
}

async function claimFence(
  db: Db,
  identity: PaidEffectIdentity,
  deliveryId: string,
  leaseMs = 60_000,
): Promise<number> {
  const result = await claim(db, identity, deliveryId, leaseMs);
  if (result.kind !== 'claimed') throw new Error(`expected claimed, got ${result.kind}`);
  return result.fence;
}

function _settled<T>(run: Promise<T>) {
  return run.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
}

async function _reachBarrier(barrier: Promise<void>, run: Promise<unknown>): Promise<void> {
  await Promise.race([
    barrier,
    run.then((result) => {
      throw new Error(`transaction finished before its barrier: ${JSON.stringify(result)}`);
    }),
  ]);
}

/** Dedicated real connection, with latches around real SQL/COMMIT only. */
async function _isolatedConnection(
  hooks: { afterFamilyLock?: () => Promise<void>; beforeCommit?: () => Promise<void> } = {},
) {
  const url = new URL(z.url().parse(process.env.TEST_DATABASE_URL));
  if (
    !/^\/test_fork_\d+$/.test(url.pathname) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  ) {
    throw new Error('Concurrency tests require the disposable Vitest fork');
  }
  const client = postgres(url.toString(), { max: 1 });
  const db: Db = drizzle(client, { schema });
  const [backend] = await db.execute<{ pid: number; name: string }>(
    sql`select pg_backend_pid() as pid, current_database() as name`,
  );
  expect(backend.name).toBe(url.pathname.slice(1));
  const transaction = db.transaction.bind(db);
  db.transaction = (body, config) =>
    transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '8s'`);
      await tx.execute(sql`set local statement_timeout = '10s'`);
      if (hooks.afterFamilyLock) {
        const execute = tx.execute.bind(tx);
        let paused = false;
        tx.execute = <TRow extends Record<string, unknown> = Record<string, unknown>>(
          query: Parameters<Tx['execute']>[0],
        ) => {
          const pending = execute<TRow>(query);
          const run = pending.execute.bind(pending);
          pending.execute = async () => {
            const result = await run();
            if (!paused && pending.getQuery().sql.includes('pg_advisory_xact_lock')) {
              paused = true;
              await hooks.afterFamilyLock?.();
            }
            return result;
          };
          return pending;
        };
      }
      const result = await body(tx);
      await hooks.beforeCommit?.();
      return result;
    }, config);
  return { db, pid: backend.pid, close: () => client.end({ timeout: 5 }) };
}

async function _expectFamilyWait(holderPid: number, waiterPid: number, family: string) {
  expect(holderPid).not.toBe(waiterPid);
  const key = paidEffectControlLockKey(family);
  await expect
    .poll(
      async () => {
        const [state] = await testDb().execute<{
          holder: boolean;
          waiter: boolean;
          blocked: boolean;
        }>(sql`
      select exists (
        select 1 from pg_locks where locktype = 'advisory' and pid = ${holderPid}
        and classid = ((hashtextextended(${key}, 0) >> 32) & 4294967295)::oid
        and objid = (hashtextextended(${key}, 0) & 4294967295)::oid
        and objsubid = 1 and mode = 'ExclusiveLock' and granted
      ) as holder, exists (
        select 1 from pg_locks where locktype = 'advisory' and pid = ${waiterPid}
        and classid = ((hashtextextended(${key}, 0) >> 32) & 4294967295)::oid
        and objid = (hashtextextended(${key}, 0) & 4294967295)::oid
        and objsubid = 1 and mode = 'ExclusiveLock' and not granted
      ) as waiter, ${holderPid} = any(pg_blocking_pids(${waiterPid})) as blocked
    `);
        return state;
      },
      { timeout: 5_000, interval: 20 },
    )
    .toEqual({ holder: true, waiter: true, blocked: true });
}

describe('paid-effect store transitions', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // @invariant concurrency: exactly one delivery may claim the physical send for one effect identity, even when two transactions race on separate connections
  // @fails-if both concurrent claims win (double paid send), both lose, or the fence advances more than once
  it('admits exactly one winner in a concurrent claim race', async () => {
    const identity = await admitIntent(testDb(), INPUT);
    const [first, second] = await Promise.all([
      claim(testDb(), identity, 'delivery-1'),
      claim(testDb(), identity, 'delivery-2'),
    ]);
    const claims = [first, second].filter((r) => r.kind === 'claimed');
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ kind: 'claimed', fence: 1 });
    const row = await readPaidEffect(testDb(), identity);
    expect(row?.state).toBe('sending');
    expect(row?.fence).toBe(1);
    expect(['delivery-1', 'delivery-2']).toContain(row?.delivery.deliveryId);
    expect([first, second].filter((r) => r.kind === 'refused')).toHaveLength(1);
  });

  // @invariant data: a changed input or revision creates a NEW effect row and never erases the historical obligation
  // @fails-if re-derivation with new input/revision deletes or overwrites the old row, destroying the audit trail of a paid obligation
  it('preserves historical obligations when input or revision changes', async () => {
    const first = await admitIntent(testDb(), INPUT);
    await claimFence(testDb(), first, 'delivery-1', -1_000);
    await settleExpiredPaidEffectSends(testDb());
    const second = await admitIntent(testDb(), OTHER_INPUT);
    const third = await admitIntent(testDb(), INPUT, { entityRevision: 'rev-7' });
    expect(second.inputDigest).not.toBe(first.inputDigest);
    expect(third.entityRevision).toBe('rev-7');
    const obligations = await listPaidEffectObligations(testDb(), { family: 'test_family' });
    expect(obligations.map((o) => o.identity.inputDigest)).toEqual(
      expect.arrayContaining([first.inputDigest, second.inputDigest, third.inputDigest]),
    );
    expect(await readPaidEffect(testDb(), first)).toMatchObject({ state: 'unknown' });
  });
});
