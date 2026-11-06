/**
 * audit:flags — flag 定义、reader 与 base/head 契约门
 *
 * 唯一登记处是 `src/core/config/registry.ts` 的 CONFIG_REGISTRY（boolean env 开关 +
 * operator 可枚举/CSV/JSON 控制项）；11 个编译期 const 由领域源码自己的
 * `const NAME = true|false` 定义登记。没有第二份台账：本审计从定义和源码推导，
 * 再与 comparison base 的同一份推导逐项对比。
 *
 * 拦什么：
 *   - 源码里出现 `*_ENABLED` 但既没有 CONFIG_REGISTRY 定义，也不是 boolean const；
 *   - 定义声明的 env 名/字面量域/大小写/极性/envMode 与真实 envParse 或 base 不一致；
 *   - 已登记 flag 没有活 reader（或只有直接 process.env 读）；
 *   - base 不可得（fail closed）；
 *   - 非 ENABLED 控制项（enum/CSV/JSON）从定义推导 census，新增控制项不登记即失败。
 *
 * 只报告不改行为：base/head 的 codeDefault、新增/删除键与 reader 集合变化全部打印，
 * 由 review 判断；LITERAL-VARIANCE 仍是 observability only。
 *
 * 扫描去掉注释、保留字符串（很多 flag 经常量名读取）；测试文件不参与。
 */

import { type Dirent, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { z } from 'zod';
import { CONFIG_REGISTRY, type ConfigKeyDef } from '../src/core/config/registry';
import { listTreeFiles, readBlobs, resolveAuditBaseSha } from './lib/git-base-scan';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const REGISTRY_PATH = 'src/core/config/registry.ts';

const SCAN_ROOTS = ['src', 'server', 'scripts'] as const;
const EXCLUDE_DIRS = new Set(['node_modules', '.next', 'dist', '.git', '.claude', 'drizzle']);
// The audit's own script names flags in doc examples and violation text.
const EXCLUDE_FILES = new Set(['scripts/audit-flags.ts', 'scripts/audit-flags.test.ts']);

// Whole-token match; the trailing guard keeps DEFAULT_ENABLED out of DEFAULT_ENABLED_BY_KIND.
export const FLAG_TOKEN_RE = /(?<![A-Z0-9_])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_ENABLED(?![A-Z0-9_])/g;

const READER_FNS = new Set(['getConfig', 'getConfigFlag', 'getConfigMany']);
const METADATA_FIELDS = ['description', 'consumers', 'reload', 'exposure'] as const;

/** Grammar probes: literal-domain sides, whitespace, case, and non-flag garbage. */
const GRAMMAR_PROBES = [
  '',
  ' ',
  'true',
  'TRUE',
  'True',
  ' true ',
  '1',
  ' 1 ',
  'false',
  'FALSE',
  'False',
  ' false ',
  '0',
  ' 0 ',
  'yes',
  'no',
  'on',
  'off',
  'enabled',
  '2',
  '-1',
] as const;

// ── types ────────────────────────────────────────────────────────────────────────────────────

export type ControlKind = 'flag' | 'enum' | 'csv' | 'json' | 'scalar' | 'other';

export interface FlagGrammarFingerprint {
  trueLiterals: readonly string[];
  falseLiterals: readonly string[];
  caseInsensitive: boolean;
  polarity: 'opt-in' | 'opt-out';
}

export interface DefinitionFingerprint {
  key: string;
  kind: ControlKind;
  codeDefault: unknown;
  /** codeDefault 不是静态字面量时置位：跳过默认值对比，避免假 drift。 */
  codeDefaultUnresolved?: boolean;
  envName: string | null;
  envMode: string;
  tier: string;
  flag: FlagGrammarFingerprint | null;
  /** flag 属性存在但静态不可解析：已单独报问题，不再伪造 BASE-DRIFT。 */
  flagUnresolved?: boolean;
  enumValues: string[] | null | undefined;
}

export interface FingerprintExtraction {
  fingerprints: Map<string, DefinitionFingerprint>;
  problems: string[];
}

export interface HeadDefinition extends DefinitionFingerprint {
  description: string | null;
  consumers: string[] | null;
  reload: string | null;
  exposure: string | null;
  readers: string[];
}

export interface ConstDefinition {
  name: string;
  value: boolean;
  file: string;
}

export type ViolationCode =
  | 'UNREGISTERED'
  | 'DEFINITION-PROBLEM'
  | 'NO-READER'
  | 'ORPHAN-READER'
  | 'ORPHAN-ENV-READ'
  | 'DIRECT-ENV-READ'
  | 'CONST-PROBLEM'
  | 'BASE-PROBLEM'
  | 'BASE-DRIFT';

export interface FlagViolation {
  code: ViolationCode;
  name: string;
  detail: string;
}

export interface DiffEntry {
  name: string;
  field: string;
  base: unknown;
  head: unknown;
}

export interface FlagAuditResult {
  ok: boolean;
  base: string | null;
  definitions: HeadDefinition[];
  consts: ConstDefinition[];
  foundTokens: string[];
  violations: FlagViolation[];
  diff: DiffEntry[];
  variance: { signature: string; flags: string[] }[];
}

// ── comment stripping (keeps strings; a flag name in a string literal DOES count) ──────────────

export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  let inLine = false;
  let inBlock = false;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      i += 1;
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i += 2;
        continue;
      }
      if (c === '\n') out += c;
      i += 1;
      continue;
    }
    if (inSingle) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (inDouble) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inDouble = false;
      i += 1;
      continue;
    }
    if (inTemplate) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === '`') inTemplate = false;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '`') {
      inTemplate = true;
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// ── source tree (head filesystem or a base ref, one comparable shape) ─────────────────────────

// Babel AST nodes are structurally untyped for this audit; helpers narrow before each use.
// biome-ignore lint/suspicious/noExplicitAny: Babel AST node shape
type AstNode = Record<string, any>;

interface Binding {
  init: AstNode;
  file: string;
}

interface ImportBinding {
  source: string;
  imported: string;
}

class SourceTree {
  private readonly texts: Map<string, string>;
  private readonly asts = new Map<string, AstNode | null>();
  private readonly constBindings = new Map<string, Map<string, Binding>>();
  private readonly importBindings = new Map<string, Map<string, ImportBinding>>();

  constructor(texts: Map<string, string>) {
    this.texts = texts;
  }

  static head(): SourceTree {
    const texts = new Map<string, string>();
    for (const root of SCAN_ROOTS) {
      for (const rel of walkHeadSource(join(REPO_ROOT, root))) {
        texts.set(rel, readFileSync(join(REPO_ROOT, rel), 'utf-8'));
      }
    }
    return new SourceTree(texts);
  }

  static atRef(ref: string): SourceTree {
    const files = listTreeFiles(REPO_ROOT, ref, SCAN_ROOTS).filter((entry) =>
      isScannablePath(entry.path),
    );
    const blobs = readBlobs(
      REPO_ROOT,
      ref,
      files.map((entry) => entry.path),
    );
    const texts = new Map<string, string>();
    for (const entry of files) {
      const text = blobs.get(entry.path);
      if (text !== undefined) texts.set(entry.path, text);
    }
    return new SourceTree(texts);
  }

  paths(): string[] {
    return [...this.texts.keys()].sort();
  }

  text(path: string): string | undefined {
    return this.texts.get(path);
  }

  filesContaining(needle: string): string[] {
    return this.paths().filter((path) => this.texts.get(path)?.includes(needle));
  }

  has(path: string): boolean {
    return this.texts.has(path);
  }

  ast(path: string): AstNode | null {
    if (this.asts.has(path)) return this.asts.get(path) ?? null;
    const text = this.texts.get(path);
    if (text === undefined) return null;
    let ast: AstNode | null = null;
    try {
      ast = parse(text, {
        sourceType: 'module',
        plugins: ['typescript', 'jsx'],
        errorRecovery: true,
      }) as unknown as AstNode;
    } catch {
      ast = null;
    }
    this.asts.set(path, ast);
    return ast;
  }

  /** Module-local top-level consts (`const X = ...` and `export const X = ...`). */
  bindings(path: string): Map<string, Binding> {
    const cached = this.constBindings.get(path);
    if (cached) return cached;
    const map = new Map<string, Binding>();
    const ast = this.ast(path);
    if (ast) {
      walkAst(ast, (node) => {
        if (node.type !== 'VariableDeclarator' || node.id?.type !== 'Identifier') return;
        if (!node.init) return;
        if (!map.has(node.id.name)) map.set(node.id.name, { init: node.init, file: path });
      });
    }
    this.constBindings.set(path, map);
    return map;
  }

  imports(path: string): Map<string, ImportBinding> {
    const cached = this.importBindings.get(path);
    if (cached) return cached;
    const map = new Map<string, ImportBinding>();
    const ast = this.ast(path);
    if (ast) {
      walkAst(ast, (node) => {
        if (node.type !== 'ImportDeclaration' || typeof node.source?.value !== 'string') return;
        for (const spec of node.specifiers ?? []) {
          const local = spec.local?.name;
          if (typeof local !== 'string') continue;
          if (spec.type === 'ImportSpecifier' && typeof spec.imported?.name === 'string') {
            map.set(local, { source: node.source.value, imported: spec.imported.name });
          } else if (spec.type === 'ImportDefaultSpecifier') {
            map.set(local, { source: node.source.value, imported: 'default' });
          }
        }
      });
    }
    this.importBindings.set(path, map);
    return map;
  }

  resolveModule(fromPath: string, source: string): string | undefined {
    let base: string | undefined;
    if (source.startsWith('@/')) base = `src/${source.slice(2)}`;
    else if (source.startsWith('.'))
      base = posix.normalize(posix.join(posix.dirname(fromPath), source));
    if (!base) return undefined;
    const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
    return candidates.find((candidate) => this.has(candidate));
  }
}

function isScannablePath(path: string): boolean {
  return (
    (path.endsWith('.ts') || path.endsWith('.tsx')) &&
    !path.endsWith('.test.ts') &&
    !path.endsWith('.test.tsx') &&
    !path.endsWith('.d.ts') &&
    !EXCLUDE_FILES.has(path) &&
    !path.split('/').some((segment) => EXCLUDE_DIRS.has(segment))
  );
}

function walkHeadSource(root: string, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const abs = join(root, entry.name);
    if (entry.isDirectory()) {
      walkHeadSource(abs, out);
    } else if (entry.isFile()) {
      const rel = relative(REPO_ROOT, abs);
      if (isScannablePath(rel)) out.push(rel);
    }
  }
  return out;
}

