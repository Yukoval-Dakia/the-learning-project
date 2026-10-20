import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import { z } from 'zod';
import {
  type RatchetEdge,
  type RatchetViolation,
  addedEdges,
  auditEdgeRecords,
  auditKernelFacadeConsumption,
  auditKernelReverseEdges,
  compareSccsAgainstBase,
} from './lib/dependency-ratchet';
import {
  lineCountOf,
  listTrackedFiles,
  listTreeFiles,
  readBlobs,
  resolveAuditBaseSha,
  resolveSpecifierInTree,
  worktreeRenameMap,
} from './lib/git-base-scan';
import {
  SIZE_METRIC,
  type SizedFile,
  auditSourceSizeRatchet,
  compatShimSchema,
  edgeRecordSchema,
  inSizeScope,
  sourceSizeRecordSchema,
  stableContractRulingSchema,
} from './lib/source-size';

const SOURCE_RE = /\.[cm]?[jt]sx?$/;
const TEST_RE = /\.(?:unit|db|migration|integration|e2e)?\.?(?:test|spec)\.[cm]?[jt]sx?$/;
const PUBLIC_ENTRYPOINTS = new Set(['public', 'ui-public']);
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const EDGE_UNIT = 'distinct-source-file-to-resolved-module' as const;
const BASELINE_PATH = 'scripts/capability-boundary-baseline.json';
const DEBT_KINDS = [
  'capabilityToServer',
  'serverToCapabilityDeep',
  'crossCapabilityValue',
] as const;
const countSchema = z.number().int().nonnegative();
const debtSchema = z.object({
  total: countSchema,
  byOwnerPair: z.record(z.string(), countSchema),
});
const changeFields = {
  debt: z.enum(DEBT_KINDS),
  pair: z.string().trim().min(1),
  date: z.iso.date(),
  from: countSchema,
  to: countSchema,
};
const raiseJustificationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('offset') }),
  z.object({ kind: z.literal('recorded_ruling'), ruling: z.url({ protocol: /^https?$/ }) }),
  // The only channel that may still raise capabilityToServer / crossCapabilityValue
  // totals: an explicit owner approval carrying the verbatim quote. The audit
  // verifies presence and shape, not authenticity — review must check the link.
  z.object({
    kind: z.literal('owner_approval'),
    approval: z.url({ protocol: /^https?$/ }),
    quote: z.string().trim().min(1),
  }),
]);
const baselineChangeSchema = z
  .discriminatedUnion('direction', [
    z.object({ ...changeFields, direction: z.literal('decrease') }),
    z.object({
      ...changeFields,
      direction: z.literal('increase'),
      reason: z.string().trim().min(1),
      exitCondition: z.string().trim().min(1),
      justification: raiseJustificationSchema,
    }),
  ])
  .refine(
    (change) =>
      change.direction === 'increase' ? change.to > change.from : change.to < change.from,
    { message: 'decrease requires to < from; increase requires to > from' },
  );
const baselineSchema = z.object({
  schemaVersion: z.literal(1),
  edgeUnit: z.literal(EDGE_UNIT),
  notes: z.record(z.string(), z.union([z.string(), baselineChangeSchema])).optional(),
  /** Debt adjustments + stable_contract rulings share one append-only
   *  ledger; rulings are discriminated by `type` and never enter debt math. */
  changes: z.array(z.union([baselineChangeSchema, stableContractRulingSchema])).default([]),
  /** Registration log: every new audited dependency edge needs one entry. */
  edgeRecords: z.array(edgeRecordSchema).default([]),
  /** Registration log: >1000-line growth/crossing/new files (proposal §1.4). */
  sourceSizeRecords: z.array(sourceSizeRecordSchema).default([]),
  /** Coordinator-approved compat shims — max 14-day windows, real consumers. */
  compatShims: z.array(compatShimSchema).default([]),
  debts: z.object({
    capabilityToServer: debtSchema,
    serverToCapabilityDeep: debtSchema,
    crossCapabilityValue: debtSchema.extend({ nontrivialSccs: z.array(z.array(z.string())) }),
  }),
});
type DependencyBaseline = z.infer<typeof baselineSchema>;

export type DependencyKind = 'type' | 'value';

export interface Violation {
  file: string;
  source: string;
  reason: string;
}

export interface DependencyDebt {
  total: number;
  byOwnerPair: Record<string, number>;
}

export interface CrossCapabilityValueDebt extends DependencyDebt {
  nontrivialSccs: string[][];
}

export interface DependencySnapshot {
  schemaVersion: 1;
  edgeUnit: typeof EDGE_UNIT;
  debts: {
    capabilityToServer: DependencyDebt;
    serverToCapabilityDeep: DependencyDebt;
    crossCapabilityValue: CrossCapabilityValueDebt;
  };
}

export interface DependencyReport {
  semanticEdges: number;
  serverToCapabilityPublic: number;
  serverToCapabilityPublicByOwnerPair: Record<string, number>;
  crossCapabilityTypeOnly: number;
  crossCapabilityTypeOnlyByOwnerPair: Record<string, number>;
}

export interface BoundaryAuditResult {
  ok: boolean;
  violations: Violation[];
  dependencySnapshot: DependencySnapshot;
  dependencyReport: DependencyReport;
  dependencies: SemanticDependency[];
  /** Filled in by main() once the base commit is measured. */
  regressions?: {
    sccs: { base: number; head: number };
    newDependencyEdges: number;
    serverEntryNew: { public: number; type: number; blocked: number };
    kernelReverseNew: { value: number; type: number };
    overCeilingFiles: { base: number; head: number };
    overThresholdFiles: { base: number; head: number };
  };
}

interface ImportReference {
  source: string;
  kind: DependencyKind;
  /** Imported/re-exported names; ['*'] for namespace/bare/dynamic edges. */
  symbols: string[];
}

