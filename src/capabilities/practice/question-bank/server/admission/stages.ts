// Durable call receipts let a waiting admission resume without repeating blind solves.
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AgentRunError, type AgentRunErrorFields } from '@/ai/agent-run-error';
import { type HelpProviderFault, isHelpProviderFault } from '@/ai/help-provider-fault';
import { boundTerminalHttpStatus, providerTransientVerdict } from '@/ai/provider-failure';
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
import { assertModelProfileCapabilityFit } from '@/server/ai/model-profiles';
import {
  planProviderTransientRetry,
  providerTransientRetryPolicy,
  sleepMs,
} from '@/server/ai/provider-transient-retry';
import type { BoundRunTaskTextFn } from '@/server/ai/runner-fn';

export type AdmissionStageReceiptRef = { identity: PaidEffectIdentity; receipt_digest: string };

export const AdmissionRecovery = z.object({
  reason: z.enum(['quota', 'login']),
  retry_at: z.string().datetime().nullable(),
  evidence_ref: z.string().min(1),
});
export type AdmissionRecoveryT = z.infer<typeof AdmissionRecovery>;
/** Provider adapters supply typed reason/evidence; admission owns the retry clock. */
export type AdmissionRecoveryReader = (
  error: unknown,
) => Pick<AdmissionRecoveryT, 'reason' | 'evidence_ref'> | null;

export class AdmissionWaiting extends Error {
  constructor(
    readonly recovery: AdmissionRecoveryT,
    readonly stage: string,
    readonly route?: { provider: string; model: string },
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

export class AdmissionInterrupted extends Error {
  constructor(reason?: unknown) {
    super(
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : 'Admission was interrupted; no terminal question verdict',
    );
  }
}

export const ADMISSION_STAGE_FAMILY = 'question_admission_stage';
const FAMILY = ADMISSION_STAGE_FAMILY;

const ProviderFailureEvidenceSchema = z.object({
  http_status: z.number().optional(),
  retry_after_ms: z.number().optional(),
  stream_error: z.literal(true).optional(),
});

const StageErrorFields = z.object({
  kind: z.string(),
  taskRunId: z.string(),
  subtype: z.string(),
  apiErrorStatus: z.number().nullable().optional(),
  errors: z.array(z.string()),
  costUsd: z.number().optional(),
  helpProviderFault: z.custom<HelpProviderFault>(isHelpProviderFault).optional(),
  providerFailure: ProviderFailureEvidenceSchema.optional(),
});

const StageReceipt = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not_sent') }),
  z.object({ kind: z.literal('interrupted'), reason: z.string().optional() }),
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
  z.object({
    kind: z.literal('waiting'),
    recovery: AdmissionRecovery,
    quota_failures: z.number().int().nonnegative().optional(),
    inherited_login_wait: z.boolean().optional(),
    /** Set when the wait follows an exhausted in-run transient chain (429 lane). */
    transient: z.literal(true).optional(),
  }),
  z.object({
    kind: z.literal('failure'),
    fields: StageErrorFields,
  }),
  /**
   * A settled, positively-evidenced transient provider rejection. Unlike
   * `failure`, replaying it re-issues the wire send as the next attempt —
   * the caller's configured bound decides when the chain ends. `waited_ms`
   * is the retry sleep accumulated along this call's chain so a redelivery
   * cannot reopen the wait budget; `retry_not_before` pins the honour-Retry-
   * After instant so a crash mid-backoff resumes with only the remainder.
   */
  z.object({
    kind: z.literal('transient'),
    waited_ms: z.number().nonnegative().optional(),
    retry_not_before: z.string().optional(),
    fields: StageErrorFields,
  }),
]);

// Only bound HTTP facts qualify; provider message strings never grant a retry.
function existingRecovery(
  error: unknown,
  httpStatus?: number | null,
): ReturnType<AdmissionRecoveryReader> {
  if (!(error instanceof AgentRunError)) return null;
  if (error.helpProviderFault?.kind === 'quota')
    return { reason: 'quota', evidence_ref: error.taskRunId };
  if (httpStatus === 429) return { reason: 'quota', evidence_ref: error.taskRunId };
  if (httpStatus === 401) return { reason: 'login', evidence_ref: error.taskRunId };
  return null;
}

// This queue owns adjudicator calls, not credential refresh. A single worker
// process must remain the only credential-file holder at deployment time.
let adjudicationTail = Promise.resolve();
async function serializeAdjudication<T>(run: () => Promise<T>): Promise<T> {
  const previous = adjudicationTail;
  let release = () => {};
  adjudicationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await run();
  } finally {
    release();
  }
}

