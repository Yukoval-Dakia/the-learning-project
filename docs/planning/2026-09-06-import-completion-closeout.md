# Import completion owner — YUK-955

Manual import and durable import call the same parsed business command.
The HTTP adapter only validates the request and shapes success/error responses;
all legacy deprecation headers remain present, including errors.

The session owner defines importable states once and claims the global learning
write lock, then the session, then all session blocks in stable ID order.
Source membership/status, subject attribution, manual ordinals, materialization
and the draft-ignore sweep run under that claim. Auto-enrollment uses the same
global-before-block order, so neither path can consume a source twice.
The second unprotected direct-block status implementation was removed.

Durable import no longer constructs a fake HTTP request. It locks its reserved
operation and commits question/record/attempt/block/session changes together with
the completion receipt. Duplicate deliveries read that receipt. Infrastructure
or terminal-write failures roll back and propagate for queue retry; deterministic
domain rejection records a failed operation. Make-paper and rescue retain their
distinct legacy adapters; this is not claimed as their migration.

## Evidence

- Real default job execution concurrently delivered twice, then replayed: one
  question/record/completion receipt with identical result IDs.
- A PostgreSQL constraint deliberately fails the last completion-receipt INSERT:
  all business writes roll back, no false FAILED is stored, retry succeeds once.
- Manual import paused after question insertion while auto-enroll competes:
  removing the new lock claim reproduced duplicate enrollment (red); restoring
  it produced one question/record/attempt (green).
- Independent initial review identified that concurrency P1. Its one verification
  approved the global/session/sorted-block fix, including reverse winner and sweep.
- 120 scoped DB cases cover import, auto-enroll, enroll, operation storage and
  HTTP operations. Thirteen schema unit cases, typecheck, lint, build, Postman
  generation and architecture audits passed before final integration.

The old standalone happy-path command test was replaced by direct command
concurrency and actual job/rollback tests; the legacy HTTP double-submit test now
tests the same command seam, retaining separate HTTP conflict/header coverage.
No model call, production deployment, state flag switch or data cleanup occurred.
Exact-head CI is required before merge.
