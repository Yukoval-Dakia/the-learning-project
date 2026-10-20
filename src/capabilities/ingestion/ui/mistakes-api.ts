import { apiOperationJson } from '@/ui/lib/api';
import { type MistakeListResponse, MistakeListResponseSchema } from '../api/contracts';

export type { MistakeListResponse, MistakeProjection } from '../api/contracts';

/** Browser transport for the existing mistakes GET; no server imports. */
export async function listMistakes(input: {
  limit: number;
  subject?: string;
  questionId?: string;
  cursor?: string;
}): Promise<MistakeListResponse> {
  const query = new URLSearchParams({ limit: String(input.limit) });
  if (input.subject) query.set('subject', input.subject);
  if (input.questionId) query.set('question_id', input.questionId);
  if (input.cursor) query.set('cursor', input.cursor);
  return MistakeListResponseSchema.parse(
    await apiOperationJson('listMistakes', { url: `/api/mistakes?${query}`, method: 'GET' }),
  );
}
