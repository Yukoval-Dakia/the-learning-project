import { createHash, randomUUID } from 'node:crypto';

import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';

import type { NoteVerificationResultT } from '@/core/schema/business';
import { NoteVerificationResult } from '@/core/schema/business';
import type { Db, Tx } from '@/db/client';
import { artifact, note_verification_claim } from '@/db/schema';
import { z } from 'zod';

import { NOTE_ARTIFACT_TYPES, isNoteArtifactType } from './note-artifact-types';
import { emitNoteVerificationLifecycleEvent } from './note-verification-lifecycle';

const CLAIM_RETRY_DELAY_MS = 30_000;
const RESERVED_LEASE_MS = 20_000;
const PROVIDER_STARTED_LEASE_MS = 3_900_000;
export const NOTE_VERIFICATION_PROVIDER_ATTEMPT_LIMIT = 3;

const TaskTextResultSchema = z.object({
  text: z.string(),
  task_run_id: z.string().optional(),
  cost_usd: z.number().optional(),
  cost_basis: z.enum(['reported', 'estimated', 'unknown']).optional(),
  cost_ref: z.string().optional(),
  structured_output: z.unknown().optional(),
});

const StagedNoteVerificationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('parsed'),
    parsed: NoteVerificationResult,
    taskResult: TaskTextResultSchema.nullable(),
  }),
  z.object({ kind: z.literal('provider_result'), taskResult: TaskTextResultSchema }),
]);

type StagedTaskResult = z.infer<typeof TaskTextResultSchema>;

export type StagedNoteVerification =
  | { kind: 'parsed'; parsed: NoteVerificationResultT; taskResult: StagedTaskResult | null }
  | { kind: 'provider_result'; taskResult: StagedTaskResult };

export type NoteVerificationLease = {
  artifactId: string;
  token: string;
  fence: number;
  artifactVersion: number;
  taskRunId: string;
};

export type NoteVerificationReservation =
  | { kind: 'claimed'; lease: NoteVerificationLease }
  | { kind: 'result_ready'; staged: StagedNoteVerification }
  | { kind: 'busy' }
  | { kind: 'ambiguous' }
  | { kind: 'attempts_exhausted' }
  | { kind: 'completed' }
  | { kind: 'not_found'; artifactType?: string }
  | { kind: 'not_ready'; artifactType?: string }
  | { kind: 'not_queued'; artifactType?: string };

function taskRunId(artifactId: string, artifactVersion: number, fence: number): string {
  const digest = createHash('sha256')
    .update(`note-verify-v1\0${artifactId}\0${artifactVersion}\0${fence}`)
    .digest('hex');
  return `note_verify_v1_${digest.slice(0, 32)}`;
}

function parseStaged(value: unknown) {
  return StagedNoteVerificationSchema.safeParse(value);
}

async function failArtifactVerificationForEpoch(
  tx: Tx,
  epoch: { readonly artifactId: string; readonly artifactVersion: number },
  now: Date,
): Promise<void> {
  const rows = await tx
    .update(artifact)
    .set({ verification_status: 'failed', updated_at: now })
    .where(
      and(
        eq(artifact.id, epoch.artifactId),
        inArray(artifact.type, NOTE_ARTIFACT_TYPES),
        eq(artifact.version, epoch.artifactVersion),
        eq(artifact.generation_status, 'ready'),
        eq(artifact.verification_status, 'queued'),
        isNull(artifact.archived_at),
      ),
    )
    .returning({ version: artifact.version });
  const row = rows[0];
  if (!row) return;
  await emitNoteVerificationLifecycleEvent(tx, {
    artifactId: epoch.artifactId,
    status: 'failed',
    nextVersion: row.version,
    actorKind: 'system',
    actorRef: 'note_verify_attempt_limit',
    createdAt: now,
  });
}

