import { and, eq, lte, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { copilot_evidence_checkpoint } from '@/db/schema';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import {
  COPILOT_EVIDENCE_CHECKPOINT_TTL_MS,
  type CopilotEvidenceCheckpoint,
  type CopilotEvidenceCheckpointBinding,
  type CopilotEvidenceCheckpointStore,
  bindingsEqual,
  copilotEvidenceCheckpointId,
} from './evidence-checkpoint';
import {
  type CopilotEvidenceLedgerRecord,
  CopilotEvidenceLedgerRecordSchema,
} from './evidence-submission';

const AttemptAuditSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('running'),
      task_run_id: z.string().min(1),
      task_input_sha256: z.string().length(64),
      started_at: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      outcome: z.enum(['failed_retryable', 'failed_permanent', 'success']),
      failure_kind: z.string().optional(),
      task_run_id: z.string().min(1),
      task_input_sha256: z.string().length(64),
      finished_at: z.iso.datetime(),
    })
    .strict(),
]);

type CheckpointRow = typeof copilot_evidence_checkpoint.$inferSelect;

function bindingFromRow(row: CheckpointRow): CopilotEvidenceCheckpointBinding {
  const extras = z.record(z.string(), z.string()).parse(row.binding_extras);
  const taskKind = z
    .enum(['CopilotEvidenceReviewTask', 'CopilotEvidenceVerificationTask'])
    .parse(row.task_kind);
  return {
    task_kind: taskKind,
    slot: row.slot,
    protocol_version: row.protocol_version,
    prompt_fingerprint: row.prompt_fingerprint,
    base_input_sha256: row.base_input_sha256,
    source_catalog_sha256: row.source_catalog_sha256,
    binding_extras: extras,
  };
}

function checkpointFromRow(row: CheckpointRow): CopilotEvidenceCheckpoint {
  const binding = bindingFromRow(row);
  const status = z.enum(['open', 'sealed', 'expired']).parse(row.status);
  const records = z.array(CopilotEvidenceLedgerRecordSchema).parse(row.records_json);
  const attempts = z.array(AttemptAuditSchema).parse(row.attempts_json);
  const sealed =
    status === 'sealed' &&
    row.sealed_output_json !== null &&
    row.sealed_digest_sha256 !== null &&
    row.sealed_task_run_id !== null
      ? {
          output_json: row.sealed_output_json,
          digest_sha256: row.sealed_digest_sha256,
          task_run_id: row.sealed_task_run_id,
        }
      : undefined;
  if (status === 'sealed' && !sealed) throw new Error('sealed checkpoint fields missing');
  return {
    id: row.id,
    binding,
    status,
    revision: row.revision,
    records,
    attempts,
    ...(sealed ? { sealed } : {}),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
  };
}

async function lockOrCreate(
  tx: Tx,
  binding: CopilotEvidenceCheckpointBinding,
  now: Date,
): Promise<CheckpointRow> {
  const id = copilotEvidenceCheckpointId(binding);
  await tx
    .insert(copilot_evidence_checkpoint)
    .values({
      id,
      task_kind: binding.task_kind,
      slot: binding.slot,
      protocol_version: binding.protocol_version,
      prompt_fingerprint: binding.prompt_fingerprint,
      base_input_sha256: binding.base_input_sha256,
      source_catalog_sha256: binding.source_catalog_sha256,
      binding_extras: { ...binding.binding_extras },
      expires_at: new Date(now.getTime() + COPILOT_EVIDENCE_CHECKPOINT_TTL_MS),
    })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(copilot_evidence_checkpoint)
    .where(eq(copilot_evidence_checkpoint.id, id))
    .for('update');
  if (!row || !bindingsEqual(bindingFromRow(row), binding)) {
    throw new Error('copilot evidence checkpoint binding mismatch');
  }
  if (row.status === 'expired' || row.expires_at.getTime() <= now.getTime()) {
    throw new Error('copilot evidence checkpoint expired');
  }
  return row;
}

