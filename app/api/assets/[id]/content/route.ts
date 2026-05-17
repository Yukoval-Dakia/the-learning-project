// Phase 1c.2.C — GET /api/assets/[id]/content streams the raw asset bytes
// back from R2 so the browser can render the source image inside the vision
// review UI without exposing R2 directly.
//
// The route is still behind the x-internal-token gate (middleware.ts matches
// all /api/*); the UI fetches via apiFetch → Blob → URL.createObjectURL so
// the auth header rides naturally. We don't generate a presigned R2 URL —
// keeps the single-user secret on the server.

import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { source_asset } from '@/db/schema';
import { ApiError, errorResponse } from '@/server/http/errors';
import { getR2 } from '@/server/r2';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const [row] = await db
      .select({
        id: source_asset.id,
        storage_key: source_asset.storage_key,
        mime_type: source_asset.mime_type,
        byte_size: source_asset.byte_size,
      })
      .from(source_asset)
      .where(eq(source_asset.id, id))
      .limit(1);
    if (!row) throw new ApiError('not_found', `asset ${id} not found`, 404);

    const bytes = await getR2().get(row.storage_key);
    if (!bytes) throw new ApiError('not_found', `asset ${id} bytes missing from R2`, 404);

    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': row.mime_type,
        'Content-Length': String(row.byte_size),
        'Cache-Control': 'private, max-age=60',
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
