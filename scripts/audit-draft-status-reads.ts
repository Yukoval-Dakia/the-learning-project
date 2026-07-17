/**
 * Read-side draft-status pool-visibility audit (YUK-569 / YUK-538 #14).
 *
 * Sibling of the INSERT-side `audit:draft-status`. That audit enforces that new question
 * INSERTs set draft_status; THIS one enforces that SELECT/UPDATE reads keep routing the
 * fail-open pool-visibility predicate (红线-4, NULL≡active — a row is pool-visible unless it
 * is literally 'draft') through the single shared helper `notDraftPredicate` / `isPoolVisible`
 * (src/db/predicates.ts) instead of hand-copying it. Closes the "SELECT side is unenforced"
 * gap the master register called out (docs/design/2026-07-02-project-logic-master-register.md
 * § draft-status-pool-gate-dup-predicate). Full design:
 * docs/design/2026-07-05-draft-status-pool-predicate-dedup-spec.md §6.
 *
 * ── Engine A — SQL/Drizzle positive-shape detection (ENFORCED core, §6.2) ──────────────
 * Reuses the shared comment/string/template-aware scanner (scripts/lib/ts-tokenize.ts:
 * analyzeSource) so predicate PROSE in comments / plain strings / docstrings is skipped for
 * free (the register itself + many docblocks quote the predicate — a naïve grep would drown
 * in false positives; §6.4 point 2). It positively detects the three hand-rolled family-1
 * (F1) dialects:
 *   D1  Drizzle  — or(isNull(<expr>.draft_status), ne(<expr>.draft_status, 'draft'))  (either order)
 *   R1  raw SQL  — (… draft_status … IS NULL OR … <> 'draft')  inside a sql`` template
 *   R2  raw SQL  — draft_status IS DISTINCT FROM 'draft'        inside a sql`` template
 * A MIGRATED site reads `notDraftPredicate(<col>)` / `isPoolVisible(row)` and so matches
 * none of D1/R1/R2 (helper-routed sql`` templates are detected + skipped). Family-2 gates
 * (`eq(col,'active'|'draft')`, `=== 'active'`, `!== 'draft'` promote guards, §2.2) are
 * exact-match, not F1 shapes, so they match none of D1/R1/R2 and are never flagged — nor are
 * schema/type/projection mentions (`draft_status: text(...)`, `draft_status: string | null`,
 * `draft_status: question.draft_status`), which are plain code that never matches D1.
 *
 * UNKNOWN-SHAPE backstop (§6.2): any `draft_status` token inside a sql`` template that is
 * neither helper-routed nor R1/R2 is reported UNKNOWN-SHAPE (needs triage) rather than
 * silently passing — this catches novel raw-SQL dialects (NOT IN / coalesce(...) /
 * IS DISTINCT FROM 'active' / cross-variable predicates). UNKNOWN is FILE-ALLOWLISTABLE
 * (YUK-569 review finding 1): a genuinely-benign non-predicate raw read of the column
 * (`SELECT COUNT(draft_status)`, `GROUP BY draft_status`) — which is not a pool predicate but
 * still mentions the token inside a sql`` — has an escape hatch (allowlist the file with a
 * reason + resolves_when) instead of hard-failing `pnpm test` with no recourse. A NEW UNKNOWN
 * still fails closed until someone migrates it to the helper or consciously allowlists it, so
 * novel pool predicates cannot proliferate silently. KNOWN LIMITATION (mirrors the INSERT
 * audit's regex-shape blind-spot docblock): the backstop is scoped to sql``-template context;
 * a novel DRIZZLE-combinator dialect in plain code (e.g. not(eq(col,'draft'))) is caught only
 * by D1's positive match, so a genuinely novel drizzle form would escape. Spec Appendix A
 * confirms no such executable dialect exists at baseline; adding one should route through the
 * helper.
 *
 * ── Engine B — JS closed-world ledger — DEFERRED (§6.3 C3) ─────────────────────────────
 * JS twins (`row.draft_status !== 'draft'`) are shape-INDISTINGUISHABLE from F2 promote
 * guards, so JS detection cannot be shape-based. Per the spec's C3 recommendation we ship
 * Engine A as the enforced core and DEFER Engine B (a hand-maintained JSON ledger relocates
 * the copy-paste fragility into a file that must be kept in sync — a weaker win). Post-
 * migration the 2 JS twins route through `isPoolVisible`; this audit emits an INFORMATIONAL
 * (non-blocking) note listing the live `isPoolVisible(...)` call sites as "known shape-
 * uncovered (JS twins route through isPoolVisible)".
 *
 * 用法：
 *   pnpm audit:draft-status-reads          # report-only (exit 0 always)
 *   pnpm audit:draft-status-reads --json   # machine output
 *   pnpm audit:draft-status-reads --strict # exit 1 on any non-allowlisted hand-rolled F1 inline
 *                                          # OR non-allowlisted UNKNOWN-SHAPE OR allowlist
 *                                          # hygiene / helper-def sentinel issue
 *
 * ── OWNER-DECISION note (§6.6) ────────────────────────────────────────────────────────
 * Unlike audit:relations (whose live dead-edge would block a strict-in-test wire), this
 * audit's baseline is provably CLEAN post-migration (spec §5), so `--strict` is wired into
 * `pnpm test` (immediately after audit:draft-status) in the SAME PR — the strict gate cannot
 * block on pre-existing stragglers and it is what actually closes 红线-4 on the read side.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type HygieneIssue, validateAllowlistHygiene } from './audit-draft-status';
import { analyzeSource, lineOf } from './lib/ts-tokenize';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SRC_ROOT = join(REPO_ROOT, 'src');
const ALLOWLIST_PATH = join(__dirname, 'audit-draft-status-reads-allowlist.json');

const EXCLUDE_DIRS = new Set(['node_modules', '.next', 'dist', '.git', '.claude', 'drizzle']);

// Helper definition file(s): the ONE legitimate inline predicate lives here (permanent-by-
// design, NOT an allowlist entry). Excluded from the F1 scan by path + reverse-checked via a
// sentinel marker so a rename that forgets to update this constant fails loud (§6.4 point 1).
export const HELPER_DEF_FILES = ['src/db/predicates.ts'];
export const HELPER_SENTINEL = '// AUDIT-DRAFT-READS: canonical-definition';
// A helper-routed sql`` interpolation `${notDraftPredicate(<col>.draft_status)}`. Masked (not
// whole-span-skipped) before scanning so a MIXED template — a helper call PLUS a separate
// hand-rolled predicate — still gets the hand-rolled part flagged (CodeRabbit YUK-569).
const HELPER_SQL_INTERPOLATION = /\$\{\s*notDraftPredicate\s*\([^}]*\bdraft_status\b[^}]*\)\s*\}/g;

// ---------- allowlist contract (reuse the INSERT audit's validateAllowlistHygiene) ----------

const RESOLVE_KINDS = ['pr', 'phase', 'manual'] as const;
type ResolveKind = (typeof RESOLVE_KINDS)[number];
type ResolvesWhen = { kind: ResolveKind; ref: string; expected_by: string };
type AllowlistEntry = { reason: string; resolves_when: ResolvesWhen };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadAllowlist(): { entries: Record<string, AllowlistEntry>; raw: unknown } {
  const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf-8')) as unknown;
  const entries: Record<string, AllowlistEntry> = {};
  if (isRecord(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('_')) continue;
      entries[k] = v as AllowlistEntry;
    }
  }
  return { entries, raw };
}

// ---------- source walk (mirrors audit-draft-status.ts:walkSource) ----------

export function walkSource(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const abs = join(root, entry.name);
    if (entry.isDirectory()) {
      walkSource(abs, out);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(relative(REPO_ROOT, abs));
    }
  }
  return out;
}

// ---------- Engine A shape detection ----------

export type Dialect = 'drizzle-or-isNull-ne' | 'raw-is-null-or' | 'is-distinct-from';
export type ReadHit = { file: string; line: number; dialect: Dialect; snippet: string };
export type UnknownHit = { file: string; line: number; snippet: string };
export type JsTwin = { file: string; line: number };

// D1 — order-agnostic Drizzle or(isNull(<expr>.draft_status), ne(<expr>.draft_status,'draft')).
// The `<expr>.` prefix + word-safe `.draft_status` excludes bare `draft_status` (that is the
// raw-SQL R-family) and `_draft_status`-suffixed identifiers (no `.` before `draft_status`).
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
 * Scan ONE source file for hand-rolled F1 pool-visibility predicates + UNKNOWN-SHAPE
 * draft_status tokens. Helper-definition files return nothing (excluded by design).
 * Exported pure for unit testing.
 */
