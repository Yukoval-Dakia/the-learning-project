import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { redrawDrawing } from '../server/drawing-service';
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
    const view = await redrawDrawing(db, id, parsed.data.session_id);
    if (!view) throw new ApiError('not_found', `drawing ${id} not found`, 404);
    if ('status' in view && view.status === 'refused') {
      throw new ApiError(
        'restricted_source',
        view.issues[0]?.detail ?? 'drawing sources no longer allow derivation',
        422,
      );
    }
    return Response.json(view);
  } catch (err) {
    return errorResponse(err);
  }
}
