/**
 * YUK-1531 / YUK-1630 — the resolved task budget is the single source for the whole
 * provider HTTP timeout chain: the SDK per-request `timeout` AND the undici
 * connect/headers/body timers take the same derived value (task + margin).
 *
 * The margin exists only so the lifecycle abort (and the caller deadline / lease
 * fencing ahead of it) fires first; it is derived, not a second ceiling. Without
 * explicit values the SDK's 10-minute timer and undici's own defaults would race
 * and the socket could die before the lifecycle abort.
 */
export const OPENAI_SDK_DEFAULT_TIMEOUT_MS = 600_000;

/** Budget-derived headroom so the lifecycle abort fires before HTTP layers do. */
export const PROVIDER_HTTP_TIMEOUT_MARGIN_MS = 15_000;

/**
 * The single derived HTTP bound: applied verbatim as the SDK `timeout` and as the
 * controlled dispatcher's connect/headers/body timers.
 */
export function providerHttpTimeoutMs(taskTimeoutMs: number): number {
  return taskTimeoutMs + PROVIDER_HTTP_TIMEOUT_MARGIN_MS;
}