export async function reserveNoteVerification(
  db: Db,
  artifactId: string,
): Promise<NoteVerificationReservation> {
  return db.transaction(async (tx) => {
    const artifactRows = await tx
      .select({
        type: artifact.type,
        generationStatus: artifact.generation_status,
        verificationStatus: artifact.verification_status,
        archivedAt: artifact.archived_at,
        version: artifact.version,
      })
      .from(artifact)
      .where(eq(artifact.id, artifactId))
      .for('update')
      .limit(1);
    const artifactRow = artifactRows[0];
    if (!artifactRow) return { kind: 'not_found' };
    if (!isNoteArtifactType(artifactRow.type)) {
      return { kind: 'not_queued', artifactType: artifactRow.type };
    }
    if (artifactRow.archivedAt !== null || artifactRow.verificationStatus !== 'queued') {
      const existingRows = await tx
        .select({ state: note_verification_claim.state })
        .from(note_verification_claim)
        .where(eq(note_verification_claim.artifact_id, artifactId))
        .for('update')
        .limit(1);
      if (existingRows[0]?.state === 'attempts_exhausted') {
        return { kind: 'attempts_exhausted' };
      }
      return { kind: 'not_queued', artifactType: artifactRow.type };
    }
    if (artifactRow.generationStatus !== 'ready') {
      return { kind: 'not_ready', artifactType: artifactRow.type };
    }

    const now = new Date();
    await tx
      .insert(note_verification_claim)
      .values({
        artifact_id: artifactId,
        artifact_version: artifactRow.version,
        state: 'retry_wait',
        available_at: now,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoNothing();
    const claimRows = await tx
      .select()
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, artifactId))
      .for('update')
      .limit(1);
    let claim = claimRows[0];
    if (!claim) throw new Error(`note verification claim missing after insert: ${artifactId}`);
    if (claim.artifact_version !== artifactRow.version) {
      const fence = claim.fence + 1;
      await tx
        .update(note_verification_claim)
        .set({
          artifact_version: artifactRow.version,
          state: 'retry_wait',
          fence,
          claim_token: null,
          task_run_id: null,
          result_json: null,
          result_attempts: 0,
          provider_attempts: 0,
          error_message: null,
          available_at: now,
          claimed_at: null,
          provider_started_at: null,
          result_ready_at: null,
          completed_at: null,
          lease_expires_at: null,
          updated_at: now,
        })
        .where(eq(note_verification_claim.artifact_id, artifactId));
      claim = {
        ...claim,
        artifact_version: artifactRow.version,
        state: 'retry_wait',
        fence,
        claim_token: null,
        task_run_id: null,
        result_json: null,
        result_attempts: 0,
        provider_attempts: 0,
        available_at: now,
      };
    }
    if (claim.state === 'completed') return { kind: 'completed' };
    if (claim.state === 'result_ready') {
      const parsed = parseStaged(claim.result_json);
      if (!parsed.success) {
        await tx
          .update(note_verification_claim)
          .set({ state: 'ambiguous', error_message: parsed.error.message, updated_at: now })
          .where(eq(note_verification_claim.artifact_id, artifactId));
        return { kind: 'ambiguous' };
      }
      return { kind: 'result_ready', staged: parsed.data };
    }
    if (claim.state === 'ambiguous') {
      return { kind: 'ambiguous' };
    }
    if (claim.state === 'attempts_exhausted') {
      await failArtifactVerificationForEpoch(
        tx,
        { artifactId, artifactVersion: artifactRow.version },
        now,
      );
      return { kind: 'attempts_exhausted' };
    }
    if (claim.state === 'provider_started') {
      if (claim.lease_expires_at && claim.lease_expires_at <= now) {
        await tx
          .update(note_verification_claim)
          .set({ state: 'ambiguous', updated_at: now })
          .where(
            leasePredicate(
              {
                artifactId,
                artifactVersion: claim.artifact_version,
                token: claim.claim_token ?? '',
                fence: claim.fence,
                taskRunId: claim.task_run_id ?? '',
              },
              'provider_started',
            ),
          );
        return { kind: 'ambiguous' };
      }
      return { kind: 'busy' };
    }
    if (claim.state === 'reserved' && claim.lease_expires_at && claim.lease_expires_at > now) {
      return { kind: 'busy' };
    }
    if (claim.state === 'reserved') {
      await tx
        .update(note_verification_claim)
        .set({
          state: 'retry_wait',
          claim_token: null,
          task_run_id: null,
          claimed_at: null,
          lease_expires_at: null,
          updated_at: now,
        })
        .where(eq(note_verification_claim.artifact_id, artifactId));
      claim = { ...claim, state: 'retry_wait', claim_token: null, task_run_id: null };
    }
    if (claim.state === 'retry_wait' && claim.result_json) {
      if (claim.available_at > now) return { kind: 'busy' };
      if (claim.result_attempts >= 2) {
        await tx
          .update(note_verification_claim)
          .set({ state: 'ambiguous', updated_at: now })
          .where(eq(note_verification_claim.artifact_id, artifactId));
        return { kind: 'ambiguous' };
      }
      const parsed = parseStaged(claim.result_json);
      if (!parsed.success) {
        await tx
          .update(note_verification_claim)
          .set({ state: 'ambiguous', error_message: parsed.error.message, updated_at: now })
          .where(eq(note_verification_claim.artifact_id, artifactId));
        return { kind: 'ambiguous' };
      }
      await tx
        .update(note_verification_claim)
        .set({ state: 'result_ready', updated_at: now })
        .where(eq(note_verification_claim.artifact_id, artifactId));
      return { kind: 'result_ready', staged: parsed.data };
    }
    if (claim.available_at.getTime() > now.getTime()) return { kind: 'busy' };
    if (claim.provider_attempts >= NOTE_VERIFICATION_PROVIDER_ATTEMPT_LIMIT) {
      await tx
        .update(note_verification_claim)
        .set({
          state: 'attempts_exhausted',
          claim_token: null,
          task_run_id: null,
          error_message: 'provider attempt limit reached',
          updated_at: now,
        })
        .where(eq(note_verification_claim.artifact_id, artifactId));
      await failArtifactVerificationForEpoch(
        tx,
        { artifactId, artifactVersion: artifactRow.version },
        now,
      );
      return { kind: 'attempts_exhausted' };
    }

    const fence = claim.fence + 1;
    const token = randomUUID();
    const deterministicTaskRunId = taskRunId(artifactId, artifactRow.version, fence);
    const updated = await tx
      .update(note_verification_claim)
      .set({
        state: 'reserved',
        fence,
        claim_token: token,
        task_run_id: deterministicTaskRunId,
        error_message: null,
        claimed_at: now,
        provider_started_at: null,
        lease_expires_at: new Date(now.getTime() + RESERVED_LEASE_MS),
        updated_at: now,
      })
      .where(
        and(
          eq(note_verification_claim.artifact_id, artifactId),
          eq(note_verification_claim.state, 'retry_wait'),
          lte(note_verification_claim.available_at, now),
        ),
      )
      .returning({ artifactId: note_verification_claim.artifact_id });
    if (updated.length === 0) return { kind: 'busy' };
    return {
      kind: 'claimed',
      lease: {
        artifactId,
        artifactVersion: artifactRow.version,
        token,
        fence,
        taskRunId: deterministicTaskRunId,
      },
    };
  });
}

