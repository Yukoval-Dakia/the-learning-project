// YUK-95 P5 Lane-A (Wave 7 D2/D3) — pure helpers for the in-editor cross_link
// picker. Kept IO-free + framework-free so they can be unit-tested without a
// running TipTap editor or DB.
//
// The picker is the manual counterpart to Lane-C's nightly hub auto-sync: it
// lets the user insert a `crossLinkBlock` referencing another artifact. The
// node attrs are FLAT per ADR-0022 + Wave 7 D3 — `{ id, artifact_id, block_id?,
// title? }`, NOT nested under `attrs.cross_link`. On save, the existing
// `editArtifactBodyBlocks` → `syncBlockRefsForArtifact` (Lane-0) write-through
// keeps the `artifact_block_ref` L2 index in sync; this module never touches the
// index (XC-3).

import { newId } from '@/core/ids';
import { CROSS_LINK_BLOCK_NODE } from './types';

/** One row from `GET /api/artifacts/search`. */
export interface ArtifactSearchResult {
  id: string;
  title: string;
  type: string;
}

/** A selectable entry shown in the picker list. */
export interface CrossLinkPickerItem {
  artifact_id: string;
  title: string;
  type: string;
}

/** Flat `crossLinkBlock` attrs per ADR-0022 + Wave 7 D3. */
export interface CrossLinkBlockAttrs {
  id: string;
  artifact_id: string;
  block_id?: string;
  title?: string;
}

/** TipTap/ProseMirror JSON for a single `crossLinkBlock` atom node. */
export interface CrossLinkInsertContent {
  type: typeof CROSS_LINK_BLOCK_NODE;
  attrs: CrossLinkBlockAttrs;
}

/**
 * Map raw search rows → picker items. Drops rows missing an id (can't anchor a
 * cross-link target) and falls back to the id for a blank title so the list
 * never renders an empty label.
 */
export function mapSearchResultsToPickerItems(rows: ArtifactSearchResult[]): CrossLinkPickerItem[] {
  return rows
    .filter((row) => typeof row.id === 'string' && row.id.length > 0)
    .map((row) => ({
      artifact_id: row.id,
      title: row.title?.trim() ? row.title : row.id,
      type: row.type,
    }));
}

/**
 * Build the `crossLinkBlock` node JSON for a chosen picker item. Mints a fresh
 * block id (the node's own `attrs.id`, which becomes the `from_block_id` anchor
 * Lane-0 indexes) and writes flat attrs. `block_id` is optional (block-level
 * target); P5 Lane-A inserts an artifact-level link, so it is omitted unless a
 * caller supplies one.
 */
export function buildCrossLinkInsertContent(
  item: CrossLinkPickerItem,
  options: { blockId?: string; id?: string } = {},
): CrossLinkInsertContent {
  const attrs: CrossLinkBlockAttrs = {
    id: options.id ?? newId(),
    artifact_id: item.artifact_id,
    title: item.title,
  };
  if (options.blockId) attrs.block_id = options.blockId;
  return { type: CROSS_LINK_BLOCK_NODE, attrs };
}
