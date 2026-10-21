// YUK-1563 part 4 — runtime-configured custom provider definitions.
//
// A custom provider is configuration, not code: baseURL, the env var NAME that
// holds its key, and a wire protocol. This module is the DB-free core: types,
// validation, the in-memory registry every resolution surface reads
// synchronously, and two injection ports (catalog facts + change handler) the
// server composition root wires at boot. DB hydration/CRUD live at the edges
// (server/config/custom-providers-hydrate.ts, the observability admin route),
// mirroring core/config/store ↔ server/config/hydrate.
//
// Credential honesty: only the env var NAME is ever stored or projected. The
// key value stays in the operator's env and never reaches the DB or logs.

import { ApiError } from '@/kernel/http';

export type CustomProviderProtocol = 'openai-completions' | 'anthropic-messages';

export interface CustomProviderDefinition {
  readonly id: `custom:${string}`;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly protocol: CustomProviderProtocol;
}

/** DB row shape after timestamp serialization (ISO strings). */
export interface CustomProviderRecord extends CustomProviderDefinition {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CustomProviderInput {
  readonly displayName: unknown;
  readonly baseUrl: unknown;
  readonly apiKeyEnv: unknown;
  readonly protocol: unknown;
}

/** Upper bound so the model-facts index and the registry stay cheap. */
export const CUSTOM_PROVIDER_LIMIT = 16;

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const PROTOCOLS: readonly CustomProviderProtocol[] = ['openai-completions', 'anthropic-messages'];

export function customProviderSlug(id: string): string | undefined {
  const slug = id.startsWith('custom:') ? id.slice('custom:'.length) : undefined;
  return slug && SLUG_PATTERN.test(slug) ? slug : undefined;
}

export function looksLikeCustomProviderId(id: string): boolean {
  return customProviderSlug(id) !== undefined;
}

export function customProviderIdFor(slug: string): `custom:${string}` {
  return `custom:${slug}`;
}

/** Same endpoint rules as the models.dev catalog reader (catalogEndpoint). */
export function validateCustomProviderBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError('invalid_custom_provider_input', 'base_url must be a valid URL', 422);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new ApiError(
      'invalid_custom_provider_input',
      'base_url must be HTTPS without credentials, query, or fragment',
      422,
    );
  }
  return raw.replace(/\/+$/, '');
}

export function validateCustomProviderSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new ApiError(
      'invalid_custom_provider_input',
      "provider id must be 'custom:<slug>' with a-z, 0-9, dashes",
      422,
    );
  }
}

export function validateCustomProviderInput(
  input: CustomProviderInput,
): Omit<CustomProviderDefinition, 'id'> {
  if (typeof input.displayName !== 'string' || input.displayName.trim().length === 0) {
    throw new ApiError('invalid_custom_provider_input', 'display_name is required', 422);
  }
  if (input.displayName.trim().length > 80) {
    throw new ApiError(
      'invalid_custom_provider_input',
      'display_name must be at most 80 characters',
      422,
    );
  }
  if (typeof input.baseUrl !== 'string') {
    throw new ApiError('invalid_custom_provider_input', 'base_url must be a string', 422);
  }
  if (typeof input.apiKeyEnv !== 'string' || !ENV_NAME_PATTERN.test(input.apiKeyEnv)) {
    throw new ApiError(
      'invalid_custom_provider_input',
      'api_key_env must be an env var name (A-Z, 0-9, underscore)',
      422,
    );
  }
  if (!PROTOCOLS.includes(input.protocol as CustomProviderProtocol)) {
    throw new ApiError(
      'invalid_custom_provider_input',
      `protocol must be one of ${PROTOCOLS.join(', ')}`,
      422,
    );
  }
  return {
    displayName: input.displayName.trim(),
    baseUrl: validateCustomProviderBaseUrl(input.baseUrl),
    apiKeyEnv: input.apiKeyEnv,
    protocol: input.protocol as CustomProviderProtocol,
  };
}

// ─── in-memory registry ─────────────────────────────────────────────────────

