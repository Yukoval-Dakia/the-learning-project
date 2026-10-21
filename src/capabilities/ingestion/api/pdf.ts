import { renderPdfToPngPages } from '@/capabilities/ingestion/server/pdf-render';
import { extractPdfTextLayers } from '@/capabilities/ingestion/server/pdf-text';
import {
  pdfPageImageProvenance,
  preparePdfSourceAssets,
} from '@/capabilities/ingestion/server/source-package';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { persistImageAsset } from '@/kernel/records/asset-store';
import { getR2 } from '@/server/r2';

// PDF expansion: one upload renders into page images persisted through the shared
// content-addressed asset path. The page rows are ordinary images, so the rest of
// the pipeline needs no special case.
//
// Rendering runs in the route because the user is waiting; the render timeout and
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
    // Corrupt, encrypted, empty, over-cap, timed-out, or oversized pages are 400.
    // req.signal aborts cooperatively between page renders on client disconnect.
    const pages = await renderPdfToPngPages(pdfBytes, req.signal);

    const r2 = getR2();

    // The original PDF and each text layer become SHA'd assets; page-image stamps
    // let session creation assemble the source package without a contract change.
    const textLayers = await extractPdfTextLayers(pdfBytes, req.signal);
    const { stamps } = await preparePdfSourceAssets(db, r2, { pdfBytes, textLayers });

    const assetIds: string[] = [];
    // Sequential so page order is preserved; content addressing dedups re-renders.
    for (const [index, page] of pages.entries()) {
      const row = await persistImageAsset(db, r2, {
        bytes: page.png,
        mime: 'image/png',
        provenance: pdfPageImageProvenance(stamps[index]),
      });
      assetIds.push(row.id);
    }

    const headers = new Headers();
    headers.set('Location', `/api/assets/${encodeURIComponent(assetIds[0])}/content`);
    for (const assetId of assetIds) {
      headers.append('Link', `</api/assets/${encodeURIComponent(assetId)}/content>; rel="item"`);
    }
    return Response.json(
      { asset_ids: assetIds, page_count: pages.length },
      { status: 201, headers },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
