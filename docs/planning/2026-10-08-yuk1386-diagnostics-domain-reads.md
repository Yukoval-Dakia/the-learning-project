# YUK-1386 diagnostics domain reads

Implemented on `feat/yuk-1386-diagnostics-domain-reads`, based on
`origin/main a6faded0729fd77789a05d4a07a706d5ff6b612a` and parent documentation
commit `cf8867b4bf1b8729b9c2de1ad7a54caa7bec4917`.

## Parent acceptance and delivery — 2026-10-08

PR1611 merged at 12:48:38Z as `6c6905fad01a3e7f7ea376afdad9d07d3a413d65`.
Fetched main tree `7a6e28abca853638976201fb1ecaad453bd5d5a5` equals exact
candidate `f7b84efc7b405fc774e23d5156694386e15fd468`. CI Gate `37778323336`
passed; independent R1 found P0/P1 NONE on the unchanged ten source/test blobs;
review threads were zero. CodeRabbit skipped and Codex hit its review quota;
neither result is represented as a code-review pass. The PR is unwatched.

The parent ran the three DB suites below: **24/24 passed**, exit 0, under an
atomic deployment lock. Evidence: `/tmp/yuk1386-parent-db.log` and
`/tmp/yuk1386-db-cleanup.json`. Owner/token verification preceded release at
12:43:53.390892Z. Original four containers and release hash were unchanged;
no new running containers remained. This verifies transaction visibility,
rollback, public-table row-content snapshots, time boundaries and HTTP parity.
It does not establish sequence or non-public-schema immutability.

YUK-1386 is Done for this domain slice. Main owner received the public APIs and
merge SHA; Start consumption and page acceptance remain under YUK-1358, exit
under YUK-1359. No deployment occurred. No new actionable finding was identified.
The implementation receipt below preserves what its author ran; its pending
parent checks were subsequently completed as recorded above.

## Public contract and scope

`src/capabilities/observability/public.ts` now exports the existing readers and
DTO types without wrapping or copying their implementations:

```ts
loadCoverageLattice(db: Db | Tx, now?: Date): Promise<CoverageLatticeRead>
loadConjectureScores(db: Db | Tx): Promise<ConjectureScoresRead>
```

Coverage's implementation retains `now: Date = new Date()`. Omitted and explicit
`undefined` use the wall clock; an explicit Date controls `generated_at`, activity
lookback and cooldown. `scan_ms` remains the elapsed `Date.now()` measurement of
`assembleScanInput`. The live subject registry remains the display-name source.

Public coverage types are `CoverageLatticeRead`, `GapActivity`, `KcCoverageRow`,
`LatticeGap`, and `SubjectCoverage`. Public conjecture types are
`ConjectureScoresRead`, `ConjecturePredictionScoreRow`, `ConjectureTypedStateRow`,
and `ConjectureScanDiagnostics`. Their existing string timestamps and data
shapes are unchanged.

Both existing GET handlers import their reader from `../public` and pass the
singleton database. Response serialization and `errorResponse` are unchanged.
No route, manifest, response schema, Postman specification, generated API client,
UI or Start consumer changed.

The only practice changes are the `Db, Tx` type import and `Db | Tx` signatures
on `loadFrontierKnowledge`, `loadQuestionPool`, and `assembleScanInput` in
`server/question-supply/target-discovery.ts`. Source inspection confirms
`getMasteryState`, `globalThetaForDomain`, and `getEffectiveDomain` already accept
and use the caller's handle. `getEffectiveProbeResultStatuses` likewise passes
its `Db | Tx` through corrections, recurrence dependencies and frozen assessment
reads. No deeper reader repair was needed.

The internal evidence deadline remains unchanged and is excluded from coverage's
public DTO. Discovery filters, score math, recovery and clocks are unchanged.
Conjecture still declares `single_point`, returns at most 200 mapped rows per
collection, scans at most 400 raw rows and fetches one extra sentinel. It drops
corrupt mapped rows and source statuses `corrected` or `dependency_inactive`.
It retains historical rows whose source status is `missing`, as before.

## Verification executed

All commands used
`PATH=/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH`.
Observed Node is `v24.19.0`; pnpm is `11.13.1`. No install was performed.

```sh
pnpm vitest run --config vitest.unit.config.ts \
  src/capabilities/observability/server/diagnostics-domain-reads.unit.test.ts \
  src/capabilities/observability/server/coverage-lattice-core.unit.test.ts \
  src/capabilities/observability/server/admin-domain-reads.unit.test.ts \
  src/capabilities/observability/manifest.unit.test.ts \
  src/capabilities/composition.unit.test.ts \
  src/capabilities/observability/ui/observability-honesty.unit.test.ts \
  src/capabilities/observability/ui/conjecture-scores.unit.test.tsx
```

