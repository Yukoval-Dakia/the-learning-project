// YUK-1563 — runtime models.dev catalog.
//
// One document is active in the process. Origin is remote (this process just
// stored a fetch), cache (a previous fetch read from model_catalog_cache), or
// snapshot (the committed file). Readers never block on the network. A failed
// pull leaves the active document in place. The stored document is the union of
// the previous document and the fetch: a model missing from the fetch keeps its
// previous entry and records model_absent. A selected model whose capabilities
// change keeps its previous entry and records capability_changed.

import { createHash } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import type { EffortLevel } from '@/ai/task-spec';
import { tasks } from '@/capabilities/task-registry';
import type { Db } from '@/db/client';
import { model_catalog_cache, system_config } from '@/db/schema';
import rawSnapshot from './model-catalog.snapshot.json' with { type: 'json' };
import { CATALOG_PROVIDER_BY_INTERNAL } from './model-profiles';

export const MODEL_CATALOG_URL = 'https://models.dev/api.json';
export const MODEL_CATALOG_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MODEL_CATALOG_WATCH_INTERVAL_MS = 60_000;

const FETCH_TIMEOUT_MS = 30_000;
const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const ENV_MODEL_KEYS = [
  'AI_PROVIDER_MODEL',
  'VERIFY_SOLVE_MODEL_OVERRIDE',
  'VISION_JUDGE_MODEL',
] as const;

export type CatalogOrigin = 'remote' | 'cache' | 'snapshot';

export type CatalogFinding =
  | { kind: 'model_absent'; catalogProvider: string; model: string }
  | {
      kind: 'capability_changed';
      catalogProvider: string;
      model: string;
      fields: readonly string[];
    };

export interface CatalogMeta {
  origin: CatalogOrigin;
  fetchedAt: string;
  version: string;
  upstreamVersion: string;
  findings: readonly CatalogFinding[];
}

export type CatalogRefreshResult =
  | { outcome: 'stored'; meta: CatalogMeta }
  | { outcome: 'kept'; reason: 'network' | 'invalid' | 'unreadable'; detail: string };

export interface TokenRates {
  input: number;
  output: number;
  cache_read: number;
}

interface ParsedCatalogModel {
  toolCalling?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  structuredOutput?: boolean;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  reasoningMode?: 'effort' | 'budget_tokens' | 'toggle';
  supportedEfforts?: readonly EffortLevel[];
}

type Json = Record<string, unknown>;
type ProviderMap = Record<string, Json>;

interface ActiveCatalog {
  origin: CatalogOrigin;
  fetchedAt: string;
  version: string;
  upstreamVersion: string;
  providers: ProviderMap;
  findings: readonly CatalogFinding[];
}

export type CatalogFetcher = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export interface ModelCatalogRefreshOptions {
  fetchCatalog?: CatalogFetcher;
  now?: () => Date;
}

function asJson(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function isUndefinedTable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const direct = (err as { code?: string }).code;
  const nested = (err as { cause?: { code?: string } }).cause?.code;
  return direct === '42P01' || nested === '42P01';
}

/** Narrow, fail-closed parse of one models.dev model object. */
export function parseCatalogModelEntry(entry: unknown): ParsedCatalogModel {
  const parsed: ParsedCatalogModel = {};
  const model = asJson(entry);
  if (!model) return parsed;

  parsed.toolCalling = asBoolean(model.tool_call);
  parsed.structuredOutput = asBoolean(model.structured_output);
  parsed.reasoning = asBoolean(model.reasoning);

  const inputModalities = asJson(model.modalities)?.input;
  if (Array.isArray(inputModalities)) {
    parsed.vision = inputModalities.includes('image');
  }

  const limit = asJson(model.limit);
  if (limit) {
    parsed.contextWindowTokens = asPositiveInteger(limit.context);
    parsed.maxOutputTokens = asPositiveInteger(limit.output);
  }

  const options = model.reasoning_options;
  if (Array.isArray(options) && options.length > 0) {
    const first = asJson(options[0]);
    const type = first?.type;
    if (first && (type === 'effort' || type === 'budget_tokens' || type === 'toggle')) {
      parsed.reasoningMode = type;
      if (type === 'effort' && Array.isArray(first.values)) {
        const efforts = first.values.filter(
          (value): value is EffortLevel =>
            typeof value === 'string' && EFFORT_LEVELS.includes(value as EffortLevel),
        );
        if (efforts.length > 0) parsed.supportedEfforts = efforts;
      }
    }
  }
  return parsed;
}

