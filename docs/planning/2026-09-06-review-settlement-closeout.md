# Review settlement ownership — YUK-956

Solo, deferred and paper grading now finish through three typed Practice commands:
`settleInlineSoloReview`, `settleDeferredSoloReview`, and `settlePaperSlotReview`.
The commands own the transaction, attempt/evidence writes, sorted FSRS locking,
theta and memory scheduling, rollback snapshots, and post-commit signals.
Callers retain request/provider invocation and distinct durable queue lifecycle.

The shared learning-effects implementation captures the previous card before
question fallback. Family/calibration enrichment stays in isolated savepoints.
Deferred review preserves the frozen input, late-result fences and immutable-only
late settlement. The job persists through the command and recovers the stored
terminal result on redelivery without another model call. Paper preflight prevents
unneeded paid claims, while the command rechecks frozen answers inside its transaction.
Ungraded/photo-only answers and replay do not apply learning effects or signals.

## Evidence

- Author: 128 business DB cases, 90 durable/reconcile cases, then 35 focused cases.
- Independent review: APPROVE, no P0/P1; independently ran 94 DB cases in eight files.
- Root integration: 32 DB cases covering settlement, late arrival and judge jobs;
  55 scoped static/audit unit cases; typecheck, lint, production build and targeted
  schema/draft-status/structured-judge/task-census/hub-writer/architecture audits passed.
- The source-level rollback-snapshot guard now checks the single settlement owner;
  solo and paper snapshot DB tests remain. No protection or audit threshold is removed.
- Dependency baseline tightens from 444 to 439 cross-capability/core edges;
  the other ratchets remain 0 and 47. This is not evidence that all cycles vanished.

No extra provider invocation, production deployment, data migration or UI change.
Exact-head CI is required before merging. State projection compatibility is still
private to existing state owners; this change does not retire production SoT flags.
