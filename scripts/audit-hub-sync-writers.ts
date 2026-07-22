/**
 * YUK-384 — static hub-sync writer ownership audit.
 *
 * PostgreSQL topology triggers (drizzle/0071) own hub-sync correctness: every
 * write to `knowledge` / `knowledge_edge` dirties the affected hubs via fan-out.
 * That is only safe if the FULL set of topology writers is INVENTORIED, so this
 * lexical/static audit enforces four ownership rules:
 *
 *   UNINVENTORIED_TOPOLOGY_WRITER — a knowledge/knowledge_edge write in a path
 *     that is not in the allowlist (each allowlisted writer is justified by the
 *     trigger fan-out that covers it).
 *   RECONCILIATION_OWNER_BYPASS  — a write to `hub_sync_reconciliation` outside
 *     the sole owner `src/capabilities/notes/server/hub-sync-reconciliation.ts`.
 *   INTERNAL_APPLY_MARKER_BYPASS — setting `app.hub_sync_internal_apply` outside
 *     that same owner.
 *   DIRECT_HUB_ACTOR_APPLY       — a `persistNoteRefineApply` call with
 *     `actorRef: 'hub_auto_sync'` anywhere (the reconciler owns hub apply; there
 *     is NO escape hatch).
 *
 * Usage:
 *   pnpm audit:hub-sync-writers          # exit 0 clean, exit 1 with findings
 *   pnpm audit:hub-sync-writers --json   # JSON findings
 *
 * Scans tracked `.ts` / `.tsx` under `src/` and `scripts/` (test files and this
 * audit's own source — which necessarily carries rule marker strings — excluded).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const ALLOWLIST_PATH = resolve(__dirname, 'audit-hub-sync-writers-allowlist.json');

// Sole owner of the reconciliation cursor + the internal-apply marker.
const RECONCILER_PATH = 'src/capabilities/notes/server/hub-sync-reconciliation.ts';
const TOPOLOGY_TABLES = ['knowledge', 'knowledge_edge'] as const;
const SCAN_DIRS = ['src', 'scripts'];

export type HubSyncAuditRule =
  | 'UNINVENTORIED_TOPOLOGY_WRITER'
  | 'RECONCILIATION_OWNER_BYPASS'
  | 'INTERNAL_APPLY_MARKER_BYPASS'
  | 'DIRECT_HUB_ACTOR_APPLY';

export interface HubSyncAuditFinding {
  rule: HubSyncAuditRule;
  file: string;
  line: number;
  excerpt: string;
}

export interface AllowlistEntry {
  path: string;
  tables: string[];
  reason: string;
}

function normalizePath(p: string): string {
  return p.split('\\').join('/');
}

function codeText(source: string): string {
  const out: string[] = Array.from({ length: source.length }, (_, index) =>
    source[index] === '\n' ? '\n' : ' ',
  );
  const structural: string[] = [...out];

  const copy = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) out[index] = source[index];
  };
  const copyStructural = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) structural[index] = source[index];
  };
  const previousWord = (index: number): string => {
    let cursor = index - 1;
    while (/\s/.test(structural[cursor] ?? '')) cursor -= 1;
    const end = cursor + 1;
    while (/[\w$]/.test(structural[cursor] ?? '')) cursor -= 1;
    return structural.slice(cursor + 1, end).join('');
  };
  const previousSignificantIndex = (index: number): number => {
    let cursor = index - 1;
    while (/\s/.test(structural[cursor] ?? '')) cursor -= 1;
    return cursor;
  };
  const isSqlRawArgument = (index: number): boolean => {
    let cursor = previousSignificantIndex(index);
    if (structural[cursor] !== '(') return false;
    cursor = previousSignificantIndex(cursor);
    const rawEnd = cursor + 1;
    while (/[\w$]/.test(structural[cursor] ?? '')) cursor -= 1;
    if (structural.slice(cursor + 1, rawEnd).join('') !== 'raw') return false;
    cursor = previousSignificantIndex(cursor + 1);
    if (structural[cursor] !== '.') return false;
    return previousWord(cursor) === 'sql';
  };
  const isActorRefValue = (index: number): boolean => {
    let cursor = previousSignificantIndex(index);
    if (structural[cursor] !== ':') return false;
    cursor = previousSignificantIndex(cursor);
    if (structural[cursor] === '"' || structural[cursor] === "'") cursor -= 1;
    const end = cursor + 1;
    while (/[\w$]/.test(structural[cursor] ?? '')) cursor -= 1;
    return structural.slice(cursor + 1, end).join('') === 'actorRef';
  };
  const followsControlCondition = (index: number): boolean => {
    let cursor = previousSignificantIndex(index);
    if (structural[cursor] !== ')') return false;

    let depth = 1;
    cursor -= 1;
    while (cursor >= 0 && depth > 0) {
      if (structural[cursor] === ')') depth += 1;
      else if (structural[cursor] === '(') depth -= 1;
      cursor -= 1;
    }
    return depth === 0 && ['if', 'while', 'for', 'with'].includes(previousWord(cursor + 1));
  };
  const startsRegex = (index: number): boolean => {
    const cursor = previousSignificantIndex(index);
    if (cursor < 0 || followsControlCondition(index)) return true;
    if (/[([{=,:;!&|?+*%^~<>-]/.test(structural[cursor])) return true;
    return [
      'return',
      'throw',
      'case',
      'delete',
      'void',
      'typeof',
      'instanceof',
      'in',
      'of',
      'yield',
      'await',
    ].includes(previousWord(index));
  };

  const scanCode = (start: number, stopAtBrace: boolean): number => {
    let index = start;
    let braces = 0;
    while (index < source.length) {
      const char = source[index];
      const next = source[index + 1];

      if (stopAtBrace && char === '}' && braces === 0) return index + 1;
      if (char === '{') braces += 1;
      else if (char === '}' && braces > 0) braces -= 1;

      if (char === '/' && next === '/') {
        const end = source.indexOf('\n', index + 2);
        index = end === -1 ? source.length : end;
        continue;
      }
      if (char === '/' && next === '*') {
        const end = source.indexOf('*/', index + 2);
        index = end === -1 ? source.length : end + 2;
        continue;
      }
      if (char === '/' && startsRegex(index)) {
        let cursor = index + 1;
        let escaped = false;
        let inClass = false;
        while (cursor < source.length) {
          const current = source[cursor];
          if (!escaped && current === '[') inClass = true;
          else if (!escaped && current === ']') inClass = false;
          else if (!escaped && current === '/' && !inClass) {
            cursor += 1;
            while (/[a-z]/i.test(source[cursor] ?? '')) cursor += 1;
            break;
          }
          escaped = !escaped && current === '\\';
          cursor += 1;
        }
        index = cursor;
        continue;
      }
      if (char === "'" || char === '"') {
        const quote = char;
        const literalStart = index;
        let cursor = index + 1;
        let escaped = false;
        while (cursor < source.length) {
          const current = source[cursor];
          if (!escaped && current === quote) {
            cursor += 1;
            break;
          }
          escaped = !escaped && current === '\\';
          cursor += 1;
        }
        const actorRefValue = isActorRefValue(literalStart);
        const literalText = source.slice(literalStart + 1, cursor - 1);
        let afterLiteral = cursor;
        while (/\s/.test(source[afterLiteral] ?? '')) afterLiteral += 1;
        const actorRefKey = literalText === 'actorRef' && source[afterLiteral] === ':';
        if (actorRefValue || isSqlRawArgument(literalStart) || actorRefKey) {
          copy(literalStart, cursor);
        }
        if (actorRefValue || actorRefKey) copyStructural(literalStart, cursor);
        index = cursor;
        continue;
      }
      if (char === '`') {
        const sqlTemplate = previousWord(index) === 'sql' || isSqlRawArgument(index);
        let cursor = index + 1;
        if (sqlTemplate) copy(index, index + 1);
        while (cursor < source.length) {
          if (source[cursor] === '\\') {
            if (sqlTemplate) copy(cursor, Math.min(cursor + 2, source.length));
            cursor += 2;
            continue;
          }
          if (source[cursor] === '`') {
            if (sqlTemplate) copy(cursor, cursor + 1);
            cursor += 1;
            break;
          }
          if (source[cursor] === '$' && source[cursor + 1] === '{') {
            copy(cursor, cursor + 2);
            cursor = scanCode(cursor + 2, true);
            copy(cursor - 1, cursor);
            continue;
          }
          if (sqlTemplate) copy(cursor, cursor + 1);
          cursor += 1;
        }
        index = cursor;
        continue;
      }

      structural[index] = char;
      out[index] = char;
      index += 1;
    }
    return index;
  };

  scanCode(0, false);
  return out.join('');
}

