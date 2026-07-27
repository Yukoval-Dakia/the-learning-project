import type { Db, Tx } from '@/db/client';
import { artifact } from '@/db/schema';
import { and, inArray, isNull } from 'drizzle-orm';
import { notesForKnowledge } from './notes-read';

/** Maximum paid note-refine jobs one mastery-progress event may fan out. */
export const MAX_NOTE_REFINE_FANOUT = 8;
type DbLike = Db | Tx;

/**
 * Resolve the notes owned by this capability for one mastery-progress event.
 *
 * `sourceArtifactId` preserves the direct source-note edge even when the source
 * note is not labelled with the emitted KC. Label lookups and the final result
 * are both bounded by the paid-job ceiling.
 */
export async function collectMasteryRefineTargets(
  db: DbLike,
  sourceArtifactId: string | null,
  knowledgeIds: string[],
): Promise<string[]> {
  const targets = new Set<string>();
  if (sourceArtifactId) targets.add(sourceArtifactId);

  const uniqueKnowledgeIds = [...new Set(knowledgeIds)].slice(0, MAX_NOTE_REFINE_FANOUT);
  const noteBatches = await Promise.all(
    uniqueKnowledgeIds.map((knowledgeId) =>
      notesForKnowledge(db, knowledgeId, { limit: MAX_NOTE_REFINE_FANOUT }),
    ),
  );
  for (const notes of noteBatches) {
    for (const note of notes) {
      targets.add(note.id);
      if (targets.size >= MAX_NOTE_REFINE_FANOUT) break;
    }
    if (targets.size >= MAX_NOTE_REFINE_FANOUT) break;
  }
  const candidates = [...targets].slice(0, MAX_NOTE_REFINE_FANOUT);
  if (candidates.length === 0) return [];

  const liveNotes = await db
    .select({ id: artifact.id })
    .from(artifact)
    .where(
      and(
        inArray(artifact.id, candidates),
        inArray(artifact.type, ['note_atomic', 'note_hub', 'note_long']),
        isNull(artifact.archived_at),
      ),
    );
  const liveIds = new Set(liveNotes.map((row) => row.id));
  return candidates.filter((id) => liveIds.has(id));
}
