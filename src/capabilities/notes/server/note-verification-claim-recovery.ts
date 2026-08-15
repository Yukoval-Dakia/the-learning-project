// Recovery query/preparation for the note verification state machine: selecting
// which claims are recoverable (ordered by availability), and per-claim
// preparation — epoch reset, expired-lease repair, cap terminalization, and
// result promotion — before the job redoes or finalizes them.
// Claim reservation/fencing lives in note-verification-claim-reservation.ts;
// result persistence/finalization in note-verification-claim-result.ts.
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { artifact, note_verification_claim } from '@/db/schema';

import { NOTE_ARTIFACT_TYPES, isNoteArtifactType } from './note-artifact-types';
import {
  NOTE_VERIFICATION_PROVIDER_ATTEMPT_LIMIT,
  failArtifactVerificationForEpoch,
  parseStaged,
} from './note-verification-claim-reservation';

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
