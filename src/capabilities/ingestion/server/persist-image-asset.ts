import { type R2Client, getR2 } from '@/server/r2';

// The shared content-addressed source_asset protocol lives in the kernel asset
// store, shared with the practice supply lane. The type forward stays transparent;
// runtime consumers import the kernel module directly.
export type { SourceAssetRow } from '@/kernel/records/asset-store';
export type { R2Client };
// Re-exported so capability modules reach the blob client through this seam
// (the file already holds the ingestion -> r2 boundary edge); new files must
// not import '@/server/r2' directly.
export { getR2 };