function leasePredicate(lease: NoteVerificationLease, state: string) {
  return and(
    eq(note_verification_claim.artifact_id, lease.artifactId),
    eq(note_verification_claim.claim_token, lease.token),
    eq(note_verification_claim.fence, lease.fence),
    eq(note_verification_claim.artifact_version, lease.artifactVersion),
    eq(note_verification_claim.state, state),
  );
}

function artifactEpochIsCurrent(lease: NoteVerificationLease) {
  return sql`EXISTS (
    SELECT 1 FROM ${artifact}
    WHERE ${artifact.id} = ${lease.artifactId}
      AND ${artifact.version} = ${lease.artifactVersion}
      AND ${inArray(artifact.type, NOTE_ARTIFACT_TYPES)}
      AND ${artifact.generation_status} = 'ready'
      AND ${artifact.verification_status} = 'queued'
      AND ${artifact.archived_at} IS NULL
  )`;
}

export async function markNoteVerificationProviderStarted(
  db: Db,
  lease: NoteVerificationLease,
): Promise<
  | { kind: 'started'; providerAttempts: number }
  | { kind: 'attempts_exhausted' }
  | { kind: 'claim_changed' }
> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const artifactRows = await tx
      .select({
        version: artifact.version,
        type: artifact.type,
        generationStatus: artifact.generation_status,
        verificationStatus: artifact.verification_status,
        archivedAt: artifact.archived_at,
      })
      .from(artifact)
      .where(eq(artifact.id, lease.artifactId))
      .for('update')
      .limit(1);
    const claimRows = await tx
      .select()
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, lease.artifactId))
      .for('update')
      .limit(1);
    const claim = claimRows[0];
    const artifactRow = artifactRows[0];
    if (
      !artifactRow ||
      artifactRow.version !== lease.artifactVersion ||
      !isNoteArtifactType(artifactRow.type) ||
      artifactRow.generationStatus !== 'ready' ||
      artifactRow.verificationStatus !== 'queued' ||
      artifactRow.archivedAt !== null ||
      claim?.state !== 'reserved' ||
      claim.artifact_version !== lease.artifactVersion ||
      claim.fence !== lease.fence ||
      claim.claim_token !== lease.token ||
      claim.task_run_id !== lease.taskRunId
    ) {
      return { kind: 'claim_changed' };
    }
    if (claim.provider_attempts >= NOTE_VERIFICATION_PROVIDER_ATTEMPT_LIMIT) {
      await tx
        .update(note_verification_claim)
        .set({
          state: 'attempts_exhausted',
          claim_token: null,
          task_run_id: null,
          claimed_at: null,
          lease_expires_at: null,
          error_message: 'provider attempt limit reached',
          updated_at: now,
        })
        .where(leasePredicate(lease, 'reserved'));
      await failArtifactVerificationForEpoch(tx, lease, now);
      return { kind: 'attempts_exhausted' };
    }
    const rows = await tx
      .update(note_verification_claim)
      .set({
        state: 'provider_started',
        provider_attempts: sql`${note_verification_claim.provider_attempts} + 1`,
        provider_started_at: now,
        lease_expires_at: new Date(now.getTime() + PROVIDER_STARTED_LEASE_MS),
        updated_at: now,
      })
      .where(leasePredicate(lease, 'reserved'))
      .returning({ providerAttempts: note_verification_claim.provider_attempts });
    const started = rows[0];
    return started
      ? { kind: 'started', providerAttempts: started.providerAttempts }
      : { kind: 'claim_changed' };
  });
}

