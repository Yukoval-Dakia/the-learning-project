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

// Plaintext auth headers mirrored into an error body (`X-Api-Key: <key>`,
// `Authorization=Bearer <key>`, ...) — the JSON field pattern above cannot
// see unquoted `name: value` forms.
const PLAINTEXT_AUTH_HEADER =
  /((?:authorization|x-api-key|api[-_]?key|x-auth-token|proxy-authorization|x-access-token)\s*[:=]\s*)(?:Bearer\s+|Basic\s+)?[^\s'",}\][]+/gi;

/** Request ids are receipts too — sanitize and bound them like the body. */
export const PROVIDER_ERROR_REQUEST_ID_MAX_BYTES = 128;

export interface ProviderErrorSanitizeOptions {
  /**
   * The resolved credential value(s) used for THIS request — verbatim and
   * JSON-escaped forms are redacted before the generic patterns, because an
   * error body can echo the key back in arbitrary text (`Invalid API key:
   * <key>`) where no field-name or token-shape pattern reaches it.
   */
  secrets?: readonly string[];
}

/**
 * Redact credential material from provider-produced text. The caller's
 * actual credential is removed in both its verbatim form and the form it
 * takes inside a JSON string (`JSON.stringify` escapes `"` / `\` / control
 * chars), then the generic field/header/token patterns run. Anything the
 * rules miss stays verbatim: this is a hygiene floor, not a parser.
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
 * Read a non-2xx response's body into bounded, sanitized evidence. Callers
 * pass `response.clone()` when the SDK still owns the original stream.
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
 * Credential-ish object KEYS — the key-name half of SECRET_VALUE_FIELD,
 * applied to structured argument values where the text-level pattern cannot
 * see escaped/nested keys. Failure evidence fails closed: an over-redacted
 * field name is a lesser cost than a persisted credential.
 */
const CREDENTIAL_KEY_NAME =
  /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|auth[-_]?token|authorization|client[-_]?secret|secret|password|token|credential|cookie|private[-_]?key)/i;

/**
 * A credential-looking `name:`/`name=` still present AFTER the textual
 * passes — the string may be truncated/escaped JSON that neither the JSON
 * field pattern nor a strict parse could neutralize. Anything matching this
 * residual pattern fails closed to a whole-string redaction.
 */
const RESIDUAL_CREDENTIAL_PATTERN =
  /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|auth[-_]?token|authorization|client[-_]?secret|secret|password|token|credential|cookie|private[-_]?key)\s*["'\\]*\s*[:=]/i;

const ARG_EVIDENCE_MAX_DEPTH = 16;

function sanitizeArgumentValue(
  value: unknown,
  options: ProviderErrorSanitizeOptions,
  depth: number,
): unknown {
  if (depth > ARG_EVIDENCE_MAX_DEPTH) return '[redacted]';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      // Embedded JSON text — the model serialized a composite inside a string
      // field. Recurse so inner credential KEYS are redacted even though the
      // outer text never exposes them unescaped.
      try {
        return JSON.stringify(sanitizeArgumentValue(JSON.parse(value), options, depth + 1));
      } catch {
        // Malformed embedded JSON: textual passes first, then fail closed if
        // a credential-looking field remains that no pattern could redact.
        const text = sanitizeProviderErrorText(value, options);
        return RESIDUAL_CREDENTIAL_PATTERN.test(text) ? '[redacted]' : text;
      }
    }
    return sanitizeProviderErrorText(value, options);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeArgumentValue(entry, options, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = CREDENTIAL_KEY_NAME.test(key)
        ? '[redacted]'
        : sanitizeArgumentValue(entry, options, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Recursively sanitize a tool-call ARGUMENTS value for durable failure
 * evidence (YUK-1559 C6). Unlike `sanitizeProviderErrorText` — a textual
 * hygiene pass — this walks the parsed structure: credential/auth object
 * keys are replaced by '[redacted]' at any depth, string fields that embed
 * JSON are parsed and sanitized INSIDE, and the resolved provider credential
 * is still removed verbatim and JSON-escaped. Unparseable text that still
 * shows a credential-looking `key:`/`key=` fails closed to '[redacted]'.
 */
export function sanitizeArgumentsEvidence(
  value: unknown,
  options?: ProviderErrorSanitizeOptions,
): unknown {
  return sanitizeArgumentValue(value, options ?? {}, 0);
}

/**
 * The same boundary applied to streamed argument TEXT: a strict-parsable
 * chunk is sanitized structurally (embedded JSON credentials included) and
 * re-serialized; unparseable text gets the textual passes plus the residual
 * credential fail-close. Used for every retained argument representation so
 * malformed first-turn evidence cannot leak an embedded credential either.
 */
export function sanitizeArgumentsEvidenceText(
  text: string,
  options?: ProviderErrorSanitizeOptions,
): string {
  try {
    return JSON.stringify(sanitizeArgumentValue(JSON.parse(text), options ?? {}, 0));
  } catch {
    const sanitized = sanitizeProviderErrorText(text, options);
    return RESIDUAL_CREDENTIAL_PATTERN.test(sanitized) ? '[redacted]' : sanitized;
  }
}

/**
 * Wrap the provider fetch handed to a pi query: on a non-2xx response the
 * body is cloned and recorded while the original response still reaches the
 * provider SDK untouched (pi's errorMessage continues to render its own
 * formatted summary). The LAST non-2xx wins — provider retries may pass
 * several failures before the terminal one the run reports.
 */
export function createProviderErrorCaptureFetch(
  base: typeof fetch,
  options?: ProviderErrorSanitizeOptions,
): {
  fetch: typeof fetch;
  latest(): ProviderErrorEvidence | undefined;
  /**
   * The same boundary applied to pi's formatted errorMessage — the driver
   * may embed the full (unbounded, unsanitized) provider body in it, so a
   * retained copy must pass through identical sanitize + UTF-8 cap.
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
