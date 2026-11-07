import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { readDrawingStatus } from '../server/drawing-service';
import { DrawingSessionQuerySchema } from './contracts';

export async function GET(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const { id } = params;
    if (!id) throw new ApiError('validation_error', 'drawing id is required', 400);
    const url = new URL(req.url);
    const parsed = DrawingSessionQuerySchema.safeParse({
      session_id: url.searchParams.get('session_id') ?? '',
    });
    if (!parsed.success) {
      throw new ApiError('validation_error', 'session_id query parameter is required', 400);
    }
    const view = await readDrawingStatus(db, id, parsed.data.session_id);
    // Ownership miss is indistinguishable from absence — no cross-learner leak.
    if (!view) throw new ApiError('not_found', `drawing ${id} not found`, 404);
    return Response.json(view);
  } catch (err) {
    return errorResponse(err);
  }
}
