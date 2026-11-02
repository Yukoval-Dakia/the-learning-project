import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// YUK-909 — deterministic lint warning ratchet over `biome check .`.
//
// The baseline file (scripts/lint-baseline.json) records Biome 2 warning/info totals plus
// per-rule counts. Growth fails; a shortfall passes, so parallel PRs that each remove a
// warning do not have to rewrite the same file. With a comparison base (`--base <sha>` or
// LINT_BASE_SHA, set by CI), the ceiling per severity is the lower of the file and the
// count measured on the base commit, so the effective baseline is main's real count
// without committing it back; a head file whose totals exceed the base file fails.
// Diagnostic emission order from Biome's parallel scanner is not stable, so counting
// sorts by rule before any comparison or serialization. Info diagnostics are counted.
//
// Lowering the file is optional housekeeping: pnpm lint:ratchet:update
// (refuses to write a document that raises any severity total).

const BASELINE_RELATIVE_PATH = 'scripts/lint-baseline.json';

const SEVERITIES = ['error', 'warning', 'info'];

function countBySeverity(counts, severity) {
  return counts[severity] ?? 0;
}

export function summarizeDiagnostics(diagnostics) {
  const summary = { errors: 0, warnings: 0, infos: 0, byRule: {} };
  for (const diagnostic of diagnostics) {
    const severity = diagnostic?.severity;
    const category = diagnostic?.category ?? 'uncategorized';
    if (!SEVERITIES.includes(severity)) continue;
    summary[`${severity}s`] += 1;
    let rule = summary.byRule[category];
    if (rule === undefined) {
      rule = {};
      summary.byRule[category] = rule;
    }
    rule[severity] = (rule[severity] ?? 0) + 1;
  }
  return summary;
}

function severityPlural(severity) {
  return `${severity}s`;
}

function ratchetKind(regressions, staleBy) {
  if (regressions.length > 0) return 'regression';
  if (Object.keys(staleBy).length > 0) return 'stale';
  return 'match';
}

// Growth over the ceiling is the only failure; a shortfall (`stale`) passes and is
// reported so the file can be lowered later.
export function evaluateRatchet(current, baseline) {
  const regressions = [];
  const staleBy = {};
  for (const severity of SEVERITIES) {
    const plural = severityPlural(severity);
    const currentCount = current[plural] ?? 0;
    const baselineCount = baseline?.totals?.[plural] ?? 0;
    if (currentCount > baselineCount) {
      regressions.push({ severity, baseline: baselineCount, current: currentCount });
    } else if (currentCount < baselineCount) {
      staleBy[plural] = baselineCount - currentCount;
    }
  }
  const kind = ratchetKind(regressions, staleBy);
  return { ok: kind !== 'regression', kind, staleBy, regressions };
}

// Per-rule delta rows (positive delta = growth) for human review of a regression.
export function ruleDeltas(current, baseline) {
  const rows = [];
  const baselineRules = baseline?.byRule ?? {};
  for (const [category, baselineCounts] of Object.entries(baselineRules)) {
    for (const [severity, baselineCount] of Object.entries(baselineCounts)) {
      const currentCount = countBySeverity(current.byRule[category] ?? {}, severity);
      const delta = currentCount - baselineCount;
      if (delta !== 0)
        rows.push({ category, severity, baseline: baselineCount, current: currentCount, delta });
    }
  }
  for (const [category, currentCounts] of Object.entries(current.byRule)) {
    for (const [severity, currentCount] of Object.entries(currentCounts)) {
      const baselineCount = countBySeverity(baselineRules[category] ?? {}, severity);
      if (baselineCount === 0 && currentCount > 0) {
        rows.push({ category, severity, baseline: 0, current: currentCount, delta: currentCount });
      }
    }
  }
  return rows.sort(
    (a, b) =>
      b.delta - a.delta ||
      a.category.localeCompare(b.category) ||
      a.severity.localeCompare(b.severity),
  );
}

export function buildBaselineDocument(summary) {
  const byRule = {};
  for (const category of Object.keys(summary.byRule).sort((a, b) => a.localeCompare(b))) {
    const counts = summary.byRule[category];
    byRule[category] = Object.fromEntries(
      SEVERITIES.filter((severity) => counts[severity] !== undefined).map((severity) => [
        severity,
        counts[severity],
      ]),
    );
  }
  return {
    schemaVersion: 1,
    channel:
      'biome check . --reporter=json --max-diagnostics=none (summary totals + per-diagnostic category)',
    infoPolicy:
      'info diagnostics are counted: separate infos ratchet total and per-rule rows; each severity total must equal the baseline',
    totals: { errors: summary.errors, warnings: summary.warnings, infos: summary.infos },
    byRule,
  };
}