type AstNode = {
  type: string;
  start?: number | null;
  [key: string]: unknown;
};

type Binding = { trusted: boolean };
type Scope = {
  parent?: Scope;
  bindings: Map<string, Binding>;
  types: Map<string, AstNode>;
  trustedTypes: Set<string>;
  functionScope: Scope;
};

type DrizzleWrite = { index: number; table: string };

const DB_MODULE_ALIAS = '@/db/client';
const DB_TYPE_EXPORTS = new Set(['Db', 'Tx']);

function node(value: unknown): AstNode | undefined {
  return value && typeof value === 'object' && 'type' in value ? (value as AstNode) : undefined;
}

function childNodes(value: unknown): AstNode[] {
  if (Array.isArray(value)) return value.flatMap(childNodes);
  const candidate = node(value);
  return candidate ? [candidate] : [];
}

function identifierName(value: unknown): string | undefined {
  const candidate = node(value);
  return candidate?.type === 'Identifier' ? (candidate.name as string) : undefined;
}

function declarePattern(pattern: unknown, scope: Scope): void {
  const candidate = node(pattern);
  if (!candidate) return;
  if (candidate.type === 'Identifier') {
    scope.bindings.set(candidate.name as string, { trusted: false });
    return;
  }
  if (candidate.type === 'RestElement') {
    declarePattern(candidate.argument, scope);
    return;
  }
  if (candidate.type === 'AssignmentPattern') {
    declarePattern(candidate.left, scope);
    return;
  }
  if (candidate.type === 'ObjectPattern') {
    for (const property of childNodes(candidate.properties)) {
      declarePattern(property.type === 'RestElement' ? property.argument : property.value, scope);
    }
    return;
  }
  if (candidate.type === 'ArrayPattern') {
    for (const element of childNodes(candidate.elements)) declarePattern(element, scope);
  }
}

