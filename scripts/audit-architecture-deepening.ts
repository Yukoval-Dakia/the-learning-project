/* SIZE_OK: YUK-886 (F4.1) — one consolidated quantitative architecture audit keeps one
 * shared parse/import-closure model and one violation vocabulary; every check family
 * below is a section of the same report, not a reusable subsystem. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import type { DependencySnapshot } from './audit-capability-boundaries';

// YUK-885 (F3.11) — architecture-ownership audit, consolidated into the YUK-886
// (F4.1) quantitative architecture-deepening audit.
//
// Consolidated check families (all must pass on the audited head):
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
//      stay kind-branch-free, the central boss book stays housekeeping-only,
//      the central events directory is transport/envelope only, and the
//      central tools directory holds infrastructure only — no concrete tools;
//   6. TaskSpec ownership census — exactly 52 supported TaskSpecs, each with one
//      capability owner, ProfileCriticTask Ingestion-owned with its live CLI
//      caller, no copied central TaskDef, no runtime task locator/discovery;
//   7. DomainTool ownership — every registered tool has one owner, input/output
//      Zod schemas, manifest/registry/allowlist agreement, MCP output validation;
//   8. pg-boss queue ownership — every domain queue is manifest-owned with
//      registration metadata parity; central registrations are housekeeping only;
//   9. proposal lifecycle — every supported proposal kind has one owner and
//      loader-backed accept/dismiss/retract declarations; central kind-switch 0;
//  10. recovery conformance wiring — Notes/Memory recovery and verify-dispatch
//      suites exist in the test universe;
//  11. provider attempt census — every explicit direct lane and opaque Mem0
//      operation is classified, without unknown-as-zero accounting;
//  12. dependency ceilings — totals strictly below 531/70/62 with the
//      server->capability-deep bucket empty and every raw SCC member explained
//      by the bounded public-read catalog.

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

// Central tool INFRASTRUCTURE: registry/bridge/types/allowlists/budgets/
// throttle/registration/test-support — shared machinery, not concrete tools.
const CENTRAL_TOOL_INFRASTRUCTURE = new Set([
  'src/server/ai/tools/registry.ts',
  'src/server/ai/tools/mcp-bridge.ts',
  'src/server/ai/tools/register-capability-tools.ts',
  'src/server/ai/tools/fixtures-assert.ts',
]);

// Central events files that are transport/envelope machinery. Everything else
// under src/server/events/ is a reintroduced central read model.
const CENTRAL_EVENTS_TRANSPORT_FILES = new Set([
  'src/server/events/cascade.ts',
  'src/server/events/listen_loop.ts',
  'src/server/events/sse_replay.ts',
  'src/server/events/sse_router.ts',
  'src/server/events/writer.ts',
]);

export function scanCentralSemanticDefinitions(
  sources: readonly SourceFile[],
): OwnershipViolation[] {
  const byPath = new Map(sources.map((source) => [source.path, source.code]));
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
        'registry must stay a pure static compatibility projection — no prompt builders or task business definitions (copied TaskDef)',
    });
  }
  return violations;
}

export function scanCentralRoots(sources: readonly SourceFile[]): OwnershipViolation[] {
  const byPath = new Map(sources.map((source) => [source.path, source.code]));
  const violations: OwnershipViolation[] = [...scanCentralSemanticDefinitions(sources)];

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

  for (const { path } of sources) {
    if (!path.startsWith('src/server/events/') || TEST_RE.test(path)) continue;
    if (!CENTRAL_EVENTS_TRANSPORT_FILES.has(path)) {
      violations.push({
        path,
        source: '',
        reason:
          'central events code is transport/envelope only — domain event read models live with their owning capability',
      });
    }
  }

  for (const { path } of sources) {
    if (!path.startsWith('src/server/ai/tools/') || TEST_RE.test(path)) continue;
    if (path.endsWith('.ts') && !CENTRAL_TOOL_INFRASTRUCTURE.has(path)) {
      violations.push({
        path,
        source: '',
        reason:
          'central concrete tool — DomainTools live with their owning capability; the central tools directory is infrastructure only (YUK-892)',
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// YUK-886 (F4.1) — TaskSpec ownership census.
// ---------------------------------------------------------------------------

/** Structural shape of one owned TaskSpec (fixture-friendly; the real specs match). */
export interface OwnedTaskSpecShape {
  readonly ownership?: string;
  readonly definition?: { readonly kind?: string } | null;
  readonly parseText?: unknown;
  readonly outputSchema?: { safeParse?: unknown } | null;
}

export interface TaskOwnerMapShape {
  readonly owner: string;
  readonly specs: Readonly<Record<string, OwnedTaskSpecShape>>;
}

export interface TaskSpecCensusOptions {
  readonly expectedCount: number;
  /** Kinds whose owner is pinned by the issue (e.g. ProfileCriticTask -> ingestion). */
  readonly requiredOwnerOfKind?: Readonly<Record<string, string>>;
}

