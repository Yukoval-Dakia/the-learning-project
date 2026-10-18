import { Agent, fetch as undiciFetch } from 'undici';

/**
 * YUK-1531 — Node's global fetch and this package's Agent are different Undici
 * builds, so a longer idle budget has to call this package's own fetch. The
 * request is still the Pi driver's request. Tasks inside the SDK default never
 * reach this module and keep `globalThis.fetch`.
 */
export function createIdleBudgetFetch(timeoutMs: number): {
  fetch: typeof fetch;
  close: () => Promise<void>;
} {
  const agent = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  const fetchImpl: typeof fetch = (input, init) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as object),
      dispatcher: agent,
    }) as unknown as ReturnType<typeof fetch>;
  return {
    fetch: fetchImpl,
    close: () => agent.close(),
  };
}
