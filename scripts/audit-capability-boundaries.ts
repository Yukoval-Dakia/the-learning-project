import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';

const SOURCE_RE = /\.[cm]?[jt]sx?$/;
const TEST_RE = /\.(?:unit|db|migration|integration|e2e)?\.?(?:test|spec)\.[cm]?[jt]sx?$/;
const PUBLIC_ENTRYPOINTS = new Set(['public', 'ui-public']);
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const EDGE_UNIT = 'distinct-source-file-to-resolved-module' as const;

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
}

interface ImportReference {
  source: string;
  kind: DependencyKind;
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

type ModuleLocation = CapabilityLocation | ServerLocation;

interface SemanticDependency {
  sourceFile: string;
  sourceLocation: ModuleLocation;
  targetModule: string;
  targetLocation: ModuleLocation;
  kind: DependencyKind;
}

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

function addReference(
  references: Map<string, DependencyKind>,
  source: string | undefined,
  kind: DependencyKind,
): void {
  if (!source) return;
  const previous = references.get(source);
  references.set(source, previous === 'value' || kind === 'value' ? 'value' : 'type');
}

export function importedReferences(code: string, file: string): ImportReference[] {
  const ast = parse(code, {
    sourceType: 'module',
    sourceFilename: file,
    plugins: ['typescript', 'jsx', 'dynamicImport', 'importAttributes'],
  });
  const references = new Map<string, DependencyKind>();

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
      addReference(references, stringLiteralValue(value.source), declarationKind(value));
    } else if (value.type === 'ImportExpression') {
      const source = stringLiteralValue(value.source);
      if (!source) {
        throw new Error(`${file}: non-literal dynamic import cannot be dependency-audited`);
      }
      addReference(references, source, 'value');
    } else if (value.type === 'TSImportType') {
      addReference(references, stringLiteralValue(value.argument), 'type');
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
        addReference(references, source, 'value');
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (!['loc', 'start', 'end', 'extra'].includes(key)) visit(child);
    }
  }

  visit(ast.program);
  return [...references]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, kind]) => ({ source, kind }));
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

