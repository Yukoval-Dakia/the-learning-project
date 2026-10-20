import {
  deleteImageAsset,
  isUniqueViolation,
  lockImageStorageKey,
  persistImageAsset,
  persistSourceAsset,
  sha256Hex,
} from '@/kernel/records/asset-store';
import { type R2Client, getR2 } from '@/server/r2';

// YUK-1571 — the shared content-addressed source_asset write protocol now
// lives in src/kernel/records/asset-store.ts (ingestion and the practice
// jyeoo supply lane share the same object-key lock and row lifecycle).
// The type forward below stays transparent (type-only, not a value site);
// the six runtime re-exports are coordinator-approved temporary
// compatibility sites (YUK-1571, window ends UTC 2026-11-03): consumers
// keep their import paths until the exit slice repoints them and the
// shims retire.
export type { SourceAssetRow } from '@/kernel/records/asset-store';
export type { R2Client };
// Re-exported so capability modules reach the blob client through this seam
// (the file already holds the ingestion -> r2 boundary edge); new files must
// not import '@/server/r2' directly.
export {
  deleteImageAsset,
  getR2,
  isUniqueViolation,
  lockImageStorageKey,
  persistImageAsset,
  persistSourceAsset,
  sha256Hex,
};
