// End the question's wait without resolving, voiding, or retrying its unknown payment.
import { and, eq, lte, sql } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import type { PaidEffectIdentity } from '@/core/migration/paid-effect-protocol';
import type { Db, Tx } from '@/db/client';
import { lockPaidEffectControlFamily } from '@/db/paid-effect-control';
import {
  degradePaidEffectReceiptToUnknown,
  settleExpiredPaidEffectSends,
} from '@/db/paid-effect-store';
import { paid_effect, question_revision } from '@/db/schema';
import { closePendingQuestionAdmission } from '@/kernel/records/assessment-admission-close';
import { ADMISSION_FAMILY, isPendingAdmission, lockAdmissionGroup } from './enqueue';
import { ADMISSION_STAGE_FAMILY } from './stages';

const UNKNOWN_WAIT_MS = 5 * 60_000;

/**
 * A recorded 'waiting' coordinator receipt whose wakeup stage send died
 * unresolved can never be re-asked and schedules no further wakeup. Demote
 * the run row to 'unknown' so the generic void + successor path applies —
 * the demoted receipt's digest rides in unresolved_reason as the audit key.
 * A stage 'sending' inside its lease is still active work and is left alone.
 * Returns the blocking stage unit when a demotion happened.
 */
export async function demoteWaitingCoordinatorOnUnresolvedStage(
  tx: Tx,
  identity: PaidEffectIdentity,
  opts: { expectedFence: number; result: unknown },
): Promise<string | null> {
  const status = (opts.result as { result?: { status?: string } } | null | undefined)?.result
    ?.status;
  if (status !== 'waiting') return null;
  const [unresolved] = await tx
    .select({ unit: paid_effect.unit })
    .from(paid_effect)
    .where(
      and(
        eq(paid_effect.family, ADMISSION_STAGE_FAMILY),
        eq(paid_effect.entity_id, identity.entityId),
        eq(paid_effect.entity_revision, identity.entityRevision),
        eq(paid_effect.state, 'unknown'),
      ),
    )
    .limit(1);
  if (!unresolved) return null;
  const demoted = await degradePaidEffectReceiptToUnknown(tx, identity, {
    expectedFence: opts.expectedFence,
    unresolvedReason: `unresolved_stage:${unresolved.unit};demoted_receipt:${canonicalHash(opts.result)}`,
  });
  return demoted ? unresolved.unit : null;
}

export async function closeExpiredUnknownAdmissions(db: Db) {
  const now = new Date();
  await settleExpiredPaidEffectSends(db, { family: ADMISSION_FAMILY });
  await settleExpiredPaidEffectSends(db, { family: ADMISSION_STAGE_FAMILY });
  const demoteable = await db
    .select()
    .from(paid_effect)
    .where(
      and(
        eq(paid_effect.family, ADMISSION_FAMILY),
        eq(paid_effect.state, 'receipt_ready'),
        sql`${paid_effect.result_json}->'result'->>'status' = 'waiting'`,
        sql`EXISTS (SELECT 1 FROM paid_effect s
          WHERE s.family = ${ADMISSION_STAGE_FAMILY}
            AND s.entity_id = ${paid_effect.entity_id}
            AND s.entity_revision = ${paid_effect.entity_revision}
            AND s.state = 'unknown')`,
      ),
    )
    .limit(100);
  for (const row of demoteable) {
    await db.transaction(async (tx) => {
      await lockPaidEffectControlFamily(tx, ADMISSION_FAMILY);
      await demoteWaitingCoordinatorOnUnresolvedStage(
        tx,
        {
          family: row.family,
          entityId: row.entity_id,
          entityRevision: row.entity_revision,
          unit: row.unit,
          inputDigest: row.input_digest,
        },
        { expectedFence: row.fence, result: row.result_json },
      );
    });
  }
  const candidates = await db
    .select()
    .from(paid_effect)
    .where(
      and(
        eq(paid_effect.family, ADMISSION_FAMILY),
        eq(paid_effect.state, 'unknown'),
        lte(paid_effect.updated_at, new Date(now.getTime() - UNKNOWN_WAIT_MS)),
        sql`EXISTS (SELECT 1 FROM question_group_lifecycle l
          JOIN question_revision r ON r.revision_id = l.current_revision_id
          WHERE l.group_id = ${paid_effect.entity_id}
            AND r.group_id = l.group_id
            AND r.integrity_digest = ${paid_effect.entity_revision}
            AND l.scoring_admission_state = 'withheld'
            AND l.scoring_admission_withheld_reason = 'unverified_rules'
            AND NOT l.withdrawn AND NOT l.suspended)`,
      ),
    )
    .orderBy(paid_effect.updated_at, paid_effect.entity_id)
    .limit(100);
  let closed = 0;
  for (const candidate of candidates) {
    closed += await db.transaction(async (tx) => {
      await lockPaidEffectControlFamily(tx, ADMISSION_FAMILY);
      const [current] = await tx
        .select()
        .from(paid_effect)
        .where(
          and(
            eq(paid_effect.family, candidate.family),
            eq(paid_effect.entity_id, candidate.entity_id),
            eq(paid_effect.entity_revision, candidate.entity_revision),
            eq(paid_effect.unit, candidate.unit),
            eq(paid_effect.input_digest, candidate.input_digest),
          ),
        )
        .for('update');
      if (
        current?.state !== 'unknown' ||
        current.updated_at.getTime() + UNKNOWN_WAIT_MS > now.getTime()
      )
        return 0;
      const { lifecycle } = await lockAdmissionGroup(tx, current.entity_id);
      if (!isPendingAdmission(lifecycle) || !lifecycle?.current_revision_id) return 0;
      const [revision] = await tx
        .select({ digest: question_revision.integrity_digest })
        .from(question_revision)
        .where(
          and(
            eq(question_revision.revision_id, lifecycle.current_revision_id),
            eq(question_revision.group_id, current.entity_id),
          ),
        );
      if (revision?.digest !== current.entity_revision) return 0;
      const result = await closePendingQuestionAdmission(tx, {
        groupId: current.entity_id,
        expectedRevisionId: lifecycle.current_revision_id,
        expectedGeneration: lifecycle.scoring_admission_generation,
        now,
        verification: {
          policy_id: 'question_admission_unknown_close@1',
          outcome: 'failed',
          evidence: {
            pack: 'question_admission_system_closed',
            reason: 'paid_outcome_unconfirmed',
            repair_delivery: { kind: 'system_closed', reason: 'paid_outcome_unconfirmed' },
            unknown_since: current.updated_at.toISOString(),
            wait_ms: UNKNOWN_WAIT_MS,
            paid_effect: {
              family: current.family,
              entity_id: current.entity_id,
              entity_revision: current.entity_revision,
              unit: current.unit,
              input_digest: current.input_digest,
            },
            unresolved_reason: current.unresolved_reason,
            financial_outcome: 'unknown',
            resend: false,
          },
        },
      });
      return result === 'closed' ? 1 : 0;
    });
  }
  return { closed };
}

export function buildAdmissionUnknownCloseHandler(db: Db) {
  return async () => {
    await closeExpiredUnknownAdmissions(db);
  };
}
