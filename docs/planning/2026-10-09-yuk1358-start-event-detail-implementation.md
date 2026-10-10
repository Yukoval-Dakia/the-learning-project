# YUK-1358 Start event detail implementation

Source-only author handoff for `/Volumes/YukovalSBak/yukoval-projects/tlp-yuk1352-start-frontdoor`, branch `feat/yuk-1358-start-event-detail`, starting HEAD `74f648fad471b11a99c2e3339d7626ad5aa43e7a`, main baseline `6212a4560c68c294245dc3f3e10e4f774c6ff6f8`.

## Delivered behavior

Production legacy `/events/$id` now hands its document to the real non-SSR Start route. That route retains StartWorkbenchShell, TokenGate, document navigation and browser history back, and passes the event client directly into the original EventDetailPage. Development Vite keeps the original HTTP client. The page's JSX, layout, copy, query key, chain navigation, empty/error states, affected-ref restrictions and correction controls remain intact. The only rendered component changes are transport props. A settled-markup parity test verifies the original and injected versions.

`getStartEventDetail` is GET and `postStartEventCorrection` is POST. Both use identity validators for unknown input and runAuthenticatedStartWorkbench before loading the event adapter, public operations, schemas or database. Parsing uses the delivered EventParamsSchema and EventCorrectionBodySchema. The unchanged public readEventDetail and createEventCorrection receive the selected Db or Tx. Invalid input is 400, missing data 404, corruption 500. Token denial 401 and canonical preparing/ready maintenance 503 precede malformed input. No kernel/domain/HTTP/schema/manifest/shared boot changes were made.

The GET result uses a JSON string inside Start's serializer, following the existing admin config pattern. The client parses that string and validates the public ISO DTO schema. Installed Start Seroval transport tests round-trip long nested JSON, null/false/zero, own `__proto__` and `constructor` keys in unknown payloads and future envelope values, causal/effect/correction chains, ISO dates and JSON Date conversion. This preserves the existing public JSON representation; it does not broaden the domain into arbitrary JavaScript object serialization. No new dependency or serializer was added.

Corrections retain retract, mark_wrong and restore controls. The server also accepts supersede with its existing replacement requirement. Reasons are trimmed and affected refs are retained. Each explicit domain invocation generates a new ID. The receipt carries `status: 201` and `canonicalLocation: /api/events/<encoded correction id>` inside RPC 200; the original HTTP 201/Location contract is unchanged. Mutation retry is explicitly false, including when a caller's QueryClient defaults request retries. Success invalidates the existing event query. Unknown write failure retains the reason; refresh failure/retry and deep refresh do not replay a write. A subsequent explicit user click remains a new invocation, as before.

The old admin tests' global 12-route assertions now trace each actual admin production binding. The new event route test checks all 13 named migrated production entries and the route/client/read/write path instead of blindly changing a count.

## Author evidence

110 scoped unit tests in nine files and 11 installed protocol tests passed. Typecheck, lint, full build and all ten required development-workflow audits passed. The exact Node executable was verified both directly and through pnpm exec as `/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin/node`, version 24.19.0. Full `pnpm test` was not run.

The initial unit run failed three assertions because the fixture's zero cache lifetime removed an unrelated query. The initial typecheck rejected a fixture that put preparing/ready in the reason field. Both were repaired in tests; canonical epoch rules now produce maintenance plus the actual state. Those failed logs remain alongside final evidence. No inherited mandatory gate failure or allowlist change was required. The extra staged diff whitespace check exits 2 solely for verbatim tool logs with native trailing spaces or blank endings; its captured output is retained. The source and implementation report whitespace check passes. Logs are kept byte-for-byte, including failed evidence. Lint passed with 290 nonblocking warnings; the partition audit reported its six existing nonblocking classification warnings. Build's existing chunk/dynamic-import warnings remain visible in its log.

