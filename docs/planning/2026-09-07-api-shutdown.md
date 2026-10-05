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
- Independent review, exact-head CI, merge and clean-image Mac rollout were still pending
  at this checkpoint; their completed evidence is recorded below.
  Exit 137 alone never proves data loss; this slice does not close the full YUK-887
  actual-provider/crash-recovery matrix.

## Delivery

PR #1359, exact `14ea1a8142c867e3b95c619a8441b6d56b65695d`, CI `34128362101`
all jobs succeeded; merged main `5e65629170d1ef48dfcc8e964bfa64d42f9bc691`.
Independent initial review PASS, independently reran 8 API unit tests, 7 existing boss
shutdown tests and typecheck. Additional 37 Copilot admission/cancel unit tests passed.

Clean-image SSE probe: server explicitly logged HTTP drain timeout, disconnected after
30,319ms and exited 0; the 90-second client deadline had not fired. Clone event/job-event/
task/attempt counts remained 423/24/258/4. An earlier sample with a coincident client
deadline is not evidence of server-enforced timeout. Temporary stopped probe containers
were removed; no user volume was removed.

Mac-local app/worker run the reviewed image at 2026-09-07T13:48Z, healthy with zero
restarts and StopTimeout 70/40. Image digest:
`sha256:c4ea66c85bc08dd40d1705c6fdbb24cc00b546f5d4306b9448b6620f431569f8`.
Original Postgres container, start time and data volume unchanged. Clone/live migration
added nothing; hydrated projection audit and eight retained goldens have zero drift.
Live counts remain 423 events / 258 task runs / 4 provider attempts, with no active,
created or retry queue rows. Health 200, unauthenticated subjects 401, authenticated 200.
No paid model calls; recovery-specific $3 unused. Prior fbee5c32 image remains available
for rollback. No new-production stop was performed solely as a probe; isolated image
shutdown evidence and production-running evidence are distinct. No NAS operation.
