import {
  type EmitArtifactLifecycleParams,
  emitArtifactLifecycleEvent,
} from '@/capabilities/notes/server/artifacts/mutation-events';
import type { NoteVerificationResultT } from '@/core/schema/business';
import type { Tx } from '@/db/client';

type NoteVerificationStatus = 'verified' | 'needs_review' | 'failed';

type EmitNoteVerificationLifecycleParams = {
  readonly artifactId: string;
  readonly status: NoteVerificationStatus;
  readonly nextVersion: number;
  readonly actorKind: 'agent' | 'system';
  readonly actorRef: string;
  readonly createdAt: Date;
  readonly summary?: NoteVerificationResultT;
  readonly verifiedBy?: EmitArtifactLifecycleParams['verifiedBy'];
  readonly taskRunId?: string | null;
  readonly costMicroUsd?: number | null;
};

export async function emitNoteVerificationLifecycleEvent(
  tx: Tx,
  params: EmitNoteVerificationLifecycleParams,
): Promise<void> {
  await emitArtifactLifecycleEvent(tx, {
    subjectId: params.artifactId,
    op: 'set_verification_status',
    verificationStatus: params.status,
    nextVersion: params.nextVersion,
    actorKind: params.actorKind,
    actorRef: params.actorRef,
    createdAt: params.createdAt,
    ...(params.summary !== undefined ? { verificationSummary: params.summary } : {}),
    ...(params.verifiedBy !== undefined ? { verifiedBy: params.verifiedBy } : {}),
    ...(params.taskRunId !== undefined ? { taskRunId: params.taskRunId } : {}),
    ...(params.costMicroUsd !== undefined ? { costMicroUsd: params.costMicroUsd } : {}),
  });
}
