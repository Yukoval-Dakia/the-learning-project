/**
 * Pass-through site scan (architecture anti-regression, 2026-10-20 proposal §2).
 *
 * A "site" is a statically provable forwarding shape — the only thing a machine
 * can honestly assert is "this export is an identity forward", never "this
 * module is shallow". Kinds:
 *   - module   (M1): file with zero runtime top-level definitions whose only
 *                    runtime surface is value re-export-from statements;
 *   - function (F1): exported function whose body is one `return [await]
 *                    imported(arg…)` that forwards its parameters verbatim —
 *                    same order or a full permutation of distinct params,
 *                    optionally followed by a trailing `...rest` spread of the
 *                    same binding; no defaults/patterns, and no try/catch/
 *                    guard — error boundaries, conversions and validation
 *                    never match;
 *   - alias    (A1): `export const X = importedBinding` / `export default
 *                    importedBinding` — no call, no transform;
 *   - object   (O1): exported object literal whose entire value surface is
 *                    verbatim value-import bindings (`{ foo }`, `{ foo: foo }`,
 *                    `{ foo: bar }`) — the object-shaped analogue of the M1
 *                    module shell; a computed key, method, accessor, spread or
 *                    any non-import value makes the object a real definition
 *                    and produces no site;
 *   - site     (S1): a value-bearing export-from statement inside a module that
 *                    also owns runtime definitions.
 * Type-only declarations and `import type`/`export type` produce no value
 * surface and are excluded by per-specifier kind checks, not by file name.
 */
import { createHash } from 'node:crypto';
import { parse } from '@babel/parser';
import { analyzeSource } from './ts-tokenize';

export const PASS_THROUGH_SCANNER_VERSION = 3;

export type PassThroughKind = 'module' | 'function' | 'alias' | 'object' | 'site';

export interface PassThroughSite {
  /** Repo-relative posix path of the file owning the site. */
  file: string;
  kind: PassThroughKind;
  /** Exported name; '*' when the site is the whole module or export-star. */
  symbol: string;
  /** Resolved repo-relative module the site forwards to. */
  targetModule: string;
  /** Symbol inside targetModule the site forwards ('*' for export-star). */
  targetSymbol?: string;
  /** Canonical fingerprint of the forwarding body/signature. */
  detail: string;
}

export interface ScannedSource {
  path: string;
  code: string;
}

type ResolveTarget = (file: string, source: string) => string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nodeName(value: unknown): string | undefined {
  return isRecord(value) && typeof value.name === 'string' ? value.name : undefined;
}

function literalString(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (
    (value.type === 'StringLiteral' || value.type === 'Literal') &&
    typeof value.value === 'string'
  ) {
    return value.value;
  }
  return undefined;
}

interface ImportBinding {
  source: string;
  imported: string;
  typeOnly: boolean;
}

interface ObjectCandidate {
  localName: string;
  node: Record<string, unknown>;
  /** Exported by its own declaration; `export { local }` is resolved after the pass. */
  exportedDirectly: boolean;
}

interface FunctionCandidate {
  localName: string;
  params: unknown[];
  body: Record<string, unknown> | null;
  expressionBody: unknown;
  async: boolean;
  start: number;
  end: number;
}

/** Exported (consumer-visible) names carried by an export-from statement,
 *  per specifier, paired with the name inside the target module —
 *  `export {a as b} from` → {exported:'b', target:'a'}, `export * as ns` →
 *  {exported:'ns', target:'*'}, `export v` → {exported:'v', target:'v'}.
 *  Type-only declarations/specifiers produce none. */
