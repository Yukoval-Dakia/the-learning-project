# Agent development workflow

This is the detailed command and validation reference linked from `AGENTS.md`.
`README.md` remains the source of truth for runtime shape, local setup, NAS
deployment, and the directory map.

## Local processes

```bash
pnpm dev:local        # Postgres + API :8787 + Vite :5173 + worker
pnpm dev              # alias for dev:local
pnpm rw:api           # Hono API
pnpm rw:web           # Vite SPA
pnpm worker:dev       # standalone pg-boss worker
pnpm build            # Vite + server/worker/migrate bundles
```

Development requires the API, web app, and standalone worker. `RW_WORKER=1`
is a fallback and does not replace the standalone worker.

## Local validation commands

```bash
pnpm typecheck
pnpm lint
pnpm vitest run --config vitest.unit.config.ts <test-file>
pnpm vitest run --config vitest.db.config.ts <test-file>
pnpm test:unit:watch <test-file>
pnpm test:db:watch <test-file>
pnpm test:migration
pnpm build
```

Do **not** run the complete `pnpm test` suite on the local machine. Push the
candidate head and let the exact-head GitHub `CI Gate` run the complete suite.
Local verification is typecheck, lint, audits, and build, plus the invariant
tests your change touches (if any).

### When to write a test (YUK-1401, owner 2026-10-10)

Tests are **not written by default**. Write or update one only when the change
touches one of these invariants, and only with assertions that fail when the
invariant breaks:

1. Irreversible data: migrations, backup/restore without dropped columns,
   delete/merge without data loss.
2. Deterministic scoring and settlement: same input, same score/state (numeric
   cores and TS↔Rust parity included).
3. Concurrency and locks: advisory locks, CAS/version conflicts, transaction
   rollback, idempotent retry.
4. Security boundaries: `/api/*` auth and exemptions, no provider key in the
   browser, authorization, no third-party personal data leakage.
5. Crisis referral (YUK-1398).

The five invariants take precedence over the exclusions below: a helper, DTO,
or UI behavior that carries one of them (deterministic scoring, idempotency,
privacy isolation, …) still gets an invariant test. Otherwise do not write tests
that only check UI/component rendering, DTO/schema shape,
prompt/copy/snapshots/byte hashes, source-path or doc structure, or
implementation details, or that only assert "was called"/"exists", and do not
add tests for coverage. Agent/model
output quality and learning effect are verified with real provider
actual-output or learner-outcome reconciliation, sealed with exact revision,
input/output digests, task-run ID, and provider/model/cost.

Loops for invariant tests:

- Pure logic: `pnpm vitest run --config vitest.unit.config.ts <file>`.
- DB/API: `pnpm vitest run --config vitest.db.config.ts <file>`.
- Migration SQL: `pnpm test:migration`.

DB tests use a real Postgres testcontainer and must reset state in `beforeEach`.
Its disposable data directory uses a 2 GiB tmpfs. PostgreSQL durability settings,
constraints, and transactions remain enabled. This suite does not establish
durability across a host reboot or container replacement.
Migration smoke also uses bounded tmpfs for each of its independently owned
containers. It runs the unchanged migration/backfill matrix and checks that
PostgreSQL `fsync` and `synchronous_commit` remain on; it is not a host-reboot
durability test.
Files importing DB clients, `postgres`, Drizzle, or live `PgBoss` belong in the
DB config, not the unit config. DB files run in isolated fork databases. The default
remains `resetDb()` in `beforeEach`; transaction rollback is opt-in only when every
query flows through `testDb()`. Keep full resets for singleton/raw clients, pg-boss,
advisory locks, concurrency, committed cross-connection visibility, and
`RESTART IDENTITY`-sensitive assertions. Never call `resetDb()` inside an active
transaction.

## Audit commands

The complete mechanics and allowlist formats live in the `audits-reference`
skill. Common entry points:

```bash
pnpm audit:schema
pnpm audit:dependencies
pnpm audit:api-contracts
pnpm audit:api-client
pnpm audit:api-client-usage
pnpm audit:capability-boundaries
pnpm audit:provider-lanes
pnpm audit:partition
pnpm audit:test-policy
pnpm audit:profile
pnpm audit:learner-copy
pnpm audit:no-learning-styles
pnpm audit:structured-judge
pnpm audit:task-census
pnpm audit:draft-status
pnpm audit:draft-status-reads
pnpm audit:relations
pnpm audit:calibration
pnpm audit:threshold-calibration
pnpm audit:mastery-provenance
pnpm audit:fold-writes
pnpm audit:flags
pnpm audit:projection
pnpm audit:golden --kind=<kind>
```

`audit:capability-boundaries` 同时检查 public/ui-public access seam 与三张架构债
ratchet（capability→server、server→capability deep、cross-capability value/SCC）。
机器可读报告用 `pnpm audit:capability-boundaries --json`。实测 pair 比基线低时审计失败，
运行 `pnpm audit:capability-boundaries --tighten` 收紧
`scripts/capability-boundary-baseline.json`。该命令仅下调，并追加 `changes` 记录：
`direction: "decrease"`、`debt`、`pair`、UTC `date`、`from`、`to`。
审计仍有任何错误时不写文件；再次运行不会重复追加记录。SCC 只能缩小，不能自动扩张。

需要上调时，手动追加 `direction: "increase"` 记录，除上述字段外必须填写非空
`reason` 和 `exitCondition`，并同步 pair 与 total。三类债务都受检查，缺失 pair 按 0 处理。
CI 从 PR base SHA（push 时为 before SHA）重放新增记录，要求其结果与当前基线一致，
且旧记录不可删除或改写。历史 `notes` 不追溯补写，也不能代替新上调记录。
字段检查不判断理由是否充分或退出条件是否达成，这两项仍由 reviewer 判断。

