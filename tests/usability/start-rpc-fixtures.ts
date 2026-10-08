import { readFile, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  Page,
  Request as PlaywrightRequest,
  Response as PlaywrightResponse,
  Route,
} from '@playwright/test';
import { createDefaultSerovalPlugins } from '@tanstack/react-router/ssr/client';
import { z } from 'zod';
import { AgentNotesQuerySchema } from '../../src/capabilities/agency/api/contracts';
import { ProposalDecisionInput, ProposalDecisionResource } from '../../src/core/schema/proposal';

type FixtureRequest = Pick<
  PlaywrightRequest,
  'url' | 'method' | 'headers' | 'postData' | 'postDataJSON'
>;
export type FixtureRoute = Pick<Route, 'fallback' | 'fulfill'> & { request: () => FixtureRequest };
type FixtureHandler = (route: FixtureRoute) => Promise<void> | void;
type Fulfillment = NonNullable<Parameters<Route['fulfill']>[0]>;

const reads = {
  getStartEventDetail: '/api/events',
  getStartAgentNoteBoard: '/api/agents/notes',
  getStartWorkbenchSummary: '/api/workbench/summary',
  getStartOvernightDigest: '/api/workbench/overnight-digest',
  getStartTodayCost: '/api/cost/today',
  getStartAutoApplied: '/api/proposals/auto-applied',
  getStartKnowledgeTree: '/api/knowledge',
  getStartConjectures: '/api/prep-desk/conjectures',
  getStartRecentAiChanges: '/api/artifacts/ai-changes/recent',
  getStartProposalInbox: '/api/proposals',
  getStartMistakes: '/api/mistakes',
  getStartAdminRuns: '/api/admin/runs',
  getStartAdminRunDetail: '/api/admin/runs',
  getStartAdminCost: '/api/admin/cost',
  getStartAdminFailures: '/api/admin/failures',
  getStartAdminCoverage: '/api/admin/coverage-lattice',
  getStartAdminConjectureScores: '/api/admin/conjecture-scores',
  getStartAdminConfig: '/api/admin/config',
  getStartAdminSubjects: '/api/admin/subjects',
};
const controls = {
  patchStartAdminConfig: { scope: 'config', method: 'PATCH', suffix: '' },
  resetStartAdminConfig: { scope: 'config', method: 'POST', suffix: '/reset' },
  getStartAdminSubjectTraits: { scope: 'subject', method: 'GET', suffix: '/traits' },
  getStartAdminTraits: { scope: 'catalog', method: 'GET', suffix: '' },
  getStartAdminTraitJournal: { scope: 'trait', method: 'GET', suffix: '/journal' },
  renameStartAdminSubject: { scope: 'subject', method: 'PATCH', suffix: '' },
  retireStartAdminSubject: { scope: 'subject', method: 'POST', suffix: '/retire' },
  restoreStartAdminSubject: { scope: 'subject', method: 'POST', suffix: '/restore' },
  resetStartAdminSubject: { scope: 'subject', method: 'POST', suffix: '/reset' },
  validateStartAdminSubject: { scope: 'subject', method: 'POST', suffix: '/validate' },
  editStartAdminSubjectTrait: { scope: 'subject-trait', method: 'PUT', suffix: '' },
  forkStartAdminSubjectTrait: { scope: 'subject-trait', method: 'POST', suffix: '/fork' },
  rebindStartAdminSubjectTrait: { scope: 'subject-trait', method: 'PUT', suffix: '/binding' },
  editStartAdminSharedTrait: { scope: 'trait', method: 'PUT', suffix: '' },
  rollbackStartAdminTrait: { scope: 'trait', method: 'POST', suffix: '/rollback' },
  resetStartAdminTraitToSeed: { scope: 'trait', method: 'POST', suffix: '/reset-to-seed' },
} as const;
const names = [
  ...Object.keys(reads),
  ...Object.keys(controls),
  'decideStartProposal',
  'undoStartArtifactAiChange',
  'postStartEventCorrection',
];
const traitWrites = new Set([
  'editStartAdminSubjectTrait',
  'forkStartAdminSubjectTrait',
  'rebindStartAdminSubjectTrait',
  'editStartAdminSharedTrait',
  'rollbackStartAdminTrait',
  'resetStartAdminTraitToSeed',
]);
const queryNames = new Set([
  'getStartProposalInbox',
  'getStartMistakes',
  'getStartAdminRuns',
  'getStartAdminCost',
  'getStartAdminFailures',
]);
const jsonStringNames = new Set([
  'getStartProposalInbox',
  'decideStartProposal',
  'getStartAdminConfig',
  'getStartAdminSubjectTraits',
  'getStartEventDetail',
]);
const Payload = z
  .object({ data: z.unknown().optional(), context: z.record(z.string(), z.unknown()).optional() })
  .strict();