function capabilityDelta(previous: unknown, next: unknown): string[] {
  const before = parseCatalogModelEntry(previous);
  const after = parseCatalogModelEntry(next);
  const changed: string[] = [];
  const keys = [
    'toolCalling',
    'vision',
    'reasoning',
    'structuredOutput',
    'contextWindowTokens',
    'maxOutputTokens',
    'reasoningMode',
  ] as const;
  for (const key of keys) {
    if (before[key] !== after[key]) changed.push(key);
  }
  const beforeEfforts = (before.supportedEfforts ?? []).join(',');
  const afterEfforts = (after.supportedEfforts ?? []).join(',');
  if (beforeEfforts !== afterEfforts) changed.push('supportedEfforts');
  return changed;
}

function isProviderEntry(value: unknown): value is Json {
  const entry = asJson(value);
  return entry !== undefined && asJson(entry.models) !== undefined;
}

/** Accept a models.dev root, a snapshot, or a stored `{ providers }` payload. */
function providerMapFrom(value: unknown): ProviderMap | undefined {
  const root = asJson(value);
  if (!root) return undefined;
  const wrapped = asJson(root.providers);
  const source = wrapped && Object.values(wrapped).some(isProviderEntry) ? wrapped : root;
  const map: ProviderMap = {};
  let count = 0;
  for (const [id, entry] of Object.entries(source)) {
    if (id === '_meta') continue;
    if (!isProviderEntry(entry)) continue;
    map[id] = entry;
    count += 1;
  }
  return count > 0 ? map : undefined;
}

function parseFindings(value: unknown): CatalogFinding[] {
  if (!Array.isArray(value)) return [];
  const findings: CatalogFinding[] = [];
  for (const item of value) {
    const row = asJson(item);
    if (!row) continue;
    const catalogProvider = row.catalogProvider;
    const model = row.model;
    if (typeof catalogProvider !== 'string' || catalogProvider.length === 0) continue;
    if (typeof model !== 'string' || model.length === 0) continue;
    if (row.kind === 'model_absent') {
      findings.push({ kind: 'model_absent', catalogProvider, model });
      continue;
    }
    if (row.kind === 'capability_changed' && Array.isArray(row.fields)) {
      const fields = row.fields.filter((field): field is string => typeof field === 'string');
      findings.push({ kind: 'capability_changed', catalogProvider, model, fields });
    }
  }
  return findings;
}

function snapshotActive(): ActiveCatalog {
  const root = asJson(rawSnapshot);
  const providers = providerMapFrom(rawSnapshot) ?? {};
  const retrievedAt = asJson(root?._meta)?.retrieved_at;
  const fetchedAt = typeof retrievedAt === 'string' ? retrievedAt : '1970-01-01T00:00:00.000Z';
  const version = sha256(JSON.stringify(providers));
  return {
    origin: 'snapshot',
    fetchedAt,
    version,
    upstreamVersion: `snapshot:${version}`,
    providers,
    findings: [],
  };
}

let active: ActiveCatalog = snapshotActive();
let unreadableCacheVersion: string | undefined;

function warnUnreadableCache(version: string): void {
  if (unreadableCacheVersion === version) return;
  unreadableCacheVersion = version;
  console.warn(
    `[model-catalog] cache payload unreadable version=${version} — keeping snapshot or previous`,
  );
}

function metaOf(catalog: ActiveCatalog): CatalogMeta {
  return {
    origin: catalog.origin,
    fetchedAt: catalog.fetchedAt,
    version: catalog.version,
    upstreamVersion: catalog.upstreamVersion,
    findings: catalog.findings,
  };
}

export function currentModelCatalog(): CatalogMeta {
  return metaOf(active);
}

export function catalogModelEntry(catalogProviderId: string, modelId: string): unknown {
  return asJson(active.providers[catalogProviderId]?.models)?.[modelId];
}

export function catalogModelCost(
  catalogProviderId: string,
  modelId: string,
): TokenRates | undefined {
  const cost = asJson(asJson(catalogModelEntry(catalogProviderId, modelId))?.cost);
  if (!cost) return undefined;
  const input = cost.input;
  const output = cost.output;
  const cacheRead = cost.cache_read;
  if (typeof input !== 'number' || !Number.isFinite(input)) return undefined;
  if (typeof output !== 'number' || !Number.isFinite(output)) return undefined;
  if (typeof cacheRead !== 'number' || !Number.isFinite(cacheRead)) return undefined;
  return { input, output, cache_read: cacheRead };
}

function addModelId(ids: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length > 0) ids.add(trimmed);
}