interface CapabilityLocation {
  layer: 'capability';
  owner: string;
  entrypoint: string;
}

interface ServerLocation {
  layer: 'server';
  module: string;
}

export interface SemanticDependency {
  sourceFile: string;
  sourceLocation: ModuleLocation;
  targetModule: string;
  /** Undefined when the target is not a capability/server module (kernel, core, …). */
  targetLocation: ModuleLocation | undefined;
  kind: DependencyKind;
  /** Consumed symbol names; ['*'] for namespace/bare/dynamic edges. */
  symbols: string[];
}

export type ModuleLocation = CapabilityLocation | ServerLocation;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isWithin(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`));
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (SOURCE_RE.test(name) && !TEST_RE.test(name)) files.push(path);
  }
  return files;
}

function stringLiteralValue(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (
    (value.type === 'StringLiteral' || value.type === 'Literal') &&
    typeof value.value === 'string'
  ) {
    return value.value;
  }
  return undefined;
}

function declarationKind(node: Record<string, unknown>): DependencyKind {
  if (node.importKind === 'type' || node.exportKind === 'type') return 'type';
  if (!Array.isArray(node.specifiers) || node.specifiers.length === 0) return 'value';
  return node.specifiers.every(
    (specifier) =>
      isRecord(specifier) && (specifier.importKind === 'type' || specifier.exportKind === 'type'),
  )
    ? 'type'
    : 'value';
}

function nodeName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.name === 'string') return value.name;
  if (typeof value.value === 'string') return value.value;
  return undefined;
}

/** Symbols a static import/export declaration consumes from its source module. */
function specifierSymbols(node: Record<string, unknown>): string[] {
  if (node.type === 'ExportAllDeclaration') return ['*'];
  if (!Array.isArray(node.specifiers) || node.specifiers.length === 0) return ['*'];
  const names: string[] = [];
  for (const specifier of node.specifiers) {
    if (!isRecord(specifier)) continue;
    if (specifier.type === 'ImportSpecifier') {
      names.push(nodeName(specifier.imported) ?? nodeName(specifier.local) ?? '*');
    } else if (specifier.type === 'ExportSpecifier') {
      // `export {x} from 'm'` consumes `x` — the local (source-side) name.
      names.push(nodeName(specifier.local) ?? '*');
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

function addReference(
  references: Map<string, { kind: DependencyKind; symbols: Set<string> }>,
  source: string | undefined,
  kind: DependencyKind,
  symbols: readonly string[],
): void {
  if (!source) return;
  const previous = references.get(source);
  const merged = previous?.symbols ?? new Set<string>();
  for (const symbol of symbols) merged.add(symbol);
  references.set(source, {
    kind: previous?.kind === 'value' || kind === 'value' ? 'value' : 'type',
    symbols: merged,
  });
}

export function importedReferences(code: string, file: string): ImportReference[] {
  const ast = parse(code, {
    sourceType: 'module',
    sourceFilename: file,
    plugins: file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
  });
  const references = new Map<string, { kind: DependencyKind; symbols: Set<string> }>();

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
      addReference(
        references,
        stringLiteralValue(value.source),
        declarationKind(value),
        specifierSymbols(value),
      );
    } else if (value.type === 'ImportExpression') {
      const source = stringLiteralValue(value.source);
      if (!source) {
        throw new Error(`${file}: non-literal dynamic import cannot be dependency-audited`);
      }
      addReference(references, source, 'value', ['*']);
    } else if (value.type === 'TSImportType') {
      addReference(references, stringLiteralValue(value.argument), 'type', ['*']);
    } else if (value.type === 'CallExpression' && isRecord(value.callee)) {
      const isDynamicImport = value.callee.type === 'Import';
      const isRequire = value.callee.type === 'Identifier' && value.callee.name === 'require';
      if ((isDynamicImport || isRequire) && Array.isArray(value.arguments)) {
        const source = stringLiteralValue(value.arguments[0]);
        if (!source) {
          throw new Error(
            `${file}: non-literal ${isDynamicImport ? 'dynamic import' : 'require'} cannot be dependency-audited`,
          );
        }
        addReference(references, source, 'value', ['*']);
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (!['loc', 'start', 'end', 'extra'].includes(key)) visit(child);
    }
  }

  visit(ast.program);
  return [...references]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, entry]) => ({
      source,
      kind: entry.kind,
      symbols: [...entry.symbols].sort(),
    }));
}

function resolveModuleCandidate(base: string): string {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const extension of MODULE_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  if (existsSync(base) && statSync(base).isDirectory()) {
    for (const extension of MODULE_EXTENSIONS) {
      const candidate = resolve(base, `index${extension}`);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return base;
}

export function resolveImportTarget(
  projectRoot: string,
  file: string,
  source: string,
): string | undefined {
  if (source.startsWith('@/')) {
    return resolveModuleCandidate(resolve(projectRoot, 'src', source.slice(2)));
  }
  if (source.startsWith('.')) {
    return resolveModuleCandidate(resolve(dirname(file), source));
  }
  return undefined;
}

function withoutExtension(name: string): string {
  const extension = extname(name);
  return extension ? name.slice(0, -extension.length) : name;
}

/** Locate a module from a repo-relative posix path (worktree file or tree blob). */
export function locateModulePath(path: string): ModuleLocation | undefined {
  if (path.startsWith('src/capabilities/')) {
    const [owner, ...entrypointParts] = path.slice('src/capabilities/'.length).split('/');
    if (!owner || entrypointParts.length === 0) return undefined;
    const lastPart = entrypointParts.at(-1);
    if (!lastPart) return undefined;
    entrypointParts[entrypointParts.length - 1] = withoutExtension(lastPart);
    return {
      layer: 'capability',
      owner,
      entrypoint: entrypointParts.join('/'),
    };
  }

  if (path.startsWith('src/server/')) {
    const [module] = path.slice('src/server/'.length).split('/');
    if (!module) return undefined;
    return { layer: 'server', module: withoutExtension(module) };
  }
  return undefined;
}

function locateModule(projectRoot: string, path: string): ModuleLocation | undefined {
  return locateModulePath(relative(projectRoot, path).split(sep).join('/'));
}

interface SourceInput {
  /** Repo-relative posix path. */
  path: string;
  code: string;
}

function collectDependencies(
  files: readonly SourceInput[],
  resolveTarget: (file: string, source: string) => string | undefined,
): SemanticDependency[] {
  const dependencies: SemanticDependency[] = [];
  for (const { path: file, code } of files) {
    const sourceLocation = locateModulePath(file);
    if (!sourceLocation) continue;
    const targets = new Map<
      string,
      {
        kind: DependencyKind;
        location: ModuleLocation | undefined;
        symbols: Set<string>;
      }
    >();
    for (const reference of importedReferences(code, file)) {
      const target = resolveTarget(file, reference.source);
      if (!target) continue;
      const location = locateModulePath(target);
      const previous = targets.get(target);
      const symbols = previous?.symbols ?? new Set<string>();
      for (const symbol of reference.symbols) symbols.add(symbol);
      targets.set(target, {
        kind: previous?.kind === 'value' || reference.kind === 'value' ? 'value' : 'type',
        location,
        symbols,
      });
    }
    for (const [targetModule, target] of [...targets].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      dependencies.push({
        sourceFile: file,
        sourceLocation,
        targetModule,
        targetLocation: target.location,
        kind: target.kind,
        symbols: [...target.symbols].sort(),
      });
    }
  }
  return dependencies;
}

function posixDirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

const DEPENDENCY_ROOTS = ['src/capabilities', 'src/server'];
const KERNEL_CORE_ROOTS = ['src/kernel', 'src/core'];
/** Top-level composition root + Start frontdoor + the production worker
 *  entry — outside DEPENDENCY_ROOTS so they never feed the src-layer debt
 *  buckets; they get their own port gate. Only these named entry files are
 *  scanned — maintenance scripts stay out of scope. */
const SERVER_ENTRY_ROOTS = ['server', 'scripts/worker.ts'];

function headSourceInputs(projectRoot: string, roots: readonly string[]): SourceInput[] {
  return roots
    .flatMap((root) => {
      const abs = resolve(projectRoot, root);
      if (existsSync(abs) && statSync(abs).isFile()) {
        return SOURCE_RE.test(abs) && !TEST_RE.test(abs) ? [abs] : [];
      }
      return sourceFiles(abs);
    })
    .sort()
    .map((file) => ({
      path: relative(projectRoot, file).split(sep).join('/'),
      code: readFileSync(file, 'utf8'),
    }));
}

function refSourceInputs(
  projectRoot: string,
  ref: string,
  roots: readonly string[],
): { files: SourceInput[]; pathSet: Set<string> } {
  const tree = listTreeFiles(projectRoot, ref, []);
  const pathSet = new Set(tree.map((entry) => entry.path));
  const wanted = tree.filter(
    (entry) =>
      roots.some((root) => entry.path === root || entry.path.startsWith(`${root}/`)) &&
      SOURCE_RE.test(entry.path) &&
      !TEST_RE.test(entry.path),
  );
  const blobs = readBlobs(
    projectRoot,
    ref,
    wanted.map((entry) => entry.path),
  );
  return {
    files: wanted
      .filter((entry) => blobs.has(entry.path))
      .map((entry) => ({ path: entry.path, code: blobs.get(entry.path) ?? '' })),
    pathSet,
  };
}

export function collectSemanticDependencies(projectRoot: string): SemanticDependency[] {
  const resolveTarget = (file: string, source: string) => {
    const target = resolveImportTarget(projectRoot, resolve(projectRoot, file), source);
    return target ? relative(projectRoot, target).split(sep).join('/') : undefined;
  };
  return collectDependencies(headSourceInputs(projectRoot, DEPENDENCY_ROOTS), resolveTarget);
}

/** Same measurement on an immutable base commit: blobs + tree-set resolution. */
export function collectSemanticDependenciesAtRef(
  projectRoot: string,
  ref: string,
): SemanticDependency[] {
  const { files, pathSet } = refSourceInputs(projectRoot, ref, DEPENDENCY_ROOTS);
  return collectDependencies(files, (file, source) =>
    resolveSpecifierInTree(pathSet, posixDirname(file), source),
  );
}

interface ServerEntryEdge {
  file: string;
  module: string;
  kind: DependencyKind;
  symbols: string[];
}

/**
 * Real `server/**` imports into `src/capabilities/**`, measured the same way
 * as DEPENDENCY_ROOTS edges (same parser, same resolution, same merge) so
 * base and head use an identical representation.
 */
function collectServerEntryEdges(
  files: readonly SourceInput[],
  resolveTarget: (file: string, source: string) => string | undefined,
): ServerEntryEdge[] {
  const edges: ServerEntryEdge[] = [];
  for (const { path: file, code } of files) {
    const targets = new Map<string, { kind: DependencyKind; symbols: Set<string> }>();
    for (const reference of importedReferences(code, file)) {
      const target = resolveTarget(file, reference.source);
      if (!target?.startsWith('src/capabilities/')) continue;
      const previous = targets.get(target);
      const symbols = previous?.symbols ?? new Set<string>();
      for (const symbol of reference.symbols) symbols.add(symbol);
      targets.set(target, {
        kind: previous?.kind === 'value' || reference.kind === 'value' ? 'value' : 'type',
        symbols,
      });
    }
    for (const [module, target] of [...targets].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      edges.push({ file, module, kind: target.kind, symbols: [...target.symbols].sort() });
    }
  }
  return edges;
}

function collectServerEntryDependencies(projectRoot: string): ServerEntryEdge[] {
  const resolveTarget = (file: string, source: string) => {
    const target = resolveImportTarget(projectRoot, resolve(projectRoot, file), source);
    return target ? relative(projectRoot, target).split(sep).join('/') : undefined;
  };
  return collectServerEntryEdges(headSourceInputs(projectRoot, SERVER_ENTRY_ROOTS), resolveTarget);
}

/** Same measurement on an immutable base commit. */
function collectServerEntryDependenciesAtRef(projectRoot: string, ref: string): ServerEntryEdge[] {
  const { files, pathSet } = refSourceInputs(projectRoot, ref, SERVER_ENTRY_ROOTS);
  return collectServerEntryEdges(files, (file, source) =>
    resolveSpecifierInTree(pathSet, posixDirname(file), source),
  );
}

export interface ReverseEdge {
  file: string;
  module: string;
  kind: DependencyKind;
}

function collectReverseEdges(
  files: readonly SourceInput[],
  resolveTarget: (file: string, source: string) => string | undefined,
): ReverseEdge[] {
  const merged = new Map<string, DependencyKind>();
  for (const { path: file, code } of files) {
    for (const reference of importedReferences(code, file)) {
      const target = resolveTarget(file, reference.source);
      if (
        !target ||
        (!target.startsWith('src/capabilities/') && !target.startsWith('src/server/'))
      ) {
        continue;
      }
      const key = `${file} -> ${target}`;
      const previous = merged.get(key);
      merged.set(key, previous === 'value' || reference.kind === 'value' ? 'value' : 'type');
    }
  }
  return [...merged]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, kind]) => {
      const splitAt = key.indexOf(' -> ');
      return { file: key.slice(0, splitAt), module: key.slice(splitAt + 4), kind };
    });
}

