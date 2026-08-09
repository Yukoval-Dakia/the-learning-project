# Direct-provider attempt admission

This control applies only to direct HTTP/SDK and opaque Mem0 provider attempts. It does not change
the central Claude Agent SDK session gate.

## Closed lanes and policy

Only these lane keys are accepted:

- `dashscope.embedding`
- `glm.knowledge-edge-reconcile`
- `glm.memory-reconcile`
- `glm.ocr-layout-parsing`
- `mem0.event-memory`
- `tencent.question-mark-agent`

Set `AI_PROVIDER_ATTEMPT_ADMISSION_MODE` to `off`, `observe`, or `enforce`. Set
`AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON` to an object whose explicitly listed lane values each
contain positive integer `maxConcurrentAttempts` and `maxAttemptStartsPerMinute`. Unknown keys are
rejected. Missing config, an unlisted lane, or global `off` resolves to off.
`off` disables capacity/rate enforcement but does not disable durable `provider_attempt` lifecycle
and cost truth for calls that reach the provider. Its best-effort admission row records the exact
`mode = off` with `status = acquired`, including when the immutable provider deadline has already
elapsed; off never records `would_deny`. These rows retain the normal pre-start lease for lifecycle
fencing but are excluded from capacity, rate, and mixed-policy accounting.

There is no queue. Admission uses the database clock and lane advisory serialization. A successful
reservation consumes rate capacity immediately. Pre-start reservations count as active; after
provider start the lease remains active until terminal settlement or the immutable absolute
deadline. `observe` persists `would_deny` and allows the provider callback. `enforce` persists a
denial and throws before the callback. Mixed live policy fingerprints fail closed in enforce and
produce `would_deny` in observe.

Cost readers aggregate terminal, provider-started attempt truth in SQL. They remove a legacy row
only when its `task_run_id` is a valid UUID that exactly links an authoritative attempt. Unlinked
historical OCR rows remain visible as legacy truth; no timestamp-based suppression is applied.
Tencent Submit uses one stable logical attempt identity per page operation across pg-boss retry
generations. Provider-started legacy generation rows without a saved JobId remain retryably fenced.
When retries are exhausted, only a terminal or historical ambiguous started Submit is terminalized
as a failed extraction. A competing delivery must never terminalize a live Submit owner, even on its
final retry. The attempt fence must not be auto-cleared or replayed because provider acceptance is
unknown. An operator must reconcile external Tencent evidence and follow normal failed-session
recovery before any explicit repair; this runbook does not authorize destructive cleanup or
automatic fence release.

## Rollout and rollback

Use exactly the same mode and policy JSON in the Hono app and pg-boss worker environments. Start
with `observe`, inspect durable admission outcomes, then move selected listed lanes to `enforce`
only under separate rollout authorization. Roll back immediately by setting the global mode to
`off`; existing attempt/admission evidence remains available, while new off rows record rollback
mode exactly and cannot become `would_deny`. No schema or data rollback is required.

YUK-855 is code and CI evidence only. F0.O1 owns any later production rollout; this runbook does
not authorize production configuration, deployment, or a change to an existing observation boundary.
