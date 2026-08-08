import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import {
  type DirectImporter,
  type DirectImporterKind,
  PROVIDER_LANES,
  PRUNED_MISCONCEPTION_MODULES,
  type ProviderConfigurationTruth,
  type ProviderLane,
  type SourceEvidence,
  validateProviderLaneInventory,
} from './provider-lane-inventory';

const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(?:unit|db|migration|integration|e2e)?\.?(?:test|spec)\.[cm]?[jt]sx?$/;

export type ProviderWireFinding = {
  readonly kind:
    | 'dashscope-embedding-fetch'
    | 'glm-edge-reconcile-fetch'
    | 'glm-memory-reconcile-fetch'
    | 'glm-ocr-layout-parsing-fetch'
    | 'mem0-model-bearing-operation'
    | 'tencent-question-mark-agent-sdk'
    | 'unclassified-provider-fetch';
  readonly call: string;
  readonly path: string;
};

export type ProviderLaneViolation = {
  readonly path: string;
  readonly reason: string;
};

export type ProviderLaneAuditResult = {
  readonly ok: boolean;
  readonly findings: readonly ProviderWireFinding[];
  readonly violations: readonly ProviderLaneViolation[];
};

type SourceFacts = {
  readonly imports: readonly string[];
  readonly calls: readonly string[];
  readonly envReads: readonly string[];
  readonly literals: readonly string[];
};

type SourceImportEdge = {
  readonly path: string;
  readonly source: string;
  readonly kind: DirectImporterKind;
  readonly target?: string;
};

const SUPPORTED_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root).sort((left, right) => left.localeCompare(right))) {
    const path = resolve(root, entry);
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`${path}: symbolic link found while collecting source files`);
    }
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (SOURCE_FILE.test(entry) && !TEST_FILE.test(entry)) files.push(path);
  }
  return files;
}

function backendSourceFiles(root: string): string[] {
  const files = new Set([
    ...sourceFiles(resolve(root, 'src')),
    ...sourceFiles(resolve(root, 'server')),
  ]);
  for (const entry of ['server/index.ts', 'scripts/worker.ts']) {
    const entryPath = resolve(root, entry);
    if (!existsSync(entryPath)) continue;
    if (lstatSync(entryPath).isSymbolicLink()) {
      throw new Error(`${entryPath}: symbolic link found while collecting source files`);
    }
    files.add(entryPath);
  }
  return [...files]
    .filter((path) => {
      const pathFromProject = projectPath(root, path);
      return (
        pathFromProject.startsWith('server/') ||
        pathFromProject.startsWith('src/server/') ||
        pathFromProject === 'scripts/worker.ts' ||
        (pathFromProject.startsWith('src/capabilities/') && !pathFromProject.includes('/ui/'))
      );
    })
    .sort((left, right) => projectPath(root, left).localeCompare(projectPath(root, right)));
}

function textValue(node: unknown): string | undefined {
  if (!isRecord(node)) return undefined;
  return (node.type === 'StringLiteral' || node.type === 'Literal') &&
    typeof node.value === 'string'
    ? node.value
    : undefined;
}

function callName(callee: unknown): string | undefined {
  if (!isRecord(callee)) return undefined;
  if (callee.type === 'Identifier' && typeof callee.name === 'string') return callee.name;
  if (callee.type !== 'MemberExpression' || callee.computed) return undefined;
  if (!isRecord(callee.object) || callee.object.type !== 'Identifier') return undefined;
  if (!isRecord(callee.property) || callee.property.type !== 'Identifier') return undefined;
  if (typeof callee.object.name !== 'string' || typeof callee.property.name !== 'string')
    return undefined;
  if (
    (callee.object.name === 'globalThis' || callee.object.name === 'global') &&
    callee.property.name === 'fetch'
  ) {
    return 'fetch';
  }
  return `${callee.object.name}.${callee.property.name}`;
}