let registry: ReadonlyMap<string, CustomProviderDefinition> = new Map();
let registryStamp: string | undefined;

function stampOf(records: readonly CustomProviderRecord[]): string {
  return records.map((record) => `${record.id}@${record.updatedAt}`).join('|');
}

/** Atomic registry swap (hydrate, write, and watch paths all come through here). */
export function installCustomProviders(records: readonly CustomProviderRecord[]): void {
  registry = new Map(
    records.map((record) => [
      record.id,
      {
        id: record.id,
        displayName: record.displayName,
        baseUrl: record.baseUrl,
        apiKeyEnv: record.apiKeyEnv,
        protocol: record.protocol,
      },
    ]),
  );
  registryStamp = stampOf(records);
}

/** Drizzle row (snake_case columns, Date timestamps) → registry record. Shared by both IO faces. */
export function customProviderRecordFromRow(row: {
  id: string;
  display_name: string;
  base_url: string;
  api_key_env: string;
  protocol: string;
  created_at: Date | string;
  updated_at: Date | string;
}): CustomProviderRecord {
  return {
    id: row.id as `custom:${string}`,
    displayName: row.display_name,
    baseUrl: row.base_url,
    apiKeyEnv: row.api_key_env,
    protocol: row.protocol as CustomProviderRecord['protocol'],
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

export function registryStampOf(records: readonly CustomProviderRecord[]): string {
  return stampOf(records);
}

export function customProviderDefinitions(): readonly CustomProviderDefinition[] {
  return [...registry.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function customProviderDefinition(id: string): CustomProviderDefinition | undefined {
  return registry.get(id);
}

export function isCustomProviderConfigured(id: string): boolean {
  return registry.has(id);
}

// ─── server integration ports (composition-root wired) ──────────────────────

/** Panel-visible catalog facts per custom provider; no credential material. */
export interface CustomProviderCatalogFacts {
  /** unconfigured | ok | auth_failed:<status>:<type> | unreachable:<detail> | … */
  readonly auth: string;
  /** Models with catalog facts — the set that passes the save-time runnability check. */
  readonly runnableModels: readonly string[];
  /** Models the endpoint lists but the catalog has no facts for: unknown. */
  readonly unknownModels: readonly string[];
  readonly findings: number;
}

let catalogFactsSource: (() => ReadonlyMap<string, CustomProviderCatalogFacts>) | undefined;

/** Injected by the server composition root; fresh per call (hot-reload friendly). */
export function setCustomProviderCatalogFactsSource(
  source: () => ReadonlyMap<string, CustomProviderCatalogFacts>,
): void {
  catalogFactsSource = source;
}

export function getCustomProviderCatalogFactsSource():
  | (() => ReadonlyMap<string, CustomProviderCatalogFacts>)
  | undefined {
  return catalogFactsSource;
}

export type CustomProviderChangeEvent =
  | { kind: 'put'; id: `custom:${string}` }
  | { kind: 'delete'; id: `custom:${string}` };

export type CustomProviderRefreshOutcome =
  | { outcome: 'stored'; version: string }
  | { outcome: 'kept'; reason: string; detail: string }
  | { outcome: 'not_wired' };

let changeHandler:
  | ((event: CustomProviderChangeEvent) => Promise<CustomProviderRefreshOutcome>)
  | undefined;

/**
 * Injected by the server composition root: after a definition write the server
 * refreshes the runtime catalog (an unbilled /models read, no paid probe) and
 * prunes a deleted provider's bucket. Without wiring (tests, tooling) the
 * caller gets an honest `not_wired`.
 */
export function setCustomProviderChangeHandler(
  handler: (event: CustomProviderChangeEvent) => Promise<CustomProviderRefreshOutcome>,
): void {
  changeHandler = handler;
}

export async function notifyCustomProvidersChanged(
  event: CustomProviderChangeEvent,
): Promise<CustomProviderRefreshOutcome> {
  if (!changeHandler) return { outcome: 'not_wired' };
  return changeHandler(event);
}
