import { db } from '@/db/client';
import { getAdminRunTimeline } from '@/server/admin/ai-observability';
import { errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const detail = await getAdminRunTimeline(db, id);
    if (!detail) {
      return Response.json({ error: 'not_found', message: `no run ${id}` }, { status: 404 });
    }
    return Response.json(detail);
  } catch (err) {
    return errorResponse(err);
  }
}
