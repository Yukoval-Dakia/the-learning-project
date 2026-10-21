/**
 * Question content-column write-closure audit.
 *
 * The `question` row is a working copy plus read projection, but its content columns (the grading
 * inputs) may only be written by:
 *   1. publisher-converged writers that call the publisher seam in the same transaction, at each
 *      write site (not merely somewhere in the file);
 *   2. explicitly registered working-copy writers with a pending class and ticket.
 *
 * The scan resolves `.insert()/.update()` table bindings against schema imports. Unknown
 * question-like identifiers and dynamic payloads fail closed instead of being skipped. Raw SQL
 * writes are reported. Lifecycle/projection columns do not require registration.
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
// server/ (the Hono runtime root) is part of the scan surface too.
const SEARCH_DIRS = ['src', 'server', 'scripts'].map((d) => resolve(REPO_ROOT, d));
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.git']);

/** Recording-input columns: any change must mint a new revision. */
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
// Table names may carry a schema qualifier (public.question).
const RAW_SQL_RE =
  /(?:\bUPDATE\s+(?:public\.)?question\b|\bINSERT\s+INTO\s+(?:public\.)?question\b)/i;

/** 名称疑似 question（未解析绑定的保守网：q / 任何含 question 的标识符）。 */
function looksQuestionish(ident: string): boolean {
  return ident === 'q' || ident === 'qq' || /question/i.test(ident);
}

/** Comment blanking keeps offsets: newlines stay, other chars become spaces. Prevents comment text
 * from looking like a real `.insert(question)` or `update question` write. */
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

/** Collect local → exported names from db schema imports. */
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

/** Statement payload window: from the write head to a depth-0 `;` or the next write head. Depth
 * tracking covers payloads like `.values(kinds.map((kind) => { ... }))`; strings/templates are
 * skipped whole. */
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

/** Extract the full balanced argument text for set/values (null when the chain has neither). */
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

/** Payload shape for a question write: object/array literals (including a single wrapper call
 * around an inline literal/arrow body) are `literal`; every other expression is `unresolved`
 * because the closure cannot prove which columns are written. */
export type PayloadShape = 'literal' | 'unresolved';

function resolveArgLiteral(text: string, depth = 0): boolean {
  if (depth > 6) return false;
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) return true;
  if (t.startsWith('(')) {
    // (params) => body or a parenthesized expression.
    const close = matchParen(t);
    if (close == null) return false;
    const rest = t.slice(close + 1).trim();
    if (rest.startsWith('=>')) {
      return true; // arrow body (object or block) stays in the window; column match scans it
    }
    return resolveArgLiteral(t.slice(1, close), depth + 1); // 括号表达式
  }
  // Single-arg call chain ident.fn(...) / ident(...): only when its sole argument is an inline
  // literal/arrow. Window truncation may eat the trailing paren, so an unclosed tail is allowed.
  const call = t.match(/^([A-Za-z_$][\w$.]*)\s*\(([\s\S]*)$/);
  if (call == null) return false;
  return resolveArgLiteral(call[2].replace(/\)\s*,?\s*$/, ''), depth + 1);
}

/** Match the first balanced paren; return its closing index or null. */
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
  if (arg == null) return 'literal'; // no set/values (e.g. insert(...).select): no payload surface
  return resolveArgLiteral(arg) ? 'literal' : 'unresolved';
}

/** A depth-1 identifier spread (`...ident`) in the payload object widens the content surface and
 * fails closed. Nested spreads only affect that value; `...{literal}` does not widen. The payload
 * may be a direct literal or an inline literal inside one wrapper call. */
