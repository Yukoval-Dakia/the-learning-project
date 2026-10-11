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
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { admitNoteVerifyDelivery } from '@/capabilities/notes/jobs/note_verify';
import { reserveNoteVerification } from '@/capabilities/notes/server/note-verification-claim-reservation';
import type { Db, Tx } from '@/db/client';
import * as schema from '@/db/schema';
import { artifact, note_verification_claim, paid_effect, paid_effect_control } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  admitPaidEffectDeliveryControl,
  readPaidEffectControl,
  switchPaidEffectBackend,
} from './paid-effect-control';
import { buildNoteVerificationControlAdmission } from './paid-effect-note-admission';
import {
  PaidEffectApplicationConflictError,
  PaidEffectControlFencedError,
  PaidEffectDeliveryConflictError,
  type PaidEffectIdentity,
  PaidEffectIdentityConflictError,
  PaidEffectProtocolError,
  PaidEffectReceiptConflictError,
  PaidEffectSwitchBlockedError,
  PaidEffectSwitchUnsupportedError,
  computePaidEffectIdentity,
  paidEffectControlLockKey,
  paidEffectDispatchRefSchema,
} from './paid-effect-protocol';
import {
  admitPaidEffectIntent,
  claimPaidEffectSend,
  listPaidEffectObligations,
  markPaidEffectUnknown,
  notePaidEffectApplicationFailure,
  readPaidEffect,
  recordPaidEffectApplication,
  recordPaidEffectResult,
  reservePaidEffect,
  settleExpiredPaidEffectSends,
} from './paid-effect-store';

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

function settled<T>(run: Promise<T>) {
  return run.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
}

async function reachBarrier(barrier: Promise<void>, run: Promise<unknown>): Promise<void> {
  await Promise.race([
    barrier,
    run.then((result) => {
      throw new Error(`transaction finished before its barrier: ${JSON.stringify(result)}`);
    }),
  ]);
}

