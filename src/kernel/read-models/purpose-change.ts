import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { event, paid_effect } from '@/db/schema';
import {
  eventBelongsToDocumentSql,
  readEventDerivationPolicy,
} from '@/kernel/events/derivation-policy';

// Domain-specific permanent facts in the existing event log, not job_events/receipts.
export const PURPOSE_CHANGE_ACTION = 'experimental:ingestion_purpose_change';
export const PURPOSE_REPAIR_ACTION = 'experimental:ingestion_purpose_repair';
export const PURPOSE_BRIEF_LOCK = 'memory:purpose-brief';
export const PurposeChangeInput = z
  .object({
    request_id: z.string().uuid(),
    source_document_id: z.string().min(1),
    expected_version: z.number().int().nonnegative(),
    target: z.enum(['allow', 'answer_only']),
  })
  .strict();
export type PurposeChangeInputT = z.infer<typeof PurposeChangeInput>;
export const PurposeChangeReceipt = z
  .object({
    version: z.literal(1),
    input: PurposeChangeInput,
    session_id: z.string(),
    operation_id: z.string(),
    policy_committed: z.literal(true),
    previous_policy: z.enum(['allow', 'answer_only']),
    committed_version: z.number().int(),
    epoch: z.string(),
    changed: z.boolean(),
    stop: z.array(
      z.object({
        session_id: z.string(),
        run_ref: z.string().nullable(),
        operation_id: z.string().nullable(),
      }),
    ),
    brief_scopes: z.array(z.object({ scope_key: z.string(), version: z.number().int() })),
    cleanup_required: z.boolean(),
    admission_obligation: z
      .object({
        state: z.literal('pending'),
        effect: z.literal('unknown'),
        reason: z.literal('source_fence_active_history_unknown'),
        source_document_id: z.string(),
      })
      .nullable(),
    external_effect: z.literal('unknown_or_irreversible'),
    derivation_policy: z.literal('answer_only'),
  })
  .strict();
export type PurposeChangeReceiptT = z.infer<typeof PurposeChangeReceipt>;

export const AdmissionPurposeImpact = z.object({
  state: z.enum(['pending', 'unknown']),
  effect: z.literal('unknown'),
  fence: z.literal('active'),
  reason: z.literal('source_fence_active_history_unknown'),
  operation_id: z.string().nullable(),
  source_document_id: z.string(),
  unattributed_history: z.literal('unknown'),
  deliveries: z.array(
    z.object({
      job_id: z.string(),
      group_id: z.string(),
      revision_id: z.string(),
      source_event_id: z.string(),
      usage_source_event_id: z.string(),
      source_policy: z.enum(['allow', 'answer_only', 'crisis']),
      paid_state: z.string(),
      application_error: z.string().nullable(),
    }),
  ),
});

/** Delivery facts retain attribution after queue retention; applied is history,
 * never proof that the document's downstream uses were withdrawn completely.
 */
export async function readAdmissionPurposeImpact(db: Db | Tx, documentId: string) {
  const rows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:question_admission_purpose'),
        eq(event.actor_kind, 'system'),
        eq(event.actor_ref, 'practice:question_admission'),
        eventBelongsToDocumentSql(documentId),
      ),
    );
  const deliveries = [];
  for (const row of rows) {
    const parsed = z
      .object({
        job_id: z.string(),
        question_id: z.string(),
        revision_id: z.string(),
        source_event_id: z.string(),
        usage_source_event_id: z.string(),
      })
      .safeParse(row.payload);
    if (!parsed.success) continue;
    const binding = parsed.data;
    const effects = await db
      .select({ state: paid_effect.state, error: paid_effect.last_application_error })
      .from(paid_effect)
      .where(
        and(
          eq(paid_effect.family, 'question_admission_run'),
          eq(paid_effect.delivery_id, binding.job_id),
        ),
      );
    for (const effect of effects.length ? effects : [null])
      deliveries.push({
        job_id: binding.job_id,
        group_id: binding.question_id,
        revision_id: binding.revision_id,
        source_event_id: binding.source_event_id,
        usage_source_event_id: binding.usage_source_event_id,
        source_policy: await readEventDerivationPolicy(db, binding.usage_source_event_id),
        paid_state: effect?.state ?? 'not_claimed_or_unknown',
        application_error: effect?.error ?? null,
      });
  }
  return deliveries;
}