本地默认比较 `git merge-base HEAD origin/main`，也可用 `--base <commit SHA>`。
CI 必须提供 `CAPABILITY_BASE_SHA`；手动 workflow 使用已有的 `test_policy_base` 输入。
`pnpm audit:capability-boundaries:snapshot` 仍只打印实测快照，不带变更记录，不能用它覆盖基线。

### Lint warning ratchet（YUK-909）

`pnpm lint:ratchet` 对 `biome check .` 的 warning/info 总数执行只降不升的 ratchet，
CI static lane 用同一次 Biome 扫描检查 errors 与 warning/info 增长。基线在 `scripts/lint-baseline.json`：总数 +
逐 rule 计数（信息诊断单独计数，不静默丢弃；决策已记录在文件内）。落地一个
修 warning 的 batch 之后用 `pnpm lint:ratchet:update` 重新生成基线；该命令拒绝
任何上调——基线只可能下降。

Before a PR, run:

First run any invariant tests the diff touches. Then run this local gate:

```bash
pnpm typecheck
pnpm lint
pnpm audit:schema
pnpm audit:partition
pnpm audit:api-client
pnpm audit:api-client-usage
pnpm audit:capability-boundaries
pnpm audit:provider-lanes
pnpm audit:profile
pnpm audit:task-census
pnpm audit:draft-status
pnpm audit:draft-status-reads
pnpm build
```

After push, the exact-head GitHub `CI Gate` runs separate static, audit, unit, DB,
migration, build and parity lanes. Every code change runs all retained invariant files in
the unit/DB lanes; only verified docs-only changes skip them. Each lane computes its plan after checkout, without waiting for a classifier job. DB files run in eight nonempty native Vitest shards; unit files run in two. The exact include lists live in
`vitest.shared.ts`, and `audit:partition` rejects missing, duplicate or unassigned
files and direct unmocked DB imports in unit files. The audit lanes run exactly the
commands listed in `.github/workflows/ci-gate.yml`: schema, dependencies, partition, test-policy,
question-writers, API-contract, API-client, API-client-usage, capability-boundary,
architecture-deepening, profile, learner-copy, no-learning-styles, structured-judge,
task-census, draft-status, strict draft-status-read, strict flags, hub-sync-writer and
provider-attempt-truth. `audit:provider-lanes` is a local-only census and is not in CI.
The build lane injects secret canaries into the build environment, scans
both SPA and Start browser artifacts, and verifies frontdoor token/exemptions via
an isolated listener. The parity lane runs `cargo test` plus the native/WASM/JS
parity suites with `REQUIRE_RUST_PARITY=1` for every code change, main push,
manual full invocation and unknown/invalid base. Only an explicit successful docs-only
plan may skip work. Missing planner output selects work, and planner failure fails the
lane. The
plan lives in `scripts/ci/gate-plan.mjs`. The explicit local audit commands
remain useful for clear attribution, but they do not replace the GitHub gate.

### Test admission

`audit:test-policy` compares AST case registrations with the PR base or main push parent.
New, changed and duplicated cases require two comments immediately before each registration:

```ts
// @invariant concurrency: a stale version cannot overwrite a committed answer
// @fails-if remove the version predicate from the answer UPDATE; the stale write must be rejected
it('rejects a stale answer write', async () => { /* real write and rejection assertion */ });
```

Categories are `data`, `grading`, `concurrency`, `security`, and `crisis`, matching
the five classes in AGENTS.md. Formatting-only changes and deletions do not require new
declarations. Existing cases are inherited, not retroactively certified.

The check enforces explicit admission and reports the exact registration. It cannot decide
whether the claim is true. Independent review must trace the named defect to the assertion;
use a scoped mutation or known failure when that relationship is uncertain. Delete a case
whose only outcome is a UI shape, config/DTO shape, helper call, or implementation mirror.
Do not label one of those cases as an invariant to satisfy the check.

No fine-grained tests (owner 2026-10-11). The five invariants decide *whether* a test is
needed; this rule decides *where it enters*. An invariant carried by a helper is tested through
the nearest real boundary or its module's public entry, not the helper itself. Real boundaries
are a route, job, DB transaction (including lock/CAS/idempotency primitives exercised on real
Postgres), the settlement/grading chain, an agent tool contract, or a deterministic core
module's public entry (functions exported from the module index; TS↔Rust parity suites count).
One case per invariant; a table-driven case counts as one. Add a branch or boundary case only
when removing it would let a specific defect through that no other case catches, and name that
defect in `@fails-if`. Reject internal-helper tests, parameter permutations over the same path,
and assertions on mock interactions or call counts. Mock only external dependencies (provider,
network, clock, blob storage); DB-backed invariants belong in the DB lane on real Postgres.
When a PR adds more test lines (fixtures included) than production lines (non-test files under
`src/`, `server/`, `web/`, `scripts/`, plus migration SQL), its description must justify each
invariant. This is a justification trigger, not a hard cap; delete what cannot be justified.

Locally the base is `git merge-base HEAD origin/main`; use
`pnpm audit:test-policy --base <commit>` to reproduce a CI comparison. CI fetches history
and supplies `TEST_POLICY_BASE`. Manual dispatch requires the `test_policy_base` commit SHA.
A missing CI base or invalid base fails the check.

## Postman

`postman/api-endpoints.json` is the source of truth for the generated
collection. After adding or changing a route, update the spec, run
`pnpm gen:postman`, and optionally run `pnpm api:smoke [folder]`.
