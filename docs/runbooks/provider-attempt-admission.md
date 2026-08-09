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

There is no queue. Admission uses the database clock and lane advisory serialization. A successful
reservation consumes rate capacity immediately. Pre-start reservations count as active; after
provider start the lease remains active until terminal settlement or the immutable absolute
deadline. `observe` persists `would_deny` and allows the provider callback. `enforce` persists a
denial and throws before the callback. Mixed live policy fingerprints fail closed in enforce and
produce `would_deny` in observe.

Cost readers aggregate terminal, provider-started attempt truth in SQL. They remove a legacy row
only when its `task_run_id` is a valid UUID that exactly links an authoritative attempt. Unlinked
historical OCR rows remain visible as legacy truth; no timestamp-based suppression is applied.

## Rollout and rollback

Use exactly the same mode and policy JSON in the Hono app and pg-boss worker environments. Start
with `observe`, inspect durable admission outcomes, then move selected listed lanes to `enforce`
only under separate rollout authorization. Roll back immediately by setting the global mode to
`off`; no schema or data rollback is required.

YUK-855 is code and CI evidence only. F0.O1 owns any later production rollout; this runbook does
not authorize production configuration, deployment, or a change to an existing observation boundary.
