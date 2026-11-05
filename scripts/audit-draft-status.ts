/**
 * Draft-status gate — both sides of `question.draft_status` (NULL≡active).
 *
 * Writes: every `.insert(question).values({...})` site must set the key unless the file already
 * carried that many missing-key sites on the comparison base — the base is the exemption, there
 * is no allowlist. A missing key is NULL, and the practice pool treats NULL as active, so an
 * embedded/teaching question would silently enter the general pool.
 *
 * Reads: pool-visibility checks must go through `notDraftPredicate` / `isPoolVisible`. Engine A
 * flags the three hand-rolled family-1 dialects (Drizzle `or(isNull, ne)`, raw `IS NULL OR <>
 * 'draft'`, raw `IS DISTINCT FROM 'draft'`) and any other `draft_status` token inside a sql``
 * template (UNKNOWN-SHAPE). A hit or unknown already counted at base is grandfathered; a new one
 * fails closed until it is migrated. A novel Drizzle combinator that does not match the Drizzle
 * dialect escapes this shape check. Engine B (a closed-world ledger of JS twins) is deferred;
 * live `isPoolVisible(...)` calls are reported and do not fail the gate.
 *
 * Helper-definition sentinel failures are never grandfathered.
 *
 * Write-side blind spots:
 *   1. Only inline object literals are scanned. `.values(rows)` and `.values([...])` escape; bulk
 *      inserts must use an inline literal or the gate does not cover them. Cross-line/chained insert
 *      heads are handled by INSERT_HEAD_RE.
 *   2. The key regex scans the whole object, including nested keys. A `metadata: { draft_status }`
 *      would look compliant; draft_status must be a top-level column key.
 *   3. Only src/ is walked; seed scripts are excluded by design.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listTreeFiles,
  readBlobs,
  resolveAuditBaseSha,
  worktreeRenameMap,
} from './lib/git-base-scan';
import { analyzeSource, extractObjectBlock, lineOf } from './lib/ts-tokenize';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

const EXCLUDE_DIRS = new Set(['node_modules', '.next', 'dist', '.git', '.claude', 'drizzle']);

// ---------- source walk ----------

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

// extractObjectBlock lives in scripts/lib/ts-tokenize.ts so the write-side brace scan and the
// read-side sql`` scan share one comment/string/template-aware scanner. Re-exported to keep this
// module's public surface stable.
export { extractObjectBlock };

// ---------- scan ----------

export type InsertSite = {
  file: string;
  /** 1-based line of the `.insert(question).values({` head. */
  line: number;
  hasDraftStatus: boolean;
};

