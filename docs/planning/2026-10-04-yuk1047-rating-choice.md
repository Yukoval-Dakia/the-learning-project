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
A later automatic regrade preserves the scheduling choice for that occurrence
while independently correcting theta. Other occurrences continue scheduling normally. This does not add an edit-existing-rating operation.

No historical rows or frozen replay plans are rewritten. Existing replay uses
its stored rating and source. No admission bypass, model execution, API/UI
cutover or dependency change is introduced. The eight formal entry migrations
remain under YUK-1047; this supplies their existing user-rating behavior at the
new activation boundary.

Three formal DB regressions failed first. After the fix, 107 scoped unit cases,
88 DB cases (including activation, settlement, joint input, admission and persisted
evaluation), typecheck, lint (299 existing warnings), production build and ten
audits passed. Tests additionally cover the three-value schema and concurrent
conflicting ratings. Independent review results and the final repair are recorded below; exact-head CI follows push.

Initial review confirmed two P1 defects: rating checks covered only the currently
effective candidate, and the old shared-card user guard also blocked later
independent practices. Formal ABA/new-occurrence regressions failed first.
Activation now validates all previous receipts for the candidate, reuses its
original choice on reactivation and rejects contradictory or changed choices.
Reactivation does not treat the old choice as a new scheduling event.

The FSRS guard now reads actual user-write receipts for this evaluation group,
including segments preserved across supersession. It does not protect other
groups. An additional interleaved regression first failed: user-rated A, later
automatic B, then regrade A changed the FSRS trajectory. Preserving A's segment
while replaying B from its stored plan fixes that case without an extra practice.
All 93 scoped DB cases pass after the consolidated repair, including historical
replay, joint scope, concurrency, automatic theta and manual scheduling.

The sole verification passed the two original probes and 61 DB cases but exposed
one remaining form of the second P1: A/user hard, A/regrade, B/new practice,
then an earlier C arriving late. The retained A FSRS bracket was excluded with
its superseded settlement, leaving a future card during replay (`Invalid delta_t`).
The author's formal regression reproduced the failure (1 failed / 29 passed).

The live replay set now includes retained user FSRS segments separately. They
revert/reapply only FSRS; superseded theta and calibration are never revived.
New replay receipts identify `fsrs_only` so another late arrival preserves the
same separation. Such segments cannot masquerade as a second effective
settlement during regrade. Existing frozen receipts and plans remain unchanged;
non-user FSRS segments that were actually reverted are not retained.

The regression now covers two successive earlier arrivals followed by another
regrade: four actual practices remain four FSRS repetitions, and theta evidence
is replaced without double-counting. Final author validation: 94 DB cases across
settlement, activation, joint input, admission and persisted evaluation; typecheck,
lint (299 existing warnings), build, schema/partition audits all pass. The earlier
107 unit cases and eight other local audits also passed. Independent review budget
is exhausted (initial + sole verification); the final repair is author-verified,
not represented as a third independent review.

Prerequisite #1563 merged at 21:00 UTC as 448ffe42 after exact-head CI37232936402
(82 migration, 34 browser), independent verification and its 17-minute window.
This branch was rebased onto that main before first push; no remote rewrite.
