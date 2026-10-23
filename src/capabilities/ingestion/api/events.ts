import { db } from '@/db/client';
import { jobEventStreamResponse } from '@/server/events/sse_router';

/**
 * GET /api/ingestion/[id]/events — ingestion notification-driven SSE.
 * The stream owner replays Last-Event-ID and handles live notifications, errors
 * and request abort. This profile keeps concurrent notification replays without
 * tracker heartbeats, periodic catch-up or a response-body cancel hook.
 * The business table is fixed; the generic job route owns its kind/id allowlist.
 */
export async function GET(req: Request, params: Record<string, string>): Promise<Response> {
  return jobEventStreamResponse(
    db,
    req,
    { businessTable: 'ingestion_session', businessId: params.id },
    'ingestion-notify',
  );
}