export function scanReads(file: string, src: string): { hits: ReadHit[]; unknown: UnknownHit[] } {
  if (HELPER_DEF_FILES.includes(file)) return { hits: [], unknown: [] };
  const hits: ReadHit[] = [];
  const unknown: UnknownHit[] = [];
  const { codeMask, sqlSpans } = analyzeSource(src);

  // D1 (Drizzle) — positive match over the raw source; codeMask guards against a shape that
  // appears only as PROSE inside a comment / string (the `or(` anchor must sit in real code).
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

  // R1/R2 + UNKNOWN — one verdict per sql`` template that still mentions draft_status AFTER
  // masking helper-routed interpolations. Masking (not whole-span skipping) means a MIXED
  // template — a `${notDraftPredicate(...)}` call PLUS a separate hand-rolled predicate — still
  // gets the hand-rolled part flagged (CodeRabbit YUK-569). Same-length space masking preserves
  // absolute indices, so `span.start + rel` and snippetAt(src, ...) report the real line.
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
 * Informational (Engine B deferred): live `isPoolVisible(...)` call sites — the JS twins that
 * are shape-uncovered by Engine A. Excludes the helper definition file. Exported for testing.
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
 * Reverse-check the helper-definition files: each must exist AND still carry the sentinel
 * marker, so a rename/refactor that forgets to update HELPER_DEF_FILES fails loud instead of
 * silently un-excluding (or missing) the canonical predicate. Exported pure for testing.
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
 * Core gate: a hand-rolled F1 inline hit OR an UNKNOWN-SHAPE draft_status token fails unless its
 * FILE is allowlisted (file-level exception, same reason+resolves_when contract as the INSERT
 * audit). UNKNOWN is allowlistable so a genuinely-benign non-predicate raw read of the column
 * (`SELECT COUNT(draft_status)` / `GROUP BY draft_status`) has an escape hatch instead of hard-
 * failing `pnpm test` with no recourse (YUK-569 review finding 1) — but a NEW UNKNOWN still
 * fails closed until someone consciously migrates it or allowlists it with a tracked, expiring
 * reason, so novel pool predicates can't proliferate silently. Allowlist-hygiene and helper-def
 * sentinel issues always fail (never allowlistable). Exported pure for unit testing.
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
    // A concurrent test may clean up an already-enumerated fixture. Skip only
    // that ENOENT race; permissions and other read failures must still fail loud.
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
  const { entries, raw } = loadAllowlist();
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

    // Engine B DEFERRED (§6.3 C3) — informational only, never blocks.
    console.log(
      `NOTE (Engine B deferred): ${jsTwins.length} live isPoolVisible(...) JS-twin call site(s) are shape-uncovered by Engine A (JS twins route through isPoolVisible):`,
    );
    for (const t of jsTwins) console.log(`  · ${t.file}:${t.line}`);
    console.log('');
  }

  // Report-only by default; --strict opts into the CI/pnpm-test gate (baseline clean, §6.6).
  if (isStrict && !result.ok) process.exit(1);
}

// CLI-gate (mirrors audit-draft-status.ts / audit-relations.ts): only walk + exit when run as
// a CLI so the self-test can import the pure functions without the top-level scan firing.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