/** Kernel/core -> capability|server edges in the working tree. */
export function collectKernelReverseEdges(projectRoot: string): ReverseEdge[] {
  const resolveTarget = (file: string, source: string) => {
    const target = resolveImportTarget(projectRoot, resolve(projectRoot, file), source);
    return target ? relative(projectRoot, target).split(sep).join('/') : undefined;
  };
  return collectReverseEdges(headSourceInputs(projectRoot, KERNEL_CORE_ROOTS), resolveTarget);
}

/** Kernel/core -> capability|server edges at an immutable base commit. */
export function collectKernelReverseEdgesAtRef(projectRoot: string, ref: string): ReverseEdge[] {
  const { files, pathSet } = refSourceInputs(projectRoot, ref, KERNEL_CORE_ROOTS);
  return collectReverseEdges(files, (file, source) =>
    resolveSpecifierInTree(pathSet, posixDirname(file), source),
  );
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sortedRecord(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function total(counts: Map<string, number>): number {
  return [...counts.values()].reduce((sum, count) => sum + count, 0);
}

function nontrivialSccs(edges: Iterable<string>): string[][] {
  const graph = new Map<string, Set<string>>();
  for (const edge of edges) {
    const [from, to] = edge.split(' -> ');
    if (!from || !to) continue;
    if (!graph.has(from)) graph.set(from, new Set());
    if (!graph.has(to)) graph.set(to, new Set());
    graph.get(from)?.add(to);
  }

  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  function connect(node: string): void {
    const index = nextIndex++;
    indexes.set(node, index);
    lowLinks.set(node, index);
    stack.push(node);
    onStack.add(node);

    for (const target of [...(graph.get(node) ?? [])].sort()) {
      if (!indexes.has(target)) {
        connect(target);
        lowLinks.set(node, Math.min(lowLinks.get(node) ?? index, lowLinks.get(target) ?? index));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node) ?? index, indexes.get(target) ?? index));
      }
    }

    if (lowLinks.get(node) !== indexes.get(node)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop();
      if (!member) break;
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    if (component.length > 1) components.push(component.sort());
  }

  for (const node of [...graph.keys()].sort()) {
    if (!indexes.has(node)) connect(node);
  }
  return components.sort((left, right) => left.join('/').localeCompare(right.join('/')));
}

