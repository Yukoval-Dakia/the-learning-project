# YUK-1359 retained scratch implementation handoff

2026-10-09. Implementation and scoped offline verification are complete in
`/Volumes/YukovalSBak/yukoval-projects/tlp-yuk-1363-test-storage`, branch
`fix/yuk-1359-restore-parity`, from clean `e073b99d45f46468bd321afc2a7607c4eefe1b9e`.
The final commit and source hashes are recorded in the task response and the external evidence seal
below. The sole source writer releases ownership at that commit. Parent owns independent review,
receipt-adapter integration and locked runtime acceptance. No runtime PASS is claimed.

This implements the approved [reopen integration decision](2026-10-09-yuk1359-restore-reopen-integration-design.md),
including its final host-execution correction, and retains the [coherence contract](2026-10-09-yuk1359-restore-coherence-design.md).
The existing catalog SQL correction, canonical content inspector, comparator, sequence state contract,
artifact parser and strict-capture versus restore-gate distinction are preserved.

## Public scratch and receipt contract

```text
bash scripts/restore-drill.sh --dump=<sealed-dump> --source-manifest=<capture-source-manifest> --quiescence-evidence=<maintenance.json> --out=<new-attempt-receipt> --keep --scratch-loopback-port=<1024..65535> --scratch-database=test_fork_<digits>
```

The two scratch options require one nonempty `--key=value` each, full parity mode and `--keep`.
Missing pairs, duplicates, bare/malformed values, other databases, limited modes and use outside
`restore-drill` fail before Docker. Default scratch remains network-none with user/database `loom`.
Loopback creates a fresh random scratch with bridge networking, exactly `127.0.0.1:<port>:5432`, the
validated database, and a local immutable image with `--pull=never`. A collision fails without another
port, target reuse, owner shutdown or caller volume attachment. TOC-only runs also use `--pull=never`.

New observed ownership is `scratch.ownership={container_id,attempt,volumes}`. `container_id` is the
full 64-hex ID returned by creation; `attempt` is the UUID value of Docker label
`loom.restore-drill.attempt`. `volumes` records image-created disposable volume names/destinations.
Before every scratch exec and cleanup, inspection verifies ID/name/image/label, selected DB environment,
network mode, both actual/configured port bindings and unchanged storage. Cleanup uses only the verified
ID and `docker rm -f -v`; ambiguous creation or changed ownership cannot authorize removal by name.
An ambiguous failure may leave an unverified resource for parent reconciliation and has no reopen gate.

Only successful retained loopback parity adds this strict optional object:

```text
scratch.reopen = {
  kind: "retained-loopback-v1",
  container_id: <full ID matching ownership>,
  host: "127.0.0.1",
  port: <observed published high port>,
  identity: <databaseIdentitySchema with test_fork_<digits> and in_recovery:false>
}
```

The helper checks durable database identity before/after restore, after inspection and again before
final retention. A different source cluster is required. A failed retained attempt emits `kind:"failed"`,
`verified:false`, no reopen object and a nonzero exit. Parser/schema checks reject failed/unretained or
wrong-container reopen claims; full parsing recomputes parity and checks the matching immutable image.
Current successful receipts without reopen remain parity evidence only. Historical receipts remain
limited, and `--strict` alone remains capture artifact presence, never restore or reopen acceptance.

## Host evidence and explicit target identity

Version 1 of `loom-maintenance-boundary` is unchanged, including required `app_image`/`worker_image`.
The strict version 2 has `execution.kind:"host-node-v1"`, `execution.app:{kind:"absent"}`,
`execution.runtime:{kind:"node",version,artifact:{file,sha256,bytes}}`, and
`execution.worker:{name,artifact:{file,sha256,bytes}}`. The worker name must match an enforced external
writer entry. Runtime/worker artifacts are byte-hashed at capture and boundary observations, restore
binding and gated final assembly. Runtime bytes/version also match the helper's pinned Node executable.
Mixing image fields into host evidence or omitting/faking provenance is rejected. External maintenance,
stopped-writer, session visibility, unknown-client and prepared-transaction guards remain mandatory.
Artifact hashes bind the supplied files; parent evidence must establish that the actual stopped worker
used this runtime and bundle. An attestation is not manufactured by a matching hash.

`hostDatabaseIdentity(target)` lazily imports the already installed `postgres` driver only for an explicit
PostgreSQL URL with host/user/database. It uses the unchanged `IDENTITY_SQL` in a read-only repeatable-read
transaction, one connection, disabled prepare/type discovery/notices, a five-second connect bound,
ten-second statement timeout, fifteen-second operation bound and bounded owned-client close.
Failure, interruption and close failure fail capture with sanitized diagnostics. No host `psql`, application
DB module, new dependency or environment-selected target is used. The final-backup shell now requires
`--target`; inherited `DATABASE_URL` and `LOOM_CUTOVER_TARGET` cannot supply it.