/** Dedicated real connection, with latches around real SQL/COMMIT only. */
async function isolatedConnection(
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

async function expectFamilyWait(holderPid: number, waiterPid: number, family: string) {
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

  // @invariant concurrency: intent admission is idempotent on identity and rejects a digest collision instead of overwriting the persisted intent
  // @fails-if a second admission with different input under the same identity mutates or accepts the row, letting two different paid intents share one effect
  it('admits intent idempotently and rejects a digest collision', async () => {
    const identity = await admitIntent(testDb(), INPUT);
    await expect(
      testDb().transaction(async (tx: Tx) => {
        return admitPaidEffectIntent(tx, {
          family: identity.family,
          entityId: identity.entityId,
          entityRevision: identity.entityRevision,
          unit: identity.unit,
          input: INPUT,
        });
      }),
    ).resolves.toMatchObject({ kind: 'existing', state: 'pending' });
    // Simulate the practical collision: stored input drifts from the digest source.
    await testDb()
      .update(paid_effect)
      .set({ input_json: OTHER_INPUT })
      .where(eq(paid_effect.entity_id, identity.entityId));
    await expect(
      testDb().transaction(async (tx: Tx) => {
        await admitPaidEffectIntent(tx, {
          family: identity.family,
          entityId: identity.entityId,
          entityRevision: identity.entityRevision,
          unit: identity.unit,
          input: INPUT,
        });
      }),
    ).rejects.toBeInstanceOf(PaidEffectIdentityConflictError);
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

  // @invariant concurrency: the result receipt is immutable — a semantically equal re-record is idempotent, an unequal rewrite is rejected without mutating the row, and a non-owner delivery or stale fence cannot record
  // @fails-if an unequal payload overwrites the first receipt, or a delivery that lost the claim records a result for a send it never made
  it('rejects unequal receipts and non-owner recordings, accepts equal ones idempotently', async () => {
    const identity = await admitIntent(testDb(), INPUT);
    const fence = await claimFence(testDb(), identity, 'delivery-1');
    const receipt = { verdict: 'pass', issues: [] };
    await expect(
      testDb().transaction((tx: Tx) =>
        recordPaidEffectResult(tx, identity, 'delivery-1', receipt, { fence }),
      ),
    ).resolves.toBe('recorded');
    await expect(
      testDb().transaction((tx: Tx) =>
        recordPaidEffectResult(
          tx,
          identity,
          'delivery-1',
          { issues: [], verdict: 'pass' },
          {
            fence,
          },
        ),
      ),
    ).resolves.toBe('idempotent');
    await expect(
      testDb().transaction((tx: Tx) =>
        recordPaidEffectResult(tx, identity, 'delivery-1', { verdict: 'fail' }, { fence }),
      ),
    ).rejects.toBeInstanceOf(PaidEffectReceiptConflictError);
    await expect(
      testDb().transaction((tx: Tx) =>
        recordPaidEffectResult(tx, identity, 'delivery-2', receipt, { fence }),
      ),
    ).rejects.toBeInstanceOf(PaidEffectDeliveryConflictError);
    expect(await readPaidEffect(testDb(), identity)).toMatchObject({
      state: 'receipt_ready',
      result: receipt,
    });
  });

  // @invariant concurrency: an unknown outcome stays a durable unresolved obligation — a later delivery under a NEW tick is refused and never auto-replayed, while the owning delivery may still resolve it late
  // @fails-if a new-tick delivery can claim the send again (paid double-send from an unknown), or the unknown row is hidden from the obligation surface
  it('keeps an unknown send unclaimable across a new delivery/tick, resolvable only by its owner', async () => {
    const identity = await admitIntent(testDb(), INPUT);
    const fence = await claimFence(testDb(), identity, 'delivery-1', -1_000); // lease already expired
    expect(await settleExpiredPaidEffectSends(testDb(), { family: 'test_family' })).toBe(1);
    expect(await readPaidEffect(testDb(), identity)).toMatchObject({
      state: 'unknown',
      unresolvedReason: 'send_lease_expired',
    });
    const replay = await claim(testDb(), identity, 'delivery-new-tick');
    expect(replay).toMatchObject({ kind: 'refused', state: 'unknown', receiptKnown: false });
    await expect(
      testDb().transaction((tx: Tx) =>
        markPaidEffectUnknown(tx, identity, 'delivery-new-tick', 'x', { fence }),
      ),
    ).rejects.toBeInstanceOf(PaidEffectDeliveryConflictError);
    const unknown = await readPaidEffect(testDb(), identity);
    await expect(
      testDb().transaction((tx) =>
        markPaidEffectUnknown(tx, identity, 'delivery-1', 'x', { fence: fence + 1 }),
      ),
    ).rejects.toBeInstanceOf(PaidEffectDeliveryConflictError);
    await expect(
      testDb().transaction((tx) =>
        markPaidEffectUnknown(tx, identity, 'delivery-1', 'different retry reason', { fence }),
      ),
    ).resolves.toBeUndefined();
    expect(await readPaidEffect(testDb(), identity)).toEqual(unknown);
    // Late resolution by the owning delivery is monotone information gain.
    await expect(
      testDb().transaction((tx: Tx) =>
        recordPaidEffectResult(tx, identity, 'delivery-1', { verdict: 'pass' }, { fence }),
      ),
    ).resolves.toBe('recorded');
    expect(await readPaidEffect(testDb(), identity)).toMatchObject({ state: 'receipt_ready' });
    const obligations = await listPaidEffectObligations(testDb(), { family: 'test_family' });
    expect(obligations.map((o) => o.state)).toEqual(['receipt_ready']);
  });

  // @invariant concurrency: a failed application never re-opens the physical send — the row stays a readable receipt_ready obligation and the only way on is recording the application
  // @fails-if a new delivery can claim a send after a failed application, or the obligation disappears while unapplied
  it('does not resend after a failed application and finishes from the receipt', async () => {
    const identity = await admitIntent(testDb(), INPUT);
    const fence = await claimFence(testDb(), identity, 'delivery-1');
    const receipt = { verdict: 'pass', issues: [] };
    await testDb().transaction(async (tx: Tx) => {
      await recordPaidEffectResult(tx, identity, 'delivery-1', receipt, { fence });
    });
    // The domain application crashed: the failure is noted, state unchanged.
    await testDb().transaction(async (tx: Tx) => {
      await notePaidEffectApplicationFailure(tx, identity, 'apply tx aborted');
    });
    expect(await readPaidEffect(testDb(), identity)).toMatchObject({
      state: 'receipt_ready',
      applicationAttempts: 1,
      lastApplicationError: 'apply tx aborted',
    });
    const replay = await claim(testDb(), identity, 'delivery-retry');
    expect(replay).toMatchObject({ kind: 'refused', state: 'receipt_ready', receiptKnown: true });
    await expect(
      testDb().transaction((tx: Tx) =>
        recordPaidEffectApplication(tx, identity, { applied_event: 'e1' }),
      ),
    ).resolves.toBe('applied');
    await expect(
      testDb().transaction((tx: Tx) =>
        recordPaidEffectApplication(tx, identity, { applied_event: 'e1' }),
      ),
    ).resolves.toBe('idempotent');
    await expect(
      testDb().transaction((tx: Tx) =>
        recordPaidEffectApplication(tx, identity, { applied_event: 'e2' }),
      ),
    ).rejects.toBeInstanceOf(PaidEffectApplicationConflictError);
    expect(await readPaidEffect(testDb(), identity)).toMatchObject({
      state: 'applied',
      appliedAt: expect.any(Date),
    });
    expect((await listPaidEffectObligations(testDb(), { family: 'test_family' })).length).toBe(0);
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

  // @invariant concurrency: recording a result or application in an impossible state is a protocol error, not a silent transition
  // @fails-if a result can be recorded from pending (no admitted send) or an application recorded without a receipt
  it('rejects impossible transitions', async () => {
    const identity = await admitIntent(testDb(), INPUT);
    await expect(
      testDb().transaction((tx: Tx) =>
        recordPaidEffectResult(tx, identity, 'delivery-1', { verdict: 'pass' }, { fence: 1 }),
      ),
    ).rejects.toBeInstanceOf(PaidEffectProtocolError);
    await expect(
      testDb().transaction((tx: Tx) =>
        recordPaidEffectApplication(tx, identity, { applied_event: 'e1' }),
      ),
    ).rejects.toBeInstanceOf(PaidEffectProtocolError);
  });
});

describe('paid-effect reserve admission (winner/held/completed)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  function reserveInput(
    entityRevision: string,
    input: unknown,
    unit = 'verify',
    family = 'reserve_family',
  ) {
    return {
      input: {
        family,
        entityId: 'e1',
        entityRevision,
        unit,
        input,
      },
      delivery: {
        backend: 'pg-boss' as const,
        deliveryId: `delivery-${entityRevision}-${unit}`,
        tickId: `tick-${entityRevision}`,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    };
  }

  // @invariant concurrency: reserve is the single atomic send admission — the first caller wins with a lease/fence, a re-entry on the same effect is held, and after a receipt exists every later reserve is completed with the immutable result for application replay
  // @fails-if two reserves both win for one effect, a re-entry re-admits the send, or a completed receipt is answered with winner/held instead of the recorded result
  it('discriminates winner, held, and completed for one effect', async () => {
    const first = await reservePaidEffect(
      testDb(),
      reserveInput('w1', INPUT).input,
      reserveInput('w1', INPUT).delivery,
    );
    expect(first).toMatchObject({ kind: 'winner', fence: 1 });
    const replay = await reservePaidEffect(testDb(), reserveInput('w1', INPUT).input, {
      ...reserveInput('w1', INPUT).delivery,
      deliveryId: 'delivery-replay',
    });
    expect(replay).toMatchObject({ kind: 'held', state: 'sending' });
    const identity = first.identity;
    await testDb().transaction(async (tx: Tx) => {
      await recordPaidEffectResult(
        tx,
        identity,
        'delivery-w1-verify',
        { verdict: 'pass' },
        { fence: 1 },
      );
    });
    const completed = await reservePaidEffect(
      testDb(),
      reserveInput('w1', INPUT).input,
      reserveInput('w1', INPUT).delivery,
    );
    expect(completed).toMatchObject({
      kind: 'completed',
      state: 'receipt_ready',
      result: { verdict: 'pass' },
      applied: false,
    });
    await testDb().transaction(async (tx: Tx) => {
      await recordPaidEffectApplication(tx, identity, { applied_event: 'e1' });
    });
    const applied = await reservePaidEffect(
      testDb(),
      reserveInput('w1', INPUT).input,
      reserveInput('w1', INPUT).delivery,
    );
    expect(applied).toMatchObject({ kind: 'completed', state: 'applied', applied: true });
  });

  // @invariant concurrency: an open sending/unknown effect of the same entity blocks a NEW identity (later workset or new revision) from buying — the cross-night case under the FIXED predicate
  // @fails-if a new workSetId or a bumped revision admits a fresh paid send while the entity's earlier send is unresolved
  it('blocks cross-revision/cross-workset buys on the same entity while unknown', async () => {
    const first = await reservePaidEffect(
      testDb(),
      reserveInput('w1', INPUT).input,
      reserveInput('w1', INPUT).delivery,
    );
    if (first.kind !== 'winner') throw new Error(`expected winner, got ${first.kind}`);
    await testDb().transaction(async (tx: Tx) => {
      await markPaidEffectUnknown(
        tx,
        first.identity,
        'delivery-w1-verify',
        'workflow ended without receipt',
        { fence: 1 },
      );
    });
    const laterWorkset = await reservePaidEffect(
      testDb(),
      reserveInput('w2', INPUT).input,
      reserveInput('w2', INPUT).delivery,
    );
    expect(laterWorkset).toMatchObject({ kind: 'held' });
    expect(laterWorkset.kind === 'held' && laterWorkset.blockedBy?.entityRevision).toBe('w1');
    const newRevision = await reservePaidEffect(
      testDb(),
      reserveInput('r2', INPUT).input,
      reserveInput('r2', INPUT).delivery,
    );
    expect(newRevision).toMatchObject({ kind: 'held' });
  });

  // @invariant concurrency: only A's recognized feature rep siblings of ONE revision are parallel sends; input/method/revision drift and malformed units stay blocked
  // @fails-if feature rep 1 is blocked by rep 0's unknown, or a changed method/input/revision or malformed rep unit escapes the old unknown
  it('keeps sibling rep units parallel, blocks same-unit input drift and new revisions', async () => {
    const rep1 = await reservePaidEffect(
      testDb(),
      reserveInput('rev-1', INPUT, 'feature/rep:0', 'item_prior_backfill').input,
      reserveInput('rev-1', INPUT, 'feature/rep:0', 'item_prior_backfill').delivery,
    );
    expect(rep1).toMatchObject({ kind: 'winner' });
    await testDb().transaction(async (tx: Tx) => {
      await markPaidEffectUnknown(tx, rep1.identity, 'delivery-rev-1-feature/rep:0', 'crash', {
        fence: 1,
      });
    });
    const rep2 = await reservePaidEffect(
      testDb(),
      reserveInput('rev-1', INPUT, 'feature/rep:1', 'item_prior_backfill').input,
      reserveInput('rev-1', INPUT, 'feature/rep:1', 'item_prior_backfill').delivery,
    );
    expect(rep2).toMatchObject({ kind: 'winner' });
    const sameUnitDifferentInput = await reservePaidEffect(
      testDb(),
      reserveInput('rev-1', OTHER_INPUT, 'feature/rep:0', 'item_prior_backfill').input,
      reserveInput('rev-1', OTHER_INPUT, 'feature/rep:0', 'item_prior_backfill').delivery,
    );
    expect(sameUnitDifferentInput).toMatchObject({
      kind: 'held',
      state: 'pending',
      blockedBy: rep1.identity,
    });
    for (const unit of [
      'llasa/rep:0',
      'unknown/rep:0',
      'feature/rep:-1',
      'feature/rep:01',
      'feature/rep:0\n',
    ]) {
      const request = reserveInput('rev-1', INPUT, unit, 'item_prior_backfill');
      await expect(
        reservePaidEffect(testDb(), request.input, request.delivery),
      ).resolves.toMatchObject({
        kind: 'held',
        state: 'pending',
        blockedBy: rep1.identity,
      });
    }
    const nextRevision = await reservePaidEffect(
      testDb(),
      reserveInput('rev-2', INPUT, 'feature/rep:0', 'item_prior_backfill').input,
      reserveInput('rev-2', INPUT, 'feature/rep:0', 'item_prior_backfill').delivery,
    );
    expect(nextRevision).toMatchObject({ kind: 'held' });
    expect(nextRevision.kind === 'held' && nextRevision.blockedBy?.entityRevision).toBe('rev-1');
  });

  // @invariant concurrency: C's old unknown gates the entity even if a later frozen workset selects a different model; caller-chosen rep-like units in C also cannot exempt it
  // @fails-if the SQL gate exempts arbitrary different units, letting M2 buy while M1 is unknown
  it('holds C model changes and fake rep siblings behind an unknown paid send', async () => {
    const first = reserveInput(
      'workset-1',
      INPUT,
      'rejudge:xiaomi-token-plan/M1',
      'judge_calibration_sample',
    );
    const m1 = await reservePaidEffect(testDb(), first.input, first.delivery);
    expect(m1).toMatchObject({ kind: 'winner', fence: 1 });
    await testDb().transaction((tx) =>
      markPaidEffectUnknown(tx, m1.identity, first.delivery.deliveryId, 'paid result unknown', {
        fence: 1,
      }),
    );
    const unknown = await readPaidEffect(testDb(), m1.identity);
    for (const unit of ['rejudge:xiaomi-token-plan/M2', 'feature/rep:0', 'feature/rep:1']) {
      const next = reserveInput('workset-1', OTHER_INPUT, unit, 'judge_calibration_sample');
      const held = await reservePaidEffect(testDb(), next.input, next.delivery);
      expect(held).toMatchObject({ kind: 'held', state: 'pending', blockedBy: m1.identity });
      expect(await readPaidEffect(testDb(), held.identity)).toMatchObject({
        state: 'pending',
        fence: 0,
        delivery: { deliveryId: null },
      });
    }
    expect(await readPaidEffect(testDb(), m1.identity)).toEqual(unknown);
  });

  // @invariant concurrency: two consumers racing to start DIFFERENT effects of one entity serialize on the family+entity gate lock — exactly one winner, the other held naming the blocker
  // @fails-if both concurrent cross-identity reserves win, double-engaging the provider for one entity
  it('serializes concurrent cross-identity reserves for one entity', async () => {
    const [a, b] = await Promise.all([
      reservePaidEffect(
        testDb(),
        reserveInput('w1', INPUT).input,
        reserveInput('w1', INPUT).delivery,
      ),
      reservePaidEffect(
        testDb(),
        reserveInput('w2', INPUT).input,
        reserveInput('w2', INPUT).delivery,
      ),
    ]);
    const winners = [a, b].filter((r) => r.kind === 'winner');
    const helds = [a, b].filter((r) => r.kind === 'held');
    expect(winners).toHaveLength(1);
    expect(helds).toHaveLength(1);
    expect(helds[0].kind === 'held' && helds[0].blockedBy?.entityRevision).toBe(
      winners[0].identity.entityRevision,
    );
  });

  // @invariant concurrency: completion and equal-receipt retries require the winning delivery AND its exact fence
  // @fails-if a wrong-fence or non-owner delivery records a receipt or is accepted as an idempotent completion
  it('validates winner delivery and fence on completion', async () => {
    const won = await reservePaidEffect(
      testDb(),
      reserveInput('w1', INPUT).input,
      reserveInput('w1', INPUT).delivery,
    );
    if (won.kind !== 'winner') throw new Error(`expected winner, got ${won.kind}`);
    await expect(
      testDb().transaction((tx: Tx) =>
        recordPaidEffectResult(
          tx,
          won.identity,
          'delivery-w1-verify',
          { verdict: 'pass' },
          { fence: 99 },
        ),
      ),
    ).rejects.toBeInstanceOf(PaidEffectDeliveryConflictError);
    await expect(
      testDb().transaction((tx: Tx) =>
        recordPaidEffectResult(
          tx,
          won.identity,
          'delivery-other',
          { verdict: 'pass' },
          {
            fence: 1,
          },
        ),
      ),
    ).rejects.toBeInstanceOf(PaidEffectDeliveryConflictError);
    await expect(
      testDb().transaction((tx: Tx) =>
        recordPaidEffectResult(
          tx,
          won.identity,
          'delivery-w1-verify',
          { verdict: 'pass' },
          { fence: 1 },
        ),
      ),
    ).resolves.toBe('recorded');
    const recorded = await readPaidEffect(testDb(), won.identity);
    for (const owner of [
      { deliveryId: 'delivery-w1-verify', fence: 99 },
      { deliveryId: 'delivery-other', fence: 1 },
    ]) {
      await expect(
        testDb().transaction((tx) =>
          recordPaidEffectResult(
            tx,
            won.identity,
            owner.deliveryId,
            { verdict: 'pass' },
            { fence: owner.fence },
          ),
        ),
      ).rejects.toBeInstanceOf(PaidEffectDeliveryConflictError);
    }
    await expect(
      testDb().transaction((tx) =>
        recordPaidEffectResult(
          tx,
          won.identity,
          'delivery-w1-verify',
          { verdict: 'pass' },
          { fence: 1 },
        ),
      ),
    ).resolves.toBe('idempotent');
    expect(await readPaidEffect(testDb(), won.identity)).toEqual(recorded);
  });
});

describe('paid-effect backend control (DB)', () => {
  beforeEach(async () => {
    await resetDb();
  });
  // @invariant concurrency: a delivery from the opposite backend or a stale generation is fenced inside the admission transaction
  // @fails-if the control row admits a pg-boss delivery under an explicit dbos owner, or a pre-switch generation survives a switch
  it('fences the wrong backend and stale generations', async () => {
    await testDb()
      .insert(paid_effect_control)
      .values({ family: 'ctl_family', backend: 'dbos', generation: 3 });
    await expect(
      testDb().transaction((tx: Tx) =>
        admitPaidEffectDeliveryControl(tx, 'ctl_family', { backend: 'pg-boss', deliveryId: 'j1' }),
      ),
    ).resolves.toMatchObject({ kind: 'fenced', reason: 'backend_mismatch', owner: 'dbos' });
    await expect(
      testDb().transaction((tx: Tx) =>
        admitPaidEffectDeliveryControl(tx, 'ctl_family', {
          backend: 'dbos',
          deliveryId: 'w0',
        }),
      ),
    ).resolves.toMatchObject({ kind: 'fenced', reason: 'missing_generation' });
    await expect(
      testDb().transaction((tx: Tx) =>
        admitPaidEffectDeliveryControl(tx, 'ctl_family', {
          backend: 'dbos',
          deliveryId: 'w1',
          generation: 2,
        }),
      ),
    ).resolves.toMatchObject({ kind: 'fenced', reason: 'stale_generation' });
    await expect(
      testDb().transaction((tx: Tx) =>
        admitPaidEffectDeliveryControl(tx, 'ctl_family', {
          backend: 'dbos',
          deliveryId: 'w2',
          generation: 3,
        }),
      ),
    ).resolves.toMatchObject({ kind: 'admitted' });
  });

  // @invariant concurrency: control admission is INSIDE the claim transaction — a wrong-backend or stale-generation delivery can never win a claim, and the row stays pending
  // @fails-if a fenced delivery still wins the CAS (wrong backend becomes the send owner) or the claim bypasses control entirely
  it('fences claims under the wrong owner inside the claim transaction', async () => {
    await testDb()
      .insert(paid_effect_control)
      .values({ family: 'test_family', backend: 'dbos', generation: 1 });
    const identity = await admitIntent(testDb(), INPUT);
    await expect(claim(testDb(), identity, 'delivery-1')).rejects.toBeInstanceOf(
      PaidEffectControlFencedError,
    );
    await expect(
      testDb().transaction((tx: Tx) =>
        claimPaidEffectSend(tx, identity, {
          backend: 'dbos',
          deliveryId: 'w-no-gen',
          leaseExpiresAt: new Date(Date.now() + 60_000),
        }),
      ),
    ).rejects.toBeInstanceOf(PaidEffectControlFencedError);
    await expect(
      testDb().transaction((tx: Tx) =>
        claimPaidEffectSend(tx, identity, {
          backend: 'dbos',
          deliveryId: 'w-stale',
          generation: 0,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        }),
      ),
    ).rejects.toBeInstanceOf(PaidEffectControlFencedError);
    expect(await readPaidEffect(testDb(), identity)).toMatchObject({ state: 'pending' });
    const winner = await testDb().transaction((tx: Tx) =>
      claimPaidEffectSend(tx, identity, {
        backend: 'dbos',
        deliveryId: 'w-current',
        generation: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }),
    );
    expect(winner).toMatchObject({ kind: 'claimed', fence: 1 });
  });

  // @invariant concurrency: a backend switch is blocked by EVERY unfinished obligation — sending, unknown, and (P1-5) pending intents and unapplied receipts — and proceeds (bumping the generation) only after the effect is fully applied
  // @fails-if the switch moves ownership over any unfinished state, or the generation does not advance so stale deliveries stay admissible
  it('blocks the switch on every unfinished state, then fences the old side', async () => {
    const identity = await admitIntent(testDb(), INPUT);
    const fence = await claimFence(testDb(), identity, 'delivery-1', -1_000);
    await expect(switchPaidEffectBackend(testDb(), 'test_family', 'dbos')).rejects.toBeInstanceOf(
      PaidEffectSwitchBlockedError,
    );
    await settleExpiredPaidEffectSends(testDb());
    await expect(switchPaidEffectBackend(testDb(), 'test_family', 'dbos')).rejects.toBeInstanceOf(
      PaidEffectSwitchBlockedError,
    );
    await testDb().transaction(async (tx: Tx) => {
      await recordPaidEffectResult(tx, identity, 'delivery-1', { verdict: 'pass' }, { fence });
    });
    // P1-5: a known-but-unapplied receipt still blocks the switch.
    await expect(switchPaidEffectBackend(testDb(), 'test_family', 'dbos')).rejects.toBeInstanceOf(
      PaidEffectSwitchBlockedError,
    );
    await testDb().transaction(async (tx: Tx) => {
      await recordPaidEffectApplication(tx, identity, { applied_event: 'e1' });
    });
    const after = await switchPaidEffectBackend(testDb(), 'test_family', 'dbos');
    expect(after).toEqual({
      family: 'test_family',
      backend: 'dbos',
      generation: 1,
      explicit: true,
    });
    await expect(
      testDb().transaction((tx: Tx) =>
        admitPaidEffectDeliveryControl(tx, 'test_family', {
          backend: 'dbos',
          deliveryId: 'w1',
          generation: 0,
        }),
      ),
    ).resolves.toMatchObject({ kind: 'fenced', reason: 'stale_generation' });
  });

  // @invariant concurrency: after pg-boss 0 -> DBOS 1 -> pg-boss 2, old unversioned and generation-0 jobs cannot create a paid send; only a dispatch bound to generation 2 wins
  // @fails-if pg-boss's missing generation bypasses the round-trip fence or is stamped with the current generation at consumption
  it('fences old pg-boss jobs after a backend round trip without upgrading them', async () => {
    await expect(switchPaidEffectBackend(testDb(), 'test_family', 'dbos')).resolves.toMatchObject({
      backend: 'dbos',
      generation: 1,
    });
    await expect(
      switchPaidEffectBackend(testDb(), 'test_family', 'pg-boss'),
    ).resolves.toMatchObject({ backend: 'pg-boss', generation: 2 });
    const input = {
      family: 'test_family',
      entityId: 'a1',
      entityRevision: 'r0',
      unit: 'verify',
      input: INPUT,
    };
    const identity = computePaidEffectIdentity(input);
    const delivery = {
      backend: 'pg-boss' as const,
      deliveryId: 'old-unversioned',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    };
    await expect(reservePaidEffect(testDb(), input, delivery)).rejects.toMatchObject({
      name: 'PaidEffectControlFencedError',
      reason: 'missing_generation',
    });
    expect(await readPaidEffect(testDb(), identity)).toBeNull();
    await expect(
      reservePaidEffect(testDb(), input, { ...delivery, generation: 0 }),
    ).rejects.toMatchObject({ name: 'PaidEffectControlFencedError', reason: 'stale_generation' });
    expect(await readPaidEffect(testDb(), identity)).toBeNull();
    await expect(
      reservePaidEffect(testDb(), input, {
        ...delivery,
        deliveryId: 'versioned-new',
        generation: 2,
      }),
    ).resolves.toMatchObject({ kind: 'winner', fence: 1 });
    expect(await readPaidEffect(testDb(), identity)).toMatchObject({
      state: 'sending',
      delivery: { deliveryId: 'versioned-new', backend: 'pg-boss' },
    });
  });

  // @invariant concurrency: the note_verify switch gate sees the family's EXISTING claim obligations (provider_started maps to sending) even though notes never write paid_effect rows
  // @fails-if the switch moves note_verify ownership while a live note verification claim is in flight, or the probe ignores the claim table entirely
  it('blocks the note_verify switch on live note claim obligations', async () => {
    const now = new Date();
    await testDb().insert(artifact).values({
      id: 'note-artifact-1',
      type: 'note_atomic',
      title: 'probe',
      knowledge_ids: [],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      attrs: {},
      generation_status: 'ready',
      verification_status: 'queued',
      history: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await testDb()
      .insert(note_verification_claim)
      .values({
        artifact_id: 'note-artifact-1',
        artifact_version: 0,
        state: 'provider_started',
        fence: 1,
        claim_token: '0b1f2b3c-4d5e-6f70-8a9b-0c1d2e3f4a5b',
        task_run_id: 'probe-run-1',
        provider_attempts: 1,
        available_at: now,
        lease_expires_at: new Date(now.getTime() + 60_000),
        claimed_at: now,
        provider_started_at: now,
        created_at: now,
        updated_at: now,
      });
    await expect(switchPaidEffectBackend(testDb(), 'note_verify', 'dbos')).rejects.toThrow(
      'switch blocked',
    );
    await testDb().delete(note_verification_claim);
    await expect(switchPaidEffectBackend(testDb(), 'note_verify', 'dbos')).rejects.toBeInstanceOf(
      PaidEffectSwitchUnsupportedError,
    );
    expect(await readPaidEffectControl(testDb(), 'note_verify')).toMatchObject({
      backend: 'pg-boss',
      generation: 0,
      explicit: false,
    });
  });

  // @invariant concurrency: note_verify pg-boss deliveries are admitted under the bootstrap default when no control row exists and fenced once DBOS owns the family
  // @fails-if the retained pg-boss consumer bypasses backend control, or keeps executing after ownership moved to DBOS
  it('admits note_verify deliveries under the default owner and fences after a switch', async () => {
    await expect(admitNoteVerifyDelivery(testDb(), 'job-1')).resolves.toMatchObject({
      kind: 'admitted',
    });
    expect(await readPaidEffectControl(testDb(), 'note_verify')).toEqual({
      family: 'note_verify',
      backend: 'pg-boss',
      generation: 0,
      explicit: false,
    });
    // Historical/restore control state, not authorization to cut over unversioned producers.
    await testDb()
      .insert(paid_effect_control)
      .values({ family: 'note_verify', backend: 'dbos', generation: 1 });
    await expect(admitNoteVerifyDelivery(testDb(), 'job-2')).resolves.toMatchObject({
      kind: 'fenced',
      reason: 'backend_mismatch',
      owner: 'dbos',
    });
  });

  // @invariant concurrency: a restored non-bootstrap note owner fences old unversioned jobs in the claim transaction, while a verified original dispatch generation permits the matching owner
  // @fails-if note reservation silently upgrades an old job to generation 2 or creates a claim before checking the persisted dispatch generation
  it('fences unversioned note reservations after rollback to pg-boss generation 2', async () => {
    const now = new Date();
    await testDb().insert(artifact).values({
      id: 'note-generation-2',
      type: 'note_atomic',
      title: 'generation fence',
      knowledge_ids: [],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      attrs: {},
      generation_status: 'ready',
      verification_status: 'queued',
      history: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await testDb()
      .insert(paid_effect_control)
      .values({ family: 'note_verify', backend: 'pg-boss', generation: 2 });
    const before = await testDb()
      .select()
      .from(artifact)
      .where(eq(artifact.id, 'note-generation-2'));
    await expect(
      reserveNoteVerification(testDb(), 'note-generation-2', {
        controlAdmission: buildNoteVerificationControlAdmission({
          backend: 'pg-boss',
          deliveryId: 'old-unversioned',
        }),
      }),
    ).rejects.toMatchObject({ name: 'PaidEffectControlFencedError', reason: 'missing_generation' });
    expect(await testDb().select().from(note_verification_claim)).toHaveLength(0);
    expect(
      await testDb().select().from(artifact).where(eq(artifact.id, 'note-generation-2')),
    ).toEqual(before);
    const originalDispatch = paidEffectDispatchRefSchema.parse({
      backend: 'pg-boss',
      deliveryId: 'persisted-versioned',
      generation: 2,
    });
    await expect(
      reserveNoteVerification(testDb(), 'note-generation-2', {
        controlAdmission: buildNoteVerificationControlAdmission(originalDispatch),
      }),
    ).resolves.toMatchObject({
      kind: 'claimed',
      lease: { artifactId: 'note-generation-2', fence: 1 },
    });
    expect(await testDb().select().from(note_verification_claim)).toHaveLength(1);
  });

  // @invariant concurrency: a pending intent is serialized against cutover even before any send claim exists; switch sees the committed pending obligation
  // @fails-if remove intent's family lock and the switch misses an uncommitted pending row, or only sending rows block cutover
  it('makes the switch wait for an uncommitted pending intent with no send claim', async () => {
    const paused = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const a = await isolatedConnection({
      beforeCommit: async () => {
        paused.resolve();
        await release.promise;
      },
    });
    const b = await isolatedConnection();
    const input = {
      family: 'test_family',
      entityId: 'a1',
      entityRevision: 'r0',
      unit: 'verify',
      input: INPUT,
    };
    const identity = computePaidEffectIdentity(input);
    const runs: Promise<unknown>[] = [];
    try {
      expect(await readPaidEffect(testDb(), identity)).toBeNull();
      const intentRun = settled(a.db.transaction((tx) => admitPaidEffectIntent(tx, input)));
      runs.push(intentRun);
      await reachBarrier(paused.promise, intentRun);
      const switchRun = settled(switchPaidEffectBackend(b.db, input.family, 'dbos'));
      runs.push(switchRun);
      await expectFamilyWait(a.pid, b.pid, input.family);
      expect(await readPaidEffect(testDb(), identity)).toBeNull();
      release.resolve();
      expect(await intentRun).toEqual({ status: 'fulfilled', value: { kind: 'admitted' } });
      const switchResult = await switchRun;
      expect(switchResult.status).toBe('rejected');
      if (switchResult.status !== 'rejected') throw new Error('switch must be blocked');
      expect(switchResult.reason).toBeInstanceOf(PaidEffectSwitchBlockedError);
      expect(switchResult.reason).toMatchObject({
        blocking: { pending: 1, sending: 0, unknown: 0, receipt_ready: 0 },
      });
      expect(await readPaidEffect(testDb(), identity)).toMatchObject({
        state: 'pending',
        fence: 0,
        delivery: { deliveryId: null },
      });
      expect(await readPaidEffectControl(testDb(), input.family)).toMatchObject({
        backend: 'pg-boss',
        generation: 0,
        explicit: false,
      });
    } finally {
      release.resolve();
      await Promise.all(runs);
      await Promise.all([a.close(), b.close()]);
    }
  });

  // @invariant concurrency: an uncommitted lowest-level intent owns the family lock before inserting; a missing-row switch waits and observes the committed send
  // @fails-if remove the family lock from admitPaidEffectIntent; the switch commits unseen while the new intent is paused, or the two transactions deadlock
  it('serializes missing-row intent then claim before a switch on two connections', async () => {
    const a = await isolatedConnection();
    const b = await isolatedConnection();
    const paused = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const input = {
      family: 'test_family',
      entityId: 'a1',
      entityRevision: 'r0',
      unit: 'verify',
      input: INPUT,
    };
    const identity = computePaidEffectIdentity(input);
    const runs: Promise<unknown>[] = [];
    try {
      expect(await readPaidEffect(testDb(), identity)).toBeNull();
      expect(await readPaidEffectControl(testDb(), input.family)).toMatchObject({
        explicit: false,
      });
      const claimRun = settled(
        a.db.transaction(async (tx) => {
          expect(await admitPaidEffectIntent(tx, input)).toEqual({ kind: 'admitted' });
          paused.resolve();
          await release.promise;
          return claimPaidEffectSend(tx, identity, {
            backend: 'pg-boss',
            deliveryId: 'first',
            leaseExpiresAt: new Date(Date.now() + 60_000),
          });
        }),
      );
      runs.push(claimRun);
      await reachBarrier(paused.promise, claimRun);
      const switchRun = settled(switchPaidEffectBackend(b.db, input.family, 'dbos'));
      runs.push(switchRun);
      await expectFamilyWait(a.pid, b.pid, input.family);
      // The intent is uncommitted and invisible to a different connection.
      expect(await readPaidEffect(testDb(), identity)).toBeNull();
      release.resolve();
      const [claimResult, switchResult] = await Promise.all([claimRun, switchRun]);
      expect(claimResult).toMatchObject({
        status: 'fulfilled',
        value: { kind: 'claimed', fence: 1 },
      });
      expect(switchResult.status).toBe('rejected');
      if (switchResult.status !== 'rejected') throw new Error('switch must be blocked');
      expect(switchResult.reason).toBeInstanceOf(PaidEffectSwitchBlockedError);
      expect(switchResult.reason).toMatchObject({
        blocking: { pending: 0, sending: 1, unknown: 0, receipt_ready: 0 },
      });
      expect(await readPaidEffect(testDb(), identity)).toMatchObject({
        state: 'sending',
        fence: 1,
        delivery: { deliveryId: 'first' },
      });
      expect(await readPaidEffectControl(testDb(), input.family)).toMatchObject({
        backend: 'pg-boss',
        generation: 0,
        explicit: false,
      });
    } finally {
      release.resolve();
      await Promise.all(runs);
      await Promise.all([a.close(), b.close()]);
    }
  });

  // @invariant concurrency: a missing-row switch holding the family lock runs before any intent insert; the old pg-boss transaction is fenced and rolls back completely
  // @fails-if intent admission inserts before acquiring the family lock, obtains a paid_effect write lock while the switch is paused, or survives the new backend owner
  it('lets a missing-row switch win before intent creation and fences the old claim', async () => {
    const paused = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const a = await isolatedConnection({
      afterFamilyLock: async () => {
        paused.resolve();
        await release.promise;
      },
    });
    const b = await isolatedConnection();
    const input = {
      family: 'test_family',
      entityId: 'a1',
      entityRevision: 'r0',
      unit: 'verify',
      input: INPUT,
    };
    const identity = computePaidEffectIdentity(input);
    const runs: Promise<unknown>[] = [];
    try {
      expect(await readPaidEffect(testDb(), identity)).toBeNull();
      expect(await readPaidEffectControl(testDb(), input.family)).toMatchObject({
        explicit: false,
      });
      const switchRun = settled(switchPaidEffectBackend(a.db, input.family, 'dbos'));
      runs.push(switchRun);
      await reachBarrier(paused.promise, switchRun);
      const claimRun = settled(
        b.db.transaction(async (tx) => {
          await admitPaidEffectIntent(tx, input);
          return claimPaidEffectSend(tx, identity, {
            backend: 'pg-boss',
            deliveryId: 'old',
            leaseExpiresAt: new Date(Date.now() + 60_000),
          });
        }),
      );
      runs.push(claimRun);
      await expectFamilyWait(a.pid, b.pid, input.family);
      const writes = await testDb().execute(sql`select 1 from pg_locks where pid = ${b.pid}
        and relation = 'paid_effect'::regclass and mode = 'RowExclusiveLock' and granted`);
      expect(writes).toHaveLength(0);
      release.resolve();
      const [switchResult, claimResult] = await Promise.all([switchRun, claimRun]);
      expect(switchResult).toMatchObject({
        status: 'fulfilled',
        value: { backend: 'dbos', generation: 1, explicit: true },
      });
      expect(claimResult.status).toBe('rejected');
      if (claimResult.status !== 'rejected') throw new Error('old claim must be fenced');
      expect(claimResult.reason).toBeInstanceOf(PaidEffectControlFencedError);
      expect(claimResult.reason).toMatchObject({ reason: 'backend_mismatch', owner: 'dbos' });
      expect(await readPaidEffect(testDb(), identity)).toBeNull();
      expect(await readPaidEffectControl(testDb(), input.family)).toMatchObject({
        backend: 'dbos',
        generation: 1,
        explicit: true,
      });
    } finally {
      release.resolve();
      await Promise.all(runs);
      await Promise.all([a.close(), b.close()]);
    }
  });

  // @invariant concurrency: intent's conflict-row lock follows the family lock; intent-then-claim and reserve serialize without the family/row deadlock
  // @fails-if remove intent's family lock so the first transaction holds the row and waits for reserve's family lock while reserve waits for that row
  it('serializes intent then claim against reserve without reversing family and row locks', async () => {
    const a = await isolatedConnection();
    const b = await isolatedConnection();
    const identity = await admitIntent(testDb(), INPUT);
    const input = {
      family: identity.family,
      entityId: identity.entityId,
      entityRevision: identity.entityRevision,
      unit: identity.unit,
      input: INPUT,
    };
    const paused = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const runs: Promise<unknown>[] = [];
    try {
      const firstRun = settled(
        a.db.transaction(async (tx) => {
          expect(await admitPaidEffectIntent(tx, input)).toMatchObject({
            kind: 'existing',
            state: 'pending',
          });
          paused.resolve();
          await release.promise;
          return claimPaidEffectSend(tx, identity, {
            backend: 'pg-boss',
            deliveryId: 'first',
            leaseExpiresAt: new Date(Date.now() + 60_000),
          });
        }),
      );
      runs.push(firstRun);
      await reachBarrier(paused.promise, firstRun);
      const reserveRun = settled(
        reservePaidEffect(b.db, input, {
          backend: 'pg-boss',
          deliveryId: 'second',
          leaseExpiresAt: new Date(Date.now() + 60_000),
        }),
      );
      runs.push(reserveRun);
      await expectFamilyWait(a.pid, b.pid, input.family);
      release.resolve();
      expect(await firstRun).toMatchObject({
        status: 'fulfilled',
        value: { kind: 'claimed', fence: 1 },
      });
      expect(await reserveRun).toMatchObject({
        status: 'fulfilled',
        value: { kind: 'held', state: 'sending', blockedBy: null },
      });
      expect(await readPaidEffect(testDb(), identity)).toMatchObject({
        state: 'sending',
        fence: 1,
        delivery: { deliveryId: 'first' },
      });
    } finally {
      release.resolve();
      await Promise.all(runs);
      await Promise.all([a.close(), b.close()]);
    }
  });

  // @invariant concurrency: a fenced in-transaction note admission rolls the whole reservation back — no claim row, artifact untouched
  // @fails-if the claim row (or any state change) survives a fenced reservation, or the fence is checked outside the reservation transaction
  it('rolls back the note reservation when the in-transaction admission is fenced', async () => {
    const now = new Date();
    await testDb().insert(artifact).values({
      id: 'note-fenced-1',
      type: 'note_atomic',
      title: 'fenced',
      knowledge_ids: [],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      attrs: {},
      generation_status: 'ready',
      verification_status: 'queued',
      history: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });
    // Historical/restore control state, not authorization to cut over unversioned producers.
    await testDb()
      .insert(paid_effect_control)
      .values({ family: 'note_verify', backend: 'dbos', generation: 1 });
    await expect(
      reserveNoteVerification(testDb(), 'note-fenced-1', {
        controlAdmission: buildNoteVerificationControlAdmission({
          backend: 'pg-boss',
          deliveryId: 'job-fenced',
        }),
      }),
    ).rejects.toThrow('fenced');
    const claims = await testDb()
      .select({ artifactId: note_verification_claim.artifact_id })
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, 'note-fenced-1'));
    expect(claims).toHaveLength(0);
  });

  // @invariant concurrency: a real note reservation holds the family lock until its claim commits; a concurrent missing-row switch waits and sees exactly one sending obligation
  // @fails-if remove/move the reservation hook outside its transaction, allowing the switch past the uncommitted claim instead of waiting on the same family lock
  it('serializes the note reservation vs switch with an observable blocked backend', async () => {
    const now = new Date();
    await testDb().insert(artifact).values({
      id: 'note-race-1',
      type: 'note_atomic',
      title: 'race',
      knowledge_ids: [],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      attrs: {},
      generation_status: 'ready',
      verification_status: 'queued',
      history: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });
    const before = await testDb().select().from(artifact).where(eq(artifact.id, 'note-race-1'));
    const paused = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const a = await isolatedConnection({
      beforeCommit: async () => {
        paused.resolve();
        await release.promise;
      },
    });
    const b = await isolatedConnection();
    const runs: Promise<unknown>[] = [];
    try {
      expect(await readPaidEffectControl(testDb(), 'note_verify')).toMatchObject({
        explicit: false,
      });
      const reserveRun = settled(
        reserveNoteVerification(a.db, 'note-race-1', {
          controlAdmission: buildNoteVerificationControlAdmission({
            backend: 'pg-boss',
            deliveryId: 'job-race',
          }),
        }),
      );
      runs.push(reserveRun);
      await reachBarrier(paused.promise, reserveRun);
      const switchRun = settled(switchPaidEffectBackend(b.db, 'note_verify', 'dbos'));
      runs.push(switchRun);
      await expectFamilyWait(a.pid, b.pid, 'note_verify');
      expect(await testDb().select().from(note_verification_claim)).toHaveLength(0);
      release.resolve();
      expect(await reserveRun).toMatchObject({
        status: 'fulfilled',
        value: { kind: 'claimed', lease: { artifactId: 'note-race-1', fence: 1 } },
      });
      const switchResult = await switchRun;
      expect(switchResult.status).toBe('rejected');
      if (switchResult.status !== 'rejected') throw new Error('switch must be blocked');
      expect(switchResult.reason).toBeInstanceOf(PaidEffectSwitchBlockedError);
      expect(switchResult.reason).toMatchObject({
        blocking: { pending: 0, sending: 1, unknown: 0, receipt_ready: 0 },
      });
      const claims = await testDb().select().from(note_verification_claim);
      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({
        artifact_id: 'note-race-1',
        artifact_version: 0,
        state: 'reserved',
        fence: 1,
      });
      expect(await testDb().select().from(artifact).where(eq(artifact.id, 'note-race-1'))).toEqual(
        before,
      );
      expect(await readPaidEffectControl(testDb(), 'note_verify')).toMatchObject({
        backend: 'pg-boss',
        generation: 0,
        explicit: false,
      });
    } finally {
      release.resolve();
      await Promise.all(runs);
      await Promise.all([a.close(), b.close()]);
    }
  });
});

describe('paid-effect missing control table bootstrap (DB)', () => {
  beforeEach(async () => {
    await resetDb();
    await testDb().execute(sql.raw('drop table if exists paid_effect_control'));
  });

  afterEach(async () => {
    // Restore the control table (doc §6 SQL) so later describes in this file
    // keep working against a migrated schema.
    await testDb().execute(
      sql.raw(`create table if not exists paid_effect_control (
  family text primary key,
  backend text not null check (backend in ('pg-boss','dbos')),
  generation integer not null default 0 check (generation >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)`),
    );
  });

  async function seedQueuedArtifact(id: string): Promise<void> {
    const now = new Date();
    await testDb().insert(artifact).values({
      id,
      type: 'note_atomic',
      title: id,
      knowledge_ids: [],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      attrs: {},
      generation_status: 'ready',
      verification_status: 'queued',
      history: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });
  }

  // @invariant concurrency: with the control table absent (pre-migration), a pg-boss in-transaction admission proceeds on the bootstrap default — via the non-aborting to_regclass probe, never a caught 42P01 (which would abort the reservation transaction and fail every later statement with 25P02)
  // @fails-if the missing-table check raises 42P01 inside the live reservation transaction, or the pg-boss delivery is refused before the migration lands
  it('admits a pg-boss note reservation with the control table missing', async () => {
    await seedQueuedArtifact('note-bootstrap-1');
    const reservation = await reserveNoteVerification(testDb(), 'note-bootstrap-1', {
      controlAdmission: buildNoteVerificationControlAdmission({
        backend: 'pg-boss',
        deliveryId: 'job-bootstrap',
      }),
    });
    expect(reservation).toMatchObject({ kind: 'claimed' });
    const claims = await testDb()
      .select({ state: note_verification_claim.state })
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, 'note-bootstrap-1'));
    expect(claims[0]?.state).toBe('reserved');
  });

  // @invariant concurrency: with the control table absent, a DBOS in-transaction admission is hard-fenced (pg-boss is the bootstrap default owner) and the reservation rolls back without a claim row
  // @fails-if a DBOS delivery is admitted on the missing-table bootstrap path, or the aborted reservation leaves a claim row behind
  it('hard-fences a dbos note reservation with the control table missing', async () => {
    await seedQueuedArtifact('note-bootstrap-2');
    await expect(
      reserveNoteVerification(testDb(), 'note-bootstrap-2', {
        controlAdmission: buildNoteVerificationControlAdmission({
          backend: 'dbos',
          deliveryId: 'wf-bootstrap',
        }),
      }),
    ).rejects.toThrow('fenced');
    const claims = await testDb()
      .select({ artifactId: note_verification_claim.artifact_id })
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, 'note-bootstrap-2'));
    expect(claims).toHaveLength(0);
  });
});
