// Cross-cutting ingestion limits — single source of truth so the PDF page cap
// and the /api/ingestion asset_ids array cap are provably equal (YUK-250).
//
// This module is pure (no IO, no heavy deps) so it can be imported by both the
// renderer (src/server/ingestion/pdf-render.ts) and the ingestion route Zod
// (src/capabilities/ingestion/api/sessions.ts) without dragging the PDFium WASM renderer into
// the ingestion route's bundle graph.

// A PDF expands to at most this many page images. Each page is sent base64 to
// BOTH Tencent OCR and the VLM downstream (tencent_ocr_extract.ts) — cost +
// latency scale linearly — so this is a hard, finite ceiling.
export const MAX_PDF_PAGES = 15;

// YUK-258 — DOCX ingestion caps. Every uploaded .docx (both text + visual line)
// is rendered once through LibreOffice→PDF→PDFium for evidence page images, so it
// shares the PDFium page ceiling. Kept provably equal to MAX_PDF_PAGES so the
// evidence render path can reuse renderPdfToPngPages' cap unchanged.
export const MAX_DOCX_PAGES = MAX_PDF_PAGES;

// Source-DOCX upload byte cap. Smaller than the 30 MB PDF cap because a .docx is
// XML + compressed media — even a media-heavy exam stays well under this. Route
// validates before any conversion spawn.
export const MAX_DOCX_UPLOAD_BYTES = 20_000_000;

// Per-image byte cap, single source of truth (YUK-250 limits pattern). Enforced
// by the generic asset upload route (src/capabilities/ingestion/api/assets.ts) and the DOCX
// embedded-media persist path (src/capabilities/ingestion/api/docx.ts) so an image
// embedded inside an under-cap .docx can't create a source_asset that diverges
// from the limit every other image path honours (codex-4).
export const MAX_IMAGE_UPLOAD_BYTES = 8_000_000;
