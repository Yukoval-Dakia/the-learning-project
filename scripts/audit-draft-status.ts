/**
 * Draft-status gate audit (YUK-350) — `question` INSERT 漂移 lint
 *
 * 起源（W0 C1）：`question.draft_status` 是 NULL≡active 的三态字段——一条新插入的
 * question 若不显式 set draft_status，就是 NULL，被整个 review 池当 active 收。
 * embedded check / teaching check 这类「容器内专用」题若漏 set draft_status，会
 * 静默漏进通用练习池（红线 4）。本脚本扫所有 `.insert(question).values({ ... })`
 * 站点，要求每个站点要么显式携带 draft_status key，要么在 allowlist 里声明
 * （NULL≡active 是该 writer 的合法语义，例如 auto-enroll / import / 错题录入 /
 * 卷题——它们本就是 active 题）。
 *
 * 这是 W0 C1 合并后的【唯一】draft-gate 审计（L2 的 audit-question-draft-gate.ts
 * 已废弃合入这里）；NULL-owner 枚举与 allowlist 由本文件单一拥有。
 *
 * 用法：
 *   pnpm audit:draft-status          # 报告 + 非零 exit 若有未声明的缺 draft_status 插入
 *   pnpm audit:draft-status --json   # JSON 输出
 *
 * 限制：file-walk + 正则定位 `.insert(question).values({` 头，再 brace-balance 抽
 * 出对象字面量块（跳过字符串 / 模板 / 注释里的花括号），在块内 word-boundary 找
 * draft_status key。仅扫源码（非 test、非 scripts/seed-*），word-boundary 排除
 * question_block / question_part（同名前缀的其它表）。
 *
 * 已知盲点（与 sibling audit-schema 同属正则-shape 限制，当前数据下均不可触发——
 * 已 grep 确认无任何站点命中以下形态——但未来贡献者须知）：
 *   1. 只匹配 INLINE 对象字面量形式 `.values({ ... })`。变量/数组形式 `.values(rows)` /
 *      `.values([...])` 不会被扫到，会静默逃过 gate。新增 bulk/computed-row insert 时必须
 *      改写成 inline 字面量，否则 gate 不覆盖。
 *      （F3，YUK-350：跨行 / 链式断行形态——`.insert(question)` 与 `.values({` 之间夹换行或
 *      `.onConflictDoNothing()` 等链式调用——以前被漏扫，现在 INSERT_HEAD_RE 已容忍，见其注释。）
 *   2. DRAFT_STATUS_KEY_RE 在整块对象（含嵌套）里找 key，不限 top-level。若把
 *      draft_status 作为嵌套对象（如 metadata: { draft_status: ... }）的 key，会被
 *      误判为「已设」。draft_status 必须是 top-level 列 key。
 *   3. 只 walk SRC_ROOT（src/），不扫 scripts/——seed-* 种子数据按设计排除。
 *
 * 详见 docs/design/2026-05-15-data-assumptions.md（draft_status NULL≡active 契约）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SRC_ROOT = join(REPO_ROOT, 'src');
const ALLOWLIST_PATH = join(__dirname, 'audit-draft-status-allowlist.json');

const EXCLUDE_DIRS = new Set(['node_modules', '.next', 'dist', '.git', '.claude', 'drizzle']);

// ---------- allowlist contract (mirrors audit-schema-allowlist.json shape) ----------

const RESOLVE_KINDS = ['pr', 'phase', 'manual'] as const;
type ResolveKind = (typeof RESOLVE_KINDS)[number];
type ResolvesWhen = { kind: ResolveKind; ref: string; expected_by: string };
type AllowlistEntry = { reason: string; resolves_when: ResolvesWhen };

export type HygieneIssue = { file: string; problem: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Validate the allowlist file shape: every entry must carry a non-empty reason +
 * a resolves_when { kind ∈ {pr,phase,manual}, ref non-empty, expected_by ISO date }.
 * Exported pure for unit testing. Returns the list of problems ([] when clean).
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

// ---------- brace-balanced object-block extraction ----------

/**
 * Given source text and the index of the `{` that opens an object literal, return the
 * substring from that `{` to its matching `}` (inclusive). Brace-balanced and aware of:
 *   - single / double / template-literal strings (braces inside are NOT counted; for
 *     template literals `${...}` interpolation braces ARE counted so we don't lose the
 *     real object depth)
 *   - line comments (// ...) and block comments (/* ... *​/)
 * Returns the matched block, or null if no matching close brace is found.
 *
 * Exported pure for unit testing (nested metadata objects, strings carrying '}', etc.).
 */