export function purposeOperationId(sessionId: string, requestId: string) {
  return `ingestion-purpose:${sessionId}:${requestId}`;
}
export async function readPurposeReceipt(
  db: Db | Tx,
  id: string,
): Promise<PurposeChangeReceiptT | null> {
  const [row] = await db.select().from(event).where(eq(event.id, id)).limit(1);
  if (!row) return null;
  if (
    row.action !== PURPOSE_CHANGE_ACTION ||
    row.actor_kind !== 'user' ||
    row.actor_ref !== 'self' ||
    row.outcome !== 'success' ||
    row.subject_kind !== 'source_document'
  )
    throw new Error('purpose receipt identity conflict');
  const receipt = PurposeChangeReceipt.parse(row.payload);
  if (
    receipt.operation_id !== id ||
    receipt.session_id !== row.session_id ||
    receipt.input.source_document_id !== row.subject_id
  )
    throw new Error('purpose receipt binding conflict');
  return receipt;
}

/** Stable permanent watermark, ordered by actual event identity, never wall time. */
export async function latestPurposeWithdrawal(db: Db | Tx): Promise<string | null> {
  const [row] = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, PURPOSE_CHANGE_ACTION),
        eq(event.actor_kind, 'user'),
        eq(event.actor_ref, 'self'),
        sql`${event.payload}->>'cleanup_required' = 'true'`,
      ),
    )
    .orderBy(desc(event.dispatch_seq), desc(event.id))
    .limit(1);
  return row?.id ?? null;
}

export const PurposeRepairRecord = z
  .object({
    version: z.literal(1),
    operation_id: z.string(),
    sink: z.enum(['mem0', 'brief', 'brief_dispatch', 'mem0_scan']),
    source_id: z.string(),
    state: z.enum(['complete', 'pending', 'failed', 'unknown']),
    memory_ids: z.array(z.string()).optional(),
    detail: z.string(),
    cursor: z.string().optional(),
    job_id: z.string().uuid().optional(),
    task_run_id: z.string().optional(),
    derivation_policy: z.literal('answer_only'),
  })
  .strict();
export type PurposeRepairRecordT = z.infer<typeof PurposeRepairRecord>;
export async function readPurposeRepairs(db: Db | Tx, operationId: string) {
  const rows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, PURPOSE_REPAIR_ACTION),
        eq(event.subject_id, operationId),
        eq(event.actor_kind, 'system'),
        eq(event.actor_ref, 'memory-purpose-repair'),
      ),
    )
    .orderBy(desc(event.dispatch_seq), desc(event.id));
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const value = PurposeRepairRecord.parse(row.payload);
    if (value.operation_id !== operationId) throw new Error('purpose repair binding conflict');
    const key = `${value.sink}:${value.source_id}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [value];
  });
}

export const BRIEF_PURPOSE_ACTION = 'experimental:memory_brief_purpose';

/** Legacy brief facts have no exact provenance list. A withdrawal invalidates them
 * conservatively until this writer proves it regenerated at the current watermark.
 */
export async function briefPurposeCurrent(db: Db | Tx, scopeKey: string, version: number) {
  const withdrawal = await latestPurposeWithdrawal(db);
  if (!withdrawal) return true;
  const [marker] = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, BRIEF_PURPOSE_ACTION),
        eq(event.actor_kind, 'system'),
        eq(event.actor_ref, 'memory-brief-writer'),
        eq(event.subject_id, scopeKey),
        sql`${event.payload}->>'brief_version' = ${String(version)}`,
      ),
    )
    .orderBy(desc(event.dispatch_seq))
    .limit(1);
  return marker?.payload.withdrawal_id === withdrawal;
}
