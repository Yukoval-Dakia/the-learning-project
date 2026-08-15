// Result persistence/finalization for the note verification state machine:
// staging a provider or contract result onto a fenced claim, releasing claims
// for retry (pre- and post-provider-boundary), deferring or terminalizing
// ambiguous outcomes, and finalizing a staged result into the artifact.
// Claim reservation/fencing lives in note-verification-claim-reservation.ts;
// recovery in note-verification-claim-recovery.ts.
import { and, eq, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { artifact, note_verification_claim } from '@/db/schema';

import { isNoteArtifactType } from './note-artifact-types';
import {
  NOTE_VERIFICATION_PROVIDER_ATTEMPT_LIMIT,
  type NoteVerificationLease,
  type StagedNoteVerification,
  StagedNoteVerificationSchema,
  artifactEpochIsCurrent,
  discardReservedNoteVerificationClaim,
  failArtifactVerificationForEpoch,
  leasePredicate,
} from './note-verification-claim-reservation';

const CLAIM_RETRY_DELAY_MS = 30_000;

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
