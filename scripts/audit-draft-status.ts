/**
 * Draft-status gate audit — flags `question` INSERTs that omit draft_status.
 *
 * `question.draft_status` is NULL≡active. A new embedded/teaching question that omits it silently
 * enters the general practice pool, so every `.insert(question).values({...})` site must either set
 * the key or be allowlisted with the NULL≡active semantics.
 *
 * The regex locates the insert head, brace-balances the values object (skipping strings, templates,
 * and comments), and looks for the key by word boundary (so question_block / question_part do not
 * match).
 *
 * Known blind spots:
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

export function loadAllowlist(path: string): {
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

// extractObjectBlock lives in scripts/lib/ts-tokenize.ts so both draft-status audits share one
// comment/string/template-aware scanner. Re-exported to keep this module's public surface stable.
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

function main(): void {
  const files = walkSource(SRC_ROOT).sort();
  const sites: InsertSite[] = [];
  for (const file of files) {
    const src = readFileSync(join(REPO_ROOT, file), 'utf-8');
    if (!src.includes('.insert(')) continue;
    sites.push(...scanQuestionInserts(file, src));
  }
  const { entries, raw } = loadAllowlist(ALLOWLIST_PATH);
  const result = validateDraftGate(sites, entries, raw);

  const isJson = process.argv.includes('--json');
  if (isJson) {
    console.log(JSON.stringify({ siteCount: sites.length, ...result }, null, 2));
  } else {
    console.log('draft-status gate audit\n');
    console.log(`  question-insert sites scanned:  ${sites.length}`);
    console.log(
      `  with draft_status:              ${sites.filter((s) => s.hasDraftStatus).length}`,
    );
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
        '\nFix: set draft_status on the insert, or add the file to ' +
          'scripts/audit-draft-status-allowlist.json with reason + resolves_when ' +
          "(NULL≡active is the writer's legal semantics).",
      );
    }
  }

  if (!result.ok) process.exit(1);
}

// CLI-gate: only walk and exit when run directly, so the self-test can import the pure functions.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
