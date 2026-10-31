/**
 * Ratchet for bare Postgres advisory-lock calls in production TypeScript.
 *
 * Approved homes may hold the SQL: src/kernel/locks/ and the shared helpers
 * that already issue it for their callers. Every other production file is
 * grandfathered by exact call count in scripts/audit-advisory-locks-baseline.json.
 * After this baseline exists on the comparison base, a higher count is a failure
 * even if the JSON is edited — new calls belong in an approved home.
 * Comments are ignored. This does not validate lock families or acquisition order.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSource } from './lib/ts-tokenize';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BASELINE_PATH = join(__dirname, 'audit-advisory-locks-baseline.json');
const SCAN_ROOTS = ['src', 'server', 'web', 'scripts'] as const;
const REQUIRED_REGISTRY = 'src/kernel/locks/registry.ts';
const APPROVED_PREFIXES = ['src/kernel/locks/'] as const;
const APPROVED_HELPERS = [
  'src/capabilities/agency/server/intervention/intervention-lock.ts',
  'src/db/learning-state-lock.ts',
  'src/db/session-advisory-lock.ts',
  'src/server/ai/provider-attempt-lock.ts',
] as const;
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git', 'tests']);
const SELF_PATH = 'scripts/audit-advisory-locks.ts';
const CALL_RE = /(?<![A-Za-z0-9_])pg_(?:try_)?advisory[A-Za-z0-9_]*/g;

type Site = { path: string; count: number };

type Baseline = { version: 1; sites: Site[] };

type Finding = { rule: string; detail: string };

function normalizePath(path: string): string {
  return path.split('\\').join('/');
}

function isApproved(path: string): boolean {
  if (APPROVED_HELPERS.includes(path as (typeof APPROVED_HELPERS)[number])) return true;
  return APPROVED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isProductionSource(name: string): boolean {
  if (!name.endsWith('.ts') && !name.endsWith('.tsx')) return false;
  if (name.endsWith('.d.ts')) return false;
  if (name.includes('.test.') || name.includes('.spec.')) return false;
  return true;
}

function walk(root: string, out: string[]): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) {
      walk(absolute, out);
      continue;
    }
    if (!entry.isFile() || !isProductionSource(entry.name)) continue;
    const path = normalizePath(relative(REPO_ROOT, absolute));
    if (path === SELF_PATH) continue;
    out.push(path);
  }
}

export function countAdvisoryCalls(source: string): number {
  const { commentMask } = analyzeSource(source);
  let count = 0;
  for (const match of source.matchAll(CALL_RE)) {
    const index = match.index ?? 0;
    if (commentMask[index] === 1) continue;
    count += 1;
  }
  return count;
}

function collectSites(): { scanned: number; sites: Site[] } {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root), files);
  files.sort();
  const sites: Site[] = [];
  for (const path of files) {
    if (isApproved(path)) continue;
    const count = countAdvisoryCalls(readFileSync(join(REPO_ROOT, path), 'utf8'));
    if (count > 0) sites.push({ path, count });
  }
  return { scanned: files.length, sites };
}

