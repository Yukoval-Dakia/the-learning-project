# YUK-975 — API process shutdown ownership

Scope: continue the authorized Mac-local delivery frontier recorded in YUK-887.
No schema, model calls, NAS deployment, or changes to durable Copilot Stop semantics.

## Contract

- API owns one SIGTERM/SIGINT handler in both API-only and in-process-worker modes.
- Close HTTP admission first. Let in-flight responses drain up to 30 seconds;
  disconnect remaining transports afterward. This does not cancel durable conversations.
- Await any already-starting in-process worker, stop the running boss without starting
  another one, then close postgres-js. Reuse the existing 30-second boss drain and WIP logs.
- Exit 0 only after cleanup completes; failure or the 65-second total deadline exits 1.
  Repeated signals do not run cleanup twice. Compose grants API 70 seconds and worker 40.
- The independent worker retains its existing signal owner; no new lifecycle framework.

## Evidence before review

- Baseline clean image `fbee5c32`: isolated clone, no provider credentials, RW_WORKER=0,
  health 200, `docker stop -t 2` => 137. Same image plus `--init` => 143, not graceful 0.
  This distinguishes PID 1 default signal behavior from a hung application cleanup.
- Real API entrypoint regression failed because no SIGTERM handler was installed.
  Fixed tests exercise API-only cleanup, worker startup race, and producer-boss failure.
- Real Node child receives SIGTERM with HTTP in flight: rejects new admission, preserves
  the accepted response, closes runtime, then exits 0. Deadline tests cover persistent
  transport, never-settling cleanup, failure, and duplicate signals.
- 12 scoped unit tests and 7 existing shutdown tests under the DB partition pass;
  typecheck, lint, partition, architecture/capability audits and production build pass.
  Existing partition warnings and baseline lint warnings are not new clean-sheet claims.
- Independent review, exact-head CI, merge and clean-image Mac rollout remain required.
  Exit 137 alone never proves data loss; this slice does not close the full YUK-887
  actual-provider/crash-recovery matrix.