function walkAst(node: unknown, fn: (node: AstNode) => void): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, fn);
    return;
  }
  const record = node as AstNode;
  if (typeof record.type === 'string') fn(record);
  for (const key of Object.keys(record)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
    walkAst(record[key], fn);
  }
}

// ── expression evaluation / resolution ───────────────────────────────────────────────────────

function unwrapExpression(expr: AstNode): AstNode {
  let current = expr;
  while (
    current &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'ParenthesizedExpression' ||
      current.type === 'ChainExpression' ||
      current.type === 'TypeCastExpression')
  ) {
    current = current.expression;
  }
  return current;
}

const UNKNOWN = Symbol('unknown');

/** Evaluate a literal-only expression; UNKNOWN means "not statically decidable". */
export function evaluateLiteral(expr: AstNode | undefined): unknown {
  if (!expr) return undefined;
  const node = unwrapExpression(expr);
  switch (node.type) {
    case 'StringLiteral':
      return node.value;
    case 'NumericLiteral':
      return node.value;
    case 'BooleanLiteral':
      return node.value;
    case 'NullLiteral':
      return null;
    case 'Identifier':
      return node.name === 'undefined' ? undefined : UNKNOWN;
    case 'UnaryExpression': {
      const value = evaluateLiteral(node.argument);
      if (typeof value !== 'number') return UNKNOWN;
      if (node.operator === '-') return -value;
      if (node.operator === '+') return value;
      return UNKNOWN;
    }
    case 'BinaryExpression': {
      const left = evaluateLiteral(node.left);
      const right = evaluateLiteral(node.right);
      if (typeof left !== 'number' || typeof right !== 'number') return UNKNOWN;
      switch (node.operator) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          return right === 0 ? UNKNOWN : left / right;
        default:
          return UNKNOWN;
      }
    }
    case 'TemplateLiteral':
      if ((node.expressions ?? []).length === 0) {
        return (node.quasis ?? []).map((quasi: AstNode) => quasi.value?.cooked ?? '').join('');
      }
      return UNKNOWN;
    case 'ArrayExpression': {
      const values: unknown[] = [];
      for (const element of node.elements ?? []) {
        if (!element) return UNKNOWN;
        const value = evaluateLiteral(element);
        if (value === UNKNOWN) return UNKNOWN;
        values.push(value);
      }
      return values;
    }
    case 'ObjectExpression': {
      const value: Record<string, unknown> = {};
      for (const prop of node.properties ?? []) {
        if (prop.type !== 'ObjectProperty' || prop.computed) return UNKNOWN;
        const key =
          prop.key.type === 'Identifier'
            ? prop.key.name
            : prop.key.type === 'StringLiteral'
              ? prop.key.value
              : undefined;
        if (key === undefined) return UNKNOWN;
        const propValue = evaluateLiteral(prop.value);
        if (propValue === UNKNOWN) return UNKNOWN;
        value[key] = propValue;
      }
      return value;
    }
    default:
      return UNKNOWN;
  }
}

