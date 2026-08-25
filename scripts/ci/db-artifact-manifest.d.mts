export interface DbManifestSource {
  head: string;
  tree: string;
  base: string;
  requested_mode: string;
  fallback_reason: string | null;
}

export interface DbManifestWorkspace {
  root: string;
  selection_path: string;
  manifest_path: string;
}

export interface DbManifestBuild {
  buildkite_build_number: string | null;
  pipeline_slug: string | null;
  branch: string | null;
}

export interface DbShardAssignment {
  shard: number;
  files: string[];
}

export interface DbShardPlan {
  count: number;
  assignment_strategy: string;
  assignments: DbShardAssignment[];
}

export interface DbArtifactManifest {
  schema_version: 1;
  partition: 'db';
  mode: 'affected' | 'full';
  source: DbManifestSource;
  workspace: DbManifestWorkspace;
  selected_files: string[];
  shards: DbShardPlan;
  build: DbManifestBuild | null;
  created_at: string;
  expires_at: string;
  digest_sha256: string;
}

export interface DbManifestViolation {
  code: string;
  message: string;
}

export interface DbLocalSelection {
  schema_version: 1;
  partition: 'db';
  requested_mode: string;
  effective_mode: 'affected' | 'full';
  fallback_reason?: string;
  base: string;
  changed_files: string[];
  predicted_files: string[] | null;
}

export const MANIFEST_SCHEMA_VERSION: 1;
export const MANIFEST_PARTITION: 'db';
export const MANIFEST_TTL_MS: number;
export const ASSIGNMENT_STRATEGY: string;

export function canonicalStringify(value: unknown): string;
export function computeManifestDigest(manifest: unknown): string;
export function buildShardAssignments(selectedFiles: string[], shardCount: number): DbShardPlan;
export function buildDbManifest(input: {
  selection: unknown;
  shardCount: number;
  workspace: { root: string; selectionPath: string; manifestPath: string };
  build: DbManifestBuild | null;
  head: string;
  tree: string;
  now: Date;
}): DbArtifactManifest;
export function validateDbManifest(
  manifest: unknown,
  input: {
    expectHead?: string;
    now?: Date;
    shardCount?: number | null;
  },
): { ok: boolean; violations: DbManifestViolation[] };
export function buildLocalSelection(
  manifest: DbArtifactManifest | null,
  fallbackReason?: string | null,
): DbLocalSelection;
