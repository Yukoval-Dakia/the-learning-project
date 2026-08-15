import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';

// YUK-885 (F3.11) — architecture-ownership audit.
//
// Classifies the capability dependency graph the F3 lanes left behind:
//   1. deep imports — src/server must reach capabilities only through their
//      `public` / `ui-public` ports;
//   2. uncatalogued reciprocal reads — every intra-SCC cross-capability value
//      edge must appear in scripts/capability-public-read-cycles.ts;
//   3. hidden writes — a catalogued public-read consumer file must contain no
//      write signatures (Drizzle insert/update/delete/transaction, boss
//      send/work/schedule, proposal/event writers, provider calls, write or
//      propose tools) and must not consume command symbols;
//   4. directed command cycles — files that legitimately write inside a cycle
//      are classified as command files and must carry a review issue;
//   5. central-root gates — the semantic quarry stays deleted, src/ai/registry
//      stays a pure compatibility projection, the central proposal actions
//      stay kind-branch-free, the central boss handlers stay housekeeping-only,
//      the central events transport exports envelope functions only, and the
//      central tools directory grows no new concrete tool outside the
//      transitional allowlist.

const SOURCE_RE = /\.[cm]?[jt]sx?$/;
const TEST_RE = /\.(?:unit|db|migration|integration|e2e)?\.?(?:test|spec)\.[cm]?[jt]sx?$/;
const PUBLIC_ENTRYPOINTS = new Set(['public', 'ui-public']);

export interface OwnershipViolation {
  path: string;
  source: string;
  reason: string;
}

export interface SourceFile {
  path: string;
  code: string;
}

export interface PublicReadCycleEdge {
  /** Owner of the consumed public port. */
  readonly owner: string;
  /** Consuming capability. */
  readonly consumer: string;
  /** Exact consumer files importing the port (value imports). */
  readonly files: readonly string[];
  /** Public symbols those files consume. */
  readonly symbols: readonly string[];
  /** The DTO / public type the cycle carries. */
  readonly dto: string;
  /** Why this cycle is bounded and acceptable. */
  readonly justification: string;
  /** Linear review issue owning the cycle. */
  readonly reviewIssue: string;
  /** Files inside `files` that legitimately write or consume commands. */
  readonly commandFiles: readonly string[];
}

export interface OwnerEdge {
  from: string;
  to: string;
  file: string;
}

