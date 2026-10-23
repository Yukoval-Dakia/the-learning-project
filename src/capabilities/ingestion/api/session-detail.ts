import { errorResponse } from '@/kernel/http';
import { readIngestionSessionDetail } from '../server/session-detail';

/** GET /api/ingestion-sessions/:id — readable target for creation Location headers. */
export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    return Response.json(await readIngestionSessionDetail(params.id));
  } catch (error) {
    return errorResponse(error);
  }
}
