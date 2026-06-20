/**
 * Schema write-path 防漂移 lint
 *
 * 起源：data-assumptions audit (2026-05-15) 发现 5+ stub 字段——schema 定义、零 write path。
 * 本脚本审计 `src/db/schema.ts` 所有业务字段，确保每个都有 INSERT 或 UPDATE write path；
 * 例外通过 `scripts/audit-schema-allowlist.json` 显式声明（含 reason + 解除条件）。
 *
 * 用法：
 *   pnpm audit:schema          # 报告 + 非零 exit 若有未声明 stub
 *   pnpm audit:schema --json   # JSON 输出
 *   pnpm audit:schema --list   # 只列字段健康表，不 enforce
 *
 * 实现：纯 TS file-walk（无 shell exec），扫描 src/ + app/ 内所有 .ts/.tsx。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCHEMA_PATH = resolve(REPO_ROOT, 'src/db/schema.ts');
const ALLOWLIST_PATH = resolve(__dirname, 'audit-schema-allowlist.json');
const SEARCH_DIRS = ['src', 'app'].map((d) => resolve(REPO_ROOT, d));
const EXCLUDE_DIRS = new Set(['node_modules', '.next', 'dist', '.git']);

type Field = { table: string; field: string; type: string };
type ResolveKind = 'pr' | 'phase' | 'manual';
type ResolvesWhen = {
  kind: ResolveKind;
  ref: string;
  expected_by: string;
};
type AllowlistEntry = { reason: string; resolves_when: ResolvesWhen };
type Allowlist = Record<string, AllowlistEntry>;
type AllowlistHygieneIssueCode =
  | 'invalid_entry'
  | 'missing_reason'
  | 'invalid_resolves_when'
  | 'invalid_kind'
  | 'invalid_ref'
  | 'invalid_expected_by'
  | 'expired_expected_by'
  | 'merged_pr'
  | 'shipped_phase';
export type AllowlistHygieneIssue = {
  key: string;
  code: AllowlistHygieneIssueCode;
  message: string;
};
type AllowlistHygieneOptions = {
  today: string;
  mergedPrRefs: Set<string>;
  statusText: string;
};
type AllowlistHygieneResult = {
  allowlist: Allowlist;
  issues: AllowlistHygieneIssue[];
};
type WriteHit = {
  table: string;
  field: string;
  type: string;
  insert_files: number;
  update_files: number;
  status: 'live' | 'init-only' | 'update-only' | 'stub';
};

const TRIVIAL_FIELDS = new Set(['id', 'created_at', 'updated_at', 'version', 'archived_at']);
const RESOLVE_KINDS = new Set<ResolveKind>(['pr', 'phase', 'manual']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function todayIso(now = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function parseIsoDateStrict(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

function addMonthsIso(value: string, months: number): string {
  const date = parseIsoDateStrict(value);
  if (!date) return value;
  date.setMonth(date.getMonth() + months);
  return todayIso(date);
}

function normalizePrRef(ref: string): string | null {
  const trimmed = ref.trim();
  const match =
    trimmed.match(/^#?(\d+)$/) ??
    trimmed.match(/^PR\s+#?(\d+)$/i) ??
    trimmed.match(/^pull\/(\d+)$/i) ??
    trimmed.match(/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)(?:[/?#].*)?$/i);
  return match?.[1] ?? null;
}

function normalizePhaseText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

function isShippedStatusLine(line: string): boolean {
  return /^✅\s+(?:Phase\s+)?[\p{Letter}\p{Number}]/u.test(line);
}

function shippedPhaseStatusLines(statusText: string): string[] {
  const lines = statusText.split('\n');
  const out: string[] = [];
  let inPhaseSection = false;
  let inFence = false;

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inPhaseSection = /Phase\s*路线图|Phase\s+roadmap/i.test(line);
      inFence = false;
      continue;
    }
    if (!inPhaseSection) continue;
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence && isShippedStatusLine(line)) {
      out.push(line);
    }
  }

  return out;
}

function isPhaseShipped(ref: string, statusText: string): boolean {
  const normalizedRef = normalizePhaseText(ref);
  if (!normalizedRef) return false;
  return shippedPhaseStatusLines(statusText).some((line) => {
    const normalizedLine = normalizePhaseText(line);
    return ` ${normalizedLine} `.includes(` ${normalizedRef} `);
  });
}

export function extractMergedPrRefsFromGitLog(log: string): Set<string> {
  const refs = new Set<string>();
  for (const match of log.matchAll(/\(#(\d+)\)|Merge pull request #(\d+)/gi)) {
    const ref = match[1] ?? match[2];
    if (ref) refs.add(ref);
  }
  return refs;
}

function readMergedPrRefs(): Set<string> {
  try {
    const log = execFileSync(
      'git',
      ['log', '--oneline', '--first-parent', '--decorate=short', '-n', '2000'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    return extractMergedPrRefsFromGitLog(log);
  } catch {
    return new Set();
  }
}

function readStatusText(): string {
  const statusPath = resolve(REPO_ROOT, 'docs/superpowers/status.md');
  if (!existsSync(statusPath)) return '';
  return readFileSync(statusPath, 'utf8');
}

function issue(
  key: string,
  code: AllowlistHygieneIssueCode,
  message: string,
): AllowlistHygieneIssue {
  return { key, code, message };
}

export function validateAllowlistHygiene(
  raw: unknown,
  options: AllowlistHygieneOptions,
): AllowlistHygieneResult {
  const allowlist: Allowlist = {};
  const issues: AllowlistHygieneIssue[] = [];

  if (!isRecord(raw)) {
    return {
      allowlist,
      issues: [issue('<root>', 'invalid_entry', 'allowlist root must be a JSON object')],
    };
  }

  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('_')) continue;

    if (!isRecord(value)) {
      issues.push(issue(key, 'invalid_entry', 'allowlist entry must be an object'));
      continue;
    }

    const reason = value.reason;
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      issues.push(issue(key, 'missing_reason', 'allowlist entry requires non-empty reason'));
      continue;
    }

    const resolvesWhen = value.resolves_when;
    if (!isRecord(resolvesWhen)) {
      issues.push(
        issue(
          key,
          'invalid_resolves_when',
          'resolves_when must be { kind, ref, expected_by }, not a legacy string',
        ),
      );
      continue;
    }

    const kind = resolvesWhen.kind;
    const ref = resolvesWhen.ref;
    const expectedBy = resolvesWhen.expected_by;

    if (typeof kind !== 'string' || !RESOLVE_KINDS.has(kind as ResolveKind)) {
      issues.push(
        issue(key, 'invalid_kind', "resolves_when.kind must be 'pr', 'phase', or 'manual'"),
      );
      continue;
    }
    if (typeof ref !== 'string' || ref.trim().length === 0) {
      issues.push(issue(key, 'invalid_ref', 'resolves_when.ref must be a non-empty string'));
      continue;
    }
    if (typeof expectedBy !== 'string' || !ISO_DATE_RE.test(expectedBy)) {
      issues.push(
        issue(key, 'invalid_expected_by', 'resolves_when.expected_by must be YYYY-MM-DD'),
      );
      continue;
    }
    if (!parseIsoDateStrict(expectedBy)) {
      issues.push(
        issue(key, 'invalid_expected_by', 'resolves_when.expected_by must be a valid date'),
      );
      continue;
    }
    if (expectedBy < options.today) {
      issues.push(
        issue(
          key,
          'expired_expected_by',
          `resolves_when.expected_by ${expectedBy} is before ${options.today}`,
        ),
      );
      continue;
    }
    const maxExpectedBy = addMonthsIso(options.today, 12);
    if (expectedBy > maxExpectedBy) {
      issues.push(
        issue(
          key,
          'invalid_expected_by',
          `resolves_when.expected_by ${expectedBy} is more than 12 months after ${options.today}`,
        ),
      );
      continue;
    }

    if (kind === 'pr') {
      const prRef = normalizePrRef(ref);
      if (!prRef) {
        issues.push(issue(key, 'invalid_ref', 'pr resolves_when.ref must contain a PR number'));
        continue;
      }
      if (options.mergedPrRefs.has(prRef)) {
        issues.push(issue(key, 'merged_pr', `resolves_when PR #${prRef} is already merged`));
        continue;
      }
    }

    if (kind === 'phase' && isPhaseShipped(ref, options.statusText)) {
      issues.push(issue(key, 'shipped_phase', `resolves_when phase "${ref}" is already shipped`));
      continue;
    }

    allowlist[key] = {
      reason,
      resolves_when: {
        kind: kind as ResolveKind,
        ref,
        expected_by: expectedBy,
      },
    };
  }

  return { allowlist, issues };
}

// Drizzle column constructors recognised by parseSchema. The first group are
// native drizzle-orm/pg-core builders; `vector` is the project customType
// (src/db/vector.ts, YUK-383) — without it the `embedding: vector(1024)` columns
// escape parsing entirely and stay invisible to write-path drift detection
// (YUK-385). Append future project customType constructor names here so their
// columns are audited automatically.
const PROJECT_CUSTOM_TYPE_CONSTRUCTORS = ['vector'] as const;
const SCHEMA_CONSTRAINT_HELPERS = new Set(['check', 'primaryKey', 'unique', 'index', 'foreignKey']);
const NATIVE_COLUMN_CONSTRUCTORS = [
  'text',
  'integer',
  'real',
  'jsonb',
  'boolean',
  'timestamp',
  'smallint',
  'bigint',
  'date',
  'numeric',
  'varchar',
  'json',
  'uuid',
  'bytea',
  'check',
  'primaryKey',
  'unique',
  'index',
  'foreignKey',
];
const COLUMN_CONSTRUCTOR_RE = new RegExp(
  `^\\s{2,4}(\\w+):\\s+(${[...NATIVE_COLUMN_CONSTRUCTORS, ...PROJECT_CUSTOM_TYPE_CONSTRUCTORS].join('|')})\\(`,
  'gm',
);

export function parseSchema(src: string): Field[] {
  const fields: Field[] = [];
  // Find pgTable entry points so we can slice per-table blocks.
  const tableHeads = [...src.matchAll(/export const (\w+) = pgTable\(\s*'(\w+)'/g)];
  // Also find pgView so a per-table block stops at the next entity boundary
  // (otherwise view columns get misattributed to the preceding pgTable).
  const viewHeads = [...src.matchAll(/export const (\w+) = pgView\(\s*'(\w+)'/g)];
  // Sorted union of all entity-start offsets — block boundaries.
  const boundaries = [...tableHeads, ...viewHeads].map((m) => m.index ?? 0).sort((a, b) => a - b);
  for (let i = 0; i < tableHeads.length; i++) {
    const tableName = tableHeads[i][2];
    const start = tableHeads[i].index ?? 0;
    // End at the next entity boundary (pgTable or pgView) — whichever comes first.
    const next = boundaries.find((b) => b > start);
    const end = next ?? src.length;
    const block = src.slice(start, end);
    // `lastIndex` carries between matchAll iterations on a shared /g RegExp; reset per block.
    COLUMN_CONSTRUCTOR_RE.lastIndex = 0;
    const fieldMatches = block.matchAll(COLUMN_CONSTRUCTOR_RE);
    for (const m of fieldMatches) {
      // 跳过 schema constraint helpers
      if (SCHEMA_CONSTRAINT_HELPERS.has(m[2])) continue;
      fields.push({ table: tableName, field: m[1], type: m[2] });
    }
  }
  return fields;
}

function loadAllowlist(): unknown {
  if (!existsSync(ALLOWLIST_PATH)) return {};
  return JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
}

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      walkFiles(p, out);
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

// A single drizzle write statement, scoped to the table it targets. `kind`
// distinguishes INSERT (`.insert(table).values({...})`) from UPDATE
// (`.update(table).set({...})`); `payload` is the brace-balanced object literal
// passed to `.values(` / `.set(` so field matching is confined to THIS statement
// (YUK-166: the old file-level matcher ignored table identity and let a write to
// `mistake_variant.parent_question_id` satisfy `question.parent_question_id`).
export type WriteStatement = { kind: 'insert' | 'update'; table: string; payload: string };

// Balanced-brace / bracket extractor with string + comment awareness, so braces
// inside strings, template literals, or comments don't throw off the depth count.
// Starts at `openIdx` (must be `{` or `[`) and returns the inclusive slice through
// the matching close char, or null if unbalanced.
function extractBalanced(src: string, openIdx: number): string | null {
  const open = src[openIdx];
  if (open !== '{' && open !== '[') return null;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIdx; i < src.length; i += 1) {
    const c = src[i];
    const next = src[i + 1];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inSingle) {
      if (c === '\\') i += 1;
      else if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '\\') i += 1;
      else if (c === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (c === '\\') i += 1;
      else if (c === '`') inTemplate = false;
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === '`') {
      inTemplate = true;
      continue;
    }
    if (c === '{' || c === '[') {
      depth += 1;
      continue;
    }
    if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return null;
}

// Statement terminator scan (YUK-166 F3). Returns the exclusive end offset of the
// drizzle write statement that starts at `headEnd` — the first `;` (string/comment
// aware) OR the next `.insert(<table>)` / `.update(<table>)` head, whichever comes
// first. Bounding every sub-search (`.values(` / `.set(` / `.onConflictDoUpdate(`)
// to this window stops a later statement's payload from bleeding into an earlier
// head that has no payload of its own (e.g. `db.insert(a).returning()` followed by
// `db.insert(b).values({...})` — `b`'s values must NOT attach to `a`).
function statementEnd(src: string, headEnd: number): number {
  const nextHeadRe = /\.(?:insert|update)\(\s*\w+\s*\)/g;
  nextHeadRe.lastIndex = headEnd;
  const nextHead = nextHeadRe.exec(src);
  let bound = nextHead ? nextHead.index : src.length;
  // Find the first top-level `;` before the next head (string/comment aware).
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = headEnd; i < bound; i += 1) {
    const c = src[i];
    const next = src[i + 1];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inSingle) {
      if (c === '\\') i += 1;
      else if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '\\') i += 1;
      else if (c === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (c === '\\') i += 1;
      else if (c === '`') inTemplate = false;
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === '`') {
      inTemplate = true;
      continue;
    }
    if (c === ';') {
      bound = i;
      break;
    }
  }
  return bound;
}

// Inspect the argument region of a `.call( ... )` and return the FIRST object /
// array literal opened anywhere inside that call's parentheses (string + comment
// aware, paren-depth tracked) — covering inline `{...}`, array-of-objects
// `[{...}]`, AND builder forms like `rows.map((r) => ({ ... }))`. Returns `'bare'`
// when the call closes with NO object literal inside (a true bare identifier /
// variable, e.g. `.values(row)` / `.values(initial)`): such args are opaque —
// columns cannot be enumerated from a variable, so the caller records an
// empty-payload insert (table identity known, zero columns claimed) instead of
// skipping forward into the chain and wrongly grabbing a later object literal
// (YUK-166 F2). Returns `null` when the call is malformed/unterminated within
// `bound`.
function objectArgAfter(
  src: string,
  callIdx: number,
  callLen: number,
  bound: number,
): { kind: 'literal'; payload: string } | { kind: 'bare' } | null {
  // callIdx + callLen points just past the opening `(` of the call.
  let parenDepth = 1;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = callIdx + callLen; i < bound && i < src.length; i += 1) {
    const c = src[i];
    const next = src[i + 1];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inSingle) {
      if (c === '\\') i += 1;
      else if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '\\') i += 1;
      else if (c === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (c === '\\') i += 1;
      else if (c === '`') inTemplate = false;
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      continue;
    }
    if (c === '`') {
      inTemplate = true;
      continue;
    }
    if (c === '{' || c === '[') {
      // First object/array literal inside the call → enumerable payload.
      const payload = extractBalanced(src, i);
      return payload ? { kind: 'literal', payload } : null;
    }
    if (c === '(') {
      parenDepth += 1;
      continue;
    }
    if (c === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        // Call closed with no object literal inside → opaque bare argument.
        return { kind: 'bare' };
      }
    }
  }
  return null;
}

// Extract every table-scoped INSERT / UPDATE statement in a source file. Handles:
//   • `(db|tx|...).insert(<table>).values({...} | [{...}] | builder(...))` — inline
//     object, array-of-objects, and builder forms (`rows.map((r) => ({...}))`).
//   • `(db|tx|...).insert(<table>).values(<ident>)` — bare identifier ⇒ OPAQUE insert
//     (table identity known, zero enumerable columns) (YUK-166 F2).
//   • `.onConflictDoUpdate({ ... set: {...} })` chained on an insert ⇒ the set-object
//     keys are UPDATE writes on the SAME table (YUK-166 F1: drizzle upsert).
//   • `(db|tx|...).update(<table>).set({...})` — standalone UPDATE.
// Every sub-search is bounded to the current statement (YUK-166 F3) so a later
// statement's payload cannot bleed into an earlier head that has none of its own.
// Schema var names equal SQL table names in this repo, so the captured `<table>`
// matches parseSchema's table key directly.
export function extractWriteStatements(src: string): WriteStatement[] {
  const statements: WriteStatement[] = [];

  // INSERT statements: `.insert(<table>)` → its own `.values(` (object, array, or
  // opaque bare ident) AND any chained `.onConflictDoUpdate({ ... set: {...} })`,
  // both bounded to the current statement.
  const insertHeadRe = /\.insert\(\s*(\w+)\s*\)/g;
  for (const head of src.matchAll(insertHeadRe)) {
    const table = head[1];
    const headEnd = (head.index ?? 0) + head[0].length;
    const bound = statementEnd(src, headEnd);

    // .values(...) — within this statement only.
    const valuesIdx = src.indexOf('.values(', headEnd);
    if (valuesIdx !== -1 && valuesIdx < bound) {
      const arg = objectArgAfter(src, valuesIdx, '.values('.length, bound);
      if (arg?.kind === 'literal') {
        statements.push({ kind: 'insert', table, payload: arg.payload });
      } else if (arg?.kind === 'bare') {
        // Opaque insert: table identity known, columns unknowable from a variable.
        // Empty payload claims zero columns (conservative-correct) — it neither
        // misattributes the chained onConflictDoUpdate set object (F2) nor masks.
        statements.push({ kind: 'insert', table, payload: '{}' });
      }
    }

    // .onConflictDoUpdate({ ... set: { ... } }) — set-object columns are UPDATE
    // writes on the same table (YUK-166 F1). Bounded to this statement.
    const upsertIdx = src.indexOf('.onConflictDoUpdate(', headEnd);
    if (upsertIdx !== -1 && upsertIdx < bound) {
      const arg = objectArgAfter(src, upsertIdx, '.onConflictDoUpdate('.length, bound);
      if (arg?.kind === 'literal') {
        // Find the `set:` key inside the config object and balance its value.
        // Work within the extracted payload string so offsets stay self-consistent.
        const slice = arg.payload;
        const setMatch = /\bset\s*:\s*/.exec(slice);
        if (setMatch) {
          let j = setMatch.index + setMatch[0].length;
          while (j < slice.length && slice[j] !== '{') j += 1;
          const setPayload = j < slice.length ? extractBalanced(slice, j) : null;
          if (setPayload) statements.push({ kind: 'update', table, payload: setPayload });
        }
      }
    }
  }

  // UPDATE statements: `.update(<table>)` → its own `.set(`, bounded to the
  // current statement.
  const updateHeadRe = /\.update\(\s*(\w+)\s*\)/g;
  for (const head of src.matchAll(updateHeadRe)) {
    const table = head[1];
    const headEnd = (head.index ?? 0) + head[0].length;
    const bound = statementEnd(src, headEnd);
    const setIdx = src.indexOf('.set(', headEnd);
    if (setIdx === -1 || setIdx >= bound) continue;
    const arg = objectArgAfter(src, setIdx, '.set('.length, bound);
    if (arg?.kind === 'literal') {
      statements.push({ kind: 'update', table, payload: arg.payload });
    }
  }

  return statements;
}

