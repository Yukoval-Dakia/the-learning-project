import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SELECTOR_TIMEOUT_MS = 120_000;
const DB_RUN_TIMEOUT_MS = 30 * 60_000;
const MAX_AFFECTED_CLI_BYTES = 64 * 1024;
const SOURCE_SCANNING_TEST_PATTERN =
  /(?:node:(?:fs(?:\/promises)?|child_process)|\b(?:readFileSync|readdirSync|globSync|execFileSync|execSync)\b)/;
const DYNAMIC_IMPORT_TEST_PATTERN =
  /\b(?:await\s+)?import\s*\(|\b(?:vi\.)?import(?:Actual|Original)\s*(?:<|\()/;

// Real failed-head backfill found these DB failures outside the corresponding
// PR import graphs. Keep the known flaky/red-capable files required until their
// owning regressions are eliminated; otherwise affected selection would hide a
// failure that the former full required gate exposed.
export const DB_FAILURE_SENTINEL_TESTS = [
  'src/capabilities/knowledge/server/propose_edge.db.test.ts',
  'src/capabilities/practice/jobs/quiz_gen.test.ts',
];

function normalizeRepoFile(file, root) {
  const normalized = path.isAbsolute(file) ? path.relative(root, file) : file;
  return normalized
    .split(path.sep)
    .join('/')
    .replace(/^\.\/+/, '');
}

function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function inventoryFiles(entries, root) {
  return sortedUnique(
    entries
      .map((entry) => (typeof entry === 'string' ? entry : entry?.file))
      .filter((file) => typeof file === 'string')
      .map((file) => normalizeRepoFile(file, root)),
  );
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

export function scanDbTestSources({ dbFiles, root }) {
  const sourceScanningDbTests = [];
  const dynamicImportDbTests = [];
  for (const file of dbFiles) {
    if (!isSafeRepoTestFile(file)) {
      throw new Error(`unsafe DB test inventory path: ${file}`);
    }
    const source = readFileSync(path.join(root, file), 'utf8');
    if (SOURCE_SCANNING_TEST_PATTERN.test(source)) sourceScanningDbTests.push(file);
    if (DYNAMIC_IMPORT_TEST_PATTERN.test(source)) dynamicImportDbTests.push(file);
  }
  return {
    sourceScanningDbTests: sortedUnique(sourceScanningDbTests),
    dynamicImportDbTests: sortedUnique(dynamicImportDbTests),
  };
}

export function findSourceScanningDbTests({ dbFiles, root }) {
  return scanDbTestSources({ dbFiles, root }).sourceScanningDbTests;
}

export function findDynamicImportDbTests({ dbFiles, root }) {
  return scanDbTestSources({ dbFiles, root }).dynamicImportDbTests;
}

export function mergeDbPredictedFiles({
  graphPredictedFiles,
  sourceScanningDbTests,
  dynamicImportDbTests,
  dbFiles,
}) {
  const dbInventory = new Set(dbFiles);
  const failureSentinelTests = DB_FAILURE_SENTINEL_TESTS.filter((file) => dbInventory.has(file));
  const missingFailureSentinelTests = DB_FAILURE_SENTINEL_TESTS.filter(
    (file) => !dbInventory.has(file),
  );
  return {
    predictedFiles: sortedUnique([
      ...graphPredictedFiles,
      ...sourceScanningDbTests,
      ...dynamicImportDbTests,
      ...failureSentinelTests,
    ]),
    failureSentinelTests,
    missingFailureSentinelTests,
  };
}

export function findDirectChangedDbTestMisses({ changedFiles, predictedFiles, dbFiles }) {
  const predicted = new Set(predictedFiles);
  const db = new Set(dbFiles);
  const directChangedDbTests = sortedUnique(
    changedFiles.filter((file) => /\.test\.tsx?$/.test(file) && db.has(file)),
  );
  return {
    directChangedDbTests,
    misses: directChangedDbTests.filter((file) => !predicted.has(file)),
  };
}

export function resolveRequiredDbFiles(selection) {
  if (
    selection?.schema_version !== 1 ||
    selection?.partition !== 'db' ||
    selection?.requested_mode !== 'affected' ||
    selection?.effective_mode !== 'affected' ||
    typeof selection.base !== 'string' ||
    selection.base.length === 0 ||
    !Array.isArray(selection.predicted_files) ||
    selection.predicted_files.length === 0 ||
    selection.predicted_files.some((file) => !isSafeRepoTestFile(file))
  ) {
    return null;
  }
  return sortedUnique(selection.predicted_files);
}

export function affectedCliBytes(selectedFiles) {
  return selectedFiles.reduce((total, file) => total + Buffer.byteLength(file) + 1, 0);
}

export function affectedFilesFitCli(selectedFiles) {
  return affectedCliBytes(selectedFiles) <= MAX_AFFECTED_CLI_BYTES;
}

export function parseShard(value) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value ?? '');
  if (!match) return null;
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (index > count) return null;
  return { index, count, value: `${index}/${count}` };
}

export function shouldSkipAffectedShard(selectedFileCount, shard) {
  return selectedFileCount < shard.count && shard.index > selectedFileCount;
}

/**
 * YUK-1023 — duration-balanced DB sharding.
 *
 * Vitest's native `--shard` splits by file index (count-mod), which ignores
 * runtime: the P3 lane produced 8.8min / 23.5min shards that way. Instead we
 * bin-pack the file list ourselves with an LPT (longest-processing-time)
 * greedy pass over the committed duration baseline
 * (scripts/ci/db-test-durations.json) and hand each shard an explicit file
 * list — the same approach as CircleCI timing splits / Knapsack.
 *
 * Determinism is a hard requirement: every shard recomputes the identical
 * partition, so ordering is (duration desc, path asc) and bins fill
 * least-loaded-first with index tie-break. Files missing from the baseline
 * take the median duration so a new heavy test can't silently stack a bin.
 */
export function medianDurationMs(durations) {
  const values = Object.values(durations ?? {}).filter(
    (value) => Number.isFinite(value) && value > 0,
  );
  if (values.length === 0) return 1_000;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

export function binPackDbShards({ files, shardCount, durations }) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error(`invalid shard count: ${shardCount}`);
  }
  const fallbackMs = medianDurationMs(durations);
  const bins = Array.from({ length: shardCount }, () => ({ files: [], estimatedMs: 0 }));
  const ordered = [...new Set(files)]
    .map((file) => ({
      file,
      ms: Number.isFinite(durations?.[file]) && durations[file] > 0 ? durations[file] : fallbackMs,
    }))
    .sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file));
  for (const entry of ordered) {
    let target = 0;
    for (let i = 1; i < bins.length; i += 1) {
      if (bins[i].estimatedMs < bins[target].estimatedMs) target = i;
    }
    bins[target].files.push(entry.file);
    bins[target].estimatedMs += entry.ms;
  }
  // Deterministic file order inside each bin keeps vitest output stable.
  return bins.map((bin) => ({ files: bin.files.sort(), estimatedMs: bin.estimatedMs }));
}