function resolveStrings(
  tree: SourceTree,
  file: string,
  expr: AstNode | undefined,
  depth = 0,
): string[] | undefined {
  if (!expr || depth > 8) return undefined;
  const node = unwrapExpression(expr);
  switch (node.type) {
    case 'StringLiteral':
      return [node.value];
    case 'TemplateLiteral':
      if ((node.expressions ?? []).length === 0) {
        return [(node.quasis ?? []).map((quasi: AstNode) => quasi.value?.cooked ?? '').join('')];
      }
      return undefined;
    case 'ArrayExpression': {
      const values: string[] = [];
      for (const element of node.elements ?? []) {
        if (!element) return undefined;
        const resolved = resolveStrings(tree, file, element, depth + 1);
        if (!resolved) return undefined;
        values.push(...resolved);
      }
      return values;
    }
    case 'LogicalExpression':
    case 'ConditionalExpression': {
      const branches =
        node.type === 'LogicalExpression'
          ? [node.left, node.right]
          : [node.consequent, node.alternate];
      const values: string[] = [];
      for (const branch of branches) {
        const resolved = resolveStrings(tree, file, branch, depth + 1);
        if (resolved) values.push(...resolved);
      }
      return values.length > 0 ? values : undefined;
    }
    case 'Identifier': {
      const local = tree.bindings(file).get(node.name);
      if (local) return resolveStrings(tree, local.file, local.init, depth + 1);
      const imported = tree.imports(file).get(node.name);
      if (!imported) return undefined;
      const target = tree.resolveModule(file, imported.source);
      if (!target) return undefined;
      const binding = tree.bindings(target).get(imported.imported);
      if (!binding) return undefined;
      return resolveStrings(tree, binding.file, binding.init, depth + 1);
    }
    case 'MemberExpression': {
      const object = unwrapExpression(node.object);
      if (object.type !== 'Identifier') return undefined;
      const local = tree.bindings(file).get(object.name);
      if (!local) return undefined;
      const literal = unwrapExpression(local.init);
      if (literal.type !== 'ObjectExpression') return undefined;
      const properties = (literal.properties ?? []).filter(
        (prop: AstNode) => prop.type === 'ObjectProperty',
      );
      if (!node.computed && node.property?.type === 'Identifier') {
        const match = properties.find((prop: AstNode) => prop.key?.name === node.property.name);
        return match ? resolveStrings(tree, file, match.value, depth + 1) : undefined;
      }
      const values: string[] = [];
      for (const prop of properties) {
        const resolved = resolveStrings(tree, file, prop.value, depth + 1);
        if (resolved) values.push(...resolved);
      }
      return values.length > 0 ? values : undefined;
    }
    default:
      return undefined;
  }
}

// ── scans ───────────────────────────────────────────────────────────────────────────────────

/** Live `*_ENABLED` names (comments stripped, strings kept). */
export function scanFlagTokens(tree: SourceTree): Set<string> {
  const found = new Set<string>();
  for (const path of tree.paths()) {
    const text = tree.text(path);
    if (text === undefined) continue;
    const code = stripComments(text);
    FLAG_TOKEN_RE.lastIndex = 0;
    for (const match of code.matchAll(FLAG_TOKEN_RE)) found.add(match[0]);
  }
  return found;
}

/** flag key → files whose source calls a central reader with that key. */
export function collectReaders(tree: SourceTree): Map<string, string[]> {
  const readers = new Map<string, Set<string>>();
  for (const path of tree.filesContaining('getConfig')) {
    const ast = tree.ast(path);
    if (!ast) continue;
    walkAst(ast, (node) => {
      if (node.type !== 'CallExpression' || node.callee?.type !== 'Identifier') return;
      if (!READER_FNS.has(node.callee.name)) return;
      const keys = resolveStrings(tree, path, node.arguments?.[0]);
      if (!keys) return;
      for (const key of keys) {
        if (!readers.has(key)) readers.set(key, new Set());
        readers.get(key)?.add(path);
      }
    });
  }
  return new Map(
    [...readers.entries()].map(([key, files]) => [key, [...files].sort()] as [string, string[]]),
  );
}

/** `const NAME = true|false` compile-time policy definitions (as const / satisfies transparent). */
export function collectConstFlags(tree: SourceTree): ConstDefinition[] {
  const consts: ConstDefinition[] = [];
  for (const path of tree.filesContaining('_ENABLED')) {
    const ast = tree.ast(path);
    if (!ast) continue;
    walkAst(ast, (node) => {
      // Only `const` is a compile-time definition; `let`/`var`/assignment are mutable and
      // therefore fall through to UNREGISTERED instead of earning the const exemption.
      if (node.type !== 'VariableDeclaration' || node.kind !== 'const') return;
      for (const decl of node.declarations ?? []) {
        if (decl.type !== 'VariableDeclarator' || decl.id?.type !== 'Identifier') continue;
        if (!/_ENABLED$/.test(decl.id.name) || !decl.init) continue;
        const value = evaluateLiteral(decl.init);
        if (typeof value !== 'boolean') continue;
        consts.push({ name: decl.id.name, value, file: path });
      }
    });
  }
  return consts.sort((a, b) => a.name.localeCompare(b.name));
}

/** `process.env` expression (member or computed), optionally wrapped in an optional chain. */
function isProcessEnvObject(node: AstNode | undefined): boolean {
  if (!node) return false;
  const current = unwrapExpression(node);
  if (current.type !== 'MemberExpression' && current.type !== 'OptionalMemberExpression') {
    return false;
  }
  const object = unwrapExpression(current.object);
  if (object.type !== 'Identifier' || object.name !== 'process') return false;
  if (!current.computed && current.property?.type === 'Identifier') {
    return current.property.name === 'env';
  }
  if (current.computed && current.property?.type === 'StringLiteral') {
    return current.property.value === 'env';
  }
  return false;
}

/** One direct `process.env` read of a named key. */
export interface DirectEnvRead {
  key: string;
  file: string;
  form: 'member' | 'computed' | 'destructure';
}

/**
 * Direct env reads of a specific name: `process.env.KEY`, `process.env['KEY']`, and
 * `const { KEY } = process.env`. Deliberately NOT a general env-discovery scan: callers
 * only consult the names they already care about (registered or removed definitions).
 */
