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
// P1-4r2 —— 表名可带 schema 限定（public.question）。
const RAW_SQL_RE =
  /(?:\bUPDATE\s+(?:public\.)?question\b|\bINSERT\s+INTO\s+(?:public\.)?question\b)/i;

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

/** 提取 set/values 的【平衡括号】完整参数文本（null = 链上无 set/values）。 */
function balancedPayloadArg(payload: string): string | null {
  const m = payload.match(/\.(?:set|values)\(/);
  if (m == null || m.index == null) return null;
  let i = m.index + m[0].length;
  let depth = 1;
  const start = i;
  while (i < payload.length && depth > 0) {
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
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    i += 1;
  }
  return depth === 0 ? payload.slice(start, i - 1) : null;
}

/** question 写口的载荷形态判定（P1-4r2 fail-closed）：
 *  - 对象/数组字面量（含单层包装调用与 map 回调的【内联】字面量/箭头体）
 *    ⇒ literal —— 列匹配用整个窗口；
 *  - 其余一切表达式（裸标识符 / member access / as 断言 / 参数非字面量的
 *    任意调用）⇒ UNRESOLVED_PAYLOAD —— 静态闭包无法证明写了哪些列。 */
export type PayloadShape = 'literal' | 'unresolved';

function resolveArgLiteral(text: string, depth = 0): boolean {
  if (depth > 6) return false;
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) return true;
  if (t.startsWith('(')) {
    // (params) => body / 纯括号表达式。
    const close = matchParen(t);
    if (close == null) return false;
    const rest = t.slice(close + 1).trim();
    if (rest.startsWith('=>')) {
      return true; // 箭头体（对象/语句体）都在窗口内 —— 列匹配扫窗口
    }
    return resolveArgLiteral(t.slice(1, close), depth + 1); // 括号表达式
  }
  // 单参调用链 ident.fn(...) / ident(...)：仅当其唯一参数是内联字面量/箭头。
  //（窗口截断可能吃掉尾括号 —— 允许未闭合尾。）
  const call = t.match(/^([A-Za-z_$][\w$.]*)\s*\(([\s\S]*)$/);
  if (call == null) return false;
  return resolveArgLiteral(call[2].replace(/\)\s*,?\s*$/, ''), depth + 1);
}

/** 匹配首个平衡括号：返回闭合 index，无则 null。 */
function matchParen(text: string): number | null {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

export function payloadShape(payload: string): PayloadShape {
  const arg = balancedPayloadArg(payload);
  if (arg == null) return 'literal'; // 无 set/values（如 insert(...).select 链）—— 无载荷面
  return resolveArgLiteral(arg) ? 'literal' : 'unresolved';
}

/** 载荷对象【深度 1】出现标识符 spread（`...ident`；嵌套在值内部的 merge
 * 只影响该键，不放大写入面；`...{字面量}` 不算）⇒ 全内容面（fail-closed）。
 * 载荷对象可能是直接字面量或单层包装调用的内联字面量 —— 都要看到。 */
export function hasIdentifierSpread(payload: string): boolean {
  const arg = balancedPayloadArg(payload);
  if (arg == null) return false;
  let objectText = arg.trim();
  // 剥单层包装调用：ident( <object> ) → <object>（matchParen 提参）。
  const wrapper = objectText.match(/^[A-Za-z_$][\w$.]*\s*\(/);
  if (wrapper != null) {
    const close = matchParen(objectText);
    if (close != null) objectText = objectText.slice(wrapper[0].length, close).trim();
  }
  if (!objectText.startsWith('{') && !objectText.startsWith('[')) return false;
  let depth = 0;
  let sawSpread = false;
  for (let i = 0; i < objectText.length; i += 1) {
    const ch = objectText[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < objectText.length && objectText[i] !== quote) {
        if (objectText[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth -= 1;
      if (depth === 0) break; // 载荷顶层对象闭合
    } else if (depth === 1 && ch === '.' && objectText.slice(i, i + 3) === '...') {
      const after = objectText[i + 3];
      if (/[A-Za-z_$]/.test(after)) sawSpread = true; // ...ident
    }
  }
  return sawSpread;
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

    const isDynamic = hasIdentifierSpread(payload);
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

/** 结构化源：抹除注释 + 字符串内容（offset 保持）—— 供作用域/括号分析。 */
function blankStringsAndComments(src: string): string {
  const out = blankComments(src);
  // 再抹字符串内容（保留引号本身）。
  const chars = out.split('');
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let j = from; j < to && j < chars.length; j += 1) {
      if (chars[j] !== '\n') chars[j] = ' ';
    }
  };
  while (i < out.length) {
    const ch = out[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < out.length && out[i] !== quote) {
        if (out[i] === '\\') i += 1;
        i += 1;
      }
      blank(start + 1, i); // 内容抹除，保留引号
      i += 1;
      continue;
    }
    i += 1;
  }
  return chars.join('');
}

const NON_FUNCTION_HEADS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'with',
  'return',
  'typeof',
  'await',
]);