export async function readRouteLoginWait(db: Db | Tx, configuration: unknown) {
  const route = z
    .object({ task: z.object({ provider: z.string(), model: z.string() }).passthrough() })
    .safeParse(configuration);
  if (!route.success) return null;
  const [latest] = await db.execute<{ receipt: unknown; recorded_at: Date }>(sql`
    SELECT result_json AS receipt, result_recorded_at AS recorded_at FROM paid_effect
    WHERE family = ${FAMILY} AND state IN ('receipt_ready', 'applied')
      AND input_json->>'kind' = 'QuestionAdmissionAdjudicateTask'
      AND input_json->'configuration'->'task'->>'provider' = ${route.data.task.provider}
      AND input_json->'configuration'->'task'->>'model' = ${route.data.task.model}
      AND (result_json->>'kind' = 'result' OR (
        result_json->>'kind' = 'waiting'
        AND coalesce((result_json->>'inherited_login_wait')::boolean, false) = false))
    ORDER BY result_recorded_at DESC, created_at DESC LIMIT 1
  `);
  if (!latest) return null;
  const receipt = StageReceipt.parse(latest.receipt);
  return receipt.kind === 'waiting' && receipt.recovery.reason === 'login'
    ? { recovery: receipt.recovery, recordedAt: new Date(latest.recorded_at) }
    : null;
}