export function collectDirectEnvReads(tree: SourceTree): DirectEnvRead[] {
  const reads = new Map<string, DirectEnvRead>();
  const add = (key: string, file: string, form: DirectEnvRead['form']): void => {
    if (!key) return;
    const id = `${key}\0${file}`;
    if (!reads.has(id)) reads.set(id, { key, file, form });
  };

  for (const path of tree.filesContaining('process.env')) {
    const ast = tree.ast(path);
    if (!ast) continue;
    walkAst(ast, (node) => {
      if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
        if (!isProcessEnvObject(node.object)) return;
        if (!node.computed && node.property?.type === 'Identifier') {
          add(node.property.name, path, 'member');
        } else if (node.computed && node.property?.type === 'StringLiteral') {
          add(node.property.value, path, 'computed');
        }
        return;
      }
      if (node.type !== 'VariableDeclarator' || !isProcessEnvObject(node.init)) return;
      if (node.id?.type !== 'ObjectPattern') return;
      for (const prop of node.id.properties ?? []) {
        if (prop.type !== 'ObjectProperty' || prop.computed) continue;
        const key =
          prop.key.type === 'Identifier'
            ? prop.key.name
            : prop.key.type === 'StringLiteral'
              ? prop.key.value
              : undefined;
        if (key) add(key, path, 'destructure');
      }
    });
  }
  return [...reads.values()].sort(
    (a, b) => a.key.localeCompare(b.key) || a.file.localeCompare(b.file),
  );
}

/** Allowed homes for direct env reads of registered keys (definitions, not readers). */
function isAllowedDirectEnvFile(path: string): boolean {
  return path.startsWith('src/core/config/') || path === 'src/server/config/env.ts';
}

// ── definition fingerprints ─────────────────────────────────────────────────────────────────

function schemaKindOf(schema: z.ZodTypeAny): ControlKind {
  if (schema instanceof z.ZodBoolean) return 'flag';
  if (schema instanceof z.ZodEnum) return 'enum';
  if (schema instanceof z.ZodArray) return 'csv';
  if (schema instanceof z.ZodRecord || schema instanceof z.ZodObject) return 'json';
  if (schema instanceof z.ZodNumber || schema instanceof z.ZodString) return 'scalar';
  return 'other';
}

function isFamilyKind(kind: ControlKind, hasEnv: boolean): boolean {
  // locale.learner is a DB-only TaskSpec pin, not an operator control: it has no env layer.
  return kind === 'flag' || (hasEnv && (kind === 'enum' || kind === 'csv' || kind === 'json'));
}

function normalizeGrammar(grammar: FlagGrammarFingerprint): FlagGrammarFingerprint {
  return {
    trueLiterals: [...grammar.trueLiterals],
    falseLiterals: [...grammar.falseLiterals],
    caseInsensitive: grammar.caseInsensitive,
    polarity: grammar.polarity,
  };
}

