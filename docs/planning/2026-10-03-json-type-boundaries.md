# YUK-1067 / YUK-1068 / YUK-1069 / YUK-1070 — JSON and database type boundaries

## Changes

Trait hydration, fan-out validation and subject preflight previously promoted untyped
JSON to SubjectTraitPayloads with double casts. parseTraitPayloads now composes the
existing per-kind schemas into one validated object; errors identify the failing kind.
Explicitly supplied null/undefined overrides fail validation instead of disappearing
behind a nullish fallback. Existing per-kind defaults, profile validation and hydration
fallbacks remain in place. Valid built-in profiles round-trip through the parser.

Ingestion operation polling validates code/message/status before projecting persisted
errors. Malformed extract errors fall back to extraction_failed/500; other failed
operations use operation_failed/500. Valid error fields and extra diagnostic data are
preserved. Writers are unchanged. The former pi snapshot double cast was already removed
by PR1526; no compatibility-model route is restored to add validation there.

Migration apply uses each Drizzle table's $inferSelect row type instead of duplicate
Stored interfaces and seven double casts. Queries, status transitions, canonical digests
and reconciliation semantics remain unchanged. Read-only knowledge validation and subject
name lookup accept Db|Tx; callers pass their transaction directly. Existing knowledge-domain
lookup already accepted Db|Tx, so its redundant casts are simply removed.

## Verification

Before source changes:18 real-DB failures reproduced malformed override/error handling.
New regression coverage includes all six trait kinds, older legal defaulted payloads,
unchanged built-in profiles, malformed sibling trait fan-out rollback, both ingestion
operation categories and preservation of valid diagnostic objects.
Existing migration, subject hydration/write/create, rubric and knowledge-helper tests
exercise the type-only changes. 22 unit and139 real-Postgres tests across9 DB files pass. Typecheck,lint,build
and the local pre-PR audits pass after linking the isolated API-codegen workspace
dependencies. Independent initial review found no P0/P1 or substantive P2; no
verification round is needed without a corrective patch. Final evidence is in the PR;
exact-head CI plus17-minute final-push window required before merge.
No new dependency, SQL migration, UI, production operation or provider call.
