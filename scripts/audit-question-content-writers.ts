/**
 * YUK-1043 — question 内容列写入闭包审计（insert/update closure audit）。
 * 复审 P1-7 重构：fail-closed。
 *
 * 统一发布链的不变量：legacy `question` 行是工作副本 + 读投影；判分输入
 * （内容列）的写入方只有两类 ——
 *   1. publisher-converged：经统一 publisher seam（同事务铸 revision）写入，
 *      且【每个内容写点】的结构邻域内必须真的调用 seam（per-site，不是
 *      文件级字符串存在性）；
 *   2. working-copy-pending：显式登记 + pendingClass（cutover / blocked-by
 *      ticket）+ ticket 归属 —— 不许静默绕过。
 *
 * 静态扫描 src/ + server/ + scripts/（排除 *.test.ts）：
 *   - 表解析：`.insert(X)/.update(X)` 的 X 解析到 schema import 绑定
 *     （含别名）；绑定到 question（或字面 question / schema.question）→
 *     question 写口；绑定到其它 schema 表 → 跳过；无法解析但名称疑似
 *     question（含 q / *question*）→ UNRESOLVED_TABLE（fail-closed）。
 *   - 载荷解析：question 写口的 `.set(...)/.values(...)` 载荷必须是对象/数组
 *     字面量（可含 spread）；标识符/函数调用等动态载荷 → UNRESOLVED_PAYLOAD。
 *     字面量载荷按内容列匹配（`col:` 键或 shorthand 标识符，双写面）。
 *   - 原生 SQL：`UPDATE question SET` / `INSERT INTO question` 字面 → RAW_SQL。
 *   - converged per-site 校验：内容写点起、同层或外一层块（≤120 行）内必须
 *     出现 publishQuestionGroup 调用 —— 注册文件内新增绕过写口会被抓。
 *
 * 生命周期/投影列（draft_status、embedding、answer_class、
 * canonical_content_hash、metadata、knowledge_ids、difficulty）不触发登记
 * （§2 矩阵：检索投影 vs 判分输入分开）。
 *
 * 用法：pnpm audit:question-writers [--json]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { QUESTION_CONTENT_WRITER_REGISTRY } from '../src/server/questions/writer-registry';

const __dirname = (() => {
  const url = fileURLToPath(import.meta.url);
  return url.slice(0, url.lastIndexOf('/'));
})();
const REPO_ROOT = resolve(__dirname, '..');
// P1-7 — server/（Hono 运行时顶层）也必须入扫描面。
const SEARCH_DIRS = ['src', 'server', 'scripts'].map((d) => resolve(REPO_ROOT, d));
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.git']);

/** 判分输入列（改变 ⇒ 必须铸新 revision；§2 矩阵「后者走新版本」）。 */
export const CONTENT_COLUMNS = [
  'prompt_md',
  'reference_md',
  'rubric_json',
  'choices_md',
  'structured',
  'judge_kind_override',
  'figures',
  'image_refs',
] as const;

const WRITE_HEAD_RE = /\.(?:insert|update)\(\s*([A-Za-z_$][A-Za-z0-9_$.]*)\s*\)/g;
const RAW_SQL_RE = /(?:\bUPDATE\s+question\b|\bINSERT\s+INTO\s+question\b)/i;

/** 名称疑似 question（未解析绑定的保守网：q / 任何含 question 的标识符）。 */
function looksQuestionish(ident: string): boolean {
  return ident === 'q' || ident === 'qq' || /question/i.test(ident);
}

/** 注释抹除（offset 保持：换行不变，其余字符换空格）—— 防 comment 里的
 * `.insert(question)` / `update question rows` 文本被当成真实写口（P1-7
 * 实测踩到：write-quiz 头注释与 sourced-draft-insert 的 INSERT_HEAD_RE 说明）。 */
