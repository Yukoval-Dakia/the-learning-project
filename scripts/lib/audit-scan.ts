/**
 * Shared scanner support for the repo's static audit CLIs (YUK-1579).
 *
 * Consolidates the FIVE near-copies of "recursively walk the repo's TS sources"
 * that audit-draft-status / audit-draft-status-reads / audit-schema-writes /
 * audit-fold-writes / audit-hub-sync-writers each carried privately, plus the
 * small helpers every one of them re-declared (isRecord, the resolves_when
 * allowlist loader, the run-as-CLI gate). The per-audit POLICY — which roots,
 * which excluded dirs, whether tests/generated files count, absolute vs
 * repo-relative paths — stays at each call site as an explicit options object,
 * so no audit inherits another's scan universe by accident.
 *
 * Lexical scanning (comment/string/template awareness) is NOT here: it lives in
 * ./ts-tokenize.ts (analyzeSource + derived views), shared with the draft-status
 * audits since YUK-569 and with audit-fold-writes since YUK-1579.
 */

import { type Dirent, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- source walk ----------

export type AuditSourceWalkOptions = {
  /** Repo-relative directories to walk. */
  roots: readonly string[];
  /** Directory names pruned during the walk (e.g. 'node_modules', 'drizzle'). */
  excludeDirs: ReadonlySet<string>;
  /**
   * Skip *.test.ts / *.test.tsx. Audits that classify test files later via
   * their own production-source filter (audit-schema-writes) pass false.
   * Default false.
   */
  skipTests?: boolean;
  /**
   * Skip *.generated.ts / *.generated.tsx — type-only documents whose
   * mega-unions can recurse a scanner into a stack overflow (YUK-1051).
   * Default false.
   */
  skipGenerated?: boolean;
  /** Skip *.d.ts declaration files. Default true. */
  skipDeclFiles?: boolean;
  /** Repo-relative file paths excluded from the scan (an audit's own source). */
  excludeFiles?: ReadonlySet<string>;
  /** Return absolute paths instead of repo-relative ones. Default false. */
  absolute?: boolean;
  /** Skip (rather than throw on) a walk root that does not exist. Default false. */
  skipMissingRoots?: boolean;
};

function isTsSource(name: string): boolean {
  return name.endsWith('.ts') || name.endsWith('.tsx');
}

/**
 * Walk `opts.roots` under `repoRoot` collecting TS source files, honoring the
 * caller's scan-universe policy. Traversal order is readdirSync order (same as
 * the five walkers this replaces); callers that need determinism sort the
 * result. Pure filesystem walk — no filtering on content.
 */
export function walkSourceFiles(repoRoot: string, opts: AuditSourceWalkOptions): string[] {
  const skipTests = opts.skipTests ?? false;
  const skipGenerated = opts.skipGenerated ?? false;
  const skipDeclFiles = opts.skipDeclFiles ?? true;
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (opts.skipMissingRoots && (err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      if (opts.excludeDirs.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile() || !isTsSource(entry.name)) continue;
      if (skipTests && (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx'))) {
        continue;
      }
      if (skipGenerated && /\.generated\.tsx?$/.test(entry.name)) continue;
      if (skipDeclFiles && entry.name.endsWith('.d.ts')) continue;
      const rel = relative(repoRoot, abs).split('\\').join('/');
      if (opts.excludeFiles?.has(rel)) continue;
      out.push(opts.absolute ? abs : rel);
    }
  };
  for (const root of opts.roots) walk(resolve(repoRoot, root));
  return out;
}

// ---------- small shared helpers ----------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------- resolves_when allowlist contract (draft-status family) ----------
//
// Shape contract shared by the draft-status INSERT/READ allowlists: every entry
// carries a non-empty reason + resolves_when { kind, ref, expected_by }. The
// RICHER audit-schema-writes validator (expiry horizon, merged-PR git-log check,
// shipped-phase status.md check) is a different policy and stays local to it.

export const RESOLVE_KINDS = ['pr', 'phase', 'manual'] as const;
export type ResolveKind = (typeof RESOLVE_KINDS)[number];
export type ResolvesWhen = { kind: ResolveKind; ref: string; expected_by: string };
export type AllowlistEntry = { reason: string; resolves_when: ResolvesWhen };

/**
 * Load a resolves_when-shaped allowlist JSON: skips `_`-prefixed comment keys,
 * returns both the typed entries and the raw parsed value (the hygiene
 * validator runs on the raw shape). A missing/corrupt file throws — a gate's
 * allowlist must fail loud, not silently pass empty.
 */
export function loadResolvesWhenAllowlist(path: string): {
  entries: Record<string, AllowlistEntry>;
  raw: unknown;
} {
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

// ---------- CLI gate ----------

/**
 * True when this module was invoked directly as a CLI (`tsx scripts/audit-x.ts`)
 * rather than imported. Mirrors the per-audit gate: only walk + exit when run
 * as a CLI so a self-test can import the pure functions without the top-level
 * scan firing.
 */
export function isDirectCliInvocation(metaUrl: string): boolean {
  return Boolean(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(metaUrl));
}
