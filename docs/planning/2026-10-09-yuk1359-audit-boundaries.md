# YUK-1359 shared audit boundaries

Implementation in `/Volumes/YukovalSBak/yukoval-projects/tlp-yuk1352-start-frontdoor`,
branch `fix/yuk-1359-audit-boundaries`, from main
`fe48497123f92429eac6383cf7ccc839ade4142f` plus parent docs
`f69fb1bde6da9c7097bce12618ff29b79d2b17af`. Only audit scripts, helpers, tests and
this record changed. Parent owns review, delivery and tracker state. Owner7631's
trait/public tree and PR1617 remain outside this lane.

## Retention decision and enforcement

[ADR-0063](../adr/0063-retire-copilot-mailbox-execution.md), lines 23-29 and 38-54,
already settles YUK-951 B3: retain physical history across installations, refuse
undrained legacy work, preserve native children and forbid new continuation
producers. Its October amendment and [ADR-0065](../adr/0065-pi-execution-and-conversation-replay.md),
lines 94-100, preserve that decision through the Pi migration. An elapsed deadline
does not authorize dropping tables, recreating writers or renewing allowances.

| Physical table | Required inventory | Production write contract |
| --- | --- | --- |
| `copilot_evidence_checkpoint` | Existing 19 columns and types | Existing INSERT/UPDATE prohibition preserved |
| `copilot_continuation` | All 17 columns and types | Every recognized production INSERT/UPDATE fails, including opaque and trivial-only payloads |
| `subagent_run` | All 24 columns and types | Native lifecycle remains live; four retired ownership columns cannot be written |

The mixed table's retired columns are `claim_token`, `hard_deadline_at`,
`child_task_run_id` and `pg_boss_job_id`. `lease_expires_at` is distinct: the real
native settlement writes null to clear it, so the audit permits explicit null
cleanup and rejects acquiring a lease. Native INSERTs must explicitly use running
status and a directly constructed Date or a provable unchanged Date binding for
`started_at`. Updates permit the current cancellation/settlement columns and
source-backed terminal status literals or unions; opaque payloads, unknown status
values, raw SQL mixed-table writes and launch-column mutation fail closed.

The evidence comes from `src/db/schema.ts:2153`,
`src/capabilities/copilot/server/subagent-mailbox.ts:50` (native discriminator),
`:195` (settlement and null lease cleanup), `:234` (Stop), and `:364` (native
launch). `legacy-drain-readiness.ts:7` reads both tables and distinguishes running
native projections from pending legacy work. `turns.ts:306` consumes native
lifecycle events; `durable-run-observation.ts:74` reads active native children.
Export disposition is specifically `src/server/export/constants.ts:381` and
`:410`: both tables remain excluded process state and wipe-only on archive
restore. This audit does not claim that application archives restore their rows
or change that policy. ADR-0063's prior-worker rollback/drain obligation remains
installation-specific and was not exercised here.

Removed exactly 18 replaced allowance entries, comprising 14 continuation fields
and four child fields. Every remaining entry is structurally identical to the
parent. Ordinary deadline, merged-PR and shipped-phase checks remain active.
JSON retains the checkpoint report and adds `retainedSchemas`; text shows all
three inventories. The field health report shows 40 historical-retained fields,
while native child fields retain ordinary production classifications.

## Generated output boundary

`server/frontdoor.ts:19` dynamically imports
`../dist/start/server/server.js`. `resolveImportTarget` followed that path, and
`runtimeSourceClosure` traversed the generated assets and their bundled provider
code. Both `runProviderAttemptTruthAudit` and the separate architecture provider
census consume this resolver. Excluding a directory only from the initial source
walk would leave this path open.

The resolver now preserves the frontdoor import edge while stopping traversal
at this repository's top-level `dist` output. It checks path-component symlinks
before applying that boundary. Source `.js`, imported source outside the initial
backend roots, and source directories named `dist` remain scanned. No provider
inventory or architecture baseline changed.

The regression fixture uses the installed esbuild to bundle a real source wire
into `dist/start/server/assets/provider.js`, then imports it through the same
frontdoor shape, with an unsupported dynamic import in generated output. The
built duplicate leaves findings and violations unchanged. Mutations in genuine
source JS, an imported script and nested source `dist` still produce violations.
File/directory symlinks still refuse the census.

## Verification and evidence

All commands used Node 24.19.0 prepended to PATH and pnpm 11.13.1. No DB,
container, service, provider, migration or other runtime operation was performed.