export function hasIdentifierSpread(payload: string): boolean {
  const arg = balancedPayloadArg(payload);
  if (arg == null) return false;
  let objectText = arg.trim();
  // Strip one wrapper call: ident( <object> ) → <object>.
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
      if (depth === 0) break; // top-level payload object closed
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
  /** write-site char offset (for the per-site convergence check). */
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
  // Blank comments first (offsets preserved); every check runs on the comment-free copy.
  const src = blankComments(rawSrc);
  const hits: Omit<Finding, 'file'>[] = [];
  const violations: (Omit<ScanViolation, 'file'> & { line: number })[] = [];
  const bindings = collectSchemaBindings(src);

  const lineOf = (offset: number) => src.slice(0, offset).split('\n').length;

  // Raw SQL writes to question (runtime literal SQL bypass).
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

    // ---- table resolution (fail-closed) ----
    const baseIdent = tableExpr.split('.').pop() ?? tableExpr;
    const resolved =
      baseIdent === 'question'
        ? 'question' // bare question name; no import needed — in real code it can only be the table
        : bindings.has(baseIdent)
          ? bindings.get(baseIdent)
          : looksQuestionish(baseIdent)
            ? 'question?'
            : null;
    if (resolved == null) continue; // unrelated drizzle table/object
    if (resolved === 'question?') {
      violations.push({
        code: 'UNRESOLVED_TABLE',
        line,
        detail: `'.${m[0].startsWith('.i') ? 'insert' : 'update'}(${tableExpr})' — identifier '${baseIdent}' is not a schema import but looks question-ish; resolve the table explicitly`,
      });
      continue;
    }
    if (resolved !== 'question') continue; // another schema table

    const kind: 'insert' | 'update' = m[0].includes('insert') ? 'insert' : 'update';
    const { end } = statementWindow(src, headStart + m[0].length);
    const payload = src.slice(headStart, end);

    // ---- payload resolution (fail-closed) ----
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
          // Both write forms: `col:` keys and shorthand identifiers (`{ prompt_md }`).
          (col) =>
            new RegExp(`["']?${col}["']?\\s*:`).test(payload) ||
            new RegExp(`\\b${col}\\b\\s*(?:,|\\}|\\]|$)`, 'm').test(payload),
        );
    if (contentColumns.length === 0) continue; // lifecycle/projection write: no registration needed
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

/** Structured source: comments and string contents blanked, offsets preserved, for scope/paren
 * analysis. */
function blankStringsAndComments(src: string): string {
  const out = blankComments(src);
  // Blank string contents, keeping the quotes.
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
  start: number; // offset of the function body's opening brace
  end: number; // offset of the matching closing brace (inclusive)
}

/** Function-body spans: paren-matching plus function-head detection (arrows, function
 * declarations, method shorthand; control-flow heads excluded). Heuristic but conservative: an
 * unrecognized brace is not treated as a function boundary, so the search continues outward. */
function computeFunctionSpans(structSrc: string): FunctionSpan[] {
  const stack: { pos: number; isFunction: boolean }[] = [];
  const spans: FunctionSpan[] = [];
  for (let i = 0; i < structSrc.length; i += 1) {
    const ch = structSrc[i];
    if (ch === '{') {
      // Look back up to 200 chars (no other brace) for the function head.
      const lookbackStart = Math.max(0, i - 200);
      const lookback = structSrc.slice(lookbackStart, i);
      const lastBrace = Math.max(lookback.lastIndexOf('{'), lookback.lastIndexOf('}'));
      const tail = lookback.slice(lastBrace + 1);
      let isFunction = false;
      if (/=>\s*$/.test(tail)) {
        isFunction = true; // arrow body
      } else {
        // Return-type-annotated declaration: `): Promise<X> {` — strip the trailing `: type`.
        const stripped = tail.replace(/\)\s*:\s*[^{}()]*$/, ')');
        const call = stripped.match(/([A-Za-z_$][\w$]*)\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*$/);
        if (call != null && !NON_FUNCTION_HEADS.has(call[1])) {
          isFunction = true; // function declaration / method / named function expression
        }
      }
      stack.push({ pos: i, isFunction });
      continue;
    }
    if (ch === '}') {
      const frame = stack.pop();
      if (frame?.isFunction) spans.push({ start: frame.pos, end: i });
    }
  }
  return spans;
}

/** Per-site coverage: the write site's real enclosing function must contain the seam call. Uses
 * function scope, not a char window, so a seam in a different function does not count. */
export function siteEnclosingFunctionHasSeam(rawSrc: string, siteOffset: number): boolean {
  const structSrc = blankStringsAndComments(rawSrc);
  const spans = computeFunctionSpans(structSrc);
  // Innermost enclosing function.
  let enclosing: FunctionSpan | null = null;
  for (const span of spans) {
    if (span.start < siteOffset && siteOffset < span.end) {
      if (enclosing == null || span.end - span.start < enclosing.end - enclosing.start) {
        enclosing = span;
      }
    }
  }
  if (enclosing == null) return false; // top-level write site: not accepted
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
      // The analyzer scripts themselves (regex/doc strings with write shapes) are not runtime writers.
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
  // Registry reverse-check: a file registered as converged must actually have a content write.
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
