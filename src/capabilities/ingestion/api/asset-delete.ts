import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { source_asset } from '@/db/schema';
import { ApiError, errorResponse } from '@/server/http/errors';
import { getR2 } from '@/server/r2';

export async function DELETE(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const id = params.id;
    const [row] = await db.select().from(source_asset).where(eq(source_asset.id, id)).limit(1);
    if (!row) throw new ApiError('not_found', `asset ${id} not found`, 404);
    await getR2().delete(row.storage_key);
    await db.delete(source_asset).where(eq(source_asset.id, id));
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
