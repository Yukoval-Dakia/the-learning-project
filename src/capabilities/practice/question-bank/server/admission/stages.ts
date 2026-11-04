// Durable call receipts let a waiting admission resume without repeating blind solves.
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AgentRunError, type AgentRunErrorFields } from '@/ai/agent-run-error';
import { getTaskOverride } from '@/core/config/store';
import { canonicalHash } from '@/core/migration/canonical';
import {
  type PaidEffectIdentity,
  computePaidEffectIdentity,
} from '@/core/migration/paid-effect-protocol';
import type { Db, Tx } from '@/db/client';
import {
  markPaidEffectUnknown,
  recordPaidEffectApplication,
  recordPaidEffectResult,
  reservePaidEffect,
} from '@/db/paid-effect-store';
import { ai_task_runs, paid_effect } from '@/db/schema';
import type { BoundRunTaskTextFn } from '@/server/ai/runner-fn';

export type AdmissionStageReceiptRef = { identity: PaidEffectIdentity; receipt_digest: string };

export const AdmissionRecovery = z.object({
  reason: z.enum(['quota', 'login']),
  retry_at: z.string().datetime().nullable(),
  evidence_ref: z.string().min(1),
});
export type AdmissionRecoveryT = z.infer<typeof AdmissionRecovery>;
/** Provider adapters translate typed recovery facts here; reset time may be absent. */
export type AdmissionRecoveryReader = (error: unknown) => AdmissionRecoveryT | null;

export class AdmissionWaiting extends Error {
  constructor(
    readonly recovery: AdmissionRecoveryT,
    readonly stage: string,
  ) {
    super(
      recovery.reason === 'quota'
        ? 'Admission adjudicator quota is exhausted'
        : 'Admission adjudicator login needs renewal',
    );
  }
}

export class AdmissionNotSent extends Error {
  constructor() {
    super('Admission provider query did not start');
  }
}

export const ADMISSION_STAGE_FAMILY = 'question_admission_stage';
const FAMILY = ADMISSION_STAGE_FAMILY;
const StageReceipt = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not_sent') }),
  z.object({
    kind: z.literal('result'),
    result: z
      .object({
        text: z.string(),
        task_run_id: z.string(),
        structured_output: z.unknown().optional(),
        cost_usd: z.number().optional(),
      })
      .passthrough(),
  }),
  z.object({ kind: z.literal('waiting'), recovery: AdmissionRecovery }),
  z.object({
    kind: z.literal('failure'),
    fields: z.object({
      kind: z.string(),
      taskRunId: z.string(),
      subtype: z.string(),
      apiErrorStatus: z.number().nullable().optional(),
      errors: z.array(z.string()),
      costUsd: z.number().optional(),
    }),
  }),
]);

// Bound HTTP facts are already typed; absence of reset never invents a deadline.
// No message matching, provider probing, guessed deadline, or model substitution.
function existingRecovery(error: unknown): AdmissionRecoveryT | null {
  if (!(error instanceof AgentRunError)) return null;
  if (error.apiErrorStatus === 429)
    return { reason: 'quota', retry_at: null, evidence_ref: error.taskRunId };
  if (error.apiErrorStatus === 401 || error.apiErrorStatus === 403)
    return { reason: 'login', retry_at: null, evidence_ref: error.taskRunId };
  return null;
}

