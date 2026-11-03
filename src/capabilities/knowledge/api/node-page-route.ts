// Single node read: one server-side aggregate replaces the old client-side full
// scans. Read-only; unknown, archived or learner-hidden ids are 404.

import { readLearnerKnowledgeNodePage } from '@/capabilities/knowledge/server/learner-knowledge-request';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    return Response.json(await readLearnerKnowledgeNodePage(db, params));
  } catch (err) {
    return errorResponse(err);
  }
}