function runBiomeJson(repoRoot, checkRoot = repoRoot) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules/@biomejs/biome/bin/biome'),
      'check',
      '.',
      '--reporter=json',
      '--max-diagnostics=none',
    ],
    {
      cwd: checkRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) {
    throw new Error(`[lint-ratchet] failed to spawn biome: ${result.error.message}`);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.signal || result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    throw new Error(
      `[lint-ratchet] biome failed (exit ${result.status}, signal ${result.signal ?? 'none'})`,
    );
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `[lint-ratchet] biome JSON reporter output is not parseable (exit ${result.status}): ${error instanceof Error ? error.message : error}`,
    );
  }
  const summary = report?.summary;
  if (
    typeof summary?.errors !== 'number' ||
    typeof summary.warnings !== 'number' ||
    typeof summary.infos !== 'number'
  ) {
    throw new Error(
      '[lint-ratchet] biome report is missing numeric summary totals — reporter drift?',
    );
  }
  if (summary.diagnosticsNotPrinted > 0) {
    throw new Error(
      `[lint-ratchet] ${summary.diagnosticsNotPrinted} diagnostics not printed — counting channel is incomplete`,
    );
  }
  return report;
}

function collectCurrent(repoRoot, checkRoot = repoRoot) {
  const report = runBiomeJson(repoRoot, checkRoot);
  const current = summarizeDiagnostics(report.diagnostics ?? []);
  for (const severity of SEVERITIES) {
    const counted = current[severityPlural(severity)];
    const reported = report.summary[severityPlural(severity)];
    if (counted !== reported) {
      throw new Error(
        `[lint-ratchet] counted ${severity}s (${counted}) != summary (${reported}) — reporter drift, refusing to gate`,
      );
    }
  }
  return current;
}

