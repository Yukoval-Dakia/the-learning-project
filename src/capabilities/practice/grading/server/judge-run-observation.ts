import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import {
  JUDGE_OPERATIONAL_ACTIONS,
  JudgeControl,
  JudgeOperationalEvent,
} from '@/core/schema/event/judge-operational-events';
import { JudgePendingAttemptPayload } from '@/core/schema/event/judge-pending-events';
import type { Db, Tx } from '@/db/client';
import { evaluation, event, job_events, judge_run_control } from '@/db/schema';
import {
  type JudgeWorkflowObservation,
  observeJudgeDelivery,
  observeUnmappedJudgeRun,
} from './judge-engine-client';
import {
  type JudgeDelivery,
  type JudgeOperationalState,
  type NativeJudgeDisposition,
  type SavedJudgeReceipt,
  reduceJudgeOperationalState,
} from './judge-operational-state';
import {
  NativeJudgeResolutionPayload,
  reconstructDoneFromDomainEvents,
  reconstructDoneFromNativeCompletion,
} from './judge-run-payload';
import {
  JUDGE_RUN_TABLE,
  JudgeRunStatusResponseSchema,
  JudgeRunTerminalResultSchema,
  deriveJudgeRunStatus,
  terminalJudgeRunResult,
} from './judge-run-status';

export type JudgeStatusDto = z.infer<typeof JudgeRunStatusResponseSchema>;
type PendingEvidence = {
  id: string;
  payload: z.infer<typeof JudgePendingAttemptPayload>;
  submittedAt: Date;
};
export type PermanentJudgeState =
  | { kind: 'resolved'; activity: 'terminal'; result: z.infer<typeof JudgeRunTerminalResultSchema> }
  | {
      kind: 'manual';
      activity: 'held';
      pending: PendingEvidence;
      disposition: NativeJudgeDisposition;
    }
  | {
      kind: 'pending';
      activity: 'pending';
      pending: PendingEvidence;
      operational: Extract<JudgeOperationalState, { kind: 'mapped' }>;
      delivery: JudgeDelivery | null;
    }
  | {
      kind: 'unmapped';
      activity: 'held';
      reason: 'legacy' | 'corrupt' | 'ownership_unknown';
      pending: PendingEvidence | null;
    }
  | { kind: 'absent' };

/** All permanent judge reads, including question discovery, use this selector in the caller's transaction. */
export async function loadJudgeRunEvidence(
  database: Db | Tx,
  query: { kind: 'run'; runId: string } | { kind: 'questions'; questionIds: string[] },
) {
  const pendingRows = await database
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:judge_pending_attempt'),
        query.kind === 'run'
          ? sql`${event.payload}->>'run_id' = ${query.runId}`
          : inArray(event.subject_id, query.questionIds),
      ),
    );
  const runIds =
    query.kind === 'run'
      ? [query.runId]
      : pendingRows.flatMap((r) => {
          const p = JudgePendingAttemptPayload.safeParse(r.payload);
          return p.success ? [p.data.run_id] : [];
        });
  const [control] = await database
    .select()
    .from(judge_run_control)
    .where(eq(judge_run_control.id, 1));
  const rows = runIds.length
    ? await database
        .select()
        .from(event)
        .where(
          or(
            inArray(event.id, runIds),
            and(
              inArray(event.action, JUDGE_OPERATIONAL_ACTIONS),
              sql`${event.payload}->>'run_id' in (${sql.join(
                runIds.map((id) => sql`${id}`),
                sql`,`,
              )})`,
            ),
          ),
        )
    : [];
  return { pendingRows, rows, control: JudgeControl.parse(control) };
}