function resolveImportTarget(
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

function locateModule(projectRoot: string, path: string): ModuleLocation | undefined {
  const capabilityRoot = resolve(projectRoot, 'src/capabilities');
  if (isWithin(capabilityRoot, path)) {
    const [owner, entrypoint] = relative(capabilityRoot, path).split(sep);
    if (!owner || !entrypoint) return undefined;
    return {
      layer: 'capability',
      owner,
      entrypoint: withoutExtension(entrypoint),
    };
  }

  const serverRoot = resolve(projectRoot, 'src/server');
  if (isWithin(serverRoot, path)) {
    const [module] = relative(serverRoot, path).split(sep);
    if (!module) return undefined;
    return { layer: 'server', module: withoutExtension(module) };
  }
  return undefined;
}

function collectSemanticDependencies(projectRoot: string): SemanticDependency[] {
  const roots = [resolve(projectRoot, 'src/capabilities'), resolve(projectRoot, 'src/server')];
  const dependencies: SemanticDependency[] = [];

  for (const file of roots.flatMap(sourceFiles).sort()) {
    const sourceLocation = locateModule(projectRoot, file);
    if (!sourceLocation) continue;
    const targets = new Map<string, { kind: DependencyKind; location: ModuleLocation }>();
    for (const reference of importedReferences(readFileSync(file, 'utf8'), file)) {
      const target = resolveImportTarget(projectRoot, file, reference.source);
      if (!target) continue;
      const location = locateModule(projectRoot, target);
      if (!location) continue;
      const previous = targets.get(target);
      targets.set(target, {
        kind: previous?.kind === 'value' || reference.kind === 'value' ? 'value' : 'type',
        location,
      });
    }
    for (const [targetModule, target] of [...targets].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      dependencies.push({
        sourceFile: relative(projectRoot, file),
        sourceLocation,
        targetModule: relative(projectRoot, targetModule),
        targetLocation: target.location,
        kind: target.kind,
      });
    }
  }
  return dependencies;
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
} {
  const capabilityToServer = new Map<string, number>();
  const serverToCapabilityDeep = new Map<string, number>();
  const serverToCapabilityPublic = new Map<string, number>();
  const crossCapabilityValue = new Map<string, number>();
  const crossCapabilityTypeOnly = new Map<string, number>();
  const dependencies = collectSemanticDependencies(projectRoot);

  for (const dependency of dependencies) {
    const { sourceLocation: source, targetLocation: target } = dependency;
    if (source.layer === 'capability' && target.layer === 'server') {
      increment(capabilityToServer, `${source.owner} -> ${target.module}`);
    } else if (source.layer === 'server' && target.layer === 'capability') {
      const pair = `${source.module} -> ${target.owner}`;
      if (PUBLIC_ENTRYPOINTS.has(target.entrypoint)) increment(serverToCapabilityPublic, pair);
      else increment(serverToCapabilityDeep, pair);
    } else if (
      source.layer === 'capability' &&
      target.layer === 'capability' &&
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
      semanticEdges: dependencies.length,
      serverToCapabilityPublic: total(serverToCapabilityPublic),
      serverToCapabilityPublicByOwnerPair: sortedRecord(serverToCapabilityPublic),
      crossCapabilityTypeOnly: total(crossCapabilityTypeOnly),
      crossCapabilityTypeOnlyByOwnerPair: sortedRecord(crossCapabilityTypeOnly),
    },
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
          : `${name} debt decreased: ${current} < baseline ${expected}; tighten the baseline in this change`,
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
  const browserRoots = [resolve(projectRoot, 'web/src'), resolve(projectRoot, 'src/ui')];
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
    ...browserRoots.flatMap(sourceFiles),
  ].sort();
  for (const file of auditedFiles) {
    const sourceLocation = locateModule(projectRoot, file);
    for (const reference of importedReferences(readFileSync(file, 'utf8'), file)) {
      const target = resolveImportTarget(projectRoot, file, reference.source);
      if (!target) continue;
      const targetLocation = locateModule(projectRoot, target);
      if (targetLocation?.layer !== 'capability') continue;
      if (sourceLocation?.layer === 'capability' && sourceLocation.owner === targetLocation.owner) {
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
  const { snapshot, report } = collectDependencySnapshot(projectRoot);
  const violations = [
    ...collectSeamViolations(projectRoot),
    ...(baseline ? compareDependencySnapshot(snapshot, baseline) : []),
  ];
  return {
    ok: violations.length === 0,
    violations,
    dependencySnapshot: snapshot,
    dependencyReport: report,
  };
}

export function serializeDependencySnapshot(snapshot: DependencySnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function readBaseline(projectRoot: string): DependencySnapshot {
  const path = resolve(projectRoot, 'scripts/capability-boundary-baseline.json');
  return JSON.parse(readFileSync(path, 'utf8')) as DependencySnapshot;
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
  const baseline = printBaseline ? undefined : readBaseline(projectRoot);
  const result = auditCapabilityBoundaries(projectRoot, baseline);

  if (printBaseline) {
    if (result.violations.length > 0) {
      printViolations(result.violations);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(serializeDependencySnapshot(result.dependencySnapshot));
    return;
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  if (!result.ok) {
    if (!json) printViolations(result.violations);
    process.exitCode = 1;
    return;
  }
  if (!json) {
    const debts = result.dependencySnapshot.debts;
    console.log(
      `Capability boundary audit passed: 0 deep cross-capability imports; debt ratchets exact (capability->server=${debts.capabilityToServer.total}, server->capability-deep=${debts.serverToCapabilityDeep.total}, cross-capability-value=${debts.crossCapabilityValue.total}).`,
    );
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) main();
