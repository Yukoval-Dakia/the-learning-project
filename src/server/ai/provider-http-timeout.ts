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

export function providerHttpTimeoutMs(taskTimeoutMs: number): number {
  return Math.max(OPENAI_SDK_DEFAULT_TIMEOUT_MS, taskTimeoutMs + PROVIDER_HTTP_TIMEOUT_MARGIN_MS);
}