async function readPinnedModelIds(db: Db): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  for (const task of Object.values(tasks)) addModelId(ids, task.defaultModel);
  for (const key of ENV_MODEL_KEYS) addModelId(ids, process.env[key]);
  const rows = await db
    .select({ value: system_config.value })
    .from(system_config)
    .where(like(system_config.key, '%.model'));
  for (const row of rows) addModelId(ids, row.value);
  return ids;
}

type MergedModel =
  | { kind: 'current'; entry: unknown }
  | { kind: 'model_absent'; entry: unknown }
  | { kind: 'capability_changed'; entry: unknown; fields: readonly string[] };

function mergeModelEntry(
  previousEntry: unknown,
  nextEntry: unknown,
  retainCapability: boolean,
): MergedModel {
  if (nextEntry === undefined) return { kind: 'model_absent', entry: previousEntry };
  if (previousEntry !== undefined && retainCapability) {
    const fields = capabilityDelta(previousEntry, nextEntry);
    if (fields.length > 0) return { kind: 'capability_changed', entry: previousEntry, fields };
  }
  return { kind: 'current', entry: nextEntry };
}

function wiredCatalogProviderIds(): readonly string[] {
  return [
    ...new Set(
      Object.values(CATALOG_PROVIDER_BY_INTERNAL).filter((id): id is string => id !== undefined),
    ),
  ].sort();
}

function missingWiredProviders(providers: ProviderMap): string[] {
  return wiredCatalogProviderIds().filter((id) => providers[id] === undefined);
}

/** Previous document ∪ fetched document. Absence keeps the old entry for every model. */
function mergeCatalogDocuments(
  previous: ProviderMap,
  next: ProviderMap,
  pinned: ReadonlySet<string>,
): { providers: ProviderMap; findings: CatalogFinding[] } {
  const providers: ProviderMap = {};
  const findings: CatalogFinding[] = [];
  const providerIds = [...new Set([...Object.keys(previous), ...Object.keys(next)])].sort();
  for (const providerId of providerIds) {
    const previousModels = asJson(previous[providerId]?.models) ?? {};
    const nextModels = asJson(next[providerId]?.models) ?? {};
    const models: Json = {};
    const modelIds = [
      ...new Set([...Object.keys(previousModels), ...Object.keys(nextModels)]),
    ].sort();
    for (const modelId of modelIds) {
      const merged = mergeModelEntry(
        previousModels[modelId],
        nextModels[modelId],
        pinned.has(modelId),
      );
      models[modelId] = merged.entry;
      if (merged.kind === 'model_absent') {
        findings.push({ kind: 'model_absent', catalogProvider: providerId, model: modelId });
      } else if (merged.kind === 'capability_changed') {
        findings.push({
          kind: 'capability_changed',
          catalogProvider: providerId,
          model: modelId,
          fields: merged.fields,
        });
      }
    }
    const shell = { ...(next[providerId] ?? previous[providerId] ?? {}) };
    shell.models = models;
    providers[providerId] = shell;
  }
  return { providers, findings };
}

function logActive(action: string, catalog: ActiveCatalog): void {
  console.info(
    `[model-catalog] ${action} origin=${catalog.origin} version=${catalog.version} at=${catalog.fetchedAt} findings=${catalog.findings.length}`,
  );
  for (const finding of catalog.findings) {
    const fields =
      finding.kind === 'capability_changed' ? ` fields=${finding.fields.join(',')}` : '';
    console.warn(
      `[model-catalog] retained ${finding.catalogProvider}/${finding.model} ${finding.kind}${fields}`,
    );
  }
}

function install(next: ActiveCatalog, action: string): void {
  active = next;
  logActive(action, next);
}