export function admissionStageRunner(input: {
  db: Db;
  groupId: string;
  baseDigest: string;
  deliveryId: string;
  execute: BoundRunTaskTextFn;
  recovery?: AdmissionRecoveryReader;
  recoveryConfirmed?: boolean;
  beforeSend?: () => Promise<void>;
  taskRunIds?: Set<string>;
  receiptRefs?: AdmissionStageReceiptRef[];
}): BoundRunTaskTextFn {
  let callIndex = 0;
  return async (kind, payload, ctx) => {
    const index = callIndex++;
    const configuration = { task: getTaskOverride(kind) ?? null, override: ctx?.override ?? null };
    const history = await input.db
      .select()
      .from(paid_effect)
      .where(
        and(
          eq(paid_effect.family, FAMILY),
          eq(paid_effect.entity_id, input.groupId),
          eq(paid_effect.entity_revision, input.baseDigest),
          sql`${paid_effect.input_json}->>'call_index' = ${String(index)}`,
        ),
      )
      .orderBy(desc(sql`(${paid_effect.input_json}->>'attempt')::int`))
      .limit(1);
    const previous = history[0];
    let attempt = 0;
    if (previous) {
      const frozen = z
        .object({
          kind: z.string(),
          payload_digest: z.string(),
          attempt: z.number().int().nonnegative(),
          configuration: z.unknown(),
          recovery_confirmation: z.string().nullable().optional(),
        })
        .parse(previous.input_json);
      if (frozen.kind !== kind || frozen.payload_digest !== canonicalHash(payload))
        throw new Error('Admission stage input drift; no new payment authorized');
      if (previous.state !== 'receipt_ready' && previous.state !== 'applied')
        throw new Error('Admission stage has unresolved paid outcome; no resend');
      const receipt = StageReceipt.parse(previous.result_json);
      input.receiptRefs?.push({
        identity: computePaidEffectIdentity({
          family: FAMILY,
          entityId: input.groupId,
          entityRevision: input.baseDigest,
          unit: previous.unit,
          input: previous.input_json,
        }),
        receipt_digest: canonicalHash(receipt),
      });
      if (receipt.kind === 'result') input.taskRunIds?.add(receipt.result.task_run_id);
      if (receipt.kind === 'failure') input.taskRunIds?.add(receipt.fields.taskRunId);
      if (previous.state === 'receipt_ready')
        await input.db.transaction((tx) =>
          recordPaidEffectApplication(
            tx,
            computePaidEffectIdentity({
              family: FAMILY,
              entityId: input.groupId,
              entityRevision: input.baseDigest,
              unit: previous.unit,
              input: previous.input_json,
            }),
            { kind: 'recorded' },
          ),
        );
      if (receipt.kind === 'result') return receipt.result;
      if (receipt.kind === 'not_sent') throw new AdmissionNotSent();
      if (receipt.kind === 'failure')
        throw new AgentRunError(receipt.fields as AgentRunErrorFields);
      const routing = (value: unknown) =>
        z
          .object({
            task: z
              .object({ provider: z.string().optional(), model: z.string().optional() })
              .nullable(),
            override: z.unknown(),
          })
          .parse(value);
      const changedConfiguration =
        canonicalHash(routing(frozen.configuration)) !== canonicalHash(routing(configuration));
      const confirmed =
        input.recoveryConfirmed && frozen.recovery_confirmation !== input.deliveryId;
      const due =
        receipt.recovery.retry_at != null && Date.parse(receipt.recovery.retry_at) <= Date.now();
      if (!due && !confirmed && !changedConfiguration)
        throw new AdmissionWaiting(receipt.recovery, previous.unit);
      attempt = frozen.attempt + 1;
    }
    try {
      await input.beforeSend?.();
    } catch {
      throw new AdmissionNotSent();
    }
    const unit = `call:${index}:attempt:${attempt}`;
    const stageInput = {
      kind,
      call_index: index,
      attempt,
      payload_digest: canonicalHash(payload),
      payload,
      configuration,
      recovery_confirmation: input.recoveryConfirmed ? input.deliveryId : null,
    };
    const reservation = await reservePaidEffect(
      input.db,
      {
        family: FAMILY,
        entityId: input.groupId,
        entityRevision: input.baseDigest,
        unit,
        input: stageInput,
      },
      {
        backend: 'pg-boss',
        deliveryId: input.deliveryId,
        generation: 0,
        leaseExpiresAt: new Date(Date.now() + 15 * 60_000),
      },
    );
    if (reservation.kind !== 'winner')
      throw new Error('Admission stage is owned or unresolved; no resend');
    let receipt: z.infer<typeof StageReceipt>;
    let queryStarted = false;
    const stageCtx = {
      ...ctx,
      beforeProviderQuery: async (started) => {
        await ctx?.beforeProviderQuery?.(started);
        queryStarted = true;
      },
    } satisfies NonNullable<Parameters<BoundRunTaskTextFn>[2]>;
    try {
      const result =
        kind === 'QuestionAdmissionSolveTask'
          ? await input.execute('QuestionAdmissionSolveTask', payload, stageCtx)
          : kind === 'QuestionAdmissionAdjudicateTask'
            ? await input.execute('QuestionAdmissionAdjudicateTask', payload, stageCtx)
            : (() => {
                throw new Error('Unknown admission stage task');
              })();
      receipt = StageReceipt.parse({ kind: 'result', result });
    } catch (error) {
      const recovery = input.recovery?.(error) ?? existingRecovery(error);
      const [run] =
        error instanceof AgentRunError
          ? await input.db.select().from(ai_task_runs).where(eq(ai_task_runs.id, error.taskRunId))
          : [];
      const knownFailure =
        error instanceof AgentRunError &&
        (error.apiErrorStatus != null ||
          (run?.finished_at != null &&
            (run.usage_json.transport?.send_state === 'not_sent' ||
              error.subtype === 'error_max_structured_output_retries')));
      if (recovery) {
        const parsed = AdmissionRecovery.parse(recovery);
        receipt = {
          kind: 'waiting',
          recovery: {
            ...parsed,
            retry_at:
              parsed.retry_at && Date.parse(parsed.retry_at) > Date.now() ? parsed.retry_at : null,
          },
        };
      } else if (knownFailure && error instanceof AgentRunError)
        receipt = {
          kind: 'failure',
          fields: {
            kind: error.kind,
            taskRunId: error.taskRunId,
            subtype: error.subtype,
            apiErrorStatus: error.apiErrorStatus,
            errors: error.errors,
            ...(error.costUsd != null ? { costUsd: error.costUsd } : {}),
          },
        };
      else if (!queryStarted) receipt = { kind: 'not_sent' };
      else {
        await input.db.transaction((tx) =>
          markPaidEffectUnknown(
            tx,
            reservation.identity,
            input.deliveryId,
            'admission_stage_outcome_unknown',
            { fence: reservation.fence },
          ),
        );
        throw error;
      }
    }
    await input.db.transaction(async (tx) => {
      await recordPaidEffectResult(tx, reservation.identity, input.deliveryId, receipt, {
        fence: reservation.fence,
      });
      await recordPaidEffectApplication(tx, reservation.identity, { kind: 'recorded' });
    });
    input.receiptRefs?.push({
      identity: reservation.identity,
      receipt_digest: canonicalHash(receipt),
    });
    if (receipt.kind === 'result') input.taskRunIds?.add(receipt.result.task_run_id);
    if (receipt.kind === 'failure') input.taskRunIds?.add(receipt.fields.taskRunId);
    if (receipt.kind === 'waiting') throw new AdmissionWaiting(receipt.recovery, unit);
    if (receipt.kind === 'not_sent') throw new AdmissionNotSent();
    if (receipt.kind === 'failure') throw new AgentRunError(receipt.fields as AgentRunErrorFields);
    return receipt.result;
  };
}