async function reduceEvidence(
  database: Db | Tx,
  runId: string,
  evidence: Awaited<ReturnType<typeof loadJudgeRunEvidence>>,
): Promise<PermanentJudgeState> {
  const pendingRows = evidence.pendingRows.filter((r) => r.payload.run_id === runId);
  const row = pendingRows[0];
  const parsed = JudgePendingAttemptPayload.safeParse(row?.payload);
  const pending =
    row && parsed.success
      ? { id: row.id, payload: parsed.data, submittedAt: row.created_at }
      : null;
  const resolution = evidence.rows.find((r) => r.id === runId);
  if (resolution?.action === 'experimental:assessment_judge_resolution') {
    const p = NativeJudgeResolutionPayload.safeParse(resolution.payload);
    if (p.success && pending?.payload.caller === 'native_assessment') {
      const input = pending.payload.submit;
      const [candidate] = await database
        .select()
        .from(evaluation)
        .where(eq(evaluation.evaluation_id, p.data.assessment.candidate_id));
      if (
        resolution.actor_kind === 'agent' &&
        resolution.actor_ref === 'assessment:durable_judge_run' &&
        resolution.subject_kind === 'question' &&
        resolution.subject_id === input.question_id &&
        p.data.assessment.submission_id === input.submission_id &&
        p.data.assessment.evaluation_group_id === input.evaluation_group_id &&
        p.data.attempt_event_id === `evt_assessment_${input.submission_id}` &&
        resolution.caused_by_event_id === p.data.attempt_event_id &&
        candidate?.submission_id === input.submission_id &&
        candidate.evaluation_group_id === input.evaluation_group_id &&
        candidate.provenance?.execution_receipt &&
        z
          .object({ key: z.literal(`submission:${input.submission_id}`) })
          .safeParse(candidate.provenance.execution_receipt).success
      ) {
        if (
          p.data.status === 'effective' &&
          !(await exactActivation(database, input, candidate.evaluation_id))
        )
          return { kind: 'unmapped', activity: 'held', reason: 'corrupt', pending };
        const reconstructed = JudgeRunTerminalResultSchema.safeParse(
          await reconstructDoneFromDomainEvents(database, runId),
        );
        if (reconstructed.success)
          return { kind: 'resolved', activity: 'terminal', result: reconstructed.data };
      }
    }
    return { kind: 'unmapped', activity: 'held', reason: 'corrupt', pending };
  }
  if (resolution && ['attempt', 'review'].includes(resolution.action)) {
    const reconstructed = JudgeRunTerminalResultSchema.safeParse(
      await reconstructDoneFromDomainEvents(database, runId),
    );
    if (reconstructed.success)
      return { kind: 'resolved', activity: 'terminal', result: reconstructed.data };
  }
  if (!resolution && pending?.payload.caller === 'native_assessment') {
    const input = pending.payload.submit;
    const candidates = await database
      .select()
      .from(evaluation)
      .where(
        and(
          eq(evaluation.submission_id, input.submission_id),
          eq(evaluation.evaluation_group_id, input.evaluation_group_id),
          sql`${evaluation.provenance}->'execution_receipt'->>'key' = ${`submission:${input.submission_id}`}`,
        ),
      );
    for (const candidate of candidates) {
      if (await exactActivation(database, input, candidate.evaluation_id)) {
        const result = JudgeRunTerminalResultSchema.safeParse(
          await reconstructDoneFromNativeCompletion(
            database,
            runId,
            candidate.evaluation_id,
            `evt_assessment_${input.submission_id}`,
          ),
        );
        if (result.success) return { kind: 'resolved', activity: 'terminal', result: result.data };
      }
    }
  }
  if (pendingRows.length > 1 || (row && !pending))
    return { kind: 'unmapped', activity: 'held', reason: 'corrupt', pending };
  if (!pending)
    return evidence.rows.length
      ? { kind: 'unmapped', activity: 'held', reason: 'corrupt', pending: null }
      : { kind: 'absent' };
  const receipts: SavedJudgeReceipt[] = [];
  for (const r of evidence.rows.filter((r) => r.id !== runId)) {
    const value = JudgeOperationalEvent.safeParse(r);
    if (!value.success) return { kind: 'unmapped', activity: 'held', reason: 'corrupt', pending };
    receipts.push({ id: r.id, value: value.data, createdAt: r.created_at });
  }
  const operational = reduceJudgeOperationalState({
    runId,
    pendingId: pending.id,
    pendingDigest: canonicalHash(pending.payload),
    control: evidence.control,
    receipts,
  });
  if (operational.kind === 'disposed')
    return { kind: 'manual', activity: 'held', pending, disposition: operational.disposition };
  if (pending.payload.caller !== 'native_assessment')
    return { kind: 'unmapped', activity: 'held', reason: 'legacy', pending };
  if (operational.kind !== 'mapped')
    return {
      kind: 'unmapped',
      activity: 'held',
      reason: operational.kind === 'corrupt' ? 'corrupt' : 'ownership_unknown',
      pending,
    };
  return {
    kind: 'pending',
    activity: 'pending',
    pending,
    operational,
    delivery: operational.deliveries.at(-1) ?? null,
  };
}

async function exactActivation(
  database: Db | Tx,
  input: Extract<
    z.infer<typeof JudgePendingAttemptPayload>,
    { caller: 'native_assessment' }
  >['submit'],
  candidateId: string,
) {
  const rows = await database
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:assessment_activation'),
        eq(event.subject_id, input.evaluation_group_id),
        sql`${event.payload}->>'evaluation_id' = ${candidateId}`,
      ),
    );
  const valid = rows.some(
    (r) =>
      z
        .object({
          version: z.literal(1),
          submission_id: z.literal(input.submission_id),
          evaluation_id: z.literal(candidateId),
          effective_evaluation_id: z.literal(candidateId),
          expected_effective_id: z.literal(input.expected_head.expected_effective_id),
          generation: z.literal(input.expected_head.expected_generation + 1),
        })
        .safeParse(r.payload).success,
  );
  if (!valid) return false;
  const settlement = await database
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:assessment_settlement'),
        eq(event.subject_id, input.evaluation_group_id),
        sql`${event.payload}->>'evaluation_id' = ${candidateId}`,
      ),
    );
  return settlement.some(
    (r) =>
      r.actor_kind === 'system' &&
      r.actor_ref === 'assessment_settlement' &&
      r.subject_kind === 'evaluation_group' &&
      z
        .object({
          version: z.literal(1),
          evaluation_id: z.literal(candidateId),
          evaluation_group_id: z.literal(input.evaluation_group_id),
          submission_id: z.literal(input.submission_id),
          effect: z.enum(['applied', 'ineligible', 'failed_pending', 'idempotent_replay']),
        })
        .safeParse(r.payload).success,
  );
}