export async function stageNoteVerificationResult(
  db: Db,
  lease: NoteVerificationLease,
  staged: StagedNoteVerification,
): Promise<boolean> {
  const now = new Date();
  const validated = StagedNoteVerificationSchema.parse(staged);
  const rows = await db
    .update(note_verification_claim)
    .set({
      state: 'result_ready',
      result_json: validated,
      result_ready_at: now,
      lease_expires_at: null,
      updated_at: now,
    })
    .where(and(leasePredicate(lease, 'provider_started'), artifactEpochIsCurrent(lease)))
    .returning({ artifactId: note_verification_claim.artifact_id });
  return rows.length === 1;
}

export async function stageNoteVerificationContractResult(
  db: Db,
  lease: NoteVerificationLease,
  staged: StagedNoteVerification,
): Promise<boolean> {
  const now = new Date();
  const validated = StagedNoteVerificationSchema.parse(staged);
  const rows = await db
    .update(note_verification_claim)
    .set({
      state: 'result_ready',
      result_json: validated,
      result_ready_at: now,
      lease_expires_at: null,
      updated_at: now,
    })
    .where(and(leasePredicate(lease, 'reserved'), artifactEpochIsCurrent(lease)))
    .returning({ artifactId: note_verification_claim.artifact_id });
  return rows.length === 1;
}

