# YUK-1091 — Freeze and evaluate complete dependent groups

## Problem and approved contract

The previous evaluator loaded one submission even when multiple submissions were
acknowledged in its evaluation group. A later member could not activate because the
head was anchored to the first submission; evaluating only the first member could
activate an incomplete group. Another answer could also be appended after scoring.
The original ticket's five other fixes remain delivered; this closes its group
input and head-ownership gap.

[D2/D8](2026-09-24-question-assessment-decisions.md) require one finalized dependent
group occurrence, independent questions staying separate, and new answers becoming
new attempts. A published root revision already declares its dependent parts and
scoring plan. This implementation supports separate issuances of nonoverlapping
parts of that same revision. It does not invent a cross-revision plan or choose
among overlapping alternative answers. Such acknowledged historical inputs remain
stored and held rather than being discarded or silently narrowed.

## Frozen input and execution

The persisted evaluator requires the exact expected submission ID set; omission
explicitly selects a singleton. Under the existing evaluation-group advisory lock,
it compares this set to actual immutable submissions and the declared group cache.
A joint candidate uses the existing head's stable submission anchor and attempt
sequence, regardless of which member initiated the request. A historical singleton
without a head can still produce a candidate without creating or advancing a head.

The core receives separate original member contexts and issuance scopes. It builds
a response/evidence view, validates disjoint scopes and evidence identities, and
executes each declared scoring unit once over the union. It never constructs a fake
SubmissionRecord or edits an acknowledged answer. Model requests and typed state
carry the member identities. Budget accounting and admission guards stay in place.

The writer seals member IDs, revision, union scope, max original submitted_at and a
canonical input digest covering original responses/evidence and immutable issuance
bindings. Caller-supplied metadata is overwritten. Activation reloads the original
members and bindings and checks the same proof before head or learning writes.
Missing or mismatched joint proof is held. Historical single-member input remains
unambiguous; no stored snapshot is backfilled. Existing effective replay returns
before new input/admission checks.

## Closure and downstream behavior

The first candidate, including a retryable pending candidate, seals membership.
Submission idempotency checks still run before the application closure guard.
Migration 0114 serializes direct submission/evaluation inserts with the same group
lock and prevents new members after any candidate exists; no new table or column.
The established restore-mode bypass remains, and existing rows are untouched.
Save locks group before issuance; evaluation locks group before its member;
activation takes the common learning lock, then group, candidate, submission, head
and question root. No learning or lifecycle lock is held by model execution.

Settlement v3 uses the validated union scope and frozen last-member occurrence,
keeps per-KC aggregation, and preserves existing physical FSRS targets. Rejudging
replaces the same occurrence. Historical v1/v2 receipts replay their stored inputs.
The verdict reader recomputes the same input proof and denominator. New feedback
can be viewed through any declared member, identifies the joint group/members, and
reveals answer keys/rubrics only for its sealed issued scope. Legacy feedback has
no fabricated scope metadata.

## Evidence and delivery boundary

An isolated real-publisher/issuance/submission probe reproduced four failed
assertions for a valid two-part group. The formal integration case was RED before
implementation. A separate disposable-DB experiment confirmed the proposed lock
blocks queued/direct inserts while preserving same-key replay; it was not counted
as a shipped fix. Regression coverage includes full-scope caps, input-order-stable
digests, shared evidence ambiguity, selection mismatch, concurrent evaluators and
appends, pending closure, forged/historical proof, mixed revisions, overlapping
answers, per-KC once-only settlement, repeated evaluation, feedback and restore.

No UI, production deployment, dependency updates or paid model calls. Eight formal
caller migrations remain YUK-1047; this does not label that epic complete. Local
checks, independent review and exact-head CI results are recorded in the PR.

Author verification: 138 scoped unit and 136 DB tests pass, including migration
apply and assessment backup/restore. Typecheck, lint (299 existing warnings), build
and ten local audits pass. All 82 migration smoke tests pass. Independent initial review ran 96 unit and 64 DB tests and found one P1:
the actual settlement still used the anchor time despite the plan's last-member
time. Two independent DB probes (nine failing assertions) were adopted as formal
regressions before fixing it. Actual FSRS/theta writes, receipts and replay bounds
now use the validated plan time; 50 scoped DB tests pass after the fix. The sole
P1 verification review passed the original two independent probes and 39 DB tests,
including historical v1/v2 replay. The formal joint file passes all 20 tests after
an explicit null guard and Date normalization for the JSON FSRS timestamp;
typecheck, lint and build also pass. Final-head CI remains pending.

PR-Agent's partial-group reader concern was checked: the public reader accepts
only group IDs and loads all submissions by group, with chunks over group IDs,
not member rows. Its digest-format suggestion describes a future schema-change
risk; no current serialization mismatch was demonstrated. Both are nonblocking,
with no speculative runtime changes or new duplicate tickets.