export function extractObjectBlock(src: string, openIdx: number): string | null {
  if (src[openIdx] !== '{') return null;
  let depth = 0;
  let i = openIdx;
  // String / comment state. For template literals we track `${}` interpolation depth so
  // braces inside an interpolation contribute to the real object depth.
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  // Stack of template-interpolation brace depths (to know when a `}` closes ${} vs object).
  const templateInterpDepth: number[] = [];

  for (; i < src.length; i += 1) {
    const c = src[i];
    const next = src[i + 1];
    const prev = src[i - 1];

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
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === '"') inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === '`') {
        inTemplate = false;
        continue;
      }
      if (c === '$' && next === '{') {
        // enter an interpolation — record the object-brace depth at entry so the
        // matching `}` is recognised as closing the interpolation, not the object.
        templateInterpDepth.push(depth);
        depth += 1;
        i += 1;
        continue;
      }
      // braces inside template text (not interpolation) are literal — ignore.
      if (c === '}' && templateInterpDepth.length > 0) {
        // could be closing an interpolation only if depth matches; handled in the
        // generic `}` branch below — but we are still inTemplate, so the generic
        // branch is not reached. Mirror the decrement here.
        const entryDepth = templateInterpDepth[templateInterpDepth.length - 1];
        if (depth - 1 === entryDepth) {
          templateInterpDepth.pop();
          depth -= 1;
          // resume scanning template text (we are still inside the backticks).
          continue;
        }
      }
      continue;
    }

    // not in any string/comment.
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
    if (c === '{') {
      depth += 1;
      continue;
    }
    if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        return src.slice(openIdx, i + 1);
      }
      continue;
    }
    // `prev` referenced to satisfy the no-unused guard for future escape handling.
    void prev;
  }
  return null;
}

// ---------- scan ----------

export type InsertSite = {
  file: string;
  /** 1-based line of the `.insert(question).values({` head. */
  line: number;
  hasDraftStatus: boolean;
};

// `.insert( question )[ .chain(...) ]* .values( {` — tolerant of chained-call line breaks
// (F3, YUK-350). The OLD matcher `\.insert\(\s*question\s*\)\.values\(\s*\{` required `.values(`
// to immediately follow `)` with NOTHING between them, so the idiomatic Drizzle cross-line form
//   tx
//     .insert(question)
//     .values({ ... })
//     .onConflictDoNothing()
// (and any `.insert(question).<method>(...).values({` shape) silently escaped the scan → the
// gate could go falsely green on a new cross-line insert that forgot draft_status. This head
// now allows whitespace/newlines AND zero-or-more intermediate chained method calls between
// `.insert(question)` and `.values({`:
//   `\s*` after `)` swallows the line break;
//   `(?:\.<ident>\(<no-paren args>\)\s*)*` swallows any intermediate `.foo()` chain links.
// Word-boundary on `question` still excludes question_block / question_part (the `(` after the
// table name guarantees the boundary). The intermediate-link arg matcher is `[^)]*` (no nested
// parens) — adequate for the empty-arg Drizzle chain links (`.onConflictDoNothing()`,
// `.returning()`); a chain link carrying a nested-paren call before `.values` would not be
// swallowed (acceptable — `.values` normally comes first in Drizzle insert chains).
//
// YUK-395: the values object may be wrapped in a single derive helper call —
// `.values(withAnswerClass({ ... }))` — so allow an OPTIONAL `<ident>(` (with
// whitespace/newlines) between `.values(` and the `{`. The brace-balance extractor
// keys off the `{` being the LAST char of the match, so swallowing the wrapper-open
// paren keeps the `{` as the anchor; the extra close paren after the object `}` is
// outside the extracted block and irrelevant to the draft_status key scan. Without
// this, every wrapped site silently escapes the scan and the gate goes falsely green
// (0 sites scanned).
const INSERT_HEAD_RE =
  /\.insert\(\s*question\s*\)\s*(?:\.[A-Za-z_$][\w$]*\([^)]*\)\s*)*\.values\(\s*(?:[A-Za-z_$][\w$]*\(\s*)?\{/g;
// draft_status as an object KEY (word-boundary, allow quotes), not a substring of
// another identifier.
const DRAFT_STATUS_KEY_RE = /(^|[^A-Za-z0-9_])(['"]?)draft_status\2\s*:/;

function lineOf(src: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i += 1) {
    if (src[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Scan one source file for every `.insert(question).values({ ... })` site, returning
 * whether each carries a draft_status key. Exported pure for unit testing.
 */
export function scanQuestionInserts(file: string, src: string): InsertSite[] {
  const sites: InsertSite[] = [];
  INSERT_HEAD_RE.lastIndex = 0;
  for (const m of src.matchAll(INSERT_HEAD_RE)) {
    const headIdx = m.index ?? 0;
    // the `{` is the last char of the match.
    const braceIdx = headIdx + m[0].length - 1;
    const block = extractObjectBlock(src, braceIdx);
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
 * Core gate: every question-insert site must either carry draft_status OR live in an
 * allowlisted file. Allowlisted-AND-explicit silently passes (L2→L4 chain-merge guard:
 * after L2 sets draft_status on embedded/teaching, their allowlist entries become
 * harmless-redundant — they must NOT hard-fail). Exported pure for unit testing.
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
  const { entries, raw } = loadAllowlist();
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

// CLI-gate (mirrors audit-test-partition.ts): only walk + exit when run as a CLI so the
// self-test can import the pure functions without the top-level scan firing.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
