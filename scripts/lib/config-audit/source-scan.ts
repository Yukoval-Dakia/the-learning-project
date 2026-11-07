/**
 * audit:flags 的扫描与 git 读取面（head 与 base 一个可比形状）。
 *
 * SCAN_ROOTS 的源码、git ref 的 blob、AST 解析、flag token / reader / const /
 * direct-env 扫描，以及 CONFIG_REGISTRY 的 head 定义投影都在这里；纯指纹
 * 与对比在 ./contract-compare，report/exit 留在 scripts/audit-flags.ts。
 */
import { type Dirent, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import { z } from 'zod';
import { CONFIG_REGISTRY, type ConfigKeyDef } from '../../../src/core/config/registry';
import { listTreeFiles, readBlobs } from '../git-base-scan';
import {
  type AstNode,
  type ConstDefinition,
  type HeadDefinition,
  evaluateLiteral,
  isFamilyKind,
  normalizeGrammar,
  schemaKindOf,
  unwrapExpression,
  walkAst,
} from './contract-compare';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const REGISTRY_PATH = 'src/core/config/registry.ts';

const SCAN_ROOTS = ['src', 'server', 'scripts'] as const;
const EXCLUDE_DIRS = new Set(['node_modules', '.next', 'dist', '.git', '.claude', 'drizzle']);
// The audit's own modules name flags in doc examples and violation text; they are
// the only excluded files (a split of the same content keeps the same boundary).
const EXCLUDE_FILES = new Set([
  'scripts/audit-flags.ts',
  'scripts/audit-flags.test.ts',
  'scripts/lib/config-audit/source-scan.ts',
  'scripts/lib/config-audit/contract-compare.ts',
]);

// Whole-token match; the trailing guard keeps DEFAULT_ENABLED out of DEFAULT_ENABLED_BY_KIND.
export const FLAG_TOKEN_RE = /(?<![A-Z0-9_])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_ENABLED(?![A-Z0-9_])/g;

const READER_FNS = new Set(['getConfig', 'getConfigFlag', 'getConfigMany']);

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

interface Binding {
  init: AstNode;
  file: string;
}

interface ImportBinding {
  source: string;
  imported: string;
}

export class SourceTree {
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
export function isAllowedDirectEnvFile(path: string): boolean {
  return path.startsWith('src/core/config/');
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
