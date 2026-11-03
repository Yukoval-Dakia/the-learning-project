import { readLearnerKnowledgeTree } from '@/capabilities/knowledge/server/learner-knowledge-request';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

export async function GET(
  req: Request = new Request('http://localhost/api/knowledge'),
): Promise<Response> {
  try {
    const read = await readLearnerKnowledgeTree(db, {
      subject: new URL(req.url).searchParams.get('subject') ?? undefined,
    });
    if (!read.ok) return Response.json({ error: 'validation_error' }, { status: 400 });
    return Response.json({ rows: read.rows });
  } catch (err) {
    return errorResponse(err);
  }
}
