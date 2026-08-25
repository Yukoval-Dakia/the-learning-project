import { loadTreeSnapshot } from '@/capabilities/knowledge/server/tree';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { isLearnerVisibleKnowledgeId } from '@/kernel/read-models/learner-knowledge-visibility';

export async function GET(): Promise<Response> {
  try {
    const rows = await loadTreeSnapshot(db);
    // YUK-897 — learner-facing projection: the shared snapshot intentionally
    // retains synthetic:* seed scaffolding for internal jobs; exclusion happens
    // here, at the API boundary, after snapshot enrichment.
    const learnerRows = rows.filter((r) => isLearnerVisibleKnowledgeId(r.id));
    return Response.json({ rows: learnerRows });
  } catch (err) {
    return errorResponse(err);
  }
}