## Parent adapter inputs

Reuse the helper's `parseSourceManifest`, `parseRestoreReceipt`, `compareDatabaseManifests` and pure
`validateArtifactBindings`. The latter remains free of filesystem/DB/process work. For host evidence its
complete receipt binding requires `quiescenceArtifact`, parsed `quiescence`, and observed
`executionArtifacts:{runtime:{version,artifact},worker:<artifact identity>}`. Missing observations, wrong
byte digests/sizes or runtime version fail. `validateExecutionArtifacts` is the helper's separate file-reading
boundary and returns those bindings after checking actual files and the pinned runtime. A pure adapter
must supply the parent's hash-bound actual observations, rather than call that file-reading boundary or
implement another parity validator. Offline tests prove that the pure binding check works after artifact
files are removed, while the helper operations reject actual missing/changed files.

Create a new parent preparation revision for source-only setup and late restore-bound target discovery.
Require fresh helper exit 0 with no signal, a successful new receipt, all sealed capture/dump/quiescence
bindings, helper runnable closure hashes and the target witness before any target import/connection.
The receipt's capture `helper_revision` does not identify the restore executable by itself. Recheck full
container ID/attempt/image/mapping and cluster/database OID/name/version/start/recovery state over the
explicit host endpoint before target inspection and worker launch. Host/container route addresses may
differ. Hold the uninterrupted maintenance boundary, preserve the failure latch and permanent source
worker restart prohibition, and bind the exact target once. A second restore/migration/rename/writer or a
replacement/restarted target invalidates this attempt. Only the same restored dataset may be reopened.

The original `/tmp/yuk1359-dbos-restore-offline-prep` was not edited. Its fixed worker remains
SHA256 `4e2ec8ace103cf535c3472f2f2c4611438d8cfe5a6f14a1c65abe272674824a9`.
New packaging output does not replace that parent worker input and was not executed.

## Offline evidence and limits

Evidence root: `/tmp/yuk1359-retained-scratch-offline-20261009-cHQed9`.
`sha-manifest.json` seals baseline inputs, final source, installed tool/driver/loader inputs, logs and
packaging artifacts. `commands.json` records exact commands/status. Earlier failed logs remain historical;
only the following final results describe this implementation:

- `bash /tmp/yuk1359-offline-env.sh pnpm vitest run --config vitest.unit.config.ts scripts/cutover-backup.test.ts src/core/migration/cutover-manifest.test.ts scripts/restore-runbook-drift.unit.test.ts`: 145 passed, `unit-final.log`.
- Pinned `pnpm typecheck`, `pnpm lint`, `pnpm build`: exit 0 in `typecheck-final.log`, `lint-final.log`, `build-final.log`. Lint reports 290 warnings and no errors.
- `bash -n scripts/restore-drill.sh scripts/cutover-final-backup.sh`: exit 0, `shell-syntax-final.log`. `git diff --check`: exit 0, `diff-check-final.log`.

Node `24.19.0` and cached pnpm `11.13.1` were confirmed first. Transport tests use the existing intercepted
CLI/shell pattern, fake Docker/driver transports and network/listener traps, with no fallback to real
transports. Import-inert testing also traps child-process creation. Coverage includes paired modes,
ownership/storage/cleanup races, unknown creation, mapping/DB identity changes, failed retention, forged
receipts/provenance, actual artifact mismatch, explicit-target restrictions and driver failure/timeout/
interruption/close. The previous exit-17 shell regression remains fail-closed.

No Docker, PostgreSQL, Testcontainers, migration, provider, network, runtime or browser acceptance ran.
The parent's earlier thirteen real canonical PG passes were not rerun or promoted to this source HEAD.
Actual Docker inspection shape/mapping, lazy driver protocol behavior, full capture/restore fidelity and
DBOS completed/pending/held reopen remain parent-owned runtime acceptance. No private restore/replay,
runtime lock/configuration change, dependency installation, fetch/branch change, push/PR/watch/Linear or
independent review was performed. PLAN.md, .remember and the canonical DB test remain parent-owned.
README has no obsolete universal no-port claim and needed no edit. No judge PR1625 code was brought in.

No new actionable follow-up outside the existing YUK-1359/YUK-1329 restore/reopen obligation was found.
External tracker operations were prohibited; parent retains issue state and the capture gate.