export async function releaseNoteVerificationForRetry(
  db: Db,
  lease: NoteVerificationLease,
  error: unknown,
): Promise<{ kind: 'retry_wait' } | { kind: 'attempts_exhausted' } | { kind: 'claim_changed' }> {
  return db.transaction(async (tx) => {
    const artifactRows = await tx
      .select({
        version: artifact.version,
        type: artifact.type,
        generationStatus: artifact.generation_status,
        verificationStatus: artifact.verification_status,
        archivedAt: artifact.archived_at,
      })
      .from(artifact)
      .where(eq(artifact.id, lease.artifactId))
      .for('update')
      .limit(1);
    const claimRows = await tx
      .select()
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, lease.artifactId))
      .for('update')
      .limit(1);
    const artifactRow = artifactRows[0];
    const claim = claimRows[0];
    if (
      !artifactRow ||
      artifactRow.version !== lease.artifactVersion ||
      !isNoteArtifactType(artifactRow.type) ||
      artifactRow.generationStatus !== 'ready' ||
      artifactRow.verificationStatus !== 'queued' ||
      artifactRow.archivedAt !== null ||
      claim?.state !== 'provider_started' ||
      claim.artifact_version !== lease.artifactVersion ||
      claim.fence !== lease.fence ||
      claim.claim_token !== lease.token ||
      claim.task_run_id !== lease.taskRunId
    ) {
      return { kind: 'claim_changed' };
    }
    const now = new Date();
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (claim.provider_attempts >= NOTE_VERIFICATION_PROVIDER_ATTEMPT_LIMIT) {
      const exhaustedRows = await tx
        .update(note_verification_claim)
        .set({
          state: 'attempts_exhausted',
          claim_token: null,
          task_run_id: null,
          claimed_at: null,
          provider_started_at: null,
          lease_expires_at: null,
          error_message: errorMessage,
          updated_at: now,
        })
        .where(leasePredicate(lease, 'provider_started'))
        .returning({ artifactId: note_verification_claim.artifact_id });
      if (exhaustedRows.length === 0) return { kind: 'claim_changed' };
      await failArtifactVerificationForEpoch(tx, lease, now);
      return { kind: 'attempts_exhausted' };
    }
    const retryRows = await tx
      .update(note_verification_claim)
      .set({
        state: 'retry_wait',
        claim_token: null,
        task_run_id: null,
        claimed_at: null,
        provider_started_at: null,
        lease_expires_at: null,
        error_message: errorMessage,
        available_at: new Date(now.getTime() + CLAIM_RETRY_DELAY_MS),
        updated_at: now,
      })
      .where(leasePredicate(lease, 'provider_started'))
      .returning({ artifactId: note_verification_claim.artifact_id });
    if (retryRows.length === 0) return { kind: 'claim_changed' };
    return { kind: 'retry_wait' };
  });
}

export async function releaseReservedNoteVerificationForRetry(
  db: Db,
  lease: NoteVerificationLease,
  error: unknown,
): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(note_verification_claim)
    .set({
      state: 'retry_wait',
      claim_token: null,
      task_run_id: null,
      claimed_at: null,
      lease_expires_at: null,
      error_message: error instanceof Error ? error.message : String(error),
      available_at: new Date(now.getTime() + CLAIM_RETRY_DELAY_MS),
      updated_at: now,
    })
    .where(and(leasePredicate(lease, 'reserved'), artifactEpochIsCurrent(lease)))
    .returning({ artifactId: note_verification_claim.artifact_id });
  if (rows.length === 1) return true;
  await discardReservedNoteVerificationClaim(db, lease);
  return false;
}

export async function discardReservedNoteVerificationClaim(
  db: Db,
  lease: NoteVerificationLease,
): Promise<boolean> {
  const rows = await db
    .delete(note_verification_claim)
    .where(leasePredicate(lease, 'reserved'))
    .returning({ artifactId: note_verification_claim.artifact_id });
  return rows.length === 1;
}

export async function deferNoteVerificationResultForRetry(
  db: Db,
  artifactId: string,
  error: unknown,
): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(note_verification_claim)
    .set({
      state: 'retry_wait',
      claim_token: null,
      claimed_at: null,
      provider_started_at: null,
      result_attempts: sql`${note_verification_claim.result_attempts} + 1`,
      error_message: error instanceof Error ? error.message : String(error),
      available_at: new Date(now.getTime() + CLAIM_RETRY_DELAY_MS),
      lease_expires_at: null,
      updated_at: now,
    })
    .where(
      and(
        eq(note_verification_claim.artifact_id, artifactId),
        eq(note_verification_claim.state, 'result_ready'),
      ),
    )
    .returning({ artifactId: note_verification_claim.artifact_id });
  return rows.length === 1;
}