export function collectDependencySnapshot(projectRoot: string): {
  snapshot: DependencySnapshot;
  report: DependencyReport;
  dependencies: SemanticDependency[];
} {
  const capabilityToServer = new Map<string, number>();
  const serverToCapabilityDeep = new Map<string, number>();
  const serverToCapabilityPublic = new Map<string, number>();
  const crossCapabilityValue = new Map<string, number>();
  const crossCapabilityTypeOnly = new Map<string, number>();
  const dependencies = collectSemanticDependencies(projectRoot);

  for (const dependency of dependencies) {
    const { sourceLocation: source, targetLocation: target } = dependency;
    if (source.layer === 'capability' && target?.layer === 'server') {
      increment(capabilityToServer, `${source.owner} -> ${target.module}`);
    } else if (source.layer === 'server' && target?.layer === 'capability') {
      const pair = `${source.module} -> ${target.owner}`;
      if (PUBLIC_ENTRYPOINTS.has(target.entrypoint)) increment(serverToCapabilityPublic, pair);
      else increment(serverToCapabilityDeep, pair);
    } else if (
      source.layer === 'capability' &&
      target?.layer === 'capability' &&
      source.owner !== target.owner
    ) {
      const pair = `${source.owner} -> ${target.owner}`;
      increment(dependency.kind === 'value' ? crossCapabilityValue : crossCapabilityTypeOnly, pair);
    }
  }

  return {
    snapshot: {
      schemaVersion: 1,
      edgeUnit: EDGE_UNIT,
      debts: {
        capabilityToServer: {
          total: total(capabilityToServer),
          byOwnerPair: sortedRecord(capabilityToServer),
        },
        serverToCapabilityDeep: {
          total: total(serverToCapabilityDeep),
          byOwnerPair: sortedRecord(serverToCapabilityDeep),
        },
        crossCapabilityValue: {
          total: total(crossCapabilityValue),
          byOwnerPair: sortedRecord(crossCapabilityValue),
          nontrivialSccs: nontrivialSccs(crossCapabilityValue.keys()),
        },
      },
    },
    report: {
      // Preserves the historical meaning: only capability/server-resolved edges.
      semanticEdges: dependencies.filter((dep) => dep.targetLocation !== undefined).length,
      serverToCapabilityPublic: total(serverToCapabilityPublic),
      serverToCapabilityPublicByOwnerPair: sortedRecord(serverToCapabilityPublic),
      crossCapabilityTypeOnly: total(crossCapabilityTypeOnly),
      crossCapabilityTypeOnlyByOwnerPair: sortedRecord(crossCapabilityTypeOnly),
    },
    dependencies,
  };
}

