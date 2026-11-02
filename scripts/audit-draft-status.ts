/**
 * Draft-status gate — both sides of `question.draft_status` (NULL≡active).
 *
 * Writes: every `.insert(question).values({...})` site must set the key or be listed under
 * `writes` in the allowlist. A missing key is NULL, and the practice pool treats NULL as active,
 * so an embedded/teaching question would silently enter the general pool.
 *
 * Reads: pool-visibility checks must go through `notDraftPredicate` / `isPoolVisible`. Engine A
 * flags the three hand-rolled family-1 dialects (Drizzle `or(isNull, ne)`, raw `IS NULL OR <>
 * 'draft'`, raw `IS DISTINCT FROM 'draft'`) and any other `draft_status` token inside a sql``
 * template (UNKNOWN-SHAPE). UNKNOWN is file-allowlistable under `reads`, so a benign non-predicate
 * read has an escape hatch, but a new one fails closed until it is migrated or listed. A novel
 * Drizzle combinator that does not match the Drizzle dialect escapes this shape check. Engine B
 * (a closed-world ledger of JS twins) is deferred; live `isPoolVisible(...)` calls are reported
 * and do not fail the gate.
 *
 * `writes` and `reads` are separate maps. A NULL≡active insert exemption does not excuse a
 * hand-rolled read in the same file, and a read exemption does not excuse a missing insert key.
 * Helper-definition sentinel failures are not allowlistable.
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
import { analyzeSource, extractObjectBlock, lineOf } from './lib/ts-tokenize';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SRC_ROOT = join(REPO_ROOT, 'src');
const ALLOWLIST_PATH = join(__dirname, 'audit-draft-status-allowlist.json');

const EXCLUDE_DIRS = new Set(['node_modules', '.next', 'dist', '.git', '.claude', 'drizzle']);

// ---------- allowlist contract (same shape as audit-schema-allowlist.json) ----------

const RESOLVE_KINDS = ['pr', 'phase', 'manual'] as const;
type ResolveKind = (typeof RESOLVE_KINDS)[number];
type ResolvesWhen = { kind: ResolveKind; ref: string; expected_by: string };
export type AllowlistEntry = { reason: string; resolves_when: ResolvesWhen };

export type HygieneIssue = { file: string; problem: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Validate the allowlist file shape: each entry needs a non-empty reason and a resolves_when with
 * kind in {pr,phase,manual}, a non-empty ref, and an ISO date. Pure.
 */
export function validateAllowlistHygiene(raw: unknown): HygieneIssue[] {
  const issues: HygieneIssue[] = [];
  if (!isRecord(raw)) {
    return [{ file: '<allowlist>', problem: 'allowlist root is not an object' }];
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('_')) continue; // _comment etc.
    if (!isRecord(value)) {
      issues.push({ file: key, problem: 'entry is not an object' });
      continue;
    }
    if (typeof value.reason !== 'string' || value.reason.trim().length === 0) {
      issues.push({ file: key, problem: 'missing or empty reason' });
    }
    const rw = value.resolves_when;
    if (!isRecord(rw)) {
      issues.push({ file: key, problem: 'missing resolves_when object' });
      continue;
    }
    if (typeof rw.kind !== 'string' || !RESOLVE_KINDS.includes(rw.kind as ResolveKind)) {
      issues.push({
        file: key,
        problem: `resolves_when.kind must be one of ${RESOLVE_KINDS.join('|')}`,
      });
    }
    if (typeof rw.ref !== 'string' || rw.ref.trim().length === 0) {
      issues.push({ file: key, problem: 'resolves_when.ref must be a non-empty string' });
    }
    if (typeof rw.expected_by !== 'string' || !isIsoDate(rw.expected_by)) {
      issues.push({ file: key, problem: 'resolves_when.expected_by must be a YYYY-MM-DD date' });
    }
  }
  return issues;
}

const ALLOWLIST_SIDES = ['writes', 'reads'] as const;

function entriesFromRaw(raw: unknown): Record<string, AllowlistEntry> {
  const entries: Record<string, AllowlistEntry> = {};
  if (!isRecord(raw)) return entries;
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    entries[k] = v as AllowlistEntry;
  }
  return entries;
}

export type SectionedAllowlist = {
  writes: Record<string, AllowlistEntry>;
  reads: Record<string, AllowlistEntry>;
  rawWrites: unknown;
  rawReads: unknown;
  shapeIssues: HygieneIssue[];
};

/**
 * Split the allowlist into write and read maps. A top-level file path is rejected: it would
 * otherwise apply to neither side and look like an exemption that the gate ignores.
 */
