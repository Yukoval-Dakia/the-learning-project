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

export const SHADOW_SENTINEL_TESTS = [
  'src/server/ai/retry-optin.test.ts',
  'src/subjects/skill-namespace.test.ts',
  'src/subjects/skills-image-coverage.test.ts',
  'tests/integration/session-single-owner.test.ts',
  'tests/integration/step9-invariant-audit.test.ts',
];

const SELECTOR_TIMEOUT_MS = 120_000;
const UNIT_RUN_TIMEOUT_MS = 15 * 60_000;

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

export function mergePredictedFiles(entries, root, additionalFiles = SHADOW_SENTINEL_TESTS) {
  const predicted = entries
    .map((entry) => (typeof entry === 'string' ? entry : entry?.file))
    .filter((file) => typeof file === 'string')
    .map((file) => normalizeRepoFile(file, root));
  return sortedUnique([...predicted, ...additionalFiles]);
}

const SOURCE_SCANNING_TEST_PATTERN =
  /(?:node:(?:fs(?:\/promises)?|child_process)|\b(?:readFileSync|readdirSync|globSync|execFileSync|execSync)\b)/;

export function findSourceScanningUnitTests({ unitFiles, root }) {
  return sortedUnique([
    ...SHADOW_SENTINEL_TESTS,
    ...unitFiles.filter((file) => {
      const source = readFileSync(path.join(root, file), 'utf8');
      return SOURCE_SCANNING_TEST_PATTERN.test(source);
    }),
  ]);
}

export function resolveRequiredUnitFiles(selection) {
  if (
    selection?.schema_version !== 1 ||
    selection?.requested_mode !== 'affected' ||
    selection?.effective_mode !== 'affected' ||
    typeof selection.base !== 'string' ||
    selection.base.length === 0 ||
    !Array.isArray(selection.predicted_files) ||
    selection.predicted_files.length === 0 ||
    selection.predicted_files.some(
      (file) =>
        typeof file !== 'string' ||
        path.isAbsolute(file) ||
        file.startsWith('-') ||
        file.split('/').includes('..') ||
        !/\.test\.tsx?$/.test(file),
    )
  ) {
    return null;
  }
  return sortedUnique(selection.predicted_files);
}

export function findDirectChangedUnitTestMisses({ changedFiles, predictedFiles, unitFiles }) {
  const predicted = new Set(predictedFiles);
  const unit = new Set(unitFiles);
  const directChangedUnitTests = sortedUnique(
    changedFiles.filter((file) => /\.test\.tsx?$/.test(file) && unit.has(file)),
  );
  return {
    directChangedUnitTests,
    misses: directChangedUnitTests.filter((file) => !predicted.has(file)),
  };
}

