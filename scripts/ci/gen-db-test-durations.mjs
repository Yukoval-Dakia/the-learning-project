#!/usr/bin/env node
// YUK-1023 — regenerate scripts/ci/db-test-durations.json, the committed
// per-file duration baseline that db-affected.mjs uses for LPT shard packing.
//
// Two refresh paths:
//
//   pnpm gen:db-test-durations                 # local full db run + write baseline
//   node scripts/ci/gen-db-test-durations.mjs <report.json>  # reuse a report
//   node scripts/ci/gen-db-test-durations.mjs --merge-artifacts <dir> [--out <file>]
//
// The local path runs the full db partition once with the JSON reporter and
// records each file's wall time (endTime-startTime, i.e. including fork-pool
// waiting — the same signal CI shards experience). Requires Docker for the
// testcontainer Postgres. Expect a triple-digit-minute run locally.
//
// YUK-1024 — `--merge-artifacts` is the preferred refresh: local hardware is
// ~3-7x slower than CI runners, so a locally generated baseline keeps the
// relative order right but inflates every absolute estimate (~24.5min/bin
// predicted vs ~4.5min actual on CI). Each CI DB shard uploads a
// `db-selector-report-shard-N` artifact whose db-execution-N.json carries
// per-file `file_durations` measured on the runner; merging all shards
// re-baselines on CI-true numbers:
//
//   gh run download <run-id> -D /tmp/db-artifacts \
//     -n db-selector-report-shard-1 -n db-selector-report-shard-2 \
//     -n db-selector-report-shard-3 -n db-selector-report-shard-4
//   node scripts/ci/gen-db-test-durations.mjs --merge-artifacts /tmp/db-artifacts
//
// Each file lands in exactly one shard, so merging is a union; if a file ever
// appears in two artifacts (shard retry, mixed runs) the mean wins. When a
// db-selection.json sits next to the executions its inventory_files is used
// to report coverage. Re-run after adding/removing db test files or when
// shard balance drifts — files absent from the baseline fall back to the
// suite median at pack time, so a stale baseline degrades gracefully.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { binPackDbShards } from './db-affected.mjs';

const REPORT = path.join(tmpdir(), `db-durations-${process.pid}.json`);
const OUT = path.join('scripts', 'ci', 'db-test-durations.json');

// Resolve the repo root that produced the report: cwd if it works, else the
// nearest ancestor directory containing vitest.db.config.ts (handles reports
// generated from a different worktree/checkout than the current cwd).
const rootCache = new Map();
function repoRootFor(name) {
  const cwd = process.cwd();
  if (name.startsWith(`${cwd}${path.sep}`)) return cwd;
  let dir = path.dirname(name);
  const visited = [];
  while (true) {
    if (rootCache.has(dir)) {
      for (const d of visited) rootCache.set(d, rootCache.get(dir));
      return rootCache.get(dir);
    }
    if (existsSync(path.join(dir, 'vitest.db.config.ts'))) {
      for (const d of visited) rootCache.set(d, dir);
      rootCache.set(dir, dir);
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return cwd;
    visited.push(dir);
    dir = parent;
  }
}

export function durationsFromVitestReport(report) {
  const durations = {};
  for (const entry of report?.testResults ?? []) {
    const name = typeof entry?.name === 'string' ? entry.name : null;
    const ms = Number.isFinite(entry?.duration)
      ? entry.duration
      : Number.isFinite(entry?.endTime) && Number.isFinite(entry?.startTime)
        ? entry.endTime - entry.startTime
        : null;
    if (!name || !Number.isFinite(ms)) continue;
    // Store repo-relative paths so the baseline is machine-independent.
    const rel = name.split('/').includes('..') ? name : path.relative(repoRootFor(name), name);
    durations[rel.split(path.sep).join('/')] = Math.round(ms);
  }
  return durations;
}

// YUK-1024 — merge per-shard `file_durations` maps (already repo-relative
// paths → ms, measured on CI runners) into one baseline. Each file lands in
// exactly one shard, so this is a union; a file seen in several executions
// (shard retry, mixed downloads) takes the mean of its observations.
export function mergeShardFileDurations(executions) {
  const observations = new Map();
  for (const execution of executions) {
    const fileDurations = execution?.file_durations;
    if (
      typeof fileDurations !== 'object' ||
      fileDurations === null ||
      Array.isArray(fileDurations)
    ) {
      continue;
    }
    for (const [file, value] of Object.entries(fileDurations)) {
      if (typeof file !== 'string' || file.length === 0 || !Number.isFinite(value)) continue;
      const entry = observations.get(file) ?? { total: 0, count: 0 };
      entry.total += value;
      entry.count += 1;
      observations.set(file, entry);
    }
  }
  const durations = {};
  for (const [file, { total, count }] of observations) {
    durations[file] = Math.round(total / count);
  }
  return durations;
}

// `gh run download -n db-selector-report-shard-N` unpacks every artifact into
// its own subdirectory, but a flat directory of db-execution-*.json files also
// works — scan recursively for both shapes. Returns execution reports and any
// db-selection.json siblings (their inventory_files drives coverage output).
export function findShardArtifactFiles(dir) {
  const executions = [];
  const selections = [];
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
      } else if (/^db-execution-\d+\.json$/.test(entry.name)) {
        executions.push(full);
      } else if (entry.name === 'db-selection.json') {
        selections.push(full);
      }
    }
  }
  executions.sort();
  selections.sort();
  return { executions, selections };
}