function bindingFor(name: string, scope: Scope): Binding | undefined {
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    const binding = current.bindings.get(name);
    if (binding) return binding;
  }
  return undefined;
}

function trustedBinding(expression: unknown, scope: Scope): boolean {
  let candidate = node(expression);
  while (
    candidate &&
    [
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSNonNullExpression',
      'TypeCastExpression',
    ].includes(candidate.type)
  ) {
    candidate = node(candidate.expression);
  }
  const name = identifierName(candidate);
  return name ? bindingFor(name, scope)?.trusted === true : false;
}

function trustedType(typeNode: unknown, scope: Scope, seen = new Set<string>()): boolean {
  const candidate = node(typeNode);
  if (!candidate) return false;
  if (candidate.type === 'TSTypeAnnotation')
    return trustedType(candidate.typeAnnotation, scope, seen);
  if (candidate.type === 'TSParenthesizedType' || candidate.type === 'TSOptionalType') {
    return trustedType(candidate.typeAnnotation, scope, seen);
  }
  if (candidate.type === 'TSUnionType' || candidate.type === 'TSIntersectionType') {
    return childNodes(candidate.types).some((part) => trustedType(part, scope, seen));
  }
  if (candidate.type === 'TSTypeQuery') return trustedBinding(candidate.exprName, scope);
  if (candidate.type !== 'TSTypeReference') return false;
  const name = identifierName(candidate.typeName);
  if (!name || seen.has(name)) return false;
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    if (current.trustedTypes.has(name)) return true;
    const alias = current.types.get(name);
    if (alias) {
      seen.add(name);
      return trustedType(alias, current, seen);
    }
  }
  return false;
}