export function blankComments(src: string): string {
  const out = src.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let j = from; j < to && j < out.length; j += 1) {
      if (out[j] !== '\n') out[j] = ' ';
    }
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const start = i;
      while (i < src.length && src[i] !== '\n') i += 1;
      blank(start, i);
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      blank(start, Math.min(i, src.length));
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** 收集文件内从 db schema 模块的 import 绑定：local → exported。 */
function collectSchemaBindings(src: string): Map<string, string> {
  const bindings = new Map<string, string>();
  const importRe =
    /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]*(?:db\/schema|schema\.ts|\/schema))['"]/g;
  for (const m of src.matchAll(importRe)) {
    const clause = m[1];
    for (const part of clause.split(',')) {
      const named = part.match(/^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/);
      if (!named) continue;
      const exported = named[1];
      const local = named[2] ?? named[1];
      bindings.set(local, exported);
    }
  }
  return bindings;
}

/** 语句载荷窗口：write head 起到【深度 0】的 `;` 或下一个 write head。
 * 深度追踪覆盖 `.values(kinds.map((kind) => { const d = ...; ... }))` 这类
 * 载荷（回调体内的 `;` 不是语句结束）。字符串/模板字面量整体跳过。 */
function statementWindow(src: string, headEnd: number): { start: number; end: number } {
  const nextHead = (() => {
    WRITE_HEAD_RE.lastIndex = headEnd;
    const m = WRITE_HEAD_RE.exec(src);
    WRITE_HEAD_RE.lastIndex = 0;
    return m?.index ?? -1;
  })();
  let bound = nextHead > 0 ? nextHead : src.length;
  let depth = 0;
  for (let i = headEnd; i < bound; i += 1) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < bound && src[i] !== quote) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth -= 1;
      if (depth < 0) {
        bound = i;
        break;
      }
    } else if (ch === ';' && depth === 0) {
      bound = i;
      break;
    }
  }
  return { start: headEnd, end: bound };
}

/** question 写口的载荷形态判定（P1-7）：只有【裸标识符载荷】
 *（`.set(patch)` / `.values(row as never)`）无法静态判列 ⇒ unresolved；
 * 包装调用（`withAnswerClass({...})`）/ map 回调（`kinds.map(k => ({...}))`）
 * 的对象字面量在语句窗口内可见 ⇒ literal（列匹配用整个窗口）。 */
type PayloadShape = 'literal' | 'unresolved';

function payloadShape(payload: string): PayloadShape {
  const m = payload.match(/\.(?:set|values)\(\s*([\s\S]{0,120}?)\)/);
  if (m == null) return 'literal'; // 无 set/values（如 insert(...).select 链）—— 无载荷面
  const arg = m[1];
  // 裸标识符（可带 as 断言）：内容在别处定义，静态闭包看不到 ⇒ fail-closed。
  if (/^\s*[A-Za-z_$][\w$]*(?:\s+as\s+never)?\s*$/.test(arg)) return 'unresolved';
  return 'literal';
}

export interface Finding {
  file: string;
  line: number;
  snippet: string;
  kind: 'insert' | 'update';
  contentColumns: string[];
  /** 写点在源内的字符 offset（converged per-site 校验用）。 */
  offset: number;
}

export interface ScanViolation {
  file: string;
  line: number;
  code: 'UNRESOLVED_TABLE' | 'UNRESOLVED_PAYLOAD' | 'RAW_SQL';
  detail: string;
}

export interface ScanResult {
  findings: Omit<Finding, 'file'>[];
  violations: ScanViolation[];
}

