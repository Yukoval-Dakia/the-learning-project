// Explicit family consumer of the fixed shared store. No registration or default cutover.
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  PaidEffectApplicationConflictError,
  PaidEffectProtocolError,
  type PaidEffectReservation,
  computePaidEffectIdentity,
  computePaidEffectInputDigest,
  paidEffectDispatchRefSchema,
  paidEffectIdentitySchema,
  paidEffectJsonEquals,
} from '@/core/migration/paid-effect-protocol';
import { ItemPriorDraft } from '@/core/schema/item_prior';
import type { Db, Tx } from '@/db/client';
import { lockPaidEffectControlFamily } from '@/db/paid-effect-control';
import {
  type PaidEffectSnapshot,
  admitPaidEffectIntent,
  claimPaidEffectSend,
  markPaidEffectUnknown,
  readPaidEffect,
  recordPaidEffectApplication,
  recordPaidEffectResult,
  reservePaidEffect,
} from '@/db/paid-effect-store';
import {
  ItemPriorApplicationError,
  type ItemPriorPreparedWork,
  type ItemPriorRepReceipt,
  type ItemPriorStagedItem,
  commitItemPriorStagedCalibration,
  itemPriorOutputReceiptSchema,
  itemPriorPreparedInput,
  itemPriorRepIdentity,
  parseStagedItemPriorOutput,
  settleItemPriorStagedItem,
} from './item-prior-durable-operation';
import { MAX_REPS } from './item-prior-limits';

export const itemPriorDispatchSchema = paidEffectDispatchRefSchema.extend({
  version: z.literal(1),
  tickId: z.string().min(1),
});
export type ItemPriorDispatch = z.infer<typeof itemPriorDispatchSchema>;

export const itemPriorMemberRequestSchema = z.strictObject({
  member: z.literal('item_prior_backfill'),
  dagRunId: z.string().min(1),
  runDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'runDate must be YYYY-MM-DD'),
  nodeId: z.string().min(1),
  method: z.enum(['feature', 'llasa']).optional(),
  reps: z.number().int().positive().max(MAX_REPS).optional(),
});
export type ItemPriorMemberRequest = z.infer<typeof itemPriorMemberRequestSchema>;
export const itemPriorDispatchedRequestSchema = itemPriorMemberRequestSchema
  .extend({ dispatch: itemPriorDispatchSchema })
  .refine((request) => request.dispatch.tickId === request.dagRunId, {
    message: 'dispatch tickId must be the original DAG run ID',
    path: ['dispatch', 'tickId'],
  });
export type ItemPriorDispatchedRequest = z.infer<typeof itemPriorDispatchedRequestSchema>;
export class ItemPriorMemberIdentityError extends Error {}

const dispatchedBossJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  data: z.unknown(),
});

/** Same identity check at admission and reservation; the latter serializes against job cancellation. */
export async function readItemPriorPgBossDelivery(
  tx: Tx,
  request: ItemPriorDispatchedRequest,
  lock: 'read' | 'update',
) {
  const [rawJob] = await tx.execute(sql`
    select id::text as id, name, state::text as state, data from pgboss.job
    where id = ${request.dispatch.deliveryId}::uuid ${lock === 'update' ? sql`for update` : sql``}
  `);
  if (!rawJob)
    throw new ItemPriorMemberIdentityError('The original node-bound pg-boss job is missing');
  const job = dispatchedBossJobSchema.parse(rawJob);
  const original = itemPriorDispatchedRequestSchema.safeParse(job.data);
  if (
    job.id !== request.dispatch.deliveryId ||
    job.name !== request.member ||
    !original.success ||
    !paidEffectJsonEquals(original.data, request)
  ) {
    throw new ItemPriorMemberIdentityError(
      'Persisted pg-boss job differs from the original versioned DAG dispatch',
    );
  }
  return job;
}

const applicationDispositionSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('matched') }),
  z.strictObject({
    status: z.literal('superseded'),
    existing: z.strictObject({
      b: z.number().nullable(),
      bAnchor: z.number().nullable(),
      confidence: z.number().nullable(),
      source: z.string().nullable(),
    }),
  }),
  z.strictObject({ status: z.literal('no-anchor') }),
]);
const applicationSchema = z.strictObject({
  version: z.literal(1),
  questionId: z.string().min(1),
  questionRevision: z.string().min(1),
  inputDigest: paidEffectIdentitySchema.shape.inputDigest,
  method: z.enum(['feature', 'llasa']),
  repCount: z.number().int().positive().max(MAX_REPS),
  results: z
    .array(
      z.strictObject({
        identity: paidEffectIdentitySchema,
        resultDigest: paidEffectIdentitySchema.shape.inputDigest,
      }),
    )
    .min(1)
    .max(MAX_REPS),
  disposition: applicationDispositionSchema,
  draft: ItemPriorDraft.nullable(),
});
type OutputReceipt = Extract<ItemPriorRepReceipt, { kind: 'output' }>;