// `.insert(question)[.chain(...)]*.values([helper(])?{` — tolerates line breaks and intermediate
// no-arg chain links, and one wrapper call around the values object. Word-boundary on question
// excludes question_block/question_part. A chain link with a nested-paren argument would not be
// swallowed; .values normally comes first in Drizzle insert chains.
const INSERT_HEAD_RE =
  /\.insert\(\s*question\s*\)\s*(?:\.[A-Za-z_$][\w$]*\([^)]*\)\s*)*\.values\(\s*(?:[A-Za-z_$][\w$]*\(\s*)?\{/g;
// draft_status as an object key (word-boundary, optional quotes), not part of another identifier.
const DRAFT_STATUS_KEY_RE = /(^|[^A-Za-z0-9_])(['"]?)draft_status\2\s*:/;

/**
 * Scan one file for every `.insert(question).values({...})` site and whether it carries a
 * draft_status key. Pure.
 */
export function scanQuestionInserts(file: string, src: string): InsertSite[] {
  const sites: InsertSite[] = [];
  const { codeMask } = analyzeSource(src);
  INSERT_HEAD_RE.lastIndex = 0;
  for (const m of src.matchAll(INSERT_HEAD_RE)) {
    const headIdx = m.index ?? 0;
    // The `{` is the last character of the match.
    const braceIdx = headIdx + m[0].length - 1;
    // The regex also matches prose in comments/strings; those are not insert sites.
    if (codeMask[headIdx] === 0 || codeMask[braceIdx] === 0) continue;
    const block = extractObjectBlock(src, braceIdx, codeMask);
    const hasDraftStatus = block !== null && DRAFT_STATUS_KEY_RE.test(block);
    sites.push({ file, line: lineOf(src, headIdx), hasDraftStatus });
  }
  return sites;
}

export type DraftGateResult = {
  ok: boolean;
  flagged: InsertSite[];
  /** missing-key sites the file already carried at the comparison base. */
  grandfathered: InsertSite[];
};

/**
 * A question-insert site missing draft_status is grandfathered while the file's missing-site
 * count stays within its base budget (`baseMissing` maps file → count, rename-mapped); the
 * (budget+1)-th missing site in one file fails. Pure.
 */
export function validateDraftGate(
  sites: InsertSite[],
  baseMissing: ReadonlyMap<string, number>,
): DraftGateResult {
  const used = new Map<string, number>();
  const flagged: InsertSite[] = [];
  const grandfathered: InsertSite[] = [];
  for (const site of sites) {
    if (site.hasDraftStatus) continue;
    const count = (used.get(site.file) ?? 0) + 1;
    used.set(site.file, count);
    if (count <= (baseMissing.get(site.file) ?? 0)) grandfathered.push(site);
    else flagged.push(site);
  }
  return { ok: flagged.length === 0, flagged, grandfathered };
}

// The one legitimate inline predicate lives here (permanent, not allowlisted). Exclude it by path
// and reverse-check the sentinel marker, so a rename that forgets this constant fails loud.
export const HELPER_DEF_FILES = ['src/db/predicates.ts'];
export const HELPER_SENTINEL = '// AUDIT-DRAFT-READS: canonical-definition';
// Mask helper-routed interpolations instead of skipping the whole template, so a mixed template
// (helper plus a separate hand-rolled predicate) still flags the hand-rolled part.
const HELPER_SQL_INTERPOLATION = /\$\{\s*notDraftPredicate\s*\([^}]*\bdraft_status\b[^}]*\)\s*\}/g;

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

export type ReadAuditResult = {
  ok: boolean;
  hits: ReadHit[];
  grandfatheredHits: ReadHit[];
  unknown: UnknownHit[];
  grandfatheredUnknown: UnknownHit[];
  helperDefIssues: string[];
};

/**
 * A hand-rolled F1 hit or UNKNOWN-SHAPE token fails once its file's count exceeds the base
 * budget (each side budgeted separately, rename-mapped). Helper sentinel issues always fail.
 * Pure.
 */
export function validateReadGate(
  hits: ReadHit[],
  unknown: UnknownHit[],
  baseHits: ReadonlyMap<string, number>,
  baseUnknown: ReadonlyMap<string, number>,
  helperDefIssues: string[],
): ReadAuditResult {
  const partition = <T extends { file: string }>(
    items: readonly T[],
    budget: ReadonlyMap<string, number>,
  ): [T[], T[]] => {
    const used = new Map<string, number>();
    const flagged: T[] = [];
    const grandfathered: T[] = [];
    for (const item of items) {
      const count = (used.get(item.file) ?? 0) + 1;
      used.set(item.file, count);
      if (count <= (budget.get(item.file) ?? 0)) grandfathered.push(item);
      else flagged.push(item);
    }
    return [flagged, grandfathered];
  };
  const [flagged, grandfatheredHits] = partition(hits, baseHits);
  const [flaggedUnknown, grandfatheredUnknown] = partition(unknown, baseUnknown);
  return {
    ok: flagged.length === 0 && flaggedUnknown.length === 0 && helperDefIssues.length === 0,
    hits: flagged,
    grandfatheredHits,
    unknown: flaggedUnknown,
    grandfatheredUnknown,
    helperDefIssues,
  };
}

export function readFileOrNull(relPath: string): string | null {
  try {
    return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function printWriteReport(sites: InsertSite[], result: DraftGateResult): void {
  console.log('draft-status gate audit\n');
  console.log(`  question-insert sites scanned:  ${sites.length}`);
  console.log(`  with draft_status:              ${sites.filter((s) => s.hasDraftStatus).length}`);
  console.log(`  grandfathered (NULL≡active):     ${result.grandfathered.length}\n`);

  if (result.flagged.length === 0) {
    console.log('MISSING draft_status (new since base):  (none)');
  } else {
    console.log(`MISSING draft_status (new since base):  ${result.flagged.length}`);
    for (const s of result.flagged) {
      console.log(`  - ${s.file}:${s.line}  question insert has no draft_status key`);
    }
    console.log(
      "\nFix: set draft_status on the insert (NULL≡active is the writer's legal semantics, " +
        'but only for sites that already existed at the comparison base).',
    );
  }
}

function printReadReport(scanned: number, result: ReadAuditResult, jsTwins: JsTwin[]): void {
  console.log('draft-status READ-side pool-visibility audit (YUK-569)\n');
  console.log(`  source files scanned:            ${scanned}`);
  console.log(`  hand-rolled F1 inline (flagged): ${result.hits.length}`);
  console.log(`  grandfathered F1 inline:         ${result.grandfatheredHits.length}`);
  console.log(`  UNKNOWN-SHAPE (flagged):         ${result.unknown.length}`);
  console.log(`  grandfathered UNKNOWN-SHAPE:     ${result.grandfatheredUnknown.length}\n`);

  if (result.helperDefIssues.length > 0) {
    console.log(`HELPER-DEF / SENTINEL ISSUE:  ${result.helperDefIssues.length}`);
    for (const p of result.helperDefIssues) console.log(`  - ${p}`);
    console.log('');
  }

  if (result.hits.length === 0) {
    console.log('hand-rolled F1 inline predicates (not helper, new since base):  (none)');
  } else {
    console.log(
      `hand-rolled F1 inline predicates (not helper, new since base):  ${result.hits.length}`,
    );
    for (const h of result.hits) {
      console.log(`  - ${h.file}:${h.line}  [${h.dialect}]  ${h.snippet}`);
    }
    console.log(
      '\nFix: route this pool-visibility read through notDraftPredicate / isPoolVisible ' +
        '(src/db/predicates.ts).',
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
        'read, refine this audit.',
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

// ---------- comparison base ----------

function isScannedPath(rel: string): boolean {
  const name = rel.split('/').pop() ?? rel;
  if (!name.endsWith('.ts') && !name.endsWith('.tsx')) return false;
  if (name.endsWith('.test.ts') || name.endsWith('.test.tsx') || name.endsWith('.d.ts'))
    return false;
  return !rel.split('/').some((segment) => EXCLUDE_DIRS.has(segment));
}

type BaseBudgets = {
  missingInserts: Map<string, number>;
  readHits: Map<string, number>;
  unknownReads: Map<string, number>;
};

/** Measure this gate's three finding classes on the comparison base, per file. */
function collectAtRef(sha: string): BaseBudgets {
  const candidates = listTreeFiles(REPO_ROOT, sha, ['src'])
    .map((entry) => entry.path.split('\\').join('/'))
    .filter(isScannedPath)
    .sort();
  const blobs = readBlobs(REPO_ROOT, sha, candidates);
  const bump = (map: Map<string, number>, file: string, by = 1) =>
    map.set(file, (map.get(file) ?? 0) + by);
  const budgets: BaseBudgets = {
    missingInserts: new Map(),
    readHits: new Map(),
    unknownReads: new Map(),
  };
  for (const path of candidates) {
    const src = blobs.get(path);
    if (src === undefined) continue;
    if (src.includes('.insert(')) {
      for (const site of scanQuestionInserts(path, src)) {
        if (!site.hasDraftStatus) bump(budgets.missingInserts, path);
      }
    }
    if (src.includes('draft_status')) {
      const scanned = scanReads(path, src);
      bump(budgets.readHits, path, scanned.hits.length);
      bump(budgets.unknownReads, path, scanned.unknown.length);
    }
  }
  return budgets;
}

/** Re-home a per-file count map across renames (base path → worktree path). */
function rehomeCounts(
  counts: ReadonlyMap<string, number>,
  renames: ReadonlyMap<string, string>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [file, count] of counts) {
    const target = renames.get(file) ?? file;
    out.set(target, (out.get(target) ?? 0) + count);
  }
  return out;
}

function baseFlag(): string | undefined {
  const index = process.argv.indexOf('--base');
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  const files = walkSource(SRC_ROOT).sort();
  const sites: InsertSite[] = [];
  const hits: ReadHit[] = [];
  const unknown: UnknownHit[] = [];
  const jsTwins: JsTwin[] = [];
  for (const file of files) {
    const src = readFileSync(join(REPO_ROOT, file), 'utf-8');
    if (src.includes('.insert(')) sites.push(...scanQuestionInserts(file, src));
    if (src.includes('draft_status')) {
      const scanned = scanReads(file, src);
      hits.push(...scanned.hits);
      unknown.push(...scanned.unknown);
    }
    if (src.includes('isPoolVisible(')) jsTwins.push(...findJsTwins(file, src));
  }

  const requested = baseFlag() || process.env.CAPABILITY_BASE_SHA;
  const base = process.env.TEST_POLICY_BASE || resolveAuditBaseSha(REPO_ROOT, requested);
  const baseBudgets = collectAtRef(base);
  const renames = worktreeRenameMap(REPO_ROOT, base, ['src']);

  const writeResult = validateDraftGate(sites, rehomeCounts(baseBudgets.missingInserts, renames));
  const readResult = validateReadGate(
    hits,
    unknown,
    rehomeCounts(baseBudgets.readHits, renames),
    rehomeCounts(baseBudgets.unknownReads, renames),
    checkHelperSentinels(readFileOrNull),
  );
  const ok = writeResult.ok && readResult.ok;

  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          ok,
          base,
          writes: { siteCount: sites.length, ...writeResult },
          reads: { scanned: files.length, ...readResult, jsTwins },
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`(comparison base ${base.slice(0, 12)})`);
    printWriteReport(sites, writeResult);
    console.log('');
    printReadReport(files.length, readResult, jsTwins);
  }

  if (!ok) process.exit(1);
}

// CLI-gate: only walk and exit when run directly, so the self-test can import the pure functions.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
