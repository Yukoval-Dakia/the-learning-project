import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  PaidEffectControlFencedError,
  type PaidEffectIdentity,
  type PaidEffectInput,
  PaidEffectProtocolError,
  type PaidEffectReservation,
  computePaidEffectIdentity,
  computePaidEffectInputDigest,
  paidEffectDispatchRefSchema,
  paidEffectJsonEquals,
} from '@/core/migration/paid-effect-protocol';
import type { Db, Tx } from '@/db/client';
import {
  admitPaidEffectDeliveryControl,
  lockPaidEffectControlFamily,
} from '@/db/paid-effect-control';
import {
  admitPaidEffectIntent,
  claimPaidEffectSend,
  listPaidEffectObligations,
  markPaidEffectUnknown,
  notePaidEffectApplicationFailure,
  readPaidEffect,
  recordPaidEffectApplication,
  recordPaidEffectResult,
} from '@/db/paid-effect-store';
import { paid_effect } from '@/db/schema';

const FAMILY = 'judge_calibration_sample';
const intentMetadata = z.object({
  version: z.literal(1),
  workSetId: z.string().min(1),
  freezeDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

// A future producer persists this generation in the dispatch payload. Neither
// the retained handler nor the gate-only DBOS candidate consumes it yet.
export const calibrationSampleDispatchSchema = z
  .strictObject({
    version: z.literal(1),
    scheduledAt: z.iso.datetime(),
    delivery: paidEffectDispatchRefSchema,
  })
  .superRefine((value, ctx) => {
    const tickId = `sched-${FAMILY}-${value.scheduledAt}`;
    if (
      value.delivery.tickId !== tickId ||
      (value.delivery.backend === 'dbos' && value.delivery.deliveryId !== tickId)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Calibration dispatch must retain its scheduled identity',
      });
    }
  });
export type CalibrationSampleDispatch = z.infer<typeof calibrationSampleDispatchSchema>;

export const calibrationStoreApplicationSchema = z.discriminatedUnion('write', [
  z.object({ write: z.literal('written'), domainRef: z.string().min(1) }),
  z.object({ write: z.literal('skipped'), classification: z.string().min(1) }),
]);
type CalibrationStoreApplication = z.infer<typeof calibrationStoreApplicationSchema>;

export interface CalibrationSendLease {
  readonly identity: PaidEffectIdentity;
  readonly delivery: CalibrationSampleDispatch['delivery'];
  readonly fence: number;
  readonly leaseExpiresAt: Date;
}

function requireCalibrationIdentity(identity: PaidEffectIdentity): void {
  if (identity.family !== FAMILY)
    throw new PaidEffectProtocolError('foreign calibration effect family');
}

export async function readCalibrationStoredInput(db: Db | Tx, identity: PaidEffectIdentity) {
  requireCalibrationIdentity(identity);
  const [row] = await db
    .select({ input: paid_effect.input_json })
    .from(paid_effect)
    .where(
      and(
        eq(paid_effect.family, FAMILY),
        eq(paid_effect.entity_id, identity.entityId),
        eq(paid_effect.entity_revision, identity.entityRevision),
        eq(paid_effect.unit, identity.unit),
        eq(paid_effect.input_digest, identity.inputDigest),
      ),
    );
  if (!row) throw new PaidEffectProtocolError('calibration frozen input is missing');
  return row.input;
}

export async function admitCalibrationStoreDispatch(db: Db, dispatch: CalibrationSampleDispatch) {
  await db.transaction(async (tx) => {
    const admission = await admitPaidEffectDeliveryControl(tx, FAMILY, dispatch.delivery);
    if (admission.kind === 'fenced') {
      throw new PaidEffectControlFencedError(FAMILY, admission.reason, admission.owner);
    }
  });
}

/** Freeze all member intents together before the first claim. The family lock
 * serializes competing freezes of the same scheduled/config workset. */
