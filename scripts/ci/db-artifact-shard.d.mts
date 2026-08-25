export interface DbShardManifestLike {
  mode: 'affected' | 'full';
  digest_sha256: string;
  workspace: { manifest_path: string };
  source: { head: string };
  shards: { assignments: Array<{ shard: number; files: string[] }> };
}

export interface DbManifestViolationInput {
  code: string;
  message: string;
}

export interface DbShardPlan {
  action: 'execute-manifest' | 'full-fallback' | 'fail';
  fallbackReason: string | null;
}

export interface DbShardSelectorReport {
  status: 'verified' | 'fallback' | 'failed';
  digest_sha256: string | null;
  manifest_path: string | null;
  manifest_source_head: string | null;
  fallback_reason: string | null;
  expected_skip: boolean;
}

export interface DbShardMergedReport {
  schema_version: number;
  partition: string;
  status?: string;
  reason?: string;
  violations?: DbManifestViolationInput[];
  shard: string;
  skipped_empty_shard: boolean;
  workspace_root?: string;
  selector: DbShardSelectorReport;
  consistency_violation: string | null;
  merged_at?: string;
  created_at?: string;
  [key: string]: unknown;
}

export const FALLBACK_VIOLATION_CODES: Set<string>;
export const DEFAULT_ARTIFACT_STEP: string;

export function classifyDbManifestViolations(
  violations: DbManifestViolationInput[],
): 'fallback' | 'corrupt';
export function planShardExecution(input: {
  manifestState: 'missing' | 'present';
  violations: DbManifestViolationInput[];
}): DbShardPlan;
export function expectedSkipForShard(
  manifest: DbShardManifestLike | null,
  shardIndex: number,
): boolean;
export function mergeExecutionReport(input: {
  runExecution: Record<string, unknown>;
  manifest: DbShardManifestLike | null;
  plan: DbShardPlan;
  shard: { index: number; count: number; value: string };
  workspaceRoot: string;
  now?: Date;
}): { report: DbShardMergedReport; drift: boolean };
