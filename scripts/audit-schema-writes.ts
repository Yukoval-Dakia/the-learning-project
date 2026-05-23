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
  const trimmed = line.trim();
  return trimmed.startsWith('✅') || /已\s*ship|shipped|done/i.test(trimmed);
}

function isPhaseShipped(ref: string, statusText: string): boolean {
  const normalizedRef = normalizePhaseText(ref);
  if (!normalizedRef) return false;
  const refTokens = normalizedRef.split(/\s+/).filter(Boolean);
  return statusText
    .split('\n')
    .filter(isShippedStatusLine)
    .some((line) => {
      const normalizedLine = normalizePhaseText(line);
      return (
        normalizedLine.includes(normalizedRef) ||
        refTokens.every((token) => normalizedLine.includes(token))
      );
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

function parseSchema(src: string): Field[] {
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
    const fieldMatches = block.matchAll(
      /^\s{2,4}(\w+):\s+(text|integer|real|jsonb|boolean|timestamp|smallint|bigint|date|numeric|varchar|json|uuid|bytea|check|primaryKey|unique|index|foreignKey)\(/gm,
    );
    for (const m of fieldMatches) {
      // 跳过 schema constraint helpers
      if (['check', 'primaryKey', 'unique', 'index', 'foreignKey'].includes(m[2])) continue;
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

function buildIndex(
  files: string[],
): Map<string, { src: string; hasInsert: boolean; hasUpdate: boolean }> {
  const index = new Map<string, { src: string; hasInsert: boolean; hasUpdate: boolean }>();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const hasInsert = /\.values\s*\(|\binsertInto\b/.test(src);
    const hasUpdate = /\.set\s*\(/.test(src);
    index.set(f, { src, hasInsert, hasUpdate });
  }
  return index;
}

function countWriteHits(
  field: string,
  index: Map<string, { src: string; hasInsert: boolean; hasUpdate: boolean }>,
): { insert_files: number; update_files: number } {
  // 字段名匹配两种形式：
  //   1. `field: <value>` —— 长形式
  //   2. `field,` 或 `field }` —— Drizzle shorthand（变量名同字段名）
  // 简化：文件含 .values( 且至少一处匹配 → 计 insert hit；同理 set。
  const longForm = new RegExp(`\\b${field}\\s*:`);
  const shortForm = new RegExp(`[,{(\\s]${field}\\s*[,}]`);
  let insertFiles = 0;
  let updateFiles = 0;
  for (const [, { src, hasInsert, hasUpdate }] of index) {
    if (!longForm.test(src) && !shortForm.test(src)) continue;
    if (hasInsert) insertFiles++;
    if (hasUpdate) updateFiles++;
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
    const { insert_files, update_files } = countWriteHits(f.field, index);
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
