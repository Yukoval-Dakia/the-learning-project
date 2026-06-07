// Cross-cutting ingestion limits — single source of truth so the PDF page cap
// and the /api/ingestion asset_ids array cap are provably equal (YUK-250).
//
// This module is pure (no IO, no heavy deps) so it can be imported by both the
// renderer (src/server/ingestion/pdf-render.ts) and the ingestion route Zod
// (app/api/ingestion/route.ts) without dragging the PDFium WASM renderer into
// the ingestion route's bundle graph.

// A PDF expands to at most this many page images. Each page is sent base64 to
// BOTH Tencent OCR and the VLM downstream (tencent_ocr_extract.ts) — cost +
// latency scale linearly — so this is a hard, finite ceiling.
export const MAX_PDF_PAGES = 15;
