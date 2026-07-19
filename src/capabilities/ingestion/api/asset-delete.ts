import { deleteImageAsset } from '@/capabilities/ingestion/server/persist-image-asset';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { getR2 } from '@/server/r2';

export async function DELETE(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const id = params.id;
    const deleted = await deleteImageAsset(db, getR2(), id);
    if (!deleted) throw new ApiError('not_found', `asset ${id} not found`, 404);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