function compareCounts(
  name: string,
  actual: DependencyDebt,
  baseline: DependencyDebt,
): Violation[] {
  const violations: Violation[] = [];
  for (const pair of new Set([
    ...Object.keys(actual.byOwnerPair),
    ...Object.keys(baseline.byOwnerPair),
  ])) {
    const current = actual.byOwnerPair[pair] ?? 0;
    const expected = baseline.byOwnerPair[pair] ?? 0;
    if (current === expected) continue;
    violations.push({
      file: 'scripts/capability-boundary-baseline.json',
      source: pair,
      reason:
        current > expected
          ? `${name} architecture regression: ${current} > baseline ${expected}`
          : `${name} debt decreased: ${current} < baseline ${expected}; run pnpm audit:capability-boundaries --tighten`,
    });
  }
  if (actual.total !== baseline.total) {
    violations.push({
      file: 'scripts/capability-boundary-baseline.json',
      source: name,
      reason: `total is ${actual.total}, baseline is ${baseline.total}`,
    });
  }
  return violations;
}

function canonicalSccs(components: string[][]): string[][] {
  return components
    .filter((component) => component.length > 1)
    .map((component) => [...component].sort())
    .sort((left, right) => left.join('/').localeCompare(right.join('/')));
}

function compareSccs(actual: string[][], baseline: string[][]): Violation[] {
  const current = canonicalSccs(actual);
  const expected = canonicalSccs(baseline);
  if (JSON.stringify(current) === JSON.stringify(expected)) return [];

  const baselineSets = expected.map((component) => new Set(component));
  const grew = current.some(
    (component) =>
      !baselineSets.some((baselineComponent) =>
        component.every((member) => baselineComponent.has(member)),
      ),
  );
  return [
    {
      file: 'scripts/capability-boundary-baseline.json',
      source: 'crossCapabilityValue.nontrivialSccs',
      reason: grew
        ? `cross-capability value SCC grew or a new cycle appeared: ${JSON.stringify(current)}`
        : `cross-capability value SCC shrank: ${JSON.stringify(current)}; tighten the baseline in this change`,
    },
  ];
}

export function compareDependencySnapshot(
  actual: DependencySnapshot,
  baseline: DependencySnapshot,
): Violation[] {
  if (baseline.schemaVersion !== 1 || baseline.edgeUnit !== EDGE_UNIT) {
    return [
      {
        file: 'scripts/capability-boundary-baseline.json',
        source: '',
        reason: `unsupported baseline schema; expected schemaVersion=1 and edgeUnit=${EDGE_UNIT}`,
      },
    ];
  }
  return [
    ...compareCounts(
      'capability -> server',
      actual.debts.capabilityToServer,
      baseline.debts.capabilityToServer,
    ),
    ...compareCounts(
      'server -> capability deep',
      actual.debts.serverToCapabilityDeep,
      baseline.debts.serverToCapabilityDeep,
    ),
    ...compareCounts(
      'cross-capability value',
      actual.debts.crossCapabilityValue,
      baseline.debts.crossCapabilityValue,
    ),
    ...compareSccs(
      actual.debts.crossCapabilityValue.nontrivialSccs,
      baseline.debts.crossCapabilityValue.nontrivialSccs,
    ),
  ];
}

function collectSeamViolations(projectRoot: string): Violation[] {
  const capabilityRoot = resolve(projectRoot, 'src/capabilities');
  const aiRoot = resolve(projectRoot, 'src/ai');
  const browserRoots = [
    resolve(projectRoot, 'web/src'),
    resolve(projectRoot, 'src/ui'),
    resolve(projectRoot, 'src/ui-next'),
  ];
  const violations: Violation[] = [];

  if (existsSync(capabilityRoot)) {
    for (const capability of readdirSync(capabilityRoot).sort()) {
      const capabilityPath = resolve(capabilityRoot, capability);
      if (!statSync(capabilityPath).isDirectory()) continue;
      if (!existsSync(resolve(capabilityPath, 'public.ts'))) {
        violations.push({
          file: relative(projectRoot, capabilityPath),
          source: '',
          reason: "provider capability must own a top-level 'public.ts' entrypoint",
        });
      }
    }
  }

  const auditedFiles = [
    ...sourceFiles(capabilityRoot),
    ...sourceFiles(aiRoot),
    ...browserRoots.flatMap(sourceFiles),
  ].sort();
  for (const file of auditedFiles) {
    const sourceLocation = locateModule(projectRoot, file);
    for (const reference of importedReferences(readFileSync(file, 'utf8'), file)) {
      const target = resolveImportTarget(projectRoot, file, reference.source);
      if (!target) continue;
      if (isWithin(aiRoot, file) && isWithin(capabilityRoot, target)) {
        violations.push({
          file: relative(projectRoot, file),
          source: reference.source,
          reason: 'shared ai must receive an injected catalog, not import capabilities',
        });
        continue;
      }
      const targetLocation = locateModule(projectRoot, target);
      if (targetLocation?.layer !== 'capability') continue;
      if (sourceLocation?.layer === 'capability' && sourceLocation.owner === targetLocation.owner) {
        continue;
      }
      if (
        resolve(file) === resolve(capabilityRoot, 'task-catalog.ts') &&
        targetLocation.entrypoint === 'task-public'
      ) {
        continue;
      }
      if (
        resolve(file) === resolve(capabilityRoot, 'index.ts') &&
        targetLocation.entrypoint === 'manifest'
      ) {
        continue;
      }
      if (sourceLocation?.layer !== 'capability') {
        if (targetLocation.entrypoint !== 'ui-public') {
          violations.push({
            file: relative(projectRoot, file),
            source: reference.source,
            reason: `browser composition may only consume '${targetLocation.owner}/ui-public'`,
          });
        }
        continue;
      }
      if (!PUBLIC_ENTRYPOINTS.has(targetLocation.entrypoint)) {
        violations.push({
          file: relative(projectRoot, file),
          source: reference.source,
          reason: `cross-capability imports must target '${targetLocation.owner}/public' or '${targetLocation.owner}/ui-public'`,
        });
        continue;
      }
      if (
        targetLocation.entrypoint === 'ui-public' &&
        !relative(capabilityRoot, file).split(sep).includes('ui')
      ) {
        violations.push({
          file: relative(projectRoot, file),
          source: reference.source,
          reason: 'ui-public may only be consumed by capability UI code',
        });
      }
    }
  }
  return violations;
}