function readBaselineOrNull(repoRoot) {
  const file = path.join(repoRoot, BASELINE_RELATIVE_PATH);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new Error(
      `[lint-ratchet] cannot read baseline ${BASELINE_RELATIVE_PATH}: ${error instanceof Error ? error.message : error}`,
    );
  }
  let baseline;
  try {
    baseline = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `[lint-ratchet] baseline ${BASELINE_RELATIVE_PATH} is not valid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (baseline?.schemaVersion !== 1) {
    throw new Error(
      `[lint-ratchet] baseline ${BASELINE_RELATIVE_PATH} has unsupported schemaVersion`,
    );
  }
  return baseline;
}

function git(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function comparisonBase(args) {
  const flag = args.indexOf('--base');
  const value = flag >= 0 ? args[flag + 1] : process.env.LINT_BASE_SHA;
  // A branch-creating push reports an all-zero `before`; there is no base to compare.
  if (!value || /^0+$/.test(value)) return null;
  if (!/^[a-f0-9]{40}$/.test(value)) {
    throw new Error(`[lint-ratchet] comparison base must be a full, nonzero commit SHA: ${value}`);
  }
  return value;
}

function baselineAtBase(repoRoot, base) {
  let raw;
  try {
    raw = git(repoRoot, ['show', `${base}:${BASELINE_RELATIVE_PATH}`]);
  } catch {
    return null;
  }
  return JSON.parse(raw);
}

// Measured on a detached worktree of the base commit with the head's Biome binary, so a
// Biome bump counts the same rules on both sides. A base Biome cannot read (config drift
// across a Biome upgrade) falls back to the file ceiling instead of blocking the change.
function countAtBase(repoRoot, base) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lint-ratchet-base-'));
  try {
    git(repoRoot, ['worktree', 'add', '--detach', dir, base]);
    try {
      return collectCurrent(repoRoot, dir);
    } finally {
      git(repoRoot, ['worktree', 'remove', dir]);
    }
  } catch (error) {
    console.warn(
      `[lint-ratchet] could not count diagnostics at base ${base.slice(0, 12)} (${error instanceof Error ? error.message : error}); using the baseline file as the ceiling.`,
    );
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ceilingDocument(baseline, baseCount) {
  if (!baseCount) return baseline;
  const totals = { ...baseline.totals };
  for (const severity of SEVERITIES) {
    const plural = severityPlural(severity);
    totals[plural] = Math.min(totals[plural] ?? 0, baseCount[plural] ?? 0);
  }
  return { ...baseline, totals };
}

function raisedTotals(headBaseline, baseBaseline) {
  return SEVERITIES.map(severityPlural).filter(
    (plural) => (headBaseline.totals?.[plural] ?? 0) > (baseBaseline.totals?.[plural] ?? 0),
  );
}

function renderStale(staleBy) {
  const detail = Object.entries(staleBy)
    .map(([plural, by]) => `${by} fewer ${plural}`)
    .join(', ');
  return `[lint-ratchet] below the ceiling (${detail}); the file can be lowered any time with: pnpm lint:ratchet:update`;
}

function renderRegression(regression, deltas) {
  const lines = [
    `[lint-ratchet] FAIL: ${regression.severity} diagnostics grew from ${regression.baseline} to ${regression.current} (+${regression.current - regression.baseline}).`,
  ];
  if (deltas.length > 0) {
    lines.push(
      'Per-rule deltas (positive = growth):',
      '  delta  severity   rule',
      ...deltas.map(
        (row) =>
          `  ${row.delta > 0 ? '+' : ''}${String(row.delta).padStart(4)}  ${row.severity.padEnd(9)}  ${row.category} (${row.baseline} -> ${row.current})`,
      ),
    );
  } else {
    lines.push(
      'No single rule accounts for the delta — the baseline totals do not match its per-rule counts. Regenerate with: pnpm lint:ratchet:update',
    );
  }
  lines.push(
    'Fix the new diagnostics, or land a warning-fixing batch and lower the baseline with: pnpm lint:ratchet:update',
    'The baseline may only decrease — raising it is not supported.',
  );
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const current = collectCurrent(repoRoot);

  if (current.errors > 0) {
    console.error(
      `[lint-ratchet] FAIL: biome reported ${current.errors} error diagnostics; fix them first.`,
    );
    process.exitCode = 1;
    return;
  }

  if (update) {
    const existing = readBaselineOrNull(repoRoot);
    if (existing) {
      const verdict = evaluateRatchet(current, existing);
      if (verdict.kind === 'regression') {
        for (const regression of verdict.regressions) {
          console.error(renderRegression(regression, ruleDeltas(current, existing)));
        }
        console.error('[lint-ratchet] refusing to raise the baseline — it may only decrease.');
        process.exitCode = 1;
        return;
      }
    }
    const file = path.join(repoRoot, BASELINE_RELATIVE_PATH);
    writeFileSync(file, `${JSON.stringify(buildBaselineDocument(current), null, 2)}\n`);
    console.log(
      `[lint-ratchet] baseline written at ${BASELINE_RELATIVE_PATH}: ${current.warnings} warnings / ${current.infos} infos.`,
    );
    return;
  }

  const loaded = readBaselineOrNull(repoRoot);
  if (!loaded) {
    console.error(
      `[lint-ratchet] baseline ${BASELINE_RELATIVE_PATH} is missing. Generate it with: pnpm lint:ratchet:update`,
    );
    process.exitCode = 1;
    return;
  }
  const base = comparisonBase(args);
  if (base) {
    const baseBaseline = baselineAtBase(repoRoot, base);
    const raised = baseBaseline ? raisedTotals(loaded, baseBaseline) : [];
    if (raised.length > 0) {
      console.error(
        `[lint-ratchet] FAIL: ${BASELINE_RELATIVE_PATH} raises ${raised.join(', ')} above base ${base.slice(0, 12)}. The baseline may only decrease.`,
      );
      process.exitCode = 1;
      return;
    }
  }
  const baseline = ceilingDocument(loaded, base ? countAtBase(repoRoot, base) : null);
  const verdict = evaluateRatchet(current, baseline);
  if (verdict.kind === 'regression') {
    const deltas = ruleDeltas(current, loaded);
    for (const regression of verdict.regressions) {
      console.error(renderRegression(regression, deltas));
    }
    process.exitCode = 1;
    return;
  }
  if (verdict.kind === 'stale') console.log(renderStale(verdict.staleBy));
  console.log(
    `[lint-ratchet] OK: ${current.warnings} warnings / ${current.infos} infos within ceiling ${baseline.totals.warnings} / ${baseline.totals.infos}${base ? ` (file and base ${base.slice(0, 12)})` : ' (file)'}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
