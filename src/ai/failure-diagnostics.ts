export interface FailureDiagnostics {
  stage?: 'remote_mcp_connect' | 'remote_mcp_list_tools' | 'remote_mcp_schema';
  cause: { name: string; code?: string | number; hostname?: string }[];
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
    const name = field(current, 'name');
    const code = field(current, 'code');
    const hostname = contexts.get(current)?.hostname ?? field(current, 'hostname');
    cause.push({
      name: typeof name === 'string' && ERROR_NAMES.has(name) ? name : 'Error',
      ...(typeof code === 'string' && /^(?:E[A-Z0-9_]{1,47}|UND_ERR_[A-Z_]{1,40})$/.test(code)
        ? { code }
        : typeof code === 'number' && Number.isSafeInteger(code) && Math.abs(code) <= 65535
          ? { code }
          : {}),
      ...(typeof hostname === 'string' &&
      hostname.length <= 253 &&
      /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:]+\])$/i.test(hostname)
        ? { hostname }
        : {}),
    });
    current = field(current, 'cause');
  }
  return { ...(context?.stage ? { stage: context.stage } : {}), cause };
}
