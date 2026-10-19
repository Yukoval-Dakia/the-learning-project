// YUK-1528 — the print page's fixed geometry, in page millimetres (layout doc §1–§2).
// CSS (worksheet-print.css) uses the same numbers; the paginator and the plan read them here.

export type SheetOrientation = 'portrait' | 'landscape';

export const SHEET_MM: Record<SheetOrientation, { w: number; h: number }> = {
  portrait: { w: 210, h: 297 },
  landscape: { w: 297, h: 210 },
};

/** Content column width: portrait body, and the landscape question column (passage on the left). */
export const COLUMN_MM: Record<SheetOrientation, number> = {
  portrait: 162,
  landscape: 113.7,
};

/** Inset of the marks inside a writing panel, on every side. */
export const PANEL_INSET_MM = 4;

/** Vertical gap between blocks in a page body (CSS `--ws-gap`). */
export const BLOCK_GAP_MM = 3.4;

/** A writing panel is never cut into a piece shorter than this. */
export const MIN_SEGMENT_MM = 30;

/** Kept free at the bottom of every body so sub-pixel rounding can never push a block out. */
export const BODY_SAFETY_MM = 0.6;

/** Ruled-line pitch and the 5mm grid / dot pitch used by the marks. */
export const RULE_PITCH_MM = 8;
export const GRID_PITCH_MM = 5;