99 tests in 7 files passed. Log: `/tmp/yuk1386-unit.log`.
The new public-contract suite contributes 11 tests. It uses the production pure
coverage scanner with a mocked IO seam, verifies complete DTO/HTTP equality,
registry names, zero-goal coverage versus nonzero input, optional/explicit now,
exclusive cooldown expiration and a separate 37 ms elapsed scan measurement.
Conjecture contracts check all score/state fields, missing-source compatibility,
corrupt/corrected/dependency-inactive drops, both scan/result caps, diagnostics,
generic HTTP 500 secrecy, and structured error status/body/headers.

The existing coverage-core suite retains the four-KC pool/axis/gap projection and
activity aggregation matrix. The existing UI suites retain honest empty/partial
scan and proper-score presentation contracts. Manifest/composition tests retain
both route registrations. Admin-domain contracts check the expanded public
barrel alongside its existing consumers.

Static gates passed:

| Command | Log | Evidence |
| --- | --- | --- |
| `pnpm typecheck` | `/tmp/yuk1386-typecheck.log` | Root and Start TypeScript projects passed, including new DB test source |
| `pnpm lint` | `/tmp/yuk1386-lint.log` | Zero errors, 290 warnings across the repository |
| `pnpm build` | `/tmp/yuk1386-build.log` | Frontend and app/worker/migrate bundles built; none were executed |
| `pnpm gen:postman` | `/tmp/yuk1386-postman.log` | 94 requests generated; collection/spec have no tracked changes |
| `pnpm audit:api-contracts` | `/tmp/yuk1386-api-contracts.log` | 173/173 declared, zero legacy, 163 OpenAPI paths |
| `pnpm audit:capability-boundaries` | `/tmp/yuk1386-boundaries.log` | Zero deep cross-capability imports, exact debt ratchets |
| `pnpm audit:partition` | `/tmp/yuk1386-partition.log` | Zero unmatched files and zero unit DB-import errors; six warnings on other files |

Changed-test formatting/check log: `/tmp/yuk1386-format.log`.
`git diff --check` passed. Production reader bodies and practice behavior were
compared against the base after reversing only the authorized type edits.

## Parent DB acceptance, not executed here

The existing coverage and conjecture DB suites were extended, preserving their
fixtures and original assertions. Coverage now has 9 tests and conjecture 14.
Every original HTTP fixture also compares its complete response with the public
reader. Coverage freezes only Date for this comparison and explicitly normalizes
`scan_ms`; conjecture compares exact response bytes.

New real-DB test source asserts nonzero uncommitted caller-Tx data, absence on both
the singleton and the outside test handle, full public-table content snapshots
before/after reads, and restoration to the baseline on intentional rollback.
Coverage exercises inherited KC domain, mastery, active goal, thin/covered pools,
calibration and supply activity. Conjecture exercises a legacy missing-source
score, typed-state provenance, corrupt data, real correction status and inactive
recurrence status. The latter statuses are asserted independently before checking
that their scores are dropped. A coverage DB case checks inclusive lookback and
exclusive cooldown boundaries.

After acquiring its runtime/deployment lock, the parent should run:

```sh
export PATH=/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:$PATH
pnpm vitest run --config vitest.db.config.ts \
  src/capabilities/observability/api/coverage-lattice.db.test.ts \
  src/capabilities/observability/api/conjecture-scores.db.test.ts \
  src/capabilities/observability/api/diagnostic-contracts.db.test.ts
```

Expected source count is 24 tests in 3 files. This command uses the repo's DB
partition setup and therefore must run only under the parent's authorized lock.
It has not been run by this implementation lane.

Unaffected discovery filtering is covered by the existing
`practice/server/question-supply/target-discovery.db.test.ts`. Retraction and
trusted frozen probe evidence are covered by existing
`agency/server/conjecture/probe-lifecycle.db.test.ts` and
`agency/server/scout/evidence-mcp.db.test.ts`. These suites and their production
readers are unchanged; no new execution result is claimed for them.

Snapshots compare every public table's row contents. They do not assert sequence
counter rollback or physical database-wide immutability. This is source/static
completion only. Independent review, actual DB acceptance, exact-head CI,
tracker state, integration and delivery belong to the parent. It is not W5,
YUK-1358/YUK-1359 completion or a runtime/deployment PASS.

No additional actionable follow-up was found within this bounded implementation.
YUK-1386 remains subject to parent acceptance. Per the assigned boundaries this
lane did not contact Linear or modify PLAN/.remember/1359 documents, create
children, fetch/switch/merge, push, open PRs, watch, acquire locks, run DB/container
or service/browser/provider/worker/replay/deployment operations.

The terminal receipt supplies the exact commit and complete changed-file SHA256
manifest at `/tmp/yuk1386-sha256.txt`. Writer ownership is released at that handoff.