function readChangedFiles(base, root) {
  const output = execFileSync(
    'git',
    ['diff', '--name-only', '--no-renames', '-z', base, 'HEAD', '--'],
    {
      cwd: root,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
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

function selectAffectedTests({ root, base, requestedMode, output }) {
  if (requestedMode !== 'affected') {
    const selection = fullFallbackSelection({
      requestedMode,
      base,
      changedFiles: [],
      reason: requestedMode === 'full' ? 'gate-plan-full-trigger' : 'selector-not-requested',
    });
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
      '[unit-shadow] changed-file diff failed:',
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
  const rawOutput = path.join(path.dirname(output), `unit-affected-vitest-${token}.json`);
  const fullInventoryOutput = path.join(path.dirname(output), `unit-full-inventory-${token}.json`);
  const vitestEntry = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
  const startedAt = Date.now();

  try {
    const result = spawnSync(
      process.execPath,
      [
        vitestEntry,
        'list',
        '--config',
        'vitest.unit.config.ts',
        `--changed=${base}`,
        '--filesOnly',
        `--json=${rawOutput}`,
        '--staticParse',
      ],
      { cwd: root, encoding: 'utf8', timeout: SELECTOR_TIMEOUT_MS },
    );

    if (result.status !== 0 || !existsSync(rawOutput)) {
      const timedOut = result.error?.code === 'ETIMEDOUT';
      const selection = fullFallbackSelection({
        requestedMode,
        base,
        changedFiles,
        reason: timedOut
          ? 'vitest-list-timeout'
          : `vitest-list-failed:${result.status ?? 'signal'}`,
      });
      selection.selector_stderr = result.stderr?.trim().slice(0, 2_000) || undefined;
      selection.selector_error = result.error?.message?.slice(0, 2_000) || undefined;
      writeFileSync(output, `${JSON.stringify(selection, null, 2)}\n`);
      return selection;
    }

    const entries = JSON.parse(readFileSync(rawOutput, 'utf8'));
    const graphPredictedFiles = mergePredictedFiles(entries, root, []);
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
        'vitest.unit.config.ts',
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
    const fullInventoryEntries = JSON.parse(readFileSync(fullInventoryOutput, 'utf8'));
    const unitFiles = sortedUnique(
      fullInventoryEntries
        .map((entry) => (typeof entry === 'string' ? entry : entry?.file))
        .filter((file) => typeof file === 'string')
        .map((file) => normalizeRepoFile(file, root)),
    );
    const sourceScanningUnitTests = findSourceScanningUnitTests({ unitFiles, root });
    const predictedFiles = mergePredictedFiles(entries, root, sourceScanningUnitTests);
    const directGuard = findDirectChangedUnitTestMisses({
      changedFiles,
      predictedFiles,
      unitFiles,
    });
    if (directGuard.misses.length) {
      const selection = fullFallbackSelection({
        requestedMode,
        base,
        changedFiles,
        reason: `direct-unit-test-missed:${directGuard.misses.join(',').slice(0, 1_000)}`,
      });
      selection.direct_changed_unit_tests = directGuard.directChangedUnitTests;
      selection.direct_changed_tests_missed = directGuard.misses;
      writeFileSync(output, `${JSON.stringify(selection, null, 2)}\n`);
      return selection;
    }
    const selection = {
      schema_version: 1,
      requested_mode: requestedMode,
      effective_mode: 'affected',
      base,
      changed_files: changedFiles,
      predicted_files: predictedFiles,
      unit_inventory_files: unitFiles.length,
      source_scanning_unit_tests: sourceScanningUnitTests,
      direct_changed_unit_tests: directGuard.directChangedUnitTests,
      direct_changed_tests_missed: [],
      selector_duration_ms: Date.now() - startedAt,
    };
    writeFileSync(output, `${JSON.stringify(selection, null, 2)}\n`);
    return selection;
  } catch (error) {
    console.error(
      '[unit-shadow] affected-test inventory failed:',
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
            `[unit-shadow] failed to remove ${temporaryFile}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
  }
}

export function buildShadowReport({ root, selection, fullResults }) {
  const full = sortedUnique(
    (fullResults.testResults ?? [])
      .map((result) => result?.name)
      .filter((name) => typeof name === 'string')
      .map((name) => normalizeRepoFile(name, root)),
  );
  const selected =
    selection.effective_mode === 'full'
      ? full
      : sortedUnique(
          (selection.predicted_files ?? []).map((file) => normalizeRepoFile(file, root)),
        );
  const selectedSet = new Set(selected);
  const fullSet = new Set(full);
  const failed = sortedUnique(
    (fullResults.testResults ?? [])
      .filter((result) => result?.status === 'failed')
      .map((result) => normalizeRepoFile(result.name, root)),
  );
  const missedFailures = failed.filter((file) => !selectedSet.has(file));
  const changedFiles = Array.isArray(selection.changed_files) ? selection.changed_files : [];
  const changedTests = changedFiles.filter(
    (file) => /\.test\.tsx?$/.test(file) && fullSet.has(file),
  );
  const changedTestsMissed = changedTests.filter((file) => !selectedSet.has(file));
  const predictedNotInFull = selected.filter((file) => !fullSet.has(file));

  let status = 'ok';
  if (selection.effective_mode === 'full' && selection.requested_mode === 'affected') {
    status = 'fallback';
  }
  if (missedFailures.length || changedTestsMissed.length) status = 'warning';

  return {
    schema_version: 1,
    status,
    requested_mode: selection.requested_mode,
    effective_mode: selection.effective_mode,
    fallback_reason: selection.fallback_reason,
    base: selection.base,
    selector_duration_ms: selection.selector_duration_ms,
    full_success: Boolean(fullResults.success),
    changed_files: changedFiles,
    full_files: full.length,
    selected_files: selected.length,
    selection_ratio: full.length === 0 ? 1 : Number((selected.length / full.length).toFixed(4)),
    failed_files: failed,
    missed_failures: missedFailures,
    changed_tests_missed: changedTestsMissed,
    predicted_not_in_full: predictedNotInFull,
    selected_file_list: selected,
  };
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

function markdownReport(report) {
  const rows = [
    '## Unit affected-test shadow',
    '',
    `- status: \`${report.status}\``,
    `- requested/effective: \`${report.requested_mode}\` → \`${report.effective_mode}\``,
    `- selected/full files: **${report.selected_files}/${report.full_files}** (${(report.selection_ratio * 100).toFixed(1)}%)`,
    `- selector time: ${report.selector_duration_ms ?? 'n/a'} ms`,
    `- full suite success: \`${report.full_success}\``,
    `- missed failing files: **${report.missed_failures.length}**`,
    `- directly changed tests missed: **${report.changed_tests_missed.length}**`,
  ];
  if (report.fallback_reason) rows.push(`- fallback: \`${markdownText(report.fallback_reason)}\``);
  if (report.missed_failures.length) {
    rows.push(
      '',
      '### Missed failures',
      ...report.missed_failures.map((file) => `- \`${markdownText(file)}\``),
    );
  }
  if (report.changed_tests_missed.length) {
    rows.push(
      '',
      '### Direct test misses',
      ...report.changed_tests_missed.map((file) => `- \`${markdownText(file)}\``),
    );
  }
  rows.push('');
  return `${rows.join('\n')}\n`;
}

function writeUnavailableShadowReport({ output, reason, detail }) {
  const unavailable = {
    schema_version: 1,
    status: 'unavailable',
    reason,
    ...(detail ? { detail: String(detail).slice(0, 500) } : {}),
  };
  writeFileSync(output, `${JSON.stringify(unavailable, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Unit affected-test shadow\n\n- status: \`unavailable\`\n- reason: \`${markdownText(reason)}\`\n\n`,
    );
  }
  console.log(`::warning title=Unit selector shadow unavailable::${reason}`);
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

function runRequiredUnitTests({ root, selectionPath, resultsPath, executionPath }) {
  let selection;
  let selectionReadError;
  try {
    selection = JSON.parse(readFileSync(selectionPath, 'utf8'));
  } catch (error) {
    console.error(
      '[unit-shadow] selection read failed:',
      error instanceof Error ? error.message : error,
    );
    selectionReadError = 'selection-missing-or-invalid';
  }

  const selectedFiles = resolveRequiredUnitFiles(selection);
  const requiredMode = selectedFiles ? 'affected' : 'full';
  const vitestEntry = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
  const args = [
    vitestEntry,
    'run',
    '--config',
    'vitest.unit.config.ts',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${resultsPath}`,
    // Vitest ignores file filters after a bare `--` and runs the full suite.
    // resolveRequiredUnitFiles rejects option-like and unsafe paths before they reach argv.
    ...(selectedFiles ?? []),
  ];
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    timeout: UNIT_RUN_TIMEOUT_MS,
  });
  const execution = {
    schema_version: 1,
    required_mode: requiredMode,
    requested_mode: selection?.requested_mode ?? 'full',
    effective_mode: selection?.effective_mode ?? 'full',
    fallback_reason: selection?.fallback_reason ?? selectionReadError,
    base: selection?.base ?? '',
    selector_duration_ms: selection?.selector_duration_ms,
    selected_files: selectedFiles?.length ?? null,
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
        '## Required unit selection',
        '',
        `- required mode: \`${requiredMode}\``,
        `- requested/effective: \`${markdownText(execution.requested_mode)}\` → \`${markdownText(execution.effective_mode)}\``,
        `- selected files: ${selectedFiles?.length ?? 'full suite'}`,
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
    const output = path.resolve(options.output ?? '.cache/ci-unit-selection.json');
    ensureParent(output);
    const selection = selectAffectedTests({
      root,
      base: options.base ?? '',
      requestedMode: options.mode ?? 'full',
      output,
    });
    console.log(JSON.stringify(selection, null, 2));
    return;
  }

  if (command === 'compare') {
    const selectionPath = path.resolve(options.selection ?? '.cache/ci-unit-selection.json');
    const resultsPath = path.resolve(options.results ?? '.cache/ci-unit-full.json');
    const output = path.resolve(options.output ?? '.cache/ci-unit-shadow.json');
    ensureParent(output);

    if (!existsSync(selectionPath) || !existsSync(resultsPath)) {
      writeUnavailableShadowReport({
        output,
        reason: !existsSync(selectionPath) ? 'selection-missing' : 'full-results-missing',
      });
      return;
    }

    let selection;
    let fullResults;
    try {
      selection = JSON.parse(readFileSync(selectionPath, 'utf8'));
      fullResults = JSON.parse(readFileSync(resultsPath, 'utf8'));
    } catch (error) {
      writeUnavailableShadowReport({
        output,
        reason: 'json-parse-failed',
        detail: error instanceof Error ? error.message : error,
      });
      return;
    }
    const report = buildShadowReport({ root, selection, fullResults });
    report.github = {
      run_id: process.env.GITHUB_RUN_ID,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT,
      sha: process.env.GITHUB_SHA,
      ref: process.env.GITHUB_REF,
      event_name: process.env.GITHUB_EVENT_NAME,
    };
    report.created_at = new Date().toISOString();
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdownReport(report));
    }
    if (report.missed_failures.length || report.changed_tests_missed.length) {
      console.log(
        `::warning title=Unit selector shadow miss::missed_failures=${report.missed_failures.length}, changed_tests_missed=${report.changed_tests_missed.length}`,
      );
    } else if (report.status === 'fallback') {
      console.log(
        `::warning title=Unit selector fell back to full::${report.fallback_reason ?? 'unknown'}`,
      );
    }
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (command === 'run') {
    const selectionPath = path.resolve(options.selection ?? '.cache/ci-unit-selection.json');
    const resultsPath = path.resolve(options.results ?? '.cache/ci-unit-results.json');
    const executionPath = path.resolve(options.execution ?? '.cache/ci-unit-execution.json');
    ensureParent(resultsPath);
    ensureParent(executionPath);
    const execution = runRequiredUnitTests({
      root,
      selectionPath,
      resultsPath,
      executionPath,
    });
    process.exitCode = execution.exit_code;
    return;
  }

  throw new Error('usage: unit-shadow.mjs <select|run|compare> [--key value]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
