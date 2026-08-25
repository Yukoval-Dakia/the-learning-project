import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseShard } from './db-affected.mjs';
import { buildLocalSelection, validateDbManifest } from './db-artifact-manifest.mjs';

const FULL_SHA = /^[0-9a-f]{40}$/;

export const FALLBACK_VIOLATION_CODES = new Set(['manifest-stale-head', 'manifest-expired']);
export const DEFAULT_ARTIFACT_STEP = 'db-select';

export function classifyDbManifestViolations(violations) {
  return violations.some((violation) => !FALLBACK_VIOLATION_CODES.has(violation.code))
    ? 'corrupt'
    : 'fallback';
}

export function planShardExecution({ manifestState, violations }) {
  if (manifestState === 'missing') {
    return { action: 'full-fallback', fallbackReason: 'manifest-missing' };
  }
  if (violations.length === 0) return { action: 'execute-manifest', fallbackReason: null };
  if (classifyDbManifestViolations(violations) === 'fallback') {
    const fallbackViolation = violations.find((entry) => FALLBACK_VIOLATION_CODES.has(entry.code));
    return { action: 'full-fallback', fallbackReason: fallbackViolation.code };
  }
  return { action: 'fail', fallbackReason: violations.map((entry) => entry.code).join(',') };
}

export function expectedSkipForShard(manifest, shardIndex) {
  if (manifest === null || manifest?.mode !== 'affected') return false;
  const assignment = manifest.shards.assignments.find((entry) => entry.shard === shardIndex);
  return (assignment?.files ?? []).length === 0;
}

export function mergeExecutionReport({
  runExecution,
  manifest,
  plan,
  shard,
  workspaceRoot,
  now = new Date(),
}) {
  const verified = plan.action === 'execute-manifest';
  const expectedSkip = verified ? expectedSkipForShard(manifest, shard.index) : false;
  const reportedSkip = runExecution.skipped_empty_shard === true;
  const drift = verified && reportedSkip !== expectedSkip;
  const report = {
    ...runExecution,
    shard: shard.value,
    skipped_empty_shard: reportedSkip,
    workspace_root: workspaceRoot,
    selector: {
      status: drift ? 'failed' : verified ? 'verified' : 'fallback',
      digest_sha256: verified ? manifest.digest_sha256 : null,
      manifest_path: verified ? manifest.workspace.manifest_path : null,
      manifest_source_head: manifest?.source?.head ?? null,
      fallback_reason: plan.fallbackReason,
      expected_skip: expectedSkip,
    },
    consistency_violation: drift ? 'skip-consistency-drift' : null,
    merged_at: now.toISOString(),
  };
  return { report, drift };
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFailureReport({ executionPath, shard, reason, violations }) {
  writeJson(executionPath, {
    schema_version: 1,
    partition: 'db',
    status: 'failed',
    reason,
    violations,
    shard: shard.value,
    selector: {
      status: 'failed',
      digest_sha256: null,
      manifest_path: null,
      manifest_source_head: null,
      fallback_reason: reason,
      expected_skip: false,
    },
    consistency_violation: null,
    created_at: new Date().toISOString(),
  });
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) continue;
    options[arg.slice(2)] = value;
    index += 1;
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const shard = parseShard(options.shard);
  if (!shard) {
    console.error(`[db-artifact-shard] invalid --shard value: ${options.shard ?? '(missing)'}`);
    process.exitCode = 2;
    return;
  }
  const expectHead = options['expect-head'] ?? '';
  if (!FULL_SHA.test(expectHead)) {
    console.error(`[db-artifact-shard] --expect-head must be a full 40-hex sha`);
    process.exitCode = 2;
    return;
  }

  const root = process.cwd();
  const manifestPath = path.resolve(options.manifest ?? '.cache/ci/db-manifest.json');
  const executionPath = path.resolve(
    options.execution ?? `.cache/ci/db-execution-shard-${shard.index}.json`,
  );
  const artifactStep = options['artifact-step'] ?? DEFAULT_ARTIFACT_STEP;
  const agentBin = process.env.DB_ARTIFACT_AGENT_BIN ?? 'buildkite-agent';
  const dbAffectedBin = path.resolve(
    process.env.DB_ARTIFACT_DB_AFFECTED_BIN ??
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'db-affected.mjs'),
  );
  mkdirSync(path.dirname(executionPath), { recursive: true });

  spawnSync(
    agentBin,
    ['artifact', 'download', path.relative(root, manifestPath), '.', '--step', artifactStep],
    { cwd: root, stdio: 'inherit' },
  );

  let manifest = null;
  let violations = [];
  if (!existsSync(manifestPath)) {
    violations = [];
  } else {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      violations = validateDbManifest(manifest, {
        expectHead,
        shardCount: shard.count,
      }).violations;
    } catch (error) {
      manifest = null;
      violations = [
        { code: 'manifest-corrupt-json', message: String(error?.message ?? error).slice(0, 300) },
      ];
    }
  }

  const plan = planShardExecution({
    manifestState: manifest === null && violations.length === 0 ? 'missing' : 'present',
    violations,
  });
  if (plan.action === 'fail') {
    writeFailureReport({ executionPath, shard, reason: plan.fallbackReason, violations });
    console.error(`[db-artifact-shard] failing closed: ${plan.fallbackReason}`);
    process.exitCode = 1;
    return;
  }

  const selection = buildLocalSelection(
    plan.action === 'execute-manifest' ? manifest : null,
    plan.fallbackReason,
  );
  const cacheDir = path.dirname(executionPath);
  const selectionPath = path.join(cacheDir, `db-shard-selection-${shard.index}.json`);
  const runExecutionPath = path.join(cacheDir, `db-run-execution-${shard.index}.json`);
  writeJson(selectionPath, selection);

  const runResult = spawnSync(
    process.execPath,
    [
      dbAffectedBin,
      'run',
      '--selection',
      selectionPath,
      '--shard',
      shard.value,
      '--execution',
      runExecutionPath,
    ],
    { cwd: root, stdio: 'inherit' },
  );

  let runExecution = null;
  try {
    runExecution = JSON.parse(readFileSync(runExecutionPath, 'utf8'));
  } catch {
    runExecution = null;
  }
  if (runExecution === null || typeof runExecution !== 'object') {
    writeFailureReport({ executionPath, shard, reason: 'run-execution-missing', violations: [] });
    console.error('[db-artifact-shard] db-affected run produced no execution record');
    process.exitCode = 1;
    return;
  }

  const { report, drift } = mergeExecutionReport({
    runExecution,
    manifest,
    plan,
    shard,
    workspaceRoot: root,
  });
  writeJson(executionPath, report);
  if (drift) {
    console.error('[db-artifact-shard] skip consistency drift between manifest and runner');
    process.exitCode = 1;
    return;
  }
  process.exitCode = Number.isInteger(runExecution.exit_code)
    ? runExecution.exit_code
    : (runResult.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
