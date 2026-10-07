import type { z } from 'zod';
import type { Db } from '@/db/client';
import { ApiError, collectionPayload } from '@/kernel/http';
import { resolveSubjectKnowledgeIds } from '@/kernel/read-models/knowledge-tree';
import { listMistakeProjectionPage } from '@/server/records/mistakes';
import { MistakeListQuerySchema, type MistakeListResponse } from '../api/contracts';

export type MistakeListQuery = z.input<typeof MistakeListQuerySchema>;

/** Shared read operation for HTTP and server consumers; validates before querying. */
export async function readMistakes(
  db: Db,
  input: MistakeListQuery = {},
): Promise<MistakeListResponse> {
  const parsed = MistakeListQuerySchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ApiError('validation_error', message, 400);
  }
  const query = parsed.data;
  const limit = Math.min(Math.max(query.limit ? Number.parseInt(query.limit, 10) : 50, 1), 200);
  const subjectKnowledgeIds = query.subject
    ? await resolveSubjectKnowledgeIds(db, query.subject)
    : undefined;
  const page = await listMistakeProjectionPage(db, {
    limit,
    since: query.since ? new Date(query.since) : undefined,
    questionIds: query.question_id ? [query.question_id] : undefined,
    subjectKnowledgeIds,
    cursor: query.cursor,
  });
  return collectionPayload(page.rows, { limit, next_cursor: page.next_cursor }, page);
}