export async function markNoteVerificationAmbiguous(
  db: Db,
  lease: NoteVerificationLease,
  error: unknown,
): Promise<boolean> {
  const rows = await db
    .update(note_verification_claim)
    .set({
      state: 'ambiguous',
      error_message: error instanceof Error ? error.message : String(error),
      updated_at: new Date(),
    })
    .where(leasePredicate(lease, 'provider_started'))
    .returning({ artifactId: note_verification_claim.artifact_id });
  return rows.length === 1;
}

export async function supersedeNoteVerificationEpoch(
  db: Db,
  lease: NoteVerificationLease,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const artifactRows = await tx
      .select({
        version: artifact.version,
        type: artifact.type,
        generationStatus: artifact.generation_status,
        verificationStatus: artifact.verification_status,
        archivedAt: artifact.archived_at,
      })
      .from(artifact)
      .where(eq(artifact.id, lease.artifactId))
      .for('update')
      .limit(1);
    const artifactRow = artifactRows[0];
    if (
      !artifactRow ||
      artifactRow.version === lease.artifactVersion ||
      !isNoteArtifactType(artifactRow.type) ||
      artifactRow.generationStatus !== 'ready' ||
      artifactRow.verificationStatus !== 'queued' ||
      artifactRow.archivedAt !== null
    ) {
      return false;
    }
    const claimRows = await tx
      .select()
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, lease.artifactId))
      .for('update')
      .limit(1);
    const claim = claimRows[0];
    if (
      !claim ||
      claim.artifact_version !== lease.artifactVersion ||
      claim.fence !== lease.fence ||
      claim.claim_token !== lease.token ||
      claim.task_run_id !== lease.taskRunId
    ) {
      return false;
    }
    const now = new Date();
    const nextFence = claim.fence + 1;
    const rows = await tx
      .update(note_verification_claim)
      .set({
        artifact_version: artifactRow.version,
        state: 'retry_wait',
        fence: nextFence,
        claim_token: null,
        task_run_id: null,
        result_json: null,
        result_attempts: 0,
        provider_attempts: 0,
        error_message: 'artifact epoch superseded active verification',
        available_at: now,
        lease_expires_at: null,
        claimed_at: null,
        provider_started_at: null,
        result_ready_at: null,
        completed_at: null,
        updated_at: now,
      })
      .where(
        and(
          eq(note_verification_claim.artifact_id, lease.artifactId),
          eq(note_verification_claim.artifact_version, lease.artifactVersion),
          eq(note_verification_claim.fence, lease.fence),
          eq(note_verification_claim.claim_token, lease.token),
          eq(note_verification_claim.task_run_id, lease.taskRunId),
        ),
      )
      .returning({ artifactId: note_verification_claim.artifact_id });
    return rows.length === 1;
  });
}

export async function finalizeNoteVerificationResult<T>(
  db: Db,
  artifactId: string,
  persist: (tx: Tx, staged: StagedNoteVerification) => Promise<T>,
): Promise<T | null> {
  return db.transaction(async (tx) => {
    const artifactRows = await tx
      .select({
        version: artifact.version,
        type: artifact.type,
        generationStatus: artifact.generation_status,
        verificationStatus: artifact.verification_status,
        archivedAt: artifact.archived_at,
      })
      .from(artifact)
      .where(eq(artifact.id, artifactId))
      .for('update')
      .limit(1);
    const rows = await tx
      .select()
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, artifactId))
      .for('update')
      .limit(1);
    const claim = rows[0];
    if (!claim || claim.state === 'completed') return null;
    if (claim.state !== 'result_ready' || !claim.result_json) return null;
    const artifactRow = artifactRows[0];
    if (
      !artifactRow ||
      artifactRow.version !== claim.artifact_version ||
      !isNoteArtifactType(artifactRow.type) ||
      artifactRow.generationStatus !== 'ready' ||
      artifactRow.verificationStatus !== 'queued' ||
      artifactRow.archivedAt !== null
    ) {
      return null;
    }
    const staged = StagedNoteVerificationSchema.parse(claim.result_json);
    const persisted = await persist(tx, staged);
    const now = new Date();
    await tx
      .update(note_verification_claim)
      .set({
        state: 'completed',
        claim_token: null,
        lease_expires_at: null,
        completed_at: now,
        updated_at: now,
      })
      .where(
        and(
          eq(note_verification_claim.artifact_id, artifactId),
          eq(note_verification_claim.state, 'result_ready'),
          eq(note_verification_claim.fence, claim.fence),
          eq(note_verification_claim.artifact_version, claim.artifact_version),
          sql`${note_verification_claim.claim_token} IS NOT DISTINCT FROM ${claim.claim_token}`,
        ),
      );
    return persisted;
  });
}

