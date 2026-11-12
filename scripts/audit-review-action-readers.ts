/**
 * Ratchet for new readers of the retired `review` event action.
 *
 * Production TypeScript may keep a `eq(event.action, 'review')` site that
 * already existed on the comparison base, and may shrink it. A new site or a
 * higher count fails. Comments and string literals do not count. Rename
 * carries the existing budget.
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
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git', 'tests']);
const SELF_PATH = 'scripts/audit-review-action-readers.ts';
const READER_RE = /eq\s*\(\s*event\.action\s*,\s*['"]review['"]\s*\)/g;

type Site = { path: string; count: number };
type Finding = { rule: string; detail: string };

function normalizePath(path: string): string {
  return path.split('\\').join('/');
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

export function countReviewActionReaders(source: string): number {
  const { codeMask } = analyzeSource(source);
  let count = 0;
  for (const match of source.matchAll(READER_RE)) {
    const index = match.index ?? 0;
    if (codeMask[index] !== 1) continue;
    count += 1;
  }
  return count;
}

function sitesFrom(files: readonly string[], readText: (path: string) => string): Site[] {
  const sites: Site[] = [];
  for (const path of files) {
    const count = countReviewActionReaders(readText(path));
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
  const allowed = new Map<string, number>();
  for (const site of base) allowed.set(renames.get(site.path) ?? site.path, site.count);
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
  const requested = baseFlag() || process.env.CAPABILITY_BASE_SHA;
  const sha = process.env.TEST_POLICY_BASE
    ? process.env.TEST_POLICY_BASE
    : resolveAuditBaseSha(REPO_ROOT, requested);
  const base = collectSitesAtRef(sha);
  const renames = worktreeRenameMap(REPO_ROOT, sha, SCAN_ROOTS);
  const findings = baseDiffFindings(sites, base.sites, renames);
  if (findings.length > 0) {
    console.error('review-action reader audit failed:');
    for (const finding of findings) console.error(`  ${finding.rule} ${finding.detail}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `review-action reader audit passed (${scanned} production files, ${sites.length} grandfathered sites vs base ${sha.slice(0, 12)}).`,
  );
}

main();