export function createPgCopilotEvidenceCheckpointStore(db: Db): CopilotEvidenceCheckpointStore {
  return {
    load: async (binding) => {
      const id = copilotEvidenceCheckpointId(binding);
      const [row] = await db
        .select()
        .from(copilot_evidence_checkpoint)
        .where(eq(copilot_evidence_checkpoint.id, id));
      if (!row) return undefined;
      if (!bindingsEqual(bindingFromRow(row), binding)) {
        throw new Error('copilot evidence checkpoint binding mismatch');
      }
      if (row.status === 'expired' || row.expires_at.getTime() <= Date.now()) {
        await db
          .update(copilot_evidence_checkpoint)
          .set({
            status: 'expired',
            records_json: [],
            record_digests_json: [],
            attempts_json: [],
            sealed_output_json: null,
            sealed_digest_sha256: null,
            sealed_task_run_id: null,
          })
          .where(
            and(
              eq(copilot_evidence_checkpoint.id, id),
              lte(copilot_evidence_checkpoint.expires_at, new Date()),
            ),
          );
        return undefined;
      }
      return checkpointFromRow(row);
    },
    appendRecords: async (binding, records) => {
      if (records.length === 0) return;
      await db.transaction(async (tx) => {
        const now = new Date();
        const row = await lockOrCreate(tx, binding, now);
        if (row.status === 'sealed') return;
        const known = new Set(row.record_digests_json);
        const accepted: CopilotEvidenceLedgerRecord[] = [];
        const acceptedDigests: string[] = [];
        for (const record of records) {
          const digest = sha256CanonicalJson(record);
          if (known.has(digest)) continue;
          known.add(digest);
          accepted.push(record);
          acceptedDigests.push(digest);
        }
        if (accepted.length === 0) return;
        await tx
          .update(copilot_evidence_checkpoint)
          .set({
            records_json: [...row.records_json, ...accepted],
            record_digests_json: [...row.record_digests_json, ...acceptedDigests],
            revision: row.revision + accepted.length,
            updated_at: now,
            expires_at: new Date(now.getTime() + COPILOT_EVIDENCE_CHECKPOINT_TTL_MS),
          })
          .where(eq(copilot_evidence_checkpoint.id, row.id));
      });
    },
    recordAttempt: async (binding, attempt) => {
      await db.transaction(async (tx) => {
        const now = new Date();
        const row = await lockOrCreate(tx, binding, now);
        const attempts = z.array(AttemptAuditSchema).parse(row.attempts_json);
        const storedAttempt: Record<string, unknown> = { ...attempt };
        const existingIndex = attempts.findIndex(
          (item) => item.task_run_id === attempt.task_run_id,
        );
        if (existingIndex >= 0) {
          const existingAttempt = attempts[existingIndex];
          if (existingAttempt?.outcome !== 'running' || attempt.outcome === 'running') return;
          const updatedAttempts: Record<string, unknown>[] = [...attempts];
          updatedAttempts[existingIndex] = storedAttempt;
          await tx
            .update(copilot_evidence_checkpoint)
            .set({ attempts_json: updatedAttempts, updated_at: now })
            .where(eq(copilot_evidence_checkpoint.id, row.id));
          return;
        }
        await tx
          .update(copilot_evidence_checkpoint)
          .set({ attempts_json: [...attempts, storedAttempt], updated_at: now })
          .where(eq(copilot_evidence_checkpoint.id, row.id));
      });
    },
    markSealed: async (binding, sealed) =>
      db.transaction(async (tx) => {
        const now = new Date();
        const row = await lockOrCreate(tx, binding, now);
        if (row.status === 'sealed') {
          return row.sealed_digest_sha256 === sealed.digest_sha256 &&
            row.sealed_task_run_id === sealed.task_run_id &&
            sha256CanonicalJson(row.sealed_output_json) === sha256CanonicalJson(sealed.output_json)
            ? { status: 'ok' }
            : { status: 'conflict' };
        }
        await tx
          .update(copilot_evidence_checkpoint)
          .set({
            status: 'sealed',
            sealed_output_json: sealed.output_json,
            sealed_digest_sha256: sealed.digest_sha256,
            sealed_task_run_id: sealed.task_run_id,
            updated_at: now,
          })
          .where(eq(copilot_evidence_checkpoint.id, row.id));
        return { status: 'ok' };
      }),
    verifySealedRun: async (binding, sealed) => {
      const loaded = await db
        .select()
        .from(copilot_evidence_checkpoint)
        .where(eq(copilot_evidence_checkpoint.id, copilotEvidenceCheckpointId(binding)));
      const row = loaded[0];
      return (
        row?.status === 'sealed' &&
        row.sealed_digest_sha256 === sealed.digest_sha256 &&
        row.sealed_task_run_id === sealed.task_run_id &&
        sha256CanonicalJson(row.sealed_output_json) === sha256CanonicalJson(sealed.output_json)
      );
    },
    cleanupExpired: async (now = new Date()) => {
      const deleted = await db
        .update(copilot_evidence_checkpoint)
        .set({
          status: 'expired',
          records_json: [],
          record_digests_json: [],
          attempts_json: [],
          sealed_output_json: null,
          sealed_digest_sha256: null,
          sealed_task_run_id: null,
        })
        .where(
          and(
            lte(copilot_evidence_checkpoint.expires_at, now),
            ne(copilot_evidence_checkpoint.status, 'expired'),
          ),
        )
        .returning({ id: copilot_evidence_checkpoint.id });
      return deleted.length;
    },
  };
}
