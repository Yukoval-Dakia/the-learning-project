import { notesForKnowledge } from '@/capabilities/notes/server/notes-read';
import type { Db } from '@/db/client';

/** Maximum paid note-refine jobs one successful review may fan out (YUK-694). */
export const MAX_NOTE_REFINE_FANOUT = 8;

/** Resolve a deterministic, deduplicated, bounded set of note-refine targets. */
export async function collectMasteryRefineTargets(
  db: Db,
  sourceRef: string | null,
  knowledgeIds: string[],
): Promise<string[]> {
  const targets = new Set<string>();
  if (sourceRef) targets.add(sourceRef);

  // Bound both label queries and rows per query. The final Set ceiling is the
  // load-bearing paid-job cap; the query caps keep target discovery bounded too.
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
  return [...targets];
}
