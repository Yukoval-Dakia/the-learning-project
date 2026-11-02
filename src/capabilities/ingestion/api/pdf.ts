import { expandPdfUpload } from '@/capabilities/ingestion/server/pdf-upload-operation';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';

// PDF expansion: one upload renders into page images persisted through the shared
// content-addressed asset path. The page rows are ordinary images, so the rest of
// the pipeline needs no special case.
//
// Rendering remains synchronous because the user is waiting; the render timeout and
// page cap bound the worst case to one loud failure rather than a hang.

// Source-PDF cap, larger than the per-image cap because a scanned exam can exceed
// it. The per-image cap stays unchanged.
const MAX_PDF_UPLOAD_BYTES = 30_000_000;

export async function POST(req: Request): Promise<Response> {
  try {
    const form = await req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) {
      throw new ApiError('validation_error', 'file is required', 400);
    }
    // Accept application/pdf or an empty type with a .pdf filename (drag-and-drop).
    // Not the security gate: the renderer validates the %PDF magic bytes.
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
    const { assetIds, pageCount } = await expandPdfUpload(db, pdfBytes, req.signal);

    const headers = new Headers();
    headers.set('Location', `/api/assets/${encodeURIComponent(assetIds[0])}/content`);
    for (const assetId of assetIds) {
      headers.append('Link', `</api/assets/${encodeURIComponent(assetId)}/content>; rel="item"`);
    }
    return Response.json({ asset_ids: assetIds, page_count: pageCount }, { status: 201, headers });
  } catch (err) {
    return errorResponse(err);
  }
}