function exportedValueSpecifiers(
  node: Record<string, unknown>,
): { exported: string; targetName: string }[] {
  if (!Array.isArray(node.specifiers)) return [];
  if (node.exportKind === 'type') return [];
  const pairs: { exported: string; targetName: string }[] = [];
  for (const specifier of node.specifiers) {
    if (!isRecord(specifier)) continue;
    if (specifier.exportKind === 'type') continue;
    const exported = isRecord(specifier.exported)
      ? (nodeName(specifier.exported) ?? literalString(specifier.exported))
      : undefined;
    const local = isRecord(specifier.local)
      ? (nodeName(specifier.local) ?? literalString(specifier.local))
      : undefined;
    if (specifier.type === 'ExportNamespaceSpecifier') {
      pairs.push({ exported: exported ?? '*', targetName: '*' });
      continue;
    }
    if (specifier.type === 'ExportDefaultSpecifier') {
      pairs.push({ exported: exported ?? 'default', targetName: local ?? 'default' });
      continue;
    }
    if (exported) pairs.push({ exported, targetName: local ?? exported });
  }
  return pairs;
}

/** True when the statement adds no local runtime surface of its own. */
function isNonRuntimeStatement(node: Record<string, unknown>): boolean {
  switch (node.type) {
    case 'ImportDeclaration':
    case 'TSInterfaceDeclaration':
    case 'TSTypeAliasDeclaration':
    case 'TSDeclareFunction':
    case 'TSImportEqualsDeclaration':
    case 'TSExportAssignment':
      return true;
    case 'TSModuleDeclaration':
      return node.declare === true;
    case 'ExportNamedDeclaration':
      if (typeof node.source === 'object' && node.source !== null) return true; // export-from site
      if (node.exportKind === 'type') return true;
      if (!node.declaration) return true; // `export { local }`
      return false;
    case 'ExportAllDeclaration':
      return true;
    case 'VariableDeclaration': {
      // const x = importedIdent contributes an alias site, not a definition.
      const declarators = Array.isArray(node.declarations) ? node.declarations : [];
      return (
        declarators.length > 0 &&
        declarators.every(
          (d) =>
            isRecord(d) &&
            isRecord(d.init) &&
            (d.init.type === 'Identifier' ||
              (d.init.type === 'TSAsExpression' &&
                isRecord(d.init.expression) &&
                d.init.expression.type === 'Identifier')),
        )
      );
    }
    default:
      return false;
  }
}

