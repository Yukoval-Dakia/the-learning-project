import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql } from 'drizzle-orm';
import {
  type PaidEffectIdentity,
  computePaidEffectIdentity,
} from '@/core/migration/paid-effect-protocol';
import {
  LEGACY_DRAFT_STATUS,
  SCORING_ADMISSION_STATE,
  SCORING_ADMISSION_WITHHELD_REASON,
  SUSPENSION_REASON,
} from '@/core/schema/assessment/lifecycle';
import type { DifficultyEvidenceT } from '@/core/schema/difficulty-evidence';
import { toUnifiedVerifyResult } from '@/core/schema/verify-contract';
import type { Db, Tx } from '@/db/client';
import { admitPaidEffectIntent, claimPaidEffectSend } from '@/db/paid-effect-store';
import { event, paid_effect, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events/index';
import type { SupplyTraceV1T } from '@/kernel/supply-contracts';
import { publishVerifyLifecycleUpdate } from './source_verify_lifecycle';

export type SourceVerifyRecheckClaim = {
  identity: PaidEffectIdentity;
  fence: number;
  deliveryId: string;
};

export type SourceVerifyRecheckClaimOutcome =
  | { kind: 'claimed'; identity: PaidEffectIdentity; fence: number }
  | { kind: 'held'; state: string };

export async function claimSourceVerifyRecheck(input: {
  db: Db;
  questionId: string;
  commandEventId: string;
  deliveryId: string;
}): Promise<SourceVerifyRecheckClaimOutcome> {
  return input.db.transaction(async (tx) => {
    const priorRows = await tx
      .select({
        state: paid_effect.state,
        input_json: paid_effect.input_json,
        result_json: paid_effect.result_json,
      })
      .from(paid_effect)
      .where(
        and(
          eq(paid_effect.family, 'source_verify'),
          eq(paid_effect.entity_id, input.questionId),
          eq(paid_effect.entity_revision, input.commandEventId),
          eq(paid_effect.unit, 'source_verify@1'),
        ),
      );
    const pending = priorRows.find((row) => row.state === 'pending');
    if (priorRows.some((row) => ['sending', 'unknown', 'receipt_ready'].includes(row.state))) {
      return { kind: 'held' as const, state: 'sending' };
    }
    if (
      priorRows.some(
        (row) =>
          row.state === 'applied' &&
          (row.result_json == null ||
            typeof row.result_json !== 'object' ||
            (row.result_json as Record<string, unknown>).status !== 'not_sent'),
      )
    ) {
      return { kind: 'held' as const, state: 'applied' };
    }
    const attempt =
      pending != null
        ? (((pending.input_json as Record<string, unknown> | null)?.attempt as
            | number
            | undefined) ?? 1)
        : Math.max(
            0,
            ...priorRows.map((row) => {
              const value = (row.input_json as Record<string, unknown> | null)?.attempt;
              return typeof value === 'number' && Number.isInteger(value) ? value : 1;
            }),
          ) + 1;
    const recheckEffect = {
      family: 'source_verify' as const,
      entityId: input.questionId,
      entityRevision: input.commandEventId,
      unit: 'source_verify@1' as const,
      input: pending?.input_json ?? {
        question_id: input.questionId,
        command_event_id: input.commandEventId,
        attempt,
      },
    };
    const admitted = await admitPaidEffectIntent(tx, recheckEffect);
    if (admitted.kind === 'existing' && admitted.state !== 'pending') {
      return { kind: 'held' as const, state: admitted.state };
    }
    const identity = computePaidEffectIdentity(recheckEffect);
    const send = await claimPaidEffectSend(tx, identity, {
      backend: 'pg-boss',
      deliveryId: input.deliveryId,
      leaseExpiresAt: new Date(Date.now() + 60 * 60_000),
    });
    if (send.kind !== 'claimed') {
      return { kind: 'held' as const, state: send.kind === 'refused' ? send.state : 'pending' };
    }
    return { kind: 'claimed' as const, identity, fence: send.fence };
  });
}

export async function writeSourceVerifyErrorEvent(input: {
  target: Db | Tx;
  questionId: string;
  recheckCommandEventId?: string;
  error: unknown;
  configError: boolean;
  difficultyEvidence?: DifficultyEvidenceT | null;
  supplyTrace?: SupplyTraceV1T;
}): Promise<void> {
  await writeEvent(input.target, {
    id: createId(),
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'source_verify',
    action: 'experimental:source_verify',
    subject_kind: 'question',
    subject_id: input.questionId,
    outcome: 'error',
    payload: {
      question_id: input.questionId,
      ...(input.recheckCommandEventId != null
        ? { recheck_command_event_id: input.recheckCommandEventId }
        : {}),
      ...toUnifiedVerifyResult({
        source: 'system_error',
        summary_md: `source_verify failed: ${String((input.error as Error).message ?? input.error)}`,
        error: String((input.error as Error).message ?? input.error),
      }),
      ...(input.configError ? { config_error: true } : {}),
      error: String((input.error as Error).message ?? input.error),
      ...(input.difficultyEvidence ? { difficulty_evidence: input.difficultyEvidence } : {}),
      ...(input.supplyTrace ? { supply_trace: input.supplyTrace } : {}),
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(),
  });
}

export async function suspendSourceVerifyContract(input: {
  tx: Tx;
  questionId: string;
  groupRootId: string;
  rowVersion: number;
  verifiedIdentity: { revisionId: string | null; admissionGeneration: number | null };
  outcome: { status: 'transient_error' | 'config_error'; message: string };
}): Promise<boolean> {
  const { tx } = input;
  await tx
    .select({ id: question.id })
    .from(question)
    .where(eq(question.id, input.groupRootId))
    .for('update')
    .limit(1);
  const [post] = await tx
    .select({
      version: question.version,
      promotedElsewhere: sql<boolean>`EXISTS (
        SELECT 1 FROM ${event}
        WHERE ${event.action} = 'experimental:source_verify'
          AND ${event.subject_kind} = 'question'
          AND ${event.subject_id} = ${input.questionId}
          AND ${event.outcome} = 'success'
      )`,
    })
    .from(question)
    .where(eq(question.id, input.questionId))
    .for('update')
    .limit(1);
  const maySuspendContract =
    post != null && post.version === input.rowVersion && !post.promotedElsewhere;
  if (!maySuspendContract) return false;
  await tx
    .update(question)
    .set({ draft_status: LEGACY_DRAFT_STATUS.DRAFT, updated_at: new Date() })
    .where(eq(question.id, input.questionId));
  await publishVerifyLifecycleUpdate(tx, {
    rootId: input.groupRootId,
    expectedRevision: input.verifiedIdentity.revisionId,
    expectedGeneration: input.verifiedIdentity.admissionGeneration,
    admission: {
      state: SCORING_ADMISSION_STATE.WITHHELD,
      reason: SCORING_ADMISSION_WITHHELD_REASON.UNVERIFIED_RULES,
    },
    suspension: { suspended: true, reason: SUSPENSION_REASON.VERIFY_HOLD },
    verification: {
      policy_id: 'source_verify@1',
      outcome: 'suspended',
      evidence: {
        check: 'source_grounding',
        transient: input.outcome.status === 'transient_error',
        ...(input.outcome.status === 'config_error' ? { config_error: true } : {}),
        message: input.outcome.message,
      },
    },
    actorRef: 'source_verify:suspend',
    now: new Date(),
  });
  return true;
}
