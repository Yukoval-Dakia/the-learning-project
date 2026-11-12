import { db } from '@/db/client';
import { readBacktrace } from '../server/backtrace-read';
import { requestBacktraceRepair } from '../server/backtrace-subscription';
export async function GET(_req: Request, params: Record<string, string>) {
  const result = await readBacktrace(db, { attempt_event_id: params.attemptEventId });
  if (result.status === 'pending_insight' || result.status === 'judging')
    await requestBacktraceRepair(db, params.attemptEventId);
  return Response.json(result);
}
