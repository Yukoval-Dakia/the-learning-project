export interface FailureDiagnostics {
  stage?: 'remote_mcp_connect' | 'remote_mcp_list_tools' | 'remote_mcp_schema';
  cause: { name: string; code?: string | number; hostname?: string }[];
}

/** Any cause-chain link: a thrown error or the transport collector's captured evidence. */
export interface FailureLink {
  readonly name?: unknown;
  readonly code?: unknown;
  readonly hostname?: unknown;
  readonly cause?: readonly FailureLink[];
}

const contexts = new WeakMap<object, Omit<FailureDiagnostics, 'cause'> & { hostname?: string }>();
const ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
  'DOMException',
  'ConnectTimeoutError',
  'HeadersTimeoutError',
  'BodyTimeoutError',
  'SocketError',
  'RequestAbortedError',
  'ResponseError',
  'McpError',
  'SseError',
]);

function field(value: object, key: string): unknown {
  // Diagnostics must not execute an exception's custom getters.
  for (let current: object | null = value, depth = 0; current && depth < 4; depth++) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return descriptor.value;
      current = Object.getPrototypeOf(current);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sanitizeName(name: unknown): string {
  return typeof name === 'string' && ERROR_NAMES.has(name) ? name : 'Error';
}

function sanitizeCode(code: unknown): string | number | undefined {
  if (typeof code === 'string' && /^(?:E[A-Z0-9_]{1,47}|UND_ERR_[A-Z_]{1,40})$/.test(code)) {
    return code;
  }
  if (typeof code === 'number' && Number.isSafeInteger(code) && Math.abs(code) <= 65535) {
    return code;
  }
  return undefined;
}

function sanitizeHostname(hostname: unknown): string | undefined {
  return typeof hostname === 'string' &&
    hostname.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:]+\])$/i.test(hostname)
    ? hostname
    : undefined;
}

function sanitizeLink(name: unknown, code: unknown, hostname: unknown) {
  const safeCode = sanitizeCode(code);
  const safeHostname = sanitizeHostname(hostname);
  return {
    name: sanitizeName(name),
    ...(safeCode !== undefined ? { code: safeCode } : {}),
    ...(safeHostname !== undefined ? { hostname: safeHostname } : {}),
  };
}

export function annotateFailure(
  error: unknown,
  stage: NonNullable<FailureDiagnostics['stage']>,
  hostname: string,
): void {
  if (error && typeof error === 'object') contexts.set(error, { stage, hostname });
}

/** Metadata only: three links, fixed error names, bounded codes and DNS/IP hostnames. */
export function failureDiagnostics(error: unknown): FailureDiagnostics {
  const context = error && typeof error === 'object' ? contexts.get(error) : undefined;
  const cause: FailureDiagnostics['cause'] = [];
  const seen = new Set<object>();
  for (let current = error; current && typeof current === 'object' && cause.length < 3; ) {
    if (seen.has(current)) break;
    seen.add(current);
    cause.push(
      sanitizeLink(
        field(current, 'name'),
        field(current, 'code'),
        contexts.get(current)?.hostname ?? field(current, 'hostname'),
      ),
    );
    current = field(current, 'cause');
  }
  return { ...(context?.stage ? { stage: context.stage } : {}), cause };
}

/**
 * The same whitelist over evidence that no longer travels as a thrown error: the
 * provider transport collector captured the wire cause before the SDK flattened
 * it into a message string. `fallbackHostname` is the endpoint the attempt tried
 * to reach; it is attached only when no link names a host.
 */
export function failureDiagnosticsFromLinks(
  head: FailureLink | undefined,
  fallbackHostname?: string,
): FailureDiagnostics | undefined {
  if (!head) return undefined;
  const cause: FailureDiagnostics['cause'] = [];
  const seen = new Set<object>();
  for (let current: FailureLink | undefined = head; current && cause.length < 3; ) {
    if (seen.has(current)) break;
    seen.add(current);
    cause.push(sanitizeLink(current.name, current.code, current.hostname));
    current = current.cause?.[0];
  }
  const safeHostname = sanitizeHostname(fallbackHostname);
  if (
    safeHostname !== undefined &&
    cause.length > 0 &&
    !cause.some((link) => link.hostname !== undefined)
  ) {
    cause[cause.length - 1] = { ...cause[cause.length - 1], hostname: safeHostname };
  }
  return cause.length > 0 ? { cause } : undefined;
}

/** True when a link carries code or hostname — the fields that make a failure actionable. */
export function failureDiagnosticsCarryEvidence(diagnostics: FailureDiagnostics): boolean {
  return diagnostics.cause.some((link) => link.code !== undefined || link.hostname !== undefined);
}

/**
 * A bare hostname from an endpoint URL (`https://h:8443/v1` → `h`). Unparsable
 * input yields undefined; diagnostics never throw on the path that reports a failure.
 */
export function hostnameFromUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw).hostname;
  } catch {
    return undefined;
  }
}
