#!/usr/bin/env node
// YUK-1023 — regenerate scripts/ci/db-test-durations.json, the committed
// per-file duration baseline that db-affected.mjs uses for LPT shard packing.
//
// Runs the full db partition once with the JSON reporter and records each
// file's wall time (endTime-startTime, i.e. including fork-pool waiting —
// the same signal CI shards experience). Requires Docker for the
// testcontainer Postgres. Expect a single-digit-minute run locally.
//
//   pnpm gen:db-test-durations                 # full run + write baseline
//   node scripts/ci/gen-db-test-durations.mjs <report.json>  # reuse an existing report
//
// Re-run after adding/removing db test files or when shard balance drifts.
// Files absent from the baseline fall back to the suite median at pack time,
// so a stale baseline degrades gracefully instead of misbalancing forever.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

function main() {
  const existingReport = process.argv[2];
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
  if (Object.keys(durations).length === 0) {
    throw new Error(
      'no per-file durations in the vitest report — refusing to write an empty baseline',
    );
  }
  const sorted = Object.fromEntries(
    Object.entries(durations).sort(([a], [b]) => a.localeCompare(b)),
  );
  const baseline = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source: 'pnpm gen:db-test-durations (local full db run)',
    durations: sorted,
  };
  writeFileSync(OUT, `${JSON.stringify(baseline, null, 2)}\n`);
  const total = Object.values(sorted).reduce((a, b) => a + b, 0);
  console.log(
    `[gen-db-test-durations] wrote ${OUT}: ${Object.keys(sorted).length} files, ` +
      `${Math.round(total / 60000)}min cumulative, vitest exit ${vitestStatus}`,
  );
  if (vitestStatus !== 0) {
    console.warn(
      '[gen-db-test-durations] vitest exited non-zero — durations still recorded; ' +
        'failing files may be under-measured.',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
