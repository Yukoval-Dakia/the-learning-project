/** Git-side base-fact readers shared by the regression ratchets in
 *  audit-capability-boundaries.ts and audit-architecture-deepening.ts.
 *  Everything here is read-only plumbing: callers own the audit semantics. */
import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';

const MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const SHA_RE = /^[a-f0-9]{7,40}$/;

function git(projectRoot: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    input,
    maxBuffer: 512 * 1024 * 1024,
  });
}

/** Shared base resolution: --base/CAPABILITY_BASE_SHA win, else merge-base with
 *  origin/main. CI must pin a base explicitly (fail closed). */
export function resolveAuditBaseSha(projectRoot: string, requested?: string): string {
  if (process.env.CI && !requested && !process.env.CAPABILITY_BASE_SHA) {
    throw new Error('CI requires CAPABILITY_BASE_SHA or --base <commit>.');
  }
  const explicit = requested || process.env.CAPABILITY_BASE_SHA;
  const base = explicit || git(projectRoot, ['merge-base', 'HEAD', 'origin/main']).trim();
  if (!SHA_RE.test(base) || /^0+$/.test(base)) {
    throw new Error('Baseline comparison requires an existing commit SHA; fetch the base first.');
  }
  return base;
}

export interface TreeEntry {
  /** Repo-relative posix path. */
  path: string;
  /** Base blob SHA — the file identity used by rename/registration checks. */
  blob: string;
}

/** `git ls-tree -r` over the given roots; every tracked blob in the tree. */
export function listTreeFiles(
  projectRoot: string,
  ref: string,
  roots: readonly string[],
): TreeEntry[] {
  const raw = git(projectRoot, ['ls-tree', '-r', '-z', ref, '--', ...roots]);
  const entries: TreeEntry[] = [];
  for (const record of raw.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const meta = record.slice(0, tab).split(' ');
    if (meta[1] !== 'blob') continue;
    entries.push({ path: record.slice(tab + 1), blob: meta[2] });
  }
  return entries;
}

/** Repo-relative posix paths of tracked files under the roots. */
export function listTrackedFiles(projectRoot: string, roots: readonly string[]): string[] {
  const raw = git(projectRoot, ['ls-files', '-z', '--', ...roots]);
  return raw.split('\0').filter(Boolean);
}

/**
 * Bulk-read blob contents at a ref via one `git cat-file --batch` call.
 * Missing objects are skipped (paths come from listTreeFiles, so absence means
 * the tree moved under us — callers treat a missing blob as fail-closed input).
 */
export function readBlobs(
  projectRoot: string,
  ref: string,
  paths: readonly string[],
): Map<string, string> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  const request = paths.map((path) => `${ref}:${path}`).join('\n');
  const raw = execFileSync('git', ['cat-file', '--batch'], {
    cwd: projectRoot,
    input: request,
    maxBuffer: 512 * 1024 * 1024,
  });
  let offset = 0;
  for (const path of paths) {
    const headerEnd = raw.indexOf(0x0a, offset);
    if (headerEnd === -1) break;
    const header = raw.slice(offset, headerEnd).toString('utf8');
    if (header.endsWith(' missing')) {
      offset = headerEnd + 1;
      continue;
    }
    const size = Number(header.split(' ')[2]);
    const content = raw.slice(headerEnd + 1, headerEnd + 1 + size).toString('utf8');
    offset = headerEnd + 1 + size + 1; // trailing newline after blob content
    out.set(path, content);
  }
  return out;
}

/**
 * Rename identity map base -> worktree (`git diff -M --name-status`).
 * Lets ratchets follow a file across renames instead of laundering stock
 * (a renamed >1500-line file is still the same >1500-line file).
 */
export function worktreeRenameMap(
  projectRoot: string,
  base: string,
  roots: readonly string[],
): Map<string, string> {
  const raw = git(projectRoot, ['diff', '-M', '--name-status', '-z', base, '--', ...roots]);
  const tokens = raw.split('\0').filter(Boolean);
  const map = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (status.startsWith('R')) {
      map.set(tokens[i + 1], tokens[i + 2]);
      i += 2;
    }
  }
  return map;
}

/** `wc -l` semantics: number of LF characters. */
export function lineCountOf(text: string): number {
  let lines = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lines += 1;
  return lines;
}

/**
 * Set-based import resolution for blobs at a base ref — mirrors
 * resolveModuleCandidate/resolveImportTarget against a repo-relative path set
 * instead of the filesystem, so base and head produce comparable module keys.
 */
export function resolveSpecifierInTree(
  pathSet: ReadonlySet<string>,
  fromDir: string,
  source: string,
): string | undefined {
  let base: string | undefined;
  if (source.startsWith('@/')) base = `src/${source.slice(2)}`;
  else if (source.startsWith('.')) base = posix.normalize(posix.join(fromDir, source));
  if (!base) return undefined;
  if (pathSet.has(base)) return base;
  for (const extension of MODULE_EXTENSIONS) {
    if (pathSet.has(`${base}${extension}`)) return `${base}${extension}`;
  }
  for (const extension of MODULE_EXTENSIONS) {
    if (pathSet.has(`${base}/index${extension}`)) return `${base}/index${extension}`;
  }
  return base;
}
