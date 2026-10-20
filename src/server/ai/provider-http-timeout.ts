/**
 * YUK-1531 — the OpenAI SDK aborts the whole request, including a live stream,
 * at 10 minutes unless the call passes `timeout`. undici's own defaults
 * (headers/body idle 5 minutes, connect 10 seconds) are NOT reset by the SDK
 * timer — a task budget must make every layer explicit, or the provider
 * socket can die before the lifecycle abort ever fires.
 *
 * YUK-1630 — the resolved task budget is now the single configuration source
 * for the whole provider HTTP timeout chain: the SDK per-request `timeout`
 * AND the undici connect/headers/body timers all take the same derived value
 * (`task + margin`). The margin exists only so the lifecycle's exact task
 * abort (and the caller deadline / lease fencing ahead of it) always fires
 * first; it is derived, not a second configurable ceiling.
 */
export const OPENAI_SDK_DEFAULT_TIMEOUT_MS = 600_000;

/** Budget-derived headroom so the lifecycle abort fires before HTTP layers do. */
export const PROVIDER_HTTP_TIMEOUT_MARGIN_MS = 15_000;

/**
 * The single derived HTTP bound for one task budget. Applied verbatim as the
 * SDK `timeout` request option and as the undici connect/headers/body timers
 * on the attempt's controlled dispatcher (provider-transport.ts).
 */
export function providerHttpTimeoutMs(taskTimeoutMs: number): number {
  return taskTimeoutMs + PROVIDER_HTTP_TIMEOUT_MARGIN_MS;
}
