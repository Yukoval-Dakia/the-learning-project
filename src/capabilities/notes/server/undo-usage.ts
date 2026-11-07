// Reference answers notes owes the inbox's batch-undo guard.
//
// Two owners ask: knowledge (does a live note carry this node as a label?) and
// agency (are the notes a learning-item retract would archive untouched, and does
// any note outside the group reference them?). Both are notes facts — the artifact
// rows, the note write history and the block references — so they are answered
// here instead of being re-derived by the caller.
//
// The artifact version is the only write-path-independent witness. Every
// note_generate body commit advances it by exactly one; any other body write
// (refine apply, refine undo, presence flush, hub auto sync, learner edit) also
// advances it without adding a whitelisted event. So equal counts prove every
// write came from generation, and any future writer is blocked by construction.

import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { artifact, artifact_block_ref } from '@/db/schema/artifacts';

type DbLike = Db | Tx;

/** note_generate owns these body writes; they are not learner edits. */
const NOTE_GENERATE_EDIT_ACTORS: ReadonlySet<string> = new Set([
  'note_generate',
  'note_generate_retry',
  'note_generate_fallback',
]);

/** Live notes whose `knowledge_ids` carry the node as a label. */
export async function knowledgeNodesWithNoteLabels(
  db: DbLike,
  nodeIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const wanted = new Set(nodeIds);
  if (wanted.size === 0) return new Set();
  const rows = await db
    .select({ knowledgeIds: artifact.knowledge_ids })
    .from(artifact)
    .where(
      and(
        isNull(artifact.archived_at),
        or(
          ...[...wanted].map(
            (id) => sql`${artifact.knowledge_ids} @> jsonb_build_array(${id}::text)`,
          ),
        ),
      ),
    );
  const used = new Set<string>();
  for (const row of rows) {
    for (const id of row.knowledgeIds ?? []) {
      if (wanted.has(id)) used.add(id);
    }
  }
  return used;
}

export interface ProposalNoteUndoFacts {
  readonly artifactById: ReadonlyMap<
    string,
    {
      readonly sourceRef: string | null;
      readonly archivedAt: Date | null;
      readonly version: number;
    }
  >;
  readonly artifactIdsByProposal: ReadonlyMap<string, readonly string[]>;
  /** Note ids whose version disagrees with the generation body-write count. */
  readonly editedArtifactIds: ReadonlySet<string>;
  /** Note id → ids of notes outside the proposal that reference it. */
  readonly inboundRefsByTarget: ReadonlyMap<string, readonly string[]>;
}

/**
 * Everything a note-carrying retract must check: the artifacts the proposal
 * minted (plus each item's primary artifact), their write history and inbound
 * block references.
 */
export async function readProposalNoteUndoFacts(
  db: DbLike,
  input: { proposalIds: readonly string[]; primaryArtifactIds: readonly string[] },
): Promise<ProposalNoteUndoFacts> {
  const artifacts = await db
    .select({
      id: artifact.id,
      sourceRef: artifact.source_ref,
      archivedAt: artifact.archived_at,
      version: artifact.version,
    })
    .from(artifact)
    .where(
      or(
        inArray(artifact.source_ref, [...input.proposalIds]),
        input.primaryArtifactIds.length > 0
          ? inArray(artifact.id, [...input.primaryArtifactIds])
          : undefined,
      ),
    );
  const artifactById = new Map(
    artifacts.map((row) => [
      row.id,
      { sourceRef: row.sourceRef, archivedAt: row.archivedAt, version: row.version },
    ]),
  );
  const artifactIdsByProposal = new Map<string, string[]>();
  for (const row of artifacts) {
    if (!row.sourceRef) continue;
    const list = artifactIdsByProposal.get(row.sourceRef);
    if (list) list.push(row.id);
    else artifactIdsByProposal.set(row.sourceRef, [row.id]);
  }
  const allArtifactIds = [...new Set(artifacts.map((row) => row.id))];

  const editedArtifactIds = new Set<string>();
  if (allArtifactIds.length > 0) {
    const editRows = await db
      .select({
        artifactId: event.subject_id,
        actorKind: event.actor_kind,
        actorRef: event.actor_ref,
      })
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:body_blocks_edit'),
          eq(event.subject_kind, 'artifact'),
          inArray(event.subject_id, allArtifactIds),
        ),
      );
    const generationWrites = new Map<string, number>();
    for (const row of editRows) {
      if (row.actorKind !== 'agent') continue;
      if (!NOTE_GENERATE_EDIT_ACTORS.has(row.actorRef)) continue;
      generationWrites.set(row.artifactId, (generationWrites.get(row.artifactId) ?? 0) + 1);
    }
    for (const artifactId of allArtifactIds) {
      const row = artifactById.get(artifactId);
      if (!row) continue;
      if (row.version !== (generationWrites.get(artifactId) ?? 0)) {
        editedArtifactIds.add(artifactId);
      }
    }
  }

  const inboundRefsByTarget = new Map<string, string[]>();
  if (allArtifactIds.length > 0) {
    const refs = await db
      .select({
        fromArtifactId: artifact_block_ref.from_artifact_id,
        toArtifactId: artifact_block_ref.to_artifact_id,
      })
      .from(artifact_block_ref)
      .where(
        and(
          inArray(artifact_block_ref.to_artifact_id, allArtifactIds),
          ne(artifact_block_ref.from_artifact_id, artifact_block_ref.to_artifact_id),
        ),
      );
    for (const row of refs) {
      const list = inboundRefsByTarget.get(row.toArtifactId);
      if (list) list.push(row.fromArtifactId);
      else inboundRefsByTarget.set(row.toArtifactId, [row.fromArtifactId]);
    }
  }

  return { artifactById, artifactIdsByProposal, editedArtifactIds, inboundRefsByTarget };
}

/** Locks the artifact rows the notes archive applier will mutate, ascending id. */
export async function lockProposalNoteArtifacts(
  tx: Tx,
  input: { proposalId: string; primaryArtifactIds: readonly string[] },
): Promise<void> {
  if (input.primaryArtifactIds.length === 0) {
    await tx
      .select({ id: artifact.id })
      .from(artifact)
      .where(eq(artifact.source_ref, input.proposalId))
      .orderBy(artifact.id)
      .for('update');
    return;
  }
  await tx
    .select({ id: artifact.id })
    .from(artifact)
    .where(
      or(
        eq(artifact.source_ref, input.proposalId),
        inArray(artifact.id, [...input.primaryArtifactIds]),
      ),
    )
    .orderBy(artifact.id)
    .for('update');
}
