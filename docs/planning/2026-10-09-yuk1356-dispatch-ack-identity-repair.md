# YUK-1356 native dispatch acknowledgement identity repair

The parent's actual DB batch at `6981981b718eadaabd7e937a3089feba821f1af3`
reported 43 passing cases and one failure in
`native-durable-attempt.db.test.ts`, case `freezes originals before enqueue;
concurrent HTTP retries and worker redelivery settle once`. Its original
`coordinate_mismatch` assertion remains. The normal existing-row path rejected a
changed rating, but the transaction catch reread only caller and submission ID
and returned the run ID. The catch thereby converted a validation refusal to
success. The failed log is preserved at
`/tmp/yuk1356-dispatch-ack-repair/parent-failed-tests.log`.

## Accepted identity

`dispatchNativeAttempt` now constructs one immutable identity from the accepted
submission returned by `prepareFormalAttemptSubmission` and the requested
execution options. Both the existing-row transaction and the lost-COMMIT
acknowledgement reread call the same validator under the run lock. New pending
input is constructed from that same identity.

The validator parses the stored payload and compares native caller, deterministic
run/pending IDs, frozen question/submission/evaluation-group/submitted-at,
initial expected head, user rating and unassisted policy. The accepted pending
row must have the user/self/question/action envelope, a session consistent with
its accepted capture, the frozen created-at timestamp and null
outcome/cause/task/cost. Corrupt or inconsistent records fail closed.

Capture remains first-write-wins. `recordFormalAttemptCapture` in
`src/capabilities/practice/server/assessment/attempt.ts` explicitly states,
"Capture is first-write-wins; a retry's wall-clock latency cannot rewrite the
attempt." `AssessmentAttemptCapture` defines process observations, which do not
replace original responses. Retry capture is therefore excluded from intent
comparison; the stored capture is reused. Current question metadata, current
effective head and mutable event ingest state are not read for comparison.
Submitted-at comes from the stored submission rather than the retry's clock.

An exact accepted original still replays when the feature flag is disabled or
its operation has already completed. Recovery returns its run ID without a new
capture, pending write, reservation, admission, enqueue, model call or refund.
The existing absent-original refund branch and reconciliation ownership are
unchanged. No recovery loop, delivery writer or live consumer was added.

## Source verification and prepared DB evidence

The focused dispatcher unit regression first produced 19 failures and four
passes against the original source. It then passed all 23 cases after the
repair. It exercises normal reads, failures before the initial read and lost
acknowledgement after an exact existing-row transaction, using a mocked database
and dependency boundaries. It checks that no effect operation is called. This
does not establish a real DB commit.

Prepared DB cases retain the original concurrent retry/redelivery/completion
case and its strict changed-rating refusal. That case now also rejects a
changed unassisted policy after completion. Four new option cases cover changed
and removed rating and both policy directions, with feature flag enabled and
disabled, unchanged original/effects and no additional admission/send/model or
refund. Nineteen seeded same-ID corrupt originals cover payload coordinates,
initial head, event envelope and malformed data. Their insert bypasses the
typed event writer so the negative actually reaches persisted corrupt truth.

The existing operational pending-COMMIT fixture now snapshots the real committed
event rows before throwing the acknowledgement error, verifies exact replay and
changed-option refusals against that snapshot, checks one retained admission
and no dispatch send/refund, and verifies the existing sweep uses the same
reservation/delivery with no model claim. Its original assertions remain.
The parent's two fixture fixes at `6981981b7` are preserved, including the
driver timestamp binding and per-run notification queries.

Authorized checks use verified Node v24.19.0 at
`/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin`. Final command results,
source Git blobs/SHA-256, fixed build copies and manifests are sealed in
`/tmp/yuk1356-dispatch-ack-repair/HANDOFF.md`. Only scoped units, typecheck, lint
and full build are author verification. DB, process, migration, provider,
browser, operational and real consumer acceptance remain UNRUN in this lane.

## Ownership and next acceptance

Only dispatch identity/recovery in `durable-attempt.ts`, its focused unit file,
the native DB fixture, the existing operational pending-COMMIT fixture and this
document are owned. The unrelated `executeNativeAttempt` receipt repair remains
byte-identical. Notification, clock, schema, kernel, Start, boot, package, lock,
migrations, audits and parent PLAN/remember/acceptance/tracker are unchanged.

Parent owns the actual rerun of the original failing DB case, broader suites,
runtime ownership/cleanup and the sole remaining R2. No review was started and
no R1 finding is declared resolved here. The existing failure is already
parent-owned; no separate actionable follow-up was established. Tracker writes
are prohibited for this writer.

Suggested parent commands, UNRUN here:

```sh
export PATH=/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH
pnpm vitest run --config vitest.db.config.ts src/capabilities/practice/server/native-durable-attempt.db.test.ts -t 'freezes originals before enqueue; concurrent HTTP retries and worker redelivery settle once' --bail 1
pnpm vitest run --config vitest.db.config.ts tests/dbos-judge/operational.db.test.ts -t 'pending COMMIT acknowledgment loss preserves the same accepted original, token and reservation; the sweep resends only that fixed identity' --bail 1
pnpm vitest run --config vitest.db.config.ts src/capabilities/practice/server/native-durable-attempt.db.test.ts src/capabilities/practice/jobs/judge_pending_reconcile.db.test.ts tests/dbos-judge/operational.db.test.ts --bail 1
```