function parseBaseline(text: string, label: string): Baseline {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} root must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error(`${label} version must be 1`);
  if (!Array.isArray(record.sites)) throw new Error(`${label} sites must be an array`);
  const sites: Site[] = [];
  for (const entry of record.sites) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${label} site entry must be an object`);
    }
    const site = entry as Record<string, unknown>;
    if (typeof site.path !== 'string' || site.path.length === 0) {
      throw new Error(`${label} site path must be a string`);
    }
    if (!Number.isInteger(site.count) || (site.count as number) < 1) {
      throw new Error(`${label} site count must be a positive integer (${site.path})`);
    }
    sites.push({ path: normalizePath(site.path), count: site.count as number });
  }
  return { version: 1, sites };
}

function baselineShapeFindings(baseline: Baseline): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  let previous = '';
  for (const site of baseline.sites) {
    if (seen.has(site.path)) {
      findings.push({ rule: 'DUPLICATE_BASELINE', detail: site.path });
    }
    seen.add(site.path);
    if (site.path < previous) {
      findings.push({ rule: 'UNSORTED_BASELINE', detail: site.path });
    }
    previous = site.path;
    if (site.path.startsWith('/') || site.path.includes('..')) {
      findings.push({ rule: 'BAD_BASELINE_PATH', detail: site.path });
    }
    if (isApproved(site.path)) {
      findings.push({ rule: 'ALLOWLIST_OVERLAP', detail: site.path });
    }
  }
  return findings;
}

function resolveComparisonSha(): string | null {
  const env = process.env.TEST_POLICY_BASE || process.env.CAPABILITY_BASE_SHA || '';
  if (/^[0-9a-f]{40}$/.test(env)) return env;
  try {
    const sha = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function readBaseBaseline(sha: string): Baseline | null {
  try {
    const text = execFileSync(
      'git',
      ['show', `${sha}:scripts/audit-advisory-locks-baseline.json`],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return parseBaseline(text, `base ${sha}`);
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
    if (stderr.includes('does not exist') || stderr.includes('not in')) return null;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read baseline at ${sha}: ${message}`);
  }
}

function raisedFindings(current: Baseline, base: Baseline): Finding[] {
  const previous = new Map(base.sites.map((site) => [site.path, site.count]));
  const findings: Finding[] = [];
  for (const site of current.sites) {
    const before = previous.get(site.path) ?? 0;
    if (site.count > before) {
      findings.push({
        rule: 'BASELINE_RAISED',
        detail: `${site.path} ${before} -> ${site.count}`,
      });
    }
  }
  return findings;
}

function countFindings(actual: Site[], baseline: Baseline): Finding[] {
  const expected = new Map(baseline.sites.map((site) => [site.path, site.count]));
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const site of actual) {
    seen.add(site.path);
    const count = expected.get(site.path);
    if (count === undefined) {
      findings.push({ rule: 'UNREGISTERED_SITE', detail: `${site.path} count=${site.count}` });
      continue;
    }
    if (site.count !== count) {
      findings.push({
        rule: 'SITE_COUNT',
        detail: `${site.path} baseline=${count} actual=${site.count}`,
      });
    }
  }
  for (const site of baseline.sites) {
    if (!seen.has(site.path)) {
      findings.push({
        rule: 'BASELINE_STALE',
        detail: `${site.path} baseline=${site.count} actual=0`,
      });
    }
  }
  return findings;
}

function main(): void {
  const { scanned, sites } = collectSites();
  if (process.argv.includes('--print')) {
    process.stdout.write(`${JSON.stringify({ version: 1, sites }, null, 2)}\n`);
    return;
  }

  const findings: Finding[] = [];
  if (!existsSync(join(REPO_ROOT, REQUIRED_REGISTRY))) {
    findings.push({ rule: 'MISSING_REGISTRY', detail: REQUIRED_REGISTRY });
  }
  for (const helper of APPROVED_HELPERS) {
    if (!existsSync(join(REPO_ROOT, helper))) {
      findings.push({ rule: 'MISSING_APPROVED_HELPER', detail: helper });
    }
  }

  let baseline: Baseline;
  try {
    baseline = parseBaseline(readFileSync(BASELINE_PATH, 'utf8'), 'baseline');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`advisory-lock audit failed: ${message}`);
    process.exitCode = 1;
    return;
  }
  findings.push(...baselineShapeFindings(baseline));
  findings.push(...countFindings(sites, baseline));

  const sha = resolveComparisonSha();
  if (!sha) {
    console.error('advisory-lock audit: no comparison base; baseline raise check skipped');
  } else {
    try {
      const base = readBaseBaseline(sha);
      if (base) findings.push(...raisedFindings(baseline, base));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      findings.push({ rule: 'BASE_UNREADABLE', detail: message });
    }
  }

  if (findings.length > 0) {
    console.error('advisory-lock audit failed:');
    for (const finding of findings) console.error(`  ${finding.rule} ${finding.detail}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `advisory-lock audit passed (${scanned} production files, ${sites.length} grandfathered).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
