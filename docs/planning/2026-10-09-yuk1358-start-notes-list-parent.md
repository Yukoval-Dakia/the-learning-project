# Start notes list parent verification

Exact source `c236a7160343f7f9a6277ec8c59b70e104ebf267` is committed and writer-released. Parent independently matched all 21 source, 29 log and 893 emitted artifact hashes. Log paths are relative to their evidence directory; an initial checker used the repository root, then corrected that base and verified all entries.

Parent reran five scoped unit files: 50/50 passed. Three real isolated DB suites passed 18/18, including the three new Start/domain/HTTP parity cases and existing notes API/selector regressions. The new suite proves nonzero transaction-local data, independent observer invisibility, custom/alias/inherited subject resolution, empty versus absent filters, archived exclusions, escaped search, full ISO DTO, 205 unpaginated rows, public-table content/count stability and rollback. Author typecheck/lint/build, installed-protocol tests and post-build audits remain separately attributed in the implementation report.

The parent acquired the runtime mutex at 04:54:05Z and released it at 04:54:37.145544Z after exact owner/token checks. Testcontainers exited. Original four container IDs/images/start times/health, complete running set and current-release SHA were unchanged. No provider, shared worker, replay or deployment occurred. The public receipt omits the private lock token.

[Evidence manifest](evidence/yuk1358-start-notes-list/manifest.json) preserves parent logs and author hash manifests. Independent R1 is running. Exact-head CI and real built RPC/browser acceptance are pending; prepared tests and serializer checks do not prove browser behavior.

The existing `useSubjects` remains an authenticated HTTP consumer, and note detail/presence/editor/write paths remain outside this slice. This is recorded as remaining YUK-1358/YUK-1359 migration work, not a newly introduced defect or whole Notes completion. No duplicate ticket is needed. Judge and restore remain coordinator-owned.