/** Learner-safe waiting facts only; task payloads and provider errors remain private. */
export async function readAdmissionWaits(db: Db | Tx, groupIds: readonly string[]) {
  if (!groupIds.length) return [];
  const rows = await db.execute<{ group_id: string; recovery: unknown }>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (entity_id, entity_revision, input_json->>'call_index')
        entity_id, entity_revision, state, result_json
      FROM paid_effect
      WHERE family = ${FAMILY} AND ${inArray(paid_effect.entity_id, [...groupIds])}
      ORDER BY entity_id, entity_revision, input_json->>'call_index', (input_json->>'attempt')::int DESC
    ) SELECT l.entity_id AS group_id, l.result_json->'recovery' AS recovery
      FROM latest l
      JOIN question_group_lifecycle q ON q.group_id = l.entity_id
      JOIN question_revision r ON r.revision_id = q.current_revision_id
      WHERE l.state IN ('receipt_ready', 'applied') AND l.result_json->>'kind' = 'waiting'
        AND r.integrity_digest = l.entity_revision
        AND EXISTS (SELECT 1 FROM paid_effect coordinator
          WHERE coordinator.family = 'question_admission_run' AND coordinator.entity_id = l.entity_id
          AND coordinator.entity_revision = l.entity_revision AND coordinator.state = 'receipt_ready'
          AND coordinator.result_json->'result'->>'status' = 'waiting')
  `);
  return rows.map((row) => {
    const recovery = AdmissionRecovery.parse(row.recovery);
    return {
      question_id: row.group_id,
      reason: recovery.reason,
      retry_at: recovery.retry_at,
      recovery_action: recovery.retry_at
        ? ('wait_for_reset' as const)
        : recovery.reason === 'login'
          ? ('reauthenticate' as const)
          : ('confirm_recovery' as const),
    };
  });
}