export function headDefinitions(
  tree: SourceTree,
  readers = collectReaders(tree),
): HeadDefinition[] {
  const out: HeadDefinition[] = [];
  for (const [key, def] of Object.entries(CONFIG_REGISTRY) as [string, ConfigKeyDef][]) {
    const kind = schemaKindOf(def.schema);
    if (!isFamilyKind(kind, def.envName !== undefined)) continue;
    out.push({
      key,
      kind,
      codeDefault: def.codeDefault,
      envName: def.envName ?? null,
      envMode: def.envMode ?? 'fallback',
      tier: def.tier,
      flag: def.flag ? normalizeGrammar(def.flag) : null,
      enumValues:
        def.schema instanceof z.ZodEnum ? [...(def.schema.options as readonly string[])] : null,
      description: def.description ?? null,
      consumers: def.consumers ? [...def.consumers] : null,
      reload: def.reload ?? null,
      exposure: def.exposure ?? null,
      readers: readers.get(key) ?? [],
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

// ── base registry extraction (AST; same fields, no runtime import of base code) ─────────────

function objectProperty(node: AstNode | undefined, name: string): AstNode | undefined {
  if (node?.type !== 'ObjectExpression') return undefined;
  for (const prop of node.properties ?? []) {
    if (prop.type !== 'ObjectProperty' || prop.computed) continue;
    const key =
      prop.key.type === 'Identifier'
        ? prop.key.name
        : prop.key.type === 'StringLiteral'
          ? prop.key.value
          : undefined;
    if (key === name) return prop.value;
  }
  return undefined;
}

/** Top-level `const` initializers in one module, for same-file constant resolution. */
function constInitializers(ast: AstNode): Map<string, AstNode> {
  const map = new Map<string, AstNode>();
  walkAst(ast, (node) => {
    if (node.type !== 'VariableDeclaration' || node.kind !== 'const') return;
    for (const decl of node.declarations ?? []) {
      if (decl.type !== 'VariableDeclarator' || decl.id?.type !== 'Identifier' || !decl.init) {
        continue;
      }
      if (!map.has(decl.id.name)) map.set(decl.id.name, decl.init);
    }
  });
  return map;
}

/** Resolve literals through same-file const identifiers; UNKNOWN = not statically decidable. */
function resolveStatic(
  node: AstNode | undefined,
  consts: Map<string, AstNode>,
  depth = 0,
): unknown {
  if (!node || depth > 8) return UNKNOWN;
  const current = unwrapExpression(node);
  if (current.type === 'Identifier') {
    if (current.name === 'undefined') return undefined;
    const init = consts.get(current.name);
    return init ? resolveStatic(init, consts, depth + 1) : UNKNOWN;
  }
  if (current.type === 'ArrayExpression') {
    const values: unknown[] = [];
    for (const element of current.elements ?? []) {
      if (!element) return UNKNOWN;
      const value = resolveStatic(element, consts, depth + 1);
      if (value === UNKNOWN) return UNKNOWN;
      values.push(value);
    }
    return values;
  }
  if (current.type === 'ObjectExpression') {
    const value: Record<string, unknown> = {};
    for (const prop of current.properties ?? []) {
      if (prop.type !== 'ObjectProperty' || prop.computed) return UNKNOWN;
      const key =
        prop.key.type === 'Identifier'
          ? prop.key.name
          : prop.key.type === 'StringLiteral'
            ? prop.key.value
            : undefined;
      if (key === undefined) return UNKNOWN;
      const propValue = resolveStatic(prop.value, consts, depth + 1);
      if (propValue === UNKNOWN) return UNKNOWN;
      value[key] = propValue;
    }
    return value;
  }
  return evaluateLiteral(current);
}

function grammarFromAst(
  node: AstNode | undefined,
  consts: Map<string, AstNode>,
  depth = 0,
): FlagGrammarFingerprint | null | typeof UNKNOWN {
  if (!node || depth > 8) return null;
  const current = unwrapExpression(node);
  if (current.type === 'Identifier') {
    const init = consts.get(current.name);
    return init ? grammarFromAst(init, consts, depth + 1) : UNKNOWN;
  }
  if (current.type !== 'ObjectExpression') return UNKNOWN;
  const trueLiterals = stringArrayFromAst(objectProperty(current, 'trueLiterals'), consts);
  const falseLiterals = stringArrayFromAst(objectProperty(current, 'falseLiterals'), consts);
  const caseInsensitive = resolveStatic(objectProperty(current, 'caseInsensitive'), consts);
  const polarity = resolveStatic(objectProperty(current, 'polarity'), consts);
  if (
    !trueLiterals ||
    !falseLiterals ||
    typeof caseInsensitive !== 'boolean' ||
    (polarity !== 'opt-in' && polarity !== 'opt-out')
  ) {
    return UNKNOWN;
  }
  return { trueLiterals, falseLiterals, caseInsensitive, polarity };
}

function stringArrayFromAst(
  node: AstNode | undefined,
  consts: Map<string, AstNode>,
): string[] | undefined {
  const value = resolveStatic(node, consts);
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === 'string') ? (value as string[]) : undefined;
}

function schemaKindFromAst(node: AstNode | undefined): ControlKind {
  const schema = node ? unwrapExpression(node) : undefined;
  if (schema?.type !== 'CallExpression') return 'other';
  const callee = schema.callee;
  if (callee?.type !== 'MemberExpression') return 'other';
  // Chained builders (`.strict()`, `.refine(...)`, `.optional()`) wrap the real schema call.
  if (callee.object?.type !== 'Identifier') return schemaKindFromAst(callee.object);
  if (callee.object.name !== 'z' || callee.property?.type !== 'Identifier') return 'other';
  switch (callee.property.name) {
    case 'boolean':
      return 'flag';
    case 'enum':
      return 'enum';
    case 'array':
      return 'csv';
    case 'record':
    case 'object':
      return 'json';
    case 'number':
    case 'string':
      return 'scalar';
    default:
      return 'other';
  }
}

function enumValuesFromAst(
  node: AstNode | undefined,
  consts: Map<string, AstNode>,
): string[] | undefined {
  const schema = node ? unwrapExpression(node) : undefined;
  if (schema?.type !== 'CallExpression') return undefined;
  const first = schema.arguments?.[0];
  return stringArrayFromAst(first, consts);
}

/**
 * Extract CONFIG_REGISTRY fingerprints from source text. Used for BOTH base and head so the
 * comparison is apples-to-apples; same-file `const` identifiers (e.g. `flag: OPT_IN_FLAG`) are
 * resolved, and anything not statically decidable is reported instead of faked as drift.
 */
export function extractRegistryFingerprints(sourceText: string): FingerprintExtraction {
  const ast = parse(sourceText, {
    sourceType: 'module',
    plugins: ['typescript'],
    errorRecovery: true,
  }) as unknown as AstNode;
  const consts = constInitializers(ast);
  let registry: AstNode | undefined;
  walkAst(ast, (node) => {
    if (registry) return;
    if (node.type !== 'VariableDeclarator' || node.id?.type !== 'Identifier') return;
    if (node.id.name !== 'CONFIG_REGISTRY') return;
    const init = node.init ? unwrapExpression(node.init) : undefined;
    if (init?.type === 'ObjectExpression') registry = init;
  });
  const result = new Map<string, DefinitionFingerprint>();
  const problems: string[] = [];
  if (!registry) return { fingerprints: result, problems };

  for (const prop of registry.properties ?? []) {
    if (prop.type !== 'ObjectProperty' || prop.computed) continue;
    const key =
      prop.key.type === 'Identifier'
        ? prop.key.name
        : prop.key.type === 'StringLiteral'
          ? prop.key.value
          : undefined;
    if (key === undefined) continue;
    const node = prop.value;
    const schemaNode = objectProperty(node, 'schema');
    const kind = schemaKindFromAst(schemaNode);

    const envNameNode = objectProperty(node, 'envName');
    const envNameValue = resolveStatic(envNameNode, consts);
    if (envNameNode && envNameValue === UNKNOWN) {
      problems.push(`${key}: envName is not statically decidable`);
    }
    const envName = typeof envNameValue === 'string' ? envNameValue : null;
    if (!isFamilyKind(kind, envName !== null)) continue;

    const flagNode = objectProperty(node, 'flag');
    const grammar = grammarFromAst(flagNode, consts);
    if (grammar === UNKNOWN) {
      problems.push(
        `${key}: flag grammar is not statically resolvable (use a literal object or a same-file const)`,
      );
    }

    const codeDefaultValue = resolveStatic(objectProperty(node, 'codeDefault'), consts);
    const envModeValue = resolveStatic(objectProperty(node, 'envMode'), consts);
    const tierValue = resolveStatic(objectProperty(node, 'tier'), consts);
    if (objectProperty(node, 'envMode') && envModeValue === UNKNOWN) {
      problems.push(`${key}: envMode is not statically decidable`);
    }
    if (objectProperty(node, 'tier') && tierValue === UNKNOWN) {
      problems.push(`${key}: tier is not statically decidable`);
    }

    const enumValues = kind === 'enum' ? enumValuesFromAst(schemaNode, consts) : null;
    if (kind === 'enum' && !enumValues) {
      problems.push(`${key}: enum values are not statically resolvable`);
    }

    result.set(key, {
      key,
      kind,
      codeDefault: codeDefaultValue === UNKNOWN ? undefined : codeDefaultValue,
      codeDefaultUnresolved: codeDefaultValue === UNKNOWN,
      envName,
      envMode: typeof envModeValue === 'string' ? envModeValue : 'fallback',
      tier: typeof tierValue === 'string' ? tierValue : 'A',
      flag: grammar === UNKNOWN ? null : grammar,
      flagUnresolved: grammar === UNKNOWN,
      enumValues,
    });
  }
  return { fingerprints: result, problems };
}

// ── validation ──────────────────────────────────────────────────────────────────────────────

function expectedFromGrammar(grammar: FlagGrammarFingerprint, raw: string): boolean | undefined {
  const normalized = grammar.caseInsensitive ? raw.trim().toLowerCase() : raw;
  if (grammar.trueLiterals.includes(normalized)) return true;
  if (grammar.falseLiterals.includes(normalized)) return false;
  return undefined;
}

function grammarProblems(def: ConfigKeyDef, key: string): string[] {
  const problems: string[] = [];
  const grammar = def.flag;
  if (!grammar) return [`${key}: boolean flag has no flag grammar metadata`];
  if (def.envName !== key) {
    problems.push(`${key}: envName must equal the registered key (got ${def.envName ?? 'none'})`);
  }
  if (typeof def.codeDefault !== 'boolean') {
    problems.push(`${key}: boolean flag needs a boolean codeDefault`);
  } else {
    const polarity = def.codeDefault ? 'opt-out' : 'opt-in';
    if (grammar.polarity !== polarity) {
      problems.push(
        `${key}: polarity '${grammar.polarity}' contradicts codeDefault ${String(def.codeDefault)} (expected '${polarity}')`,
      );
    }
  }
  if (grammar.trueLiterals.length === 0) problems.push(`${key}: trueLiterals must not be empty`);
  if (typeof def.envParse !== 'function') {
    problems.push(`${key}: boolean flag needs envParse (raw env string cannot become a boolean)`);
    return problems;
  }
  for (const raw of GRAMMAR_PROBES) {
    const expected = expectedFromGrammar(grammar, raw);
    const actual = def.envParse(raw);
    if (!Object.is(actual, expected)) {
      problems.push(
        `${key}: envParse(${JSON.stringify(raw)}) = ${JSON.stringify(actual)} but declared grammar yields ${JSON.stringify(expected)}`,
      );
      break;
    }
  }
  return problems;
}

function metadataProblems(def: ConfigKeyDef, key: string): string[] {
  const problems: string[] = [];
  for (const field of METADATA_FIELDS) {
    const value = def[field];
    if (value === undefined || value === null) {
      problems.push(`${key}: missing ${field}`);
    } else if (field === 'consumers') {
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        !value.every((item) => typeof item === 'string' && item.trim() !== '')
      ) {
        problems.push(`${key}: consumers must be a non-empty string[]`);
      }
    } else if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`${key}: ${field} must be a non-empty string`);
    }
  }
  return problems;
}

