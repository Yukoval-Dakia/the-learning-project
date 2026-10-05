import { createKnowledgeNodeFromEvents } from '@/capabilities/knowledge/public';
import type { Tx } from '@/db/client';

export function subjectRootId(subjectId: string): string {
  return `seed:${subjectId}:root`;
}

/** Idempotent subject root birth. Existing roots are never rewritten or given replacement history. */
export async function ensureSubjectRoot(
  tx: Tx,
  subjectId: string,
  displayName: string,
): Promise<{ created: boolean; rootId: string }> {
  const rootId = subjectRootId(subjectId);
  const created = await createKnowledgeNodeFromEvents(
    tx,
    {
      id: rootId,
      name: displayName,
      domain: subjectId,
      parent_id: null,
      proposed_by_ai: false,
      created_at: new Date(),
    },
    { actorRef: 'subject-root-create' },
    'skip',
  );
  return { created, rootId };
}
