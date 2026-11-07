// Streams asset bytes from R2 behind the normal x-internal-token gate; the UI
// fetches a blob, so no presigned URL or client-side secret is needed.
//
// Frozen JS assets are served inert as text/plain with nosniff and a sandbox CSP,
// because same-origin text/javascript would run agent code with origin privileges.

import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { source_asset } from '@/db/schema';
import { ApiError, errorResponse } from '@/kernel/http';
import { getR2 } from '@/kernel/object-storage';

/** 可在本站按原 mime 直接渲染的位图类型（不含 svg：svg 可携带脚本）。 */
const DISPLAYABLE_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp',
]);

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
        provenance: source_asset.provenance,
      })
      .from(source_asset)
      .where(eq(source_asset.id, id))
      .limit(1);
    if (!row) throw new ApiError('not_found', `asset ${id} not found`, 404);

    // Drawing-owned assets carry their own spec identity (source_kind, drg_
    // id prefix, reserved storage prefix, drawing_id provenance) — refuse any
    // of them before the 304/bytes path so the generic surface can never
    // bypass the owner/lifecycle/source gate on GET /api/drawings/[id]/asset.
    // Absence is indistinguishable: 404, no oracle.
    if (
      row.provenance?.source_kind === 'drawing_svg' ||
      row.id.startsWith('drg_') ||
      row.storage_key.startsWith('assets/drawing-svg/') ||
      typeof row.provenance?.drawing_id === 'string'
    ) {
      throw new ApiError('not_found', `asset ${id} not found`, 404);
    }

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

    // 安全裁决：只有已知的位图类型按存储 mime 原样返回；JS 代码
    // 资产按惰性字节服务（text/plain + CSP sandbox，宿主页 fetch 后校验 digest
    // 再注入沙箱 iframe）；其余一切（html / svg / xhtml / 未知类型）一律按下载
    // 处理，绝不在本站以可执行或可渲染的类型返回。nosniff 全部都带。
    const codeAssetMime =
      row.mime_type === 'text/javascript' || row.mime_type === 'application/javascript';
    // YUK-1548 §2.3 — only rows written by the svg_figure immutable writer
    // (provenance + svf_ id + reserved storage prefix) may serve SVG inline.
    // Every other SVG stays a download. The bytes are already rebuilt from the
    // allowlist at compose time; CSP + nosniff keep direct-open inert.
    const svgFigure =
      row.mime_type === 'image/svg+xml' &&
      row.provenance?.source_kind === 'svg_figure' &&
      /^svf_[0-9a-f]{32}$/.test(row.id) &&
      row.storage_key.startsWith('assets/svg-figure/');
    const displayableImage = DISPLAYABLE_IMAGE_MIMES.has(row.mime_type);
    const servedHeaders: Record<string, string> = svgFigure
      ? {
          'Content-Type': 'image/svg+xml',
          'Content-Security-Policy': "sandbox; default-src 'none'",
        }
      : codeAssetMime
        ? {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Security-Policy': "sandbox; default-src 'none'",
          }
        : displayableImage
          ? { 'Content-Type': row.mime_type }
          : {
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': 'attachment',
              'Content-Security-Policy': "sandbox; default-src 'none'",
            };
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        ...servedHeaders,
        'Content-Length': String(row.byte_size),
        ...cacheHeaders,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
