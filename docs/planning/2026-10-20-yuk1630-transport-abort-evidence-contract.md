# YUK-1630 transport abort evidence contract (Stage-1 follow-up)

Date: 2026-10-20. Product baseline: `1250790851c85308cdc47e28dca8088a50d936c6`
(post-PR1860). Scope: `src/server/ai/provider-transport.ts` only.

## Runtime-observed finding

Three real ubm admission runs on TEST (`lrhwp3pi0yqj4tjoanvs83x4`,
`svxpzmn1kpuywr6ygnbd4flp`, `oexnesqqbbmdn1ifg1u8l73r`), all HTTP 200 /
success, each ended its SSE stream with a wire-level `AbortError` (code 20)
recorded as `signal_aborted=true` + `timeout_layer='signal'` +
`signal_initiator='unknown'` + `last_failure` — with **no** lifecycle abort
markers and **no** captured `signal_reason`.

Consistent source path (evidence-consistent, not proven-origin): Node 24.22
builtin fetch `response.cancel()` aborts the fetch controller; OpenAI SDK
`core/streaming.mjs` sees `[DONE]`, breaks, and cancels the reader. The
abort surfaces at the undici layer as `onResponseError(AbortError)` WITHOUT
firing the request's composed AbortSignal. Frozen artifacts:
`…/stage1-yuk1630-timeout-20261020/ops-125079-ubm-acceptance/` +
`…/ops-yuk1630-ubm-125079085-20261020/formal-02/transport.json`.

Defect: `signalAborted()` promoted any abort-shaped error (name/code match)
into `signal_aborted`, and `last_failure` stored every wire error — so a
neutral stream-end cancellation masqueraded as timeout-layer evidence and
as a failure on a successful run.

## Contract (additive, v:1 receipt unchanged)

- `signal_aborted` — emitted ONLY when the composed AbortSignal observably
  fired (listener ran, or signal arrived already aborted). Never inferred
  from error name/code. `signal_initiator`/`signal_reason` exist only
  alongside it; unknown origin stays `unknown` or absent.
- `timeout_layer` — positive timeout evidence only:
  `UND_ERR_CONNECT_TIMEOUT`/`UND_ERR_HEADERS_TIMEOUT`/`UND_ERR_BODY_TIMEOUT`,
  or an observed signal abort attributed by `abort_initiators` to
  `execution_timeout`/`session_deadline`. Caller cancel, lease loss, generic
  teardown, SDK cleanup and unknown-origin aborts stay unclassified.
  `'sdk'` remains reserved/un-emitted.
- `last_transport_error` (new, optional) — neutral raw evidence: the most
  recent error ANY request produced, incl. records truncated out of
  `requests` (>32nd). Carries `seq`/`at`/`send_state`/`error` plus the
  observed-abort fields when present. Not a failure verdict.
- `last_failure` — now only a VERIFIED transport/timeout failure: a
  classified `timeout_layer`, or a cause chain containing substantive
  non-abort evidence. A bare abort-only error never lands here.

Unchanged: budgets, fetch/dispatcher wiring, legacy/modern/H1/H2 bridge,
lifecycle timers, send_state/totals/lane truth, retry/cost/paid outcomes.
Persisted `usage_json.transport` rows stay readable — all fields optional,
no DDL, no parsing gate. No consumer outside the module reads
`last_failure` (verified: practice `last_failure_event` is unrelated;
admin surfaces show raw JSON only).

## Explicitly NOT claimed

- Not a reproduction of the historical 10s timeout; not HTTP/2 evidence.
- Abort origin is stated as evidence-consistent, not captured-proven.
- Failure-path timeout samples remain NOT_RUN (no real timeout occurred).