export function auditCapabilityBoundaries(
  projectRoot: string,
  baseline?: DependencySnapshot,
): BoundaryAuditResult {
  const { snapshot, report, dependencies } = collectDependencySnapshot(projectRoot);
  const violations = [
    ...collectSeamViolations(projectRoot),
    ...(baseline ? compareDependencySnapshot(snapshot, baseline) : []),
  ];
  return {
    ok: violations.length === 0,
    violations,
    dependencySnapshot: snapshot,
    dependencyReport: report,
    dependencies,
  };
}

export function serializeDependencySnapshot(snapshot: DependencySnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export function parseBaseline(text: string, source: string): DependencyBaseline {
  try {
    return baselineSchema.parse(JSON.parse(text));
  } catch (error) {
    const detail =
      error instanceof z.ZodError
        ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`${source}: ${detail}`);
  }
}

export type { DependencyBaseline };

export function readBaselineAtRef(projectRoot: string, ref: string): DependencyBaseline {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return parseBaseline(git(['show', `${ref}:${BASELINE_PATH}`]), `${ref}:${BASELINE_PATH}`);
}

function compareBaselineChanges(
  baseline: DependencyBaseline,
  previous: DependencyBaseline,
  actual: DependencySnapshot,
): Violation[] {
  const violations: Violation[] = [];
  const fail = (source: string, reason: string) =>
    violations.push({ file: BASELINE_PATH, source, reason });
  if (
    JSON.stringify(baseline.changes.slice(0, previous.changes.length)) !==
    JSON.stringify(previous.changes)
  ) {
    fail('changes', 'baseline change history must be append-only');
  }
  for (const ledger of ['edgeRecords', 'sourceSizeRecords', 'compatShims'] as const) {
    if (
      JSON.stringify(baseline[ledger].slice(0, previous[ledger].length)) !==
      JSON.stringify(previous[ledger])
    ) {
      fail(ledger, `${ledger} history must be append-only`);
    }
  }
  const replayed = structuredClone(previous.debts);
  for (const change of baseline.changes.slice(previous.changes.length)) {
    // stable_contract rulings are site classifications, not debt moves —
    // they are validated in audit-architecture-deepening against real sites.
    if ('type' in change) continue;
    const counts = replayed[change.debt].byOwnerPair;
    if ((counts[change.pair] ?? 0) !== change.from) {
      fail(change.pair, `change.from=${change.from} does not match preceding baseline`);
    }
    counts[change.pair] = change.to;
    if (change.direction !== 'increase') continue;
    if (change.debt === 'serverToCapabilityDeep') {
      fail(
        change.pair,
        'serverToCapabilityDeep is a zero boundary — no justification can raise it; the import must go through the capability public module',
      );
      continue;
    }
    if (change.justification.kind === 'offset') {
      const before = previous.debts[change.debt];
      const measured = actual.debts[change.debt];
      const otherPairDecreased = Object.entries(before.byOwnerPair).some(
        ([pair, count]) => pair !== change.pair && (measured.byOwnerPair[pair] ?? 0) < count,
      );
      if (!otherPairDecreased || measured.total > before.total) {
        fail(
          change.pair,
          `${change.debt} offset requires a real decrease in another pair and no net growth from base (${before.total} -> ${measured.total}); otherwise record a coordination ruling`,
        );
      }
      continue;
    }
    if (
      change.justification.kind === 'recorded_ruling' &&
      (change.debt === 'capabilityToServer' || change.debt === 'crossCapabilityValue')
    ) {
      fail(
        change.pair,
        `a coordination ruling cannot raise ${change.debt}; only an owner approval with the verbatim quote can raise this total (and every new edge still needs an edgeRecord)`,
      );
    }
    // owner_approval raises only via explicit owner words; the audit verifies the
    // record's shape (URL + verbatim quote), not the link's authenticity — that
    // check belongs to review.
  }
  for (const debt of DEBT_KINDS) {
    const before = replayed[debt].byOwnerPair;
    const after = baseline.debts[debt].byOwnerPair;
    for (const pair of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const from = before[pair] ?? 0;
      const to = after[pair] ?? 0;
      if (from !== to) {
        fail(
          pair,
          `${debt} baseline ${from} -> ${to} needs a dated ${to > from ? 'increase record with reason, exitCondition and justification' : 'decrease record'} in changes`,
        );
      }
    }
  }
  return violations;
}