/** Load the committed duration baseline; absent/invalid → {} (all files get
 *  the median fallback, degenerating to balanced-by-count — never fails the
 *  lane over a missing optimization input). */
export function loadDbTestDurations(root) {
  try {
    const parsed = JSON.parse(
      readFileSync(path.join(root, 'scripts', 'ci', 'db-test-durations.json'), 'utf8'),
    );
    return typeof parsed?.durations === 'object' && parsed.durations !== null
      ? parsed.durations
      : {};
  } catch {
    return {};
  }
}

function readChangedFiles(base, root) {
  const output = execFileSync(
    'git',
    ['diff', '--name-only', '--no-renames', '-z', base, 'HEAD', '--'],
    {
      cwd: root,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: SELECTOR_TIMEOUT_MS,
    },
  );
  return sortedUnique(
    output
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((file) => normalizeRepoFile(file, root)),
  );
}

function fullFallbackSelection({ requestedMode, base, changedFiles, reason }) {
  return {
    schema_version: 1,
    partition: 'db',
    requested_mode: requestedMode,
    effective_mode: 'full',
    fallback_reason: reason,
    base,
    changed_files: changedFiles,
    predicted_files: null,
  };
}

function isSafeMergeBase(base) {
  return /^[0-9a-f]{7,64}$/i.test(base);
}

