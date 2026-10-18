// YUK-1559 (C6) — shared provider HTTP error evidence.
//
// A non-2xx provider response carries the only honest record of WHY the wire
// rejected us (schema violations, quota, auth). pi-ai already folds a
// formatted `<status>: <body>` display string into `errorMessage`, but that
// is a re-serialized, separately-capped rendering — not the raw body — and it
// drops the response headers entirely. This module is the single capture
// boundary both sides use:
//
//   - the pi lane wraps the per-query provider fetch (`baseLoopConfig`) so a
//     non-2xx response's body is cloned, bounded and sanitized BEFORE the
//     provider SDK consumes it — the terminal error frame then carries the
//     evidence into `ai_task_runs.error_message` and `paid_effect.unresolved_reason`;
//   - the admission preflight script records the same shape on its receipt.
//
// The body is UTF-8 text capped at 4096 BYTES (same bound as the submit-args
// evidence in raw-arguments-evidence.ts), with a sha256 of the full sanitized
// text so a truncated capture still matches the wire. Secrets are redacted —
// provider keys, auth headers and tokens never land in logs or receipts.

import { sha256Hex } from '@/core/migration/canonical';
import { truncateUtf8 } from '@/core/raw-arguments-evidence';

/** Maximum UTF-8 bytes of a persisted provider error body. */
export const PROVIDER_ERROR_BODY_MAX_BYTES = 4096;

export interface ProviderErrorEvidence {
  http_status: number;
  /** Header-carried request id when the gateway emits one; body ids stay inside `body`. */
  request_id?: string;
  /** Sanitized body excerpt, ≤ PROVIDER_ERROR_BODY_MAX_BYTES of UTF-8. */
  body: string;
  /** Digest of the FULL sanitized body — a truncated capture still matches the wire. */
  body_sha256: string;
  truncated: boolean;
}

// JSON string fields whose key contains a credential-ish word, including
// suffixed variants (`api_key`, `apiKey`, `access_token_v2`, ...). The value
// pattern is a full JSON string so escaped quotes cannot leak a tail.
const SECRET_VALUE_FIELD =
  /"((?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|auth[-_]?token|authorization|client[-_]?secret|secret|password|token)[^"\\]*)"(\s*:\s*)"(?:[^"\\]|\\.)*"/gi;

/**
 * Redact credential material from a provider error body. The body is a
 * receipt artifact — an error payload should never echo our secrets, but
 * proxies and SDKs have been known to mirror request fields. Anything the
 * patterns miss stays verbatim: this is a hygiene floor, not a parser.
 */
export function sanitizeProviderErrorText(text: string): string {
  return text
    .replace(SECRET_VALUE_FIELD, (_match, key: string, sep: string) => `"${key}"${sep}"[redacted]"`)
    .replace(/Bearer\s+[^\s"',}]+/g, 'Bearer [redacted]')
    .replace(/\b(?:sk|tp|oat)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]');
}

/**
 * Read a non-2xx response's body into bounded, sanitized evidence. Callers
 * pass `response.clone()` when the SDK still owns the original stream.
 */
export async function readProviderErrorEvidence(
  response: Response,
): Promise<ProviderErrorEvidence> {
  const raw = (await response.text().catch(() => '')).trim();
  const sanitized = sanitizeProviderErrorText(raw);
  const body = truncateUtf8(sanitized, PROVIDER_ERROR_BODY_MAX_BYTES);
  const requestId =
    response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined;
  return {
    http_status: response.status,
    ...(requestId ? { request_id: requestId } : {}),
    body,
    body_sha256: sha256Hex(sanitized),
    truncated: body !== sanitized,
  };
}

/**
 * Wrap the provider fetch handed to a pi query: on a non-2xx response the
 * body is cloned and recorded while the original response still reaches the
 * provider SDK untouched (pi's errorMessage continues to render its own
 * formatted summary). The LAST non-2xx wins — provider retries may pass
 * several failures before the terminal one the run reports.
 */
export function createProviderErrorCaptureFetch(base: typeof fetch): {
  fetch: typeof fetch;
  latest(): ProviderErrorEvidence | undefined;
} {
  let latest: ProviderErrorEvidence | undefined;
  return {
    fetch: async (input, init) => {
      const response = await base(input, init);
      if (!response.ok) {
        latest = await readProviderErrorEvidence(response.clone()).catch(() => latest);
      }
      return response;
    },
    latest: () => latest,
  };
}