export function scanTaskSpecOwnership(
  ownerMaps: readonly TaskOwnerMapShape[],
  options: TaskSpecCensusOptions,
): OwnershipViolation[] {
  const violations: OwnershipViolation[] = [];
  const kindOwners = new Map<string, string[]>();
  const owners = new Set<string>();
  const definitionSites = new Map<unknown, string>();

  for (const { owner, specs } of ownerMaps) {
    if (owners.has(owner)) {
      violations.push({
        path: owner,
        source: '',
        reason: 'duplicate task owner map — each capability contributes exactly one owner map',
      });
    }
    owners.add(owner);
    for (const [key, spec] of Object.entries(specs)) {
      const registered = kindOwners.get(key) ?? [];
      registered.push(owner);
      kindOwners.set(key, registered);
      if (spec.ownership !== 'owned') {
        violations.push({
          path: `${owner}/${key}`,
          source: '',
          reason: `owned TaskSpec must carry ownership='owned' (got '${String(spec.ownership)}')`,
        });
      }
      const definition = spec.definition;
      if (!isRecord(definition)) {
        violations.push({
          path: `${owner}/${key}`,
          source: '',
          reason: 'owned TaskSpec is missing its definition',
        });
        continue;
      }
      if (definition.kind !== key) {
        violations.push({
          path: `${owner}/${key}`,
          source: String(definition.kind),
          reason: 'owner map key does not match spec.definition.kind',
        });
      }
      if (typeof spec.parseText !== 'function') {
        violations.push({
          path: `${owner}/${key}`,
          source: '',
          reason: 'owned TaskSpec is missing parseText',
        });
      }
      if (
        !isRecord(spec.outputSchema) ||
        typeof (spec.outputSchema as { safeParse?: unknown }).safeParse !== 'function'
      ) {
        violations.push({
          path: `${owner}/${key}`,
          source: '',
          reason: 'owned TaskSpec is missing a Zod outputSchema',
        });
      }
      if (definitionSites.has(definition)) {
        violations.push({
          path: `${owner}/${key}`,
          source: definitionSites.get(definition) ?? '',
          reason: 'copied TaskDef — two owner entries share one definition object',
        });
      } else {
        definitionSites.set(definition, `${owner}/${key}`);
      }
    }
  }

  if (kindOwners.size !== options.expectedCount) {
    violations.push({
      path: 'src/ai/task-catalog.ts',
      source: '',
      reason: `task census: expected exactly ${options.expectedCount} supported TaskSpecs, found ${kindOwners.size}`,
    });
  }
  for (const [kind, registered] of [...kindOwners].sort(([a], [b]) => a.localeCompare(b))) {
    if (registered.length > 1) {
      violations.push({
        path: kind,
        source: registered.join(', '),
        reason: `duplicate owner — task kind is registered by ${registered.length} capabilities`,
      });
    }
  }
  for (const [kind, owner] of Object.entries(options.requiredOwnerOfKind ?? {})) {
    const registered = kindOwners.get(kind) ?? [];
    if (registered.length !== 1 || registered[0] !== owner) {
      violations.push({
        path: kind,
        source: registered.join(', ') || '<missing>',
        reason: `task kind must be owned by '${owner}' (got [${registered.join(', ')}])`,
      });
    }
  }
  return violations;
}

export interface TaskCensusConformanceInput {
  /** Result of scripts/audit-task-census.ts against the audited head. */
  readonly catalogCount: number;
  readonly expectedCount: number;
  readonly errors: readonly string[];
  /** The ProfileCriticTask CLI caller evidence (null = missing). */
  readonly profileCriticCallerPresent: boolean;
  /** Violations from scripts/lib/task-census-guards.ts forbidden-pattern scan. */
  readonly forbiddenPatternViolations: readonly string[];
}