function globalFetchMemberName(node: unknown): string | undefined {
  if (!isRecord(node) || node.type !== 'MemberExpression' || node.computed) return undefined;
  if (!isRecord(node.object) || node.object.type !== 'Identifier') return undefined;
  if (!isRecord(node.property) || node.property.type !== 'Identifier') return undefined;
  return (node.object.name === 'globalThis' || node.object.name === 'global') &&
    node.property.name === 'fetch'
    ? 'fetch'
    : undefined;
}

function envReadName(node: unknown): string | undefined {
  if (
    !isRecord(node) ||
    (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') ||
    node.computed
  )
    return undefined;
  if (
    !isRecord(node.object) ||
    (node.object.type !== 'MemberExpression' && node.object.type !== 'OptionalMemberExpression') ||
    node.object.computed
  )
    return undefined;
  if (!isRecord(node.object.object) || node.object.object.type !== 'Identifier') return undefined;
  if (!isRecord(node.object.property) || node.object.property.type !== 'Identifier')
    return undefined;
  if (!isRecord(node.property) || node.property.type !== 'Identifier') return undefined;
  return node.object.object.name === 'process' && node.object.property.name === 'env'
    ? typeof node.property.name === 'string'
      ? node.property.name
      : undefined
    : undefined;
}

function helperEnvReadName(node: unknown): string | undefined {
  if (!isRecord(node) || node.type !== 'CallExpression') return undefined;
  if (!isRecord(node.callee) || node.callee.type !== 'Identifier') return undefined;
  if (node.callee.name !== 'optionalEnv' && node.callee.name !== 'requireEnv') return undefined;
  if (!Array.isArray(node.arguments)) return undefined;
  return textValue(node.arguments[1]);
}

function inspectSource(code: string, filename: string): SourceFacts {
  const program = parse(code, {
    sourceType: 'module',
    sourceFilename: filename,
    plugins: ['typescript', 'jsx', 'dynamicImport', 'importAttributes'],
  }).program;
  const imports = new Set<string>();
  const calls: string[] = [];
  const requestAliases = new Map<string, string>();
  const envReads = new Set<string>();
  const literals = new Set<string>();

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isRecord(value)) return;
    const literal = textValue(value);
    if (literal) literals.add(literal);
    if (value.type === 'ImportDeclaration') {
      const source = textValue(value.source);
      if (source) imports.add(source);
    }
    if (value.type === 'VariableDeclarator') {
      if (
        isRecord(value.id) &&
        value.id.type === 'Identifier' &&
        typeof value.id.name === 'string' &&
        isRecord(value.init) &&
        value.init.type === 'Identifier' &&
        typeof value.init.name === 'string'
      ) {
        requestAliases.set(value.id.name, value.init.name);
      }
      if (
        isRecord(value.id) &&
        value.id.type === 'Identifier' &&
        typeof value.id.name === 'string'
      ) {
        const globalFetch = globalFetchMemberName(value.init);
        if (globalFetch) requestAliases.set(value.id.name, globalFetch);
      }
      if (
        isRecord(value.id) &&
        value.id.type === 'ObjectPattern' &&
        isRecord(value.init) &&
        value.init.type === 'Identifier' &&
        (value.init.name === 'globalThis' || value.init.name === 'global') &&
        Array.isArray(value.id.properties)
      ) {
        for (const property of value.id.properties) {
          if (
            !isRecord(property) ||
            property.type !== 'ObjectProperty' ||
            !isRecord(property.key) ||
            property.key.type !== 'Identifier' ||
            property.key.name !== 'fetch' ||
            !isRecord(property.value) ||
            property.value.type !== 'Identifier' ||
            typeof property.value.name !== 'string'
          ) {
            continue;
          }
          requestAliases.set(property.value.name, 'fetch');
        }
      }
    }
    if (value.type === 'CallExpression') {
      const name = callName(value.callee);
      if (name) calls.push(name);
    }
    const envRead = envReadName(value);
    if (envRead) envReads.add(envRead);
    const helperEnvRead = helperEnvReadName(value);
    if (helperEnvRead) envReads.add(helperEnvRead);
    for (const [key, child] of Object.entries(value)) {
      if (!['loc', 'start', 'end', 'extra'].includes(key)) visit(child);
    }
  }

  visit(program);
  return {
    imports: [...imports].sort((left, right) => left.localeCompare(right)),
    calls: calls
      .map((call) => {
        let resolved = call;
        const visited = new Set<string>();
        while (requestAliases.has(resolved) && !visited.has(resolved)) {
          visited.add(resolved);
          resolved = requestAliases.get(resolved) ?? resolved;
        }
        return resolved === 'fetch' || resolved === 'fetchImpl' ? resolved : call;
      })
      .sort((left, right) => left.localeCompare(right)),
    envReads: [...envReads].sort((left, right) => left.localeCompare(right)),
    literals: [...literals].sort((left, right) => left.localeCompare(right)),
  };
}

