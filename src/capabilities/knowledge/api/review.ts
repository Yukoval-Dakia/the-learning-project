// KnowledgeReviewTask HTTP entrypoint.
//
// 2026-05-17: dropped the `@ai-sdk/anthropic` model handle. The agent
// runtime + provider routing now live in streamReviewTask, which calls
// streamTask → Claude Agent SDK → xiaomi/mimo per Provider Manager.

import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { streamReviewTask } from '@/capabilities/knowledge/server/review';


export async function POST(): Promise<Response> {
  try {
    return await streamReviewTask({ db });
  } catch (err) {
    return errorResponse(err);
  }
}