| Command | Result and preserved log in `/tmp/yuk1359-audit-boundaries/` |
| --- | --- |
| Baseline `pnpm audit:schema` | Exit 1, exactly 18 expired entries; `baseline-schema-red.log` |
| Baseline `pnpm audit:architecture-deepening` after existing build | Exit 1, generated assets and 15 unclassified wires; `baseline-architecture-red.log` |
| New focused regressions before fixes | Exit 1, 24 failed / 67 passed; `causal-unit-red.log` |
| Final scoped unit command below | Exit 0, 296 tests / eight files; `final2-focused-unit.log` |
| `pnpm typecheck` | Exit 0; `final2-typecheck.log` |
| `pnpm lint` | Exit 0, 290 warnings; `final2-lint.log` |
| `CODEX_FULL_GATE=1 pnpm build` | Exit 0; `final-build.log` |
| Post-build `pnpm audit:schema` | Exit 0, no retention issues or unallowed stubs; `final-schema.log` |
| Post-build `pnpm audit:architecture-deepening` | Exit 0, 11 lanes / 0 unclassified; dependency totals 435/0/48; `final-architecture.log` |
| Post-build `pnpm audit:provider-lanes` | Exit 0, no violations; `final-provider-lanes.log` |
| Post-build `pnpm audit:provider-attempt-truth` | Exit 0; `final-provider-attempt.log` |

```sh
pnpm vitest run --config vitest.unit.config.ts \
  scripts/audit-schema-writes.test.ts \
  scripts/audit-copilot-retention.unit.test.ts \
  scripts/schema-evidence-soundness.unit.test.ts \
  scripts/schema-production-writes.unit.test.ts \
  scripts/schema-write-producers.unit.test.ts \
  scripts/audit-provider-lanes.unit.test.ts \
  scripts/audit-provider-attempt-truth.unit.test.ts \
  scripts/audit-architecture-deepening.unit.test.ts
```

The original supplied YUK-1391 red logs are copied unchanged alongside these
logs. Intermediate runs also remain, including `focused-unit-first.log`, whose
single failure was a test inventory typo of 25 instead of the actual 24 child
columns. Final generated Start server output remains present. SHA256 manifests
in the same evidence directory cover sources, decisions/consumers, parent docs,
logs, baseline source snapshots and generated server files.

This is implementation evidence, not independent review, exact-head CI,
installation drain, archive restore, runtime acceptance or deployment. Schema
checks cover names and constructor types, including timestamp timezone, rather
than nullability/default/constraint equivalence. Write discovery remains bounded
Drizzle and directly executed static SQL syntax, not proof against external SQL,
triggers, arbitrary wrappers or dynamic identifiers. New native construction
forms need explicit audit evidence rather than an allowance. The two confirmed
failures are repaired; no additional actionable follow-up was found in scope.
Parent retains Linear capture and all delivery obligations.

## Parent verification — 2026-10-09 JST

Parent verified all 64 source/log manifest entries and all 676 generated Start server files against the handed-off SHA256 manifests. At fixed source `739757dd9f7e6419e371efbafbfbd5e6a213ca56`, the parent independently ran all eight focused suites: 296/296 passed. With the generated output still present, all four real commands returned zero: schema, architecture-deepening, provider-lanes and provider-attempt-truth. Logs are `/tmp/yuk1359-parent-unit.log` and `/tmp/yuk1359-parent-audits/`; initial failures remain in the author evidence root.

Independent R1 is running on the fixed source diff. This is not yet review approval, exact-head CI or merge. No database, service, provider or deployment operation was performed.

## Independent review and CI fixture repair

Initial independent R1 completed with no P0/P1 on `f69fb1bde..739757dd9`; parent matched diff SHA256 `eecb8b8d46003105ea3ce0ebc1c293ee3c2891be74b0eaca87fe23b0ed500fae`. The reviewer traced native launch/settlement/Stop/recovery, drain/read/export consumers and the provider import closure. No additional review round was opened.

Exact CI `37804475263`, job `113405166468`, found one new fixture cleanup failure on Linux: `rmSync(server/artifacts)` reported that the symlink path was a directory. The preceding audit rejection assertion passed; 3017 other tests in that shard passed. Parent retained the downloaded job log at `/tmp/yuk1359-ci-unit3-gh.log` and changed only fixture cleanup to `unlinkSync`, with an assertion that its target file remains intact. Audit implementation is unchanged. Parent reran all 68 provider-lane tests, typecheck, lint and the complete build; all returned zero. Logs are in `/tmp/yuk1359-ci-repair/`. These Mac checks do not claim the pending new Linux CI result.
