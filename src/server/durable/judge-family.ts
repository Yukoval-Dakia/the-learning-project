import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  type JudgeEngineInventoryT,
  judgeLegacyJobId,
  readPermanentJudgeRun,
  recordJudgeOperationalReceipt,
  reserveJudgeOperationalDelivery,
  sealJudgeEngineInventory,
  validateJudgeEngineInventory,
} from '@/capabilities/practice/public';
import { canonicalHash } from '@/core/migration/canonical';
import { ModelUnitOutcome } from '@/core/schema/assessment';
import {
  JudgeControl,
  JudgeOperationalEvent,
  type JudgeOwner,
  JudgeOwnership,
  type JudgePhase,
} from '@/core/schema/event/judge-operational-events';
import { JudgePendingAttemptPayload } from '@/core/schema/event/judge-pending-events';
import type { Db, Tx } from '@/db/client';
import { event, judge_run_control } from '@/db/schema';
import { lockProducerFenceInstaller } from './producer-fence-lock';

export const JUDGE_FAMILY = 'judge_run';
export const JUDGE_RECONCILE_FAMILY = 'judge_pending_reconcile';
const familyEnvelope = {
  actor_kind: 'system' as const,
  actor_ref: 'judge:operational' as const,
  subject_kind: 'durable_family' as const,
  subject_id: 'judge_run' as const,
  caused_by_event_id: null,
  outcome: null,
  task_run_id: null,
  cost_micro_usd: null,
};
const receiptId = (kind: string, parts: readonly unknown[]) =>
  `evt_judge_${kind}_${canonicalHash(parts)}`;
