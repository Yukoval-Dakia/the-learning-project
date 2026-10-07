# YUK-1365 live SSE acceptance follow-up

PR1593 merged as df08399ff after exact-head CI37627929759 at 733e24852,
independent review and its P1 repair. The two trees are identical. Deployment
uses ARM64 image 28f89c8b2b9db63eeb311f92b9cef68528fab25232bbf0f596c6e4cd4fc1e214.
The existing localhost8787 runtime remains Agent TEST ONLY.

Final stopped-writer backup restored 101 table counts, 94 local object-store
files and Mem0 SQLite integrity. Runtime app/worker are healthy; readiness active,
pg-boss schema44, all four BAM rows completed and zero invalid queue indexes.
Private evidence and recovery data are under
`/Volumes/YukovalSBak/yukoval-projects/tlp-local-prod-20260907.sjUaCU/deployment-yuk1365-b54c9a06d`.
Old f3 application rollback is not authorized by this evidence: queue schema and
retention semantics changed. Never restore over writes made after the backup.

Actual hello acceptance exposed a remaining transport defect. Durable deltas
were committed from 13:41:52.743Z to 54.223Z, before CopilotTask finished at
54.311Z and terminal reply/done at54.347/348Z. Yet HTTP observed batches on a
10-second cadence: first delta50.121s, done60.141s after request. Reconnection
with Last-Event-ID succeeded and the final reply was ordinary text, with no
learning-review rejection. These numbers include startup/model latency; they
do not claim faster model inference. Actual CopilotTask cost estimate was
$0.008906625. Evidence: `/tmp/yuk1365-acceptance/hello-fa5311b5e8664e30a583797ed9872b39.json`.

`server/index.ts` never started the existing `startListenLoop`; therefore worker
NOTIFY messages never reached the API's in-process SSE router. The periodic
10-second durable catch-up was the only live delivery path. This follow-up
awaits LISTEN before HTTP serve and stops the listener after HTTP drain,
ensuring the DB client still closes if listener shutdown fails. It adds no
classifier, queue operation or content review and preserves replay/heartbeats.

Local checks: 12 startup/shutdown unit tests, 16 LISTEN/writer/SSE DB tests,
typecheck, lint and build passed. Logs `/tmp/yuk1365-listener-{unit,db,typecheck,lint,build}.log`.
Independent review and fresh exact-head CI apply to this follow-up; actual
browser incremental/cancellation acceptance must be rerun after its deployment.
The first release is partial acceptance, not completed streaming delivery.
