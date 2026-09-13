# YUK-980 startup-tail shutdown verification

Base revision: `9c943c41add259b8d4c849db3736b75fb3577232`.
Scope: standalone worker only; no production stop or deployment in this verification.

## Root cause and fix

The previous entrypoint retained a local `boss = null` until `startBossWorker`
returned. Consumers were already mounted during that function's registration
tail, so SIGTERM could take the no-boss exit path despite an active job.

The production-used `bootWorker` lifecycle reads the running instance published
before consumers mount. Shutdown waits up to nine seconds for an unfinished
startup tail before draining. Once a signal arrives, the shutdown handler owns
the exit; startup rejection cannot race it with a second process exit.

## Regression evidence

- Extraction-only, old wiring: lifecycle DB suite exited 1 with two failing
  mid-registration cases and three passing cases. The failure included the false
  `no jobs drainable` log while a real pg-boss job was active.
- Final lifecycle plus shutdown suites: both files pass; six lifecycle and
  sixteen shutdown cases. Lead independently reran after removing swallowed
  cleanup errors.
- Lead independently ran `pnpm typecheck`, `pnpm lint`, and `pnpm build`:
  exit 0; lint retained 307 warnings and one info, with no new baseline increase.
- Independent gate reviewer: PASS, no blocking findings.
- LSP initialization failed to locate TypeScript; LSP is not claimed clean.
  The actual `tsc --noEmit` execution is the typecheck evidence.

## Built artifact and real signals

Lead reran the freshly built `node dist/worker.cjs` against an empty migrated
scratch database in the disposable `yuk980-qa-pg` container. No provider keys
or production database were used. Database locks controlled the startup phase
and kept an echo job active; the harness sent real OS SIGTERM.

| Scenario | Observed result |
| --- | --- |
| Before consumers, blocked on tool-operation recovery | Exit 1; boot-window log; no pretend drain |
| Active echo job, startup blocked at reconciliation, then released | Tail settles before stop; job completed; output `dcba`; exit 0 |
| Active echo job, startup stays blocked past nine seconds | Timeout logged; job drains to completed; exit 0 |
| Fully ready with active echo job | Normal drain, no startup-wait log; job completed; exit 0 |

Final harness result: 19 passed, zero failed. The lead's first rerun found a
harness race: dispatch preceded acquisition of the echo row lock, so the job
could finish before its active-state assertion. The corrected ordering confirms
the lock is held before dispatch and aborts if active state is not observed.
The failure was not discarded as a passing rerun without a cause.

The scratch container was stopped and removed. Local raw logs and the corrected
harness are retained in the lane's `.yuk980-evidence/` directory.

## Boundary retained

Nine seconds of startup waiting plus thirty seconds of pg-boss drain is a
waiting budget, not a proven 39-second hard process deadline. pg-boss pool close
can add latency after its drain timeout. A pathological stuck pool may still
reach Compose's 40-second SIGKILL boundary. This was noted by the reviewer as
non-blocking; no claim of arbitrary-hang hard-deadline coverage is made here.
