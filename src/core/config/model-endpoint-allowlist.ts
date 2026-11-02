// YUK-1646 — model endpoint host allowlist.
//
// A provider credential is sent as a bearer (or api-key) credential to the
// configured model endpoint. Only hosts the models.dev catalog declares — plus
// the code-owned first-party endpoints the catalog omits — may receive one.
// The runtime catalog owner installs the host set; validation runs where a
// base_url is accepted (custom provider save) and where it is resolved for a
// wire call. The allowlist covers model endpoints only. It never gates the
// agent's browsing/fetch tools.
//
// YUK-1654 — an allowlist entry carries the port when the endpoint declares
// one (`https://h` and `https://h:443` are the key `h`; `https://h:8443` is
// `h:8443`), so a credential is never rerouted through a port the catalog does
// not name. Repo-known provider credentials are additionally bound to their
// own provider's endpoints: provider A's key never reaches provider B's host,
// and a built-in provider endpoint never receives another env's credential.

import { ApiError } from '@/kernel/http';

export const MODEL_ENDPOINT_HOST_NOT_ALLOWED = 'model_endpoint_host_not_allowed';
export const PROVIDER_KEY_ENV_NOT_BOUND = 'provider_key_env_not_bound';

let allowlist: ReadonlySet<string> = new Set();
let installed = false;

/**
 * The allowlist key for an endpoint URL: the lowercase host, plus `:port` when
 * the URL names a non-default port (the URL parser already drops default
 * ports). `undefined` when the URL does not parse.
 */
export function endpointKeyOf(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    return url.port ? `${url.hostname.toLowerCase()}:${url.port}` : url.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Replace the installed set. Called by the runtime model catalog owner. */
export function installModelEndpointHostAllowlist(keys: Iterable<string>): void {
  const next = new Set<string>();
  for (const key of keys) {
    const normalized = key.trim().toLowerCase();
    if (normalized.length > 0) next.add(normalized);
  }
  allowlist = next;
  installed = true;
}

export function modelEndpointHostAllowlist(): ReadonlySet<string> {
  return allowlist;
}

/** False while no catalog document has been installed: fail closed. */
export function isModelEndpointHostAllowed(rawUrl: string): boolean {
  const key = endpointKeyOf(rawUrl);
  return installed && key !== undefined && allowlist.has(key);
}

export function assertModelEndpointHostAllowed(rawUrl: string, subject: string): void {
  if (!installed) {
    throw new ApiError(
      'model_endpoint_allowlist_unavailable',
      `model endpoint host allowlist is not loaded yet (${subject}); refusing a provider base_url before the models.dev catalog is available`,
      503,
    );
  }
  const key = endpointKeyOf(rawUrl);
  if (key !== undefined && allowlist.has(key)) return;
  const portNote =
    key !== undefined && key.includes(':')
      ? ' (a non-default port must be declared by the catalog endpoint itself)'
      : '';
  throw new ApiError(
    MODEL_ENDPOINT_HOST_NOT_ALLOWED,
    `model endpoint base_url host '${key ?? rawUrl}' is not in the models.dev catalog host allowlist (${subject}); provider credentials are only sent to catalog-listed endpoints${portNote}`,
    422,
  );
}

// ─── provider credential <-> endpoint binding (YUK-1654) ─────────────────────

/**
 * Which endpoint keys each repo-known provider credential may be sent to, and
 * which credentials each repo-known provider endpoint accepts. Endpoints of
 * providers this repo does not implement appear in neither map: their env
 * naming is the operator's, so only the host allowlist applies to them.
 */
export interface ProviderKeyEndpointBindings {
  readonly byEnv: ReadonlyMap<string, ReadonlySet<string>>;
  readonly byHost: ReadonlyMap<string, ReadonlySet<string>>;
}

let bindingsSource: (() => ProviderKeyEndpointBindings) | undefined;

/**
 * Injected by the provider registry join (fresh per call: the binding follows
 * the active catalog document, so a catalog refresh can never strand a stale
 * host set).
 */
export function setProviderKeyEndpointBindingsSource(
  source: () => ProviderKeyEndpointBindings,
): void {
  bindingsSource = source;
}

function bindingViolation(apiKeyEnv: string, rawUrl: string): string | undefined {
  const bindings = bindingsSource?.();
  if (!bindings) return undefined;
  const key = endpointKeyOf(rawUrl);
  if (key === undefined) return undefined;
  const ownedKeys = bindings.byEnv.get(apiKeyEnv);
  if (ownedKeys !== undefined) {
    return ownedKeys.has(key)
      ? undefined
      : `${apiKeyEnv} is a built-in provider credential and may only be sent to ${[...ownedKeys].sort().join(', ') || '(its provider has no known model endpoint)'}, not '${key}'`;
  }
  const accepting = bindings.byHost.get(key);
  if (accepting !== undefined && !accepting.has(apiKeyEnv)) {
    return `'${key}' is a built-in provider endpoint; only ${[...accepting].sort().join(', ')} may be sent there, not ${apiKeyEnv}`;
  }
  return undefined;
}

/**
 * Fail-closed predicate for read paths that drop the endpoint instead of
 * throwing: an unbound (or unavailable) pairing reports false.
 */
export function isProviderKeyEnvBound(apiKeyEnv: string, rawUrl: string): boolean {
  if (!bindingsSource) return false;
  return bindingViolation(apiKeyEnv, rawUrl) === undefined;
}

export function assertProviderKeyEnvBound(
  apiKeyEnv: string,
  rawUrl: string,
  subject: string,
): void {
  if (!bindingsSource) {
    throw new ApiError(
      'provider_key_bindings_unavailable',
      `provider key/endpoint bindings are not loaded yet (${subject}); refusing api_key_env '${apiKeyEnv}' before the provider registry is available`,
      503,
    );
  }
  const violation = bindingViolation(apiKeyEnv, rawUrl);
  if (violation !== undefined) {
    throw new ApiError(PROVIDER_KEY_ENV_NOT_BOUND, `${violation} (${subject})`, 422);
  }
}
