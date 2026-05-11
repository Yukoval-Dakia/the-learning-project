import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { streamReviewTask } from '@/server/knowledge/review';
import { anthropic } from '@ai-sdk/anthropic';

export const runtime = 'nodejs';

export async function POST(): Promise<Response> {
  try {
    const model = anthropic('claude-sonnet-4-6');
    return await streamReviewTask({ db, model });
  } catch (err) {
    return errorResponse(err);
  }
}
