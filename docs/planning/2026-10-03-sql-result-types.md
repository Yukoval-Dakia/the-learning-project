# YUK-1071 — remaining SQL result types

PR1529 covered the original issue list. A full source scan found20 further raw-SQL
result double casts in15 files, so YUK-1071 stayed open. This follow-up removes those
remaining result casts with Drizzle execute row generics and direct access to already
typed results. Four row interfaces become closed type aliases accepted by Drizzle's
Record constraint; paper detail reuses its existing SubmittedRow shape.

Queries, ordering, locks, transactions, number|string decoding, JSON validation and
empty-result fallbacks are unchanged. The configuration epoch query also declares its
selected seq_synced column. The old kc_dedup cast-convention comment is updated.
This does not claim that unrelated JSON, SDK or AST boundary casts have been removed.

## Verification

TypeScript AST comparison against base0dfc37cd confirms all58 SQL tagged templates
in the15 changed source files are byte-identical, including interpolated expressions.
27 unit tests across3 files and257 real Postgres tests across14 files pass, covering
configuration hydration/epoch/restore, paper slot counts/read models, mastery and
prerequisite closure, knowledge due/dedup/frontier jobs and few-shot retrieval.
Typecheck, lint (299 existing warnings), build and all10 pre-PR audits pass. Postman
regeneration is unchanged. No new regression tests are needed for the type-only change.
Independent initial review found no introduced P0/P1 or substantive P2 regression.
Exact-head CI and the required17-minute final-push window remain before merge; final evidence in PR.
No new dependency, schema migration, UI, production operation or provider call.
Capture: independent review found an inherited raw timestamp mismatch affecting the
few-shot recency tiebreaker. After duplicate search, YUK-1116 tracks the focused runtime
fix and real-Postgres regression separately; this PR preserves existing behavior.