function stripSupportedExtension(path: string): string {
  const extension = extname(path);
  return SUPPORTED_SOURCE_EXTENSIONS.includes(extension) ? path.slice(0, -extension.length) : path;
}

function importKind(node: Record<string, unknown>): DirectImporterKind {
  if (node.importKind === 'type') return 'type';
  const specifiers = Array.isArray(node.specifiers) ? node.specifiers : [];
  if (
    specifiers.length > 0 &&
    specifiers.every((specifier) => isRecord(specifier) && specifier.importKind === 'type')
  ) {
    return 'type';
  }
  return 'runtime';
}

function resolveImportTarget(root: string, importer: string, source: string): string | undefined {
  const unextended = stripSupportedExtension(
    source.startsWith('@/')
      ? resolve(root, 'src', source.slice(2))
      : source.startsWith('.')
        ? resolve(dirname(importer), source)
        : '',
  );
  if (!unextended) return undefined;
  const candidates = [
    ...SUPPORTED_SOURCE_EXTENSIONS.map((extension) => `${unextended}${extension}`),
    ...SUPPORTED_SOURCE_EXTENSIONS.map((extension) => resolve(unextended, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (lstatSync(candidate).isSymbolicLink()) {
      throw new Error(`${candidate}: symbolic link found while resolving source import`);
    }
    if (statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

function importSourceFiles(root: string): string[] {
  const files = new Set([
    ...sourceFiles(resolve(root, 'src')),
    ...sourceFiles(resolve(root, 'server')),
  ]);
  for (const entry of ['server/index.ts', 'scripts/worker.ts']) {
    const entryPath = resolve(root, entry);
    if (!existsSync(entryPath)) continue;
    if (lstatSync(entryPath).isSymbolicLink()) {
      throw new Error(`${entryPath}: symbolic link found while collecting source files`);
    }
    files.add(entryPath);
  }
  return [...files].sort((left, right) =>
    projectPath(root, left).localeCompare(projectPath(root, right)),
  );
}

function collectImportEdgesFromSource(
  root: string,
  path: string,
  code: string,
): {
  readonly edges: readonly SourceImportEdge[];
  readonly unsupportedDynamicImports: readonly string[];
} {
  const program = parse(code, {
    sourceType: 'module',
    sourceFilename: path,
    plugins: ['typescript', 'jsx', 'dynamicImport', 'importAttributes'],
  }).program;
  const edges: SourceImportEdge[] = [];
  const unsupportedDynamicImports: string[] = [];
  const addEdge = (source: string, kind: DirectImporterKind): void => {
    edges.push({
      path: projectPath(root, path),
      source,
      kind,
      target: resolveImportTarget(root, path, source),
    });
  };
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isRecord(value)) return;
    if (value.type === 'ImportDeclaration') {
      const source = textValue(value.source);
      if (source) addEdge(source, importKind(value));
    }
    if (value.type === 'ExportNamedDeclaration' || value.type === 'ExportAllDeclaration') {
      const source = textValue(value.source);
      if (source) addEdge(source, 're-export');
    }
    if (value.type === 'CallExpression') {
      const argumentsList = Array.isArray(value.arguments) ? value.arguments : [];
      if (isRecord(value.callee) && value.callee.type === 'Import') {
        const source = textValue(argumentsList[0]);
        if (source) addEdge(source, 'dynamic');
        else unsupportedDynamicImports.push(projectPath(root, path));
      }
      if (
        isRecord(value.callee) &&
        value.callee.type === 'Identifier' &&
        value.callee.name === 'require'
      ) {
        const source = textValue(argumentsList[0]);
        if (source) addEdge(source, 'runtime');
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (!['loc', 'start', 'end', 'extra'].includes(key)) visit(child);
    }
  }
  visit(program);
  return { edges, unsupportedDynamicImports };
}

function runtimeSourceClosure(root: string, roots: readonly string[]): string[] {
  const pending = [...roots];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || visited.has(path)) continue;
    visited.add(path);
    const scan = collectImportEdgesFromSource(root, path, readFileSync(path, 'utf8'));
    for (const edge of scan.edges) {
      if (edge.target && edge.kind !== 'type' && !isUiSource(root, edge.target)) {
        pending.push(edge.target);
      }
    }
  }
  return [...visited].sort((left, right) =>
    projectPath(root, left).localeCompare(projectPath(root, right)),
  );
}

function isUiSource(root: string, path: string): boolean {
  const pathFromProject = projectPath(root, path);
  return pathFromProject.startsWith('src/ui/') || pathFromProject.includes('/ui/');
}

function collectProjectImportScan(root: string): {
  readonly edges: readonly SourceImportEdge[];
  readonly unsupportedDynamicImports: readonly string[];
} {
  const scans = runtimeSourceClosure(root, importSourceFiles(root)).map((path) =>
    collectImportEdgesFromSource(root, path, readFileSync(path, 'utf8')),
  );
  return {
    edges: scans
      .flatMap((scan) => scan.edges)
      .sort(
        (left, right) =>
          left.path.localeCompare(right.path) ||
          left.source.localeCompare(right.source) ||
          left.kind.localeCompare(right.kind),
      ),
    unsupportedDynamicImports: scans
      .flatMap((scan) => scan.unsupportedDynamicImports)
      .sort((left, right) => left.localeCompare(right)),
  };
}

export function collectProjectImportEdges(projectRoot: string): readonly SourceImportEdge[] {
  return collectProjectImportScan(resolve(projectRoot)).edges;
}

function importerMultiset(importers: readonly DirectImporter[]): string[] {
  return importers
    .map((importer) => `${importer.path}:${importer.kind}`)
    .sort((left, right) => left.localeCompare(right));
}

function compositionRole(path: string): 'api' | 'worker' | undefined {
  if (/^src\/capabilities\/[^/]+\/api\//.test(path)) return 'api';
  if (/^src\/capabilities\/[^/]+\/jobs\//.test(path)) return 'worker';
  if (path === 'src/server/boss/handlers.ts' || path === 'scripts/worker.ts') return 'worker';
  return undefined;
}

function runtimeRolesForTarget(
  root: string,
  edges: readonly SourceImportEdge[],
  target: string,
): string[] {
  const reachable = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!edge.target || edge.kind === 'type') continue;
    const targets = reachable.get(edge.path) ?? new Set<string>();
    targets.add(projectPath(root, edge.target));
    reachable.set(edge.path, targets);
  }
  const roles = new Set<string>();
  for (const path of importSourceFiles(root).map((file) => projectPath(root, file))) {
    const role = compositionRole(path);
    if (!role) continue;
    const queue = [path];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      if (current === projectPath(root, target)) {
        roles.add(role);
        break;
      }
      for (const next of reachable.get(current) ?? []) queue.push(next);
    }
  }
  return [...roles].sort((left, right) => left.localeCompare(right));
}

function moduleSegment(source: string): string {
  return stripSupportedExtension(basename(source));
}

function projectPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function findingsFor(path: string, code: string, facts: SourceFacts): ProviderWireFinding[] {
  return facts.calls.flatMap((call): ProviderWireFinding[] => {
    if (call === 'memory.add' || call === 'memory.search') {
      return [{ kind: 'mem0-model-bearing-operation', call, path }];
    }
    if (
      facts.imports.includes('tencentcloud-sdk-nodejs-ocr') &&
      (call === 'client.SubmitQuestionMarkAgentJob' ||
        call === 'client.DescribeQuestionMarkAgentJob')
    ) {
      return [{ kind: 'tencent-question-mark-agent-sdk', call, path }];
    }
    if (call !== 'fetch' && call !== 'fetchImpl') return [];
    if (code.includes('/embeddings')) return [{ kind: 'dashscope-embedding-fetch', call, path }];
    if (code.includes('judgeEdgeReconcile') && code.includes('/chat/completions')) {
      return [{ kind: 'glm-edge-reconcile-fetch', call, path }];
    }
    if (code.includes('judgeReconciliation') && code.includes('/chat/completions')) {
      return [{ kind: 'glm-memory-reconcile-fetch', call, path }];
    }
    if (code.includes('layout_parsing'))
      return [{ kind: 'glm-ocr-layout-parsing-fetch', call, path }];
    return [{ kind: 'unclassified-provider-fetch', call, path }];
  });
}

export function collectProviderWireFindings(projectRoot: string): ProviderWireFinding[] {
  return runtimeSourceClosure(projectRoot, backendSourceFiles(projectRoot))
    .flatMap((path) => {
      const code = readFileSync(path, 'utf8');
      return findingsFor(projectPath(projectRoot, path), code, inspectSource(code, path));
    })
    .sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.path.localeCompare(right.path) ||
        left.call.localeCompare(right.call),
    );
}