function predeclareImmediate(statements: unknown, scope: Scope): void {
  for (const statement of childNodes(statements)) {
    if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
      for (const declaration of childNodes(statement.declarations))
        declarePattern(declaration.id, scope);
    } else if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') {
      const name = identifierName(statement.id);
      if (name) scope.bindings.set(name, { trusted: false });
    } else if (statement.type === 'TSTypeAliasDeclaration') {
      const name = identifierName(statement.id);
      const annotation = node(statement.typeAnnotation);
      if (name && annotation) scope.types.set(name, annotation);
    }
  }
}

function predeclareVars(value: unknown, functionScope: Scope): void {
  for (const candidate of childNodes(value)) {
    if (
      candidate.type === 'FunctionDeclaration' ||
      candidate.type === 'FunctionExpression' ||
      candidate.type === 'ArrowFunctionExpression' ||
      candidate.type === 'ClassDeclaration' ||
      candidate.type === 'ClassExpression'
    ) {
      continue;
    }
    if (candidate.type === 'VariableDeclaration' && candidate.kind === 'var') {
      for (const declaration of childNodes(candidate.declarations)) {
        declarePattern(declaration.id, functionScope);
      }
    }
    for (const [key, child] of Object.entries(candidate)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;
      predeclareVars(child, functionScope);
    }
  }
}

function isRepoDbModule(source: string, file: string): boolean {
  if (source === DB_MODULE_ALIAS) return true;
  if (!source.startsWith('.')) return false;
  const resolved = normalizePath(resolve('/', dirname(file), source)).slice(1);
  return resolved === 'src/db/client' || resolved === 'src/db/client.ts';
}