interface FunctionSpan {
  start: number; // 函数体开始 brace 的 offset
  end: number; // 匹配的闭 brace offset（含）
}

/** 函数体 span 提取：括号配对栈 + 函数头识别（箭头 / function 声明式 /
 * 方法简写 —— 排除控制流头）。启发式但保守：识别不出函数头时该 brace 不
 * 作为函数边界（外层继续向上找）。 */
function computeFunctionSpans(structSrc: string): FunctionSpan[] {
  const stack: { pos: number; isFunction: boolean }[] = [];
  const spans: FunctionSpan[] = [];
  for (let i = 0; i < structSrc.length; i += 1) {
    const ch = structSrc[i];
    if (ch === '{') {
      // 回看最多 200 字符（不含其它 brace）判断函数头。
      const lookbackStart = Math.max(0, i - 200);
      const lookback = structSrc.slice(lookbackStart, i);
      const lastBrace = Math.max(lookback.lastIndexOf('{'), lookback.lastIndexOf('}'));
      const tail = lookback.slice(lastBrace + 1);
      let isFunction = false;
      if (/=>\s*$/.test(tail)) {
        isFunction = true; // 箭头函数体
      } else {
        // 返回类型注解的函数声明：`): Promise<X> {` —— 先剥掉尾部的 `: type`。
        const stripped = tail.replace(/\)\s*:\s*[^{}()]*$/, ')');
        const call = stripped.match(/([A-Za-z_$][\w$]*)\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*$/);
        if (call != null && !NON_FUNCTION_HEADS.has(call[1])) {
          isFunction = true; // function 声明 / 方法 / 具名函数表达式
        }
      }
      stack.push({ pos: i, isFunction });
      continue;
    }
    if (ch === '}') {
      const frame = stack.pop();
      if (frame != null && frame.isFunction) spans.push({ start: frame.pos, end: i });
    }
  }
  return spans;
}

/** P1-4r2 — per-site 覆盖 = 写点的【真实包围函数】内必须出现 seam 调用
 *（函数作用域分析，非字符窗口 —— bypass()/unrelated() 跨函数不计）。 */
export function siteEnclosingFunctionHasSeam(rawSrc: string, siteOffset: number): boolean {
  const structSrc = blankStringsAndComments(rawSrc);
  const spans = computeFunctionSpans(structSrc);
  // 最内层包围函数（start < site < end 中最小约 span）。
  let enclosing: FunctionSpan | null = null;
  for (const span of spans) {
    if (span.start < siteOffset && siteOffset < span.end) {
      if (enclosing == null || span.end - span.start < enclosing.end - enclosing.start) {
        enclosing = span;
      }
    }
  }
  if (enclosing == null) return false; // 顶层写点：不认可（要求函数内 seam）
  const body = structSrc.slice(enclosing.start, enclosing.end + 1);
  return /publishQuestionGroup/.test(body);
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
      const uncovered = offsets.filter((o) => !siteEnclosingFunctionHasSeam(src, o));
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
