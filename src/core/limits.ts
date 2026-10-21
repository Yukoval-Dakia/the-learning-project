// Cross-cutting ingestion limits, shared so the route and renderer cannot drift.
// Pure, so the SPA and route Zod can import it without pulling PDFium into their graphs.

// Each page is base64-sent to OCR and the VLM, so cost and latency scale linearly.
export const MAX_PDF_PAGES = 15;

// DOCX renders through LibreOffice→PDF→PDFium and shares the same page ceiling.
export const MAX_DOCX_PAGES = MAX_PDF_PAGES;

// DOCX is compressed XML plus media; even media-heavy exams stay well below this.
export const MAX_DOCX_UPLOAD_BYTES = 20_000_000;

// Single source for the practice reasoning-trace bound across schemas, route contract,
// write-side truncation and UI. Pure leaf so the browser can read it without the event
// schema bundle (moved out of known.ts per PR #1069 review).
export const REASONING_TRACE_MAX_LEN = 4000;

// Enforced by the generic asset route and the DOCX embedded-media path, so an image
// inside an under-cap DOCX cannot diverge from the standalone upload limit.
export const MAX_IMAGE_UPLOAD_BYTES = 8_000_000;

// Copilot conversation auto-reuse age ceiling for both the server predicate and the UI
// bootstrap. Lives here (pure leaf) to avoid a server→capability deep import or the
// public-export module cycle.
export const COPILOT_REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;
