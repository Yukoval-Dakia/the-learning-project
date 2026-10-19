/**
 * Shared support for the audit CLIs' verbatim-duplicated plumbing (YUK-1579).
 *
 * Scope is deliberately narrow — only clusters that were LITERAL copies across
 * the draft-status / draft-status-reads / fold-writes audits:
 *
 *   walkSourceFiles        the three audits' Dirent-based source walkers
 *                          (the draft pair's were verbatim copies; fold-writes'
 *                          adds excludeFiles + unreadable-dir tolerance, both
 *                          explicit options here)
 *   loadResolvesWhenAllowlist   the draft pair's verbatim allowlist loaders
 *   isRecord / isDirectCliInvocation   verbatim micro-helpers repeated in 3/5
 *                          and 5/5 audits respectively
 *
 * NOT here, by rejection (coverage-behavior changes, parent review of
 * 6a66b12ca): audit-schema-writes' and audit-hub-sync-writers' statSync-based
 * walkers (they FOLLOW symlinks; the Dirent walker skips them) stay local to
 * those audits, and fold-writes' private stripComments lexer stays private
 * (its template-literal handling differs from ts-tokenize's analyzer). Lexical
 * scanning that IS shared already lives in ./ts-tokenize.ts (YUK-569).
 */

import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- source walk ----------

export type AuditSourceWalkOptions = {
  /** Repo-relative directories to walk, in order. */
  roots: readonly string[];
  /** Directory names pruned during the walk (checked before descending). */
  excludeDirs: ReadonlySet<string>;
  /** Repo-relative file paths excluded from the scan (an audit's own files). */
  excludeFiles: ReadonlySet<string>;
  /**
   * true: a directory whose readdirSync fails (missing scan root, unreadable
   * subtree, ...) is skipped and the walk continues — fold-writes' original
   * `catch { return out; }` semantics, for every error code.
   * false: the error propagates unchanged — the draft-status pair's original
   * behavior (no try/catch at all).
   */
  ignoreUnreadableDirs: boolean;
};

/**
 * The walk policy shared verbatim by the three Dirent-walker audits: recurse
 * with readdirSync({ withFileTypes: true }) (symlink entries are neither file
 * nor directory, so symlinks are skipped — the original behavior of all
 * three), collect .ts/.tsx files that are not *.test.ts(x) and not *.d.ts,
 * returning repo-relative paths in traversal order. All per-audit differences
 * are explicit required options; nothing is preserved by a default that
 * happens to match.
 */
export function walkSourceFiles(repoRoot: string, opts: AuditSourceWalkOptions): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (opts.ignoreUnreadableDirs) return;
      throw err;
    }
    for (const entry of entries) {
      if (opts.excludeDirs.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue;
      if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) continue;
      if (name.endsWith('.d.ts')) continue;
      const rel = relative(repoRoot, abs);
      if (opts.excludeFiles.has(rel)) continue;
      out.push(rel);
    }
  };
  for (const root of opts.roots) walk(resolve(repoRoot, root));
  return out;
}

// ---------- resolves_when allowlist loading (draft-status family) ----------

export const RESOLVE_KINDS = ['pr', 'phase', 'manual'] as const;
export type ResolveKind = (typeof RESOLVE_KINDS)[number];
export type ResolvesWhen = { kind: ResolveKind; ref: string; expected_by: string };
export type AllowlistEntry = { reason: string; resolves_when: ResolvesWhen };

/**
 * Load a resolves_when-shaped allowlist JSON: readFileSync + JSON.parse (both
 * throw on failure — a gate's allowlist must fail loud), skip `_`-prefixed
 * comment keys, return typed entries plus the raw parsed value (shape
 * validation runs on the raw). Verbatim body of the two loaders it replaced.
 */
export function loadResolvesWhenAllowlist(
  path: string,
): { entries: Record<string, AllowlistEntry>; raw: unknown } {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  const entries: Record<string, AllowlistEntry> = {};
  if (isRecord(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('_')) continue;
      entries[k] = v as AllowlistEntry;
    }
  }
  return { entries, raw };
}

// ---------- micro-helpers ----------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when this module was invoked directly as a CLI (`tsx scripts/audit-x.ts`)
 * rather than imported — the exact expression all five audits used at their
 * tail gate, so the pure functions stay importable without the scan firing.
 */
export function isDirectCliInvocation(metaUrl: string): boolean {
  return Boolean(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(metaUrl));
}
