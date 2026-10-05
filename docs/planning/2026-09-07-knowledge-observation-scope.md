# YUK-967 — optional knowledge observations

The original presentation-tool actual invented absence of recent failures after
requesting only children. Knowledge owns whether a section was observed; neither
Copilot prose nor a second evaluator should infer it from an absent property.

Plan:
1. Add explicit not_requested / no_returned_nodes / observed section status at
   the existing reader contract, plus the bounded failure scope.
2. Verify omitted, empty, nonempty and unmatched-node reads against real DB rows;
   verify the same contract survives the public result snapshot.
3. Run the unchanged presentation-tool actual from a clean integrated revision,
   reserving before any paid call. Reserve0.40 for the original presentation-tool
   case: total authorized10 pool reserve9.95823/safe0.04177. Estimates remain
   0.0690050668 before this run; no historical reserve is reclaimed.
4. Independent review, local scoped gates and exact-head CI before merge.

No extra query/model call, reply rewriting, new evaluator or UI change. Existing
failure snippets are latest10 across recorded attempts; stats counts remain30d.
Do not silently turn either into the other or claim global absence from no nodes.

Implemented at e0bba356.12 reader DB and34 snapshot/fixture DB tests, typecheck,
lint and build pass; independent initial review PASS. No extra model/query call.
The new worktree uses its own frozen-lock dependencies; an initial shared-modules
symlink failed pnpm's dependency check, was removed (link only), and no shared
modules were changed. No RED claim is based on that environment failure.

Actual passes at clean5717bcbdf66de6a80d2cad4cac11259f6a769c42, unchanged original
presentation-tool prompt. One root/read/presentation, both node names correct,
no invented unobserved failures.1502-byte live/persisted snapshot retains statuses
and scoped claim authority. Evidence: `evidence/2026-09-07-knowledge-observation-actual.json`.
Input41516 vs earlier41280 (+236); this correctness change does not claim token
reduction. Estimate0.0031086707, cumulative0.0721137375 (not invoice), reserve9.95823,
safe0.04177. No paid process remains. Integration/exact CI pending; no production.

Integrated with YUK-969 on main5bd921e3 (YUK-968 delivered). Root100 DB/41 unit,
typecheck/lint/build and architecture gates pass; each lane has independent initial
review PASS. AI guidance now points at existing capability tool/judge owners,
removing stale central paths without duplicating inventory. Exact PR CI remains.
