import { beforeEach, describe, expect, it } from 'vitest';

import {
  type PaidEffectIdentity,
  computePaidEffectIdentity,
} from '@/core/migration/paid-effect-protocol';
import type { Db, Tx } from '@/db/client';
import {
  admitPaidEffectIntent,
  claimPaidEffectSend,
  listPaidEffectObligations,
  readPaidEffect,
  settleExpiredPaidEffectSends,
} from '@/db/paid-effect-store';
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

/** Dedicated real connection, with latches around real SQL/COMMIT only. */

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