export function admissionStageRunner(input: {
  db: Db;
  groupId: string;
  baseDigest: string;
  deliveryId: string;
  execute: BoundRunTaskTextFn;
  recovery?: AdmissionRecoveryReader;
  recoveryConfirmed?: boolean;
  loginProbeRoute?: { provider: string; model: string };
  interrupted?: () => boolean;
  interruptionReason?: () => unknown;
  beforeSend?: () => Promise<void>;
  /** Wall-clock bound forwarded to the retry planner; a delay past it is not taken. */
  deadlineAt?: number;
  taskRunIds?: Set<string>;
  receiptRefs?: AdmissionStageReceiptRef[];
}): BoundRunTaskTextFn {
  const transientPolicy = providerTransientRetryPolicy();
  let callIndex = 0;
  return async (kind, payload, ctx) => {
    const index = callIndex++;
    const runStage = async () => {
      const configuration = {
        task: getTaskOverride(kind) ?? null,
        override: ctx?.override ?? null,
      };
      const loginWait =
        kind === 'QuestionAdmissionAdjudicateTask'
          ? await readRouteLoginWait(input.db, configuration)
          : null;
      const [confirmation] =
        loginWait && input.recoveryConfirmed
          ? await input.db.execute<{ confirmed: boolean }>(sql`
              SELECT created_on > ${loginWait.recordedAt.toISOString()}::timestamptz AS confirmed FROM pgboss.job
              WHERE id::text = ${input.deliveryId}
            `)
          : [];
      // A bulk recovery delivery created before a failed login probe is not a
      // fresh confirmation. Only the first probe may refresh that dead token.
      const loginProbeConfirmed = confirmation?.confirmed === true;
      const route =
        configuration.task?.provider && configuration.task.model
          ? { provider: configuration.task.provider, model: configuration.task.model }
          : undefined;
      const automaticLoginProbe =
        loginWait != null &&
        route != null &&
        canonicalHash(input.loginProbeRoute ?? null) === canonicalHash(route) &&
        Date.now() >=
          Date.parse(
            loginWait.recovery.retry_at ??
              new Date(loginWait.recordedAt.getTime() + 60 * 60_000).toISOString(),
          );
      // Retries stay on this call's `call:${index}:attempt:${n}` chain: a new
      // send never consumes a new call_index, so a replayed delivery sees one
      // settled chain instead of a second payment under a shifted index.
      for (;;) {
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
        let quotaFailures = 0;
        let priorWaitedMs = 0;
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
          const previousIdentity = computePaidEffectIdentity({
            family: FAMILY,
            entityId: input.groupId,
            entityRevision: input.baseDigest,
            unit: previous.unit,
            input: previous.input_json,
          });
          if (!input.receiptRefs?.some((ref) => ref.identity === previousIdentity))
            input.receiptRefs?.push({
              identity: previousIdentity,
              receipt_digest: canonicalHash(receipt),
            });
          if (receipt.kind === 'result') input.taskRunIds?.add(receipt.result.task_run_id);
          if (receipt.kind === 'failure' || receipt.kind === 'transient')
            input.taskRunIds?.add(receipt.fields.taskRunId);
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
          if (receipt.kind === 'interrupted') throw new AdmissionInterrupted(receipt.reason);
          if (receipt.kind === 'failure')
            throw new AgentRunError(receipt.fields as AgentRunErrorFields);
          if (receipt.kind === 'transient') {
            // The transient chain stays bounded by the same policy the caller
            // applies: beyond the retry bound the frozen failure is terminal.
            if (frozen.attempt >= transientPolicy.maxRetries)
              throw new AgentRunError(receipt.fields as AgentRunErrorFields);
            attempt = frozen.attempt + 1;
            priorWaitedMs = receipt.waited_ms ?? 0;
            if (receipt.retry_not_before != null) {
              // Honour the recorded retry instant once — in-process loops land
              // here too, so the single sleep site serves every delivery.
              const remaining = Date.parse(receipt.retry_not_before) - Date.now();
              if (remaining > 0) await sleepMs(Math.min(remaining, transientPolicy.maxWaitMs));
            }
          } else {
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
              canonicalHash(routing(frozen.configuration)) !==
              canonicalHash(routing(configuration));
            if (!changedConfiguration && receipt.recovery.reason === 'quota')
              quotaFailures = receipt.quota_failures ?? frozen.attempt + 1;
            const confirmed =
              input.recoveryConfirmed &&
              frozen.recovery_confirmation !== input.deliveryId &&
              (receipt.recovery.reason !== 'login' || !loginWait || loginProbeConfirmed);
            const due =
              receipt.recovery.reason === 'quota' &&
              receipt.recovery.retry_at != null &&
              Date.parse(receipt.recovery.retry_at) <= Date.now();
            const loginRecovered = receipt.recovery.reason === 'login' && loginWait == null;
            if (
              !due &&
              !confirmed &&
              !changedConfiguration &&
              !loginRecovered &&
              !automaticLoginProbe
            )
              throw new AdmissionWaiting(receipt.recovery, previous.unit, route);
            attempt = frozen.attempt + 1;
          }
        }
        // Purpose/control guards and aborts retain their original identity.
        await input.beforeSend?.();
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
        const hasImages =
          payload != null &&
          typeof payload === 'object' &&
          'images' in payload &&
          Array.isArray(payload.images) &&
          payload.images.length > 0;
        const stageCtx = {
          ...ctx,
          beforeProviderQuery: async (started) => {
            await ctx?.beforeProviderQuery?.(started);
            // Text-only runs keep their configured cheap lane. Image-bearing runs
            // require vision on the actual resolved route before query() is called.
            if (hasImages)
              assertModelProfileCapabilityFit(
                { kind, needsToolCall: true, isMultimodal: true },
                started.provider,
                started.model,
              );
            queryStarted = true;
          },
        } satisfies NonNullable<Parameters<BoundRunTaskTextFn>[2]>;
        if (loginWait && !loginProbeConfirmed && !automaticLoginProbe) {
          receipt = {
            kind: 'waiting',
            recovery: loginWait.recovery,
            inherited_login_wait: true,
          };
        } else
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
            const [run] =
              error instanceof AgentRunError
                ? await input.db
                    .select()
                    .from(ai_task_runs)
                    .where(eq(ai_task_runs.id, error.taskRunId))
                : [];
            const httpStatus =
              error instanceof AgentRunError && run?.finished_at != null
                ? boundTerminalHttpStatus(error, run.usage_json.transport)
                : null;
            const verdict =
              error instanceof AgentRunError && run?.finished_at != null
                ? providerTransientVerdict({ error, transport: run.usage_json.transport })
                : undefined;
            // `attempt` is this send's index in the chain — retries consumed so
            // far. The planner is the one bound owner: a granted plan defers the
            // scheduled quota wait; exhaustion (or no verdict) lets recovery
            // proceed so a recoverable quota failure never hardens into a
            // terminal stage error.
            const plan =
              verdict !== undefined && error instanceof AgentRunError
                ? await planProviderTransientRetry({
                    db: input.db,
                    error,
                    policy: transientPolicy,
                    budget: { retries: attempt, waitedMs: priorWaitedMs },
                    ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
                  })
                : undefined;
            const recovery =
              (kind === 'QuestionAdmissionAdjudicateTask' ? input.recovery?.(error) : undefined) ??
              existingRecovery(error, httpStatus);
            const knownFailure =
              error instanceof AgentRunError &&
              run?.finished_at != null &&
              (httpStatus != null ||
                run.usage_json.transport?.send_state === 'not_sent' ||
                error.subtype === 'error_max_structured_output_retries' ||
                error.helpProviderFault?.kind === 'parse' ||
                error.helpProviderFault?.kind === 'bad_gateway');
            if (recovery && !input.interrupted?.() && plan === undefined) {
              const parsed = AdmissionRecovery.pick({ reason: true, evidence_ref: true }).parse(
                recovery,
              );
              quotaFailures = parsed.reason === 'quota' ? quotaFailures + 1 : 0;
              const minutes = [5, 15, 30][quotaFailures - 1] ?? 60;
              receipt = {
                kind: 'waiting',
                quota_failures: quotaFailures,
                ...(verdict !== undefined ? { transient: true } : {}),
                recovery: {
                  ...parsed,
                  retry_at:
                    parsed.reason === 'quota'
                      ? new Date(Date.now() + minutes * 60_000).toISOString()
                      : new Date(Date.now() + 60 * 60_000).toISOString(),
                },
              };
            } else if (plan !== undefined && error instanceof AgentRunError) {
              receipt = {
                kind: 'transient',
                waited_ms: priorWaitedMs + plan.delayMs,
                retry_not_before: new Date(Date.now() + plan.delayMs).toISOString(),
                fields: {
                  kind: error.kind,
                  taskRunId: error.taskRunId,
                  subtype: error.subtype,
                  ...(error.apiErrorStatus !== undefined
                    ? { apiErrorStatus: error.apiErrorStatus }
                    : {}),
                  errors: error.errors,
                  ...(error.costUsd != null ? { costUsd: error.costUsd } : {}),
                  ...(error.helpProviderFault
                    ? { helpProviderFault: error.helpProviderFault }
                    : {}),
                  ...(error.providerFailure ? { providerFailure: error.providerFailure } : {}),
                },
              };
            } else if (knownFailure && error instanceof AgentRunError)
              receipt = {
                kind: 'failure',
                fields: {
                  kind: error.kind,
                  taskRunId: error.taskRunId,
                  subtype: error.subtype,
                  ...(error.apiErrorStatus !== undefined
                    ? { apiErrorStatus: error.apiErrorStatus }
                    : {}),
                  errors: error.errors,
                  ...(error.costUsd != null ? { costUsd: error.costUsd } : {}),
                  ...(error.helpProviderFault
                    ? { helpProviderFault: error.helpProviderFault }
                    : {}),
                  ...(error.providerFailure ? { providerFailure: error.providerFailure } : {}),
                },
              };
            else if (
              !queryStarted ||
              (input.interrupted?.() && run?.usage_json.transport?.send_state === 'not_sent')
            )
              receipt = input.interrupted?.()
                ? {
                    kind: 'interrupted',
                    reason: new AdmissionInterrupted(input.interruptionReason?.()).message,
                  }
                : { kind: 'not_sent' };
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
        if (!input.receiptRefs?.some((ref) => ref.identity === reservation.identity))
          input.receiptRefs?.push({
            identity: reservation.identity,
            receipt_digest: canonicalHash(receipt),
          });
        if (receipt.kind === 'result') input.taskRunIds?.add(receipt.result.task_run_id);
        if (receipt.kind === 'failure' || receipt.kind === 'transient')
          input.taskRunIds?.add(receipt.fields.taskRunId);
        if (input.interrupted?.() || receipt.kind === 'interrupted')
          throw new AdmissionInterrupted(
            input.interruptionReason?.() ??
              (receipt.kind === 'interrupted' ? receipt.reason : undefined),
          );
        if (receipt.kind === 'waiting') throw new AdmissionWaiting(receipt.recovery, unit, route);
        if (receipt.kind === 'not_sent') throw new AdmissionNotSent();
        if (receipt.kind === 'failure')
          throw new AgentRunError(receipt.fields as AgentRunErrorFields);
        // Transient chains loop back through the history read, which owns the
        // retry_not_before sleep — one wait site for fresh and replayed sends.
        if (receipt.kind === 'transient') continue;
        return receipt.result;
      }
    };
    return kind === 'QuestionAdmissionAdjudicateTask'
      ? serializeAdjudication(runStage)
      : runStage();
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
      recovery_action:
        recovery.reason === 'login'
          ? ('reauthenticate' as const)
          : recovery.retry_at
            ? ('wait_for_retry' as const)
            : ('confirm_recovery' as const),
    };
  });
}
