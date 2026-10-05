# YUK-1007 — task budget snapshots

The configuration store accepted task budget overrides, but execution continued to
read frozen TaskSpecs. Resolve a fresh immutable TaskBudget synchronously at each
chat/typed entry point, before middleware, admission or adapter startup. A running
invocation and all its retries retain that value; the next invocation sees refreshed
configuration. Existing explicit maxIterations/timeoutMs parameters win per field.
TaskSpecs remain unchanged as defaults.

Chat consumes maxIterations, timeout and opt-in transientRetries. Typed execution
consumes timeout, transientRetries and cumulative maxCost, retaining retry:none,
unknown-cost reserves, settlement failure handling and the fixed typed binding.
Streaming stays single-attempt. Caller/provider session deadlines and admission
bounds still apply independently of the task timeout.

The admin contract adds budget_wiring, effective_budget and budget_note, using the
same resolver as execution. Unsupported chat maxCost and typed maxIterations report
null. The aggregate override_wired.budget flag stays false because neither lane
consumes every field; consumers must inspect the field-level wiring. Effective values
are next-call baselines, before explicit caller overrides and retry policy gates.
Generated API types and Postman documentation follow this backend contract; no UI
components or settings writes are implemented in this slice.

## Validation

Five regression cases fail before the reader change: ordinary/SSE/collecting snapshots,
retry after refresh, and typed cumulative cost. They pass after wiring; scoped tests
also cover next-call refresh, explicit override priority, typed retry:none, middleware
and real Postgres hydration/read-model consistency. Exact totals and local gates,
independent review, exact-head CI and required final-push window recorded in the PR.
Local result:185 unit/9files and67 real-Postgres tests/4files pass, together with
typecheck, lint(299 existing warnings), build and all10 pre-PR audits. Independent
initial review found no introduced P0/P1. One substantive P2 is tracked in the same
epic: configured timeouts >=1h violate the stuck-run sweeper lifetime assumption.
Defaults remain below the threshold. Bound persisted/read budgets or persist a
reconciliation deadline before exposing the write UI/HTTP; a UI-only clamp is insufficient.
No real model requests, production changes or dependency upgrades.

Capture: remaining atomic configuration writes/reset and UI are already tracked in
YUK-1007; inherited timestamp behavior is separately tracked in YUK-1116.