const Query = z.record(z.string(), z.string().optional());
const Decision = z.object({ id: z.string().min(1), input: ProposalDecisionInput }).strict();
const Undo = z.object({ artifactId: z.string().min(1), eventId: z.string().min(1) }).strict();
const SerializerOptions = z.object({ plugins: z.array(z.unknown()) });
const Serializer = z.object({
  fromJSON: z.function({ input: z.tuple([z.unknown(), SerializerOptions]), output: z.unknown() }),
  fromCrossJSON: z.function({
    input: z.tuple([z.unknown(), SerializerOptions]),
    output: z.unknown(),
  }),
  toCrossJSONAsync: z.function({
    input: z.tuple([z.unknown(), SerializerOptions]),
    output: z.promise(z.unknown()),
  }),
});

let serializerPromise: Promise<z.infer<typeof Serializer>> | undefined;
async function serializer() {
  serializerPromise ??= (async () => {
    const entry = await realpath(
      fileURLToPath(import.meta.resolve('@tanstack/react-start/client-rpc')),
    );
    const require = createRequire(
      createRequire(entry).resolve('@tanstack/start-client-core/package.json'),
    );
    // Resolve Start's actual dependency, including pnpm isolation. No parallel serializer or new dependency.
    const module: unknown = await import(pathToFileURL(require.resolve('seroval')).href);
    return Serializer.parse(module);
  })();
  return serializerPromise;
}
const plugins = () => ({ plugins: createDefaultSerovalPlugins() });

export function parseBuiltFunctionMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const seen = new Set<string>();
  for (const match of text.matchAll(
    /"([a-f0-9]{64})"\s*:\s*\{\s*functionName:\s*"([A-Za-z0-9_]+)_createServerFn_handler"/g,
  )) {
    const [, id, name] = match;
    if (!id || !name || map.has(id) || seen.has(name))
      throw new Error('Duplicate built Start function ID/name');
    map.set(id, name);
    seen.add(name);
  }
  for (const name of names)
    if (!seen.has(name)) throw new Error(`Built Start resolver is missing ${name}`);
  return map;
}

export async function loadBuiltFunctionMap(root = process.cwd()): Promise<Map<string, string>> {
  const assets = join(root, 'dist/start/server/assets');
  const candidates = (await readdir(assets)).filter(
    (name) => name.includes('server-fn-resolver') && name.endsWith('.js'),
  );
  if (candidates.length !== 1 || !candidates[0])
    throw new Error('Expected exactly one emitted Start RPC resolver. Run pnpm build first.');
  return parseBuiltFunctionMap(await readFile(join(assets, candidates[0]), 'utf8'));
}