export function scanTaskCensusConformance(input: TaskCensusConformanceInput): OwnershipViolation[] {
  const violations: OwnershipViolation[] = [];
  if (input.catalogCount !== input.expectedCount) {
    violations.push({
      path: 'src/ai/task-catalog.ts',
      source: '',
      reason: `task census: registered ${input.catalogCount} kinds, expected exactly ${input.expectedCount}`,
    });
  }
  for (const error of input.errors) {
    violations.push({
      path: 'task-census',
      source: '',
      reason: error,
    });
  }
  if (!input.profileCriticCallerPresent) {
    violations.push({
      path: 'scripts/compile-profile.ts',
      source: '',
      reason: 'ProfileCriticTask must keep its exact CLI caller (runAgentTask in compile-profile)',
    });
  }
  for (const violation of input.forbiddenPatternViolations) {
    violations.push({
      path: 'src/ai/task-catalog.ts',
      source: '',
      reason: `runtime task locator/discovery: ${violation}`,
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// YUK-886 (F4.1) — DomainTool ownership.
// ---------------------------------------------------------------------------

export interface DomainToolDeclarationShape {
  readonly owner: string;
  readonly name: string;
  readonly hasLoad: boolean;
}

export interface DomainToolShape {
  readonly name: string;
  readonly inputSchema?: { safeParse?: unknown } | null;
  readonly outputSchema?: { safeParse?: unknown } | null;
}

export interface DomainToolOwnershipInput {
  readonly declarations: readonly DomainToolDeclarationShape[];
  readonly loadedTools: readonly DomainToolShape[];
  readonly allowlistNames: readonly string[];
  /** mcp-bridge.ts contains the YUK-862 global output-schema validation wiring. */
  readonly bridgeValidatesOutput: boolean;
}

function isZodLike(value: unknown): value is { safeParse: unknown } {
  return isRecord(value) && typeof value.safeParse === 'function';
}

export function scanDomainToolOwnership(input: DomainToolOwnershipInput): OwnershipViolation[] {
  const violations: OwnershipViolation[] = [];
  const declarationOwners = new Map<string, string[]>();
  for (const declaration of input.declarations) {
    const owners = declarationOwners.get(declaration.name) ?? [];
    owners.push(declaration.owner);
    declarationOwners.set(declaration.name, owners);
    if (!declaration.name.trim()) {
      violations.push({
        path: declaration.owner,
        source: '',
        reason: 'manifest declares a DomainTool with an empty name',
      });
    }
  }
  for (const [name, owners] of [...declarationOwners].sort(([a], [b]) => a.localeCompare(b))) {
    if (owners.length > 1) {
      violations.push({
        path: name,
        source: owners.join(', '),
        reason: `duplicate owner — DomainTool declared by ${owners.length} capabilities`,
      });
    }
    if (!input.allowlistNames.includes(name)) {
      violations.push({
        path: name,
        source: owners.join(', '),
        reason:
          'manifest/registry/allowlist agreement: declared DomainTool is absent from the allowlist universe',
      });
    }
  }
  for (const name of input.allowlistNames) {
    if (!declarationOwners.has(name)) {
      violations.push({
        path: name,
        source: '',
        reason:
          'manifest/registry/allowlist agreement: allowlisted DomainTool has no manifest owner',
      });
    }
  }

  const loadedByName = new Map(input.loadedTools.map((tool) => [tool.name, tool]));
  for (const [name, owners] of declarationOwners) {
    if (!input.declarations.find((d) => d.name === name)?.hasLoad) continue;
    const tool = loadedByName.get(name);
    if (tool === undefined) {
      violations.push({
        path: name,
        source: owners.join(', '),
        reason: 'declared DomainTool loader did not produce a registered tool',
      });
      continue;
    }
    if (!isZodLike(tool.inputSchema)) {
      violations.push({
        path: name,
        source: tool.name,
        reason: 'invalid DomainTool: inputSchema must be a Zod schema',
      });
    }
    if (!isZodLike(tool.outputSchema)) {
      violations.push({
        path: name,
        source: tool.name,
        reason: 'unvalidated DomainTool: outputSchema must be a Zod schema (MCP output validation)',
      });
    }
  }
  for (const tool of input.loadedTools) {
    if (!declarationOwners.has(tool.name)) {
      violations.push({
        path: tool.name,
        source: '',
        reason: 'registry tool has no manifest owner declaration',
      });
    }
  }
  if (!input.bridgeValidatesOutput) {
    violations.push({
      path: 'src/server/ai/tools/mcp-bridge.ts',
      source: '',
      reason: 'MCP bridge must validate every tool output against outputSchema (YUK-862)',
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// YUK-886 (F4.1) — pg-boss queue ownership.
// ---------------------------------------------------------------------------

export interface QueueDeclarationShape {
  readonly owner: string;
  readonly name: string;
  readonly queueTier?: string;
  readonly hasLoad: boolean;
  readonly pollingIntervalSeconds?: number;
  readonly batchSize?: number;
}

export interface CentralQueueLiteralShape {
  readonly path: string;
  readonly api: 'work' | 'send' | 'schedule' | 'create';
  readonly name: string;
}

export interface QueueOwnershipInput {
  readonly declarations: readonly QueueDeclarationShape[];
  readonly centralLiterals: readonly CentralQueueLiteralShape[];
  /** Central book housekeeping queues (echo / prune_* / promote_* / verify-dispatch net). */
  readonly housekeepingQueues: readonly string[];
  /** Module-owned infrastructure queues outside the capability manifests (memory_*). */
  readonly moduleOwnedQueues: readonly string[];
}

const VALID_QUEUE_TIERS = new Set(['llm', 'agent', 'fast']);

export function scanQueueOwnership(input: QueueOwnershipInput): OwnershipViolation[] {
  const violations: OwnershipViolation[] = [];
  const declaredOwners = new Map<string, string[]>();
  for (const declaration of input.declarations) {
    const owners = declaredOwners.get(declaration.name) ?? [];
    owners.push(declaration.owner);
    declaredOwners.set(declaration.name, owners);
    if (declaration.queueTier !== undefined && !VALID_QUEUE_TIERS.has(declaration.queueTier)) {
      violations.push({
        path: declaration.name,
        source: declaration.owner,
        reason: `registration metadata parity: invalid queue tier '${String(declaration.queueTier)}'`,
      });
    }
    if (
      declaration.pollingIntervalSeconds !== undefined &&
      (!(declaration.pollingIntervalSeconds > 0) ||
        !Number.isFinite(declaration.pollingIntervalSeconds))
    ) {
      violations.push({
        path: declaration.name,
        source: declaration.owner,
        reason: 'registration metadata parity: pollingIntervalSeconds must be a positive number',
      });
    }
    if (
      declaration.batchSize !== undefined &&
      (!Number.isSafeInteger(declaration.batchSize) || declaration.batchSize < 1)
    ) {
      violations.push({
        path: declaration.name,
        source: declaration.owner,
        reason: 'registration metadata parity: batchSize must be a positive integer',
      });
    }
  }
  for (const [name, owners] of [...declaredOwners].sort(([a], [b]) => a.localeCompare(b))) {
    if (owners.length > 1) {
      violations.push({
        path: name,
        source: owners.join(', '),
        reason: `duplicate owner — pg-boss queue declared by ${owners.length} capabilities`,
      });
    }
  }

  const housekeeping = new Set(input.housekeepingQueues);
  const moduleOwned = new Set(input.moduleOwnedQueues);
  for (const literal of input.centralLiterals) {
    if (declaredOwners.has(literal.name)) {
      violations.push({
        path: literal.path,
        source: literal.name,
        reason: `central queue literal '${literal.name}' re-registers a manifest-owned queue (registration metadata parity: exactly one registration site)`,
      });
      continue;
    }
    if (housekeeping.has(literal.name) || moduleOwned.has(literal.name)) continue;
    violations.push({
      path: literal.path,
      source: literal.name,
      reason: `central semantic queue registration: '${literal.name}' is neither housekeeping, module-owned, nor manifest-declared`,
    });
  }
  return violations;
}

const QUEUE_LITERAL_RES: readonly { api: CentralQueueLiteralShape['api']; re: RegExp }[] = [
  { api: 'work', re: /\bboss\.work\(\s*['"]([^'"]+)['"]/g },
  { api: 'send', re: /\bboss\.send\(\s*['"]([^'"]+)['"]/g },
  { api: 'schedule', re: /\bboss\.schedule\(\s*['"]([^'"]+)['"]/g },
  { api: 'create', re: /\bcreate(?:Job|OrUpdate)?Queue\(\s*boss,\s*['"]([^'"]+)['"]/g },
];

/** Literal queue names used in central registration/send call sites (non-test). */
export function scanCentralQueueLiterals(
  sources: readonly SourceFile[],
  scannedRoots: readonly string[],
): CentralQueueLiteralShape[] {
  const literals: CentralQueueLiteralShape[] = [];
  for (const { path, code } of sources) {
    if (TEST_RE.test(path)) continue;
    if (!scannedRoots.some((root) => path.startsWith(root))) continue;
    for (const { api, re } of QUEUE_LITERAL_RES) {
      for (const match of code.matchAll(re)) {
        literals.push({ path, api, name: match[1] ?? '' });
      }
    }
  }
  return literals.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.api.localeCompare(right.api) ||
      left.name.localeCompare(right.name),
  );
}

// ---------------------------------------------------------------------------
// YUK-886 (F4.1) — proposal lifecycle ownership.
// ---------------------------------------------------------------------------

export interface ProposalKindDeclarationShape {
  readonly owner: string;
  readonly kind: string;
  readonly hasAccept: boolean;
  readonly hasDismiss: boolean;
  readonly hasRetract: boolean;
}

export interface ProposalLifecycleInput {
  readonly declarations: readonly ProposalKindDeclarationShape[];
  /** Kinds the AiProposalPayload discriminated union supports on this head. */
  readonly supportedKinds: readonly string[];
  /** Kinds whose accept is intentionally unsupported (producer-only proposals). */
  readonly producerOnlyKinds?: readonly string[];
}

export function scanProposalLifecycle(input: ProposalLifecycleInput): OwnershipViolation[] {
  const violations: OwnershipViolation[] = [];
  const kindOwners = new Map<string, string[]>();
  const declarationByKind = new Map<string, ProposalKindDeclarationShape>();
  for (const declaration of input.declarations) {
    const owners = kindOwners.get(declaration.kind) ?? [];
    owners.push(declaration.owner);
    kindOwners.set(declaration.kind, owners);
    declarationByKind.set(declaration.kind, declaration);
  }
  const producerOnly = new Set(input.producerOnlyKinds ?? []);
  for (const [kind, owners] of [...kindOwners].sort(([a], [b]) => a.localeCompare(b))) {
    if (owners.length > 1) {
      violations.push({
        path: kind,
        source: owners.join(', '),
        reason: `duplicate owner — proposal kind declared by ${owners.length} capabilities`,
      });
    }
    if (!input.supportedKinds.includes(kind)) {
      violations.push({
        path: kind,
        source: owners.join(', '),
        reason:
          'phantom proposal kind: declared by a manifest but unsupported by AiProposalPayload',
      });
    }
    const declaration = declarationByKind.get(kind);
    if (declaration && !declaration.hasAccept && !producerOnly.has(kind)) {
      violations.push({
        path: kind,
        source: owners.join(', '),
        reason:
          'supported proposal kind must declare its accept applier through the lifecycle registry (or be classified producer-only)',
      });
    }
  }
  for (const kind of [...input.supportedKinds].sort((a, b) => a.localeCompare(b))) {
    if (!kindOwners.has(kind)) {
      violations.push({
        path: kind,
        source: '',
        reason: 'missing owner — supported proposal kind is not declared by any capability',
      });
    }
  }
  for (const kind of [...producerOnly].sort((a, b) => a.localeCompare(b))) {
    if (kindOwners.has(kind) && declarationByKind.get(kind)?.hasAccept) {
      violations.push({
        path: kind,
        source: '',
        reason: 'stale producer-only classification — the kind declares an accept applier',
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// YUK-886 (F4.1) — recovery conformance wiring + provider attempt census +
// dependency ceilings.
// ---------------------------------------------------------------------------

/** Suites whose presence wires Notes/Memory recovery conformance and verify dispatch. */
export const RECOVERY_CONFORMANCE_SUITES = [
  'src/capabilities/notes/server/note-handoff.db.test.ts',
  'src/capabilities/notes/server/hub-sync-reconciliation.db.test.ts',
  'src/server/memory/memory-reconcile-handoff-recovery.db.test.ts',
  'src/server/memory/reconcile-handler.db.test.ts',
  'src/server/boss/verify-dispatch-outbox.db.test.ts',
] as const;

export function scanRecoveryConformance(existingPaths: readonly string[]): OwnershipViolation[] {
  const existing = new Set(existingPaths);
  return RECOVERY_CONFORMANCE_SUITES.filter((path) => !existing.has(path)).map((path) => ({
    path,
    source: '',
    reason:
      'recovery conformance suite is missing — Notes/Memory recovery and verify dispatch must stay covered',
  }));
}

export interface ProviderAttemptCensusInput {
  /** Violations from scripts/audit-provider-attempt-truth.ts (wrapper/legacy/zero-cost/lane drift). */
  readonly attemptTruthViolations: readonly {
    readonly path: string;
    readonly rule: string;
    readonly detail: string;
  }[];
  /** Census findings classified as explicit direct lanes (non-unclassified). */
  readonly classifiedLaneFindings: number;
  /** Findings the wire census could not classify (must be zero). */
  readonly unclassifiedFindings: number;
}

export function scanProviderAttemptCensus(input: ProviderAttemptCensusInput): OwnershipViolation[] {
  const violations: OwnershipViolation[] = input.attemptTruthViolations.map((violation) => ({
    path: violation.path,
    source: violation.rule,
    reason: `provider attempt census: ${violation.detail}`,
  }));
  if (input.unclassifiedFindings > 0) {
    violations.push({
      path: 'scripts/audit-provider-lanes.ts',
      source: '',
      reason: `provider attempt census: ${input.unclassifiedFindings} unclassified provider wire(s) — every explicit direct lane and opaque Mem0 operation must be identified`,
    });
  }
  if (input.classifiedLaneFindings <= 0) {
    violations.push({
      path: 'scripts/audit-provider-lanes.ts',
      source: '',
      reason:
        'provider attempt census found zero classified lanes — the census must enumerate the explicit direct lanes, not default to zero',
    });
  }
  return violations;
}

export interface DependencyCeilings {
  readonly capabilityToServer: number;
  readonly serverToCapabilityDeep: number;
  readonly crossCapabilityValue: number;
}

/** Issue-pinned strict ceilings: totals must be strictly BELOW each value. */
export const DEPENDENCY_CEILINGS: DependencyCeilings = {
  capabilityToServer: 531,
  serverToCapabilityDeep: 70,
  crossCapabilityValue: 62,
};

export function scanDependencyCeilings(input: {
  readonly totals: DependencyCeilings;
  readonly deepPairCounts: Readonly<Record<string, number>>;
}): OwnershipViolation[] {
  const violations: OwnershipViolation[] = [];
  const checks: readonly [keyof DependencyCeilings, string][] = [
    ['capabilityToServer', 'capability -> server'],
    ['serverToCapabilityDeep', 'server -> capability deep'],
    ['crossCapabilityValue', 'cross-capability value'],
  ];
  for (const [key, label] of checks) {
    if (!(input.totals[key] < DEPENDENCY_CEILINGS[key])) {
      violations.push({
        path: 'scripts/capability-boundary-baseline.json',
        source: label,
        reason: `dependency total ${input.totals[key]} is not strictly below the ceiling ${DEPENDENCY_CEILINGS[key]}`,
      });
    }
  }
  for (const [pair, count] of Object.entries(input.deepPairCounts).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (count > 0) {
      violations.push({
        path: 'scripts/capability-boundary-baseline.json',
        source: pair,
        reason: `targeted owner bucket must be zero: server->capability-deep ${pair} = ${count}`,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Composed audit result.
// ---------------------------------------------------------------------------

export interface ArchitectureDeepeningFacts {
  readonly ownerMaps: readonly TaskOwnerMapShape[];
  readonly taskCensus: TaskCensusConformanceInput;
  readonly expectedTaskCount: number;
  readonly tools: DomainToolOwnershipInput;
  readonly queues: QueueOwnershipInput;
  readonly proposals: ProposalLifecycleInput;
  readonly recoverySuitePaths: readonly string[];
  readonly providerAttemptCensus: ProviderAttemptCensusInput;
  readonly dependency: {
    readonly totals: DependencyCeilings;
    readonly deepPairCounts: Readonly<Record<string, number>>;
    /** Exact-baseline comparison violations from audit-capability-boundaries. */
    readonly baselineViolations: readonly { readonly source: string; readonly reason: string }[];
  };
}

export interface AuditResult {
  ok: boolean;
  violations: OwnershipViolation[];
  sccs: string[][];
  intraSccEdgeCount: number;
  catalogReadFiles: number;
  catalogCommandFiles: number;
}

export interface DeepeningAuditResult extends AuditResult {
  readonly counts: {
    readonly taskSpecs: number;
    readonly domainTools: number;
    readonly manifestQueues: number;
    readonly proposalKinds: number;
    readonly centralSemanticDefinitions: number;
    readonly centralConcreteTools: number;
    readonly centralSemanticQueueRegistrations: number;
    readonly centralKindSwitches: number;
    readonly classifiedProviderLanes: number;
    readonly unclassifiedProviderWires: number;
    readonly recoverySuites: number;
    readonly dependencyTotals: DependencyCeilings;
  };
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
    ...scanCentralRoots(sources),
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

export function auditArchitectureDeepening(
  projectRoot: string,
  catalog: readonly PublicReadCycleEdge[],
  facts: ArchitectureDeepeningFacts,
): DeepeningAuditResult {
  const ownership = auditArchitectureOwnership(projectRoot, catalog);
  const centralLiterals = facts.queues.centralLiterals ?? [];
  const queueOwnershipInput: QueueOwnershipInput = { ...facts.queues, centralLiterals };
  const violations = [
    ...ownership.violations,
    ...scanTaskSpecOwnership(facts.ownerMaps, {
      expectedCount: facts.expectedTaskCount,
      requiredOwnerOfKind: { ProfileCriticTask: 'ingestion' },
    }),
    ...scanTaskCensusConformance(facts.taskCensus),
    ...scanDomainToolOwnership(facts.tools),
    ...scanQueueOwnership(queueOwnershipInput),
    ...scanProposalLifecycle(facts.proposals),
    ...scanRecoveryConformance(facts.recoverySuitePaths),
    ...scanProviderAttemptCensus(facts.providerAttemptCensus),
    ...scanDependencyCeilings(facts.dependency),
    ...facts.dependency.baselineViolations.map((violation) => ({
      path: 'scripts/capability-boundary-baseline.json',
      source: violation.source,
      reason: violation.reason,
    })),
  ];

  const uniqueOwners = new Set(facts.ownerMaps.flatMap((map) => Object.keys(map.specs))).size;
  const centralFiles = violations.filter((violation) =>
    violation.reason.includes('central concrete tool'),
  ).length;
  const centralSemanticQueueRegistrations = violations.filter((violation) =>
    violation.reason.startsWith('central semantic queue registration'),
  ).length;
  const centralKindSwitches = violations.filter((violation) =>
    violation.reason.includes('central proposal-kind dispatch branch'),
  ).length;

  return {
    ...ownership,
    ok: violations.length === 0,
    violations,
    counts: {
      taskSpecs: uniqueOwners,
      domainTools: new Set(facts.tools.declarations.map((d) => d.name)).size,
      manifestQueues: new Set(facts.queues.declarations.map((d) => d.name)).size,
      proposalKinds: new Set(facts.proposals.declarations.map((d) => d.kind)).size,
      centralSemanticDefinitions: violations.filter(
        (violation) =>
          violation.reason.includes('pure static compatibility projection') ||
          violation.reason.includes('semantic quarry'),
      ).length,
      centralConcreteTools: centralFiles,
      centralSemanticQueueRegistrations,
      centralKindSwitches,
      classifiedProviderLanes: facts.providerAttemptCensus.classifiedLaneFindings,
      unclassifiedProviderWires: facts.providerAttemptCensus.unclassifiedFindings,
      recoverySuites: facts.recoverySuitePaths.filter((path) =>
        existsSync(resolve(projectRoot, path)),
      ).length,
      dependencyTotals: facts.dependency.totals,
    },
  };
}

async function runCli(): Promise<void> {
  const { publicReadCycleCatalog } = await import('./capability-public-read-cycles.js');
  const { taskCatalog } = await import('../src/ai/task-catalog.js');
  const { capabilities } = await import('../src/capabilities/index.js');
  const { auditTaskCensus, LIVE_NON_CALLER_CLASSIFICATIONS } = await import(
    './audit-task-census.js'
  );
  const { scanForbiddenTaskCatalogPatterns } = await import('./lib/task-census-guards.js');
  const { collectProviderWireFindings } = await import('./audit-provider-lanes.js');
  const { runProviderAttemptTruthAudit } = await import('./audit-provider-attempt-truth.js');
  const { collectDependencySnapshot, compareDependencySnapshot } = await import(
    './audit-capability-boundaries.js'
  );
  const { READ_TOOLS, PROPOSE_WRITE_TOOLS } = await import('../src/kernel/tools/allowlists.js');
  const { AiProposalPayload } = await import('../src/core/schema/proposal.js');
  const { z } = await import('zod');
  const projectRoot = process.cwd();

  // --- TaskSpec ownership facts -------------------------------------------
  const { practiceTaskSpecs } = await import('../src/capabilities/practice/tasks/index.js');
  const { ingestionTaskSpecs } = await import('../src/capabilities/ingestion/tasks/index.js');
  const { knowledgeTaskSpecs } = await import('../src/capabilities/knowledge/tasks/index.js');
  const { notesTaskSpecs } = await import('../src/capabilities/notes/tasks/index.js');
  const { agencyTaskSpecs } = await import('../src/capabilities/agency/tasks/index.js');
  const { copilotTaskSpecs } = await import('../src/capabilities/copilot/tasks/index.js');
  const ownerMaps = [
    { owner: 'practice', specs: practiceTaskSpecs as Record<string, OwnedTaskSpecShape> },
    { owner: 'ingestion', specs: ingestionTaskSpecs as Record<string, OwnedTaskSpecShape> },
    { owner: 'knowledge', specs: knowledgeTaskSpecs as Record<string, OwnedTaskSpecShape> },
    { owner: 'notes', specs: notesTaskSpecs as Record<string, OwnedTaskSpecShape> },
    { owner: 'agency', specs: agencyTaskSpecs as Record<string, OwnedTaskSpecShape> },
    { owner: 'copilot', specs: copilotTaskSpecs as Record<string, OwnedTaskSpecShape> },
  ];

  const census = auditTaskCensus({
    catalogKinds: Object.keys(taskCatalog),
    sourceRoot: projectRoot,
    nonLiveClassifications: LIVE_NON_CALLER_CLASSIFICATIONS,
  });

  // --- DomainTool facts ----------------------------------------------------
  const toolDeclarations = capabilities.flatMap((cap) =>
    (cap.copilotTools?.tools ?? []).map((tool) => ({
      owner: cap.name,
      name: tool.name,
      hasLoad: Boolean(tool.load),
    })),
  );
  process.env.DATABASE_URL ??= 'postgresql://audit:unused@127.0.0.1:1/audit?sslmode=disable';
  const loadedTools: DomainToolShape[] = [];
  for (const capability of capabilities) {
    for (const decl of capability.copilotTools?.tools ?? []) {
      if (!decl.load) continue;
      const tool = (await decl.load()) as DomainToolShape;
      loadedTools.push({
        name: tool.name,
        inputSchema: tool.inputSchema as { safeParse?: unknown } | null | undefined,
        outputSchema: tool.outputSchema as { safeParse?: unknown } | null | undefined,
      });
    }
  }
  const bridgeSource = readFileSync(
    resolve(projectRoot, 'src/server/ai/tools/mcp-bridge.ts'),
    'utf8',
  );

  // --- queue facts ---------------------------------------------------------
  const queueDeclarations = capabilities.flatMap((cap) =>
    (cap.jobs?.handlers ?? []).map((job) => ({
      owner: cap.name,
      name: job.name,
      queueTier: job.queue,
      hasLoad: Boolean(job.load),
      pollingIntervalSeconds: job.pollingIntervalSeconds,
      batchSize: job.batchSize,
    })),
  );
  const centralSources = [
    ...sourceFilesUnder(projectRoot, resolve(projectRoot, 'src/server/boss')),
    ...sourceFilesUnder(projectRoot, resolve(projectRoot, 'src/server/memory')),
  ];
  const centralLiterals = scanCentralQueueLiterals(centralSources, [
    'src/server/boss/',
    'src/server/memory/',
  ]);

  // --- proposal facts ------------------------------------------------------
  const proposalDeclarations = capabilities.flatMap((cap) =>
    (cap.proposals?.kinds ?? []).map((kind) => ({
      owner: cap.name,
      kind: kind.kind,
      hasAccept: kind.accept !== undefined,
      hasDismiss: kind.dismiss !== undefined,
      hasRetract: kind.retract !== undefined,
    })),
  );
  const supportedKinds =
    AiProposalPayload instanceof z.ZodDiscriminatedUnion
      ? AiProposalPayload.options.map((option) => option.shape.kind.value as string)
      : [];

  // --- provider attempt census ---------------------------------------------
  const attemptTruthViolations = runProviderAttemptTruthAudit(projectRoot);
  const wireFindings = collectProviderWireFindings(projectRoot);
  const unclassifiedFindings = wireFindings.filter(
    (finding) => finding.kind === 'unclassified-provider-fetch',
  ).length;

  // --- dependency facts -----------------------------------------------------
  const { snapshot } = collectDependencySnapshot(projectRoot);
  const baseline = JSON.parse(
    readFileSync(resolve(projectRoot, 'scripts/capability-boundary-baseline.json'), 'utf8'),
  ) as DependencySnapshot;
  const baselineViolations = compareDependencySnapshot(snapshot, baseline);

  const result = auditArchitectureDeepening(projectRoot, publicReadCycleCatalog, {
    ownerMaps,
    expectedTaskCount: 50,
    taskCensus: {
      catalogCount: census.catalogCount,
      expectedCount: 50,
      errors: census.errors,
      profileCriticCallerPresent: census.profileCriticCaller !== null,
      forbiddenPatternViolations: scanForbiddenTaskCatalogPatterns(projectRoot).map(
        (violation) =>
          `${violation.file}:${violation.line}:${violation.column}: ${violation.reason}`,
      ),
    },
    tools: {
      declarations: toolDeclarations,
      loadedTools,
      allowlistNames: [...READ_TOOLS, ...PROPOSE_WRITE_TOOLS],
      bridgeValidatesOutput: bridgeSource.includes('outputSchema.safeParse'),
    },
    queues: {
      declarations: queueDeclarations,
      centralLiterals,
      housekeepingQueues: [
        'echo',
        'prune_job_events',
        'prune_orphan_review_sessions',
        'prune_orphan_placement_sessions',
        'prune_orphan_conversation_sessions',
        'promote_conversation_idle',
        'verify_dispatch_recover',
      ],
      moduleOwnedQueues: ['memory_event_ingest', 'memory_brief_regen', 'memory_reconcile'],
    },
    proposals: {
      declarations: proposalDeclarations,
      supportedKinds,
      producerOnlyKinds: ['archive', 'defer', 'judge_retraction'],
    },
    recoverySuitePaths: [...RECOVERY_CONFORMANCE_SUITES],
    providerAttemptCensus: {
      attemptTruthViolations,
      classifiedLaneFindings: wireFindings.length - unclassifiedFindings,
      unclassifiedFindings,
    },
    dependency: {
      totals: {
        capabilityToServer: snapshot.debts.capabilityToServer.total,
        serverToCapabilityDeep: snapshot.debts.serverToCapabilityDeep.total,
        crossCapabilityValue: snapshot.debts.crossCapabilityValue.total,
      },
      deepPairCounts: snapshot.debts.serverToCapabilityDeep.byOwnerPair,
      baselineViolations: baselineViolations.map((violation) => ({
        source: violation.source,
        reason: violation.reason,
      })),
    },
  });

  if (!result.ok) {
    console.error(
      `Architecture deepening audit failed with ${result.violations.length} violation(s):`,
    );
    for (const violation of result.violations) {
      console.error(`- ${violation.path}: ${violation.source} — ${violation.reason}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Architecture deepening audit passed: ${result.counts.taskSpecs} owned TaskSpecs (census ${census.catalogCount}/${census.discoveredKinds.length} invoked/${Object.keys(census.nonLiveClassifications).length} compatibility); ${result.counts.domainTools} owned DomainTools; ${result.counts.manifestQueues} manifest queues + 0 central semantic registrations; ${result.counts.proposalKinds} owned proposal kinds + 0 central kind switches; 0 central semantic definitions; 0 central concrete tools; SCC [${result.sccs
      .map((component) => component.join('/'))
      .join(
        '; ',
      )}] fully catalogued (${result.intraSccEdgeCount} intra-SCC edge directions; ${result.catalogReadFiles} public-read files, ${result.catalogCommandFiles} command files); ${result.counts.classifiedProviderLanes} classified provider lanes / ${result.counts.unclassifiedProviderWires} unclassified; ${result.counts.recoverySuites}/${RECOVERY_CONFORMANCE_SUITES.length} recovery suites; dependency totals ${result.counts.dependencyTotals.capabilityToServer}/${result.counts.dependencyTotals.serverToCapabilityDeep}/${result.counts.dependencyTotals.crossCapabilityValue} strictly below 531/70/62.`,
  );
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) {
  void runCli();
}