/** 顶层 spread 检测：payload 的 set/values 对象字面量深度 1 处的 `...ident`。 */
function hasTopLevelSpread(payload: string): boolean {
  const open = payload.search(/\.(?:set|values)\(\s*\{/);
  if (open < 0) return false;
  let depth = 0;
  let i = open;
  while (i < payload.length) {
    const ch = payload[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < payload.length && payload[i] !== quote) {
        if (payload[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return false; // payload 顶层对象闭合
    }
    if (depth === 1 && ch === '.' && payload.slice(i, i + 3) === '...') {
      const after = payload[i + 3];
      if (/[A-Za-z_]/.test(after)) return true;
    }
    i += 1;
  }
  return false;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

export function scanSource(rawSrc: string): Omit<ScanResult, 'violations'> & {
  violations: (Omit<ScanViolation, 'file'> & { line: number })[];
} {
  // 注释抹除（offset 对齐）：head/raw-SQL/scope 都在无注释副本上判定。
  const src = blankComments(rawSrc);
  const hits: Omit<Finding, 'file'>[] = [];
  const violations: (Omit<ScanViolation, 'file'> & { line: number })[] = [];
  const bindings = collectSchemaBindings(src);

  const lineOf = (offset: number) => src.slice(0, offset).split('\n').length;

  // 原生 SQL 绕过面（运行时代码里的字面 SQL 写 question）。
  for (const m of src.matchAll(new RegExp(RAW_SQL_RE.source, 'gi'))) {
    violations.push({
      code: 'RAW_SQL',
      line: lineOf(m.index ?? 0),
      detail: `raw SQL write on question table: ${m[0]}`,
    });
  }

  WRITE_HEAD_RE.lastIndex = 0;
  for (const m of src.matchAll(WRITE_HEAD_RE)) {
    const headStart = m.index ?? 0;
    const tableExpr = m[1];
    const line = lineOf(headStart);

    // ---- 表解析（P1-7 fail-closed）----
    const baseIdent = tableExpr.split('.').pop() ?? tableExpr;
    const resolved =
      baseIdent === 'question'
        ? 'question' // 字面 question 名（无 import 也能解析 —— 真实代码里它只能指表）
        : bindings.has(baseIdent)
          ? bindings.get(baseIdent)
          : looksQuestionish(baseIdent)
            ? 'question?'
            : null;
    if (resolved == null) continue; // 与 question 无关的 drizzle 表/对象
    if (resolved === 'question?') {
      violations.push({
        code: 'UNRESOLVED_TABLE',
        line,
        detail: `'.${m[0].startsWith('.i') ? 'insert' : 'update'}(${tableExpr})' — identifier '${baseIdent}' is not a schema import but looks question-ish; resolve the table explicitly`,
      });
      continue;
    }
    if (resolved !== 'question') continue; // 其它 schema 表

    const kind: 'insert' | 'update' = m[0].includes('insert') ? 'insert' : 'update';
    const { end } = statementWindow(src, headStart + m[0].length);
    const payload = src.slice(headStart, end);

    // ---- 载荷解析（P1-7 fail-closed）----
    if (payloadShape(payload) === 'unresolved') {
      const argDesc = payload.match(/\.(?:set|values)\(\s*([^)]{0,40})/s)?.[1] ?? '?';
      violations.push({
        code: 'UNRESOLVED_PAYLOAD',
        line,
        detail: `question ${kind} payload is not an object/array literal (got '${argDesc.trim()}…') — static closure cannot prove which columns are written`,
      });
      continue;
    }

    const isDynamic = hasTopLevelSpread(payload);
    const contentColumns = isDynamic
      ? [...CONTENT_COLUMNS]
      : CONTENT_COLUMNS.filter(
          // 双写面：`col:` 键 或 shorthand 标识符（`{ prompt_md }` / `...f({ prompt_md })`）。
          (col) =>
            new RegExp(`["']?${col}["']?\\s*:`).test(payload) ||
            new RegExp(`\\b${col}\\b\\s*(?:,|\\}|\\]|$)`, 'm').test(payload),
        );
    if (contentColumns.length === 0) continue; // 生命周期/投影写入不触发登记
    hits.push({
      line,
      kind,
      contentColumns,
      snippet: payload.slice(0, 120).replace(/\s+/g, ' '),
      offset: headStart,
    });
  }
  return { findings: hits, violations };
}

/** converged 文件的 per-site 校验（P1-7）：内容写点起、同层或外一层块
 *（≤120 行）内必须出现 publisher seam 调用。 */
export function siteHasPublishInScope(src: string, siteOffset: number): boolean {
  const limit = Math.min(src.length, siteOffset + 120 * 120); // ~120 行保守上界
  let depth = 0;
  let region = '';
  for (let i = siteOffset; i < limit; i += 1) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < limit && src[i] !== quote) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      region += '""';
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth -= 1;
      // 越过本块再退一层（同层 / 外一层）为止。
      if (depth < -2) break;
    }
    region += ch;
  }
  return /publishQuestionGroup/.test(region);
}

function main(): number {
  const json = process.argv.includes('--json');
  const findings: Finding[] = [];
  const violations: ScanViolation[] = [];
  const siteOffsetsByFile = new Map<string, number[]>();
  const srcByFile = new Map<string, string>();

  for (const dir of SEARCH_DIRS) {
    for (const file of walk(dir)) {
      if (/\.test\.tsx?$/.test(file)) continue;
      const rel = relative(REPO_ROOT, file);
      // 分析器脚本自身（含写入形状的 regex/文档字符串）不是 runtime writer。
      if (/^scripts\/audit-[a-z-]+\.ts$/.test(rel)) continue;
      const raw = readFileSync(file, 'utf8');
      const src = blankComments(raw);
      const result = scanSource(raw);
      for (const hit of result.findings) findings.push({ ...hit, file: rel });
      for (const v of result.violations) violations.push({ ...v, file: rel });
      if (
        result.findings.length > 0 &&
        QUESTION_CONTENT_WRITER_REGISTRY[rel]?.status === 'publisher-converged'
      ) {
        srcByFile.set(rel, src);
        siteOffsetsByFile.set(
          rel,
          result.findings.map((f) => f.offset),
        );
      }
    }
  }

  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }

  const registryViolations: string[] = [];
  for (const [file, hits] of [...byFile.entries()].sort()) {
    const entry = QUESTION_CONTENT_WRITER_REGISTRY[file];
    if (!entry) {
      registryViolations.push(
        `UNREGISTERED content writer: ${file} (${hits.map((h) => h.contentColumns.join('+')).join(', ')}) — add to writer-registry.ts with a disposition`,
      );
      continue;
    }
    if (entry.status === 'publisher-converged') {
      const src = srcByFile.get(file) ?? readFileSync(resolve(REPO_ROOT, file), 'utf8');
      const offsets = siteOffsetsByFile.get(file) ?? [];
      if (!/publishQuestionGroup/.test(src)) {
        registryViolations.push(
          `REGISTRY DRIFT: ${file} claims publisher-converged but does not reference the publisher seam`,
        );
        continue;
      }
      const uncovered = offsets.filter((o) => !siteHasPublishInScope(src, o));
      if (uncovered.length > 0) {
        const lines = uncovered.map((o) => src.slice(0, o).split('\n').length);
        registryViolations.push(
          `UNCONVERGED SITE(S): ${file} lines ${lines.join(',')} write question content columns with no publishQuestionGroup call in the enclosing scope (per-site convergence, P1-7)`,
        );
      }
    }
  }
  // Registry 反向检查：登记为 converged 的文件确实存在内容写入（防过期条目）。
  for (const [file, entry] of Object.entries(QUESTION_CONTENT_WRITER_REGISTRY)) {
    if (entry.status === 'publisher-converged' && !byFile.has(file)) {
      registryViolations.push(
        `STALE ENTRY: ${file} registered as content writer but scanner sees no content-column write`,
      );
    }
  }

  if (json) {
    console.log(JSON.stringify({ findings, violations, registryViolations }, null, 2));
  } else {
    console.log('\n=== question 内容列写入闭包（YUK-1043）===');
    for (const [file, hits] of [...byFile.entries()].sort()) {
      const entry = QUESTION_CONTENT_WRITER_REGISTRY[file];
      const status = entry
        ? `${entry.status}${entry.pendingClass ? ` [${entry.pendingClass}]` : ''} [${entry.tickets.join('/')}]`
        : '⚠️ UNREGISTERED';
      console.log(
        `${file} → ${status} (${hits.length} site(s): ${hits.map((h) => h.contentColumns.join('+')).join(', ')})`,
      );
    }
    const allViolations = [
      ...violations.map((v) => `${v.file}:${v.line} ${v.code} — ${v.detail}`),
      ...registryViolations,
    ];
    if (allViolations.length > 0) {
      console.error(`\n✖ ${allViolations.length} violation(s):`);
      for (const v of allViolations) console.error(`  - ${v}`);
      process.exit(1);
    }
    console.log('\n✔ 全部内容列写入方已登记（converged per-site 验证或显式 pending 分类）。');
  }
  return violations.length > 0 || registryViolations.length > 0 ? 1 : 0;
}

if (process.argv[1]?.endsWith('audit-question-content-writers.ts')) {
  process.exit(main());
}