function canonicalHash(code: string, start: number, end: number): string {
  const mask = analyzeSource(code).codeMask;
  let canonical = '';
  for (let i = start; i < end && i < code.length; i++) {
    if (mask[i] === 1 && !/\s/.test(code[i])) canonical += code[i];
  }
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function callTargetOf(
  expression: unknown,
  bindings: Map<string, ImportBinding>,
): { binding: ImportBinding; member: string | null } | null {
  if (!isRecord(expression) || expression.type !== 'CallExpression') return null;
  const callee = expression.callee;
  if (!isRecord(callee)) return null;
  if (callee.type === 'Identifier') {
    const binding = bindings.get(nodeName(callee) ?? '');
    return binding && !binding.typeOnly ? { binding, member: null } : null;
  }
  if (
    callee.type === 'MemberExpression' &&
    callee.computed !== true &&
    isRecord(callee.object) &&
    callee.object.type === 'Identifier'
  ) {
    const binding = bindings.get(nodeName(callee.object) ?? '');
    if (!binding || binding.typeOnly) return null;
    const member = nodeName(callee.property) ?? literalString(callee.property) ?? null;
    return member === null ? null : { binding, member };
  }
  return null;
}

export type ForwardShape = 'direct' | 'reordered' | 'spread' | 'direct+spread' | 'reordered+spread';

/** Plain-Identifier prefix comparison: 'direct' same order, 'reordered' for a
 *  full permutation of distinct names (element-wise sorted equality — never
 *  string concat; `f(a,b) => g(a,a)` must not match), null otherwise. */
function plainPrefixShape(params: unknown[], args: unknown[]): 'direct' | 'reordered' | null {
  const paramNames: string[] = [];
  for (const param of params) {
    if (!isRecord(param) || param.type !== 'Identifier' || typeof param.name !== 'string') {
      return null;
    }
    paramNames.push(param.name);
  }
  const argNames: string[] = [];
  for (const arg of args) {
    if (!isRecord(arg) || arg.type !== 'Identifier' || typeof arg.name !== 'string') return null;
    argNames.push(arg.name);
  }
  if (argNames.length !== paramNames.length) return null;
  if (argNames.every((name, i) => name === paramNames[i])) return 'direct';
  const sortedParams = [...paramNames].sort();
  const sortedArgs = [...argNames].sort();
  if (
    new Set(paramNames).size === paramNames.length &&
    sortedArgs.every((name, i) => name === sortedParams[i])
  ) {
    return 'reordered';
  }
  return null;
}

/** Decidable F1 argument shapes — everything else (defaults, patterns,
 *  transforms, dropped/duplicated params, a spread anywhere but last, computed
 *  calls) stays a real definition, not a thin forward:
 *   - plain params forwarded in order (`direct`) or fully permuted (`reordered`)
 *   - a trailing `...rest` parameter forwarded as a trailing `...rest` spread
 *     of the same binding, with no leading prefix (`spread`) or a verbatim/
 *     permuted plain prefix (`direct+spread` / `reordered+spread`). */
function forwardArgsShape(params: unknown[], args: unknown[]): ForwardShape | null {
  const lastParam = params[params.length - 1];
  const restName =
    isRecord(lastParam) &&
    lastParam.type === 'RestElement' &&
    isRecord(lastParam.argument) &&
    lastParam.argument.type === 'Identifier'
      ? lastParam.argument.name
      : null;
  if (restName !== null) {
    // `(...rest) => target(...rest)` and `(p…, ...rest) => target(p…, ...rest)`:
    // the spread must be the last argument and name the same binding.
    const lastArg = args[args.length - 1];
    if (
      args.length !== params.length ||
      !isRecord(lastArg) ||
      lastArg.type !== 'SpreadElement' ||
      !isRecord(lastArg.argument) ||
      lastArg.argument.type !== 'Identifier' ||
      lastArg.argument.name !== restName
    ) {
      return null;
    }
    const prefix = plainPrefixShape(params.slice(0, -1), args.slice(0, -1));
    if (prefix === null) return null;
    if (params.length === 1) return 'spread';
    return prefix === 'direct' ? 'direct+spread' : 'reordered+spread';
  }
  // No rest parameter: any spread argument is out of shape.
  if (args.length !== params.length) return null;
  return plainPrefixShape(params, args);
}

/** The F1 shape: `return [await] imported(…)` with a decidable forward of the
 *  parameters — same order or a full permutation of distinct params, with an
 *  optional trailing `...rest` spread of the same binding — and nothing else. */
function forwardDetail(
  candidate: FunctionCandidate,
  bindings: Map<string, ImportBinding>,
): {
  target: ImportBinding;
  member: string | null;
  awaited: boolean;
  shape: ForwardShape;
} | null {
  let returned: unknown;
  if (candidate.expressionBody !== null) {
    returned = candidate.expressionBody;
  } else {
    const body = candidate.body;
    if (!body || !Array.isArray(body.body) || body.body.length !== 1) return null;
    const statement = body.body[0];
    if (!isRecord(statement) || statement.type !== 'ReturnStatement') return null;
    returned = statement.argument;
  }
  let awaited = false;
  if (isRecord(returned) && returned.type === 'AwaitExpression') {
    awaited = true;
    returned = returned.argument;
  }
  const call = callTargetOf(returned, bindings);
  if (!call) return null;
  const args = isRecord(returned) && Array.isArray(returned.arguments) ? returned.arguments : [];
  const shape = forwardArgsShape(candidate.params, args);
  if (!shape) return null;
  return { target: call.binding, member: call.member, awaited, shape };
}

/** A `const`/`export const` declarator whose initializer is an object literal;
 *  whether it is exported (directly or by a later `export { … }`) and whether
 *  the object is a pure forward table are resolved after the whole pass. */
function objectCandidateFromDeclarator(
  declarator: Record<string, unknown>,
): ObjectCandidate | null {
  const localName = nodeName(declarator.id);
  let init: unknown = declarator.init;
  if (isRecord(init) && init.type === 'TSAsExpression') init = init.expression;
  if (!localName || !isRecord(init) || init.type !== 'ObjectExpression') return null;
  return { localName, node: init, exportedDirectly: false };
}

/** An exported object literal is a forwarding table only when it adds no
 *  runtime surface of its own: every property holds an imported binding
 *  verbatim. One non-import value (a literal, a call, a local function, a
 *  spread, a method) means the object owns behavior or data, so none of its
 *  properties are provable identity forwards — same all-or-nothing rule as the
 *  M1 module shell. `TSAs` wrappers and string keys stay verbatim. */
function objectPropertyBindings(
  node: Record<string, unknown>,
  bindings: Map<string, ImportBinding>,
): { key: string; binding: ImportBinding }[] {
  const properties = Array.isArray(node.properties) ? node.properties : [];
  if (properties.length === 0) return [];
  const pairs: { key: string; binding: ImportBinding }[] = [];
  for (const property of properties) {
    if (!isRecord(property)) return [];
    if (property.type !== 'ObjectProperty' && property.type !== 'Property') return [];
    if (property.computed === true || property.method === true) return [];
    if (property.kind !== undefined && property.kind !== 'init') return [];
    const key = nodeName(property.key) ?? literalString(property.key);
    if (!key) return [];
    let value: unknown = property.value;
    if (isRecord(value) && value.type === 'TSAsExpression') value = value.expression;
    if (!isRecord(value) || value.type !== 'Identifier') return [];
    const binding = bindings.get(nodeName(value) ?? '');
    if (!binding || binding.typeOnly) return [];
    pairs.push({ key, binding });
  }
  return pairs;
}

function functionCandidateFromDeclarator(
  declarator: Record<string, unknown>,
): FunctionCandidate | null {
  const localName = nodeName(declarator.id);
  const init = declarator.init;
  if (!localName || !isRecord(init)) return null;
  if (init.type !== 'ArrowFunctionExpression' && init.type !== 'FunctionExpression') return null;
  return {
    localName,
    params: Array.isArray(init.params) ? init.params : [],
    body: isRecord(init.body) && init.body.type === 'BlockStatement' ? init.body : null,
    expressionBody: isRecord(init.body) && init.body.type !== 'BlockStatement' ? init.body : null,
    async: init.async === true,
    start: typeof init.start === 'number' ? init.start : 0,
    end: typeof init.end === 'number' ? init.end : 0,
  };
}

function functionCandidateFromDeclaration(node: Record<string, unknown>): FunctionCandidate | null {
  if (node.type !== 'FunctionDeclaration') return null;
  const localName = nodeName(node.id) ?? 'default';
  return {
    localName,
    params: Array.isArray(node.params) ? node.params : [],
    body: isRecord(node.body) ? node.body : null,
    expressionBody: null,
    async: node.async === true,
    start: typeof node.start === 'number' ? node.start : 0,
    end: typeof node.end === 'number' ? node.end : 0,
  };
}

/**
 * Extract every pass-through site in one file. `resolve` maps an import
 * specifier to the canonical repo-relative module path so base and head keys
 * compare equal across `@/` vs relative spellings.
 */
export function scanPassThroughSites(
  sources: readonly ScannedSource[],
  resolve: ResolveTarget,
): PassThroughSite[] {
  const sites: PassThroughSite[] = [];

  for (const { path, code } of sources) {
    const ast = parse(code, {
      sourceType: 'module',
      sourceFilename: path,
      plugins: path.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
    });
    const bindings = new Map<string, ImportBinding>();
    const candidates: FunctionCandidate[] = [];
    const exportedNames = new Set<string>();
    // A local binding may be re-exported under several aliases
    // (`export { f as a, f as b }`) — keep every real exported name so each
    // alias produces its own site and alias ordering cannot hide one.
    const localToExported = new Map<string, Set<string>>();
    const addLocalExport = (local: string, exported: string) => {
      const names = localToExported.get(local) ?? new Set<string>();
      names.add(exported);
      localToExported.set(local, names);
    };
    // Re-export identities keyed by exported symbol + target so adding
    // `export { b } from './m'` beside an existing `export { a } from './m'`
    // produces a NEW site instead of collapsing into one module-level key.
    const reexportPairs = new Map<
      string,
      { exported: string; target: string; targetName: string }
    >();
    const addReexportPair = (exported: string, target: string, targetName: string) => {
      reexportPairs.set(`${exported} → ${target}`, { exported, target, targetName });
    };
    // Plain `const wrapper = imported` keeps the import as a permanent alias —
    // when that local is later exported (any order, any name) it is the same
    // pass-through as an export specifier of an import binding. `let`/`var`
    // and non-identifier inits are never provable permanent bindings.
    const varAliases = new Map<string, ImportBinding>();
    const objectCandidates: ObjectCandidate[] = [];
    const pendingVarExports: { local: string; exported: string }[] = [];
    let runtimeDefs = 0;
    let sawValueReexport = false;

    for (const statement of ast.program.body) {
      if (!isRecord(statement)) continue;
      if (statement.type === 'ImportDeclaration') {
        const source = literalString(statement.source);
        const statementTypeOnly = statement.importKind === 'type';
        if (source && Array.isArray(statement.specifiers)) {
          for (const specifier of statement.specifiers) {
            if (!isRecord(specifier)) continue;
            const local = nodeName(specifier.local);
            if (!local) continue;
            const typeOnly = statementTypeOnly || specifier.importKind === 'type';
            let imported = '*';
            if (specifier.type === 'ImportSpecifier') {
              imported = nodeName(specifier.imported) ?? literalString(specifier.imported) ?? local;
            } else if (specifier.type === 'ImportDefaultSpecifier') {
              imported = 'default';
            }
            bindings.set(local, { source, imported, typeOnly });
          }
        }
        continue;
      }

      if (statement.type === 'ExportNamedDeclaration') {
        const source = literalString(statement.source);
        if (source !== undefined) {
          // export-from: a pass-through site candidate per exported symbol.
          const valuePairs = exportedValueSpecifiers(statement);
          if (valuePairs.length > 0) {
            const target = resolve(path, source);
            if (target) {
              for (const pair of valuePairs) {
                addReexportPair(pair.exported, target, pair.targetName);
              }
              sawValueReexport = true;
            }
          }
          continue;
        }
        if (statement.declaration) {
          const declaration = statement.declaration;
          if (isRecord(declaration) && declaration.type === 'FunctionDeclaration') {
            const candidate = functionCandidateFromDeclaration(declaration);
            if (candidate) {
              candidates.push(candidate);
              exportedNames.add(candidate.localName);
            }
          } else if (isRecord(declaration) && declaration.type === 'VariableDeclaration') {
            for (const declarator of Array.isArray(declaration.declarations)
              ? declaration.declarations
              : []) {
              if (!isRecord(declarator)) continue;
              const fn = functionCandidateFromDeclarator(declarator);
              if (fn) {
                candidates.push(fn);
                exportedNames.add(fn.localName);
                continue;
              }
              // alias site: export const X = importedIdentifier
              const name = nodeName(declarator.id);
              const init = declarator.init;
              let aliasOf: unknown = init;
              if (isRecord(init) && init.type === 'TSAsExpression') aliasOf = init.expression;
              if (isRecord(aliasOf) && aliasOf.type === 'Identifier' && name) {
                const binding = bindings.get(nodeName(aliasOf) ?? '');
                if (binding && !binding.typeOnly) {
                  varAliases.set(name, binding);
                  const target = resolve(path, binding.source);
                  if (target) {
                    sites.push({
                      file: path,
                      kind: 'alias',
                      symbol: name,
                      targetModule: target,
                      targetSymbol: binding.imported,
                      detail: `alias:${binding.imported}`,
                    });
                  }
                }
              }
              const exportedObject =
                declaration.kind === 'const' ? objectCandidateFromDeclarator(declarator) : null;
              if (exportedObject) {
                exportedObject.exportedDirectly = true;
                objectCandidates.push(exportedObject);
              }
            }
          }
        } else if (statement.exportKind !== 'type' && Array.isArray(statement.specifiers)) {
          // `export { localName as x }` — a value forward when the local name is
          // itself an imported binding.
          for (const specifier of statement.specifiers) {
            if (!isRecord(specifier) || specifier.exportKind === 'type') continue;
            const local = nodeName(specifier.local);
            const exported = isRecord(specifier.exported)
              ? (nodeName(specifier.exported) ?? literalString(specifier.exported))
              : undefined;
            if (!local || !exported) continue;
            addLocalExport(local, exported);
            exportedNames.add(exported);
            pendingVarExports.push({ local, exported });
            const binding = bindings.get(local);
            if (binding && !binding.typeOnly) {
              const target = resolve(path, binding.source);
              if (target) {
                sites.push({
                  file: path,
                  kind: 'site',
                  symbol: exported,
                  targetModule: target,
                  targetSymbol: binding.imported,
                  detail: `local-export:${binding.imported}`,
                });
              }
            }
          }
        }
        if (!isNonRuntimeStatement(statement)) runtimeDefs += 1;
        continue;
      }

      if (statement.type === 'ExportAllDeclaration') {
        const source = literalString(statement.source);
        if (source !== undefined && statement.exportKind !== 'type') {
          const target = resolve(path, source);
          if (target) {
            addReexportPair('*', target, '*');
            sawValueReexport = true;
          }
        }
        continue;
      }

      if (statement.type === 'ExportDefaultDeclaration') {
        const declaration = statement.declaration;
        if (isRecord(declaration) && declaration.type === 'FunctionDeclaration') {
          const candidate = functionCandidateFromDeclaration(declaration);
          if (candidate) {
            candidates.push(candidate);
            exportedNames.add('default');
            addLocalExport(candidate.localName, 'default');
          }
        } else if (
          isRecord(declaration) &&
          (declaration.type === 'ArrowFunctionExpression' ||
            declaration.type === 'FunctionExpression')
        ) {
          // `export default (a) => imported(a)` — the same F1 pipeline,
          // exported symbol `default`.
          candidates.push({
            localName: 'default',
            params: Array.isArray(declaration.params) ? declaration.params : [],
            body:
              isRecord(declaration.body) && declaration.body.type === 'BlockStatement'
                ? declaration.body
                : null,
            expressionBody:
              isRecord(declaration.body) && declaration.body.type !== 'BlockStatement'
                ? declaration.body
                : null,
            async: declaration.async === true,
            start: typeof declaration.start === 'number' ? declaration.start : 0,
            end: typeof declaration.end === 'number' ? declaration.end : 0,
          });
          exportedNames.add('default');
        } else if (isRecord(declaration) && declaration.type === 'ObjectExpression') {
          // `export default { foo }` — the same object-shape forward, exported
          // under `default`, matched at the end of the pass.
          objectCandidates.push({
            localName: 'default',
            node: declaration,
            exportedDirectly: true,
          });
        } else if (
          isRecord(declaration) &&
          (declaration.type === 'Identifier' ||
            (declaration.type === 'TSAsExpression' &&
              isRecord(declaration.expression) &&
              declaration.expression.type === 'Identifier'))
        ) {
          const ident = declaration.type === 'Identifier' ? declaration : declaration.expression;
          const localName = nodeName(ident);
          if (localName) {
            // `export default f` / `export default f as T` — f may be a local
            // forward candidate, so `default` is one of its exported names.
            // (If f is an imported binding the alias site below covers it and
            // no candidate will ever match this name.)
            addLocalExport(localName, 'default');
            exportedNames.add('default');
            pendingVarExports.push({ local: localName, exported: 'default' });
          }
          const binding = bindings.get(localName ?? '');
          if (binding && !binding.typeOnly) {
            const target = resolve(path, binding.source);
            if (target) {
              sites.push({
                file: path,
                kind: 'alias',
                symbol: 'default',
                targetModule: target,
                targetSymbol: binding.imported,
                detail: `alias:${binding.imported}`,
              });
            }
          }
        }
        if (!isNonRuntimeStatement(statement)) runtimeDefs += 1;
        continue;
      }

      if (statement.type === 'FunctionDeclaration') {
        const candidate = functionCandidateFromDeclaration(statement);
        if (candidate) candidates.push(candidate);
      } else if (statement.type === 'VariableDeclaration') {
        for (const declarator of Array.isArray(statement.declarations)
          ? statement.declarations
          : []) {
          if (!isRecord(declarator)) continue;
          const fn = functionCandidateFromDeclarator(declarator);
          if (fn) {
            candidates.push(fn);
            continue;
          }
          // `const wrapper = imported` — a permanent alias only when the
          // declarator is const, the init is a bare identifier (TSAs ok) and
          // that identifier is a value import binding. `let`/`var`, member or
          // call expressions are never provable permanent bindings.
          if (statement.kind !== 'const') continue;
          const objectCandidate = objectCandidateFromDeclarator(declarator);
          if (objectCandidate) objectCandidates.push(objectCandidate);
          const name = nodeName(declarator.id);
          let init: unknown = declarator.init;
          if (isRecord(init) && init.type === 'TSAsExpression') init = init.expression;
          if (!name || !isRecord(init) || init.type !== 'Identifier') continue;
          const binding = bindings.get(nodeName(init) ?? '');
          if (binding && !binding.typeOnly) varAliases.set(name, binding);
        }
      }
      if (!isNonRuntimeStatement(statement)) runtimeDefs += 1;
    }

    for (const candidate of candidates) {
      const exportedSet = new Set<string>(
        localToExported.get(candidate.localName) ?? new Set<string>(),
      );
      if (exportedNames.has(candidate.localName)) exportedSet.add(candidate.localName);
      const forward = forwardDetail(candidate, bindings);
      if (!forward) continue;
      const target = resolve(path, forward.target.source);
      if (!target) continue;
      for (const exported of exportedSet) {
        if (!exportedNames.has(exported)) continue;
        sites.push({
          file: path,
          kind: 'function',
          symbol: exported,
          targetModule: target,
          targetSymbol: forward.target.imported,
          detail: [
            `forward:${forward.target.imported}${forward.member ? `.${forward.member}` : ''}`,
            `${forward.shape}${forward.awaited ? '+await' : ''}`,
            canonicalHash(code, candidate.start, candidate.end),
          ].join(';'),
        });
      }
    }

    // `const wrapper = imported` re-exported under any name — same-site as a
    // specifier of an import binding, resolved after the whole pass so
    // declaration/export order cannot hide it. Import bindings take the
    // immediate `local-export`/`alias` path and can never be varAliases.
    for (const pending of pendingVarExports) {
      if (bindings.has(pending.local)) continue;
      const alias = varAliases.get(pending.local);
      if (!alias) continue;
      const target = resolve(path, alias.source);
      if (!target) continue;
      sites.push({
        file: path,
        kind: 'site',
        symbol: pending.exported,
        targetModule: target,
        targetSymbol: alias.imported,
        detail: `var-export:${alias.imported}`,
      });
    }

    // Exported object literals whose properties hold an imported binding
    // verbatim: the object-shaped A1 alias. Exported names are resolved after
    // the whole pass so declaration/export order cannot hide one.
    for (const candidate of objectCandidates) {
      const exportedSet = new Set<string>(
        localToExported.get(candidate.localName) ?? new Set<string>(),
      );
      if (candidate.exportedDirectly) exportedSet.add(candidate.localName);
      if (exportedSet.size === 0) continue;
      for (const { key, binding } of objectPropertyBindings(candidate.node, bindings)) {
        const target = resolve(path, binding.source);
        if (!target) continue;
        for (const exported of exportedSet) {
          sites.push({
            file: path,
            kind: 'object',
            symbol: `${exported}.${key}`,
            targetModule: target,
            targetSymbol: binding.imported,
            detail: `object:${binding.imported}`,
          });
        }
      }
    }

    const reexports = [...reexportPairs.values()].sort(
      (a, b) => a.target.localeCompare(b.target) || a.exported.localeCompare(b.exported),
    );
    if (runtimeDefs === 0 && sawValueReexport) {
      for (const pair of reexports) {
        sites.push({
          file: path,
          kind: 'module',
          symbol: pair.exported,
          targetModule: pair.target,
          targetSymbol: pair.targetName,
          detail: `module:${PASS_THROUGH_SCANNER_VERSION}`,
        });
      }
    } else {
      for (const pair of reexports) {
        sites.push({
          file: path,
          kind: 'site',
          symbol: pair.exported,
          targetModule: pair.target,
          targetSymbol: pair.targetName,
          detail: `site:${PASS_THROUGH_SCANNER_VERSION}`,
        });
      }
    }
  }

  return sites.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.kind.localeCompare(b.kind) ||
      a.symbol.localeCompare(b.symbol) ||
      a.targetModule.localeCompare(b.targetModule),
  );
}

