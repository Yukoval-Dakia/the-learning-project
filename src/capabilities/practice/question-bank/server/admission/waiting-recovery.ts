// Re-arm a quota wait whose scheduled wake-up delivery was lost, without paying twice.
// The scan only re-sends a delivery. It reads the frozen coordinator receipt, replays
// its paid stage receipts through the normal claim, and lets the stage runner decide
// whether the retry instant has arrived.
import { and, eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import {
  QUESTION_ADMISSION_CONTRACT_VERSION,
  QUESTION_ADMISSION_PAID_UNIT,
  QUESTION_ADMISSION_PAID_UNITS,
} from '@/core/question-admission-policy';
import type { Db, Tx } from '@/db/client';
import { lockPaidEffectControlFamily, readPaidEffectControl } from '@/db/paid-effect-control';
import { fromPgBossDrizzleTx } from '@/db/pg-boss-drizzle';
import { paid_effect, question_revision } from '@/db/schema';
import { writeEvent } from '@/kernel/events/index';
import { getStartedBoss } from '@/server/boss/client';
import {
  ADMISSION_FAMILY,
  type AdmissionJobData,
  admissionJobId,
  isPendingAdmission,
  lockAdmissionGroup,
} from './enqueue';
import { AdmissionResultReceipt, FrozenAdmissionInput } from './receipt';

/**
 * A wait is only re-armed after its own retry instant has clearly passed, so the
 * normal scheduled wake-up keeps its first chance and a burst of due waits cannot
 * race the delivery that is already on the queue.
 */
export const ADMISSION_WAIT_RECOVERY_GRACE_MS = 10 * 60_000;
/** Candidates inspected per pass; the batch below bounds the sends. */
export const ADMISSION_WAIT_RECOVERY_SCAN_LIMIT = 200;
/** One pass re-arms at most this many waits; the admission queue still runs them serially. */
export const ADMISSION_WAIT_RECOVERY_BATCH_LIMIT = 10;
/**
 * Re-arm budget for one waiting receipt. This is a delivery budget, not a paid-attempt
 * cap: a re-armed delivery that is itself lost may be re-armed again, but a receipt
 * whose resume keeps failing without moving the wait cannot spin forever.
 */
export const ADMISSION_WAIT_RECOVERY_MAX_ATTEMPTS = 3;

const RECOVERY_EVENT_ACTION = 'experimental:question_admission_waiting_recovery';
const RECOVERY_ACTOR_REF = 'practice:question_admission';
const STAGE_FAMILY = 'question_admission_stage';

const Recovery = z.object({
  reason: z.enum(['quota', 'login']),
  retry_at: z.string().datetime(),
  evidence_ref: z.string().min(1),
});

const LEGACY_PAID_UNITS = QUESTION_ADMISSION_PAID_UNITS.filter(
  (unit) => unit !== QUESTION_ADMISSION_PAID_UNIT,
);

type RecoveryAttempt = { kind: 'rearmed'; jobId: string } | { kind: 'skipped'; reason: string };

interface WaitCandidate {
  groupId: string;
  entityRevision: string;
  inputDigest: string;
  input: unknown;
  result: unknown;
  /** Latest quota-waiting stage receipt: the sleep clock the stage runner reads. */
  stageUnit: string;
  stageInputDigest: string;
  stageRetryAt: string;
}

export interface AdmissionWaitRecoveryReport {
  scanned: number;
  rearmed: { groupId: string; jobId: string; retryAt: string }[];
  skipped: { groupId: string; reason: string }[];
}

function skippedReport(report: AdmissionWaitRecoveryReport, groupId: string, reason: string): void {
  report.skipped.push({ groupId, reason });
}

/**
 * Latest live coordinator receipt and its latest quota-waiting stage receipt per
 * group. The coordinator supplies the frozen input; the stage receipt is the clock
 * the stage runner compares `retry_at` against.
 */
async function readCandidates(db: Db): Promise<WaitCandidate[]> {
  const rows = await db.execute<{
    group_id: string;
    entity_revision: string;
    input_digest: string;
    input_json: unknown;
    result_json: unknown;
    stage_unit: string;
    stage_input_digest: string;
    stage_recovery: unknown;
  }>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (c.entity_id, c.entity_revision, c.unit)
        c.entity_id, c.entity_revision, c.unit, c.input_digest, c.input_json,
        c.result_json, c.state, c.created_at
      FROM paid_effect c
      WHERE c.family = ${ADMISSION_FAMILY}
        AND c.unit = ${QUESTION_ADMISSION_PAID_UNIT}
        AND c.state IN ('receipt_ready', 'applied')
      ORDER BY c.entity_id, c.entity_revision, c.unit, c.created_at DESC
    ), waits AS (
      SELECT DISTINCT ON (s.entity_id, s.entity_revision, s.input_json->>'call_index')
        s.entity_id, s.entity_revision, s.unit, s.input_digest, s.state,
        s.result_json, s.result_recorded_at
      FROM paid_effect s
      WHERE s.family = ${STAGE_FAMILY}
        AND s.state IN ('receipt_ready', 'applied')
        AND s.result_json->>'kind' = 'waiting'
        AND s.result_json->'recovery'->>'reason' = 'quota'
      ORDER BY s.entity_id, s.entity_revision, s.input_json->>'call_index',
        (s.input_json->>'attempt')::int DESC
    )
    SELECT candidate.* FROM (
      SELECT DISTINCT ON (c.entity_id, c.entity_revision, c.unit)
        c.entity_id AS group_id, c.entity_revision, c.input_digest, c.input_json,
        c.result_json, w.unit AS stage_unit, w.input_digest AS stage_input_digest,
        w.result_json->'recovery' AS stage_recovery,
        w.result_json->'recovery'->>'retry_at' AS stage_retry_at
      FROM latest c
      JOIN waits w ON w.entity_id = c.entity_id AND w.entity_revision = c.entity_revision
      JOIN question_group_lifecycle l ON l.group_id = c.entity_id
      JOIN question_revision r ON r.revision_id = l.current_revision_id
      WHERE c.result_json->'result'->>'status' = 'waiting'
        AND r.integrity_digest = c.entity_revision
        AND l.scoring_admission_state = 'withheld'
        AND l.scoring_admission_withheld_reason = 'unverified_rules'
        AND NOT l.withdrawn AND NOT l.suspended
        AND c.input_json->>'revision_id' = l.current_revision_id
        AND c.input_json->>'revision_digest' = r.integrity_digest
        AND NOT EXISTS (
          SELECT 1 FROM paid_effect unresolved
          WHERE unresolved.family = ${STAGE_FAMILY}
            AND unresolved.entity_id = c.entity_id
            AND unresolved.entity_revision = c.entity_revision
            AND unresolved.state IN ('sending', 'unknown')
        )
        AND NOT EXISTS (
          SELECT 1 FROM paid_effect legacy
          WHERE legacy.family = ${ADMISSION_FAMILY}
            AND legacy.entity_id = c.entity_id
            AND legacy.entity_revision = c.entity_revision
            AND legacy.unit IN (${sql.join(
              LEGACY_PAID_UNITS.map((unit) => sql`${unit}`),
              sql`, `,
            )})
            AND legacy.state = 'receipt_ready'
        )
      ORDER BY c.entity_id, c.entity_revision, c.unit, w.result_recorded_at DESC
    ) candidate
    ORDER BY candidate.stage_retry_at, candidate.group_id
    LIMIT ${ADMISSION_WAIT_RECOVERY_SCAN_LIMIT}
  `);
  const candidates: WaitCandidate[] = [];
  for (const row of rows) {
    const recovery = Recovery.safeParse(row.stage_recovery);
    const receipt = AdmissionResultReceipt.safeParse(row.result_json);
    if (!recovery.success || !receipt.success || receipt.data.result.status !== 'waiting') {
      continue;
    }
    candidates.push({
      groupId: row.group_id,
      entityRevision: row.entity_revision,
      inputDigest: row.input_digest,
      input: row.input_json,
      result: row.result_json,
      stageUnit: row.stage_unit,
      stageInputDigest: row.stage_input_digest,
      stageRetryAt: recovery.data.retry_at,
    });
  }
  return candidates;
}

async function hasActiveDelivery(db: Db | Tx, groupId: string): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id FROM pgboss.job
    WHERE name = ${ADMISSION_FAMILY}
      AND data->>'question_id' = ${groupId}
      AND state IN ('created', 'retry', 'active')
    LIMIT 1
  `);
  return rows.length > 0;
}