function checkEvidence(
  root: string,
  evidence: SourceEvidence,
  role: string,
): ProviderLaneViolation | undefined {
  const path = resolve(root, evidence.path);
  if (!existsSync(path))
    return { path: evidence.path, reason: `${role} evidence path does not exist` };
  const code = readFileSync(path, 'utf8');
  const facts = inspectSource(code, path);
  const importsMatch = evidence.imports?.every((source) => facts.imports.includes(source)) ?? true;
  const callsMatch = evidence.calls?.every((call) => facts.calls.includes(call)) ?? true;
  const envReadsMatch = evidence.envReads?.every((name) => facts.envReads.includes(name)) ?? true;
  const literalsMatch =
    evidence.literals?.every((literal) => facts.literals.includes(literal)) ?? true;
  const tokensMatch = evidence.contains?.every((needle) => code.includes(needle)) ?? true;
  if (importsMatch && callsMatch && envReadsMatch && literalsMatch && tokensMatch) return undefined;
  const mismatches = [
    !importsMatch ? 'import' : undefined,
    !callsMatch ? 'call' : undefined,
    !envReadsMatch ? 'env read' : undefined,
    !literalsMatch ? 'literal' : undefined,
    !tokensMatch ? 'token' : undefined,
  ].filter((value): value is string => Boolean(value));
  return {
    path: evidence.path,
    reason: `${role} evidence no longer matches declared ${mismatches.join(', ')}`,
  };
}