function applicationBase(
  work: ItemPriorPreparedWork,
  staged: ItemPriorStagedItem,
  results: readonly OutputReceipt[],
) {
  const authoritative = settleItemPriorStagedItem(
    work,
    results.map((result) => parseStagedItemPriorOutput(work.method, result.outputText)),
  );
  if (!paidEffectJsonEquals(authoritative, staged)) {
    throw new PaidEffectApplicationConflictError(
      'item-prior staged draft differs from immutable results',
    );
  }
  return {
    version: 1,
    questionId: work.candidate.id,
    questionRevision: work.questionRevision,
    inputDigest: work.inputDigest,
    method: work.method,
    repCount: work.repCount,
    results: results.map((result, index) => ({
      identity: computePaidEffectIdentity(itemPriorPaidEffectInput(work, index)),
      resultDigest: computePaidEffectInputDigest(result),
    })),
    draft: staged.draft ?? null,
  };
}

/** Pure compatibility check; only the store consumer can establish that every rep is applied. */
export function validateItemPriorAppliedApplication(
  work: ItemPriorPreparedWork,
  staged: ItemPriorStagedItem,
  results: readonly OutputReceipt[],
  applications: readonly unknown[],
) {
  const base = applicationBase(work, staged, results);
  if (applications.length !== work.repCount) {
    throw new PaidEffectApplicationConflictError(
      'item-prior terminal application set is incomplete',
    );
  }
  const historical = applicationSchema.parse(applications[0]);
  if ((staged.status === 'no-anchor') !== (historical.disposition.status === 'no-anchor')) {
    throw new PaidEffectApplicationConflictError(
      'item-prior terminal disposition differs from immutable results',
    );
  }
  const expected = { ...base, disposition: historical.disposition };
  if (!applications.every((application) => paidEffectJsonEquals(application, expected))) {
    throw new PaidEffectApplicationConflictError(
      'item-prior terminal application receipts are incompatible',
    );
  }
  return historical.disposition;
}

/** B's sibling exemption requires one revision to identify one complete frozen workset. */
export function itemPriorPaidEffectRevision(work: ItemPriorPreparedWork): string {
  return computePaidEffectInputDigest({
    version: 1,
    questionRevision: work.questionRevision,
    inputDigest: work.inputDigest,
    repCount: work.repCount,
  });
}

export function itemPriorPaidEffectInput(work: ItemPriorPreparedWork, repIndex: number) {
  const rep = itemPriorRepIdentity(work, repIndex);
  const input = itemPriorPreparedInput(work);
  if (computePaidEffectInputDigest(input) !== work.inputDigest) {
    throw new PaidEffectProtocolError('item-prior frozen input no longer matches its digest');
  }
  return {
    family: 'item_prior_backfill',
    entityId: rep.questionId,
    entityRevision: itemPriorPaidEffectRevision(work),
    unit: `${work.method}/rep:${repIndex}`,
    input,
  };
}

export type ItemPriorPaidEffectWinner = Extract<PaidEffectReservation, { kind: 'winner' }> & {
  readonly identity: ReturnType<typeof computePaidEffectIdentity>;
};

export type ItemPriorPaidEffectReservation =
  | (PaidEffectReservation & { readonly identity: ReturnType<typeof computePaidEffectIdentity> })
  | {
      readonly kind: 'recovery-only';
      readonly identity: ReturnType<typeof computePaidEffectIdentity>;
      readonly jobState: string;
      /** null means absent, not a fabricated pending intent. */
      readonly effectState: 'pending' | null;
    };

function completedReservation(snapshot: PaidEffectSnapshot): ItemPriorPaidEffectReservation {
  if (snapshot.state !== 'receipt_ready' && snapshot.state !== 'applied') {
    throw new PaidEffectProtocolError('item-prior recovery requires a known result receipt');
  }
  return {
    kind: 'completed',
    identity: snapshot.identity,
    state: snapshot.state,
    result: snapshot.result,
    application: snapshot.application,
    applied: snapshot.state === 'applied',
  };
}

export class ItemPriorPaidEffectAdapter {
  readonly dispatch: Readonly<ItemPriorDispatch>;
  private readonly request: Readonly<ItemPriorDispatchedRequest>;

  constructor(
    private readonly db: Db,
    request: ItemPriorDispatchedRequest,
  ) {
    // Producer persists this before dispatch. Never read current control to upgrade an old job.
    const original = itemPriorDispatchedRequestSchema.parse(request);
    this.dispatch = Object.freeze(original.dispatch);
    this.request = Object.freeze({ ...original, dispatch: this.dispatch });
  }

