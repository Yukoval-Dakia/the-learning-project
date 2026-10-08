import { apiFetch } from '@/ui/lib/api';

// TanStack RPC uses this same token/error transport as the retained HTTP clients.
export const authenticatedStartFetch: typeof fetch = (input, init) => {
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
