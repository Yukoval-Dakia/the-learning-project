# YUK-1007 AI output locale hot reload

## Delivered behavior

`locale.learner` now controls the learner-facing language instruction for chat task
system prompts (`zh-CN` or `en`). The Chinese default remains byte-identical.
The existing config write/hydrate path supplies the value; this change adds no
HTTP mutation route, UI, schema migration, provider call or deployment.
The config read API reports the real consumer and its effective language.

Each runner invocation captures locale before asynchronous work and preserves it
through retries. The next invocation reads the latest process snapshot. The
existing app/worker refresh interval is 15 seconds; failed refresh retains the
last good snapshot, so this is a polling interval, not a failure-free SLA.
The intervention validator's solve/content/review stages share one locale, used
both for execution and sealed prompt fingerprints. Evaluation captures one locale
per fixture, including observations after asynchronous calls. This fixes the P1
found in independent review of the initial dynamic-reader implementation.
Current-template checks still invalidate historical evidence when the current
prompt changes, matching the existing prompt-version policy.

Typed tasks have no system prompt and retain their routing guard. UI language,
per-task budgets, configuration editing routes, and the settings panel remain
separate YUK-1007 work. No real-model language-quality claim is made.

## Verification

- Initial regression: 1 failed / 40 passed; setting English did not affect prompts.
- Final scoped unit: 252 passed across nine files (prompts, registry goldens,
  config read model, runner seam, provenance, runner-fn, intervention author,
  intervention evaluation).
- Real Postgres: 55 passed across admin-config HTTP and intervention-preparation
  suites. Covers set/clear, invalid-write rejection, exact default restoration,
  and locale changes during a sealed multi-stage validator run.
- Independent review: one P1 fixed; final review found no P0/P1 or new P2.
  Reviewer independently ran 68 runner/admission/evaluation unit cases.
- Typecheck, lint (299 existing warnings), lint ratchet, production build and
  partition/API-client/API-client-usage/capability-boundaries/provider-lanes/
  profile/task-census/draft-status/draft-status-reads audits pass.
- `audit:schema` fails with 65 expired allowlist entries, all dated 2026-09-30.
  Re-running at untouched main `0718757169723bbad0efc73506c708dccc80af17`
  produces the identical 65 entries. No allowlist or audit gate was changed.
  Affected groups: answer (1), learning_session (3), event (9), item_calibration
  (3), mastery_state (2), subject_trait_journal (3), event_subscription_checkpoint
  (11), event_subscription_delivery (17), event_subscription_effect (16).
  Tracked as YUK-1111; blocks merge readiness pending evidence-backed reconciliation.

Local command logs: `/tmp/yuk1007-locale-*.log` and
`/tmp/yuk1007-base-schema.log` in the task environment. Full local `pnpm test`
was not run; remote exact-head CI remains required.

## Shared gate recovery

Merged prerequisite branch #1522 (YUK-1111/YUK-1115) into this candidate: the
65-expiration failure above is historical. 61 obsolete exemptions removed; four
real reserved fields have explicit bounded follow-up YUK-1113. New SQL/default
producer support and dependency repairs pass locally. Full exact-head CI reruns
after push; prerequisite PR and this locale PR are not yet claimed merged.

The final candidate also includes pi 1.0.0 prerequisite #1523. Its system message
transport now carries the locale-bound prompt. Each prerequisite has its own
independent review; no review budget is reset by merging the branches.

Combined local acceptance after pi/schema/dependency integration: 160 unit cases
across five files and 55 real-Postgres cases across two files passed. Typecheck,
lint ratchet (299 warnings), production build and pre-PR audits passed. The
original locale-specific 252-unit evidence above remains separately scoped.
