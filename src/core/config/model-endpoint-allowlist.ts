// YUK-1646 — model endpoint host allowlist.
//
// A provider credential is sent as a bearer (or api-key) credential to the
// configured model endpoint. Only hosts the models.dev catalog declares — plus
// the code-owned first-party endpoints the catalog omits — may receive one.
// The runtime catalog owner installs the host set; validation runs where a
// base_url is accepted (custom provider save) and where it is resolved for a
// wire call. The allowlist covers model endpoints only. It never gates the
// agent's browsing/fetch tools.

import { ApiError } from '@/kernel/http';

export const MODEL_ENDPOINT_HOST_NOT_ALLOWED = 'model_endpoint_host_not_allowed';

let allowlist: ReadonlySet<string> = new Set();
let installed = false;

function hostOf(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Replace the installed set. Called by the runtime model catalog owner. */
export function installModelEndpointHostAllowlist(hosts: Iterable<string>): void {
  const next = new Set<string>();
  for (const host of hosts) {
    const normalized = host.trim().toLowerCase();
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
  const host = hostOf(rawUrl);
  return installed && host !== undefined && allowlist.has(host);
}

export function assertModelEndpointHostAllowed(rawUrl: string, subject: string): void {
  if (!installed) {
    throw new ApiError(
      'model_endpoint_allowlist_unavailable',
      `model endpoint host allowlist is not loaded yet (${subject}); refusing a provider base_url before the models.dev catalog is available`,
      503,
    );
  }
  const host = hostOf(rawUrl);
  if (host !== undefined && allowlist.has(host)) return;
  throw new ApiError(
    MODEL_ENDPOINT_HOST_NOT_ALLOWED,
    `model endpoint base_url host '${host ?? rawUrl}' is not in the models.dev catalog host allowlist (${subject}); provider credentials are only sent to catalog-listed endpoints`,
    422,
  );
}
