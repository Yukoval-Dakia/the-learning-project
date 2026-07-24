// 内核 http facade（YUK-311 / YUK-770）— ApiError/errorResponse 本体现居 kernel，
// capability 包的 API handler 统一从 @/kernel/http 取错误整形 + 响应契约。
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
    public readonly headers?: HeadersInit,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return Response.json(
      { error: err.code, message: err.message },
      { status: err.status, headers: err.headers },
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  // Log the real message + stack server-side, but never leak them to the client:
  // unhandled errors can carry DB/internal detail. Return a fixed generic body.
  console.error('unhandled error', { message, stack, timestamp: new Date().toISOString() });
  return Response.json(
    { error: 'internal_error', message: 'Internal Server Error' },
    { status: 500 },
  );
}

export const HTTP_CONTRACT_STATUS = {
  created: 201,
  accepted: 202,
  noContent: 204,
  malformedRequest: 400,
  unauthorized: 401,
  notFound: 404,
  conflict: 409,
  semanticValidation: 422,
  rateLimited: 429,
  internalError: 500,
} as const;

export type ResourceWriteOutcome = 'created' | 'existing' | 'accepted';

function statusForResourceOutcome(outcome: ResourceWriteOutcome): number {
  if (outcome === 'created') return HTTP_CONTRACT_STATUS.created;
  if (outcome === 'accepted') return HTTP_CONTRACT_STATUS.accepted;
  return 200;
}

function assertApiLocation(location: string): void {
  if (!location.startsWith('/api/')) {
    throw new Error(`resource Location must be an absolute API path: ${location}`);
  }
}

/** Return a resource creation/acceptance representation with an honest status and Location. */
export function resourceResponse(
  body: unknown,
  options: {
    outcome: ResourceWriteOutcome;
    location: string;
    headers?: HeadersInit;
  },
): Response {
  assertApiLocation(options.location);
  const headers = new Headers(options.headers);
  headers.set('Location', options.location);
  return Response.json(body, {
    status: statusForResourceOutcome(options.outcome),
    headers,
  });
}

/**
 * Add the canonical resource status/Location contract to a successful legacy handler response
 * without consuming or reshaping its JSON body. Error responses pass through unchanged.
 */
export async function canonicalResourceResponse(
  response: Response,
  options: {
    outcome: ResourceWriteOutcome | ((body: unknown) => ResourceWriteOutcome);
    location: string | ((body: unknown) => string);
  },
): Promise<Response> {
  if (!response.ok) return response;

  const body = (await response.clone().json()) as unknown;
  const outcome = typeof options.outcome === 'function' ? options.outcome(body) : options.outcome;
  const location =
    typeof options.location === 'function' ? options.location(body) : options.location;
  assertApiLocation(location);

  const headers = new Headers(response.headers);
  headers.set('Location', location);
  return new Response(response.body, {
    status: statusForResourceOutcome(outcome),
    statusText: response.statusText,
    headers,
  });
}

export interface CursorPage {
  limit: number;
  next_cursor: string | null;
}

/** Build the canonical collection envelope while retaining explicitly supplied legacy fields. */
export function collectionPayload<T, Legacy extends object = Record<never, never>>(
  data: T[],
  page: CursorPage,
  legacy?: Legacy,
): { data: T[]; page: CursorPage } & Legacy {
  return {
    ...(legacy ?? ({} as Legacy)),
    data,
    page,
  };
}

/**
 * Wrap a legacy route response without consuming or reshaping its body.
 *
 * RFC 9745 requires `Deprecation` to be a Structured Field Date, so the stable
 * value below records when this compatibility program began. A `Sunset` header
 * is intentionally omitted until usage evidence supports a real cutoff.
 * `successor-version` gives clients a machine-readable migration target.
 */
export function deprecatedRouteResponse(response: Response, successorPath: string): Response {
  const headers = new Headers(response.headers);
  headers.set('Deprecation', '@1783987200'); // 2026-07-14T00:00:00Z
  headers.append('Link', `<${successorPath}>; rel="successor-version"`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
