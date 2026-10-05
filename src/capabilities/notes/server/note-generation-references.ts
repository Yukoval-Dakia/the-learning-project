import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { ArtifactBodyBlocksT } from '@/core/schema/business';
import type { Db, Tx } from '@/db/client';
import { artifact } from '@/db/schema';
import { bodyBlocksToBlockSummaries } from './body-blocks';
import { NOTE_ARTIFACT_TYPES } from './note-artifact-types';

export interface NoteGenerationReference {
  artifact_id: string;
  title: string;
  artifact_type: string;
  generation_status: string;
  blocks: Array<{ id: string; text_excerpt: string }>;
}

/** Bounded real targets from the current note family/labels, never model-authored IDs. */
export async function loadNoteGenerationReferences(
  db: Db,
  note: {
    id: string;
    parent_artifact_id: string | null;
    knowledge_ids: string[];
  },
): Promise<NoteGenerationReference[]> {
  const scope = [eq(artifact.parent_artifact_id, note.id)];
  if (note.parent_artifact_id)
    scope.push(
      eq(artifact.id, note.parent_artifact_id),
      eq(artifact.parent_artifact_id, note.parent_artifact_id),
    );
  for (const id of note.knowledge_ids)
    scope.push(sql`${artifact.knowledge_ids} @> ${JSON.stringify([id])}::jsonb`);
  const rows = await db
    .select({
      id: artifact.id,
      title: artifact.title,
      type: artifact.type,
      generation_status: artifact.generation_status,
      body_blocks: artifact.body_blocks,
    })
    .from(artifact)
    .where(
      and(
        ne(artifact.id, note.id),
        inArray(artifact.type, NOTE_ARTIFACT_TYPES),
        isNull(artifact.archived_at),
        or(...scope),
      ),
    )
    .orderBy(asc(artifact.id))
    .limit(12);
  return rows.map((row) => ({
    artifact_id: row.id,
    title: row.title.slice(0, 160),
    artifact_type: row.type,
    generation_status: row.generation_status,
    blocks: bodyBlocksToBlockSummaries(row.body_blocks, 80)
      .filter((block): block is typeof block & { id: string } => typeof block.id === 'string')
      .slice(0, 8)
      .map((block) => ({ id: block.id, text_excerpt: block.text_excerpt })),
  }));
}

/** Short commit fence, never held across the provider call. Source and bounded
 * supplied targets share one sorted lock order, including mutually linked notes. */
export async function lockCurrentNoteGenerationReferences(
  tx: Tx,
  sourceId: string,
  references: NoteGenerationReference[],
): Promise<NoteGenerationReference[]> {
  const rows = await tx
    .select()
    .from(artifact)
    .where(inArray(artifact.id, [sourceId, ...references.map((ref) => ref.artifact_id)]))
    .orderBy(asc(artifact.id))
    .for('update');
  return rows
    .filter(
      (row) =>
        row.id !== sourceId &&
        row.archived_at === null &&
        (NOTE_ARTIFACT_TYPES as readonly string[]).includes(row.type),
    )
    .map((row) => ({
      artifact_id: row.id,
      title: row.title,
      artifact_type: row.type,
      generation_status: row.generation_status,
      // Check existence against the whole current body, not a fresh first-eight
      // preview which could hide an originally supplied block after reordering.
      blocks: bodyBlocksToBlockSummaries(row.body_blocks, 0)
        .filter((block): block is typeof block & { id: string } => typeof block.id === 'string')
        .map((block) => ({ id: block.id, text_excerpt: '' })),
    }));
}

/** Validate before the ready transaction so an invented reference is never indexed. */
export function assertNoteGenerationReferences(
  body: ArtifactBodyBlocksT,
  references: NoteGenerationReference[],
): void {
  const targets = new Map(references.map((reference) => [reference.artifact_id, reference]));
  const visit = (node: Record<string, unknown>) => {
    const attrs = (node.attrs ?? {}) as Record<string, unknown>;
    if (node.type === 'crossLinkBlock' || node.type === 'artifactRefBlock') {
      const target =
        typeof attrs.artifact_id === 'string' ? targets.get(attrs.artifact_id) : undefined;
      if (!target) throw new Error('note generation reference is outside supplied context');
      if (attrs.block_id != null && !target.blocks.some((block) => block.id === attrs.block_id))
        throw new Error('note generation block reference is outside supplied context');
    }
    if (node.type === 'questionRefBlock')
      throw new Error('note generation has no supplied question reference context');
    if (Array.isArray(node.content)) for (const child of node.content) visit(child);
  };
  for (const node of body.content) visit(node);
}
