import { KnowledgeTreeQuerySchema } from '@/capabilities/knowledge/api/contracts';
import { loadTreeSnapshot } from '@/capabilities/knowledge/server/tree';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

export async function GET(
  req: Request = new Request('http://localhost/api/knowledge'),
): Promise<Response> {
  try {
    const parsed = KnowledgeTreeQuerySchema.safeParse({
      subject: new URL(req.url).searchParams.get('subject') ?? undefined,
    });
    if (!parsed.success) return Response.json({ error: 'validation_error' }, { status: 400 });
    const rows = await loadTreeSnapshot(db, parsed.data.subject);
    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}
