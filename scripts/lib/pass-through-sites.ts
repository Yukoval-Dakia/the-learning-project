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
 *                    same order, a full permutation of distinct params, or a
 *                    single rest parameter spread verbatim; no defaults/
 *                    patterns, and no try/catch/guard — error boundaries,
 *                    conversions and validation never match;
 *   - alias    (A1): `export const X = importedBinding` / `export default
 *                    importedBinding` — no call, no transform;
 *   - site     (S1): a value-bearing export-from statement inside a module that
 *                    also owns runtime definitions.
 * Type-only declarations and `import type`/`export type` produce no value
 * surface and are excluded by per-specifier kind checks, not by file name.
 */
import { createHash } from 'node:crypto';
import { parse } from '@babel/parser';
import type { CompatShim } from './source-size';
import { shimIsLive, validateCompatShimFields } from './source-size';
import { analyzeSource } from './ts-tokenize';

export const PASS_THROUGH_SCANNER_VERSION = 1;

export type PassThroughKind = 'module' | 'function' | 'alias' | 'site';

export interface PassThroughSite {
  /** Repo-relative posix path of the file owning the site. */
  file: string;
  kind: PassThroughKind;
  /** Exported name; '*' when the site is the whole module or export-star. */
  symbol: string;
  /** Resolved repo-relative module the site forwards to. */
  targetModule: string;
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

interface FunctionCandidate {
  localName: string;
  params: unknown[];
  body: Record<string, unknown> | null;
  expressionBody: unknown;
  async: boolean;
  start: number;
  end: number;
}

function exportedValueSpecifiers(node: Record<string, unknown>): string[] {
  if (!Array.isArray(node.specifiers)) return [];
  if (node.exportKind === 'type') return [];
  const names: string[] = [];
  for (const specifier of node.specifiers) {
    if (!isRecord(specifier)) continue;
    if (specifier.exportKind === 'type') continue;
    if (specifier.type === 'ExportNamespaceSpecifier') {
      names.push('*');
      continue;
    }
    if (specifier.type === 'ExportDefaultSpecifier') {
      names.push('default');
      continue;
    }
    const exported = isRecord(specifier.exported)
      ? (nodeName(specifier.exported) ?? literalString(specifier.exported))
      : undefined;
    if (exported) names.push(exported);
  }
  return names;
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

/** Decidable F1 argument shapes — everything else (defaults, patterns,
 *  transforms, dropped/duplicated params, computed calls) stays a real
 *  definition, not a thin forward. */
function forwardArgsShape(
  params: unknown[],
  args: unknown[],
): 'direct' | 'reordered' | 'spread' | null {
  // `(...args) => target(...args)` / `function f(...args) { return target(...args) }`
  if (params.length === 1 && args.length === 1) {
    const param = params[0];
    const arg = args[0];
    if (
      isRecord(param) &&
      param.type === 'RestElement' &&
      isRecord(param.argument) &&
      param.argument.type === 'Identifier' &&
      isRecord(arg) &&
      arg.type === 'SpreadElement' &&
      isRecord(arg.argument) &&
      arg.argument.type === 'Identifier' &&
      arg.argument.name === param.argument.name
    ) {
      return 'spread';
    }
  }
  if (args.length !== params.length) return null;
  // Every parameter must be a plain Identifier — defaults, rest (outside the
  // single-rest case above) and destructuring patterns own decisions.
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
  if (argNames.every((name, i) => name === paramNames[i])) return 'direct';
  // Permutation: distinct parameters, each used exactly once, order may differ.
  // Element-wise set membership (lengths already equal) — never string concat.
  const paramSet = new Set(paramNames);
  if (paramSet.size === paramNames.length && argNames.every((name) => paramSet.has(name))) {
    return 'reordered';
  }
  return null;
}

/** The F1 shape: `return [await] imported(…)` with a decidable forward of the
 *  parameters — same order, a full permutation of distinct params, or a single
 *  rest parameter spread verbatim — and nothing else. */
function forwardDetail(
  candidate: FunctionCandidate,
  bindings: Map<string, ImportBinding>,
): {
  target: ImportBinding;
  member: string | null;
  awaited: boolean;
  shape: 'direct' | 'reordered' | 'spread';
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
    const localToExported = new Map<string, string>();
    const reexportTargets = new Set<string>();
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
          // export-from: a pass-through site candidate when it carries values.
          const valueSymbols = exportedValueSpecifiers(statement);
          if (valueSymbols.length > 0) {
            const target = resolve(path, source);
            if (target) {
              reexportTargets.add(target);
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
                  const target = resolve(path, binding.source);
                  if (target) {
                    sites.push({
                      file: path,
                      kind: 'alias',
                      symbol: name,
                      targetModule: target,
                      detail: `alias:${binding.imported}`,
                    });
                  }
                }
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
            localToExported.set(local, exported);
            exportedNames.add(exported);
            const binding = bindings.get(local);
            if (binding && !binding.typeOnly) {
              const target = resolve(path, binding.source);
              if (target) {
                sites.push({
                  file: path,
                  kind: 'site',
                  symbol: exported,
                  targetModule: target,
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
            reexportTargets.add(target);
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
            localToExported.set(candidate.localName, 'default');
          }
        } else if (
          isRecord(declaration) &&
          (declaration.type === 'Identifier' ||
            (declaration.type === 'TSAsExpression' &&
              isRecord(declaration.expression) &&
              declaration.expression.type === 'Identifier'))
        ) {
          const ident = declaration.type === 'Identifier' ? declaration : declaration.expression;
          const binding = bindings.get(nodeName(ident) ?? '');
          if (binding && !binding.typeOnly) {
            const target = resolve(path, binding.source);
            if (target) {
              sites.push({
                file: path,
                kind: 'alias',
                symbol: 'default',
                targetModule: target,
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
          if (fn) candidates.push(fn);
        }
      }
      if (!isNonRuntimeStatement(statement)) runtimeDefs += 1;
    }

    for (const candidate of candidates) {
      const exported = localToExported.get(candidate.localName) ?? candidate.localName;
      if (!exportedNames.has(exported)) continue;
      const forward = forwardDetail(candidate, bindings);
      if (!forward) continue;
      const target = resolve(path, forward.target.source);
      if (!target) continue;
      sites.push({
        file: path,
        kind: 'function',
        symbol: exported,
        targetModule: target,
        detail: [
          `forward:${forward.target.imported}${forward.member ? `.${forward.member}` : ''}`,
          `${forward.shape}${forward.awaited ? '+await' : ''}`,
          canonicalHash(code, candidate.start, candidate.end),
        ].join(';'),
      });
    }

    if (runtimeDefs === 0 && sawValueReexport) {
      for (const target of [...reexportTargets].sort()) {
        sites.push({
          file: path,
          kind: 'module',
          symbol: '*',
          targetModule: target,
          detail: `module:${PASS_THROUGH_SCANNER_VERSION}`,
        });
      }
    } else {
      for (const target of reexportTargets) {
        sites.push({
          file: path,
          kind: 'site',
          symbol: '*',
          targetModule: target,
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
  return `${site.file}|${site.kind}|${site.symbol}|${site.targetModule}|${site.detail}`;
}

/**
 * Set difference head vs base. `renames` maps a base path to its head path so a
 * moved file keeps its identity instead of laundering a stock site as new.
 */
export function diffPassThroughSites(
  baseSites: readonly PassThroughSite[],
  headSites: readonly PassThroughSite[],
  renames: ReadonlyMap<string, string>,
): { added: PassThroughSite[]; removed: PassThroughSite[] } {
  const normalizedBase = new Map<string, PassThroughSite>();
  for (const site of baseSites) {
    const file = renames.get(site.file) ?? site.file;
    normalizedBase.set(siteKey({ ...site, file }), site);
  }
  const headKeys = new Map(headSites.map((site) => [siteKey(site), site]));
  const added = headSites.filter((site) => !normalizedBase.has(siteKey(site)));
  const removed = [...normalizedBase.values()].filter((site) => {
    const normalized = siteKey({ ...site, file: renames.get(site.file) ?? site.file });
    return !headKeys.has(normalized);
  });
  return { added, removed };
}

// ---------------------------------------------------------------------------
// Compat-shim validation (proposal §2.4): new sites default-fail unless a
// coordinator-approved entry covers them; every live approved shim must carry
// real consumer evidence, an exit condition, an issue and a ≤14-day window.
// ---------------------------------------------------------------------------

export interface ConsumerReference {
  source: string;
  kind: 'value' | 'type';
  symbols: string[];
  line: number;
}

function declarationIsValue(node: Record<string, unknown>): boolean {
  if (node.importKind === 'type' || node.exportKind === 'type') return false;
  if (!Array.isArray(node.specifiers) || node.specifiers.length === 0) return true;
  return node.specifiers.some(
    (specifier) =>
      isRecord(specifier) && specifier.importKind !== 'type' && specifier.exportKind !== 'type',
  );
}

function statementSymbols(node: Record<string, unknown>): string[] {
  if (node.type === 'ExportAllDeclaration') return ['*'];
  if (!Array.isArray(node.specifiers) || node.specifiers.length === 0) return ['*'];
  const names: string[] = [];
  for (const specifier of node.specifiers) {
    if (!isRecord(specifier)) continue;
    if (specifier.importKind === 'type' || specifier.exportKind === 'type') continue;
    if (specifier.type === 'ImportSpecifier' || specifier.type === 'ExportSpecifier') {
      const consumed = specifier.type === 'ImportSpecifier' ? specifier.imported : specifier.local;
      names.push(nodeName(consumed) ?? literalString(consumed) ?? '*');
    } else if (
      specifier.type === 'ImportDefaultSpecifier' ||
      specifier.type === 'ExportDefaultSpecifier'
    ) {
      names.push('default');
    } else {
      names.push('*');
    }
  }
  return names.length > 0 ? names : ['*'];
}

/** All module references a consumer file makes, with their statement line. */
export function consumerImports(code: string, file: string): ConsumerReference[] {
  const ast = parse(code, {
    sourceType: 'module',
    sourceFilename: file,
    plugins: file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
  });
  const references: ConsumerReference[] = [];
  const lineOf = (node: Record<string, unknown>) =>
    isRecord(node.loc) && typeof node.loc.start === 'object' && node.loc.start !== null
      ? ((node.loc.start as Record<string, unknown>).line as number)
      : 0;

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isRecord(value)) return;
    if (
      value.type === 'ImportDeclaration' ||
      value.type === 'ExportNamedDeclaration' ||
      value.type === 'ExportAllDeclaration'
    ) {
      const source = literalString(value.source);
      if (source) {
        references.push({
          source,
          kind: declarationIsValue(value) ? 'value' : 'type',
          symbols: statementSymbols(value),
          line: lineOf(value),
        });
      }
    } else if (value.type === 'ImportExpression') {
      const source = literalString(value.source);
      if (source) {
        references.push({ source, kind: 'value', symbols: ['*'], line: lineOf(value) });
      }
    } else if (value.type === 'TSImportType') {
      const source = literalString(value.argument);
      if (source) {
        references.push({ source, kind: 'type', symbols: ['*'], line: lineOf(value) });
      }
    } else if (value.type === 'CallExpression' && isRecord(value.callee)) {
      const isDynamicImport = value.callee.type === 'Import';
      const isRequire = value.callee.type === 'Identifier' && value.callee.name === 'require';
      if ((isDynamicImport || isRequire) && Array.isArray(value.arguments)) {
        const source = literalString(value.arguments[0]);
        if (source) {
          references.push({ source, kind: 'value', symbols: ['*'], line: lineOf(value) });
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (!['loc', 'start', 'end', 'extra'].includes(key)) visit(child);
    }
  }
  visit(ast.program);
  return references;
}

export function describeSite(site: PassThroughSite): string {
  return `${site.kind} ${site.symbol} -> ${site.targetModule} (${site.detail})`;
}

/** Whether a compatShims entry covers this pass-through site. */
export function shimCoversSite(shim: CompatShim, site: PassThroughSite): boolean {
  if (site.file !== shim.path || site.kind !== shim.kind) return false;
  if (shim.kind === 'module') return true;
  if (shim.kind === 'site') return site.targetModule === shim.targetModule;
  return site.symbol === shim.symbol;
}

export interface ShimViolation {
  path: string;
  source: string;
  reason: string;
}

export function auditCompatShims(input: {
  headSites: readonly PassThroughSite[];
  newSites: readonly PassThroughSite[];
  records: readonly CompatShim[];
  /** Number of records that already existed at base (append-only tail is new). */
  previousRecords: number;
  readSource: (path: string) => string | undefined;
  resolveTarget: (consumerFile: string, source: string) => string | undefined;
  today: string;
}): ShimViolation[] {
  const violations: ShimViolation[] = [];
  const fail = (path: string, source: string, reason: string) =>
    violations.push({ path, source, reason });

  for (const site of input.newSites) {
    if (!input.records.some((record) => shimCoversSite(record, site))) {
      fail(
        site.file,
        describeSite(site),
        'new pass-through shell — remove it or record a coordinator-approved compatShims entry {consumers file:line, exitCondition, issue, approval, deadline <= date+14d}',
      );
    }
  }

  for (const record of input.records) {
    const live = input.headSites.some((site) => shimCoversSite(record, site));
    if (!live) continue;
    if (!shimIsLive(record, input.today)) {
      fail(
        record.path,
        'compatShims',
        `approved shim window expired at ${record.deadline} while the site still exists — retire it`,
      );
    }
  }

  for (const record of input.records.slice(input.previousRecords)) {
    for (const problem of validateCompatShimFields(record)) {
      fail(record.path, 'compatShims', problem);
    }
    if (!input.newSites.some((site) => shimCoversSite(record, site))) {
      fail(
        record.path,
        'compatShims',
        'shim record does not cover a newly added pass-through site',
      );
    }
    for (const consumer of record.consumers) {
      const code = input.readSource(consumer.file);
      if (code === undefined) {
        fail(consumer.file, `line ${consumer.line}`, 'declared consumer file does not exist');
        continue;
      }
      let references: ConsumerReference[];
      try {
        references = consumerImports(code, consumer.file);
      } catch {
        fail(consumer.file, `line ${consumer.line}`, 'declared consumer file does not parse');
        continue;
      }
      const hit = references.find(
        (reference) =>
          reference.line === consumer.line &&
          reference.kind === 'value' &&
          input.resolveTarget(consumer.file, reference.source) === record.path &&
          (record.symbol === undefined ||
            record.kind === 'module' ||
            reference.symbols.includes(record.symbol) ||
            reference.symbols.includes('*')),
      );
      if (!hit) {
        fail(
          consumer.file,
          `line ${consumer.line}`,
          `no value import of shim ${record.path} at the declared line — consumer evidence must be real`,
        );
      }
    }
  }
  return violations;
}
