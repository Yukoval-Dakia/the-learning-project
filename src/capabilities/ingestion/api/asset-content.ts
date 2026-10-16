// Phase 1c.2.C — GET /api/assets/[id]/content streams the raw asset bytes
// back from R2 so the browser can render the source image inside the vision
// review UI without exposing R2 directly.
//
// The route is still behind the x-internal-token gate (middleware.ts matches
// all /api/*); the UI fetches via apiFetch → Blob → URL.createObjectURL so
// the auth header rides naturally. We don't generate a presigned R2 URL —
// keeps the single-user secret on the server.
//
// YUK-1497 (K5 custom block): the same route serves frozen JS code assets
// (stored mime_type text/javascript) for the sandboxed custom block; the page
// fetches the bytes, verifies SHA-256 against the presentation digest and only
// then injects them into a sandboxed iframe. nosniff keeps the stored
// mime_type authoritative — the browser must never sniff executable content.

import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { source_asset } from '@/db/schema';
import { ApiError, errorResponse } from '@/kernel/http';
import { getR2 } from '@/server/r2';

function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((candidate) => {
    const tag = candidate.trim();
    return tag === '*' || tag === etag || tag === `W/${etag}`;
  });
}

export async function GET(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const id = params.id;
    const [row] = await db
      .select({
        id: source_asset.id,
        storage_key: source_asset.storage_key,
        mime_type: source_asset.mime_type,
        byte_size: source_asset.byte_size,
        sha256: source_asset.sha256,
      })
      .from(source_asset)
      .where(eq(source_asset.id, id))
      .limit(1);
    if (!row) throw new ApiError('not_found', `asset ${id} not found`, 404);

    const etag = `"${row.sha256}"`;
    const cacheHeaders = {
      ETag: etag,
      'Cache-Control': 'private, max-age=60',
      // 存储的 mime_type 是唯一真相 —— 禁止浏览器嗅探成可执行/可渲染的别的类型。
      'X-Content-Type-Options': 'nosniff',
    };
    if (matchesIfNoneMatch(req.headers.get('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers: cacheHeaders });
    }

    const bytes = await getR2().get(row.storage_key);
    if (!bytes) throw new ApiError('not_found', `asset ${id} bytes missing from R2`, 404);

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': row.mime_type,
        'Content-Length': String(row.byte_size),
        ...cacheHeaders,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
