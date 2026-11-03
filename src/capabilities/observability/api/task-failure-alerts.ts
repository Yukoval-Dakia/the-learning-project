import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { loadTaskFailureAlerts } from '../server/task-failure-alerts';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await loadTaskFailureAlerts(db));
  } catch (err) {
    return errorResponse(err);
  }
}
