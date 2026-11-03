// Learner-facing tree and node-page reads for both front doors (HTTP and Start).
// The snapshot keeps synthetic seed scaffolding for internal jobs; this is the
// one place the learner boundary hides it.
import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { loadTreeSnapshot } from '@/kernel/read-models/knowledge-graph';
import { isLearnerVisibleKnowledgeId } from '@/kernel/read-models/learner-knowledge-visibility';
import { KnowledgeIdParamsSchema, KnowledgeTreeQuerySchema } from '../api/contracts';
import { loadKnowledgeNodePage } from './node-page';

type TreeRows = Awaited<ReturnType<typeof loadTreeSnapshot>>;

/** `invalid_query` keeps the tree route's code-only 400 envelope at the door. */
export async function readLearnerKnowledgeTree(
  db: Db,
  rawQuery: unknown,
): Promise<{ ok: true; rows: TreeRows } | { ok: false; error: 'invalid_query' }> {
  const parsed = KnowledgeTreeQuerySchema.safeParse(rawQuery);
  if (!parsed.success) return { ok: false, error: 'invalid_query' };
  const rows = await loadTreeSnapshot(db, parsed.data.subject);
  return { ok: true, rows: rows.filter((row) => isLearnerVisibleKnowledgeId(row.id)) };
}

/** Hidden, missing and archived nodes are all the same 404. */
export async function readLearnerKnowledgeNodePage(db: Db, rawParams: unknown) {
  const parsed = KnowledgeIdParamsSchema.safeParse(rawParams);
  if (!parsed.success) {
    throw new ApiError('validation_error', 'knowledge id is required', 400);
  }
  const page = await loadKnowledgeNodePage(db, parsed.data.id);
  if (!page) {
    throw new ApiError('not_found', `knowledge ${parsed.data.id} not found`, 404);
  }
  return page;
}
