import type { Db } from '@/db/client';
import { getR2 } from '@/kernel/object-storage';
import { persistImageAsset } from '@/kernel/records/asset-store';
import { renderPdfToPngPages } from './pdf-render';
import { extractPdfTextLayers } from './pdf-text';
import { pdfPageImageProvenance, preparePdfSourceAssets } from './source-package';

/**
 * Expands one validated PDF upload into ordered page assets with source provenance.
 * Rendering, text extraction and source persistence precede sequential page writes.
 * Failures propagate without rollback: assets already persisted remain available
 * for content-addressed reuse. The caller owns multipart validation and HTTP output.
 */
export async function expandPdfUpload(
  db: Db,
  pdfBytes: Uint8Array,
  signal: AbortSignal,
): Promise<{ assetIds: string[]; pageCount: number }> {
  // Corrupt, encrypted, empty, over-cap, timed-out, or oversized pages are 400.
  // signal aborts cooperatively between page renders on client disconnect.
  const pages = await renderPdfToPngPages(pdfBytes, signal);

  const r2 = getR2();

  // The original PDF and each text layer become SHA'd assets; page-image stamps
  // let session creation assemble the source package without a contract change.
  const textLayers = await extractPdfTextLayers(pdfBytes, signal);
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
  return { assetIds, pageCount: pages.length };
}
