// Learner-scoped drawing asset serve: the SAME ownership/expiry/retraction
// gate as the status read runs before any byte or 304 leaves. The generic
// /api/assets content route refuses drawing-owned assets, so this is the only
// path a drawing SVG reaches the browser — a withdrawn drawing is dead here
// even on a cached etag.

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { getR2 } from '@/kernel/object-storage';
import { readDrawingAsset } from '../server/drawing-service';
import { DrawingSessionQuerySchema } from './contracts';

function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((candidate) => {
    const tag = candidate.trim();
    return tag === '*' || tag === etag || tag === `W/${etag}`;
  });
}

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
    // Authorization BEFORE the cache path: ownership + expiry + retraction /
    // epoch fence, then ready-state. Any failure is a plain 404 — state is
    // never an oracle.
    const asset = await readDrawingAsset(db, id, parsed.data.session_id);
    if (!asset) throw new ApiError('not_found', `drawing ${id} not found`, 404);

    const etag = `"${asset.sha256}"`;
    const cacheHeaders = {
      ETag: etag,
      'Cache-Control': 'private, max-age=60',
      'X-Content-Type-Options': 'nosniff',
    };
    if (matchesIfNoneMatch(req.headers.get('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers: cacheHeaders });
    }
    const bytes = await getR2().get(asset.storage_key);
    if (!bytes) throw new ApiError('not_found', `drawing ${id} bytes missing`, 404);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': 'image/svg+xml',
        'Content-Length': String(asset.byte_size),
        'Content-Security-Policy': "sandbox; default-src 'none'",
        ...cacheHeaders,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