function tightenBaseline(baseline: DependencyBaseline, actual: DependencySnapshot): void {
  // Ledger dates are author-local ("the day the record is written"), not UTC —
  // a JST morning lands the day before in UTC and would falsely trip the
  // post-dating guard.
  const date = new Date().toLocaleDateString('en-CA');
  for (const debt of DEBT_KINDS) {
    const counts = baseline.debts[debt].byOwnerPair;
    for (const [pair, from] of Object.entries(counts)) {
      const to = actual.debts[debt].byOwnerPair[pair] ?? 0;
      if (to >= from) continue;
      baseline.changes.push({ debt, pair, date, from, to, direction: 'decrease' });
      if (to === 0) delete counts[pair];
      else counts[pair] = to;
    }
    baseline.debts[debt].total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  }
  const current = actual.debts.crossCapabilityValue.nontrivialSccs;
  const previous = baseline.debts.crossCapabilityValue.nontrivialSccs;
  if (current.every((group) => previous.some((old) => group.every((node) => old.includes(node))))) {
    baseline.debts.crossCapabilityValue.nontrivialSccs = current;
  }
}

/**
 * Audited base->head edges: capability->server (value and type), cross-capability
 * value, and capability->kernel value edges. New edges in these classes must be
 * registered 1:1 in edgeRecords with the consumed symbols and an issue.
 */
function auditedRatchetEdges(dependencies: readonly SemanticDependency[]): RatchetEdge[] {
  const edges: RatchetEdge[] = [];
  for (const dep of dependencies) {
    if (dep.sourceLocation.layer !== 'capability') continue;
    const target = dep.targetLocation;
    if (target?.layer === 'server') {
      edges.push({
        file: dep.sourceFile,
        module: dep.targetModule,
        kind: dep.kind,
        symbols: dep.symbols,
        debt: 'capabilityToServer',
      });
    } else if (
      target?.layer === 'capability' &&
      target.owner !== dep.sourceLocation.owner &&
      dep.kind === 'value'
    ) {
      edges.push({
        file: dep.sourceFile,
        module: dep.targetModule,
        kind: dep.kind,
        symbols: dep.symbols,
        debt: 'crossCapabilityValue',
      });
    } else if (
      target === undefined &&
      dep.targetModule.startsWith('src/kernel/') &&
      dep.kind === 'value'
    ) {
      edges.push({
        file: dep.sourceFile,
        module: dep.targetModule,
        kind: dep.kind,
        symbols: dep.symbols,
        debt: 'capabilityToKernel',
      });
    }
  }
  return edges;
}

/**
 * A new `server/**` edge may reach capabilities only through the approved
 * ports — `public`/`ui-public` entrypoints. A new edge to a private `api/`,
 * `ui/` or `server/` module, or to the `src/capabilities` barrel (a second
 * composition-root entry), fails — regardless of kind; owner ruling gives
 * top-level server no private type-only exemption (the kernel reverse-edge
 * type split is a different direction and does not carry over). Base stock
 * is grandfathered; a type→value upgrade on an existing pair counts as new.
 */
function auditServerEntryEdges(input: {
  base: readonly ServerEntryEdge[];
  head: readonly ServerEntryEdge[];
  renames: ReadonlyMap<string, string>;
}): { violations: RatchetViolation[]; newPublicEdges: number; newTypeEdges: number } {
  const added = addedEdges(input.base, input.head, input.renames);
  const violations: RatchetViolation[] = [];
  let newPublicEdges = 0;
  let newTypeEdges = 0;
  for (const edge of added) {
    const target = locateModulePath(edge.module);
    if (target?.layer === 'capability' && PUBLIC_ENTRYPOINTS.has(target.entrypoint)) {
      newPublicEdges += 1;
      continue;
    }
    if (edge.kind === 'type') newTypeEdges += 1;
    violations.push({
      file: edge.file,
      source: edge.module,
      reason:
        'new server/ entry dependency reaches a capability private module — only capability public/ui-public entrypoints (or kernel ports) are approved ports for new edges',
    });
  }
  return { violations, newPublicEdges, newTypeEdges };
}

function crossValuePairs(dependencies: readonly SemanticDependency[]): string[] {
  const pairs = new Set<string>();
  for (const dep of dependencies) {
    const target = dep.targetLocation;
    if (
      dep.sourceLocation.layer === 'capability' &&
      target?.layer === 'capability' &&
      target.owner !== dep.sourceLocation.owner &&
      dep.kind === 'value'
    ) {
      pairs.add(`${dep.sourceLocation.owner} -> ${target.owner}`);
    }
  }
  return [...pairs];
}

function collectBaseSizeFiles(projectRoot: string, ref: string): SizedFile[] {
  const entries = listTreeFiles(projectRoot, ref, [...SIZE_METRIC.roots]).filter((entry) =>
    inSizeScope(entry.path),
  );
  const blobs = readBlobs(
    projectRoot,
    ref,
    entries.map((entry) => entry.path),
  );
  return entries
    .filter((entry) => blobs.has(entry.path))
    .map((entry) => ({
      path: entry.path,
      lines: lineCountOf(blobs.get(entry.path) ?? ''),
      blob: entry.blob,
    }));
}

function collectHeadSizeFiles(projectRoot: string): SizedFile[] {
  const files: SizedFile[] = [];
  for (const path of listTrackedFiles(projectRoot, [...SIZE_METRIC.roots])) {
    if (!inSizeScope(path)) continue;
    try {
      files.push({
        path,
        lines: lineCountOf(readFileSync(resolve(projectRoot, path), 'utf8')),
        blob: '',
      });
    } catch {
      // Tracked but removed from the worktree (pending deletion).
    }
  }
  return files;
}

function printViolations(violations: Violation[]): void {
  console.error(`Capability boundary audit failed with ${violations.length} violation(s):`);
  for (const violation of violations) {
    console.error(`- ${violation.file}: ${violation.source} — ${violation.reason}`);
  }
}

