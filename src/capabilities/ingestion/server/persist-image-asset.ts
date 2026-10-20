import { type R2Client, getR2 } from '@/server/r2';

// YUK-1571 — the shared content-addressed source_asset write protocol now
// lives in src/kernel/records/asset-store.ts (ingestion and the practice
// jyeoo supply lane share the same object-key lock and row lifecycle).
// The type forward below stays transparent (type-only, not a value site);
// the six temporary runtime re-exports retired in the YUK-1571 compat-exit
// slice — every consumer now imports the kernel module directly.
export type { SourceAssetRow } from '@/kernel/records/asset-store';
export type { R2Client };
// Re-exported so capability modules reach the blob client through this seam
// (the file already holds the ingestion -> r2 boundary edge); new files must
// not import '@/server/r2' directly.
export { getR2 };
