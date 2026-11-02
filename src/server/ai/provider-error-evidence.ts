// YUK-1559 (C6) — shared provider HTTP error evidence.
//
// A non-2xx body is the only honest record of why the wire rejected us. pi-ai's
// formatted errorMessage is a re-serialized, separately-capped rendering that
// drops headers, so both capture sites use this one boundary: the pi lane wraps
// the per-query fetch (body cloned, bounded and sanitized before the SDK consumes
// it) and the admission preflight records the same shape on its receipt.
//
// Bodies are capped at 4096 bytes with a sha256 of the FULL sanitized text, so a
// truncated capture still matches the wire. Provider keys, auth headers and
// tokens never land in logs or receipts.

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

// Plaintext auth headers mirrored into an error body (`X-Api-Key: <key>`,
// `Authorization=Bearer <key>`, ...) — the JSON field pattern above cannot
// see unquoted `name: value` forms.
const PLAINTEXT_AUTH_HEADER =
  /((?:authorization|x-api-key|api[-_]?key|x-auth-token|proxy-authorization|x-access-token)\s*[:=]\s*)(?:Bearer\s+|Basic\s+)?[^\s'",}\][]+/gi;

/** Request ids are receipts too — sanitize and bound them like the body. */
export const PROVIDER_ERROR_REQUEST_ID_MAX_BYTES = 128;

export interface ProviderErrorSanitizeOptions {
  /**
   * Credential value(s) used for THIS request — removed verbatim and JSON-escaped
   * before the generic patterns, since a body can echo the key back in free text.
   */
  secrets?: readonly string[];
}

/**
 * Redact credential material from provider-produced text: the caller's credential
 * (verbatim and JSON-escaped), then generic field/header/token patterns. Anything
 * the rules miss stays verbatim — this is a hygiene floor, not a parser.
 */
export function sanitizeProviderErrorText(
  text: string,
  options?: ProviderErrorSanitizeOptions,
): string {
  let out = text;
  for (const secret of options?.secrets ?? []) {
    if (secret === '') continue;
    if (out.includes(secret)) out = out.split(secret).join('[redacted]');
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret && out.includes(escaped)) {
      out = out.split(escaped).join('[redacted]');
    }
  }
  return out
    .replace(SECRET_VALUE_FIELD, (_match, key: string, sep: string) => `"${key}"${sep}"[redacted]"`)
    .replace(PLAINTEXT_AUTH_HEADER, (_match, prefix: string) => `${prefix}[redacted]`)
    .replace(/Bearer\s+[^\s"',}]+/g, 'Bearer [redacted]')
    .replace(/\b(?:sk|tp|oat)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]');
}

/**
 * Read a non-2xx body into bounded, sanitized evidence. Callers pass
 * `response.clone()` when the SDK still owns the original stream.
 */
export async function readProviderErrorEvidence(
  response: Response,
  options?: ProviderErrorSanitizeOptions,
): Promise<ProviderErrorEvidence> {
  const raw = (await response.text().catch(() => '')).trim();
  const sanitized = sanitizeProviderErrorText(raw, options);
  const body = truncateUtf8(sanitized, PROVIDER_ERROR_BODY_MAX_BYTES);
  const requestIdRaw =
    response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined;
  const requestId = requestIdRaw
    ? truncateUtf8(
        sanitizeProviderErrorText(requestIdRaw, options),
        PROVIDER_ERROR_REQUEST_ID_MAX_BYTES,
      )
    : undefined;
  return {
    http_status: response.status,
    ...(requestId ? { request_id: requestId } : {}),
    body,
    body_sha256: sha256Hex(sanitized),
    truncated: body !== sanitized,
  };
}

/**
 * Credential-ish object KEYS — the key-name half of SECRET_VALUE_FIELD applied to
 * structured values. Over-redaction is cheaper than a persisted credential.
 */
const CREDENTIAL_KEY_NAME =
  /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|auth[-_]?token|authorization|client[-_]?secret|secret|password|token|credential|cookie|private[-_]?key)/i;

/**
 * A credential-looking `name:`/`name=` surviving the textual passes (truncated or
 * escaped JSON) fails closed to whole-string redaction.
 */
const RESIDUAL_CREDENTIAL_PATTERN =
  /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|auth[-_]?token|authorization|client[-_]?secret|secret|password|token|credential|cookie|private[-_]?key)\s*["'\\]*\s*[:=]/i;

const ARG_EVIDENCE_MAX_DEPTH = 16;

function sanitizeArgumentText(
  value: string,
  options: ProviderErrorSanitizeOptions,
  depth: number,
): string {
  const text = sanitizeProviderErrorText(value, options);
  let inspected = text;
  for (let level = depth; level <= ARG_EVIDENCE_MAX_DEPTH; level += 1) {
    // Inspect decoded views too: embedded/malformed text need not start with a JSON
    // delimiter and its keys may be escaped several times. Keep original escaping.
    if (
      RESIDUAL_CREDENTIAL_PATTERN.test(inspected) ||
      sanitizeProviderErrorText(inspected, options) !== inspected
    ) {
      return '[redacted]';
    }
    const decoded = inspected.replace(/\\(?:["\\/bfnrt]|u[\da-fA-F]{4})/g, (encoded) =>
      JSON.parse(`"${encoded}"`),
    );
    if (decoded === inspected) return text;
    inspected = decoded;
  }
  // An unresolved representation at the bound must not retain a credential.
  return '[redacted]';
}

function sanitizeArgumentValue(
  value: unknown,
  options: ProviderErrorSanitizeOptions,
  depth: number,
): unknown {
  if (depth > ARG_EVIDENCE_MAX_DEPTH) return '[redacted]';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
      // JSON string literals too: each parse unwraps one encoding layer under the
      // same depth bound as object/array traversal.
      try {
        return JSON.stringify(sanitizeArgumentValue(JSON.parse(value), options, depth + 1));
      } catch {
        // All retained string fallbacks share the fail-closed boundary below.
      }
    }
    return sanitizeArgumentText(value, options, depth);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeArgumentValue(entry, options, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[sanitizeArgumentText(key, options, depth)] = CREDENTIAL_KEY_NAME.test(key)
        ? '[redacted]'
        : sanitizeArgumentValue(entry, options, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Recursively sanitize tool-call ARGUMENTS for durable failure evidence (YUK-1559
 * C6): credential-ish keys are redacted at any depth, embedded JSON strings are
 * parsed and sanitized inside, and unparseable text showing a credential-looking
 * `key:`/`key=` fails closed to '[redacted]'.
 */
export function sanitizeArgumentsEvidence(
  value: unknown,
  options?: ProviderErrorSanitizeOptions,
): unknown {
  return sanitizeArgumentValue(value, options ?? {}, 0);
}

/**
 * Same boundary for streamed argument TEXT: parsable chunks are sanitized
 * structurally and re-serialized; unparseable text gets the textual passes plus
 * the residual fail-close.
 */
export function sanitizeArgumentsEvidenceText(
  text: string,
  options?: ProviderErrorSanitizeOptions,
): string {
  try {
    return JSON.stringify(sanitizeArgumentValue(JSON.parse(text), options ?? {}, 0));
  } catch {
    return sanitizeArgumentText(text, options ?? {}, 0);
  }
}

/**
 * Wrap the provider fetch handed to a pi query: on a non-2xx the body is cloned
 * and recorded while the original response reaches the SDK untouched. The LAST
 * non-2xx wins — retries may pass several failures before the reported one.
 */
export function createProviderErrorCaptureFetch(
  base: typeof fetch,
  options?: ProviderErrorSanitizeOptions,
): {
  fetch: typeof fetch;
  latest(): ProviderErrorEvidence | undefined;
  /**
   * Same boundary for pi's formatted errorMessage, which may embed the full
   * unbounded provider body.
   */
  sanitize(text: string): string;
} {
  let latest: ProviderErrorEvidence | undefined;
  return {
    fetch: async (input, init) => {
      const response = await base(input, init);
      if (!response.ok) {
        latest = await readProviderErrorEvidence(response.clone(), options).catch(() => latest);
      }
      return response;
    },
    latest: () => latest,
    sanitize: (text) =>
      truncateUtf8(sanitizeProviderErrorText(text, options), PROVIDER_ERROR_BODY_MAX_BYTES),
  };
}
