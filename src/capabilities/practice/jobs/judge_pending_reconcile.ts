import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { canonicalHash } from '@/core/migration/canonical';
import {
  JudgeOperationalEvent,
  JudgeReconcileObservationPayload,
} from '@/core/schema/event/judge-operational-events';
import { JudgePendingAttemptPayload } from '@/core/schema/event/judge-pending-events';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { observeJudgeDelivery } from '../server/judge-engine-client';
import {
  acceptJudgeDelivery,
  authorizeJudgeSend,
  disposeJudgeRun,
  judgeOwner,
  lockJudgeRun,
  readJudgeControl,
  reserveJudgeDelivery,
  writeJudgeReceipt,
} from '../server/judge-operational';
import { judgeReceiptId, judgeRecoveryCapacity } from '../server/judge-operational-state';
import {
  type JudgeRunEnqueueDeps,
  admitJudgeRun,
  enqueueJudgeRun,
} from '../server/judge-run-dispatch';
import { projectJudgeRunNotification } from '../server/judge-run-notification';
import { readJudgeRunPermanent } from '../server/judge-run-observation';
import { JUDGE_RUN_EVENTS } from '../server/judge-run-status';

export const RECONCILE_STALL_MS = 15 * 60_000;
export const RECOVERY_MAX_AGE_MS = 7 * 86400_000;
export const RECONCILE_SCAN_LIMIT = 20;
export const RECONCILE_RAW_SCAN_LIMIT = 200;
export const MAX_RECOVERY_ATTEMPTS = 2;
export interface JudgePendingReconcileReport {
  scanned: number;
  reenqueued: number;
  skippedLive: number;
  skippedTerminal: number;
  skippedExhausted: number;
  failed: number;
}
export interface JudgePendingReconcileDeps extends JudgeRunEnqueueDeps {
  observe?: typeof observeJudgeDelivery;
  boss?: NonNullable<JudgeRunEnqueueDeps['boss']> & {
    getJobById: (queue: string, id: string) => Promise<import('pg-boss').JobWithMetadata | null>;
  };
}
/** The cursor and frozen selection commit before work. Replays retain that selection; later ticks move past it. */
async function selectSweep(
  database: Db,
  args: { now: Date; limit: number; tickId: string; backend?: 'pg-boss' | 'dbos' },
) {
  return database.transaction(async (tx) => {
    const control = await readJudgeControl(tx, 'share');
    await tx.execute(sql`select pg_advisory_xact_lock(1356,2)`);
    const id = judgeReceiptId('sweep', [args.tickId]);
    const [saved] = await tx.select().from(event).where(eq(event.id, id));
    if (saved) {
      const receipt = JudgeOperationalEvent.parse(saved);
      if (
        receipt.action !== 'experimental:judge_reconcile_observation' ||
        receipt.payload.tick_id !== args.tickId ||
        (args.backend && receipt.payload.ownership.backend !== args.backend)
      )
        throw new Error('Judge sweep identity conflict');
      return receipt.payload;
    }
    const ownership = {
      ...judgeOwner(control),
      backend: args.backend ?? judgeOwner(control).backend,
    };
    const [prior] = await tx
      .select({ payload: event.payload })
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:judge_reconcile_observation'),
          sql`${event.payload}->'ownership'->>'incarnation' = ${control.incarnation}`,
          sql`${event.payload}->'ownership'->>'backend' = ${ownership.backend}`,
        ),
      )
      .orderBy(desc(sql`(${event.payload}->>'sequence')::bigint`))
      .limit(1);
    const last = prior ? JudgeReconcileObservationPayload.parse(prior.payload) : null;
    const admitted = control.phase === ownership.backend;
    const cursor = last?.cursor;
    const rows = admitted
      ? await tx
          .select()
          .from(event)
          .where(
            and(
              eq(event.action, 'experimental:judge_pending_attempt'),
              lt(event.created_at, new Date(args.now.getTime() - RECONCILE_STALL_MS)),
              cursor
                ? sql`(${event.created_at},${event.id}) > (${cursor.created_at}::timestamptz,${cursor.id})`
                : undefined,
              sql`not exists (select 1 from event d where d.action='experimental:judge_disposition' and
        ((d.payload->>'coordinate'='native' and d.payload->>'pending_id'=${event.id}) or
         (d.payload->>'coordinate'='legacy_task' and d.payload->>'task_id'=${event.id})))`,
            ),
          )
          .orderBy(asc(event.created_at), asc(event.id))
          .limit(args.limit)
      : [];
    const final = rows.at(-1);
    const payload = JudgeReconcileObservationPayload.parse({
      version: 1,
      tick_id: args.tickId,
      ownership,
      sequence: (last?.sequence ?? 0) + 1,
      admission: admitted ? 'admitted' : 'fenced',
      pending_ids: rows.map((r) => r.id),
      cursor:
        rows.length === args.limit && final
          ? { created_at: final.created_at.toISOString(), id: final.id }
          : null,
      recorded_at: args.now.toISOString(),
    });
    await writeJudgeReceipt(
      tx,
      id,
      {
        actor_kind: 'system',
        actor_ref: 'judge:operational',
        subject_kind: 'durable_family',
        subject_id: 'judge_run',
        caused_by_event_id: null,
        outcome: null,
        task_run_id: null,
        cost_micro_usd: null,
        action: 'experimental:judge_reconcile_observation',
        payload,
      },
      args.now,
    );
    return payload;
  });
}
export async function reconcileStalledJudgeAttempts(
  database: Db,
  args: {
    now?: Date;
    deps?: JudgePendingReconcileDeps;
    rawScanLimit?: number;
    tick?: { backend: 'pg-boss' | 'dbos'; id: string };
  } = {},
) {
  const now = args.now ?? new Date(),
    deps = args.deps ?? {};
  const report: JudgePendingReconcileReport = {
    scanned: 0,
    reenqueued: 0,
    skippedLive: 0,
    skippedTerminal: 0,
    skippedExhausted: 0,
    failed: 0,
  };
  const sweep = await selectSweep(database, {
    now,
    limit: Math.max(1, Math.min(200, args.rawScanLimit ?? 200)),
    tickId: args.tick?.id ?? randomUUID(),
    backend: args.tick?.backend,
  });
  if (sweep.admission === 'fenced') return report;
  const rows = sweep.pending_ids.length
    ? await database.select().from(event).where(inArray(event.id, sweep.pending_ids))
    : [];
  for (const row of rows) {
    report.scanned++;
    try {
      const parsed = JudgePendingAttemptPayload.safeParse(row.payload);
      if (!parsed.success) {
        await database.transaction(async (tx) => {
          await lockJudgeRun(tx, row.id);
          await writeJudgeReceipt(
            tx,
            judgeReceiptId('legacy-disposition', ['pending', row.id]),
            {
              actor_kind: 'system',
              actor_ref: 'judge:operational',
              subject_kind: 'durable_family',
              subject_id: 'judge_run',
              caused_by_event_id: null,
              outcome: null,
              action: 'experimental:judge_disposition',
              payload: {
                coordinate: 'legacy_task',
                version: 1,
                backend: sweep.ownership.backend,
                task_id: row.id,
                payload_digest: canonicalHash(row.payload),
                kind: 'manual',
                reason: 'invalid_receipt',
                actor_ref: 'judge:reconciler',
                decided_at: now.toISOString(),
                observed_ownership: sweep.ownership,
                evidence_refs: [row.id],
                evidence_digest: canonicalHash(row.payload),
              },
            },
            now,
          );
        });
        report.skippedTerminal++;
        continue;
      }
      const runId = parsed.data.run_id;
      const state = await readJudgeRunPermanent(database, runId);
      if (state.kind === 'resolved' || state.kind === 'manual') {
        await projectJudgeRunNotification(database, runId);
        report.skippedTerminal++;
        continue;
      }
      if (state.kind !== 'pending') {
        await disposeAndProject(database, runId, {
          reason:
            parsed.data.caller === 'submit' ? 'historical_unknown' : 'recovery_history_unknown',
          actorRef: 'judge:reconciler',
          evidenceRefs: [row.id],
          evidenceDigest: canonicalHash(row.payload),
          at: now,
        });
        report.skippedTerminal++;
        continue;
      }
      const latest = state.delivery;
      if (!latest) {
        report.skippedLive++;
        continue;
      }
      const observation = await (deps.observe ?? observeJudgeDelivery)(latest.reservation);
      if (observation.kind === 'unavailable') {
        report.skippedLive++;
        continue;
      }
      if (
        observation.kind === 'present' &&
        ['ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(observation.state)
      ) {
        await disposeAndProject(database, runId, {
          reason: 'terminal_delivery',
          actorRef: 'judge:reconciler',
          evidenceRefs: [latest.reservationId],
          evidenceDigest: canonicalHash(observation),
          at: now,
        });
        report.skippedTerminal++;
        continue;
      }
      if (
        observation.kind === 'present' &&
        (latest.kind === 'send_unknown' ||
          latest.kind === 'reserved_unsent' ||
          latest.kind === 'rejected')
      ) {
        await database.transaction(async (tx) => {
          await lockJudgeRun(tx, runId);
          await acceptJudgeDelivery(tx, latest.reservation, null, 'authoritative_lookup', now);
        });
        report.skippedLive++;
        continue;
      }
      if (observation.kind === 'present' && observation.state !== 'SUCCESS') {
        report.skippedLive++;
        continue;
      }
      if (
        (latest.kind === 'accepted' || latest.kind === 'started') &&
        observation.kind === 'absent'
      ) {
        await disposeAndProject(database, runId, {
          reason: 'recovery_history_unknown',
          actorRef: 'judge:reconciler',
          evidenceRefs: [latest.reservationId],
          evidenceDigest: canonicalHash(observation),
          at: now,
        });
        report.skippedTerminal++;
        continue;
      }
      if (report.reenqueued >= RECONCILE_SCAN_LIMIT) continue;
      const admitted = await database.transaction(async (tx) => {
        const control = await readJudgeControl(tx, 'share');
        await lockJudgeRun(tx, runId);
        const current = await readJudgeRunPermanent(tx, runId);
        if (
          control.phase !== sweep.ownership.backend ||
          control.incarnation !== sweep.ownership.incarnation ||
          control.epoch !== sweep.ownership.epoch ||
          current.kind !== 'pending' ||
          canonicalHash(current.delivery) !== canonicalHash(latest)
        )
          return null;
        const fresh = latest.kind === 'accepted' || latest.kind === 'started';
        const capacity = judgeRecoveryCapacity({
          state: current.operational,
          submittedAt: current.pending.submittedAt,
          now,
        });
        if (fresh && capacity.kind !== 'available')
          return {
            kind: 'manual' as const,
            reason:
              capacity.kind === 'manual' ? capacity.reason : ('recovery_history_unknown' as const),
          };
        // Every new authorization is gated and stops exactly at seven days, even for a same-ID resend.
        if (now.getTime() - current.pending.submittedAt.getTime() >= RECOVERY_MAX_AGE_MS)
          return { kind: 'manual' as const, reason: 'recovery_exhausted' as const };
        const token = admitJudgeRun(deps);
        const reservation =
          fresh && capacity.kind === 'available'
            ? await reserveJudgeDelivery(
                tx,
                current.pending.id,
                current.pending.payload,
                current.operational.ownership.to,
                capacity.slot,
                now,
              )
            : latest.reservation;
        const sendId = await authorizeJudgeSend(tx, reservation, now);
        return { kind: 'send' as const, reservation, sendId, token, pending: current.pending };
      });
      if (!admitted) {
        report.skippedLive++;
        continue;
      }
      if (admitted.kind === 'manual') {
        await disposeAndProject(database, runId, {
          reason: admitted.reason,
          actorRef: 'judge:reconciler',
          evidenceRefs: [row.id, latest.reservationId],
          evidenceDigest: canonicalHash(observation),
          at: now,
        });
        report.skippedExhausted++;
        continue;
      }
      if (admitted.pending.payload.caller !== 'native_assessment')
        throw new Error('Non-native dispatch authority');
      const deliveryId = await enqueueJudgeRun(
        { run_id: runId, caller: 'native_assessment', submit: admitted.pending.payload.submit },
        deps,
        {
          token: admitted.token,
          authorization: { database, reservation: admitted.reservation, sendId: admitted.sendId },
        },
      );
      await projectJudgeRunNotification(database, runId, {
        eventType: admitted.reservation.slot ? JUDGE_RUN_EVENTS.REQUEUED : JUDGE_RUN_EVENTS.QUEUED,
        payload: {
          delivery_id: deliveryId,
          attempt: admitted.reservation.slot,
          pending_event_id: row.id,
        },
      });
      report.reenqueued++;
    } catch (error) {
      report.failed++;
      console.error('[judge_pending_reconcile] retained recovery failure', row.id, error);
    }
  }
  return report;
}
export function buildJudgePendingReconcileHandler(
  database: Db,
  deps: JudgePendingReconcileDeps = {},
) {
  return async (jobs: Job[]) => {
    let report: JudgePendingReconcileReport = {
      scanned: 0,
      reenqueued: 0,
      skippedLive: 0,
      skippedTerminal: 0,
      skippedExhausted: 0,
      failed: 0,
    };
    for (const job of jobs)
      report = await reconcileStalledJudgeAttempts(database, {
        deps,
        tick: { backend: 'pg-boss', id: job.id },
      });
    return report;
  };
}

async function disposeAndProject(
  database: Db,
  runId: string,
  options: Parameters<typeof disposeJudgeRun>[2],
) {
  await disposeJudgeRun(database, runId, options);
  await projectJudgeRunNotification(database, runId);
}
