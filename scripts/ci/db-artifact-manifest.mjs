import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolveRequiredDbFiles } from './db-affected.mjs';

export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_PARTITION = 'db';
export const MANIFEST_TTL_MS = 24 * 60 * 60 * 1000;
export const ASSIGNMENT_STRATEGY = 'round_robin_sorted';

const FULL_SHA = /^[0-9a-f]{40}$/;
const MERGE_BASE_SHA = /^[0-9a-f]{7,64}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function computeManifestDigest(manifest) {
  const { digest_sha256: _digest, ...subject } = manifest ?? {};
  return createHash('sha256').update(canonicalStringify(subject)).digest('hex');
}

export function buildShardAssignments(selectedFiles, shardCount) {
  const files = [...selectedFiles].sort((a, b) => a.localeCompare(b));
  const assignments = Array.from({ length: shardCount }, (_, index) => ({
    shard: index + 1,
    files: [],
  }));
  files.forEach((file, index) => {
    assignments[index % shardCount].files.push(file);
  });
  return { count: shardCount, assignment_strategy: ASSIGNMENT_STRATEGY, assignments };
}

export function buildDbManifest({ selection, shardCount, workspace, build, head, tree, now }) {
  const selectedFiles = resolveRequiredDbFiles(selection) ?? [];
  const manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    partition: MANIFEST_PARTITION,
    mode: selectedFiles.length > 0 ? 'affected' : 'full',
    source: {
      head,
      tree,
      base: selection?.base ?? '',
      requested_mode: selection?.requested_mode ?? 'full',
      fallback_reason: selection?.fallback_reason ?? null,
    },
    workspace: {
      root: workspace.root,
      selection_path: workspace.selectionPath,
      manifest_path: workspace.manifestPath,
    },
    selected_files: selectedFiles,
    shards: buildShardAssignments(selectedFiles, shardCount),
    build,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + MANIFEST_TTL_MS).toISOString(),
  };
  return { ...manifest, digest_sha256: computeManifestDigest(manifest) };
}

function isSafeRepoTestFile(file) {
  return (
    typeof file === 'string' &&
    !path.isAbsolute(file) &&
    !file.startsWith('-') &&
    !file.split('/').includes('..') &&
    /\.test\.tsx?$/.test(file)
  );
}

function violation(code, message) {
  return { code, message };
}