export const WRITE_SIGNATURES: readonly RegExp[] = [
  /\.insert\(/,
  /\.update\(/,
  /\.delete\(/,
  /\.transaction\(/,
  /\bboss\.send\(/,
  /\bboss\.work\(/,
  /\bboss\.schedule\(/,
  /\bwriteEvent\(/,
  /\bwriteAiProposal\(/,
  /\bemitArtifactLifecycleEvent\(/,
  /\brunTask\(/,
  /\brunAgentTask\(/,
  /\bstreamTask\(/,
  /effect:\s*'(?:write|propose)'/,
];

// Public symbols whose names mark them as commands (mutation / LLM / dispatch
// surface) rather than read models. A "read" consumer may not import these.
export const COMMAND_NAME_RE =
  /^(?:accept|apply|archive|propose|create|write|enqueue|spawn|dismiss|retract|promote|merge|upsert|tag|author|induce|dispatch|persist|update)/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

interface ParsedImport {
  source: string;
  symbols: string[];
  typeOnly: boolean;
}

function parseImports(code: string): ParsedImport[] {
  const ast = parse(code, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx', 'dynamicImport', 'importAttributes'],
  });
  const imports: ParsedImport[] = [];

  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isRecord(value)) return;

    if (value.type === 'ImportDeclaration' || value.type === 'ExportNamedDeclaration') {
      const source = stringLiteralValue(value.source);
      if (source) {
        const symbols: string[] = [];
        const typeOnly = value.importKind === 'type' || value.exportKind === 'type';
        if (Array.isArray(value.specifiers)) {
          for (const specifier of value.specifiers) {
            if (!isRecord(specifier)) continue;
            if (specifier.type === 'ImportSpecifier') {
              if (specifier.importKind === 'type') continue; // per-name type import — not a value edge
              const localName =
                isRecord(specifier.local) && typeof specifier.local.name === 'string'
                  ? specifier.local.name
                  : '';
              symbols.push(
                isRecord(specifier.imported) && typeof specifier.imported.name === 'string'
                  ? specifier.imported.name
                  : localName,
              );
            } else {
              symbols.push('*');
            }
          }
        }
        imports.push({ source, symbols, typeOnly });
      }
    } else if (value.type === 'ImportExpression' || value.type === 'CallExpression') {
      const callee = isRecord(value.callee) ? value.callee.type : undefined;
      const isDynamic = value.type === 'ImportExpression' || callee === 'Import';
      const isRequire =
        callee === 'Identifier' && isRecord(value.callee) && value.callee.name === 'require';
      if ((isDynamic || isRequire) && Array.isArray(value.arguments)) {
        const source = stringLiteralValue(value.arguments[0]);
        if (source) imports.push({ source, symbols: ['*'], typeOnly: false });
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (!['loc', 'start', 'end', 'extra'].includes(key)) visit(child);
    }
  }

  visit(ast.program);
  return imports;
}

function capabilityDeepTarget(source: string): string | null {
  const match = /^@\/capabilities\/([^/]+)\/(.*)$/.exec(source);
  if (!match) return null;
  const entrypoint = match[2].replace(/\.[cm]?[jt]sx?$/, '').replace(/\/index$/, '');
  if (PUBLIC_ENTRYPOINTS.has(entrypoint)) return null;
  return source;
}

export function scanDeepImports(sources: readonly SourceFile[]): OwnershipViolation[] {
  const violations: OwnershipViolation[] = [];
  for (const { path, code } of sources) {
    if (TEST_RE.test(path)) continue;
    if (!path.startsWith('src/server/')) continue;
    for (const imported of parseImports(code)) {
      const deep = capabilityDeepTarget(imported.source);
      if (deep) {
        violations.push({
          path,
          source: deep,
          reason: `deep capability import: central code must consume '@/capabilities/<owner>/public' ports only (got '${deep}')`,
        });
      }
    }
  }
  return violations;
}

function ownerOfCapabilityFile(path: string): string | undefined {
  return /^src\/capabilities\/([^/]+)\//.exec(path)?.[1];
}

function publicPortOf(source: string): string | null {
  return /^@\/capabilities\/([^/]+)\/public$/.exec(source)?.[1] ?? null;
}

export function buildOwnerGraph(sources: readonly SourceFile[]): OwnerEdge[] {
  const edges: OwnerEdge[] = [];
  for (const { path, code } of sources) {
    if (TEST_RE.test(path)) continue;
    const from = ownerOfCapabilityFile(path);
    if (!from) continue;
    for (const imported of parseImports(code)) {
      if (imported.typeOnly) continue;
      const to = publicPortOf(imported.source);
      if (!to || to === from) continue;
      edges.push({ from, to, file: path });
    }
  }
  return edges.sort((left, right) => left.file.localeCompare(right.file));
}

function stronglyConnectedComponents(edges: readonly OwnerEdge[]): string[][] {
  const graph = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!graph.has(edge.from)) graph.set(edge.from, new Set());
    if (!graph.has(edge.to)) graph.set(edge.to, new Set());
    graph.get(edge.from)?.add(edge.to);
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
  return components;
}

/** Edges whose endpoints both sit inside one multi-owner SCC (= the cycle body). */
export function collectIntraSccEdges(edges: readonly OwnerEdge[]): OwnerEdge[] {
  const cyclicOwners = new Set(stronglyConnectedComponents(edges).flat());
  return edges.filter((edge) => cyclicOwners.has(edge.from) && cyclicOwners.has(edge.to));
}

export function findUncataloguedReciprocalReads(
  edges: readonly OwnerEdge[],
  catalog: readonly PublicReadCycleEdge[],
): OwnershipViolation[] {
  const filesByDirection = new Map<string, Set<string>>();
  for (const edge of collectIntraSccEdges(edges)) {
    const key = `${edge.from} -> ${edge.to}`;
    filesByDirection.set(key, new Set([...(filesByDirection.get(key) ?? []), edge.file]));
  }
  const catalogByDirection = new Map(
    catalog.map((entry) => [`${entry.consumer} -> ${entry.owner}`, entry]),
  );

  const violations: OwnershipViolation[] = [];
  for (const [direction, files] of [...filesByDirection].sort(([a], [b]) => a.localeCompare(b))) {
    const entry = catalogByDirection.get(direction);
    if (!entry) {
      violations.push({
        path: direction,
        source: '',
        reason:
          'uncatalogued reciprocal read: intra-SCC edge is missing from scripts/capability-public-read-cycles.ts',
      });
      continue;
    }
    const missing = [...files].filter((file) => !entry.files.includes(file)).sort();
    if (missing.length > 0) {
      violations.push({
        path: direction,
        source: missing.join(', '),
        reason: 'uncatalogued reciprocal read: consumer file(s) missing from the catalog entry',
      });
    }
  }
  return violations;
}

function writeSignatureHits(code: string): string[] {
  return WRITE_SIGNATURES.filter((signature) => signature.test(code)).map(String);
}

export function scanCataloguedReads(
  catalog: readonly PublicReadCycleEdge[],
  sources: readonly SourceFile[],
): OwnershipViolation[] {
  const codeByPath = new Map(sources.map((source) => [source.path, source.code]));
  const violations: OwnershipViolation[] = [];

  for (const entry of catalog) {
    const port = `@/capabilities/${entry.owner}/public`;
    const commandFiles = new Set(entry.commandFiles);
    for (const file of commandFiles) {
      if (!entry.files.includes(file)) {
        violations.push({
          path: file,
          source: `${entry.consumer} -> ${entry.owner}`,
          reason: 'commandFiles lists a file outside the entry files',
        });
      }
    }
    for (const file of entry.files) {
      const code = codeByPath.get(file);
      if (code === undefined) {
        violations.push({
          path: file,
          source: `${entry.consumer} -> ${entry.owner}`,
          reason: 'catalog entry names a file that does not exist',
        });
        continue;
      }
      const imported = parseImports(code).find((candidate) => candidate.source === port);
      if (!imported || imported.typeOnly) {
        violations.push({
          path: file,
          source: port,
          reason: 'catalog entry names a file that no longer imports the public port (stale entry)',
        });
        continue;
      }
      if (commandFiles.has(file)) continue;
      const hits = writeSignatureHits(code);
      if (hits.length > 0) {
        violations.push({
          path: file,
          source: `${entry.consumer} -> ${entry.owner}`,
          reason: `catalogued public-read file contains write signatures: ${hits.join(', ')}`,
        });
      }
      const commandSymbols = imported.symbols.filter((symbol) => COMMAND_NAME_RE.test(symbol));
      if (commandSymbols.length > 0) {
        violations.push({
          path: file,
          source: `${entry.consumer} -> ${entry.owner}`,
          reason: `directed command cycle: catalogued read consumes command symbol(s) ${commandSymbols.join(', ')} from the public port`,
        });
      }
    }
  }
  return violations;
}

const CENTRAL_ACTION_FILES = [
  'src/server/proposals/actions.ts',
  'src/server/proposals/accept-action.ts',
  'src/server/proposals/dismiss-action.ts',
  'src/server/proposals/retract-action.ts',
  'src/server/proposals/lifecycle-context.ts',
  'src/server/proposals/owner-runtime.ts',
] as const;

const PROPOSAL_KIND_CASE_RE =
  /case\s+'(?:knowledge_node|knowledge_edge|knowledge_mutation|variant_question|learning_item|completion|relearn|note_update|record_links|record_promotion|goal_scope|block_merge|image_candidate|question_draft|question_edit|conjecture|defer|archive)'\s*:/;

const REGISTRY_SEMANTIC_RES = [
  /\bfunction\s+build\w*Prompt/,
  /\b(?:description|defaultProvider|defaultModel|budget|prompt)\s*:\s*/,
  /DEFAULT_TASK_BUDGET/,
] as const;

const EVENTS_TRANSPORT_EXPORTS = new Set(['newerEventRow', 'takeActiveRows', 'filterActiveRows']);

// Central tool INFRASTRUCTURE: registry/bridge/types/allowlists/budgets/
// throttle/registration/test-support — shared machinery, not concrete tools.
const CENTRAL_TOOL_INFRASTRUCTURE = new Set([
  'src/server/ai/tools/registry.ts',
  'src/server/ai/tools/mcp-bridge.ts',
  'src/server/ai/tools/types.ts',
  'src/server/ai/tools/allowlists.ts',
  'src/server/ai/tools/budgets.ts',
  'src/server/ai/tools/context-throttle.ts',
  'src/server/ai/tools/register-capability-tools.ts',
  'src/server/ai/tools/fixtures-assert.ts',
]);

// YUK-885 transitional allowlist: the central concrete tools that remain until
// their capability migration lands (moving them today would raise dependency
// ratchets and merge copilot into the value SCC — see the PR description).
const CENTRAL_CONCRETE_TOOL_FILES = new Set([
  'src/server/ai/tools/proposal-tools.ts',
  'src/server/ai/tools/context-readers.ts',
  'src/server/ai/tools/get-attempt-context.ts',
  'src/server/ai/tools/query-mistakes.ts',
  'src/server/ai/tools/query-questions.ts',
  'src/server/ai/tools/write-quiz.ts',
  'src/server/ai/tools/tool-quiz-core.ts',
]);

export function scanCentralRoots(
  sources: readonly SourceFile[],
  allowedCentralToolFiles: readonly string[],
): OwnershipViolation[] {
  const byPath = new Map(sources.map((source) => [source.path, source.code]));
  const allowed = new Set(allowedCentralToolFiles);
  const violations: OwnershipViolation[] = [];

  if (byPath.has('src/ai/legacy-task-definitions.ts')) {
    violations.push({
      path: 'src/ai/legacy-task-definitions.ts',
      source: '',
      reason:
        'central semantic quarry must stay deleted (YUK-885); owner TaskSpecs are the only task definitions',
    });
  }

  const registry = byPath.get('src/ai/registry.ts');
  if (registry !== undefined && REGISTRY_SEMANTIC_RES.some((pattern) => pattern.test(registry))) {
    violations.push({
      path: 'src/ai/registry.ts',
      source: '',
      reason:
        'registry must stay a pure static compatibility projection — no prompt builders or task business definitions',
    });
  }

  for (const actionFile of CENTRAL_ACTION_FILES) {
    const code = byPath.get(actionFile);
    if (code !== undefined && PROPOSAL_KIND_CASE_RE.test(code)) {
      violations.push({
        path: actionFile,
        source: '',
        reason:
          'central proposal-kind dispatch branch — accept/dismiss/retract must route through the lifecycle registry only',
      });
    }
  }

  const handlers = byPath.get('src/server/boss/handlers.ts');
  if (handlers !== undefined) {
    for (const imported of parseImports(handlers)) {
      const match = /^@\/capabilities\/([^/]+)\//.exec(imported.source);
      if (match && !imported.typeOnly) {
        violations.push({
          path: 'src/server/boss/handlers.ts',
          source: imported.source,
          reason:
            'central queue registration must stay infrastructure/housekeeping — capability imports are type-only public-port types',
        });
      }
    }
  }

  const queries = byPath.get('src/server/events/queries.ts');
  if (queries !== undefined) {
    const exportRe = /^export (?:async )?function (\w+)/gm;
    for (const match of queries.matchAll(exportRe)) {
      if (!EVENTS_TRANSPORT_EXPORTS.has(match[1] ?? '')) {
        violations.push({
          path: 'src/server/events/queries.ts',
          source: match[1] ?? '',
          reason:
            'central events file must export transport/envelope helpers only — domain read models live with their owning capability',
        });
      }
    }
  }

  for (const { path } of sources) {
    if (!path.startsWith('src/server/ai/tools/') || TEST_RE.test(path)) continue;
    if (
      path.endsWith('.ts') &&
      !CENTRAL_CONCRETE_TOOL_FILES.has(path) &&
      !CENTRAL_TOOL_INFRASTRUCTURE.has(path) &&
      !allowed.has(path)
    ) {
      violations.push({
        path,
        source: '',
        reason:
          'new central concrete tool — DomainTools live with their owning capability; transitional allowlist entries need a review issue',
      });
    }
  }

  return violations;
}

export interface AuditResult {
  ok: boolean;
  violations: OwnershipViolation[];
  sccs: string[][];
  intraSccEdgeCount: number;
  catalogReadFiles: number;
  catalogCommandFiles: number;
}

function sourceFilesUnder(projectRoot: string, dir: string): SourceFile[] {
  if (!existsSync(dir)) return [];
  const files: SourceFile[] = [];
  for (const name of readdirSync(dir)) {
    const path = resolve(dir, name);
    if (statSync(path).isDirectory()) files.push(...sourceFilesUnder(projectRoot, path));
    else if (SOURCE_RE.test(name) && !TEST_RE.test(name)) {
      files.push({
        path: relative(projectRoot, path).split(sep).join('/'),
        code: readFileSync(path, 'utf8'),
      });
    }
  }
  return files;
}

export function auditArchitectureOwnership(
  projectRoot: string,
  catalog: readonly PublicReadCycleEdge[],
  allowedCentralToolFiles: readonly string[] = [],
): AuditResult {
  const sources = [
    ...sourceFilesUnder(projectRoot, resolve(projectRoot, 'src/capabilities')),
    ...sourceFilesUnder(projectRoot, resolve(projectRoot, 'src/server')),
    ...sourceFilesUnder(projectRoot, resolve(projectRoot, 'src/ai')),
  ];
  const edges = buildOwnerGraph(sources);
  const violations = [
    ...scanDeepImports(sources),
    ...findUncataloguedReciprocalReads(edges, catalog),
    ...scanCataloguedReads(catalog, sources),
    ...scanCentralRoots(sources, allowedCentralToolFiles),
  ];
  const commandFiles = new Set(catalog.flatMap((entry) => entry.commandFiles));
  return {
    ok: violations.length === 0,
    violations,
    sccs: stronglyConnectedComponents(edges),
    intraSccEdgeCount: collectIntraSccEdges(edges).length,
    catalogReadFiles: catalog.reduce(
      (count, entry) => count + entry.files.filter((file) => !commandFiles.has(file)).length,
      0,
    ),
    catalogCommandFiles: catalog.reduce((count, entry) => count + entry.commandFiles.length, 0),
  };
}

async function runCli(): Promise<void> {
  const { publicReadCycleCatalog } = await import('./capability-public-read-cycles.js');
  const result = auditArchitectureOwnership(process.cwd(), publicReadCycleCatalog);
  if (!result.ok) {
    console.error(
      `Architecture ownership audit failed with ${result.violations.length} violation(s):`,
    );
    for (const violation of result.violations) {
      console.error(`- ${violation.path}: ${violation.source} — ${violation.reason}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `Architecture ownership audit passed: 0 deep imports; SCC members [${result.sccs
      .map((component) => component.join('/'))
      .join(
        '; ',
      )}] fully catalogued (${result.intraSccEdgeCount} intra-SCC edge directions; ${result.catalogReadFiles} public-read files, ${result.catalogCommandFiles} classified command files).`,
  );
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) {
  void runCli();
}
