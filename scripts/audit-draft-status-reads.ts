/**
 * Read-side draft-status pool-visibility audit.
 *
 * Sibling of `audit:draft-status` (INSERT side). This one enforces that reads route the fail-open
 * pool-visibility predicate (NULL ≡ active) through `notDraftPredicate` / `isPoolVisible` instead
 * of hand-copying it.
 *
 * Engine A scans SQL/Drizzle shapes for the three hand-rolled F1 dialects (Drizzle
 * or(isNull,ne), raw `IS NULL OR <> 'draft'`, raw `IS DISTINCT FROM 'draft'`) and reports
 * UNKNOWN-SHAPE for any other `draft_status` token inside a sql`` template. UNKNOWN is
 * file-allowlistable so a benign non-predicate read has an escape hatch, but a new one still
 * fails closed until migrated or consciously allowlisted. The check is shape-based: a novel
 * Drizzle combinator that does not match D1 would escape.
 *
 * Engine B (JS closed-world ledger) is deferred: JS twins are shape-indistinguishable from
 * promote guards. Live `isPoolVisible(...)` call sites are reported informationally instead.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AllowlistEntry,
  type HygieneIssue,
  loadAllowlist,
  validateAllowlistHygiene,
  walkSource,
} from './audit-draft-status';
import { analyzeSource, lineOf } from './lib/ts-tokenize';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SRC_ROOT = join(REPO_ROOT, 'src');
const ALLOWLIST_PATH = join(__dirname, 'audit-draft-status-reads-allowlist.json');

const EXCLUDE_DIRS = new Set(['node_modules', '.next', 'dist', '.git', '.claude', 'drizzle']);

// The one legitimate inline predicate lives here (permanent, not allowlisted). Exclude it by path
// and reverse-check the sentinel marker, so a rename that forgets this constant fails loud.
export const HELPER_DEF_FILES = ['src/db/predicates.ts'];
export const HELPER_SENTINEL = '// AUDIT-DRAFT-READS: canonical-definition';
// Mask helper-routed interpolations instead of skipping the whole template, so a mixed template
// (helper plus a separate hand-rolled predicate) still flags the hand-rolled part.
const HELPER_SQL_INTERPOLATION = /\$\{\s*notDraftPredicate\s*\([^}]*\bdraft_status\b[^}]*\)\s*\}/g;

// ---------- source walk ----------
//
// walkSource is shared with audit-draft-status (same EXCLUDE_DIRS, Dirent semantics, and
// repo-relative output).

// ---------- Engine A shape detection ----------

export type Dialect = 'drizzle-or-isNull-ne' | 'raw-is-null-or' | 'is-distinct-from';
export type ReadHit = { file: string; line: number; dialect: Dialect; snippet: string };
export type UnknownHit = { file: string; line: number; snippet: string };
export type JsTwin = { file: string; line: number };

// D1 — order-agnostic Drizzle form. The `<expr>.` prefix excludes bare `draft_status` (raw SQL) and
// `_draft_status`-suffixed identifiers.
const D1_FWD =
  /\bor\s*\(\s*isNull\s*\(\s*[\w$.]*\.draft_status\s*\)\s*,\s*ne\s*\(\s*[\w$.]*\.draft_status\s*,\s*['"]draft['"]\s*\)/g;
const D1_REV =
  /\bor\s*\(\s*ne\s*\(\s*[\w$.]*\.draft_status\s*,\s*['"]draft['"]\s*\)\s*,\s*isNull\s*\(\s*[\w$.]*\.draft_status\s*\)/g;
// R1 — raw blocklist inside a sql`` template: `… IS NULL OR … <>/!= 'draft'`.
const R1 = /IS\s+NULL\s+OR\b[\s\S]{0,80}?(?:<>|!=)\s*['"]draft['"]/i;
// R2 — raw NULL-safe canonical form inside a sql`` template.
const R2 = /draft_status[\s\S]{0,40}?IS\s+DISTINCT\s+FROM\s+['"]draft['"]/i;

function snippetAt(src: string, index: number): string {
  const lineStart = src.lastIndexOf('\n', index) + 1;
  let lineEnd = src.indexOf('\n', index);
  if (lineEnd === -1) lineEnd = src.length;
  return src.slice(lineStart, lineEnd).trim().slice(0, 160);
}

/**
 * Scan one source file for hand-rolled F1 predicates and UNKNOWN-SHAPE draft_status tokens.
 * Helper-definition files return nothing. Pure.
 */
