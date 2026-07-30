# PR Workflow
1. Run tests and lint locally
2. Organize changes into logical commits (squash WIP)
3. Push branch and open PR with summary + test plan
4. Run one independent review pass
5. Fix validated P0/P1 findings and run at most one verification review pass
6. Require the exact-head `CI Gate`; then close out or merge according to repository policy

## Review budget and stop policy

- Automated review is advisory, not a CI correctness gate.
- Budget one initial review plus at most one verification review after P0/P1 fixes. Never start a third pass unless the owner explicitly requests it.
- Fix validated security, data-loss, correctness, or release-blocking P0/P1 findings.
- Treat P2/minor/nit/hygiene/refactor/performance suggestions as non-blocking by default. Reply with the rationale, resolve the thread, and capture only material deduplicated follow-ups in Linear.
- When the exact-head `CI Gate` is green and no validated P0/P1 remains, do not wait for or rerun pending/failed/cancelled/timed-out advisory review checks.
- Never claim that a skipped finding was fixed.
