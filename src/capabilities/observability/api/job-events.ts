import { db } from '@/db/client';
import { jobEventStreamResponse } from '@/server/events/sse_router';
import { JOB_EVENT_KIND_SET } from './event-contracts';

// Preserve the route's existing cadence exports; the stream owner runs the timers.
export { JOB_EVENT_CATCHUP_MS, JOB_EVENT_HEARTBEAT_MS } from '@/server/events/sse_router';

// Generic SSE tracker for job_events, keyed by business kind and id. The stream
// owner replays Last-Event-ID, serializes live and durable catch-up, and sends
// heartbeat comments. Business terminal events do not close the stream; the client
// closes it through request abort or response-body cancellation.
//
// `kind` comes from the caller, so an allowlist is required: otherwise any
// authenticated caller could subscribe to any business table. Add new writers to
// the event contract or their stream gets a 400.
export async function GET(req: Request, params: Record<string, string>): Promise<Response> {
  const businessTable = params.kind;
  const businessId = params.id;

  if (!businessTable || !businessId) {
    return new Response(JSON.stringify({ error: 'missing kind or id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!JOB_EVENT_KIND_SET.has(businessTable)) {
    return new Response(JSON.stringify({ error: 'unknown kind' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return jobEventStreamResponse(db, req, { businessTable, businessId }, 'job-tracker');
}