export function scanReads(file: string, src: string): { hits: ReadHit[]; unknown: UnknownHit[] } {
  if (HELPER_DEF_FILES.includes(file)) return { hits: [], unknown: [] };
  const hits: ReadHit[] = [];
  const unknown: UnknownHit[] = [];
  const { codeMask, sqlSpans } = analyzeSource(src);

  // D1 (Drizzle) — match raw source, but require the anchor to be real code, not comment/string
  // prose.
  for (const re of [D1_FWD, D1_REV]) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      const at = m.index ?? 0;
      if (codeMask[at] !== 1) continue; // prose in a comment / string — skip.
      hits.push({
        file,
        line: lineOf(src, at),
        dialect: 'drizzle-or-isNull-ne',
        snippet: snippetAt(src, at),
      });
    }
  }

  // R1/R2 + UNKNOWN — one verdict per sql`` template that still mentions draft_status after
  // masking helper routes. Same-length masking preserves indices for line/snippet output.
  for (const span of sqlSpans) {
    const text = src.slice(span.start, span.end + 1);
    const uncovered = text.replace(HELPER_SQL_INTERPOLATION, (m) => ' '.repeat(m.length));
    const rel = uncovered.search(/\bdraft_status\b/);
    if (rel === -1) continue; // no draft_status outside a helper interpolation → covered.
    const at = span.start + rel;
    if (R2.test(uncovered)) {
      hits.push({
        file,
        line: lineOf(src, at),
        dialect: 'is-distinct-from',
        snippet: snippetAt(src, at),
      });
    } else if (R1.test(uncovered)) {
      hits.push({
        file,
        line: lineOf(src, at),
        dialect: 'raw-is-null-or',
        snippet: snippetAt(src, at),
      });
    } else {
      unknown.push({ file, line: lineOf(src, at), snippet: snippetAt(src, at) });
    }
  }

  return { hits, unknown };
}

/**
 * Informational (Engine B deferred): live `isPoolVisible(...)` call sites, the JS twins Engine A
 * cannot shape-detect. Excludes the helper definition. Pure.
 */