function collectDrizzleWrites(source: string, file: string): DrizzleWrite[] {
  let program: AstNode;
  try {
    program = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: false,
      attachComment: false,
    }).program as unknown as AstNode;
  } catch (error) {
    throw new Error(
      `audit:hub-sync-writers: cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const writes: DrizzleWrite[] = [];
  const root = {} as Scope;
  root.bindings = new Map();
  root.types = new Map();
  root.trustedTypes = new Set();
  root.functionScope = root;

  const makeScope = (parent: Scope, isFunction = false): Scope => {
    const scope = {
      parent,
      bindings: new Map<string, Binding>(),
      types: new Map<string, AstNode>(),
      trustedTypes: new Set<string>(),
      functionScope: parent.functionScope,
    };
    if (isFunction) scope.functionScope = scope;
    return scope;
  };

  const visitGeneric = (candidate: AstNode, scope: Scope): void => {
    for (const [key, child] of Object.entries(candidate)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;
      for (const childNode of childNodes(child)) visit(childNode, scope);
    }
  };

  const visitFunction = (candidate: AstNode, parent: Scope, transactionCallback: boolean): void => {
    const scope = makeScope(parent, true);
    const ownName = identifierName(candidate.id);
    if (ownName) scope.bindings.set(ownName, { trusted: false });
    const parameters = childNodes(candidate.params);
    for (const parameter of parameters) declarePattern(parameter, scope);
    if (transactionCallback) {
      const firstName = identifierName(parameters[0]);
      const binding = firstName ? scope.bindings.get(firstName) : undefined;
      if (binding) binding.trusted = true;
    }
    for (const parameter of parameters) {
      const name = identifierName(parameter);
      const binding = name ? scope.bindings.get(name) : undefined;
      if (binding && trustedType(parameter.typeAnnotation, scope)) binding.trusted = true;
    }
    predeclareVars(candidate.body, scope);
    const body = node(candidate.body);
    if (body?.type === 'BlockStatement') visitBlock(body, scope);
    else if (body) visit(body, scope);
  };

  const visitBlock = (candidate: AstNode, parent: Scope): void => {
    const scope = makeScope(parent);
    predeclareImmediate(candidate.body, scope);
    for (const statement of childNodes(candidate.body)) visit(statement, scope);
  };

  const visitCall = (candidate: AstNode, scope: Scope): void => {
    const callee = node(candidate.callee);
    const member =
      callee && (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression')
        ? callee
        : undefined;
    const property = member
      ? member.computed
        ? undefined
        : identifierName(member.property)
      : undefined;
    const trustedReceiver = member ? trustedBinding(member.object, scope) : false;
    if (trustedReceiver && property && ['insert', 'update', 'delete'].includes(property)) {
      let table = node(childNodes(candidate.arguments)[0]);
      while (table?.type === 'TSAsExpression' || table?.type === 'TSNonNullExpression') {
        table = node(table.expression);
      }
      const tableName = identifierName(table);
      if (tableName && candidate.start != null)
        writes.push({ index: candidate.start, table: tableName });
    }
    const transactionCallback = trustedReceiver && property === 'transaction';
    for (const argument of childNodes(candidate.arguments)) {
      if (
        transactionCallback &&
        (argument.type === 'ArrowFunctionExpression' || argument.type === 'FunctionExpression')
      ) {
        visitFunction(argument, scope, true);
      } else {
        visit(argument, scope);
      }
    }
    if (member) visit(member.object as AstNode, scope);
  };

  const visit = (candidate: AstNode, scope: Scope): void => {
    switch (candidate.type) {
      case 'Program':
        predeclareImmediate(candidate.body, scope);
        predeclareVars(candidate.body, scope);
        for (const statement of childNodes(candidate.body)) visit(statement, scope);
        return;
      case 'ImportDeclaration': {
        const sourceValue = node(candidate.source)?.value;
        const trustedModule = typeof sourceValue === 'string' && isRepoDbModule(sourceValue, file);
        for (const specifier of childNodes(candidate.specifiers)) {
          const local = identifierName(specifier.local);
          if (!local) continue;
          scope.bindings.set(local, { trusted: false });
          if (!trustedModule || specifier.type !== 'ImportSpecifier') continue;
          const imported = identifierName(specifier.imported);
          const binding = scope.bindings.get(local);
          if (imported === 'db' && binding) binding.trusted = true;
          else if (imported && DB_TYPE_EXPORTS.has(imported)) scope.trustedTypes.add(local);
        }
        return;
      }
      case 'BlockStatement':
        visitBlock(candidate, scope);
        return;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        visitFunction(candidate, scope, false);
        return;
      case 'CatchClause': {
        const catchScope = makeScope(scope);
        declarePattern(candidate.param, catchScope);
        const body = node(candidate.body);
        if (body) visitBlock(body, catchScope);
        return;
      }
      case 'VariableDeclaration':
        for (const declaration of childNodes(candidate.declarations)) {
          const targetScope = candidate.kind === 'var' ? scope.functionScope : scope;
          declarePattern(declaration.id, targetScope);
          const name = identifierName(declaration.id);
          const binding = name ? targetScope.bindings.get(name) : undefined;
          if (binding) {
            binding.trusted =
              trustedType(node(declaration.id)?.typeAnnotation, scope) ||
              trustedBinding(declaration.init, scope);
          }
          const init = node(declaration.init);
          if (init) visit(init, scope);
        }
        return;
      case 'CallExpression':
      case 'OptionalCallExpression':
        visitCall(candidate, scope);
        return;
      case 'ClassDeclaration':
      case 'ClassExpression': {
        const classScope = makeScope(scope);
        const ownName = identifierName(candidate.id);
        if (ownName) classScope.bindings.set(ownName, { trusted: false });
        visitGeneric(candidate, classScope);
        return;
      }
      case 'TSTypeAliasDeclaration':
        return;
      default:
        visitGeneric(candidate, scope);
    }
  };

  visit(program, root);
  return writes;
}

function rawSqlWritePattern(table: string): RegExp {
  return new RegExp(`\\b(?:update|insert\\s+into|delete\\s+from)\\s+"?${table}\\b`, 'gi');
}

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
        walk(abs);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (/\.(test|db\.test|unit\.test)\.tsx?$/.test(entry)) continue;
      // This audit's own source contains rule marker strings and synthetic patterns.
      if (normalizePath(relative(root, abs)) === 'scripts/audit-hub-sync-writers.ts') continue;
      out.push(abs);
    }
  };
  for (const d of SCAN_DIRS) walk(join(root, d));
  return out;
}

