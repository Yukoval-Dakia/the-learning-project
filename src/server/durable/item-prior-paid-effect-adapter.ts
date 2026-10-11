// Explicit family consumer of the fixed shared store. No registration or default cutover.
import { z } from 'zod';
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
} from '@/capabilities/practice/server/item-prior-durable-operation';
import type { Db } from '@/db/client';
import {
  PaidEffectProtocolError,
  type PaidEffectReservation,
  computePaidEffectIdentity,
  computePaidEffectInputDigest,
  paidEffectDispatchRefSchema,
  paidEffectJsonEquals,
} from './paid-effect-protocol';
import {
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
        const results: Array<Extract<ItemPriorRepReceipt, { kind: 'output' }>> = [];
        for (const identity of identities) {
          const snapshot = await readPaidEffect(tx, identity);
          if (!snapshot || !['receipt_ready', 'applied'].includes(snapshot.state)) {
            throw new PaidEffectProtocolError(
              'item-prior application requires every result receipt',
            );
          }
          results.push(itemPriorOutputReceiptSchema.parse(snapshot.result));
        }
        const authoritative = settleItemPriorStagedItem(
          work,
          results.map((result) => parseStagedItemPriorOutput(work.method, result.outputText)),
        );
        if (!paidEffectJsonEquals(authoritative, staged)) {
          throw new PaidEffectProtocolError(
            'item-prior staged draft differs from immutable results',
          );
        }
        const disposition =
          staged.status === 'no-anchor'
            ? ({ status: 'no-anchor' } as const)
            : await commitItemPriorStagedCalibration(tx, staged);
        if (disposition.status === 'not-applicable') {
          throw new PaidEffectProtocolError(
            'item-prior settled item has no application disposition',
          );
        }
        const application = {
          version: 1,
          questionId: work.candidate.id,
          questionRevision: work.questionRevision,
          inputDigest: work.inputDigest,
          method: work.method,
          repCount: work.repCount,
          results: identities.map((identity, index) => ({
            identity,
            resultDigest: computePaidEffectInputDigest(results[index]),
          })),
          disposition,
          draft: staged.draft ?? null,
        };
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