function siteKey(site: PassThroughSite): string {
  // Identity excludes `detail` (scanner fingerprint/version): a scanner bump or
  // a reformatted body must not launder an existing site into "new". targetSymbol
  // stays identity: `export { a as b }` retargeted to `{ c as b }` is a NEW site.
  return identityKey(site);
}

/**
 * Set difference head vs base. `renames` maps a base path to its head path so a
 * moved file or moved target keeps its identity instead of laundering a stock site as new.
 */
export function diffPassThroughSites(
  baseSites: readonly PassThroughSite[],
  headSites: readonly PassThroughSite[],
  renames: ReadonlyMap<string, string>,
): { added: PassThroughSite[]; removed: PassThroughSite[] } {
  const renamed = (site: PassThroughSite): PassThroughSite => ({
    ...site,
    file: renames.get(site.file) ?? site.file,
    targetModule: renames.get(site.targetModule) ?? site.targetModule,
  });
  const normalizedBase = new Map<string, PassThroughSite>();
  for (const site of baseSites) normalizedBase.set(siteKey(renamed(site)), site);
  const headKeys = new Map(headSites.map((site) => [siteKey(site), site]));
  const added = headSites.filter((site) => !normalizedBase.has(siteKey(site)));
  const removed = [...normalizedBase.values()].filter(
    (site) => !headKeys.has(siteKey(renamed(site))),
  );
  return { added, removed };
}

