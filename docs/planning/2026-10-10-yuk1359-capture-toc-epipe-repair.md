# YUK-1359 capture TOC EPIPE repair evidence

Repair of the `pg_restore -l` stdin EPIPE that aborted capture after dump on the real
10.9 MB source dump (parent repro: `pg_restore -l` exits 0 with 681 TOC lines and no
stderr while the input pipeline rejects `EPIPE`). Needed for YUK-1346 retention
acceptance. Audit root: migration full-restore / retention safety, stage 第一天能用.

## Root cause

`runProcess` (`scripts/cutover-backup.ts`) treated every stdin write error as fatal:
`writeInput` rejection ran `terminateOnError` (SIGKILL) and the process rejected even
when the child had already exited 0 with complete, valid output. `pg_restore -l`
reads only the archive header from stdin, then exits; on any dump larger than the
pipe buffer the remaining write deterministically fails `EPIPE`.

## Minimum repair

New explicit `inputConsumption: 'full' | 'prefix'` option on `runProcess`
(default `'full'`, existing callers unchanged). `'prefix'` tolerates only
`EPIPE`/`ERR_STREAM_PREMATURE_CLOSE` on the stdin write side; the exit-code, signal,
timeout, output-limit and caller-side TOC validation gates are unchanged. No global
EPIPE suppression, no acceptance of nonzero/signal/timeout/malformed output.

Applied at exactly the three `pg_restore -l` call sites:

- capture TOC (`docker exec -i <container> pg_restore -l`, `inputFile: dumpPath`)
- restore-drill `--list-only` (`docker run --rm --network=none -i <image> pg_restore -l`)
- restore-drill full TOC verify (`docker exec -i <scratch> pg_restore -l`)

Full-input semantics preserved for: actual `pg_restore` restore (`--clean
--if-exists --no-owner --single-transaction --exit-on-error`), `psql` source reads,
dump streams and every other `runProcess` caller.

## Fixture change (test file only)

The intercepted `offlineTransport` fixture previously consumed all of stdin before
responding, so it could not reproduce the defect. New modes simulate real
`pg_restore -l` (reply after the first stdin chunk with `stdin.pause()`, then exit):

- `toc-early-exit`: early exit 0 with valid TOC (pg_dump emits 1 MB for capture)
- `toc-early-nonzero`: early exit 17
- `toc-early-malformed`: early exit 0 with non-TOC output
- `restore-early-close`: non-`-l` `pg_restore` exits 0 after the first chunk

`sourceFixture`/`offlineTransport` gained an optional `dumpBytes` parameter so the
staged dump exceeds the pipe buffer (4 MiB), making early-close deterministic.

## Red/green causal proof (real helper code, real CLI, fully intercepted)

RED (fix absent): `pg_restore -l reads only the dump prefix` failed — capture exited
1 with `{"phase":"cli","code":"operation_failed","message":"write EPIPE"}`, matching
the production repro; `--list-only` likewise failed 1. `toc-early-malformed` failed
but without `invalid_toc` (EPIPE masked the output gate). `toc-early-nonzero` and
`restore-early-close` already failed as required.

GREEN (fix applied): all four new tests pass, and the whole file passes.

Commands (all via `bash /tmp/yuk1359-offline-env.sh`, cwd = this worktree):

- `pnpm vitest run --config vitest.unit.config.ts scripts/cutover-backup.test.ts -t 'pg_restore -l reads only'`
  → RED: 1 failed / 161 skipped (`write EPIPE`)
- `pnpm vitest run --config vitest.unit.config.ts scripts/cutover-backup.test.ts -t 'early'`
  → RED: 2 failed / 2 passed; after fix → GREEN: 4 passed / 158 skipped
- `pnpm vitest run --config vitest.unit.config.ts scripts/cutover-backup.test.ts`
  → GREEN: 162 passed (104.77 s)
- `pnpm typecheck` → exit 0
- `pnpm exec biome check scripts/cutover-backup.ts scripts/cutover-backup.test.ts` → exit 0
- `pnpm build` → exit 0 (web build + `dist/{server,worker,migrate}.cjs`)

Assertions in the new tests cover: capture emits a sealed source manifest with
`toc_entries` 1; `--list-only` prints the TOC and writes no receipt; full
restore-drill returns `kind: verified`; the actual restore still received every
dump byte (`bytes.jsonl` sha == staged dump sha256); early nonzero yields
`{phase:'toc',exitCode:17}`; malformed yields `{phase:'toc',code:'invalid_toc'}`;
early restore closure yields a failed receipt with a `'restore'` phase error.

## Hashes (sha256)

- `scripts/cutover-backup.ts` (fixed): `33b5ee939a45aba839fe78f46e013f570189a394a0e5533507c0c37485167b7d`
- `scripts/cutover-backup.test.ts` (fixed): `095a08ac6d246c6f3a2c34011ea1b282c8c2f75c7c7a0f4c8795e3a8f3568495`
- parent repro `/tmp/yuk1346-f210-parent-capture-01/toc-repro.json`: `ff6f5264059b4b3bf8ef0e8718ae20e22ce9b8635a7b631836fa232708f8fad2`
- `package.json`/`pnpm-lock.yaml` identical to `tlp-yuk-1346-turn-retention`
  (`a4cb8557…`, `10c6a3c0…`); `node_modules` symlinked read-only for verification,
  not committed.

## Limitations

- Offline interception only: no Docker, network, real Postgres or real `pg_restore`
  ran in this worktree. Runtime acceptance on the real 10.9 MB dump remains with
  the parent; this is implementation evidence, not a runtime PASS.
- Early-close tolerance is modeled per call site (`'prefix'`), not inferred; any new
  prefix-reading command must opt in explicitly.
- Small dumps that fit the pipe buffer never produce EPIPE on either code path;
  behaviour there is unchanged.
