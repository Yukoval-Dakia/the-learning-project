// YUK-1563 QA AC3 — read-face projection of the settled provider auth facts.
// Kept in its own module (not inside the >1000-line provider-models-check
// state machine) so the projection has a live consumer without growing the
// state machine file; it type-imports the check shape only and sends nothing.

import type { ProviderModelsCheck } from './provider-models-check';

/**
 * A coarse unconfigured / configured / auth_failed view of the same state
 * machine `providerAuthLabel` describes, for panels that only need the auth
 * verdict. `configured` covers ok, unprobed, unsettled and unreachable alike.
 */
export interface ProviderAuthStatus {
  status: 'unconfigured' | 'configured' | 'auth_failed';
  httpStatus: number | null;
  errorType: string | null;
}

export function providerAuthStatus(
  check: ProviderModelsCheck | undefined,
  fingerprint: string | null,
): ProviderAuthStatus {
  if (fingerprint === null) return { status: 'unconfigured', httpStatus: null, errorType: null };
  // A receipt only counts for the credential fingerprint that produced it.
  if (!check || check.credentialFingerprint !== fingerprint) {
    return { status: 'configured', httpStatus: null, errorType: null };
  }
  const failed =
    check.inference.status === 'auth_failed'
      ? check.inference
      : check.list.status === 'auth_failed'
        ? check.list
        : undefined;
  return failed
    ? { status: 'auth_failed', httpStatus: failed.httpStatus, errorType: failed.errorType }
    : { status: 'configured', httpStatus: null, errorType: null };
}