export function findJsTwins(file: string, src: string): JsTwin[] {
  if (HELPER_DEF_FILES.includes(file)) return [];
  const { codeMask } = analyzeSource(src);
  const twins: JsTwin[] = [];
  const re = /\bisPoolVisible\s*\(/g;
  for (const m of src.matchAll(re)) {
    const at = m.index ?? 0;
    if (codeMask[at] !== 1) continue;
    twins.push({ file, line: lineOf(src, at) });
  }
  return twins;
}

/**
 * Each helper-definition file must exist and still carry the sentinel, so a rename/refactor that
 * forgets HELPER_DEF_FILES fails loud instead of silently un-excluding the canonical predicate.
 * Pure.
 */
export function checkHelperSentinels(readFile: (relPath: string) => string | null): string[] {
  const problems: string[] = [];
  for (const f of HELPER_DEF_FILES) {
    const src = readFile(f);
    if (src === null) {
      problems.push(`${f}: helper-def file missing (update HELPER_DEF_FILES if it moved)`);
      continue;
    }
    if (!src.includes(HELPER_SENTINEL)) {
      problems.push(`${f}: sentinel marker "${HELPER_SENTINEL}" missing`);
    }
  }
  return problems;
}

// ---------- gate ----------

export type ReadAuditResult = {
  ok: boolean;
  hits: ReadHit[];
  allowlisted: ReadHit[];
  unknown: UnknownHit[];
  allowlistedUnknown: UnknownHit[];
  hygieneIssues: HygieneIssue[];
  helperDefIssues: string[];
};

/**
 * A hand-rolled F1 hit or UNKNOWN-SHAPE token fails unless its file is allowlisted. UNKNOWN is
 * allowlistable so a benign non-predicate read has an escape hatch, while a new one still fails
 * closed. Allowlist hygiene and helper sentinel issues always fail. Pure.
 */
export function validateReadGate(
  hits: ReadHit[],
  unknown: UnknownHit[],
  allowlist: Record<string, AllowlistEntry>,
  rawAllowlist: unknown,
  helperDefIssues: string[],
): ReadAuditResult {
  const hygieneIssues = validateAllowlistHygiene(rawAllowlist);
  const allowed = new Set(Object.keys(allowlist));
  const flagged: ReadHit[] = [];
  const allowlisted: ReadHit[] = [];
  for (const hit of hits) {
    if (allowed.has(hit.file)) allowlisted.push(hit);
    else flagged.push(hit);
  }
  const flaggedUnknown: UnknownHit[] = [];
  const allowlistedUnknown: UnknownHit[] = [];
  for (const u of unknown) {
    if (allowed.has(u.file)) allowlistedUnknown.push(u);
    else flaggedUnknown.push(u);
  }
  const ok =
    flagged.length === 0 &&
    flaggedUnknown.length === 0 &&
    hygieneIssues.length === 0 &&
    helperDefIssues.length === 0;
  return {
    ok,
    hits: flagged,
    allowlisted,
    unknown: flaggedUnknown,
    allowlistedUnknown,
    hygieneIssues,
    helperDefIssues,
  };
}

// ---------- CLI ----------

export function readFileOrNull(relPath: string): string | null {
  try {
    return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function main(): void {
  const files = walkSource(SRC_ROOT).sort();
  const hits: ReadHit[] = [];
  const unknown: UnknownHit[] = [];
  const jsTwins: JsTwin[] = [];
  for (const file of files) {
    // A concurrent test may clean up an already-enumerated fixture; skip only that ENOENT race.
    // Permission and other read failures still fail loud.
    const src = readFileOrNull(file);
    if (src === null) continue;
    if (src.includes('draft_status')) {
      const r = scanReads(file, src);
      hits.push(...r.hits);
      unknown.push(...r.unknown);
    }
    if (src.includes('isPoolVisible(')) jsTwins.push(...findJsTwins(file, src));
  }

  const helperDefIssues = checkHelperSentinels(readFileOrNull);
  const { entries, raw } = loadAllowlist(ALLOWLIST_PATH);
  const result = validateReadGate(hits, unknown, entries, raw, helperDefIssues);

  const isJson = process.argv.includes('--json');
  const isStrict = process.argv.includes('--strict');

  if (isJson) {
    console.log(JSON.stringify({ scanned: files.length, ...result, jsTwins }, null, 2));
  } else {
    console.log('draft-status READ-side pool-visibility audit (YUK-569)\n');
    console.log(`  source files scanned:            ${files.length}`);
    console.log(`  hand-rolled F1 inline (flagged): ${result.hits.length}`);
    console.log(`  allowlisted F1 inline:           ${result.allowlisted.length}`);
    console.log(`  UNKNOWN-SHAPE (flagged):         ${result.unknown.length}`);
    console.log(`  allowlisted UNKNOWN-SHAPE:       ${result.allowlistedUnknown.length}\n`);

    if (result.helperDefIssues.length > 0) {
      console.log(`HELPER-DEF / SENTINEL ISSUE:  ${result.helperDefIssues.length}`);
      for (const p of result.helperDefIssues) console.log(`  - ${p}`);
      console.log('');
    }
    if (result.hygieneIssues.length > 0) {
      console.log(`ALLOWLIST HYGIENE ERROR:  ${result.hygieneIssues.length}`);
      for (const h of result.hygieneIssues) console.log(`  - ${h.file}: ${h.problem}`);
      console.log('');
    }

    if (result.hits.length === 0) {
      console.log('hand-rolled F1 inline predicates (not helper, not allowlisted):  (none)');
    } else {
      console.log(
        `hand-rolled F1 inline predicates (not helper, not allowlisted):  ${result.hits.length}`,
      );
      for (const h of result.hits) {
        console.log(`  - ${h.file}:${h.line}  [${h.dialect}]  ${h.snippet}`);
      }
      console.log(
        '\nFix: route this pool-visibility read through notDraftPredicate / isPoolVisible ' +
          '(src/db/predicates.ts), or add the file to ' +
          'scripts/audit-draft-status-reads-allowlist.json with reason + resolves_when.',
      );
    }
    console.log('');

    if (result.unknown.length > 0) {
      console.log(
        `UNKNOWN-SHAPE draft_status in sql-template context (needs triage):  ${result.unknown.length}`,
      );
      for (const u of result.unknown) console.log(`  - ${u.file}:${u.line}  ${u.snippet}`);
      console.log(
        '\nTriage: a novel raw-SQL dialect touching draft_status. If it is a pool-visibility ' +
          'predicate, route it through notDraftPredicate; if it is a legitimate non-predicate ' +
          'read, refine this audit or allowlist it.',
      );
      console.log('');
    }

    // Engine B is deferred — informational only, never blocks.
    console.log(
      `NOTE (Engine B deferred): ${jsTwins.length} live isPoolVisible(...) JS-twin call site(s) are shape-uncovered by Engine A (JS twins route through isPoolVisible):`,
    );
    for (const t of jsTwins) console.log(`  · ${t.file}:${t.line}`);
    console.log('');
  }

  // Report-only by default; --strict opts into the CI/pnpm-test gate (baseline clean, §6.6).
  if (isStrict && !result.ok) process.exit(1);
}

// CLI-gate: only walk and exit when run directly, so the self-test can import the pure functions.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
