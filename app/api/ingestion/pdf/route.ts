import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { renderPdfToPngPages } from '@/capabilities/ingestion/server/pdf-render';
import { persistImageAsset } from '@/capabilities/ingestion/server/persist-image-asset';
import { getR2 } from '@/server/r2';

export const runtime = 'nodejs';

// PDF expansion endpoint (YUK-250). Takes ONE PDF multipart upload, renders it
// to N PNG page images, persists each via the SHARED content-addressed
// image-asset write path (the same helper /api/assets uses), and returns the
// produced asset ids. After this, the page assets are plain kind='image' rows —
// byte-identical in contract to a photo — so the rest of the ingestion pipeline
// (session create → Tencent/VLM extract worker) needs zero changes.
//
// Render runs synchronously in the route handler (not the pg-boss worker): the
// user is actively waiting at the upload UI, a 1–15 page render is sub-10s, and
// keeping the renderer out of scripts/worker.ts keeps the worker bundle
// untouched. The 30s render timeout + 15-page cap (in pdf-render.ts) bound the
// worst case to one loud failure, not a hang.

// Source-PDF upload cap — larger than the 8 MB per-image cap because a 15-page
// scanned exam can exceed that. Local to this route; the /api/assets per-image
// cap stays 8 MB. (Next App Router route handlers have no framework body limit;
// this app constant is the only gate.)
const MAX_PDF_UPLOAD_BYTES = 30_000_000;

export async function POST(req: Request): Promise<Response> {
  try {
    const form = await req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) {
      throw new ApiError('validation_error', 'file is required', 400);
    }
    // Accept the canonical application/pdf, plus an empty type when the filename
    // ends in .pdf — browsers send '' for drag-and-drop / some OS pickers even
    // for genuine PDFs (mirrors the client isPdf fallback). This is not the
    // security gate: renderPdfToPngPages validates the %PDF magic bytes and 400s
    // a misnamed non-PDF, so a wrong-extension file is still rejected loudly.
    const isPdfMime =
      file.type === 'application/pdf' ||
      (file.type === '' && file.name.toLowerCase().endsWith('.pdf'));
    if (!isPdfMime) {
      throw new ApiError('validation_error', `unsupported mime_type: ${file.type}`, 400);
    }
    if (file.size <= 0) {
      throw new ApiError('validation_error', 'PDF 文件为空', 400);
    }
    if (file.size > MAX_PDF_UPLOAD_BYTES) {
      throw new ApiError(
        'validation_error',
        `PDF 超过 ${MAX_PDF_UPLOAD_BYTES / 1_000_000} MB 上限`,
        400,
      );
    }

    const pdfBytes = new Uint8Array(await file.arrayBuffer());
    // Throws ApiError('validation_error', <中文>, 400) for corrupt / encrypted /
    // zero-page / over-cap / timeout / oversized-page.
    const pages = await renderPdfToPngPages(pdfBytes);

    const r2 = getR2();
    const assetIds: string[] = [];
    // Sequential so page order is preserved in asset_ids (page_index downstream
    // is array-index-driven). Content-addressed dedup: re-rendering the same PDF
    // page yields the same storage_key.
    for (const page of pages) {
      const row = await persistImageAsset(db, r2, { bytes: page.png, mime: 'image/png' });
      assetIds.push(row.id);
    }

    return Response.json({ asset_ids: assetIds, page_count: pages.length }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
