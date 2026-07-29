interface DbAffectedSelection {
  schema_version: 1;
  partition: 'db';
  requested_mode: 'skip' | 'affected' | 'full';
  effective_mode: 'affected' | 'full';
  fallback_reason?: string;
  base: string;
  changed_files: string[];
  predicted_files: string[] | null;
}

export const DB_FAILURE_SENTINEL_TESTS: string[];
export function findSourceScanningDbTests(input: {
  dbFiles: string[];
  root: string;
}): string[];
export function findDynamicImportDbTests(input: {
  dbFiles: string[];
  root: string;
}): string[];
export function mergeDbPredictedFiles(input: {
  graphPredictedFiles: string[];
  sourceScanningDbTests: string[];
  dynamicImportDbTests: string[];
  dbFiles: string[];
}): { predictedFiles: string[]; failureSentinelTests: string[] };
export function findDirectChangedDbTestMisses(input: {
  changedFiles: string[];
  predictedFiles: string[];
  dbFiles: string[];
}): { directChangedDbTests: string[]; misses: string[] };
export function resolveRequiredDbFiles(selection: unknown): string[] | null;
export function parseShard(
  value: string | undefined,
): { index: number; count: number; value: string } | null;
export function shouldSkipAffectedShard(
  selectedFileCount: number,
  shard: { index: number; count: number; value: string },
): boolean;
export function selectAffectedDbTests(input: {
  root: string;
  base: string;
  requestedMode: string;
  output: string;
}): DbAffectedSelection;
