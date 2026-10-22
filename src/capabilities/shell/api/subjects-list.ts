import { loadLearnerSubjects } from '@/capabilities/shell/server/subjects-list';
import { errorResponse } from '@/kernel/http';

export async function GET(): Promise<Response> {
  try {
    const { db } = await import('@/db/client');
    return Response.json(await loadLearnerSubjects(db));
  } catch (err) {
    return errorResponse(err);
  }
}
