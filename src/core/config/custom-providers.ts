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
import {
  assertModelEndpointHostAllowed,
  assertProviderKeyEnvBound,
} from './model-endpoint-allowlist';

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

/**
 * A custom provider's `api_key_env` value is sent as a bearer credential to
 * the admin-chosen base_url. Only dedicated provider credentials may be named:
 * the name must end in `_API_KEY`/`_TOKEN`, and shared infrastructure/secret
 * families are refused outright so a custom endpoint can never be handed
 * DATABASE_URL, the internal token, or a cloud role credential.
 */
const KEY_ENV_SUFFIX_PATTERN = /_(?:API_KEY|TOKEN)$/;
const DENIED_KEY_ENV_NAMES: ReadonlySet<string> = new Set([
  'INTERNAL_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
]);
const DENIED_KEY_ENV_PREFIXES: readonly string[] = [
  'DATABASE_',
  'POSTGRES_',
  'PG_',
  'AWS_',
  'GOOGLE_',
  'GCP_',
  'AZURE_',
  'GITHUB_',
  'CLOUDFLARE_',
  'R2_',
  'S3_',
  'LMNR_',
  'LAMINAR_',
  'SENTRY_',
  'OPENCODE_',
  'X_INTERNAL',
];

function deniedKeyEnvName(name: string): boolean {
  if (DENIED_KEY_ENV_NAMES.has(name)) return true;
  return DENIED_KEY_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

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
  // The scheme must be the literal lowercase prefix: `new URL` normalizes
  // `HTTPS://` to protocol 'https:', which would pass the URL check but then
  // violate the DB check (a 500 instead of this 422).
  if (!raw.startsWith('https://')) {
    throw new ApiError('invalid_custom_provider_input', 'base_url must be an https:// URL', 422);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError('invalid_custom_provider_input', 'base_url must be a valid URL', 422);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ApiError(
      'invalid_custom_provider_input',
      'base_url must be HTTPS without credentials, query, or fragment',
      422,
    );
  }
  const normalized = raw.replace(/\/+$/, '');
  // The key named by api_key_env is sent to this endpoint. Refuse a host the
  // models.dev catalog does not declare as a model endpoint.
  assertModelEndpointHostAllowed(normalized, 'custom provider base_url');
  return normalized;
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
  if (!KEY_ENV_SUFFIX_PATTERN.test(input.apiKeyEnv) || deniedKeyEnvName(input.apiKeyEnv)) {
    throw new ApiError(
      'invalid_custom_provider_input',
      'api_key_env must name a dedicated provider credential ending in _API_KEY or _TOKEN; shared infrastructure/secret env names (DATABASE_*, POSTGRES_*, INTERNAL_TOKEN, cloud credentials) are refused because the value is sent to this provider.',
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
  const baseUrl = validateCustomProviderBaseUrl(input.baseUrl);
  // YUK-1654 — the credential named by api_key_env is bound to its provider's
  // endpoints: another provider's key never travels to this base_url.
  assertProviderKeyEnvBound(input.apiKeyEnv, baseUrl, 'custom provider api_key_env');
  return {
    displayName: input.displayName.trim(),
    baseUrl,
    apiKeyEnv: input.apiKeyEnv,
    protocol: input.protocol as CustomProviderProtocol,
  };
}

// ─── in-memory registry ─────────────────────────────────────────────────────

let registry: ReadonlyMap<string, CustomProviderDefinition> = new Map();
let registryStamp: string | undefined;
let registryHydrated = false;

function stampOf(records: readonly CustomProviderRecord[]): string {
  return records.map((record) => `${record.id}@${record.updatedAt}`).join('|');
}

/**
 * False until a DB read succeeded (including an empty table). The catalog
 * merge must not read an un-hydrated registry as "every custom provider was
 * deleted"; a failed boot hydrate keeps the stored buckets until the watch
 * retries.
 */
export function customProvidersRegistryHydrated(): boolean {
  return registryHydrated;
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
  registryHydrated = true;
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
 * runs the shared catalog refresh (custom providers themselves only get the
 * unbilled /models read — a due built-in 1-token probe can ride the same
 * refresh) and prunes a deleted provider's bucket. Without wiring (tests,
 * tooling) the caller gets an honest `not_wired`.
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