export function parseSectionedAllowlist(raw: unknown): SectionedAllowlist {
  if (!isRecord(raw)) {
    return {
      writes: {},
      reads: {},
      rawWrites: undefined,
      rawReads: undefined,
      shapeIssues: [{ file: '<allowlist>', problem: 'allowlist root is not an object' }],
    };
  }
  const sides = new Set<string>(ALLOWLIST_SIDES);
  const shapeIssues: HygieneIssue[] = [];
  for (const key of Object.keys(raw)) {
    if (key.startsWith('_') || sides.has(key)) continue;
    shapeIssues.push({
      file: key,
      problem: 'unknown top-level key; put the entry under writes or reads',
    });
  }
  const rawWrites = raw.writes;
  const rawReads = raw.reads;
  if (!isRecord(rawWrites)) {
    shapeIssues.push({ file: 'writes', problem: 'writes section must be an object' });
  }
  if (!isRecord(rawReads)) {
    shapeIssues.push({ file: 'reads', problem: 'reads section must be an object' });
  }
  return {
    writes: entriesFromRaw(rawWrites),
    reads: entriesFromRaw(rawReads),
    rawWrites,
    rawReads,
    shapeIssues,
  };
}

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
  allowlistedHits: string[];
  hygieneIssues: HygieneIssue[];
};

/**
 * Every question-insert site must set draft_status or live in an allowlisted file. An allowlisted
 * site that also sets it passes silently: after migration those entries are redundant, not errors.
 * Pure.
 */
export function validateDraftGate(
  sites: InsertSite[],
  allowlist: Record<string, AllowlistEntry>,
  rawAllowlist: unknown,
): DraftGateResult {
  const hygieneIssues = validateAllowlistHygiene(rawAllowlist);
  const allowed = new Set(Object.keys(allowlist));
  const flagged: InsertSite[] = [];
  const allowlistedHits: string[] = [];
  for (const site of sites) {
    if (site.hasDraftStatus) continue;
    if (allowed.has(site.file)) {
      allowlistedHits.push(site.file);
      continue;
    }
    flagged.push(site);
  }
  return {
    ok: flagged.length === 0 && hygieneIssues.length === 0,
    flagged,
    allowlistedHits,
    hygieneIssues,
  };
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
  allowlisted: ReadHit[];
  unknown: UnknownHit[];
  allowlistedUnknown: UnknownHit[];
  hygieneIssues: HygieneIssue[];
  helperDefIssues: string[];
};

/**
 * A hand-rolled F1 hit or UNKNOWN-SHAPE token fails unless its file is on the reads allowlist.
 * UNKNOWN is allowlistable so a benign non-predicate read has an escape hatch, while a new one
 * still fails closed. Allowlist hygiene and helper sentinel issues always fail. Pure.
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
  console.log(`  allowlisted (NULL≡active):       ${result.allowlistedHits.length}\n`);

  if (result.hygieneIssues.length > 0) {
    console.log(`ALLOWLIST HYGIENE ERROR:  ${result.hygieneIssues.length}`);
    for (const h of result.hygieneIssues) console.log(`  - ${h.file}: ${h.problem}`);
    console.log('');
  }

  if (result.flagged.length === 0) {
    console.log('MISSING draft_status (not allowlisted):  (none)');
  } else {
    console.log(`MISSING draft_status (not allowlisted):  ${result.flagged.length}`);
    for (const s of result.flagged) {
      console.log(`  - ${s.file}:${s.line}  question insert has no draft_status key`);
    }
    console.log(
      '\nFix: set draft_status on the insert, or add the file under writes in ' +
        'scripts/audit-draft-status-allowlist.json with reason + resolves_when ' +
        "(NULL≡active is the writer's legal semantics).",
    );
  }
}

function printReadReport(scanned: number, result: ReadAuditResult, jsTwins: JsTwin[]): void {
  console.log('draft-status READ-side pool-visibility audit (YUK-569)\n');
  console.log(`  source files scanned:            ${scanned}`);
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
        '(src/db/predicates.ts), or add the file under reads in ' +
        'scripts/audit-draft-status-allowlist.json with reason + resolves_when.',
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

  const sections = parseSectionedAllowlist(JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf-8')));
  const writeResult = validateDraftGate(
    sites,
    sections.writes,
    isRecord(sections.rawWrites) ? sections.rawWrites : {},
  );
  const readResult = validateReadGate(
    hits,
    unknown,
    sections.reads,
    isRecord(sections.rawReads) ? sections.rawReads : {},
    checkHelperSentinels(readFileOrNull),
  );
  const ok = sections.shapeIssues.length === 0 && writeResult.ok && readResult.ok;

  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          ok,
          shapeIssues: sections.shapeIssues,
          writes: { siteCount: sites.length, ...writeResult },
          reads: { scanned: files.length, ...readResult, jsTwins },
        },
        null,
        2,
      ),
    );
  } else {
    if (sections.shapeIssues.length > 0) {
      console.log(`ALLOWLIST SHAPE ERROR:  ${sections.shapeIssues.length}`);
      for (const h of sections.shapeIssues) console.log(`  - ${h.file}: ${h.problem}`);
      console.log('');
    }
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
