export function buildAuthedRequest(
  url: string,
  init: RequestInit = {},
  token = 'test-token',
): Request {
  const headers = new Headers(init.headers);
  headers.set('x-internal-token', token);
  return new Request(url, { ...init, headers });
}