export function main(argv = process.argv.slice(2), projectRoot = process.cwd()): void {
  const printBaseline = argv.includes('--print-dependency-baseline');
  const json = argv.includes('--json');
  const tighten = argv.includes('--tighten');
  if (printBaseline && tighten)
    throw new Error('Snapshot printing cannot be combined with --tighten.');
  const result = auditCapabilityBoundaries(projectRoot);

  if (printBaseline) {
    if (result.violations.length > 0) {
      printViolations(result.violations);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(serializeDependencySnapshot(result.dependencySnapshot));
    return;
  }
  const baseline = parseBaseline(
    readFileSync(resolve(projectRoot, BASELINE_PATH), 'utf8'),
    BASELINE_PATH,
  );
  const baseIndex = argv.indexOf('--base');
  if (baseIndex !== -1 && !argv[baseIndex + 1]) throw new Error('--base requires a commit SHA.');
  const baseSha = resolveAuditBaseSha(
    projectRoot,
    baseIndex === -1 ? process.env.CAPABILITY_BASE_SHA : argv[baseIndex + 1],
  );
  const previous = readBaselineAtRef(projectRoot, baseSha);
  if (tighten) tightenBaseline(baseline, result.dependencySnapshot);
  result.violations.push(
    ...compareBaselineChanges(baseline, previous, result.dependencySnapshot),
    ...compareDependencySnapshot(result.dependencySnapshot, baseline),
  );

  // Anti-regression ratchets measured against the immutable base commit.
  const today = new Date().toLocaleDateString('en-CA');
  const renames = worktreeRenameMap(projectRoot, baseSha, [
    ...SIZE_METRIC.roots,
    'scripts/worker.ts',
  ]);
  const headEdges = auditedRatchetEdges(result.dependencies);
  const baseDependencies = collectSemanticDependenciesAtRef(projectRoot, baseSha);
  const baseEdges = auditedRatchetEdges(baseDependencies);
  const newEdges = addedEdges(baseEdges, headEdges, renames);
  const headReverse = collectKernelReverseEdges(projectRoot);
  const reverse = auditKernelReverseEdges({
    base: collectKernelReverseEdgesAtRef(projectRoot, baseSha),
    head: headReverse,
    renames,
  });
  const sccs = compareSccsAgainstBase(
    result.dependencySnapshot.debts.crossCapabilityValue.nontrivialSccs,
    nontrivialSccs(crossValuePairs(baseDependencies)),
  );
  const serverEntry = auditServerEntryEdges({
    base: collectServerEntryDependenciesAtRef(projectRoot, baseSha),
    head: collectServerEntryDependencies(projectRoot),
    renames,
  });
  const baseSizes = collectBaseSizeFiles(projectRoot, baseSha);
  const headSizes = collectHeadSizeFiles(projectRoot);
  result.violations.push(
    ...auditEdgeRecords({
      records: baseline.edgeRecords,
      previousRecords: previous.edgeRecords.length,
      head: headEdges,
      added: newEdges,
    }),
    ...sccs.violations,
    ...serverEntry.violations,
    ...reverse.violations,
    ...auditKernelFacadeConsumption({
      added: newEdges,
      kernelReverseValueTargets: new Set(
        headReverse.filter((edge) => edge.kind === 'value').map((edge) => edge.file),
      ),
    }),
    ...auditSourceSizeRatchet({
      base: baseSizes,
      head: headSizes,
      renames,
      records: baseline.sourceSizeRecords,
      previousRecords: previous.sourceSizeRecords.length,
      today,
    }),
  );
  const overCeiling = (files: readonly SizedFile[]) =>
    files.filter((file) => file.lines > SIZE_METRIC.hardCeiling).length;
  const overThreshold = (files: readonly SizedFile[]) =>
    files.filter((file) => file.lines > SIZE_METRIC.registrationThreshold).length;
  result.regressions = {
    sccs: { base: sccs.baseCount, head: sccs.actualCount },
    newDependencyEdges: newEdges.length,
    serverEntryNew: {
      public: serverEntry.newPublicEdges,
      type: serverEntry.newTypeEdges,
      blocked: serverEntry.violations.length,
    },
    kernelReverseNew: { value: reverse.newValueEdges, type: reverse.newTypeEdges },
    overCeilingFiles: { base: overCeiling(baseSizes), head: overCeiling(headSizes) },
    overThresholdFiles: { base: overThreshold(baseSizes), head: overThreshold(headSizes) },
  };
  result.ok = result.violations.length === 0;
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  if (!result.ok) {
    if (!json) printViolations(result.violations);
    process.exitCode = 1;
    return;
  }
  if (tighten) {
    const formatted = execFileSync(
      'pnpm',
      ['exec', 'biome', 'format', '--stdin-file-path', BASELINE_PATH],
      { cwd: projectRoot, input: serializeDependencySnapshot(baseline), encoding: 'utf8' },
    );
    writeFileSync(resolve(projectRoot, BASELINE_PATH), formatted);
  }
  if (!json) {
    const debts = result.dependencySnapshot.debts;
    const regressions = result.regressions;
    console.log(
      `Capability boundary audit passed: 0 deep cross-capability imports; debt ratchets exact (capability->server=${debts.capabilityToServer.total}, server->capability-deep=${debts.serverToCapabilityDeep.total}, cross-capability-value=${debts.crossCapabilityValue.total}); ` +
        `new dependency edges=${regressions?.newDependencyEdges ?? 0}; server-entry new edges=${regressions?.serverEntryNew.public ?? 0} approved/${regressions?.serverEntryNew.blocked ?? 0} blocked/${regressions?.serverEntryNew.type ?? 0} type-only; nontrivial SCCs=${regressions?.sccs.head ?? 0} (base ${regressions?.sccs.base ?? 0}); ` +
        `>${SIZE_METRIC.hardCeiling}-line files=${regressions?.overCeilingFiles.head ?? 0} (base ${regressions?.overCeilingFiles.base ?? 0}).`,
    );
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
