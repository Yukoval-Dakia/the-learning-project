// End the question's wait without resolving, voiding, or retrying its unknown payment.
import { and, eq, lte, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { lockPaidEffectControlFamily } from '@/db/paid-effect-control';
import { settleExpiredPaidEffectSends } from '@/db/paid-effect-store';
import { paid_effect, question_revision } from '@/db/schema';
import { closePendingQuestionAdmission } from '@/kernel/records/assessment-admission-close';
import { ADMISSION_FAMILY, isPendingAdmission, lockAdmissionGroup } from './enqueue';
import { ADMISSION_STAGE_FAMILY } from './stages';

const UNKNOWN_WAIT_MS = 5 * 60_000;

export async function closeExpiredUnknownAdmissions(db: Db) {
  const now = new Date();
  await settleExpiredPaidEffectSends(db, { family: ADMISSION_FAMILY });
  await settleExpiredPaidEffectSends(db, { family: ADMISSION_STAGE_FAMILY });
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