export async function decodeRpcRequest(request: FixtureRequest, map: Map<string, string>) {
  const url = new URL(request.url());
  const id = url.pathname.match(/^\/_serverFn\/([a-f0-9]{64})$/)?.[1];
  const name = id ? map.get(id) : undefined;
  if (!name || !names.includes(name)) throw new Error(`Unknown built Start RPC ${url.pathname}`);
  const control = Object.entries(controls).find(([key]) => key === name)?.[1];
  const method =
    name === 'decideStartProposal' ||
    name === 'undoStartArtifactAiChange' ||
    name === 'postStartEventCorrection' ||
    (control && control.method !== 'GET')
      ? 'POST'
      : 'GET';
  if (request.method() !== method || request.headers()['x-tsr-serverfn'] !== 'true')
    throw new Error(`Invalid Start RPC method/header for ${name}`);
  const encoded = method === 'GET' ? url.searchParams.get('payload') : request.postData();
  const payload = Payload.parse(
    encoded ? (await serializer()).fromJSON(JSON.parse(encoded), plugins()) : {},
  );
  let body: unknown;
  let httpMethod: string = method;
  url.search = '';
  if (name === 'getStartEventDetail' || name === 'postStartEventCorrection') {
    const event = z
      .object({ id: z.string().trim().min(1), input: z.unknown().optional() })
      .parse(payload.data);
    url.pathname = `/api/events/${encodeURIComponent(event.id)}${name === 'postStartEventCorrection' ? '/corrections' : ''}`;
    if (name === 'postStartEventCorrection') body = event.input;
  } else if (control) {
    const input = z.record(z.string(), z.unknown()).parse(payload.data ?? {});
    const id = (key: string) => encodeURIComponent(z.string().trim().min(1).parse(input[key]));
    httpMethod = control.method;
    if (control.scope === 'config') url.pathname = `/api/admin/config${control.suffix}`;
    else if (control.scope === 'catalog') url.pathname = '/api/admin/traits';
    else if (control.scope === 'subject')
      url.pathname = `/api/admin/subjects/${id('subjectId')}${control.suffix}`;
    else if (control.scope === 'subject-trait')
      url.pathname = `/api/admin/subjects/${id('subjectId')}/traits/${id('kind')}${control.suffix}`;
    else url.pathname = `/api/admin/traits/${id('traitId')}${control.suffix}`;
    if (control.method === 'GET') {
      for (const key of control.scope === 'catalog'
        ? ['kind']
        : control.scope === 'trait'
          ? ['limit', 'cursor']
          : []) {
        if (input[key] !== undefined) url.searchParams.set(key, z.string().parse(input[key]));
      }
    } else {
      const { subjectId: _subject, traitId: _trait, kind: _kind, ...remaining } = input;
      body = remaining;
    }
  } else if (name === 'decideStartProposal') {
    const decision = Decision.parse(payload.data);
    url.pathname = `/api/proposals/${encodeURIComponent(decision.id)}/decisions`;
    body = decision.input;
  } else if (name === 'undoStartArtifactAiChange') {
    const undo = Undo.parse(payload.data);
    url.pathname = `/api/artifacts/${encodeURIComponent(undo.artifactId)}/ai-changes/${encodeURIComponent(undo.eventId)}/undo`;
  } else if (name === 'getStartAdminRunDetail') {
    const detail = z
      .object({ id: z.string().min(1) })
      .strict()
      .parse(payload.data);
    url.pathname = `/api/admin/runs/${encodeURIComponent(detail.id)}`;
  } else {
    const path = Object.entries(reads).find(([key]) => key === name)?.[1];
    if (!path) throw new Error(`No fixture operation for ${name}`);
    url.pathname = path;
  }
  if (name === 'getStartAgentNoteBoard') {
    const input = AgentNotesQuerySchema.parse(payload.data ?? {});
    if (input.limit !== undefined) url.searchParams.set('limit', String(input.limit));
  } else if (queryNames.has(name)) {
    for (const [key, value] of Object.entries(Query.parse(payload.data ?? {})))
      if (value !== undefined) url.searchParams.set(key, value);
  } else if (
    !control &&
    method === 'GET' &&
    name !== 'getStartAdminRunDetail' &&
    name !== 'getStartEventDetail' &&
    payload.data !== undefined
  ) {
    throw new Error(`Unexpected input for ${name}`);
  }
  return {
    name,
    request: {
      url: () => url.toString(),
      method: () => httpMethod,
      headers: () => request.headers(),
      postData: () => (body === undefined ? null : JSON.stringify(body)),
      postDataJSON: () => body,
    } satisfies FixtureRequest,
  };
}

