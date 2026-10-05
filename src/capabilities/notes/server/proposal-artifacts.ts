import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { artifact } from '@/db/schema';
import { requireLaterProposalCorrection } from '@/kernel/proposals/types';
import { emitArtifactLifecycleEvent } from './artifacts/mutation-events';

/** Archive a proposal's still-live artifacts atomically with its correction. */
export async function archiveProposalArtifacts(
  tx: Tx,
  input: { proposalId: string; archivedAt: Date },
): Promise<void> {
  const rows = await tx
    .select()
    .from(artifact)
    .where(and(eq(artifact.source_ref, input.proposalId), isNull(artifact.archived_at)))
    .orderBy(asc(artifact.id))
    .for('update');
  if (rows.length === 0) return;
  // The shared retract owner retries the whole correction transaction if a note
  // edit won while we waited. Never backdate archive or rewrite a committed event.
  requireLaterProposalCorrection(
    input.archivedAt,
    new Date(Math.max(...rows.map((row) => row.updated_at.getTime()))),
  );
  for (const row of rows) {
    // Invalidate writers that read before this lock and later CAS on version.
    const nextVersion = row.version + 1;
    await tx
      .update(artifact)
      .set({ archived_at: input.archivedAt, updated_at: input.archivedAt, version: nextVersion })
      .where(eq(artifact.id, row.id));
    await emitArtifactLifecycleEvent(tx, {
      subjectId: row.id,
      op: 'archive',
      archivedAt: input.archivedAt,
      nextVersion,
      actorKind: 'user',
      actorRef: 'self',
      causedByEventId: input.proposalId,
      createdAt: input.archivedAt,
    });
  }
}
