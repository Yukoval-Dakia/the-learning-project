// Nightly DAG orchestrator constants. Kept out of the god file.

/** Single-anchor orchestrator queue. */
export const ORCHESTRATOR_QUEUE = 'nightly_orchestrator';

/** Must match `createJobQueue`'s `${name}_dlq`; drift passes tests against a queue
 *  nobody creates. */
export const ORCHESTRATOR_DLQ = `${ORCHESTRATOR_QUEUE}_dlq`;

/**
 * Anchor at ~02:30 Asia/Shanghai. Members declare no cron of their own
 * (`validateComposition` enforces it). The cron string is derived from hour/minute
 * so the boot catch-up gate cannot drift from the anchor.
 */
export const ORCHESTRATOR_ANCHOR_HOUR = 2;
export const ORCHESTRATOR_ANCHOR_MINUTE = 30;
export const ORCHESTRATOR_CRON = `${ORCHESTRATOR_ANCHOR_MINUTE} ${ORCHESTRATOR_ANCHOR_HOUR} * * *`;
export const ORCHESTRATOR_TZ = 'Asia/Shanghai';

/**
 * Boot catch-up window. pg-boss never replays a missed cron, so a stack that is
 * down around the anchor creates no run at all. Without the window a midday restart
 * would drag the paid chain into learner hours; 5h ends by 07:30.
 */
export const ORCHESTRATOR_CATCHUP_WINDOW_SECONDS = 5 * 60 * 60;

/**
 * Tick self-schedule interval. pg-boss persists the send, so the chain survives a
 * worker restart; 60s is enough for nightly layers to converge.
 */
export const TICK_INTERVAL_SECONDS = 60;

/**
 * Node timeout. A node still enqueued/running after this fails, so hard downstreams
 * skip with a trace. It covers the full retry budget: (1 + JOB_RETRY_LIMIT) ×
 * EXPIRE_AGENT + backoff ≈ 6h. `enqueued_at` is written once at claim, so a shorter
 * timeout would fail during attempt two even if attempt three succeeded.
 *
 * pg-boss expire/retry remains the primary backstop; this only catches jobs pg-boss
 * will never converge. Recompute when the retry constants change.
 */
export const NODE_TIMEOUT_SECONDS = 7 * 60 * 60;

/**
 * Stagger for members enqueued in the same pass.
 *
 * `JobDecl.queue` is a tier label, not a pg-boss queue name; every job has its own
 * worker, so batchSize:1 does not stop different jobs from firing together. The
 * eight llm roots would hit the provider at once with no concurrency gate, no
 * in-process backoff, and 30s retries without jitter.
 *
 * A serial chain usually has one ready node, so offset 0 adds no delay. The cap keeps
 * delay bounded; 15min + the 6h retry budget still fits the 7h timeout.
 */
export const LAYER_STAGGER_SECONDS = 120;
export const LAYER_STAGGER_MAX_SECONDS = 15 * 60;
