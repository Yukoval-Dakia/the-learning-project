// 内核 http 错误整形 facade（P1 薄壳，YUK-311）— 包装遗留 @/server/http/errors，
// capability 包的 API handler 统一从这里取 ApiError/errorResponse。
export { ApiError, errorResponse } from '@/server/http/errors';

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
