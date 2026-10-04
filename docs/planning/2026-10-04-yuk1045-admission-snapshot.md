# YUK-1045 — Candidate admission evidence

## Reproduced gap

On main 093c0c24, the real issue → save → evaluate path wrote automatic candidates
with only source/assisted provenance. Activation skipped generation checks when
neither the caller nor the candidate supplied a token; it also did not require
scoring admission. A later withheld state or changed generation still advanced
the head. The original YUK-1045 was reopened; YUK-1095's earlier CAS fix is distinct.

Two isolated-DB investigation probes reproduced the permission error. Nine formal
DB assertions then failed before the fix; the manual/self-report/replay positive
cases passed. Investigation probes used an explicit ineligible settlement seam;
formal regression tests use the actual learningSettlement port and assert no
head advancement, receipt, FSRS or mastery rows when activation is denied.

## Change and historical behavior

- The candidate writer reads current revision/admission generation/state and hold
  flags before executing the evaluator. It overwrites any caller-supplied snapshot
  with that server observation; no lifecycle lock is held across a model call.
- The shared provenance schema retains that optional snapshot. Missing historical
  evidence remains absent/null; no revision, candidate or database row is backfilled.
- Under the existing group-root lock, automatic activation requires a complete
  snapshot of the same revision, admitted at execution and activation, with the
  same generation and no suspension/withdrawal. Missing lifecycle is held.
- The optional caller generation remains an additional assertion; it cannot fill
  missing historical evidence, substitute current values, or refresh old candidates.
- Executed scoring (including the default mode) requires automatic provenance.
  Manual/self-report sources require explicit manual_assert with complete asserted
  results; callers cannot relabel executor output to bypass automatic admission.
- Explicit D9/D15 manual/self-report ratings remain possible without admitted
  marking rules, under existing current hold/withdrawal checks. Existing effective
  candidates still return idempotent replay before a fresh admission check.
- A held answer and its candidate remain saved. After same-revision re-verification,
  a new evaluation attempt captures the actual new admission facts. Publishing a
  different revision does not grant its admission to an old revision's candidate.

No SQL migration, UI, production, dependency or paid-model changes. This fixes the
reopened admission portion of YUK-1045. YUK-1091 still owns joint membership/final
input closure; YUK-1047 still owns the eight formal caller migrations.

## Verification

The new integration cases use real publisher/issuance/submission/evaluator writes,
longer question content and actual settlement. They cover withheld/generation
changes, forged caller snapshots, replacement revisions, missing historical facts,
missing lifecycle, fresh evaluation after re-verification, manual/self-report,
idempotent replay, and verification changing while the injected executor is running.
Positive activation/settlement/reader fixtures now carry actual published admission
facts; the gate is not relaxed to accommodate fixtures.

Independent initial review reproduced a P1: execute could carry manual/self_report
provenance and activate while withheld. Both independent DB probes reproduced it;
two added core regressions were RED before the mode/source guard. The added DB
regressions check both default and explicit execute, no model invocation, no
candidate write and no activation/learning writes. Legal manual assertions remain
covered by positive tests.

Author verification: 116 scoped unit and 77 DB tests pass; typecheck, lint (299
existing warnings), build and all ten required local audits pass. The independent
initial review also passed 61 unit and 60 DB tests. The single P1 verification
review and exact-head CI are pending; the merge window starts at last push.