export function validateDbManifest(manifest, { expectHead, now = new Date(), shardCount = null }) {
  const violations = [];
  if (manifest?.schema_version !== MANIFEST_SCHEMA_VERSION) {
    violations.push(violation('schema-version-unsupported', 'manifest schema_version must be 1'));
  }
  if (manifest?.partition !== MANIFEST_PARTITION) {
    violations.push(violation('partition-mismatch', 'manifest partition must be "db"'));
  }
  if (manifest?.mode !== 'affected' && manifest?.mode !== 'full') {
    violations.push(violation('mode-invalid', 'manifest mode must be "affected" or "full"'));
  }

  const source = manifest?.source ?? {};
  if (!FULL_SHA.test(source.head ?? '')) {
    violations.push(violation('source-head-malformed', 'source.head must be a full 40-hex sha'));
  }
  if (!FULL_SHA.test(source.tree ?? '')) {
    violations.push(violation('source-tree-malformed', 'source.tree must be a full 40-hex sha'));
  }
  if (typeof source.base !== 'string' || !MERGE_BASE_SHA.test(source.base)) {
    violations.push(violation('source-base-malformed', 'source.base must be a git sha'));
  }

  for (const [field, value] of Object.entries(manifest?.workspace ?? {})) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      violations.push(
        violation('workspace-path-not-absolute', `workspace.${field} must be absolute`),
      );
    }
  }

  const selectedFiles = Array.isArray(manifest?.selected_files) ? manifest.selected_files : [];
  for (const file of selectedFiles) {
    if (!isSafeRepoTestFile(file)) {
      violations.push(
        violation('selected-file-unsafe', `selected file is not a safe repo test path`),
      );
    }
  }
  if (manifest?.mode === 'affected' && selectedFiles.length === 0) {
    violations.push(
      violation(
        'mode-affected-empty-selection',
        'affected mode requires at least one selected file',
      ),
    );
  }

  const shards = manifest?.shards ?? {};
  const assignments = Array.isArray(shards.assignments) ? shards.assignments : [];
  const coverage = new Map();
  let assignmentsComplete = Number.isInteger(shards.count) && shards.count >= 1;
  assignmentsComplete &&= assignments.length === shards.count;
  assignmentsComplete &&= assignments.every(
    (assignment, index) => assignment?.shard === index + 1 && Array.isArray(assignment.files),
  );
  if (assignmentsComplete) {
    for (const assignment of assignments) {
      for (const file of assignment.files) {
        if (!selectedFiles.includes(file)) assignmentsComplete = false;
        coverage.set(file, (coverage.get(file) ?? 0) + 1);
      }
    }
    assignmentsComplete &&= selectedFiles.every((file) => coverage.get(file) === 1);
  }
  if (!assignmentsComplete) {
    violations.push(
      violation(
        'shard-assignments-incomplete',
        'shard assignments must map every selected file to exactly one shard',
      ),
    );
  }
  if (shardCount !== null && shards.count !== shardCount) {
    violations.push(
      violation(
        'shard-count-mismatch',
        `manifest declares ${shards.count} shards, expected ${shardCount}`,
      ),
    );
  }

  const createdAt = manifest?.created_at;
  const expiresAt = manifest?.expires_at;
  if (typeof createdAt !== 'string' || !ISO_TIMESTAMP.test(createdAt)) {
    violations.push(
      violation('created-at-invalid', 'created_at must be an ISO-8601 UTC timestamp'),
    );
  }
  if (typeof expiresAt !== 'string' || !ISO_TIMESTAMP.test(expiresAt)) {
    violations.push(
      violation('expires-at-invalid', 'expires_at must be an ISO-8601 UTC timestamp'),
    );
  } else if (typeof createdAt === 'string' && ISO_TIMESTAMP.test(createdAt)) {
    if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
      violations.push(violation('expires-at-invalid', 'expires_at must be after created_at'));
    }
    if (now.getTime() > Date.parse(expiresAt)) {
      violations.push(violation('manifest-expired', 'manifest expiry has passed'));
    }
  }
  if (typeof expectHead === 'string' && expectHead !== source.head) {
    violations.push(
      violation(
        'manifest-stale-head',
        `manifest head ${source.head} differs from expected ${expectHead}`,
      ),
    );
  }

  if (typeof manifest?.digest_sha256 !== 'string' || !SHA256_HEX.test(manifest.digest_sha256)) {
    violations.push(violation('digest-malformed', 'digest_sha256 must be 64 lowercase hex chars'));
  } else if (computeManifestDigest(manifest) !== manifest.digest_sha256) {
    violations.push(
      violation('digest-mismatch', 'recomputed manifest digest differs from digest_sha256'),
    );
  }

  return { ok: violations.length === 0, violations };
}

export function buildLocalSelection(manifest, fallbackReason = null) {
  if (manifest !== null && manifest?.mode === 'affected') {
    return {
      schema_version: MANIFEST_SCHEMA_VERSION,
      partition: MANIFEST_PARTITION,
      requested_mode: 'affected',
      effective_mode: 'affected',
      base: manifest.source.base,
      changed_files: [],
      predicted_files: manifest.selected_files,
    };
  }
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    partition: MANIFEST_PARTITION,
    requested_mode: manifest?.source?.requested_mode ?? 'full',
    effective_mode: 'full',
    fallback_reason:
      fallbackReason ?? manifest?.source?.fallback_reason ?? 'gate-plan-full-trigger',
    base: manifest?.source?.base ?? '',
    changed_files: [],
    predicted_files: null,
  };
}
