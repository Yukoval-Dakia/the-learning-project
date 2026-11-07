import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { cancelDrawing } from '../server/drawing-service';
import { DrawingSessionQuerySchema } from './contracts';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const { id } = params;
    if (!id) throw new ApiError('validation_error', 'drawing id is required', 400);
    const raw = await req.json().catch(() => null);
    const parsed = DrawingSessionQuerySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError('validation_error', 'session_id body field is required', 400);
    }
    const view = await cancelDrawing(db, id, parsed.data.session_id);
    if (!view) throw new ApiError('not_found', `drawing ${id} not found`, 404);
    return Response.json(view);
  } catch (err) {
    return errorResponse(err);
  }
}
