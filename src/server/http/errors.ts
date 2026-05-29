export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return Response.json({ error: err.code, message: err.message }, { status: err.status });
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
