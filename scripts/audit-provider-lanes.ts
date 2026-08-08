import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import {
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
  return [...files]
    .filter((path) => {
      const pathFromProject = projectPath(root, path);
      return (
        pathFromProject.startsWith('server/') ||
        pathFromProject.startsWith('src/server/') ||
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
  return `${callee.object.name}.${callee.property.name}`;
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
    calls: calls.sort((left, right) => left.localeCompare(right)),
    envReads: [...envReads].sort((left, right) => left.localeCompare(right)),
    literals: [...literals].sort((left, right) => left.localeCompare(right)),
  };
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
  return backendSourceFiles(projectRoot)
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
  return {
    path: evidence.path,
    reason: `${role} evidence no longer matches the declared AST import, call, env read, or literal token`,
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
    for (const [role, evidence] of [
      ['wire', lane.wire],
      ['evidence hook', lane.evidence],
      ...lane.callers.map((caller) => ['caller', caller] as const),
    ] as const) {
      const violation = checkEvidence(root, evidence, role);
      if (violation) violations.push(violation);
    }
  }

  const prunedImportNames = PRUNED_MISCONCEPTION_MODULES.map((path) =>
    basename(path).replace(/\.ts$/, ''),
  );
  for (const module of PRUNED_MISCONCEPTION_MODULES) {
    if (existsSync(resolve(root, module))) {
      violations.push({ path: module, reason: 'pruned module was reintroduced' });
    }
  }
  for (const file of sourceFiles(resolve(root, 'src'))) {
    const facts = inspectSource(readFileSync(file, 'utf8'), file);
    if (
      facts.imports.some((imported) => prunedImportNames.some((name) => imported.endsWith(name)))
    ) {
      violations.push({
        path: projectPath(root, file),
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
