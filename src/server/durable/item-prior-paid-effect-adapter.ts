// Explicit family consumer of the fixed shared store. No registration or default cutover.
import { z } from 'zod';
import {
  ItemPriorApplicationError,
  type ItemPriorPreparedWork,
  type ItemPriorRepReceipt,
  type ItemPriorStagedItem,
  MAX_REPS,
  commitItemPriorStagedCalibration,
  itemPriorOutputReceiptSchema,
  itemPriorPreparedInput,
  itemPriorRepIdentity,
  parseStagedItemPriorOutput,
  settleItemPriorStagedItem,
} from '@/capabilities/practice/server/item-prior-durable-operation';
import { ItemPriorDraft } from '@/core/schema/item_prior';
import type { Db } from '@/db/client';
import {
  PaidEffectApplicationConflictError,
  PaidEffectProtocolError,
  type PaidEffectReservation,
  computePaidEffectIdentity,
  computePaidEffectInputDigest,
  paidEffectDispatchRefSchema,
  paidEffectIdentitySchema,
  paidEffectJsonEquals,
} from './paid-effect-protocol';
import {
  type PaidEffectSnapshot,
  markPaidEffectUnknown,
  readPaidEffect,
  recordPaidEffectApplication,
  recordPaidEffectResult,
  reservePaidEffect,
} from './paid-effect-store';

export const itemPriorDispatchSchema = paidEffectDispatchRefSchema.extend({
  version: z.literal(1),
  tickId: z.string().min(1),
});
export type ItemPriorDispatch = z.infer<typeof itemPriorDispatchSchema>;

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

export class ItemPriorPaidEffectAdapter {
  readonly dispatch: Readonly<ItemPriorDispatch>;

  constructor(
    private readonly db: Db,
    dispatch: ItemPriorDispatch,
  ) {
    // Producer persists this before dispatch. Never read current control to upgrade an old job.
    this.dispatch = Object.freeze(itemPriorDispatchSchema.parse(dispatch));
  }

  reserveRep(work: ItemPriorPreparedWork, repIndex: number) {
    return reservePaidEffect(this.db, itemPriorPaidEffectInput(work, repIndex), {
      ...this.dispatch,
      leaseExpiresAt: new Date(Date.now() + 60_000),
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