export async function prepareCalibrationStoreWorkSet(
  db: Db,
  input: {
    workSetId: string;
    freezeDigest: string;
    effects: readonly PaidEffectInput[];
    dispatch: CalibrationSampleDispatch;
  },
) {
  return db.transaction(async (tx) => {
    await lockPaidEffectControlFamily(tx, FAMILY);
    const admission = await admitPaidEffectDeliveryControl(tx, FAMILY, input.dispatch.delivery);
    if (admission.kind === 'fenced') {
      throw new PaidEffectControlFencedError(FAMILY, admission.reason, admission.owner);
    }
    const rows = await tx
      .select({ input: paid_effect.input_json })
      .from(paid_effect)
      .where(
        and(
          eq(paid_effect.family, FAMILY),
          sql`${paid_effect.input_json}->>'workSetId' = ${input.workSetId}`,
        ),
      );
    const digests = [
      ...new Set(rows.map((row) => intentMetadata.parse(row.input).freezeDigest)),
    ].sort();
    if (digests.some((digest) => digest !== input.freezeDigest)) {
      return { kind: 'freeze_mismatch', recordedFreezeDigests: digests } as const;
    }
    for (const effect of input.effects) {
      const metadata = intentMetadata.parse(effect.input);
      if (
        effect.family !== FAMILY ||
        metadata.workSetId !== input.workSetId ||
        metadata.freezeDigest !== input.freezeDigest
      ) {
        throw new PaidEffectProtocolError('calibration intent does not match its workset');
      }
      await admitPaidEffectIntent(tx, effect);
    }
    // An empty freeze has no paid_effect row. Parent must supply a durable tick
    // receipt before claiming replay-stable empty selection or runtime admission.
    return { kind: 'prepared' } as const;
  });
}

/** Uses the shared admission/claim operations inside one family transaction.
 * Calibration additionally blocks a new purchase while an older receipt still
 * needs application. This check is serialized with every result/apply write. */
export async function reserveCalibrationStoreEffect(
  db: Db,
  input: PaidEffectInput,
  dispatch: CalibrationSampleDispatch,
  leaseExpiresAt: Date,
): Promise<PaidEffectReservation & { readonly identity: PaidEffectIdentity }> {
  const identity = computePaidEffectIdentity(input);
  if (
    identity.family !== FAMILY ||
    !Number.isFinite(leaseExpiresAt.getTime()) ||
    leaseExpiresAt <= new Date()
  ) {
    throw new PaidEffectProtocolError('calibration claim family/lease mismatch');
  }
  return db.transaction(async (tx) => {
    await lockPaidEffectControlFamily(tx, FAMILY);
    const admission = await admitPaidEffectDeliveryControl(tx, FAMILY, dispatch.delivery);
    if (admission.kind === 'fenced') {
      throw new PaidEffectControlFencedError(FAMILY, admission.reason, admission.owner);
    }
    await admitPaidEffectIntent(tx, input);
    const row = await readPaidEffect(tx, identity);
    if (!row) throw new PaidEffectProtocolError('calibration reservation lost its intent');
    if (row.state === 'receipt_ready' || row.state === 'applied') {
      return {
        kind: 'completed',
        identity,
        state: row.state,
        result: row.result,
        application: row.application,
        applied: row.state === 'applied',
      };
    }
    if (row.state !== 'pending') {
      return { kind: 'held', identity, state: row.state, blockedBy: null };
    }
    const [blocker] = await tx
      .select()
      .from(paid_effect)
      .where(
        and(
          eq(paid_effect.family, FAMILY),
          eq(paid_effect.entity_id, identity.entityId),
          eq(paid_effect.state, 'receipt_ready'),
          sql`(${paid_effect.entity_revision} <> ${identity.entityRevision}
        or ${paid_effect.unit} <> ${identity.unit}
        or ${paid_effect.input_digest} <> ${identity.inputDigest})`,
        ),
      )
      .limit(1);
    if (blocker)
      return {
        kind: 'held',
        identity,
        state: 'pending',
        blockedBy: {
          family: blocker.family,
          entityId: blocker.entity_id,
          entityRevision: blocker.entity_revision,
          unit: blocker.unit,
          inputDigest: blocker.input_digest,
        },
      };
    const claim = await claimPaidEffectSend(tx, identity, { ...dispatch.delivery, leaseExpiresAt });
    if (claim.kind === 'claimed') return { kind: 'winner', identity, fence: claim.fence };
    if (claim.kind === 'missing')
      throw new PaidEffectProtocolError('calibration claim lost its intent');
    return { kind: 'held', identity, state: claim.state, blockedBy: claim.blockedBy ?? null };
  });
}

