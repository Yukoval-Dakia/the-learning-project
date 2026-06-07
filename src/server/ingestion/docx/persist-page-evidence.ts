import { MAX_DOCX_PAGES, MAX_PDF_PAGES } from '@/core/limits';
import type { Db } from '@/db/client';
import { renderPdfToPngPages } from '@/server/ingestion/pdf-render';
import { persistImageAsset } from '@/server/ingestion/persist-image-asset';
import type { R2Client } from '@/server/r2';

import type { DocxConverter } from './convert';

// renderPdfToPngPages enforces MAX_PDF_PAGES internally; the docx evidence path
// relies on that cap being the docx cap too. Assert the equivalence at module
// load so a future divergence (someone bumps one constant) fails loudly here
// rather than silently letting an over-cap docx through the renderer's PDF cap.
if (MAX_DOCX_PAGES !== MAX_PDF_PAGES) {
  throw new Error(
    `persist-page-evidence: MAX_DOCX_PAGES (${MAX_DOCX_PAGES}) must equal MAX_PDF_PAGES (${MAX_PDF_PAGES})`,
  );
}

// YUK-258 — 原图同步存储不变式 (owner 铁律, BOTH lines execute this).
//
// Every uploaded .docx is rendered once via LibreOffice→PDF→PDFium into page
// images persisted as source_asset rows:
//   - 视觉线: the page images ARE the extract input (fed to tencent_ocr_extract).
//   - 文本线: blocks come from pandoc markdown; the page images are evidence only
//     (VLM 兜底 / 人工 review 时有图可读).
//
// Reuses #332全套 unchanged: renderPdfToPngPages (PDFium, 30s timeout + 15-page
// cap) + persistImageAsset (content-addressed SHA-256 → R2 + source_asset row).
// MAX_DOCX_PAGES is provably equal to MAX_PDF_PAGES so the cap carries over.

export interface PageEvidence {
  /** source_asset row ids, in page order. */
  assetIds: string[];
  pageCount: number;
}

/**
 * Render the docx to evidence page images and persist them.
 *
 * Throws `ApiError('validation_error', <中文>, 400)` for conversion timeout
 * (from the converter seam) or PDF render failure / over-cap (from
 * renderPdfToPngPages — MAX_DOCX_PAGES === MAX_PDF_PAGES so the page-cap message
 * is the PDF one). The caller's try/catch → errorResponse turns these into 400s.
 */
export async function persistDocxPageEvidence(
  db: Db,
  r2: R2Client,
  converter: DocxConverter,
  docxBytes: Uint8Array,
): Promise<PageEvidence> {
  const pdfBytes = await converter.docxToPdf(docxBytes);
  // renderPdfToPngPages enforces the page cap (MAX_PDF_PAGES === MAX_DOCX_PAGES,
  // asserted at module load) and the 30s render timeout; it throws ApiError(400)
  // on over-cap / corrupt.
  const pages = await renderPdfToPngPages(pdfBytes);

  const assetIds: string[] = [];
  // Sequential so page order is preserved in asset_ids (page_index downstream is
  // array-index-driven). Content-addressed dedup at the R2 layer.
  for (const page of pages) {
    const row = await persistImageAsset(db, r2, { bytes: page.png, mime: 'image/png' });
    assetIds.push(row.id);
  }

  return { assetIds, pageCount: pages.length };
}