export async function installJudgeProducerFence(database: Db) {
  await database.transaction(async (tx) => {
    await lockProducerFenceInstaller(tx);
    await tx.execute(sql`select pg_advisory_xact_lock(1356,1)`);
    for (const relation of ['job', 'schedule']) {
      await tx.execute(
        sql.raw(`DROP TRIGGER IF EXISTS yuk1356_judge_producer ON pgboss.${relation}`),
      );
      await tx.execute(
        sql.raw(
          `CREATE TRIGGER yuk1356_judge_producer BEFORE INSERT OR UPDATE OF name ON pgboss.${relation} FOR EACH ROW EXECUTE FUNCTION fence_judge_producer()`,
        ),
      );
    }
  });
}
export async function readJudgeFamilyControl(database: Db | Tx) {
  const [row] = await database.select().from(judge_run_control).where(eq(judge_run_control.id, 1));
  return JudgeControl.parse(row);
}
const obligation = z.object({
  task_id: z.string(),
  state: z.string(),
  kind: z.enum(['job', 'tick', 'dlq', 'forwarder', 'schedule', 'pending', 'model_claim']),
  payload_digest: z.string(),
  run_id: z.string().nullable(),
});
export type JudgeObligation = z.infer<typeof obligation>;
/** Inventory includes terminal jobs, DLQs, accepted ticks, forwarding ambiguity, originals and unresolved paid claims. */
export async function inspectLegacyJudgeObligations(database: Db | Tx): Promise<JudgeObligation[]> {
  const rows = await database.execute(sql`select id::text as task_id,state::text as state,
    case when name like '%_dlq' then 'dlq' when name='judge_pending_reconcile' then 'tick' else 'job' end as kind,
    data as payload from pgboss.job where name in ('judge_run','judge_run_dlq','judge_pending_reconcile','judge_pending_reconcile_dlq')
    union all select id::text,state::text,'forwarder',data from pgboss.job where name='__pgboss__send-it' and state<>'completed'
      and (jsonb_typeof(data) is distinct from 'object' or jsonb_typeof(data->'name') is distinct from 'string' or
        data->>'name' in ('','judge_run','judge_pending_reconcile'))
    union all select name,'registered','schedule',to_jsonb(s) from pgboss.schedule s where name in ('judge_run','judge_pending_reconcile')
    union all select id,'pending','pending',payload from event where action='experimental:judge_pending_attempt'
    union all select c.id,'unknown','model_claim',c.payload from event c where c.action='experimental:assessment_model_claim'
      and exists(select 1 from event p where p.action='experimental:judge_pending_attempt' and p.payload->>'caller'='native_assessment'
        and p.payload->'submit'->>'submission_id'=c.payload->>'submission_id')
      and not exists(select 1 from event r where r.id=replace(c.id,'evt_model_claim_','evt_model_result_')
        and r.action='experimental:assessment_model_result' and r.caused_by_event_id=c.id and r.payload->>'input_digest'=c.payload->>'input_digest')`);
  return rows.map((row) =>
    obligation.parse({
      ...row,
      payload_digest: canonicalHash(row.payload),
      run_id: z.object({ run_id: z.string() }).safeParse(row.payload).data?.run_id ?? null,
    }),
  );
}
export async function disposeLegacyJudgeObligation(
  database: Db,
  input: {
    obligation: JudgeObligation;
    owner: JudgeOwner;
    actorRef: string;
    evidenceRefs: string[];
    backend?: 'pg-boss' | 'dbos';
    reason: 'historical_unknown' | 'explicit_disposal' | 'provider_unknown';
  },
) {
  await database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.obligation.task_id}))`);
    const control = await readJudgeFamilyControl(tx);
    if (control.incarnation !== input.owner.incarnation)
      throw new Error('Legacy disposition incarnation mismatch');
    const payload = {
      coordinate: 'legacy_task' as const,
      version: 1 as const,
      backend: input.backend ?? 'pg-boss',
      task_id: input.obligation.task_id,
      payload_digest: input.obligation.payload_digest,
      kind: 'manual' as const,
      reason: input.reason,
      actor_ref: input.actorRef,
      decided_at: new Date().toISOString(),
      observed_ownership: input.owner,
      evidence_refs: input.evidenceRefs,
      evidence_digest: canonicalHash(input.obligation),
    };
    const id = receiptId('legacy-disposition', [
      input.backend ?? 'pg-boss',
      input.obligation.task_id,
      input.obligation.payload_digest,
    ]);
    const [prior] = await tx.select().from(event).where(eq(event.id, id));
    if (prior) {
      const parsed = JudgeOperationalEvent.parse(prior);
      if (
        parsed.action !== 'experimental:judge_disposition' ||
        parsed.payload.coordinate !== 'legacy_task' ||
        parsed.payload.payload_digest !== input.obligation.payload_digest
      )
        throw new Error('Legacy disposition replay conflict');
      payload.decided_at = parsed.payload.decided_at;
    }
    await recordJudgeOperationalReceipt(tx, id, {
      ...familyEnvelope,
      action: 'experimental:judge_disposition',
      payload,
    });
  });
}
/** Parent supplies sealed quiescence and engine inventory. This function never contacts an engine inside Tx. */
export async function transitionJudgeFamily(
  database: Db,
  input: {
    expectedEpoch: number;
    nextPhase: z.infer<typeof JudgePhase>;
    actorRef: string;
    evidenceRefs: string[];
    evidenceDigest: string;
    engineInventory: JudgeEngineInventoryT;
  },
) {
  return database.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(judge_run_control)
      .where(eq(judge_run_control.id, 1))
      .for('update');
    const control = JudgeControl.parse(row);
    if (control.epoch !== input.expectedEpoch) throw new Error('Judge transition epoch conflict');
    const allowed =
      control.phase === 'pg-boss'
        ? 'draining-pg-boss'
        : control.phase === 'dbos'
          ? 'draining-dbos'
          : control.phase === 'draining-pg-boss'
            ? 'dbos'
            : 'pg-boss';
    if (input.nextPhase !== allowed)
      throw new Error('Judge phase transitions require an ordered drain');
    const finishing = control.phase.startsWith('draining-');
    if (finishing) {
      const inventory = validateJudgeEngineInventory(input.engineInventory);
      if (
        !input.evidenceRefs.length ||
        inventory.backend !== (control.phase === 'draining-pg-boss' ? 'pg-boss' : 'dbos') ||
        Date.now() - Date.parse(inventory.observed_at) > 60_000 ||
        Date.parse(inventory.observed_at) > Date.now() + 1000
      )
        throw new Error('Judge transition requires fresh sealed source census and quiescence');
      const live = inventory.items.filter((i) =>
        [
          'created',
          'retry',
          'active',
          'PENDING',
          'ENQUEUED',
          'DELAYED',
          'ACTIVE',
          'registered',
        ].includes(i.state),
      );
      if (live.length)
        throw new Error(
          `Executable source judge obligations: ${live.map((i) => i.task_id).join(',')}`,
        );
      if (control.phase === 'draining-pg-boss') {
        const actual = await inspectLegacyJudgeObligations(tx);
        const engine = actual.filter((i) => !['pending', 'model_claim'].includes(i.kind));
        const supplied = inventory.items.map((i) => ({
          task_id: i.task_id,
          kind: i.kind,
          state: i.state,
          payload_digest: i.payload_digest,
          run_id: i.run_id,
        }));
        if (
          canonicalHash(engine.sort((a, b) => a.task_id.localeCompare(b.task_id))) !==
          canonicalHash(supplied.sort((a, b) => a.task_id.localeCompare(b.task_id)))
        )
          throw new Error('Legacy judge census changed at transition');
      }
      const allPending = await tx
        .select()
        .from(event)
        .where(eq(event.action, 'experimental:judge_pending_attempt'));
      for (const pending of allPending) {
        const p = JudgePendingAttemptPayload.safeParse(pending.payload);
        const state = p.success ? await readPermanentJudgeRun(tx, p.data.run_id) : null;
        if (state?.kind === 'resolved' || state?.kind === 'manual') continue;
        const mappings = await tx
          .select()
          .from(event)
          .where(
            and(
              eq(event.action, 'experimental:judge_ownership'),
              sql`${event.payload}->>'pending_id' = ${pending.id}`,
            ),
          );
        const mapped = mappings.some((r) => {
          const m = JudgeOperationalEvent.safeParse(r);
          return (
            m.success &&
            m.data.action === 'experimental:judge_ownership' &&
            m.data.payload.coordinate === 'native' &&
            m.data.payload.pending_digest === canonicalHash(p.data) &&
            m.data.payload.to.incarnation === control.incarnation &&
            m.data.payload.to.epoch === control.epoch + 1 &&
            m.data.payload.to.backend === input.nextPhase
          );
        });
        const dispositions = await tx
          .select()
          .from(event)
          .where(
            and(
              eq(event.action, 'experimental:judge_disposition'),
              sql`${event.payload}->>'task_id' = ${pending.id}`,
            ),
          );
        if (
          !mapped &&
          !dispositions.some((r) => {
            const d = JudgeOperationalEvent.safeParse(r);
            return (
              d.success &&
              d.data.action === 'experimental:judge_disposition' &&
              d.data.payload.coordinate === 'legacy_task' &&
              d.data.payload.payload_digest === canonicalHash(pending.payload)
            );
          })
        )
          throw new Error(`Unmapped pending judge original ${pending.id}`);
      }
      if (control.phase === 'draining-dbos') {
        for (const task of inventory.items) {
          if (task.state === 'SUCCESS' || (task.kind === 'schedule' && task.state === 'PAUSED'))
            continue;
          const receipts = await tx
            .select()
            .from(event)
            .where(
              and(
                eq(event.action, 'experimental:judge_disposition'),
                sql`${event.payload}->>'task_id' = ${task.task_id}`,
              ),
            );
          if (
            !receipts.some((r) => {
              const d = JudgeOperationalEvent.safeParse(r);
              return (
                d.success &&
                d.data.action === 'experimental:judge_disposition' &&
                d.data.payload.coordinate === 'legacy_task' &&
                d.data.payload.backend === 'dbos' &&
                d.data.payload.payload_digest === task.payload_digest
              );
            })
          )
            throw new Error(`Unresolved terminal DBOS judge obligation ${task.task_id}`);
        }
      }
      if (control.phase === 'draining-pg-boss') {
        const obligations = await inspectLegacyJudgeObligations(tx);
        const receipts = await tx
          .select()
          .from(event)
          .where(eq(event.action, 'experimental:judge_disposition'));
        for (const task of obligations) {
          if (task.kind === 'job' && task.state === 'completed' && task.run_id) {
            const state = await readPermanentJudgeRun(tx, task.run_id);
            if (state.kind === 'resolved' || state.kind === 'manual') continue;
            const maps = await tx
              .select()
              .from(event)
              .where(
                and(
                  eq(event.action, 'experimental:judge_ownership'),
                  sql`${event.payload}->>'run_id' = ${task.run_id}`,
                ),
              );
            if (
              maps.some((r) => {
                const m = JudgeOperationalEvent.safeParse(r);
                return (
                  m.success &&
                  m.data.action === 'experimental:judge_ownership' &&
                  m.data.payload.coordinate === 'native' &&
                  m.data.payload.to.epoch === control.epoch + 1 &&
                  m.data.payload.to.incarnation === control.incarnation &&
                  m.data.payload.to.backend === 'dbos'
                );
              })
            )
              continue;
          }
          if (
            task.kind === 'schedule' ||
            (['job', 'tick', 'forwarder'].includes(task.kind) &&
              ['created', 'retry', 'active'].includes(task.state))
          )
            throw new Error(`Executable legacy judge obligation ${task.task_id}`);
          if (task.kind === 'pending') {
            const [pending] = await tx.select().from(event).where(eq(event.id, task.task_id));
            const p = JudgePendingAttemptPayload.safeParse(pending?.payload);
            if (p.success) {
              const state = await readPermanentJudgeRun(tx, p.data.run_id);
              if (state.kind === 'resolved' || state.kind === 'manual') continue;
              // Approved imports must explicitly map to the next ownership epoch.
              const mappings = await tx
                .select()
                .from(event)
                .where(
                  and(
                    eq(event.action, 'experimental:judge_ownership'),
                    sql`${event.payload}->>'run_id' = ${p.data.run_id}`,
                  ),
                );
              if (
                mappings.some((r) => {
                  const m = JudgeOperationalEvent.safeParse(r);
                  return (
                    m.success &&
                    m.data.action === 'experimental:judge_ownership' &&
                    m.data.payload.coordinate === 'native' &&
                    m.data.payload.to.incarnation === control.incarnation &&
                    m.data.payload.to.epoch === control.epoch + 1 &&
                    m.data.payload.to.backend === 'dbos'
                  );
                })
              )
                continue;
            }
          }
          const disposed = receipts.some((r) => {
            const parsed = JudgeOperationalEvent.safeParse(r);
            return (
              parsed.success &&
              parsed.data.action === 'experimental:judge_disposition' &&
              parsed.data.payload.coordinate === 'legacy_task' &&
              parsed.data.payload.backend === 'pg-boss' &&
              parsed.data.payload.task_id === task.task_id &&
              parsed.data.payload.payload_digest === task.payload_digest
            );
          });
          if (!disposed) throw new Error(`Unmapped legacy judge obligation ${task.task_id}`);
        }
      }
    }
    const epoch = control.epoch + 1,
      id = receiptId('transition', [control.incarnation, epoch]),
      now = new Date();
    await recordJudgeOperationalReceipt(
      tx,
      id,
      {
        ...familyEnvelope,
        action: 'experimental:judge_family_transition',
        payload: {
          version: 1,
          incarnation: control.incarnation,
          prior_phase: control.phase,
          next_phase: input.nextPhase,
          prior_epoch: control.epoch,
          next_epoch: epoch,
          actor_ref: input.actorRef,
          evidence_refs: input.evidenceRefs,
          evidence_digest: input.evidenceDigest,
          recorded_at: now.toISOString(),
        },
      },
      now,
    );
    const updated = await tx
      .update(judge_run_control)
      .set({ epoch, phase: input.nextPhase, phase_changed_at: now, transition_event_id: id })
      .where(and(eq(judge_run_control.id, 1), eq(judge_run_control.epoch, control.epoch)))
      .returning();
    if (updated.length !== 1) throw new Error('Judge transition lost ownership');
    return JudgeControl.parse(updated[0]);
  });
}
/** Import only an explicitly proven cohort. Archive receipts alone cannot select this incarnation. */
export async function mapJudgePendingOwnership(
  database: Db,
  input: {
    runId: string;
    target: JudgeOwner;
    recoveryHistory: 'unknown' | string[];
    sourceDigest: string;
    evidenceRefs: string[];
    engineInventory: JudgeEngineInventoryT;
  },
) {
  await database.transaction(async (tx) => {
    const [controlRow] = await tx
      .select()
      .from(judge_run_control)
      .where(eq(judge_run_control.id, 1))
      .for('share');
    const control = JudgeControl.parse(controlRow),
      target = JudgeOwnership.parse(input.target);
    if (
      !control.phase.startsWith('draining-') ||
      target.incarnation !== control.incarnation ||
      target.epoch !== control.epoch + 1 ||
      target.backend !== (control.phase === 'draining-pg-boss' ? 'dbos' : 'pg-boss')
    )
      throw new Error('Judge import target requires the next drained epoch');
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.runId}))`);
    const [pending] = await tx
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:judge_pending_attempt'),
          sql`${event.payload}->>'run_id' = ${input.runId}`,
        ),
      );
    const p = JudgePendingAttemptPayload.parse(pending?.payload);
    if (!pending || p.caller !== 'native_assessment')
      throw new Error('Only frozen native originals may obtain execution ownership');
    const mappingId = receiptId('owner', [input.runId, target.incarnation, target.epoch]);
    const [mapped] = await tx.select().from(event).where(eq(event.id, mappingId));
    if (mapped) {
      const saved = JudgeOperationalEvent.parse(mapped);
      if (
        saved.action !== 'experimental:judge_ownership' ||
        saved.payload.coordinate !== 'native' ||
        saved.payload.run_id !== input.runId ||
        saved.payload.pending_id !== pending.id ||
        saved.payload.submitted_at !== p.submit.submitted_at ||
        canonicalHash(saved.payload.to) !== canonicalHash(target) ||
        saved.payload.pending_digest !== canonicalHash(p) ||
        saved.payload.source_digest !== input.sourceDigest ||
        saved.payload.recovery_history.kind !== 'known' ||
        canonicalHash(saved.payload.recovery_history.accepted_recovery_ids) !==
          canonicalHash(input.recoveryHistory) ||
        canonicalHash(saved.payload.evidence_refs) !== canonicalHash(input.evidenceRefs)
      )
        throw new Error('Import replay identity conflict');
      return;
    }
    const prior = await readPermanentJudgeRun(tx, input.runId);
    if (prior.kind === 'resolved' || prior.kind === 'manual')
      throw new Error('Terminal judge run cannot transfer execution');
    const source = await inspectJudgePendingImport(tx, input.runId);
    const inventory = validateJudgeEngineInventory(input.engineInventory);
    if (
      source.digest !== input.sourceDigest ||
      !input.evidenceRefs.length ||
      Date.now() - Date.parse(inventory.observed_at) > 60_000 ||
      Date.parse(inventory.observed_at) > Date.now() + 1000 ||
      inventory.backend !== (control.phase === 'draining-pg-boss' ? 'pg-boss' : 'dbos')
    )
      throw new Error('Import source seal or engine ownership mismatch');
    if (
      input.recoveryHistory === 'unknown' ||
      new Set(input.recoveryHistory).size !== input.recoveryHistory.length ||
      input.recoveryHistory.length >= 2 ||
      Date.now() - Date.parse(p.submit.submitted_at) >= 7 * 86400_000
    )
      throw new Error('Unknown or exhausted import budget requires manual disposition');
    if (
      inventory.items.some(
        (i) => i.run_id === input.runId && !['completed', 'SUCCESS'].includes(i.state),
      )
    )
      throw new Error('Only quiesced, nonterminal native gaps can transfer');
    const unresolved = source.rows
      .filter((r) => r.action === 'experimental:assessment_model_claim')
      .some(
        (c) =>
          !source.rows.some(
            (r) =>
              r.id === c.id.replace('evt_model_claim_', 'evt_model_result_') &&
              r.caused_by_event_id === c.id &&
              r.payload.input_digest === c.payload.input_digest &&
              ModelUnitOutcome.safeParse(r.payload.outcome).success &&
              ModelUnitOutcome.safeParse(r.payload.outcome).data?.kind === 'scored',
          ),
      );
    const hasClaims = source.rows.some((r) => r.action === 'experimental:assessment_model_claim');
    if (unresolved || (hasClaims && !(prior.kind === 'pending' && prior.operational.binding)))
      throw new Error('Unbound or unknown model claims require manual disposition');
    const deliveries = prior.kind === 'pending' ? prior.operational.deliveries : [];
    if (deliveries.some((d) => d.kind === 'send_unknown'))
      throw new Error('Unknown delivery cannot transfer');
    const acceptedRecovery = deliveries
      .filter((d) => d.reservation.slot > 0 && (d.kind === 'accepted' || d.kind === 'started'))
      .map((d) => d.reservation.delivery_id);
    if (prior.kind === 'pending') {
      const history = prior.operational.ownership.recovery_history;
      if (history.kind !== 'known') throw new Error('Unknown retained history cannot transfer');
      acceptedRecovery.push(...history.accepted_recovery_ids);
    }
    for (const item of inventory.items.filter((i) => i.run_id === input.runId)) {
      if ([1, 2].some((slot) => item.task_id === judgeLegacyJobId(input.runId, slot)))
        acceptedRecovery.push(item.task_id);
    }
    for (const delivery of deliveries) {
      if (delivery.kind !== 'accepted' && delivery.kind !== 'started') continue;
      if (
        !inventory.items.some(
          (i) =>
            i.task_id === delivery.reservation.delivery_id &&
            i.run_id === input.runId &&
            ['completed', 'SUCCESS'].includes(i.state),
        )
      )
        throw new Error('Accepted delivery has unavailable or pruned source engine evidence');
    }
    if (acceptedRecovery.some((id) => !input.recoveryHistory.includes(id)))
      throw new Error('Imported recovery history omits accepted delivery');
    const from = prior.kind === 'pending' ? prior.operational.ownership.to : null;
    const slot = deliveries.length
      ? Math.max(input.recoveryHistory.length + 1, ...deliveries.map((d) => d.reservation.slot + 1))
      : input.recoveryHistory.length
        ? input.recoveryHistory.length + 1
        : 0;
    if (slot > 2) throw new Error('No unoccupied delivery slot remains for transfer');
    const reservation = await reserveJudgeOperationalDelivery(
      tx,
      pending.id,
      p,
      target,
      slot,
      new Date(),
    );
    await recordJudgeOperationalReceipt(
      tx,
      receiptId('owner', [input.runId, target.incarnation, target.epoch]),
      {
        actor_kind: 'system',
        actor_ref: 'judge:operational',
        subject_kind: 'event',
        subject_id: pending.id,
        caused_by_event_id: pending.id,
        outcome: null,
        action: 'experimental:judge_ownership',
        payload: {
          coordinate: 'native',
          version: 1,
          run_id: input.runId,
          pending_id: pending.id,
          pending_digest: canonicalHash(p),
          from,
          to: target,
          submitted_at: p.submit.submitted_at,
          source_digest: input.sourceDigest,
          mapped_deliveries: [{ slot, delivery_id: reservation.delivery_id }],
          recovery_history: { kind: 'known', accepted_recovery_ids: input.recoveryHistory },
          evidence_refs: input.evidenceRefs,
        },
      },
    );
  });
}

