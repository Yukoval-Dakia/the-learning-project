// Learner-facing tree and node-page reads for both front doors (HTTP and Start).
// The snapshot keeps synthetic seed scaffolding for internal jobs; this is the
// one place the learner boundary hides it.
import type { ReviewTimingJson } from '@/core/schema/learner-judgment';
import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { loadTreeSnapshot } from '@/kernel/read-models/knowledge-graph';
import { readLearnerJudgments } from '@/kernel/read-models/learner-judgment';
import { isLearnerVisibleKnowledgeId } from '@/kernel/read-models/learner-knowledge-visibility';
import { reviewTimingJson } from '@/kernel/read-models/review-timing';
import {
  KnowledgeIdParamsSchema,
  KnowledgeNodePageQuerySchema,
  KnowledgeTreeQuerySchema,
} from '../api/contracts';
import { loadKnowledgeNodePage } from './node-page';

type TreeRows = Array<
  Awaited<ReturnType<typeof loadTreeSnapshot>>[number] & {
    review_timing: {
      freshness: Pick<ReviewTimingJson['freshness'], 'decay_bucket'>;
    } | null;
  }
>;

/** `invalid_query` keeps the tree route's code-only 400 envelope at the door. */
export async function readLearnerKnowledgeTree(
  db: Db,
  rawQuery: unknown,
): Promise<{ ok: true; rows: TreeRows } | { ok: false; error: 'invalid_query' }> {
  const parsed = KnowledgeTreeQuerySchema.safeParse(rawQuery);
  if (!parsed.success) return { ok: false, error: 'invalid_query' };
  const rows = await loadTreeSnapshot(db, parsed.data.subject);
  const visibleRows = rows.filter((row) => isLearnerVisibleKnowledgeId(row.id));
  const judgments = await readLearnerJudgments(db, {
    knowledge_ids: visibleRows.map((row) => row.id),
    context: 'any',
    as_of: new Date(),
  });
  const byId = new Map(judgments.items.map((item) => [item.knowledge_id, item]));
  return {
    ok: true,
    rows: visibleRows.map((row) => {
      const item = byId.get(row.id);
      return {
        ...row,
        review_timing: item
          ? {
              freshness: {
                decay_bucket: reviewTimingJson(item.review_timing).freshness.decay_bucket,
              },
            }
          : null,
      };
    }),
  };
}

/** Hidden, missing and archived nodes are all the same 404. */
export async function readLearnerKnowledgeNodePage(
  db: Db,
  rawParams: unknown,
  rawQuery: unknown = {},
) {
  const parsed = KnowledgeIdParamsSchema.safeParse(rawParams);
  if (!parsed.success) {
    throw new ApiError('validation_error', 'knowledge id is required', 400);
  }
  const query = KnowledgeNodePageQuerySchema.safeParse(rawQuery);
  if (!query.success) throw new ApiError('validation_error', 'invalid activity query', 400);
  const page = await loadKnowledgeNodePage(db, parsed.data.id, query.data.timeline_cursor);
  if (!page) {
    throw new ApiError('not_found', `knowledge ${parsed.data.id} not found`, 404);
  }
  return page;
}