  async reserveRep(
    work: ItemPriorPreparedWork,
    repIndex: number,
  ): Promise<ItemPriorPaidEffectReservation> {
    const input = itemPriorPaidEffectInput(work, repIndex);
    const identity = computePaidEffectIdentity(input);
    const delivery = {
      ...this.dispatch,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    };
    if (this.dispatch.backend !== 'pg-boss') {
      return reservePaidEffect(this.db, input, delivery);
    }
    return this.db.transaction(async (tx) => {
      // Family FIRST, then owning job, then B's row/entity/control locks in their existing order.
      // The job lock remains held through the claim commit; cached admission cannot bypass it.
      await lockPaidEffectControlFamily(tx, input.family);
      const job = await readItemPriorPgBossDelivery(tx, this.request, 'update');
      if (!['created', 'retry', 'active'].includes(job.state)) {
        // Readonly recovery: no intent insert, claim, lease/fence mutation or invented receipt.
        const snapshot = await readPaidEffect(tx, identity);
        if (snapshot?.state === 'receipt_ready' || snapshot?.state === 'applied') {
          return completedReservation(snapshot);
        }
        if (snapshot?.state === 'sending' || snapshot?.state === 'unknown') {
          return { kind: 'held', identity, state: snapshot.state, blockedBy: null };
        }
        return {
          kind: 'recovery-only',
          identity,
          jobState: job.state,
          effectState: snapshot?.state === 'pending' ? 'pending' : null,
        };
      }
      await admitPaidEffectIntent(tx, input);
      const claim = await claimPaidEffectSend(tx, identity, delivery);
      if (claim.kind === 'claimed') return { kind: 'winner', identity, fence: claim.fence };
      if (claim.kind === 'missing') {
        throw new PaidEffectProtocolError('item-prior admitted intent is missing at send claim');
      }
      if (claim.receiptKnown) {
        const snapshot = await readPaidEffect(tx, identity);
        if (!snapshot) throw new PaidEffectProtocolError('item-prior result receipt is missing');
        return completedReservation(snapshot);
      }
      return { kind: 'held', identity, state: claim.state, blockedBy: claim.blockedBy ?? null };
    });
  }

  async completeRep(
    winner: ItemPriorPaidEffectWinner,
    receipt: ItemPriorRepReceipt,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (receipt.kind === 'unknown') {
        await markPaidEffectUnknown(tx, winner.identity, this.dispatch.deliveryId, receipt.reason, {
          fence: winner.fence,
        });
      } else {
        await recordPaidEffectResult(
          tx,
          winner.identity,
          this.dispatch.deliveryId,
          itemPriorOutputReceiptSchema.parse(receipt),
          { fence: winner.fence },
        );
      }
    });
  }

  /** Domain disposition and every rep application receipt commit together. Readback is noncausal. */
  async commitStaged(work: ItemPriorPreparedWork, staged: ItemPriorStagedItem) {
    if (staged.status === 'held' || staged.status === 'incomplete') {
      return { status: 'not-applicable' } as const;
    }
    try {
      return await this.db.transaction(async (tx) => {
        const identities = Array.from({ length: work.repCount }, (_, index) =>
          computePaidEffectIdentity(itemPriorPaidEffectInput(work, index)),
        );
        const results: OutputReceipt[] = [];
        const snapshots: PaidEffectSnapshot[] = [];
        for (const identity of identities) {
          const snapshot = await readPaidEffect(tx, identity);
          if (!snapshot || !['receipt_ready', 'applied'].includes(snapshot.state)) {
            throw new PaidEffectProtocolError(
              'item-prior application requires every result receipt',
            );
          }
          results.push(itemPriorOutputReceiptSchema.parse(snapshot.result));
          snapshots.push(snapshot);
        }
        if (snapshots.every((snapshot) => snapshot.state === 'applied')) {
          // Historical disposition survives supported later domain edits and lost workflow acknowledgments.
          // This branch performs no domain reads/writes and never rewrites an application receipt.
          return validateItemPriorAppliedApplication(
            work,
            staged,
            results,
            snapshots.map((snapshot) => snapshot.application),
          );
        }
        if (snapshots.some((snapshot) => snapshot.state === 'applied')) {
          throw new PaidEffectApplicationConflictError(
            'item-prior mixed applied and unapplied receipts require reconciliation',
          );
        }
        const base = applicationBase(work, staged, results);
        const disposition =
          staged.status === 'no-anchor'
            ? ({ status: 'no-anchor' } as const)
            : await commitItemPriorStagedCalibration(tx, staged);
        if (disposition.status === 'not-applicable') {
          throw new PaidEffectProtocolError(
            'item-prior settled item has no application disposition',
          );
        }
        const application = { ...base, disposition };
        for (const identity of identities) {
          await recordPaidEffectApplication(tx, identity, application);
        }
        return disposition;
      });
    } catch (error) {
      throw new ItemPriorApplicationError(
        `item-prior transactional application failed for question ${work.candidate.id}`,
        error,
        work.candidate.id,
      );
    }
  }
}