function buildIndex(files: string[]): Map<string, WriteStatement[]> {
  const index = new Map<string, WriteStatement[]>();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    index.set(f, extractWriteStatements(src));
  }
  return index;
}

function statementMatchesField(payload: string, field: string): boolean {
  // 字段名匹配两种形式：
  //   1. `field: <value>` —— 长形式
  //   2. `field,` 或 `field }` —— Drizzle shorthand（变量名同字段名）
  const longForm = new RegExp(`\\b${field}\\s*:`);
  const shortForm = new RegExp(`[,{(\\s]${field}\\s*[,}]`);
  return longForm.test(payload) || shortForm.test(payload);
}

// Table-aware write-path count (YUK-166). A field counts as written only when a
// statement targeting ITS OWN table carries it; a same-named column on another
// table no longer cross-satisfies. Counts are per-file (a file with any matching
// insert/update statement for the table contributes one).
export function countWriteHits(
  table: string,
  field: string,
  index: Map<string, WriteStatement[]>,
): { insert_files: number; update_files: number } {
  let insertFiles = 0;
  let updateFiles = 0;
  for (const [, statements] of index) {
    let fileInsert = false;
    let fileUpdate = false;
    for (const st of statements) {
      if (st.table !== table) continue;
      if (!statementMatchesField(st.payload, field)) continue;
      if (st.kind === 'insert') fileInsert = true;
      else fileUpdate = true;
    }
    if (fileInsert) insertFiles++;
    if (fileUpdate) updateFiles++;
  }
  return { insert_files: insertFiles, update_files: updateFiles };
}