function checkConfiguration(
  root: string,
  configuration: ProviderConfigurationTruth,
): ProviderLaneViolation[] {
  const entries = [
    ['configuration endpoint', configuration.endpoint.source],
    ['configuration credential', configuration.credential.source],
    ['configuration model', configuration.model.source],
  ] as const;
  return entries.flatMap((entry): ProviderLaneViolation[] => {
    const violation = checkEvidence(root, entry[1], entry[0]);
    return violation ? [violation] : [];
  });
}

function sameMultiset(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function laneForFinding(kind: ProviderWireFinding['kind']): string | undefined {
  const ids = {
    'dashscope-embedding-fetch': 'dashscope.embedding',
    'glm-edge-reconcile-fetch': 'glm.knowledge-edge-reconcile',
    'glm-memory-reconcile-fetch': 'glm.memory-reconcile',
    'glm-ocr-layout-parsing-fetch': 'glm.ocr-layout-parsing',
    'mem0-model-bearing-operation': 'mem0.event-memory',
    'tencent-question-mark-agent-sdk': 'tencent.question-mark-agent',
  } as const;
  return kind === 'unclassified-provider-fetch' ? undefined : ids[kind];
}

export function auditProviderLanes(
  projectRoot: string,
  lanes: readonly ProviderLane[] = PROVIDER_LANES,
): ProviderLaneAuditResult {
  const root = resolve(projectRoot);
  const findings = collectProviderWireFindings(root);
  const importScan = collectProjectImportScan(root);
  const violations: ProviderLaneViolation[] = validateProviderLaneInventory(lanes).map(
    (reason) => ({
      path: 'scripts/provider-lane-inventory.ts',
      reason,
    }),
  );
  for (const finding of findings) {
    const laneId = laneForFinding(finding.kind);
    const lane = laneId ? lanes.find((candidate) => candidate.id === laneId) : undefined;
    if (!lane || lane.wire.path !== finding.path || !lane.wire.calls.includes(finding.call)) {
      violations.push({
        path: finding.path,
        reason: `unlisted direct provider wire: ${finding.kind}`,
      });
    }
  }
  for (const lane of lanes) {
    if (lane.disposition === 'prune') continue;
    violations.push(...checkConfiguration(root, lane.configuration));
    const observedCalls = findings
      .filter(
        (finding) => laneForFinding(finding.kind) === lane.id && finding.path === lane.wire.path,
      )
      .map((finding) => finding.call)
      .sort((left, right) => left.localeCompare(right));
    const expectedCalls = [...lane.wire.calls].sort((left, right) => left.localeCompare(right));
    if (!sameMultiset(observedCalls, expectedCalls)) {
      violations.push({
        path: lane.wire.path,
        reason: `wire call count drift: expected ${expectedCalls.join(', ')}; observed ${observedCalls.join(', ')}`,
      });
    }
    const wirePath = resolve(root, lane.wire.path);
    const observedImporters = importerMultiset(
      importScan.edges
        .filter((edge) => edge.target === wirePath)
        .map((edge) => ({ path: edge.path, kind: edge.kind })),
    );
    const expectedImporters = importerMultiset(lane.directImporters);
    if (!sameMultiset(observedImporters, expectedImporters)) {
      violations.push({
        path: lane.wire.path,
        reason: `direct importer closure drift: expected ${expectedImporters.join(', ')}; observed ${observedImporters.join(', ')}`,
      });
    }
    const observedRoles = runtimeRolesForTarget(root, importScan.edges, wirePath);
    const expectedRoles = [...lane.roles].sort((left, right) => left.localeCompare(right));
    if (!sameMultiset(observedRoles, expectedRoles)) {
      violations.push({
        path: lane.wire.path,
        reason: `runtime role closure drift: expected ${expectedRoles.join(', ')}; observed ${observedRoles.join(', ')}`,
      });
    }
    for (const [role, evidence] of [
      ['wire', lane.wire],
      ['evidence hook', lane.evidence],
      ...lane.callers.map((caller) => ['caller', caller] as const),
    ] as const) {
      const violation = checkEvidence(root, evidence, role);
      if (violation) violations.push(violation);
    }
  }

  for (const path of importScan.unsupportedDynamicImports) {
    violations.push({
      path,
      reason: 'unsupported dynamic import prevents direct importer closure validation',
    });
  }

  const prunedImportNames = new Set(
    PRUNED_MISCONCEPTION_MODULES.map((path) => moduleSegment(path)),
  );
  for (const module of PRUNED_MISCONCEPTION_MODULES) {
    if (existsSync(resolve(root, module))) {
      violations.push({ path: module, reason: 'pruned module was reintroduced' });
    }
  }
  for (const edge of importScan.edges) {
    if (prunedImportNames.has(moduleSegment(edge.source))) {
      violations.push({
        path: edge.path,
        reason: 'pruned misconception reconcile module is imported',
      });
    }
  }

  const sortedViolations = violations.sort(
    (left, right) => left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason),
  );
  return { ok: sortedViolations.length === 0, findings, violations: sortedViolations };
}

function readProjectRoot(args: readonly string[]): string {
  const index = args.indexOf('--root');
  const root = index >= 0 ? args[index + 1] : undefined;
  if (!root) throw new Error('usage: tsx scripts/audit-provider-lanes.ts --root <project-root>');
  return root;
}

function isCliEntry(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isCliEntry()) {
  const result = auditProviderLanes(readProjectRoot(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
