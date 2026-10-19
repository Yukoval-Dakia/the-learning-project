/**
 * YUK-1531 — the OpenAI SDK aborts the whole request, including a live stream,
 * at 10 minutes unless the call passes `timeout`. undici's default
 * headersTimeout/bodyTimeout is 5 minutes and is not reset by the SDK timer.
 * A task budget longer than either of those must raise both, or the provider
 * socket dies before the lifecycle abort.
 */
export const OPENAI_SDK_DEFAULT_TIMEOUT_MS = 600_000;
export const UNDICI_DEFAULT_IDLE_TIMEOUT_MS = 300_000;

/** Headroom so the lifecycle abort fires before the HTTP client does. */
const PROVIDER_HTTP_TIMEOUT_MARGIN_MS = 15_000;

/**
 * Undefined keeps the OpenAI SDK's 10-minute default and `globalThis.fetch`.
 * Replacing fetch for every task would skip observers that wrap the global
 * fetch, including the judge transport fixture. Only a budget that cannot fit
 * in that default gets a longer HTTP timer.
 */
export function providerHttpTimeoutMs(taskTimeoutMs: number): number | undefined {
  const needed = taskTimeoutMs + PROVIDER_HTTP_TIMEOUT_MARGIN_MS;
  if (needed <= OPENAI_SDK_DEFAULT_TIMEOUT_MS) return undefined;
  return needed;
}
