import type { Db, Tx } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { isLearnerVisibleKnowledgeId } from '@/kernel/read-models/learner-knowledge-visibility';
import { KnowledgeEdgeQuerySchema } from '../api/contracts';
import { type KnowledgeEdgePage, listKnowledgeEdgesPage } from './edges';

/** Learner filter does not recompute the cursor: it still names the last unfiltered row. */
export async function readKnowledgeEdges(
  db: Db | Tx,
  rawQuery: unknown,
): Promise<KnowledgeEdgePage> {
  const parsed = KnowledgeEdgeQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ApiError('validation_error', message, 400);
  }
  const page = await listKnowledgeEdgesPage(db, {
    from: parsed.data.from,
    to: parsed.data.to,
    relation_type: parsed.data.relation_type,
    subject: parsed.data.subject,
    includeArchived: parsed.data.include_archived,
    limit: parsed.data.limit,
    cursor: parsed.data.cursor,
  });
  return {
    rows: page.rows.filter(
      (edge) =>
        isLearnerVisibleKnowledgeId(edge.from_knowledge_id) &&
        isLearnerVisibleKnowledgeId(edge.to_knowledge_id),
    ),
    next_cursor: page.next_cursor,
  };
}
