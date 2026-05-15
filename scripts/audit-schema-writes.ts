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

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCHEMA_PATH = resolve(REPO_ROOT, 'src/db/schema.ts');
const ALLOWLIST_PATH = resolve(__dirname, 'audit-schema-allowlist.json');
const SEARCH_DIRS = ['src', 'app'].map((d) => resolve(REPO_ROOT, d));
const EXCLUDE_DIRS = new Set(['node_modules', '.next', 'dist', '.git']);

type Field = { table: string; field: string; type: string };
type AllowlistEntry = { reason: string; resolves_when: string };
type Allowlist = Record<string, AllowlistEntry>;
type WriteHit = {
  table: string;
  field: string;
  type: string;
  insert_files: number;
  update_files: number;
  status: 'live' | 'init-only' | 'update-only' | 'stub';
};

const TRIVIAL_FIELDS = new Set(['id', 'created_at', 'updated_at', 'version', 'archived_at']);

function parseSchema(src: string): Field[] {
  const fields: Field[] = [];
  const tableHeads = [...src.matchAll(/export const (\w+) = pgTable\(\s*'(\w+)'/g)];
  for (let i = 0; i < tableHeads.length; i++) {
    const tableName = tableHeads[i][2];
    const start = tableHeads[i].index ?? 0;
    const end = tableHeads[i + 1]?.index ?? src.length;
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

function loadAllowlist(): Allowlist {
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

function buildIndex(files: string[]): Map<string, { src: string; hasInsert: boolean; hasUpdate: boolean }> {
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
  const allowlist = loadAllowlist();
  const stubs = results.filter((r) => r.status === 'stub');
  const unallowedStubs = stubs.filter((s) => !allowlist[`${s.table}.${s.field}`]);
  const allowedStubs = stubs.filter((s) => allowlist[`${s.table}.${s.field}`]);

  if (asJson) {
    console.log(JSON.stringify({ results, unallowedStubs, allowedStubs }, null, 2));
    process.exit(listOnly ? 0 : unallowedStubs.length > 0 ? 1 : 0);
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
  console.log(`  stub (unallowed): ${unallowedStubs.length}${unallowedStubs.length > 0 ? ' ⚠️' : ''}`);

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

main();