export async function listRecoverableNoteVerificationResults(
  db: Db,
  limit = 50,
): Promise<string[]> {
  const now = new Date();
  const rows = await db
    .select({ artifactId: note_verification_claim.artifact_id })
    .from(note_verification_claim)
    .innerJoin(artifact, eq(artifact.id, note_verification_claim.artifact_id))
    .where(
      and(
        lte(note_verification_claim.available_at, now),
        isNull(artifact.archived_at),
        inArray(artifact.type, NOTE_ARTIFACT_TYPES),
        eq(artifact.generation_status, 'ready'),
        eq(artifact.verification_status, 'queued'),
        or(
          eq(note_verification_claim.state, 'result_ready'),
          and(
            eq(note_verification_claim.state, 'retry_wait'),
            isNotNull(note_verification_claim.result_json),
          ),
          and(
            eq(note_verification_claim.state, 'retry_wait'),
            isNull(note_verification_claim.task_run_id),
            isNull(note_verification_claim.result_json),
          ),
          and(
            inArray(note_verification_claim.state, ['reserved', 'provider_started']),
            isNotNull(note_verification_claim.lease_expires_at),
            lte(note_verification_claim.lease_expires_at, now),
          ),
          sql`${artifact.version} <> ${note_verification_claim.artifact_version}`,
        ),
      ),
    )
    .orderBy(note_verification_claim.available_at, note_verification_claim.artifact_id)
    .limit(limit);
  return rows.map((row) => row.artifactId);
}

export async function prepareNoteVerificationResultRecovery(
  db: Db,
  artifactId: string,
): Promise<
  | { kind: 'result_ready'; artifactType: string }
  | { kind: 'retry_required'; artifactId: string; fence: number }
  | null
