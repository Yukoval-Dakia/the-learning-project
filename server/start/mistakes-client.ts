import type { listMistakes } from '@/capabilities/ingestion/ui-public';
import { apiFetch } from '@/ui/lib/api';
import { getStartMistakes } from './mistakes-function';

// Reuse token headers, 401 re-gating and structured HTTP errors from the existing client.
// TanStack's RPC transport constructs a URL and RequestInit, rather than a Request.
const authenticatedFetch: typeof fetch = (input, init) => {
  if (input instanceof Request) {
    return apiFetch(input.url, {
      method: input.method,
      headers: input.headers,
      signal: input.signal,
      ...init,
    });
  }
  return apiFetch(input.toString(), init);
};

export const listStartMistakes: typeof listMistakes = (input) =>
  getStartMistakes({
    data: { limit: String(input.limit), subject: input.subject },
    fetch: authenticatedFetch,
  });