function upstreamVersionOf(response: Response, rawBody: string): string {
  const etag = response.headers.get('etag')?.replace(/^W\//, '').replaceAll('"', '').trim();
  if (etag && etag.length > 0) return etag;
  return `sha256:${sha256(rawBody)}`;
}

async function pullRemote(
  fetchCatalog: CatalogFetcher,
): Promise<
  | { providers: ProviderMap; upstreamVersion: string }
  | { error: 'network' | 'invalid'; detail: string }
> {
  let response: Response;
  try {
    response = await fetchCatalog(MODEL_CATALOG_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return { error: 'network', detail: error instanceof Error ? error.message : 'fetch failed' };
  }
  if (!response.ok) return { error: 'network', detail: `HTTP ${response.status}` };
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { error: 'invalid', detail: 'JSON parse failed' };
  }
  const providers = providerMapFrom(parsed);
  if (!providers) return { error: 'invalid', detail: 'catalog has no providers' };
  const missing = missingWiredProviders(providers);
  if (missing.length > 0)
    return { error: 'invalid', detail: `missing providers ${missing.join(',')}` };
  return { providers, upstreamVersion: upstreamVersionOf(response, raw) };
}

function kept(reason: 'network' | 'invalid' | 'unreadable', detail: string): CatalogRefreshResult {
  console.warn(`[model-catalog] kept previous catalog reason=${reason} ${detail}`);
  return { outcome: 'kept', reason, detail };
}

export async function hydrateModelCatalog(db: Db): Promise<CatalogMeta> {
  try {
    const rows = await db
      .select({
        fetched_at: model_catalog_cache.fetched_at,
        version: model_catalog_cache.version,
        upstream_version: model_catalog_cache.upstream_version,
        payload: model_catalog_cache.payload,
        findings: model_catalog_cache.findings,
      })
      .from(model_catalog_cache)
      .where(eq(model_catalog_cache.id, 1))
      .limit(1);
    const row = rows[0];
    if (!row) return metaOf(active);
    const providers = providerMapFrom(row.payload);
    if (!providers) {
      warnUnreadableCache(row.version);
      return metaOf(active);
    }
    unreadableCacheVersion = undefined;
    const fetchedAt =
      row.fetched_at instanceof Date ? row.fetched_at.toISOString() : String(row.fetched_at);
    install(
      {
        origin: 'cache',
        fetchedAt,
        version: row.version,
        upstreamVersion: row.upstream_version,
        providers,
        findings: parseFindings(row.findings),
      },
      'loaded',
    );
  } catch (error) {
    console.warn(
      '[model-catalog] cache read failed — keeping snapshot or previous',
      isUndefinedTable(error) ? 'relation missing' : error instanceof Error ? error.message : error,
    );
  }
  return metaOf(active);
}

export async function refreshModelCatalog(
  db: Db,
  options: ModelCatalogRefreshOptions = {},
): Promise<CatalogRefreshResult> {
  let pinned: ReadonlySet<string>;
  try {
    pinned = await readPinnedModelIds(db);
  } catch (error) {
    return kept(
      'unreadable',
      isUndefinedTable(error)
        ? 'system_config missing'
        : error instanceof Error
          ? error.message
          : 'pinned models unreadable',
    );
  }

  const fetchCatalog = options.fetchCatalog ?? ((url, init) => fetch(url, init));
  const pulled = await pullRemote(fetchCatalog);
  if ('error' in pulled) return kept(pulled.error, pulled.detail);

  const retained = mergeCatalogDocuments(active.providers, pulled.providers, pinned);
  const now = options.now?.() ?? new Date();
  const version = sha256(JSON.stringify(retained.providers));
  const next: ActiveCatalog = {
    origin: 'remote',
    fetchedAt: now.toISOString(),
    version,
    upstreamVersion: pulled.upstreamVersion,
    providers: retained.providers,
    findings: retained.findings,
  };
  try {
    await db
      .insert(model_catalog_cache)
      .values({
        id: 1,
        fetched_at: now,
        version,
        upstream_version: pulled.upstreamVersion,
        source_url: MODEL_CATALOG_URL,
        payload: { providers: retained.providers },
        findings: retained.findings,
      })
      .onConflictDoUpdate({
        target: model_catalog_cache.id,
        set: {
          fetched_at: now,
          version,
          upstream_version: pulled.upstreamVersion,
          source_url: MODEL_CATALOG_URL,
          payload: { providers: retained.providers },
          findings: retained.findings,
        },
      });
  } catch (error) {
    return kept(
      'unreadable',
      isUndefinedTable(error)
        ? 'model_catalog_cache missing'
        : error instanceof Error
          ? error.message
          : 'cache write failed',
    );
  }
  install(next, 'stored');
  return { outcome: 'stored', meta: metaOf(next) };
}

export function startModelCatalogWatch(
  db: Db,
  intervalMs = MODEL_CATALOG_WATCH_INTERVAL_MS,
): {
  stop: () => void;
} {
  const timer = setInterval(() => {
    void (async () => {
      try {
        const rows = await db
          .select({ version: model_catalog_cache.version })
          .from(model_catalog_cache)
          .where(eq(model_catalog_cache.id, 1))
          .limit(1);
        const version = rows[0]?.version;
        if (!version || version === active.version || version === unreadableCacheVersion) return;
        await hydrateModelCatalog(db);
      } catch (error) {
        console.warn(
          '[model-catalog] cache watch failed',
          error instanceof Error ? error.message : error,
        );
      }
    })();
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
