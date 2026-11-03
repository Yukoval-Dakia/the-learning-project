// Sole body commit for note artifacts, on the caller's transaction: locked read,
// version bump, history entry, CAS UPDATE, backlink index, then the paired fold
// events. Row and events are built from one after-state and one timestamp, so the
// artifact fold reproduces the row exactly. Row lock only; never takes an
// advisory lock (hub-sync and presence order advisory → row).

import { type SQL, and, eq } from 'drizzle-orm';

import {
  type ArtifactLifecycleOp,
  emitArtifactBodyBlocksEditEvent,
  emitArtifactLifecycleEvent,
} from '@/capabilities/notes/server/artifacts/mutation-events';
import { syncBlockRefsForArtifact } from '@/capabilities/notes/server/block-refs';
import {
  ArtifactBodyBlocks,
  type ArtifactBodyBlocksT,
  type ArtifactHistoryEntryT,
} from '@/core/schema/business';
import type { Tx } from '@/db/client';
import { artifact } from '@/db/schema';
import { nextProjectionEventTime } from '@/kernel/events';

export interface ArtifactBodyBase {
  type: string;
  version: number;
  body_blocks: ArtifactBodyBlocksT | null;
  history: ArtifactHistoryEntryT[];
  attrs: Record<string, unknown>;
  generation_status: string;
  verification_status: string;
  archived_at: Date | null;
}

export interface ArtifactBodyChange {
  body: ArtifactBodyBlocksT;
  /** Appended entry; version, at and the version pair are stamped here. */
  history?: {
    by: Record<string, unknown>;
    summary_md: string;
    action: string;
    fields?: Record<string, unknown>;
  };
  /** Columns that move with the body, carried by one lifecycle event. */
  lifecycle?: {
    op: Extract<ArtifactLifecycleOp, 'set_generation_status' | 'set_verification_status'>;
    generationStatus?: string;
    verificationStatus?: string;
    generatedBy?: Record<string, unknown>;
    attrs?: Record<string, unknown>;
  };
  actor: {
    kind: 'user' | 'agent';
    ref: string;
    taskRunId?: string | null;
    costMicroUsd?: number | null;
  };
  eventId?: string;
  optOutMemoryIngestion: boolean;
}

export interface ArtifactBodyCommitParams<S> {
  artifactId: string;
  /** Extra row guard, applied to both the locked read and the CAS UPDATE. */
  where?: SQL;
  /** Wall-clock request; the stream watermark may move it forward. */
  requestedAt?: Date;
  /** Decide on the locked row: the change to commit, or a caller-defined skip. */
  plan: (
    base: ArtifactBodyBase,
    next: { version: number; at: Date },
  ) => ArtifactBodyChange | { skip: S } | Promise<ArtifactBodyChange | { skip: S }>;
}

export type ArtifactBodyCommitResult<S> =
  | {
      status: 'committed';
      previousVersion: number;
      version: number;
      body: ArtifactBodyBlocksT;
      historyAfter: ArtifactHistoryEntryT[];
      eventId: string;
      at: Date;
    }
  | { status: 'skipped'; reason: S; base: ArtifactBodyBase }
  /** No row matched the id and guard. */
  | { status: 'missing' }
  /** The CAS UPDATE matched nothing despite the lock. */
  | { status: 'conflict' };

export async function commitArtifactBody<S = never>(
  tx: Tx,
  params: ArtifactBodyCommitParams<S>,
): Promise<ArtifactBodyCommitResult<S>> {
  const { artifactId } = params;
  const rowGuard = params.where
    ? and(eq(artifact.id, artifactId), params.where)
    : eq(artifact.id, artifactId);
  const rows = await tx
    .select({
      type: artifact.type,
      version: artifact.version,
      body_blocks: artifact.body_blocks,
      history: artifact.history,
      attrs: artifact.attrs,
      generation_status: artifact.generation_status,
      verification_status: artifact.verification_status,
      archived_at: artifact.archived_at,
    })
    .from(artifact)
    .where(rowGuard)
    .for('update')
    .limit(1);
  const row = rows[0];
  if (!row) return { status: 'missing' };
  const base: ArtifactBodyBase = {
    ...row,
    body_blocks: row.body_blocks ?? null,
    history: Array.isArray(row.history) ? row.history : [],
    attrs: row.attrs ?? {},
  };

  // Under the row lock, so this commit folds after every earlier artifact event
  // even when a previous writer used the same or a later clock.
  const at = await nextProjectionEventTime(
    tx,
    'artifact',
    artifactId,
    params.requestedAt ?? new Date(),
  );
  const version = base.version + 1;
  const decision = await params.plan(base, { version, at });
  if ('skip' in decision) return { status: 'skipped', reason: decision.skip, base };

  const body = ArtifactBodyBlocks.parse(decision.body);
  const historyAfter: ArtifactHistoryEntryT[] = decision.history
    ? [
        ...base.history,
        {
          version,
          at,
          by: decision.history.by as ArtifactHistoryEntryT['by'],
          summary_md: decision.history.summary_md,
          action: decision.history.action,
          previous_artifact_version: base.version,
          next_artifact_version: version,
          ...decision.history.fields,
        },
      ]
    : base.history;
  const lifecycle = decision.lifecycle;

  const updated = await tx
    .update(artifact)
    .set({
      body_blocks: body as never,
      history: historyAfter as never,
      ...(lifecycle?.generationStatus !== undefined
        ? { generation_status: lifecycle.generationStatus }
        : {}),
      ...(lifecycle?.verificationStatus !== undefined
        ? { verification_status: lifecycle.verificationStatus }
        : {}),
      ...(lifecycle?.generatedBy !== undefined
        ? { generated_by: { ...lifecycle.generatedBy } as never }
        : {}),
      ...(lifecycle?.attrs !== undefined ? { attrs: lifecycle.attrs as never } : {}),
      version,
      updated_at: at,
    })
    .where(and(rowGuard, eq(artifact.version, base.version)))
    .returning({ id: artifact.id });
  if (updated.length !== 1) return { status: 'conflict' };

  await syncBlockRefsForArtifact(tx, artifactId, body);

  const { actor } = decision;
  const eventId = await emitArtifactBodyBlocksEditEvent(tx, {
    subjectId: artifactId,
    eventId: decision.eventId,
    previousArtifactVersion: base.version,
    nextArtifactVersion: version,
    bodyBlocks: body,
    previousBodyBlocks: base.body_blocks,
    historyAfter,
    actorKind: actor.kind,
    actorRef: actor.ref,
    taskRunId: actor.taskRunId ?? null,
    costMicroUsd: actor.costMicroUsd ?? null,
    createdAt: at,
    optOutMemoryIngestion: decision.optOutMemoryIngestion,
  });
  if (lifecycle) {
    await emitArtifactLifecycleEvent(tx, {
      subjectId: artifactId,
      op: lifecycle.op,
      generationStatus: lifecycle.generationStatus,
      verificationStatus: lifecycle.verificationStatus,
      generatedBy: lifecycle.generatedBy,
      attrs: lifecycle.attrs,
      nextVersion: version,
      actorKind: actor.kind,
      actorRef: actor.ref,
      taskRunId: actor.taskRunId ?? null,
      costMicroUsd: actor.costMicroUsd ?? null,
      createdAt: at,
    });
  }

  return {
    status: 'committed',
    previousVersion: base.version,
    version,
    body,
    historyAfter,
    eventId,
    at,
  };
}