| Command ledger name | Exit | Log |
| --- | --- | --- |
| `format-initial` | 0 | [log](evidence/yuk1358-start-event-detail/format-initial.log) |
| `build-start-initial` | 0 | [log](evidence/yuk1358-start-event-detail/build-start-initial.log) |
| `unit-initial` | 1 | [log](evidence/yuk1358-start-event-detail/unit-initial.log) |
| `typecheck-initial` | 1 | [log](evidence/yuk1358-start-event-detail/typecheck-initial.log) |
| `protocol-initial` | 0 | [log](evidence/yuk1358-start-event-detail/protocol-initial.log) |
| `format-repair` | 0 | [log](evidence/yuk1358-start-event-detail/format-repair.log) |
| `unit-final` | 0 | [log](evidence/yuk1358-start-event-detail/unit-final.log) |
| `lint-final` | 0 | [log](evidence/yuk1358-start-event-detail/lint-final.log) |
| `typecheck-final` | 0 | [log](evidence/yuk1358-start-event-detail/typecheck-final.log) |
| `toolchain` | 0 | [log](evidence/yuk1358-start-event-detail/toolchain.log) |
| `build-final` | 0 | [log](evidence/yuk1358-start-event-detail/build-final.log) |
| `protocol-final` | 0 | [log](evidence/yuk1358-start-event-detail/protocol-final.log) |
| `audit-schema` | 0 | [log](evidence/yuk1358-start-event-detail/audit-schema.log) |
| `audit-partition` | 0 | [log](evidence/yuk1358-start-event-detail/audit-partition.log) |
| `audit-api-client` | 0 | [log](evidence/yuk1358-start-event-detail/audit-api-client.log) |
| `audit-api-client-usage` | 0 | [log](evidence/yuk1358-start-event-detail/audit-api-client-usage.log) |
| `audit-capability-boundaries` | 0 | [log](evidence/yuk1358-start-event-detail/audit-capability-boundaries.log) |
| `audit-provider-lanes` | 0 | [log](evidence/yuk1358-start-event-detail/audit-provider-lanes.log) |
| `pnpm-toolchain` | 0 | [log](evidence/yuk1358-start-event-detail/pnpm-toolchain.log) |
| `audit-profile` | 0 | [log](evidence/yuk1358-start-event-detail/audit-profile.log) |
| `audit-task-census` | 0 | [log](evidence/yuk1358-start-event-detail/audit-task-census.log) |
| `audit-draft-status` | 0 | [log](evidence/yuk1358-start-event-detail/audit-draft-status.log) |
| `audit-draft-status-reads` | 0 | [log](evidence/yuk1358-start-event-detail/audit-draft-status-reads.log) |
| `diff-check` | 0 | [log](evidence/yuk1358-start-event-detail/diff-check.log) |
| `scope-check` | 0 | [log](evidence/yuk1358-start-event-detail/scope-check.log) |
| `staged-diff-check` | 2 | [log](evidence/yuk1358-start-event-detail/staged-diff-check.log) |
| `source-diff-check` | 0 | [log](evidence/yuk1358-start-event-detail/source-diff-check.log) |

Full exact commands, absolute cwd, exit codes, elapsed time and log paths are in [commands.jsonl](evidence/yuk1358-start-event-detail/commands.jsonl). [owned-source-paths.json](evidence/yuk1358-start-event-detail/owned-source-paths.json) lists every changed TypeScript path. Source, logs and all emitted build assets have separate SHA256 manifests in this evidence directory. Build artifacts themselves stay in the existing ignored `dist/` and `web/dist/` directories.

## Prepared parent acceptance

Four rich real DB tests are prepared in `server/start/event-operation.db.test.ts` and were not executed by the author. They cover nonzero uncommitted cause/effect/multiple-correction reads through Tx, separate connection invisibility and rollback, tied-time ordering for all four correction kinds, a fifth fresh explicit invocation, original row bytes, pending ingest/scopes/dispatch metadata, whole-public-table and sequence no-write rejection snapshots, and corrupt focal/cause/correction errors. These are in-process operation tests, separate from live RPC/browser acceptance.

The parent can run the new adapter tests together with the delivered domain contract tests after obtaining its isolated runtime/DB boundary:

```bash
cd /Volumes/YukovalSBak/yukoval-projects/tlp-yuk1352-start-frontdoor
export PATH="/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH"
pnpm vitest run --config vitest.db.config.ts server/start/event-operation.db.test.ts src/capabilities/observability/server/event-detail.db.test.ts
```

Author did not run DB tests, Testcontainers, Docker, PG, servers, browsers, workers, provider calls, runtime locks or queues. Independent review, real DB execution, built RPC/browser authentication and epoch acceptance, release/CI/PR remain parent-owned. The parent should check direct/cold event documents, each original control, actual 401 re-gating, preparing/ready 503 before malformed input, corrupt 500 versus absent 404, whole-table no-write reads/rejections, and failed-refresh/unknown-outcome no replay on the built artifact.

No new actionable follow-up was discovered beyond the parent-owned migration acceptance work. Linear capture and PLAN/.remember alignment are explicitly parent-owned; no external issue operation or parent document write was performed. No push, PR, merge, watch, branch/worktree change or delegation occurred.