> {
  return db.transaction(async (tx) => {
    const artifactRows = await tx
      .select({
        type: artifact.type,
        version: artifact.version,
        generationStatus: artifact.generation_status,
        verificationStatus: artifact.verification_status,
        archivedAt: artifact.archived_at,
      })
      .from(artifact)
      .where(eq(artifact.id, artifactId))
      .for('update')
      .limit(1);
    const artifactRow = artifactRows[0];
    if (!artifactRow) return null;

    const claimRows = await tx
      .select()
      .from(note_verification_claim)
      .where(eq(note_verification_claim.artifact_id, artifactId))
      .for('update')
      .limit(1);
    const claim = claimRows[0];
    const now = new Date();
    if (
      !claim ||
      !isNoteArtifactType(artifactRow.type) ||
      artifactRow.generationStatus !== 'ready' ||
      artifactRow.verificationStatus !== 'queued' ||
      artifactRow.archivedAt !== null
    ) {
      return null;
    }
    if (claim.artifact_version !== artifactRow.version) {
      const nextFence = claim.fence + 1;
      await tx
        .update(note_verification_claim)
        .set({
          artifact_version: artifactRow.version,
          state: 'retry_wait',
          fence: nextFence,
          claim_token: null,
          task_run_id: null,
          result_json: null,
          result_attempts: 0,
          provider_attempts: 0,
          error_message: 'artifact epoch superseded during claim recovery',
          available_at: now,
          lease_expires_at: null,
          claimed_at: null,
          provider_started_at: null,
          result_ready_at: null,
          completed_at: null,
          updated_at: now,
        })
        .where(
          and(
            eq(note_verification_claim.artifact_id, artifactId),
            eq(note_verification_claim.artifact_version, claim.artifact_version),
            eq(note_verification_claim.fence, claim.fence),
          ),
        );
      return { kind: 'retry_required', artifactId, fence: nextFence };
    }
    if (claim.state === 'reserved' && claim.lease_expires_at && claim.lease_expires_at <= now) {
      const nextFence = claim.fence + 1;
      await tx
        .update(note_verification_claim)
        .set({
          state: 'retry_wait',
          fence: nextFence,
          claim_token: null,
          task_run_id: null,
          error_message: 'expired pre-provider reservation recovered',
          lease_expires_at: null,
          claimed_at: null,
          updated_at: now,
        })
        .where(
          and(
            eq(note_verification_claim.artifact_id, artifactId),
            eq(note_verification_claim.state, 'reserved'),
            eq(note_verification_claim.fence, claim.fence),
          ),
        );
      return { kind: 'retry_required', artifactId, fence: nextFence };
    }
    if (
      claim.state === 'provider_started' &&
      claim.lease_expires_at &&
      claim.lease_expires_at <= now
    ) {
      await tx
        .update(note_verification_claim)
        .set({ state: 'ambiguous', error_message: 'provider-start lease expired', updated_at: now })
        .where(
          and(
            eq(note_verification_claim.artifact_id, artifactId),
            eq(note_verification_claim.state, 'provider_started'),
            eq(note_verification_claim.fence, claim.fence),
          ),
        );
      return null;
    }
    if (claim.available_at > now) return null;
    if (claim.state === 'retry_wait' && !claim.task_run_id && !claim.result_json) {
      if (claim.provider_attempts >= NOTE_VERIFICATION_PROVIDER_ATTEMPT_LIMIT) {
        await tx
          .update(note_verification_claim)
          .set({
            state: 'attempts_exhausted',
            error_message: 'provider attempt limit reached',
            updated_at: now,
          })
          .where(
            and(
              eq(note_verification_claim.artifact_id, artifactId),
              eq(note_verification_claim.state, 'retry_wait'),
              eq(note_verification_claim.fence, claim.fence),
              eq(note_verification_claim.artifact_version, claim.artifact_version),
            ),
          );
        await failArtifactVerificationForEpoch(
          tx,
          { artifactId, artifactVersion: claim.artifact_version },
          now,
        );
        return null;
      }
      return { kind: 'retry_required', artifactId, fence: claim.fence };
    }
    if (claim.state === 'result_ready') {
      return { kind: 'result_ready', artifactType: artifactRow.type };
    }
    if (claim.state !== 'retry_wait' || !claim.result_json) return null;
    if (claim.result_attempts >= 2) {
      await tx
        .update(note_verification_claim)
        .set({ state: 'ambiguous', updated_at: now })
        .where(
          and(
            eq(note_verification_claim.artifact_id, artifactId),
            eq(note_verification_claim.state, 'retry_wait'),
            eq(note_verification_claim.fence, claim.fence),
            eq(note_verification_claim.artifact_version, claim.artifact_version),
          ),
        );
      return null;
    }
    const parsed = parseStaged(claim.result_json);
    if (!parsed.success) {
      await tx
        .update(note_verification_claim)
        .set({ state: 'ambiguous', error_message: parsed.error.message, updated_at: now })
        .where(
          and(
            eq(note_verification_claim.artifact_id, artifactId),
            eq(note_verification_claim.state, 'retry_wait'),
            eq(note_verification_claim.fence, claim.fence),
            eq(note_verification_claim.artifact_version, claim.artifact_version),
          ),
        );
      return null;
    }
    const promoted = await tx
      .update(note_verification_claim)
      .set({ state: 'result_ready', updated_at: now })
      .where(
        and(
          eq(note_verification_claim.artifact_id, artifactId),
          eq(note_verification_claim.state, 'retry_wait'),
          eq(note_verification_claim.fence, claim.fence),
          eq(note_verification_claim.artifact_version, claim.artifact_version),
          isNotNull(note_verification_claim.result_json),
        ),
      )
      .returning({ artifactId: note_verification_claim.artifact_id });
    return promoted.length === 1 ? { kind: 'result_ready', artifactType: artifactRow.type } : null;
  });
}