function readJsonOrNull(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function sortDurations(durations) {
  return Object.fromEntries(Object.entries(durations).sort(([a], [b]) => a.localeCompare(b)));
}

function writeBaseline({ durations, source, out, logSuffix = '' }) {
  const sorted = sortDurations(durations);
  if (Object.keys(sorted).length === 0) {
    throw new Error('no per-file durations collected — refusing to write an empty baseline');
  }
  const baseline = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source,
    durations: sorted,
  };
  writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`);
  const total = Object.values(sorted).reduce((a, b) => a + b, 0);
  console.log(
    `[gen-db-test-durations] wrote ${out}: ${Object.keys(sorted).length} files, ` +
      `${Math.round(total / 60000)}min cumulative${logSuffix}`,
  );
  return sorted;
}

function mergeArtifacts(dir, out) {
  const { executions: reportPaths, selections: selectionPaths } = findShardArtifactFiles(dir);
  if (reportPaths.length === 0) {
    throw new Error(`no db-execution-*.json files found under ${dir}`);
  }
  const executions = [];
  for (const reportPath of reportPaths) {
    const parsed = readJsonOrNull(reportPath);
    if (parsed === null) {
      console.warn(`[gen-db-test-durations] skipping unreadable report: ${reportPath}`);
      continue;
    }
    executions.push(parsed);
  }
  const durations = mergeShardFileDurations(executions);
  const runIds = [
    ...new Set(executions.map((execution) => execution?.github?.run_id).filter(Boolean)),
  ];
  const source =
    runIds.length > 0
      ? `CI shard file_durations merged via --merge-artifacts (gh run ${runIds.join(', ')})`
      : 'CI shard file_durations merged via --merge-artifacts';
  const sorted = writeBaseline({ durations, source, out });

  // Coverage: when a db-selection.json sits next to the executions, its
  // inventory_files is the CI-truth file list — diff it against the baseline.
  const selection = selectionPaths
    .map((selectionPath) => readJsonOrNull(selectionPath))
    .find((parsed) => Array.isArray(parsed?.inventory_files));
  const inventory = Array.isArray(selection?.inventory_files)
    ? [...new Set(selection.inventory_files)].sort()
    : null;
  if (inventory) {
    const merged = new Set(Object.keys(sorted));
    const inventorySet = new Set(inventory);
    const missing = inventory.filter((file) => !merged.has(file));
    const extra = [...merged].filter((file) => !inventorySet.has(file));
    if (missing.length === 0 && extra.length === 0) {
      console.log(
        `[gen-db-test-durations] coverage: baseline keys == CI inventory (${inventory.length} files)`,
      );
    } else {
      console.warn(
        `[gen-db-test-durations] coverage drift vs CI inventory (${inventory.length} files): ` +
          `${missing.length} missing, ${extra.length} extra` +
          (missing.length ? ` — missing: ${missing.slice(0, 10).join(', ')}` : '') +
          (extra.length ? ` — extra: ${extra.slice(0, 10).join(', ')}` : ''),
      );
    }
  }

  // Sanity: repack with the fresh numbers so the printout shows whether the
  // new baseline actually predicts CI-true shard times (~5min/bin), not just
  // that a file got written.
  const shardCount = executions.length;
  const files = inventory ?? Object.keys(sorted);
  if (shardCount > 0 && files.length > 0) {
    const bins = binPackDbShards({ files, shardCount, durations: sorted });
    const estimates = bins.map((bin) => (bin.estimatedMs / 60000).toFixed(1));
    console.log(
      `[gen-db-test-durations] repack preview over ${shardCount} shards: ` +
        `${estimates.join(' / ')} min per bin`,
    );
  }
  return sorted;
}

function parseMergeArgs(args) {
  let dir;
  let out = OUT;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--out') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--out requires a file path');
      }
      out = value;
      index += 1;
    } else if (!arg.startsWith('--') && dir === undefined) {
      dir = arg;
    } else {
      throw new Error(`unexpected --merge-artifacts argument: ${arg}`);
    }
  }
  if (!dir) {
    throw new Error('usage: gen-db-test-durations.mjs --merge-artifacts <dir> [--out <file>]');
  }
  return { dir, out };
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--merge-artifacts') {
    const { dir, out } = parseMergeArgs(args.slice(1));
    if (!existsSync(dir)) {
      throw new Error(`artifact directory not found: ${dir}`);
    }
    mergeArtifacts(dir, out);
    return;
  }

  const existingReport = args[0];
  let vitestStatus = 0;
  const reportPath = existingReport ?? REPORT;
  if (!existingReport) {
    const vitestEntry = path.join('node_modules', 'vitest', 'vitest.mjs');
    const result = spawnSync(
      process.execPath,
      [
        vitestEntry,
        'run',
        '--config',
        'vitest.db.config.ts',
        '--reporter=json',
        `--outputFile=${REPORT}`,
      ],
      { stdio: 'inherit' },
    );
    vitestStatus = result.status ?? 1;
  }
  if (!existsSync(reportPath)) {
    throw new Error(`vitest did not produce a JSON report at ${reportPath}`);
  }
  const durations = durationsFromVitestReport(JSON.parse(readFileSync(reportPath, 'utf8')));
  if (!existingReport) rmSync(reportPath, { force: true });
  writeBaseline({
    durations,
    source: 'pnpm gen:db-test-durations (local full db run)',
    out: OUT,
    logSuffix: `, vitest exit ${vitestStatus}`,
  });
  if (vitestStatus !== 0) {
    console.warn(
      '[gen-db-test-durations] vitest exited non-zero — durations still recorded; ' +
        'failing files may be under-measured.',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