export async function inspectLegacyJudgeInventory(
  database: Db | Tx,
): Promise<JudgeEngineInventoryT> {
  const obligations = await inspectLegacyJudgeObligations(database);
  return sealJudgeEngineInventory(
    'pg-boss',
    obligations.flatMap((i) =>
      i.kind === 'pending' || i.kind === 'model_claim' ? [] : [{ ...i, kind: i.kind }],
    ),
  );
}
export async function inspectJudgePendingImport(database: Db | Tx, runId: string) {
  const pending = await database
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:judge_pending_attempt'),
        sql`${event.payload}->>'run_id' = ${runId}`,
      ),
    );
  if (pending.length !== 1) throw new Error('Import requires one immutable pending original');
  const p = JudgePendingAttemptPayload.parse(pending[0]?.payload);
  if (p.caller !== 'native_assessment') throw new Error('Import requires native input');
  const rows = await database
    .select()
    .from(event)
    .where(sql`${event.payload}->>'run_id' = ${runId} or
    (${event.action} in ('experimental:assessment_model_claim','experimental:assessment_model_result') and
     ${event.payload}->>'submission_id' = ${p.submit.submission_id})`)
    .orderBy(event.id);
  return {
    pending: pending[0],
    payload: p,
    rows,
    digest: canonicalHash({ pending: pending[0], rows }),
  };
}
