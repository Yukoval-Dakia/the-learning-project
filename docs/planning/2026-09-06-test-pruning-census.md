# Project-wide pruning census — YUK-959

Inspected AI catalog/runner, kernel, subjects, UI, capability manifest/ownership,
and integration test scopes for obsolete path scans, full option snapshots and
duplicated assembly checks. This is a structural census, not a claim that every
test assertion was manually reviewed or that smaller test counts imply quality.

Earlier batches removed capability-move scans and retired pipeline internals.
The remaining safe deletion is two Notes path-existence cases plus the duplicate
central-file absence assertion. Actual manifest tool/job/subscription loading,
task ownership and the shared artifact envelope's semantic boundary remain.
Central architecture audits continue scanning forbidden semantic roots/imports.

Candidates deliberately retained:

- Math serializer round-trip: a distinct realistic profile, not merely a path assertion.
- Provider-attempt lifecycle boundary: equivalent protection against legacy cost
  writes has not been demonstrated by the general schema audit; do not weaken billing safety.
- Prompt/skill contracts and paid-retry scan: model behavior and charge boundaries
  cannot be replaced by mocked happy-path output.
- UI lazy-bundle and accessibility wiring: no equivalent runtime guard was proven;
  source-based checks alone do not make a test disposable.
- Rich rollback, idempotency, late-result, cancellation and recovery fixtures remain.

No production code, parser fixture, threshold or UI changed. Focused Notes and
architecture unit gates, typecheck/lint/build, independent review and exact-head CI
are required. Production observation and SoT retirement remain separate work.

Local result: 131 focused unit cases passed; typecheck, lint, production build and
architecture audit passed. Independent initial review approved with no P0/P1.
Exact-head CI remains the full-suite authority before merge.
