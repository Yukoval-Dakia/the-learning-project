/**
 * Ratchet for bare Postgres advisory-lock calls in production TypeScript.
 *
 * Approved homes may hold the SQL: src/kernel/locks/ and the shared helpers
 * that already issue it for their callers. Every other production file is
 * grandfathered by the call count measured on the comparison base commit:
 * a site present at base may keep (or shrink) its count; a new site or a
 * higher count fails — new calls belong in an approved home. A rename
 * carries its existing budget. Comments are ignored. This does not validate
 * lock families or acquisition order.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listTreeFiles,
  readBlobs,
  resolveAuditBaseSha,
  worktreeRenameMap,
} from './lib/git-base-scan';
import { analyzeSource } from './lib/ts-tokenize';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCAN_ROOTS = ['src', 'server', 'web', 'scripts'] as const;
const REQUIRED_REGISTRY = 'src/kernel/locks/registry.ts';
const APPROVED_PREFIXES = ['src/kernel/locks/'] as const;
const APPROVED_HELPERS = [
  'src/capabilities/agency/server/conjecture/probe-lock.ts',
  'src/capabilities/agency/server/intervention/intervention-lock.ts',
  'src/kernel/events/correction-lock.ts',
  'src/db/learning-state-lock.ts',
  'src/db/session-advisory-lock.ts',
  'src/server/ai/provider-attempt-lock.ts',
] as const;
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git', 'tests']);
const SELF_PATH = 'scripts/audit-advisory-locks.ts';
const CALL_RE = /(?<![A-Za-z0-9_])pg_(?:try_)?advisory[A-Za-z0-9_]*/g;

type Site = { path: string; count: number };

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

function isScannedPath(path: string): boolean {
  const normalized = normalizePath(path);
  const segments = normalized.split('/');
  if (segments.some((segment) => EXCLUDED_DIRS.has(segment))) return false;
  const name = segments[segments.length - 1];
  if (!isProductionSource(name)) return false;
  return normalized !== SELF_PATH;
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
    if (!entry.isFile()) continue;
    const path = normalizePath(relative(REPO_ROOT, absolute));
    if (!isScannedPath(path)) continue;
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

function sitesFrom(files: readonly string[], readText: (path: string) => string): Site[] {
  const sites: Site[] = [];
  for (const path of files) {
    if (isApproved(path)) continue;
    const count = countAdvisoryCalls(readText(path));
    if (count > 0) sites.push({ path, count });
  }
  return sites;
}

function collectSites(): { scanned: number; sites: Site[] } {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root), files);
  files.sort();
  return {
    scanned: files.length,
    sites: sitesFrom(files, (path) => readFileSync(join(REPO_ROOT, path), 'utf8')),
  };
}

function collectSitesAtRef(sha: string): { scanned: number; sites: Site[] } {
  const candidates = listTreeFiles(REPO_ROOT, sha, SCAN_ROOTS)
    .map((entry) => normalizePath(entry.path))
    .filter(isScannedPath)
    .sort();
  const blobs = readBlobs(REPO_ROOT, sha, candidates);
  return {
    scanned: candidates.length,
    sites: sitesFrom(candidates, (path) => blobs.get(path) ?? ''),
  };
}

function baseDiffFindings(
  current: readonly Site[],
  base: readonly Site[],
  renames: ReadonlyMap<string, string>,
): Finding[] {
  // A rename carries its existing lock budget; a copy still starts at zero.
  const allowed = new Map<string, number>();
  for (const site of base) {
    allowed.set(renames.get(site.path) ?? site.path, site.count);
  }

  const findings: Finding[] = [];
  for (const site of current) {
    const before = allowed.get(site.path) ?? 0;
    if (site.count > before) {
      findings.push({
        rule: 'NEW_OR_GROWN_SITE',
        detail: `${site.path} base=${before} actual=${site.count}`,
      });
    }
  }
  return findings;
}

function baseFlag(): string | undefined {
  const index = process.argv.indexOf('--base');
  return index >= 0 ? process.argv[index + 1] : undefined;
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

  // TEST_POLICY_BASE is the env this audit's CI lane provides; resolveAuditBaseSha
  // reads CAPABILITY_BASE_SHA/--base, so honor the lane env first.
  const requested = baseFlag() || process.env.CAPABILITY_BASE_SHA;
  const sha = process.env.TEST_POLICY_BASE
    ? process.env.TEST_POLICY_BASE
    : resolveAuditBaseSha(REPO_ROOT, requested);
  const base = collectSitesAtRef(sha);
  const renames = worktreeRenameMap(REPO_ROOT, sha, SCAN_ROOTS);
  findings.push(...baseDiffFindings(sites, base.sites, renames));

  if (findings.length > 0) {
    console.error('advisory-lock audit failed:');
    for (const finding of findings) console.error(`  ${finding.rule} ${finding.detail}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `advisory-lock audit passed (${scanned} production files, ${sites.length} grandfathered sites vs base ${sha.slice(0, 12)}).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