async function recoveryAttempts(
  db: Db | Tx,
  groupId: string,
  digest: string,
  retryAt: string,
): Promise<number> {
  const rows = await db.execute<{ attempts: number }>(sql`
    SELECT count(*)::int AS attempts FROM event
    WHERE action = ${RECOVERY_EVENT_ACTION}
      AND subject_kind = 'question'
      AND subject_id = ${groupId}
      AND payload->>'revision_digest' = ${digest}
      AND payload->>'retry_at' = ${retryAt}
  `);
  return rows[0]?.attempts ?? 0;
}

function recoveryEventId(
  groupId: string,
  digest: string,
  retryAt: string,
  attempt: number,
): string {
  return `admission-wait-recovery:${groupId}:${attempt}:${retryAt}:${digest}`;
}

/**
 * Scan for recorded quota waits whose wake-up is gone and re-queue one delivery each.
 * Idempotent under concurrent scans: the family advisory lock serializes the check,
 * and the pg-boss id below is derived from the waiting receipt (digest, stage, retry
 * instant), so a second sender collides on the id. No paid effect is created here.
 */
export async function recoverExpiredAdmissionWaits(
  db: Db,
  options: { now?: Date; boss?: PgBoss } = {},
): Promise<AdmissionWaitRecoveryReport> {
  const report: AdmissionWaitRecoveryReport = { scanned: 0, rearmed: [], skipped: [] };
  const now = options.now ?? new Date();
  const queueProbe = await db.execute<{ reg: string | null }>(sql`
    SELECT to_regclass('pgboss.job') AS reg
  `);
  if (queueProbe[0]?.reg == null) return report;
  const boss = options.boss ?? (await getStartedBoss());
  const candidates = await readCandidates(db);
  report.scanned = candidates.length;

  for (const candidate of candidates) {
    if (report.rearmed.length >= ADMISSION_WAIT_RECOVERY_BATCH_LIMIT) break;
    if (Date.parse(candidate.stageRetryAt) > now.getTime() - ADMISSION_WAIT_RECOVERY_GRACE_MS) {
      skippedReport(report, candidate.groupId, 'retry_not_due');
      continue;
    }
    const input = FrozenAdmissionInput.safeParse(candidate.input);
    if (!input.success) {
      skippedReport(report, candidate.groupId, 'unreadable_frozen_input');
      continue;
    }

    const outcome = await db.transaction<RecoveryAttempt>(async (tx) => {
      await lockPaidEffectControlFamily(tx, ADMISSION_FAMILY);
      const control = await readPaidEffectControl(tx, ADMISSION_FAMILY);
      if (control.backend !== 'pg-boss') {
        return { kind: 'skipped', reason: 'backend_not_pg_boss' };
      }
      // Family -> paid row (coordinator, then stage) -> root -> lifecycle: the same
      // order as the delivery claim. No paid effect is written by this transaction.
      const [row] = await tx
        .select()
        .from(paid_effect)
        .where(
          and(
            eq(paid_effect.family, ADMISSION_FAMILY),
            eq(paid_effect.entity_id, candidate.groupId),
            eq(paid_effect.entity_revision, candidate.entityRevision),
            eq(paid_effect.unit, QUESTION_ADMISSION_PAID_UNIT),
            eq(paid_effect.input_digest, candidate.inputDigest),
          ),
        )
        .for('update')
        .limit(1);
      if (row == null || (row.state !== 'receipt_ready' && row.state !== 'applied')) {
        return { kind: 'skipped', reason: 'receipt_gone' };
      }
      const receipt = AdmissionResultReceipt.safeParse(row.result_json);
      if (!receipt.success || receipt.data.result.status !== 'waiting') {
        return { kind: 'skipped', reason: 'wait_changed' };
      }
      const [stage] = await tx
        .select()
        .from(paid_effect)
        .where(
          and(
            eq(paid_effect.family, STAGE_FAMILY),
            eq(paid_effect.entity_id, candidate.groupId),
            eq(paid_effect.entity_revision, row.entity_revision),
            eq(paid_effect.unit, candidate.stageUnit),
            eq(paid_effect.input_digest, candidate.stageInputDigest),
          ),
        )
        .for('update')
        .limit(1);
      if (stage == null || (stage.state !== 'receipt_ready' && stage.state !== 'applied')) {
        return { kind: 'skipped', reason: 'wait_changed' };
      }
      const stageReceipt = z
        .object({ kind: z.literal('waiting'), recovery: Recovery })
        .safeParse(stage.result_json);
      if (!stageReceipt.success || stageReceipt.data.recovery.retry_at !== candidate.stageRetryAt) {
        return { kind: 'skipped', reason: 'wait_changed' };
      }
      if (
        Date.parse(stageReceipt.data.recovery.retry_at) >
        now.getTime() - ADMISSION_WAIT_RECOVERY_GRACE_MS
      ) {
        return { kind: 'skipped', reason: 'retry_not_due' };
      }
      const { lifecycle } = await lockAdmissionGroup(tx, candidate.groupId);
      if (!lifecycle || !isPendingAdmission(lifecycle)) {
        return { kind: 'skipped', reason: 'not_pending' };
      }
      const revisionId = lifecycle.current_revision_id;
      if (revisionId == null || input.data.revision_id !== revisionId) {
        return { kind: 'skipped', reason: 'revision_moved' };
      }
      const [revision] = await tx
        .select({ digest: question_revision.integrity_digest })
        .from(question_revision)
        .where(
          and(
            eq(question_revision.revision_id, revisionId),
            eq(question_revision.group_id, candidate.groupId),
          ),
        );
      if (
        revision?.digest !== row.entity_revision ||
        input.data.revision_digest !== row.entity_revision
      ) {
        return { kind: 'skipped', reason: 'revision_moved' };
      }
      const [unresolved] = await tx
        .select({ unit: paid_effect.unit })
        .from(paid_effect)
        .where(
          and(
            eq(paid_effect.family, STAGE_FAMILY),
            eq(paid_effect.entity_id, candidate.groupId),
            eq(paid_effect.entity_revision, row.entity_revision),
            sql`${paid_effect.state} IN ('sending', 'unknown')`,
          ),
        )
        .limit(1);
      if (unresolved) return { kind: 'skipped', reason: 'unresolved_stage' };
      if (await hasActiveDelivery(tx, candidate.groupId)) {
        return { kind: 'skipped', reason: 'active_delivery' };
      }
      const attempts = await recoveryAttempts(
        tx,
        candidate.groupId,
        row.entity_revision,
        stageReceipt.data.recovery.retry_at,
      );
      if (attempts >= ADMISSION_WAIT_RECOVERY_MAX_ATTEMPTS) {
        return { kind: 'skipped', reason: 'recovery_budget_exhausted' };
      }

      const jobData = {
        admission_version: QUESTION_ADMISSION_CONTRACT_VERSION,
        question_id: input.data.group_id,
        ...(input.data.revision_id ? { revision_id: input.data.revision_id } : {}),
        ...(input.data.revision_digest
          ? { expected_revision_digest: input.data.revision_digest }
          : {}),
        expected_admission_generation: input.data.admission_generation,
        dispatch_generation: control.generation,
        recovery_confirmed: false,
      } satisfies AdmissionJobData;
      // Per waiting receipt, so a repeat scan (or a second reviewer of the same wait)
      // lands on the same delivery id; the stage unit is only a receipt locator.
      const jobId = admissionJobId(
        input.data.group_id,
        input.data.revision_id ?? input.data.group_id,
        `${row.entity_revision}:${candidate.stageUnit}:recovery:${stageReceipt.data.recovery.retry_at}`,
        input.data.admission_generation,
      );
      const sent = await boss.send(ADMISSION_FAMILY, jobData, {
        id: jobId,
        db: fromPgBossDrizzleTx(tx),
      });
      if (sent == null) return { kind: 'skipped', reason: 'delivery_exists' };
      await writeEvent(tx, {
        id: recoveryEventId(
          candidate.groupId,
          row.entity_revision,
          stageReceipt.data.recovery.retry_at,
          attempts + 1,
        ),
        actor_kind: 'system',
        actor_ref: RECOVERY_ACTOR_REF,
        action: RECOVERY_EVENT_ACTION,
        subject_kind: 'question',
        subject_id: candidate.groupId,
        payload: {
          group_id: candidate.groupId,
          revision_id: input.data.revision_id,
          revision_digest: row.entity_revision,
          retry_at: stageReceipt.data.recovery.retry_at,
          stage: candidate.stageUnit,
          evidence_ref: stageReceipt.data.recovery.evidence_ref,
          attempt: attempts + 1,
          job_id: jobId,
          delivery_lost: 'no_active_delivery_past_retry_at',
        },
        affected_scopes: [],
        ingest_at: now,
      });
      return { kind: 'rearmed', jobId };
    });

    if (outcome.kind === 'rearmed') {
      report.rearmed.push({
        groupId: candidate.groupId,
        jobId: outcome.jobId,
        retryAt: candidate.stageRetryAt,
      });
    } else {
      skippedReport(report, candidate.groupId, outcome.reason);
    }
  }
  return report;
}

export function buildAdmissionWaitingRecoveryHandler(db: Db) {
  return async () => {
    const report = await recoverExpiredAdmissionWaits(db);
    if (report.rearmed.length > 0) {
      console.log(
        `[question_admission] re-armed ${report.rearmed.length} lost waiting wake-up(s): ` +
          report.rearmed.map((row) => `${row.groupId}@${row.retryAt}`).join(', '),
      );
    }
    return report;
  };
}
