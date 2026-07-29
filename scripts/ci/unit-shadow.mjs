import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SHADOW_SENTINEL_TESTS = [
  'src/server/ai/retry-optin.test.ts',
  'src/subjects/skill-namespace.test.ts',
  'src/subjects/skills-image-coverage.test.ts',
  'tests/integration/session-single-owner.test.ts',
  'tests/integration/step9-invariant-audit.test.ts',
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

export function mergePredictedFiles(entries, root) {
  const predicted = entries
    .map((entry) => (typeof entry === 'string' ? entry : entry?.file))
    .filter((file) => typeof file === 'string')
    .map((file) => normalizeRepoFile(file, root));
  return sortedUnique([...predicted, ...SHADOW_SENTINEL_TESTS]);
}

function readChangedFiles(base, root) {
  const output = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return output
    ? sortedUnique(output.split('\n').map((file) => normalizeRepoFile(file, root)))
    : [];
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

function selectAffectedTests({ root, base, requestedMode, output }) {
  let changedFiles = [];
  try {
    changedFiles = readChangedFiles(base, root);
  } catch {
    const selection = fullFallbackSelection({
      requestedMode,
      base,
      changedFiles,
      reason: 'changed-files-unavailable',
    });
    writeFileSync(output, `${JSON.stringify(selection, null, 2)}\n`);
    return selection;
  }

  if (requestedMode !== 'affected') {
    const selection = fullFallbackSelection({
      requestedMode,
      base,
      changedFiles,
      reason: requestedMode === 'full' ? 'gate-plan-full-trigger' : 'selector-not-requested',
    });
    writeFileSync(output, `${JSON.stringify(selection, null, 2)}\n`);
    return selection;
  }

  const rawOutput = path.join(path.dirname(output), 'unit-affected-vitest.json');
  const vitestEntry = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
  const startedAt = Date.now();
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
    { cwd: root, encoding: 'utf8' },
  );

  if (result.status !== 0 || !existsSync(rawOutput)) {
    const selection = fullFallbackSelection({
      requestedMode,
      base,
      changedFiles,
      reason: `vitest-list-failed:${result.status ?? 'signal'}`,
    });
    selection.selector_stderr = result.stderr?.trim().slice(0, 2_000) || undefined;
    writeFileSync(output, `${JSON.stringify(selection, null, 2)}\n`);
    return selection;
  }

  try {
    const entries = JSON.parse(readFileSync(rawOutput, 'utf8'));
    const selection = {
      schema_version: 1,
      requested_mode: requestedMode,
      effective_mode: 'affected',
      base,
      changed_files: changedFiles,
      predicted_files: mergePredictedFiles(entries, root),
      selector_duration_ms: Date.now() - startedAt,
    };
    writeFileSync(output, `${JSON.stringify(selection, null, 2)}\n`);
    return selection;
  } catch {
    const selection = fullFallbackSelection({
      requestedMode,
      base,
      changedFiles,
      reason: 'vitest-list-json-invalid',
    });
    writeFileSync(output, `${JSON.stringify(selection, null, 2)}\n`);
    return selection;
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
  const changedTests = selection.changed_files.filter(
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
    changed_files: selection.changed_files,
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
  if (report.fallback_reason) rows.push(`- fallback: \`${report.fallback_reason}\``);
  if (report.missed_failures.length) {
    rows.push('', '### Missed failures', ...report.missed_failures.map((file) => `- \`${file}\``));
  }
  if (report.changed_tests_missed.length) {
    rows.push(
      '',
      '### Direct test misses',
      ...report.changed_tests_missed.map((file) => `- \`${file}\``),
    );
  }
  rows.push('');
  return `${rows.join('\n')}\n`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--')) continue;
    options[arg.slice(2)] = rest[index + 1];
    index += 1;
  }
  return { command, options };
}

function ensureParent(file) {
  mkdirSync(path.dirname(file), { recursive: true });
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
      const unavailable = {
        schema_version: 1,
        status: 'unavailable',
        reason: !existsSync(selectionPath) ? 'selection-missing' : 'full-results-missing',
      };
      writeFileSync(output, `${JSON.stringify(unavailable, null, 2)}\n`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `## Unit affected-test shadow\n\n- status: \`unavailable\`\n- reason: \`${unavailable.reason}\`\n\n`,
        );
      }
      console.log(`::warning title=Unit selector shadow unavailable::${unavailable.reason}`);
      return;
    }

    const selection = JSON.parse(readFileSync(selectionPath, 'utf8'));
    const fullResults = JSON.parse(readFileSync(resultsPath, 'utf8'));
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

  throw new Error('usage: unit-shadow.mjs <select|compare> [--key value]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