/**
 * Scan `root` for hub-sync ownership violations. `allowlist` inventories the
 * known topology writers; anything else is a finding.
 */
export async function auditHubSyncWriters(input: {
  root: string;
  allowlist: AllowlistEntry[];
}): Promise<HubSyncAuditFinding[]> {
  const findings: HubSyncAuditFinding[] = [];
  const allowByPath = new Map<string, Set<string>>();
  for (const entry of input.allowlist) {
    allowByPath.set(normalizePath(entry.path), new Set(entry.tables));
  }

  for (const abs of listSourceFiles(input.root)) {
    const rel = normalizePath(relative(input.root, abs));
    const isReconciler = rel === RECONCILER_PATH;
    const sourceText = readFileSync(abs, 'utf8');
    const code = codeText(sourceText);
    const drizzleWrites = collectDrizzleWrites(sourceText, rel);
    const lines = sourceText.split('\n');
    const addFinding = (rule: HubSyncAuditRule, index: number) => {
      const line = code.slice(0, index).split('\n').length;
      findings.push({ rule, file: rel, line, excerpt: lines[line - 1]?.trim() ?? '' });
    };

    if (!isReconciler) {
      for (const write of drizzleWrites) {
        if (write.table === 'hub_sync_reconciliation') {
          addFinding('RECONCILIATION_OWNER_BYPASS', write.index);
        }
      }
      for (const match of code.matchAll(rawSqlWritePattern('hub_sync_reconciliation'))) {
        addFinding('RECONCILIATION_OWNER_BYPASS', match.index ?? 0);
      }
      for (const match of code.matchAll(/app\.hub_sync_internal_apply/g)) {
        addFinding('INTERNAL_APPLY_MARKER_BYPASS', match.index);
      }
    }
    for (const match of code.matchAll(
      /(?:actorRef|['"]actorRef['"])\s*:\s*['"]hub_auto_sync['"]/g,
    )) {
      addFinding('DIRECT_HUB_ACTOR_APPLY', match.index);
    }
    for (const table of TOPOLOGY_TABLES) {
      if (allowByPath.get(rel)?.has(table)) continue;
      for (const write of drizzleWrites) {
        if (write.table === table) addFinding('UNINVENTORIED_TOPOLOGY_WRITER', write.index);
      }
      for (const match of code.matchAll(rawSqlWritePattern(table))) {
        addFinding('UNINVENTORIED_TOPOLOGY_WRITER', match.index ?? 0);
      }
    }
  }
  return findings;
}

export function loadAllowlist(): AllowlistEntry[] {
  let raw: { writers?: AllowlistEntry[] };
  try {
    raw = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')) as { writers?: AllowlistEntry[] };
  } catch (err) {
    // This is a CI gate — a missing/corrupt allowlist must fail with a clear, actionable
    // message, not a raw ENOENT/SyntaxError stack.
    throw new Error(
      `audit:hub-sync-writers: cannot read/parse allowlist at ${ALLOWLIST_PATH}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return raw.writers ?? [];
}

async function main(): Promise<void> {
  const findings = await auditHubSyncWriters({ root: REPO_ROOT, allowlist: loadAllowlist() });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(findings, null, 2));
  }
  if (findings.length === 0) {
    console.log('Hub sync writer audit passed');
    return;
  }
  console.error(`Hub sync writer audit found ${findings.length} violation(s):`);
  for (const f of findings) {
    console.error(`  [${f.rule}] ${f.file}:${f.line} — ${f.excerpt}`);
  }
  process.exitCode = 1;
}

// Run as CLI only (not when imported by the test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