function controlProblems(def: ConfigKeyDef, key: string, kind: ControlKind): string[] {
  if (kind === 'enum') {
    const options = def.schema instanceof z.ZodEnum ? def.schema.options : undefined;
    if (!options || options.length === 0) return [`${key}: enum control has no options`];
  }
  return [];
}

function sameGrammar(a: FlagGrammarFingerprint | null, b: FlagGrammarFingerprint | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameEnum(a: string[] | null, b: string[] | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Base/head contract drift. Default values and reader sets are reported, never failed. */
function compareWithBase(
  base: Map<string, DefinitionFingerprint>,
  head: Map<string, DefinitionFingerprint>,
  headDefs: Map<string, HeadDefinition>,
  baseReaders: Map<string, string[]>,
  baseConsts: ConstDefinition[],
  headConsts: ConstDefinition[],
): { violations: FlagViolation[]; diff: DiffEntry[] } {
  const violations: FlagViolation[] = [];
  const diff: DiffEntry[] = [];

  for (const [key, baseDef] of base) {
    const headDef = head.get(key);
    if (!headDef) {
      diff.push({ name: key, field: 'removed', base: baseDef.kind, head: null });
      continue;
    }
    if (baseDef.envName !== headDef.envName) {
      violations.push({
        code: 'BASE-DRIFT',
        name: key,
        detail: `envName changed: base ${JSON.stringify(baseDef.envName)} → head ${JSON.stringify(headDef.envName)}`,
      });
    }
    if (baseDef.envMode !== headDef.envMode) {
      violations.push({
        code: 'BASE-DRIFT',
        name: key,
        detail: `envMode changed: base '${baseDef.envMode}' → head '${headDef.envMode}'`,
      });
    }
    if (baseDef.kind !== headDef.kind) {
      violations.push({
        code: 'BASE-DRIFT',
        name: key,
        detail: `control kind changed: base '${baseDef.kind}' → head '${headDef.kind}'`,
      });
    }
    if (baseDef.flag === null && headDef.flag !== null) {
      diff.push({ name: key, field: 'flag-metadata', base: null, head: headDef.flag });
    } else if (baseDef.flag !== null && headDef.flag === null) {
      // A head extraction problem is already reported; do not fake a grammar change.
      if (!headDef.flagUnresolved) {
        violations.push({
          code: 'BASE-DRIFT',
          name: key,
          detail: 'flag grammar metadata was removed at head',
        });
      }
    } else if (!sameGrammar(baseDef.flag, headDef.flag)) {
      violations.push({
        code: 'BASE-DRIFT',
        name: key,
        detail: `flag grammar changed: base ${JSON.stringify(baseDef.flag)} → head ${JSON.stringify(headDef.flag)}`,
      });
    }
    if (
      baseDef.enumValues !== undefined &&
      headDef.enumValues !== undefined &&
      !sameEnum(baseDef.enumValues, headDef.enumValues)
    ) {
      violations.push({
        code: 'BASE-DRIFT',
        name: key,
        detail: `enum values changed: base ${JSON.stringify(baseDef.enumValues)} → head ${JSON.stringify(headDef.enumValues)}`,
      });
    }
    const before = (baseReaders.get(key) ?? []).join(',');
    const after = (headDefs.get(key)?.readers ?? []).join(',');
    if (before !== after) {
      diff.push({ name: key, field: 'readers', base: before, head: after });
    }
    if (baseDef.codeDefaultUnresolved || headDef.codeDefaultUnresolved) {
      // Not statically comparable; report once instead of fabricating a value change.
      diff.push({
        name: key,
        field: 'codeDefault-unresolved',
        base: baseDef.codeDefaultUnresolved ? 'unresolved' : baseDef.codeDefault,
        head: headDef.codeDefaultUnresolved ? 'unresolved' : headDef.codeDefault,
      });
    } else if (JSON.stringify(baseDef.codeDefault) !== JSON.stringify(headDef.codeDefault)) {
      diff.push({
        name: key,
        field: 'codeDefault',
        base: baseDef.codeDefault ?? null,
        head: headDef.codeDefault ?? null,
      });
    }
  }

  for (const [key, headDef] of head) {
    if (!base.has(key)) {
      diff.push({ name: key, field: 'added', base: null, head: headDef.kind });
    }
  }

  const baseConstByName = new Map(baseConsts.map((entry) => [entry.name, entry]));
  const headConstByName = new Map(headConsts.map((entry) => [entry.name, entry]));
  for (const [name, baseConst] of baseConstByName) {
    const headConst = headConstByName.get(name);
    if (!headConst) {
      diff.push({ name, field: 'const-removed', base: baseConst.value, head: null });
    } else if (baseConst.value !== headConst.value) {
      diff.push({ name, field: 'const-value', base: baseConst.value, head: headConst.value });
    }
  }
  for (const name of headConstByName.keys()) {
    if (!baseConstByName.has(name)) {
      diff.push({ name, field: 'const-added', base: null, head: headConstByName.get(name)?.value });
    }
  }

  return { violations, diff };
}

/** The AST extractor must see exactly what the runtime registry sees at head. */
function crossCheckHead(
  runtime: HeadDefinition[],
  extraction: FingerprintExtraction,
): FlagViolation[] {
  const violations: FlagViolation[] = [];
  for (const def of runtime) {
    const ast = extraction.fingerprints.get(def.key);
    if (!ast) {
      violations.push({
        code: 'DEFINITION-PROBLEM',
        name: def.key,
        detail: 'AST extractor cannot see this CONFIG_REGISTRY entry',
      });
      continue;
    }
    if (ast.kind !== def.kind) {
      violations.push({
        code: 'DEFINITION-PROBLEM',
        name: def.key,
        detail: `runtime schema kind '${def.kind}' but AST extraction says '${ast.kind}'`,
      });
    }
    if (ast.envName !== def.envName) {
      violations.push({
        code: 'DEFINITION-PROBLEM',
        name: def.key,
        detail: `runtime envName ${JSON.stringify(def.envName)} but AST extraction says ${JSON.stringify(ast.envName)}`,
      });
    }
    if (def.flag && ast.flag) {
      const runtimeGrammar = normalizeGrammar(def.flag);
      if (!sameGrammar(runtimeGrammar, ast.flag)) {
        violations.push({
          code: 'DEFINITION-PROBLEM',
          name: def.key,
          detail: `runtime flag grammar ${JSON.stringify(runtimeGrammar)} but AST extraction says ${JSON.stringify(ast.flag)}`,
        });
      }
    }
    if (def.enumValues && ast.enumValues && !sameEnum(def.enumValues, ast.enumValues)) {
      violations.push({
        code: 'DEFINITION-PROBLEM',
        name: def.key,
        detail: `runtime enum values ${JSON.stringify(def.enumValues)} but AST extraction says ${JSON.stringify(ast.enumValues)}`,
      });
    }
  }
  return violations;
}

export function auditFlags(comparisonBase?: string): FlagAuditResult {
  const headTree = SourceTree.head();
  const readers = collectReaders(headTree);
  const definitions = headDefinitions(headTree, readers);
  const consts = collectConstFlags(headTree);
  const foundTokens = [...scanFlagTokens(headTree)].sort();

  const violations: FlagViolation[] = [];
  const registered = new Map(definitions.map((def) => [def.key, def]));
  const constByName = new Map<string, ConstDefinition[]>();
  for (const entry of consts) {
    const list = constByName.get(entry.name) ?? [];
    list.push(entry);
    constByName.set(entry.name, list);
  }

  // 1) Every live *_ENABLED token must be a registry flag or a boolean const.
  for (const token of foundTokens) {
    if (registered.has(token)) continue;
    if (constByName.has(token)) continue;
    violations.push({
      code: 'UNREGISTERED',
      name: token,
      detail:
        'live *_ENABLED token with no CONFIG_REGISTRY definition and no `const NAME = true|false`; register the definition (or delete the dead reference)',
    });
  }

  // 2) Constants are single, boolean, and never shadow a registry key.
  for (const [name, entries] of constByName) {
    if (entries.length > 1) {
      violations.push({
        code: 'CONST-PROBLEM',
        name,
        detail: `boolean const declared ${entries.length} times: ${entries.map((entry) => entry.file).join(', ')}`,
      });
    }
    if (registered.has(name)) {
      violations.push({
        code: 'CONST-PROBLEM',
        name,
        detail: 'compile-time const shadows a CONFIG_REGISTRY key (two definitions for one flag)',
      });
    }
  }

  // 3) Every registry definition is complete, parser-accurate, and has a live central reader.
  for (const [key, def] of Object.entries(CONFIG_REGISTRY) as [string, ConfigKeyDef][]) {
    const kind = schemaKindOf(def.schema);
    if (!isFamilyKind(kind, def.envName !== undefined)) continue;
    for (const problem of metadataProblems(def, key)) {
      violations.push({ code: 'DEFINITION-PROBLEM', name: key, detail: problem });
    }
    if (kind === 'flag') {
      for (const problem of grammarProblems(def, key)) {
        violations.push({ code: 'DEFINITION-PROBLEM', name: key, detail: problem });
      }
    } else {
      for (const problem of controlProblems(def, key, kind)) {
        violations.push({ code: 'DEFINITION-PROBLEM', name: key, detail: problem });
      }
    }
    if ((readers.get(key) ?? []).length === 0) {
      violations.push({
        code: 'NO-READER',
        name: key,
        detail: 'no live getConfig/getConfigFlag/getConfigMany call resolves this key',
      });
    }
  }

  // 4) Base/head contract diff, orphaned consumers, and direct-env bypass detection.
  const baseSha = resolveAuditBaseSha(REPO_ROOT, comparisonBase);
  const baseTree = SourceTree.atRef(baseSha);
  const baseRegistryText = baseTree.text(REGISTRY_PATH);
  const headRegistryText = headTree.text(REGISTRY_PATH);
  const diff: DiffEntry[] = [];
  if (baseRegistryText === undefined) {
    violations.push({
      code: 'BASE-PROBLEM',
      name: REGISTRY_PATH,
      detail: `registry file missing at comparison base ${baseSha}`,
    });
    return {
      ok: false,
      base: baseSha,
      definitions,
      consts,
      foundTokens,
      violations,
      diff,
      variance: computeVariance(definitions),
    };
  }

  const headExtraction = headRegistryText
    ? extractRegistryFingerprints(headRegistryText)
    : { fingerprints: new Map<string, DefinitionFingerprint>(), problems: ['registry missing'] };
  for (const problem of headExtraction.problems) {
    violations.push({ code: 'DEFINITION-PROBLEM', name: REGISTRY_PATH, detail: problem });
  }
  violations.push(...crossCheckHead(definitions, headExtraction));

  const baseExtraction = extractRegistryFingerprints(baseRegistryText);
  for (const problem of baseExtraction.problems) {
    violations.push({ code: 'BASE-PROBLEM', name: REGISTRY_PATH, detail: problem });
  }
  if (baseExtraction.fingerprints.size === 0) {
    violations.push({
      code: 'BASE-PROBLEM',
      name: REGISTRY_PATH,
      detail: `could not extract CONFIG_REGISTRY at comparison base ${baseSha}`,
    });
    return {
      ok: false,
      base: baseSha,
      definitions,
      consts,
      foundTokens,
      violations,
      diff,
      variance: computeVariance(definitions),
    };
  }

  const baseReaders = collectReaders(baseTree);
  const compared = compareWithBase(
    baseExtraction.fingerprints,
    headExtraction.fingerprints,
    new Map(definitions.map((def) => [def.key, def])),
    baseReaders,
    collectConstFlags(baseTree),
    consts,
  );
  violations.push(...compared.violations);
  diff.push(...compared.diff);

  const headReads = collectDirectEnvReads(headTree);
  const baseReadIds = new Set(
    collectDirectEnvReads(baseTree).map((read) => `${read.key}\u0000${read.file}`),
  );

  // (a) A definition removed at head must not leave direct env reads behind.
  for (const key of baseExtraction.fingerprints.keys()) {
    if (registered.has(key)) continue;
    const orphanReads = headReads.filter((read) => read.key === key);
    if (orphanReads.length > 0) {
      const files = [...new Set(orphanReads.map((read) => read.file))].sort();
      violations.push({
        code: 'ORPHAN-ENV-READ',
        name: key,
        detail: `definition removed at head but still read directly from ${files.join(', ')}`,
      });
    }
    const headFiles = readers.get(key) ?? [];
    if (headFiles.length > 0) {
      violations.push({
        code: 'ORPHAN-READER',
        name: key,
        detail: `definition removed at head but still read from ${headFiles.join(', ')}`,
      });
    }
  }

  // (b) A registered key read directly from process.env bypasses DB/env/default resolution.
  //     Only new (key, file) pairs relative to base fail; existing reads are grandfathered.
  for (const read of headReads) {
    if (!registered.has(read.key)) continue;
    if (isAllowedDirectEnvFile(read.file)) continue;
    if (baseReadIds.has(`${read.key}\u0000${read.file}`)) continue;
    violations.push({
      code: 'DIRECT-ENV-READ',
      name: read.key,
      detail: `registered key read directly from process.env in ${read.file} (${read.form}); use getConfig/getConfigFlag/getConfigMany`,
    });
  }

  return {
    ok: violations.length === 0,
    base: baseSha,
    definitions,
    consts,
    foundTokens,
    violations,
    diff,
    variance: computeVariance(definitions),
  };
}

function computeVariance(definitions: HeadDefinition[]): { signature: string; flags: string[] }[] {
  const bySignature = new Map<string, string[]>();
  for (const def of definitions) {
    if (def.kind !== 'flag' || !def.flag) continue;
    const literals = [...def.flag.trueLiterals]
      .sort()
      .map((literal) => `'${literal}'`)
      .join('|');
    const signature = `true=${literals} false='${[...def.flag.falseLiterals].sort().join("'|'")}' match=${def.flag.caseInsensitive ? 'ci' : 'cs'}`;
    const list = bySignature.get(signature) ?? [];
    list.push(def.key);
    bySignature.set(signature, list);
  }
  return [...bySignature.entries()]
    .map(([signature, flags]) => ({ signature, flags: flags.sort() }))
    .sort((a, b) => a.signature.localeCompare(b.signature));
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

function baseFlag(): string | undefined {
  const index = process.argv.indexOf('--base');
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value) throw new Error('--base requires a commit SHA.');
  return value;
}

function printViolations(violations: FlagViolation[]): void {
  const groups = new Map<ViolationCode, FlagViolation[]>();
  for (const violation of violations) {
    const list = groups.get(violation.code) ?? [];
    list.push(violation);
    groups.set(violation.code, list);
  }
  for (const code of [
    'UNREGISTERED',
    'DEFINITION-PROBLEM',
    'NO-READER',
    'ORPHAN-READER',
    'ORPHAN-ENV-READ',
    'DIRECT-ENV-READ',
    'CONST-PROBLEM',
    'BASE-PROBLEM',
    'BASE-DRIFT',
  ] satisfies ViolationCode[]) {
    const list = groups.get(code);
    if (!list || list.length === 0) continue;
    console.log(`  ${code}: ${list.length}`);
    for (const violation of list) console.log(`    - ${violation.name}: ${violation.detail}`);
    console.log('');
  }
}

function main(): void {
  const isJson = process.argv.includes('--json');
  const isStrict = process.argv.includes('--strict');

  const requested = baseFlag() ?? process.env.CAPABILITY_BASE_SHA;
  const base = process.env.TEST_POLICY_BASE || resolveAuditBaseSha(REPO_ROOT, requested);
  const result = auditFlags(base);

  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const flags = result.definitions.filter((def) => def.kind === 'flag').length;
    const controls = result.definitions.length - flags;
    console.log('audit:flags — flag 定义、reader 与 base/head 契约门\n');
    console.log(
      `  definitions: ${result.definitions.length} family keys (flag×${flags}, control×${controls}); const×${result.consts.length}; live *_ENABLED tokens: ${result.foundTokens.length}.`,
    );
    console.log(`  base: ${result.base ?? '(missing)'}\n`);

    printViolations(result.violations);

    const shippedDiff = result.diff.filter(
      (entry) => entry.field !== 'const-value' && entry.field !== 'codeDefault',
    );
    const defaultDiff = result.diff.filter(
      (entry) => entry.field === 'const-value' || entry.field === 'codeDefault',
    );
    console.log(
      `  BASE/HEAD 定义变化: ${shippedDiff.length === 0 ? '(none)' : shippedDiff.length}`,
    );
    for (const entry of shippedDiff) {
      console.log(
        `    - ${entry.name} ${entry.field}: ${JSON.stringify(entry.base)} → ${JSON.stringify(entry.head)}`,
      );
    }
    if (defaultDiff.length > 0) {
      console.log(`  BASE/HEAD 默认值变化（informational，review 负责）: ${defaultDiff.length}`);
      for (const entry of defaultDiff) {
        console.log(
          `    - ${entry.name} ${entry.field}: ${JSON.stringify(entry.base)} → ${JSON.stringify(entry.head)}`,
        );
      }
    }
    console.log('');

    console.log(
      `  LITERAL-VARIANCE — env flag 字面量约定（report-only, ${result.variance.length} 种）:`,
    );
    for (const group of result.variance) {
      console.log(`    · ${group.signature}`);
      for (const key of group.flags) console.log(`        ${key}`);
    }
    console.log('');
    console.log(
      '  定义在 src/core/config/registry.ts；const 由领域源码自己的 boolean 声明登记。' +
        ' 直接 env 读只对已登记 key 与 base 删除的 key 检查，不做全仓未登记 env 普查。' +
        ' report-only (exit 0); --strict gates UNREGISTERED / DEFINITION-PROBLEM / NO-READER / ORPHAN-* / DIRECT-ENV-READ / CONST-PROBLEM / BASE-DRIFT.',
    );
  }

  if (!result.ok) {
    const baseBroken = result.violations.some((violation) => violation.code === 'BASE-PROBLEM');
    // An unmeasurable base fails closed in every mode; other findings need --strict.
    if (isStrict || baseBroken) process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[audit:flags] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
