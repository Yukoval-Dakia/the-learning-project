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
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { admitNoteVerifyDelivery } from '@/capabilities/notes/jobs/note_verify';
import type { Db, Tx } from '@/db/client';
import { artifact, note_verification_claim, paid_effect, paid_effect_control } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  admitPaidEffectDeliveryControl,
  readPaidEffectControl,
  switchPaidEffectBackend,
} from './paid-effect-control';
import {
  PaidEffectApplicationConflictError,
  PaidEffectControlFencedError,
  PaidEffectDeliveryConflictError,
  type PaidEffectIdentity,
  PaidEffectIdentityConflictError,
  PaidEffectProtocolError,
  PaidEffectReceiptConflictError,
  PaidEffectSwitchBlockedError,
  computePaidEffectIdentity,
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
        await admitPaidEffectIntent(tx, {
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

  function reserveInput(entityRevision: string, input: unknown, unit = 'verify') {
    return {
      input: {
        family: 'reserve_family',
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

  // @invariant concurrency: under the FIXED predicate sibling units of ONE revision are deliberately parallel paid sends and do not block each other, while the SAME unit with a different input and ANY new revision are blocked by the old unknown
  // @fails-if rep:2 is blocked by rep:1's unknown within one revision, or a same-unit digest change / revision change escapes the old unknown
  it('keeps sibling rep units parallel, blocks same-unit input drift and new revisions', async () => {
    const rep1 = await reservePaidEffect(
      testDb(),
      reserveInput('rev-1', INPUT, 'method-a/rep:1').input,
      reserveInput('rev-1', INPUT, 'method-a/rep:1').delivery,
    );
    expect(rep1).toMatchObject({ kind: 'winner' });
    await testDb().transaction(async (tx: Tx) => {
      await markPaidEffectUnknown(tx, rep1.identity, 'delivery-rev-1-method-a/rep:1', 'crash', {
        fence: 1,
      });
    });
    const rep2 = await reservePaidEffect(
      testDb(),
      reserveInput('rev-1', INPUT, 'method-a/rep:2').input,
      reserveInput('rev-1', INPUT, 'method-a/rep:2').delivery,
    );
    expect(rep2).toMatchObject({ kind: 'winner' });
    const sameUnitDifferentInput = await reservePaidEffect(
      testDb(),
      reserveInput('rev-1', OTHER_INPUT, 'method-a/rep:1').input,
      reserveInput('rev-1', OTHER_INPUT, 'method-a/rep:1').delivery,
    );
    expect(sameUnitDifferentInput).toMatchObject({ kind: 'held' });
    const nextRevision = await reservePaidEffect(
      testDb(),
      reserveInput('rev-2', INPUT, 'method-a/rep:1').input,
      reserveInput('rev-2', INPUT, 'method-a/rep:1').delivery,
    );
    expect(nextRevision).toMatchObject({ kind: 'held' });
    expect(nextRevision.kind === 'held' && nextRevision.blockedBy?.entityRevision).toBe('rev-1');
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

  // @invariant concurrency: completion is valid only for the winning delivery AND its exact fence — a stale fence or a non-owner delivery cannot write the receipt
  // @fails-if a wrong-fence delivery records a result for a send it no longer owns
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
    await expect(switchPaidEffectBackend(testDb(), 'note_verify', 'dbos')).resolves.toMatchObject({
      backend: 'dbos',
      generation: 1,
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
    await switchPaidEffectBackend(testDb(), 'note_verify', 'dbos');
    await expect(admitNoteVerifyDelivery(testDb(), 'job-2')).resolves.toMatchObject({
      kind: 'fenced',
      reason: 'backend_mismatch',
      owner: 'dbos',
    });
  });
});