// ---------------------------------------------------------------------------
// New-site gate: a pass-through shell that did not exist at the comparison
// base fails. There is no classification ledger — the only exemption is a
// named re-export inside `public.ts`, which is a declared public entrypoint
// by path and export form, not debt.
// ---------------------------------------------------------------------------

function identityKey(entry: {
  file: string;
  kind: string;
  symbol: string;
  targetModule: string;
  targetSymbol?: string;
}): string {
  return `${entry.file}|${entry.kind}|${entry.symbol}|${entry.targetModule}|${entry.targetSymbol ?? ''}`;
}

export function describeSite(site: PassThroughSite): string {
  return `${site.kind} ${site.symbol} -> ${site.targetModule} (${site.detail})`;
}

export interface PassThroughViolation {
  path: string;
  source: string;
  reason: string;
}

/** A named re-export inside a capability `public.ts` is the file's declared
 *  job, not a pass-through shell. `export *`/`export * as ns` forwards an open
 *  namespace and is never an entrypoint; hand-written function/alias forwards
 *  are debt wherever they live, and so is `var-export` — the two-step
 *  `const b = a; export { b }` spelling of the same alias shell. Only a
 *  `public.ts` under `src/capabilities/` declares capability entrypoints; a
 *  `public.ts` anywhere else is just a filename. */
function isPublicEntrypointSite(site: PassThroughSite): boolean {
  return (
    site.file.startsWith('src/capabilities/') &&
    site.file.endsWith('/public.ts') &&
    (site.kind === 'module' || site.kind === 'site') &&
    !site.detail.startsWith('var-export:') &&
    site.symbol !== '*' &&
    site.targetSymbol !== '*'
  );
}

export function auditPassThroughNewSites(input: {
  newSites: readonly PassThroughSite[];
}): PassThroughViolation[] {
  const violations: PassThroughViolation[] = [];
  for (const site of input.newSites) {
    if (isPublicEntrypointSite(site)) continue;
    violations.push({
      path: site.file,
      source: describeSite(site),
      reason:
        'new pass-through shell — remove it, or forward a named symbol through ' +
        'the owning capability public.ts (public entrypoints are not debt)',
    });
  }
  return violations;
}