/**
 * One `vitest list` of the whole db partition. Returns the repo-relative file
 * list or null on failure — inventory listing is an optimization input (shard
 * balancing), so failures degrade to the vitest `--shard` fallback instead of
 * failing the selection.
 */
function tryListDbInventoryFiles({ root, directory }) {
  const vitestEntry = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
  const inventoryOutput = path.join(directory, `db-full-inventory-${randomUUID()}.json`);
  try {
    const result = spawnSync(
      process.execPath,
      [
        vitestEntry,
        'list',
        '--config',
        'vitest.db.config.ts',
        '--filesOnly',
        `--json=${inventoryOutput}`,
        '--staticParse',
      ],
      { cwd: root, encoding: 'utf8', timeout: SELECTOR_TIMEOUT_MS },
    );
    if (result.status !== 0 || !existsSync(inventoryOutput)) return null;
    const files = inventoryFiles(JSON.parse(readFileSync(inventoryOutput, 'utf8')), root);
    return files.length > 0 ? files : null;
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(inventoryOutput);
    } catch {
      // already gone
    }
  }
}

export function selectAffectedDbTests({ root, base, requestedMode, output }) {
  if (requestedMode !== 'affected') {
    const selection = fullFallbackSelection({
      requestedMode,
      base,
      changedFiles: [],
      reason: requestedMode === 'full' ? 'gate-plan-full-trigger' : 'selector-not-requested',
    });
    // Full mode still needs the inventory list so each shard can duration-bin
    // the suite instead of delegating a count-mod split to vitest --shard.
    const inventory = tryListDbInventoryFiles({ root, directory: path.dirname(output) });
    if (inventory) selection.inventory_files = inventory;
    writeFileSync(output, `${JSON.stringify(selection, null, 2)}\n`);
    return selection;
  }

  if (!base) {
    const selection = fullFallbackSelection({
      requestedMode,
      base,
      changedFiles: [],
      reason: 'base-empty',
    });
    writeFileSync(output, `${JSON.stringify(selection, null, 2)}\n`);
    return selection;
  }

  if (!isSafeMergeBase(base)) {
    const selection = fullFallbackSelection({
      requestedMode,
      base,
      changedFiles: [],
      reason: 'base-invalid',
    });
    writeFileSync(output, `${JSON.stringify(selection, null, 2)}\n`);
    return selection;
  }

  let changedFiles = [];
  try {
    changedFiles = readChangedFiles(base, root);
  } catch (error) {
    console.error(
      '[db-affected] changed-file diff failed:',
      error instanceof Error ? error.message : error,
    );
    const selection = fullFallbackSelection({
      requestedMode,
      base,
      changedFiles,
      reason: 'changed-files-unavailable',
    });
    writeFileSync(output, `${JSON.stringify(selection, null, 2)}\n`);
    return selection;
  }

  const token = randomUUID();
  const rawOutput = path.join(path.dirname(output), `db-affected-vitest-${token}.json`);
  const fullInventoryOutput = path.join(path.dirname(output), `db-full-inventory-${token}.json`);
  const vitestEntry = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
  const startedAt = Date.now();

  try {
    const affectedResult = spawnSync(
      process.execPath,
      [
        vitestEntry,
        'list',
        '--config',
        'vitest.db.config.ts',
        `--changed=${base}`,
        '--filesOnly',
        `--json=${rawOutput}`,
        '--staticParse',
      ],
      { cwd: root, encoding: 'utf8', timeout: SELECTOR_TIMEOUT_MS },
    );
    if (affectedResult.status !== 0 || !existsSync(rawOutput)) {
      const timedOut = affectedResult.error?.code === 'ETIMEDOUT';
      const selection = fullFallbackSelection({
        requestedMode,
        base,
        changedFiles,
        reason: timedOut
          ? 'vitest-list-timeout'
          : `vitest-list-failed:${affectedResult.status ?? 'signal'}`,
      });
      selection.selector_stderr = affectedResult.stderr?.trim().slice(0, 2_000) || undefined;
      selection.selector_error = affectedResult.error?.message?.slice(0, 2_000) || undefined;
      writeFileSync(output, `${JSON.stringify(selection, null, 2)}\n`);
      return selection;
    }

    const graphPredictedFiles = inventoryFiles(JSON.parse(readFileSync(rawOutput, 'utf8')), root);
    if (graphPredictedFiles.length === 0) {
      const selection = fullFallbackSelection({
        requestedMode,
        base,
        changedFiles,
        reason: 'vitest-affected-empty',
      });
      writeFileSync(output, `${JSON.stringify(selection, null, 2)}\n`);
      return selection;
    }

    const fullInventoryResult = spawnSync(
      process.execPath,
      [
        vitestEntry,
        'list',
        '--config',
        'vitest.db.config.ts',
        '--filesOnly',
        `--json=${fullInventoryOutput}`,
        '--staticParse',
      ],
      { cwd: root, encoding: 'utf8', timeout: SELECTOR_TIMEOUT_MS },
    );
    if (fullInventoryResult.status !== 0 || !existsSync(fullInventoryOutput)) {
      const timedOut = fullInventoryResult.error?.code === 'ETIMEDOUT';
      const selection = fullFallbackSelection({
        requestedMode,
        base,
        changedFiles,
        reason: timedOut
          ? 'vitest-full-list-timeout'
          : `vitest-full-list-failed:${fullInventoryResult.status ?? 'signal'}`,
      });
      selection.selector_stderr = fullInventoryResult.stderr?.trim().slice(0, 2_000) || undefined;
      selection.selector_error = fullInventoryResult.error?.message?.slice(0, 2_000) || undefined;
      writeFileSync(output, `${JSON.stringify(selection, null, 2)}\n`);
      return selection;
    }

    const dbFiles = inventoryFiles(JSON.parse(readFileSync(fullInventoryOutput, 'utf8')), root);
    const { sourceScanningDbTests, dynamicImportDbTests } = scanDbTestSources({ dbFiles, root });
    const { predictedFiles, failureSentinelTests, missingFailureSentinelTests } =
      mergeDbPredictedFiles({
        graphPredictedFiles,
        sourceScanningDbTests,
        dynamicImportDbTests,
        dbFiles,
      });
    if (missingFailureSentinelTests.length) {
      const selection = fullFallbackSelection({
        requestedMode,
        base,
        changedFiles,
        reason: `failure-sentinel-missing:${missingFailureSentinelTests.join(',').slice(0, 1_000)}`,
      });
      selection.missing_failure_sentinel_db_tests = missingFailureSentinelTests;
      writeFileSync(output, `${JSON.stringify(selection, null, 2)}\n`);
      return selection;
    }
    const directGuard = findDirectChangedDbTestMisses({
      changedFiles,
      predictedFiles,
      dbFiles,
    });
    if (directGuard.misses.length) {
      const selection = fullFallbackSelection({
        requestedMode,
        base,
        changedFiles,
        reason: `direct-db-test-missed:${directGuard.misses.join(',').slice(0, 1_000)}`,
      });
      selection.direct_changed_db_tests = directGuard.directChangedDbTests;
      selection.direct_changed_tests_missed = directGuard.misses;
      writeFileSync(output, `${JSON.stringify(selection, null, 2)}\n`);
      return selection;
    }

    const selection = {
      schema_version: 1,
      partition: 'db',
      requested_mode: requestedMode,
      effective_mode: 'affected',
      base,
      changed_files: changedFiles,
      predicted_files: predictedFiles,
      db_inventory_files: dbFiles.length,
      // Full inventory as a list — duration bin-packing at run time needs
      // every candidate, not just the count.
      inventory_files: dbFiles,
      source_scanning_db_tests: sourceScanningDbTests,
      dynamic_import_db_tests: dynamicImportDbTests,
      failure_sentinel_db_tests: failureSentinelTests,
      direct_changed_db_tests: directGuard.directChangedDbTests,
      direct_changed_tests_missed: [],
      selector_duration_ms: Date.now() - startedAt,
    };
    writeFileSync(output, `${JSON.stringify(selection, null, 2)}\n`);
    return selection;
  } catch (error) {
    console.error(
      '[db-affected] affected-test inventory failed:',
      error instanceof Error ? error.message : error,
    );
    const selection = fullFallbackSelection({
      requestedMode,
      base,
      changedFiles,
      reason: 'vitest-list-json-invalid',
    });
    writeFileSync(output, `${JSON.stringify(selection, null, 2)}\n`);
    return selection;
  } finally {
    for (const temporaryFile of [rawOutput, fullInventoryOutput]) {
      try {
        unlinkSync(temporaryFile);
      } catch (error) {
        if (existsSync(temporaryFile)) {
          console.error(
            `[db-affected] failed to remove ${temporaryFile}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
  }
}

function markdownText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('`', '&#96;')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n');
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--')) continue;
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) continue;
    options[arg.slice(2)] = value;
    index += 1;
  }
  return { command, options };
}

function ensureParent(file) {
  mkdirSync(path.dirname(file), { recursive: true });
}

function sanitizeInventoryFiles(selection) {
  const files = selection?.inventory_files;
  if (!Array.isArray(files) || files.length === 0) return null;
  return files.every((file) => isSafeRepoTestFile(file)) ? sortedUnique(files) : null;
}

/** Per-file wall time from a vitest JSON report — endTime-startTime covers
 *  worker-pool waiting, which is the signal shard balancing needs. Parse
 *  failures degrade to an empty map, never to a failed lane. */
function readVitestFileDurations(reportPath, root) {
  try {
    const parsed = JSON.parse(readFileSync(reportPath, 'utf8'));
    const durations = {};
    for (const entry of parsed.testResults ?? []) {
      const file = typeof entry?.name === 'string' ? normalizeRepoFile(entry.name, root) : null;
      const ms = Number.isFinite(entry?.duration)
        ? entry.duration
        : Number.isFinite(entry?.endTime) && Number.isFinite(entry?.startTime)
          ? entry.endTime - entry.startTime
          : null;
      if (file && Number.isFinite(ms)) durations[file] = Math.round(ms);
    }
    return durations;
  } catch {
    return {};
  }
}

function runRequiredDbTests({ root, selectionPath, executionPath, shardValue }) {
  let selection;
  let selectionReadError;
  try {
    selection = JSON.parse(readFileSync(selectionPath, 'utf8'));
  } catch (error) {
    console.error(
      '[db-affected] selection read failed:',
      error instanceof Error ? error.message : error,
    );
    selectionReadError = 'selection-missing-or-invalid';
  }

  const shard = parseShard(shardValue);
  if (!shard) throw new Error(`invalid --shard value: ${shardValue ?? '(missing)'}`);

  const selectedFiles = resolveRequiredDbFiles(selection);
  const selectedCliBytes = selectedFiles ? affectedCliBytes(selectedFiles) : null;
  const selectedFilesFitCli = selectedFiles !== null && affectedFilesFitCli(selectedFiles);
  const runnableFiles = selectedFilesFitCli ? selectedFiles : null;
  const requiredMode = runnableFiles ? 'affected' : 'full';
  const argvFallbackReason =
    selectedFiles !== null && !selectedFilesFitCli ? 'affected-argv-too-large' : undefined;

  // YUK-1023 — duration-balanced sharding. Affected mode bins the selected
  // files; full mode bins the selector's inventory_files listing. Only a
  // selection missing both lists (legacy artifact, or the inventory listing
  // failed inside select) falls back to vitest's count-mod --shard.
  const durations = loadDbTestDurations(root);
  const candidateFiles = runnableFiles ?? sanitizeInventoryFiles(selection);
  const bins = candidateFiles
    ? binPackDbShards({ files: candidateFiles, shardCount: shard.count, durations })
    : null;
  const bin = bins?.[shard.index - 1] ?? null;
  const binFiles = bin && affectedFilesFitCli(bin.files) ? bin.files : null;
  const binOverflowsCli = bin !== null && !affectedFilesFitCli(bin.files);

  const startedAt = Date.now();
  const skippedEmptyShard = bin !== null && bin.files.length === 0;
  let result = { status: 0, signal: null, error: undefined };
  const reportPath = path.join(
    path.dirname(executionPath),
    `db-vitest-report-${shard.index}-of-${shard.count}.json`,
  );

  if (!skippedEmptyShard) {
    const vitestEntry = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
    const args = [
      vitestEntry,
      'run',
      '--config',
      'vitest.db.config.ts',
      // Keep the console reporter AND emit the JSON report — the per-file
      // durations in it feed the committed baseline used by bin-packing.
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${reportPath}`,
      '--passWithNoTests',
      ...(binFiles ?? [`--shard=${shard.value}`]),
    ];
    result = spawnSync(process.execPath, args, {
      cwd: root,
      stdio: 'inherit',
      timeout: DB_RUN_TIMEOUT_MS,
    });
  }

  const fileDurations = readVitestFileDurations(reportPath, root);
  try {
    unlinkSync(reportPath);
  } catch {
    // report absent (skipped shard or reporter failure) — nothing to remove
  }

  const execution = {
    schema_version: 1,
    partition: 'db',
    required_mode: requiredMode,
    requested_mode: selection?.requested_mode ?? 'full',
    effective_mode: selection?.effective_mode ?? 'full',
    fallback_reason: selection?.fallback_reason ?? selectionReadError ?? argvFallbackReason,
    base: selection?.base ?? '',
    shard: shard.value,
    skipped_empty_shard: skippedEmptyShard,
    selector_duration_ms: selection?.selector_duration_ms,
    selected_files: selectedFiles?.length ?? null,
    selected_cli_bytes: selectedCliBytes,
    shard_strategy: binFiles
      ? 'duration-binpack'
      : binOverflowsCli
        ? 'vitest-shard-cli-overflow'
        : 'vitest-shard-legacy',
    shard_files: binFiles?.length ?? null,
    bin_estimated_ms: bin?.estimatedMs ?? null,
    file_durations: fileDurations,
    test_duration_ms: Date.now() - startedAt,
    exit_code: result.status ?? 1,
    signal: result.signal ?? null,
    timed_out: result.error?.code === 'ETIMEDOUT',
    github: {
      run_id: process.env.GITHUB_RUN_ID,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT,
      sha: process.env.GITHUB_SHA,
      ref: process.env.GITHUB_REF,
      event_name: process.env.GITHUB_EVENT_NAME,
    },
    created_at: new Date().toISOString(),
  };
  writeFileSync(executionPath, `${JSON.stringify(execution, null, 2)}\n`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        '## Required DB selection',
        '',
        `- shard: \`${shard.value}\``,
        `- required mode: \`${requiredMode}\``,
        `- requested/effective: \`${markdownText(execution.requested_mode)}\` → \`${markdownText(execution.effective_mode)}\``,
        `- selected files before sharding: ${selectedFiles?.length ?? 'full suite'}`,
        `- shard strategy: \`${execution.shard_strategy}\``,
        `- shard files: ${execution.shard_files ?? 'n/a'} (est. ${execution.bin_estimated_ms ?? 'n/a'} ms)`,
        `- empty shard skipped: \`${skippedEmptyShard}\``,
        `- selector time: ${execution.selector_duration_ms ?? 'n/a'} ms`,
        `- test time: ${execution.test_duration_ms} ms`,
        `- exit code: \`${execution.exit_code}\``,
        execution.fallback_reason
          ? `- fallback: \`${markdownText(execution.fallback_reason)}\``
          : null,
        '',
      ]
        .filter((line) => line !== null)
        .join('\n'),
    );
  }
  return execution;
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  if (command === 'select') {
    const output = path.resolve(options.output ?? '.cache/ci-db-selection.json');
    ensureParent(output);
    const selection = selectAffectedDbTests({
      root,
      base: options.base ?? '',
      requestedMode: options.mode ?? 'full',
      output,
    });
    console.log(JSON.stringify(selection, null, 2));
    return;
  }

  if (command === 'run') {
    const selectionPath = path.resolve(options.selection ?? '.cache/ci-db-selection.json');
    const executionPath = path.resolve(options.execution ?? '.cache/ci-db-execution.json');
    ensureParent(executionPath);
    const execution = runRequiredDbTests({
      root,
      selectionPath,
      executionPath,
      shardValue: options.shard,
    });
    if (execution.exit_code !== 0) process.exitCode = execution.exit_code;
    return;
  }

  throw new Error(`unknown command: ${command ?? '(missing)'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
