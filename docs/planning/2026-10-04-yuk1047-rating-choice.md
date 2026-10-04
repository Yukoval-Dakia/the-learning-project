# YUK-1047 — Explicit FSRS choice during assessment activation

D14–D16 in `2026-09-24-question-assessment-decisions.md` require a user's
scheduling choice to remain independent of automatic correctness evidence.
The existing activation boundary had no way to carry that choice: a correct
candidate always scheduled good, even when the learner selected hard. It also
scheduled automatic assisted evidence without an explicit user choice.

Activation now accepts optional `user_rating` using the existing again/hard/good
schema. Settlement records it as user-sourced FSRS input while retaining the
candidate's original grading provenance for theta and calibration. An automatic
assisted result retains its score but creates no FSRS write without an explicit
choice. Existing manual/self-report provenance keeps its explicit manual route.
An unresolved self-report can schedule FSRS without inventing a correct verdict.

The activation receipt freezes the explicit choice in the same transaction as
learning effects and the effective head. Repeating the same choice is idempotent;
an omitted choice is a replay/read. Supplying a different choice for an already
active candidate returns `rating_conflict`, including concurrent first activation.
A later automatic regrade preserves the last user FSRS writer while independently
correcting theta. This does not add an edit-existing-rating operation.

No historical rows or frozen replay plans are rewritten. Existing replay uses
its stored rating and source. No admission bypass, model execution, API/UI
cutover or dependency change is introduced. The eight formal entry migrations
remain under YUK-1047; this supplies their existing user-rating behavior at the
new activation boundary.

Three formal DB regressions failed first. After the fix, 107 scoped unit cases,
88 DB cases (including activation, settlement, joint input, admission and persisted
evaluation), typecheck, lint (299 existing warnings), production build and ten
audits passed. Tests additionally cover the three-value schema and concurrent
conflicting ratings. Independent initial review and exact-head CI are pending.