function audit(): WriteHit[] {
  const src = readFileSync(SCHEMA_PATH, 'utf8');
  const fields = parseSchema(src);
  const files: string[] = [];
  for (const d of SEARCH_DIRS) walkFiles(d, files);
  // 排除 schema.ts / generated.ts / test files（INSERT/UPDATE 在 fixture 不算业务写入；但允许 test 算）
  const businessFiles = files.filter(
    (f) => !f.endsWith('schema.ts') && !f.endsWith('generated.ts'),
  );
  const index = buildIndex(businessFiles);
  const results: WriteHit[] = [];
  for (const f of fields) {
    if (TRIVIAL_FIELDS.has(f.field)) continue;
    const { insert_files, update_files } = countWriteHits(f.table, f.field, index);
    let status: WriteHit['status'];
    if (insert_files > 0 && update_files > 0) status = 'live';
    else if (insert_files > 0) status = 'init-only';
    else if (update_files > 0) status = 'update-only';
    else status = 'stub';
    results.push({ ...f, insert_files, update_files, status });
  }
  return results;
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const listOnly = args.includes('--list');

  const results = audit();
  const hygiene = validateAllowlistHygiene(loadAllowlist(), {
    today: todayIso(),
    mergedPrRefs: readMergedPrRefs(),
    statusText: readStatusText(),
  });
  const allowlist = hygiene.allowlist;
  const stubs = results.filter((r) => r.status === 'stub');
  const unallowedStubs = stubs.filter((s) => !allowlist[`${s.table}.${s.field}`]);
  const allowedStubs = stubs.filter((s) => allowlist[`${s.table}.${s.field}`]);

  if (asJson) {
    console.log(
      JSON.stringify(
        { results, unallowedStubs, allowedStubs, allowlistIssues: hygiene.issues },
        null,
        2,
      ),
    );
    process.exit(listOnly ? 0 : unallowedStubs.length > 0 || hygiene.issues.length > 0 ? 1 : 0);
  }

  console.log('\n=== Schema 字段健康表（仅显示非 live）===\n');
  console.log('| Table.Field | Type | INSERT files | UPDATE files | Status |');
  console.log('|---|---|---|---|---|');
  for (const r of results) {
    if (r.status === 'live') continue;
    const allowed = allowlist[`${r.table}.${r.field}`] ? ' (allowed)' : '';
    console.log(
      `| ${r.table}.${r.field} | ${r.type} | ${r.insert_files} | ${r.update_files} | ${r.status}${allowed} |`,
    );
  }

  console.log(`\nTotal fields audited: ${results.length}`);
  console.log(`  live: ${results.filter((r) => r.status === 'live').length}`);
  console.log(`  init-only: ${results.filter((r) => r.status === 'init-only').length}`);
  console.log(`  update-only: ${results.filter((r) => r.status === 'update-only').length}`);
  console.log(`  stub (allowed): ${allowedStubs.length}`);
  console.log(
    `  stub (unallowed): ${unallowedStubs.length}${unallowedStubs.length > 0 ? ' ⚠️' : ''}`,
  );

  if (hygiene.issues.length > 0 && !listOnly) {
    console.log('\n⚠️  Allowlist hygiene issues found:\n');
    for (const item of hygiene.issues) {
      console.log(`  - ${item.key}: ${item.code} — ${item.message}`);
    }
    console.log(
      "\nUse resolves_when: { kind: 'pr' | 'phase' | 'manual', ref: string, expected_by: 'YYYY-MM-DD' }.",
    );
    process.exit(1);
  }

  if (unallowedStubs.length > 0 && !listOnly) {
    console.log('\n⚠️  Unallowed stubs found:\n');
    for (const s of unallowedStubs) {
      console.log(`  - ${s.table}.${s.field} (${s.type})`);
    }
    console.log(
      '\n如该字段确实计划留 stub，加入 scripts/audit-schema-allowlist.json 并附 reason + resolves_when。\n如不要保留，删 schema 定义。',
    );
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
