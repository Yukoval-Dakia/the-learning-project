import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { ImmutableAssetDeleteForbiddenError, deleteImageAsset } from '@/kernel/records/asset-store';
import { getR2 } from '@/server/r2';

export async function DELETE(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const id = params.id;
    const deleted = await deleteImageAsset(db, getR2(), id);
    if (!deleted) throw new ApiError('not_found', `asset ${id} not found`, 404);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof ImmutableAssetDeleteForbiddenError) {
      return errorResponse(new ApiError(err.code, err.message, 409));
    }
    return errorResponse(err);
  }
}