export function recordCalibrationStoreResult(db: Db, lease: CalibrationSendLease, result: unknown) {
  requireCalibrationIdentity(lease.identity);
  return db.transaction((tx) =>
    recordPaidEffectResult(tx, lease.identity, lease.delivery.deliveryId, result, {
      fence: lease.fence,
    }),
  );
}

export function markCalibrationStoreUnknown(db: Db, lease: CalibrationSendLease, reason: string) {
  requireCalibrationIdentity(lease.identity);
  return db.transaction((tx) =>
    markPaidEffectUnknown(tx, lease.identity, lease.delivery.deliveryId, reason, {
      fence: lease.fence,
    }),
  );
}

/** A bounded read fails loudly instead of hiding a historical obligation. The
 * shared reader needs pagination before a larger family can be admitted. */
export async function readCalibrationStoreObligations(db: Db) {
  const rows = await listPaidEffectObligations(db, { family: FAMILY, limit: 1001 });
  if (rows.length > 1000)
    throw new PaidEffectProtocolError(
      'calibration obligation read exceeds 1000; pagination required',
    );
  return rows;
}

export async function applyCalibrationStoreReceipt(
  db: Db,
  identity: PaidEffectIdentity,
  apply: (tx: Tx, result: unknown, frozenInput: unknown) => Promise<CalibrationStoreApplication>,
) {
  requireCalibrationIdentity(identity);
  return db.transaction(async (tx) => {
    await lockPaidEffectControlFamily(tx, FAMILY);
    const row = await readPaidEffect(tx, identity);
    if (!row) throw new PaidEffectProtocolError('calibration apply lost its receipt');
    if (row.state === 'applied') {
      const saved = z
        .object({
          version: z.literal(1),
          effect: z.unknown(),
          resultDigest: z.string(),
          application: z.unknown(),
        })
        .parse(row.application);
      if (
        !paidEffectJsonEquals(saved.effect, identity) ||
        saved.resultDigest !== computePaidEffectInputDigest(row.result)
      ) {
        throw new PaidEffectProtocolError('calibration application provenance mismatch');
      }
      return {
        kind: 'applied',
        application: calibrationStoreApplicationSchema.parse(saved.application),
      } as const;
    }
    if (row.state !== 'receipt_ready')
      throw new PaidEffectProtocolError('calibration apply requires a known receipt');
    try {
      const application = await tx.transaction(async (applicationTx) => {
        const evidence = await apply(
          applicationTx,
          row.result,
          await readCalibrationStoredInput(applicationTx, identity),
        );
        await recordPaidEffectApplication(applicationTx, identity, {
          version: 1,
          effect: identity,
          resultDigest: computePaidEffectInputDigest(row.result),
          application: evidence,
        });
        return evidence;
      });
      return { kind: 'applied', application } as const;
    } catch (error) {
      // The savepoint rolls back domain + receipt together, including a caught
      // MF8 unique violation that leaves PostgreSQL's transaction aborted.
      const message = error instanceof Error ? error.message : String(error);
      await notePaidEffectApplicationFailure(tx, identity, message);
      return { kind: 'pending', error: message } as const;
    }
  });
}