export async function rpcFulfillment(
  name: string,
  options: Fulfillment = {},
): Promise<Fulfillment> {
  const status = options.status ?? 200;
  const body: unknown =
    options.json !== undefined
      ? options.json
      : typeof options.body === 'string'
        ? JSON.parse(options.body)
        : undefined;
  if (status >= 400) return { ...options, headers: { ...options.headers, 'x-tss-raw': 'true' } };
  if (body === undefined) throw new Error(`Missing JSON fixture result for ${name}`);
  let result = jsonStringNames.has(name) ? JSON.stringify(body) : body;
  if (traitWrites.has(name) || name === 'postStartEventCorrection') {
    const receipt = z.record(z.string(), z.unknown()).parse(body);
    const canonicalLocation = options.headers?.Location ?? options.headers?.location;
    result = { ...receipt, status, ...(canonicalLocation ? { canonicalLocation } : {}) };
  }
  const encoded = await (await serializer()).toCrossJSONAsync(
    { result, error: undefined, context: {} },
    plugins(),
  );
  // RPC200 and its resource are distinct from retained HTTP201/Location. Do not forge a Location.
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'x-tss-serialized': 'true' },
    body: JSON.stringify(encoded),
  };
}

export function matchesFixturePattern(pattern: string, url: URL): boolean {
  if (pattern === '**/api/**') return url.pathname.startsWith('/api/');
  const match = pattern.match(/^\*\*(\/api\/[^*]+)(\*\*)?$/);
  if (!match?.[1]) throw new Error(`Unsupported fixture pattern: ${pattern}`);
  return match[2]
    ? `${url.pathname}${url.search}`.startsWith(match[1])
    : `${url.pathname}${url.search}` === match[1];
}

export async function routeFixtureApi(
  page: Page,
  pattern: string,
  handler: FixtureHandler,
  onUnexpected?: (message: string) => void,
): Promise<void> {
  const map = await loadBuiltFunctionMap();
  await page.route(pattern, handler);
  await page.route('**/_serverFn/**', async (route) => {
    let decoded: Awaited<ReturnType<typeof decodeRpcRequest>>;
    try {
      decoded = await decodeRpcRequest(route.request(), map);
    } catch (error) {
      if (!onUnexpected) return route.fallback();
      const message = String(error);
      onUnexpected(message);
      return route.fulfill({ status: 501, json: { message }, headers: { 'x-tss-raw': 'true' } });
    }
    if (!matchesFixturePattern(pattern, new URL(decoded.request.url()))) return route.fallback();
    await handler({
      request: () => decoded.request,
      fallback: () => route.fallback(),
      fulfill: async (options) => route.fulfill(await rpcFulfillment(decoded.name, options)),
    });
  });
}

export async function isProposalDecisionResponse(
  response: PlaywrightResponse,
  proposalId: string,
): Promise<boolean> {
  if (response.request().method() !== 'POST') return false;
  const url = new URL(response.url());
  if (url.pathname === `/api/proposals/${encodeURIComponent(proposalId)}/decisions`) return true;
  if (!url.pathname.startsWith('/_serverFn/')) return false;
  const decoded = await decodeRpcRequest(response.request(), await loadBuiltFunctionMap());
  return (
    decoded.name === 'decideStartProposal' &&
    new URL(decoded.request.url()).pathname ===
      `/api/proposals/${encodeURIComponent(proposalId)}/decisions`
  );
}

export async function readProposalDecisionResponse(
  response: Pick<PlaywrightResponse, 'url' | 'status' | 'headers' | 'json'>,
) {
  if (new URL(response.url()).pathname.startsWith('/_serverFn/')) {
    if (response.status() !== 200 || response.headers()['x-tss-serialized'] !== 'true')
      throw new Error('Expected serialized RPC200 decision resource');
    const envelope = Payload.extend({ result: z.string(), error: z.unknown().optional() }).parse(
      (await serializer()).fromCrossJSON(await response.json(), plugins()),
    );
    if (envelope.error !== undefined) throw new Error('Decision RPC returned an error');
    return ProposalDecisionResource.parse(JSON.parse(envelope.result));
  }
  const resource = ProposalDecisionResource.parse(await response.json());
  if (
    response.status() !== 201 ||
    response.headers().location !== `/api/events/${encodeURIComponent(resource.decision_event_id)}`
  )
    throw new Error('Expected retained HTTP201 with canonical event Location');
  return resource;
}
