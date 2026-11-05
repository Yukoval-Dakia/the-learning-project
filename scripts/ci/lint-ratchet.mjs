import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// YUK-909 — deterministic lint warning ratchet over `biome check .`.
//
// The ceiling is the base commit's measured diagnostics (`--base <sha>` or LINT_BASE_SHA, set
// by CI; otherwise the fork point with origin/main). Growth in any severity fails; a shortfall
// passes, so parallel PRs that each remove warnings never collide on a shared ledger file.
// There is no checked-in baseline: the base comparison is the only gate. The base is counted
// on a detached worktree with the head's Biome binary, so a Biome bump counts the same rules
// on both sides. Diagnostic emission order from Biome's parallel scanner is not stable, so
// counting sorts by rule before any comparison. Info diagnostics are counted.

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

// Growth over the ceiling is the only failure; a shortfall (`stale`) passes and is reported.
// `baseline` carries the base commit's measured counts in { totals, byRule } shape.
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

function git(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// `pull_request.base.sha` is the base branch tip, not where the PR forked; comparing against
// the fork point keeps a later main from failing older PRs. The base comparison is the only
// gate, so it fails closed: CI must pin a base, and a local run without a resolvable merge-base
// is an error, not a pass.
function comparisonBase(repoRoot, args) {
  const flag = args.indexOf('--base');
  if (flag >= 0 && !args[flag + 1]) throw new Error('[lint-ratchet] --base needs a commit SHA');
  const value = flag >= 0 ? args[flag + 1] : process.env.LINT_BASE_SHA;
  // A branch-creating push reports an all-zero `before`; there is no explicit base then.
  if (!value || /^0+$/.test(value)) {
    if (process.env.CI) {
      throw new Error('[lint-ratchet] CI requires LINT_BASE_SHA or --base <commit>.');
    }
    try {
      return git(repoRoot, ['merge-base', 'origin/main', 'HEAD']).trim();
    } catch {
      throw new Error(
        '[lint-ratchet] could not merge-base against origin/main; fetch it or pass --base <sha>.',
      );
    }
  }
  if (!/^[a-f0-9]{40}$/.test(value)) {
    throw new Error(`[lint-ratchet] comparison base must be a full, nonzero commit SHA: ${value}`);
  }
  try {
    return git(repoRoot, ['merge-base', value, 'HEAD']).trim();
  } catch {
    throw new Error(
      `[lint-ratchet] could not merge-base against ${value}; fetch the base commit first.`,
    );
  }
}

// Measured on a detached worktree of the base commit with the head's Biome binary, so a Biome
// bump counts the same rules on both sides. There is no file ceiling to fall back to; a base
// that cannot be measured fails the run rather than disabling the gate.
function countAtBase(repoRoot, base) {
  const dir = mkdtempSync(path.join(tmpdir(), 'lint-ratchet-base-'));
  try {
    git(repoRoot, ['worktree', 'add', '--detach', dir, base]);
    try {
      return collectCurrent(repoRoot, dir);
    } finally {
      try {
        git(repoRoot, ['worktree', 'remove', dir]);
      } catch {
        git(repoRoot, ['worktree', 'prune']);
      }
    }
  } catch (error) {
    console.warn(
      `[lint-ratchet] could not count diagnostics at base ${base.slice(0, 12)}: ${error instanceof Error ? error.message : error}`,
    );
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function renderStale(staleBy) {
  const detail = Object.entries(staleBy)
    .map(([plural, by]) => `${by} fewer ${plural}`)
    .join(', ');
  return `[lint-ratchet] below the base count (${detail}); the ceiling follows main automatically.`;
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
  }
  lines.push(
    'Fix the new diagnostics — the ceiling is the count measured on the merge-base commit.',
  );
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const current = collectCurrent(repoRoot);

  if (current.errors > 0) {
    console.error(
      `[lint-ratchet] FAIL: biome reported ${current.errors} error diagnostics; fix them first.`,
    );
    process.exitCode = 1;
    return;
  }

  const base = comparisonBase(repoRoot, args);
  const baseCount = countAtBase(repoRoot, base);
  if (!baseCount) {
    console.error(
      `[lint-ratchet] FAIL: diagnostics at base ${base.slice(0, 12)} could not be measured; the base comparison is the only gate.`,
    );
    process.exitCode = 1;
    return;
  }

  const baseline = {
    totals: {
      errors: baseCount.errors,
      warnings: baseCount.warnings,
      infos: baseCount.infos,
    },
    byRule: baseCount.byRule,
  };
  const verdict = evaluateRatchet(current, baseline);
  if (verdict.kind === 'regression') {
    const deltas = ruleDeltas(current, baseline);
    for (const regression of verdict.regressions) {
      console.error(renderRegression(regression, deltas));
    }
    process.exitCode = 1;
    return;
  }
  if (verdict.kind === 'stale') console.log(renderStale(verdict.staleBy));
  console.log(
    `[lint-ratchet] OK: ${current.warnings} warnings / ${current.infos} infos within base ${base.slice(0, 12)} count ${baseline.totals.warnings} / ${baseline.totals.infos}.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
