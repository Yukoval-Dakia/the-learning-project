import { KnowledgeTreeQuerySchema } from '@/capabilities/knowledge/api/contracts';
import { loadTreeSnapshot } from '@/capabilities/knowledge/server/tree';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { isLearnerVisibleKnowledgeId } from '@/kernel/read-models/learner-knowledge-visibility';

export async function GET(
  req: Request = new Request('http://localhost/api/knowledge'),
): Promise<Response> {
  try {
    const parsed = KnowledgeTreeQuerySchema.safeParse({
      subject: new URL(req.url).searchParams.get('subject') ?? undefined,
    });
    if (!parsed.success) return Response.json({ error: 'validation_error' }, { status: 400 });
    const rows = await loadTreeSnapshot(db, parsed.data.subject);
    // YUK-897 — learner-facing projection: the shared snapshot intentionally
    // retains synthetic:* seed scaffolding for internal jobs; exclusion happens
    // here, at the API boundary, after snapshot enrichment.
    const learnerRows = rows.filter((r) => isLearnerVisibleKnowledgeId(r.id));
    return Response.json({ rows: learnerRows });
  } catch (err) {
    return errorResponse(err);
  }
}