export async function readJudgeRunPermanent(
  database: Db | Tx,
  runId: string,
): Promise<PermanentJudgeState> {
  return reduceEvidence(
    database,
    runId,
    await loadJudgeRunEvidence(database, { kind: 'run', runId }),
  );
}
export async function readJudgeQuestionActivity(database: Db | Tx, questionIds: string[]) {
  const evidence = await loadJudgeRunEvidence(database, { kind: 'questions', questionIds });
  const result = new Map<string, PermanentJudgeState[]>();
  for (const row of evidence.pendingRows) {
    const p = JudgePendingAttemptPayload.safeParse(row.payload);
    const state = p.success
      ? await reduceEvidence(database, p.data.run_id, {
          ...evidence,
          rows: evidence.rows.filter(
            (r) => r.id === p.data.run_id || r.payload.run_id === p.data.run_id,
          ),
        })
      : {
          kind: 'unmapped' as const,
          activity: 'held' as const,
          reason: 'corrupt' as const,
          pending: null,
        };
    result.set(row.subject_id, [...(result.get(row.subject_id) ?? []), state]);
  }
  return result;
}

export type JudgeStatusRead =
  | { kind: 'found'; value: JudgeStatusDto }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; reason: 'domain_read' | 'observation_unavailable' };
type ObservationPort = {
  observe: typeof observeJudgeDelivery;
  observeUnmapped: typeof observeUnmappedJudgeRun;
};
function permanentDto(runId: string, state: PermanentJudgeState): JudgeStatusDto | null {
  if (state.kind === 'resolved') return { run_id: runId, status: 'done', result: state.result };
  if (state.kind === 'manual' || state.kind === 'unmapped')
    return { run_id: runId, status: 'failed', result: null };
  return null;
}
/** Engine observation occurs only after the read transaction closes. One re-read bounds races. */
export function createJudgeRunStatusReader(port: ObservationPort) {
  return async (database: Db, runId: string): Promise<JudgeStatusRead> => {
    try {
      const snapshot = () =>
        database.transaction((tx) => readJudgeRunPermanent(tx, runId), {
          isolationLevel: 'repeatable read',
          accessMode: 'read only',
        });
      const first = await snapshot();
      const terminal = permanentDto(runId, first);
      if (terminal) return { kind: 'found', value: terminal };
      const observation: JudgeWorkflowObservation =
        first.kind === 'pending' && first.delivery
          ? await port.observe(first.delivery.reservation)
          : await port.observeUnmapped(runId);
      const second = await snapshot();
      const committed = permanentDto(runId, second);
      if (committed) return { kind: 'found', value: committed };
      if (second.kind === 'pending') {
        const unchanged =
          first.kind === 'pending' &&
          canonicalHash(first.delivery) === canonicalHash(second.delivery);
        return {
          kind: 'found',
          value: {
            run_id: runId,
            status:
              second.delivery?.kind === 'started' ||
              (unchanged && observation.kind === 'present' && observation.state === 'PENDING')
                ? 'started'
                : 'queued',
            result: null,
          },
        };
      }
      // Notification replay is compatibility evidence only, after permanent authority.
      const notifications = await database
        .select({ event_type: job_events.event_type, payload: job_events.payload })
        .from(job_events)
        .where(
          and(eq(job_events.business_table, JUDGE_RUN_TABLE), eq(job_events.business_id, runId)),
        )
        .orderBy(job_events.id);
      if (notifications.length) {
        const status = deriveJudgeRunStatus(notifications);
        return {
          kind: 'found',
          value: JudgeRunStatusResponseSchema.parse({
            run_id: runId,
            status,
            result:
              status === 'done'
                ? (JudgeRunTerminalResultSchema.safeParse(terminalJudgeRunResult(notifications))
                    .data ?? null)
                : null,
          }),
        };
      }
      if (observation.kind === 'unavailable')
        return { kind: 'unavailable', reason: 'observation_unavailable' };
      return observation.kind === 'absent'
        ? { kind: 'not_found' }
        : { kind: 'found', value: { run_id: runId, status: 'queued', result: null } };
    } catch {
      return { kind: 'unavailable', reason: 'domain_read' };
    }
  };
}
export const readJudgeRunStatus = createJudgeRunStatusReader({
  observe: observeJudgeDelivery,
  observeUnmapped: observeUnmappedJudgeRun,
});
