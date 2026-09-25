/**
 * YUK-1043 — question 内容列写入闭包审计（insert/update closure audit）。
 *
 * 统一发布链的不变量：legacy `question` 行是工作副本 + 读投影；判分输入
 * （内容列）的写入方只有两类 ——
 *   1. publisher-converged：经统一 publisher seam（同事务铸 revision）写入；
 *   2. working-copy-pending：仍在等待收敛 lane 的 producer（显式登记 +
 *      ticket 归属 —— 不许静默绕过）。
 *
 * 本脚本静态扫描 src/ + scripts/（排除 *.test.ts）中所有 `.insert(question)` /
 * `.update(question)` 语句的载荷，凡触及 CONTENT_COLUMNS 的文件必须在
 * src/server/questions/writer-registry.ts 登记；converged 文件必须真的引用
 * publisher seam（防登记漂移）。生命周期/投影列（draft_status、embedding、
 * answer_class、canonical_content_hash、metadata、knowledge_ids、difficulty）
 * 不触发登记（§2 矩阵：检索投影 vs 判分输入分开）。
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
const SEARCH_DIRS = ['src', 'scripts'].map((d) => resolve(REPO_ROOT, d));
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

const WRITE_HEAD_RE = /\.(?:insert|update)\(\s*(?:schema\.)?question\s*\)/g;

/** 顶层 spread 检测：payload 起始的 `set({...` / `values({...` 对象内深度 1 处的 `...ident`。 */
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

export interface Finding {
  file: string;
  line: number;
  snippet: string;
  kind: 'insert' | 'update';
  contentColumns: string[];
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

/** 语句载荷窗口：write head 起到【深度 0】的 `;` 或下一个 write head。
 *
 * YUK-1043 闭包修正：`.values(kinds.map((kind) => { const d = ...; ... }))` 这类
 * 载荷里，map 回调体内部的 `;` 不是语句结束 —— intervention-diagnostics 的
 * 诊断 INSERT 曾因此漏检（§2 矩阵行 16）。以 head 之后的括号/花括号深度为
 * 界：仅 depth===0 的 `;` 终结窗口；深度为负（异常截断）时退化为文件尾。 */
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

export function scanSource(src: string): Omit<Finding, 'file'>[] {
  const hits: Omit<Finding, 'file'>[] = [];
  WRITE_HEAD_RE.lastIndex = 0;
  for (const m of src.matchAll(WRITE_HEAD_RE)) {
    const headStart = m.index ?? 0;
    const kind: 'insert' | 'update' = m[0].includes('insert') ? 'insert' : 'update';
    const { end } = statementWindow(src, headStart + m[0].length);
    const payload = src.slice(headStart, end);
    // 动态载荷（顶层 spread）无法静态判列 —— 保守视为内容写入（write.ts 的
    // `set({ ...setValues })` / sourced-draft-insert、quiz_gen 的
    // `values({ ...questionRow })`）。只计 payload 顶层（大括号深度 1）的
    // spread：嵌套在值内部的 spread（如 metadata: { ...metadataRaw }）只影响
    // 该键本身，不放大写入面（quiz_verify:1107 先例）。
    const isDynamic = hasTopLevelSpread(payload);
    const contentColumns = isDynamic
      ? [...CONTENT_COLUMNS]
      : CONTENT_COLUMNS.filter((col) => new RegExp(`["']?${col}["']?\\s*:`).test(payload));
    if (contentColumns.length === 0) continue; // 生命周期/投影写入不触发登记
    const line = src.slice(0, headStart).split('\n').length;
    hits.push({ line, kind, contentColumns, snippet: payload.slice(0, 120).replace(/\s+/g, ' ') });
  }
  return hits;
}

function main(): number {
  const json = process.argv.includes('--json');
  const findings: Finding[] = [];
  for (const dir of SEARCH_DIRS) {
    for (const file of walk(dir)) {
      if (/\.test\.tsx?$/.test(file)) continue;
      const rel = relative(REPO_ROOT, file);
      // 分析器脚本自身（含对写入形状的 regex/文档字符串）不是 runtime writer。
      if (/^scripts\/audit-[a-z-]+\.ts$/.test(rel)) continue;
      const src = readFileSync(file, 'utf8');
      for (const hit of scanSource(src)) findings.push({ file: rel, ...hit });
    }
  }

  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }

  const violations: string[] = [];
  for (const [file, hits] of [...byFile.entries()].sort()) {
    const entry = QUESTION_CONTENT_WRITER_REGISTRY[file];
    if (!entry) {
      violations.push(
        `UNREGISTERED content writer: ${file} (${hits.map((h) => h.contentColumns.join('+')).join(', ')}) — add to writer-registry.ts with a disposition`,
      );
      continue;
    }
    if (entry.status === 'publisher-converged') {
      const src = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      if (!/publishQuestionGroup/.test(src)) {
        violations.push(
          `REGISTRY DRIFT: ${file} claims publisher-converged but does not reference the publisher seam`,
        );
      }
    }
  }
  // Registry 反向检查：登记为 converged 的文件确实存在内容写入（防过期条目）。
  for (const [file, entry] of Object.entries(QUESTION_CONTENT_WRITER_REGISTRY)) {
    if (entry.status === 'publisher-converged' && !byFile.has(file)) {
      violations.push(
        `STALE ENTRY: ${file} registered as content writer but scanner sees no content-column write`,
      );
    }
  }

  if (json) {
    console.log(JSON.stringify({ findings, violations }, null, 2));
  } else {
    console.log('\n=== question 内容列写入闭包（YUK-1043）===');
    for (const [file, hits] of [...byFile.entries()].sort()) {
      const entry = QUESTION_CONTENT_WRITER_REGISTRY[file];
      const status = entry ? `${entry.status} [${entry.tickets.join('/')}]` : '⚠️ UNREGISTERED';
      console.log(
        `${file} → ${status} (${hits.length} site(s): ${hits.map((h) => h.contentColumns.join('+')).join(', ')})`,
      );
    }
    if (violations.length > 0) {
      console.error(`\n✖ ${violations.length} violation(s):`);
      for (const v of violations) console.error(`  - ${v}`);
      process.exit(1);
    }
    console.log('\n✔ 全部内容列写入方已登记（converged 或显式 pending 分类）。');
  }
  return violations.length > 0 ? 1 : 0;
}

if (process.argv[1]?.endsWith('audit-question-content-writers.ts')) {
  process.exit(main());
}
