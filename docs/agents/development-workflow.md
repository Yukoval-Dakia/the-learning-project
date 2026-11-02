# Agent development workflow

This is the detailed command and validation reference linked from `AGENTS.md`.
`README.md` remains the source of truth for runtime shape, local setup, NAS
deployment, and the directory map.

## Task state and handoff

Linear owns shared task scope, ownership, progress, blockers, and follow-ups.
`PLAN.md` and `.remember/now.md` are optional, ignored notes for the current
worktree; keep them local. Commit durable requirements, approved designs,
decisions, and delivery conclusions in the appropriate versioned documents.

When an older branch first integrates their removal from Git, keep a copy of
both local files outside the worktree before merging. If Git reports a
modify/delete conflict, preserve the local content but accept removal from the
index with `git rm --cached -- PLAN.md .remember/now.md`; restore the copies as
ignored local files after the merge. Do not reintroduce another lane's task state.

## Local processes

```bash
pnpm dev:local        # 唯一入口：起 dev Postgres(:5434，与 TEST 隔离)+迁移+API/Start 前门 :8788(Vite HMR)+worker；打开 http://127.0.0.1:8788/；全新 dev 库自带 7 道已准入的种子题（`devseed:q:*`，固定答案、无需模型即可判分，仅 dev 库），重置：`docker compose -f docker-compose.dev.yml --profile dev down -v`
pnpm dev              # alias for dev:local
pnpm rw:api           # Hono API（设 RW_FRONTDOOR=dev 才带 Vite 前门；dev:local 已设）
pnpm worker:dev       # standalone pg-boss worker
pnpm build            # Start + server/worker/migrate bundles
```

Development requires the API (which hosts the Vite front door) and the standalone worker. `RW_WORKER=1`
is only a fallback; run the standalone worker.

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
PostgreSQL `fsync` and `synchronous_commit` remain on.
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
pnpm audit:partition
pnpm audit:question-writers
pnpm audit:api-contracts
pnpm audit:api-client
pnpm audit:tool-params
pnpm audit:capability-boundaries
pnpm audit:architecture-deepening
pnpm audit:practice-subowners
pnpm audit:profile
pnpm audit:learner-copy
pnpm audit:no-learning-styles
pnpm audit:structured-judge
pnpm audit:test-policy
pnpm audit:task-census
pnpm audit:draft-status
pnpm audit:flags --strict
pnpm audit:hub-sync-writers
pnpm audit:provider-lanes
pnpm audit:model-source
pnpm audit:advisory-locks
pnpm audit:relations
pnpm audit:mastery-provenance
```

`pnpm embed:inventory` is a read-only question-vector census (no embedding calls,
no writes; `scripts/embed-inventory.ts`).

`pnpm audit:capability-boundaries` 执行 capability `*-api.ts` 不得手写 `apiJson`
（必须使用生成的 operations）这条不变量，并同时检查 public/ui-public access seam 与三张架构债
ratchet（capability→server、server→capability deep、cross-capability value/SCC）。
机器可读报告用 `pnpm audit:capability-boundaries --json`。

`scripts/capability-boundary-baseline.json` 只记当前上限：三类债务的 `total`、`byOwnerPair`
与 `crossCapabilityValue.nontrivialSccs`，不存变更历史或批准记录（批准与理由写在 PR / Linear）。
审计对每个 pair、每个 total 和 SCC 做两次比较，任何一项上升即失败：

- 实测 ≤ 台账：缺失 pair 按 0 处理；
- 实测 ≤ base commit 实测：同一 PR 的 base 上重新测量，所以单改台账不能准入新增依赖，
  台账未及时下调留下的余量也不能被后续 PR 用掉。

实测下降不失败，审计会提示运行 `pnpm audit:capability-boundaries --tighten`，把台账改写为
实测快照（只会下降；审计有任何错误时不写文件）。建议在同一 PR 收紧；并行 PR 各自收紧不同 pair
时只在同一个 `total` 行冲突，重跑 `--tighten` 即可解决。台账没有上调通道：
`serverToCapabilityDeep` 另由 architecture-deepening 强制为 0，同一 owner-pair 内一删一增仍由
独立 review 对照真实 diff 判断。

`pnpm audit:architecture-deepening` 的 pass-through ratchet 要求相对 base 新增的纯转出站点
（module / function / alias / site）在 `scripts/pass-through-classifications.jsonl` 中有一行
精确绑定（`file`、`kind`、`symbol`、`targetModule`、`targetSymbol`）的分类，否则失败：

- `stable_contract`：经裁定的单符号公开端口，`symbol`/`targetSymbol` 不能是 `*`；
- `compat_shim`：带 `deadline` 的临时转接，`deadline` 不得晚于当天 +14 天；过期而站点仍在即失败；
  base 中仍存活站点的 compat 行不得删除、改分类或延期，只能随站点一起删除。
  `compat_shim` 行数只减不增：不得多于 base 版分类文件中的行数。

文件每行一个 JSON 对象，按 `file|kind|symbol|targetModule|targetSymbol` 排序且唯一；
站点消失时同一 PR 删除对应行（不匹配任何现存站点的行会失败）。

本地默认比较 `git merge-base HEAD origin/main`，也可用 `--base <commit SHA>`。
CI 的静态 `audits_architecture` job 必须提供 `CAPABILITY_BASE_SHA`；手动 workflow 使用已有的 `test_policy_base` 输入。
CircleCI 的事件可能缺少 PR base 和 push before，因此该 job 复用
`scripts/ci/resolve-circle-audit-base.mjs`，将其验证后的 SHA 输出传给 `CAPABILITY_BASE_SHA`。
分支 push 可能早于 GitHub 把提交关联到 PR；等到截止仍是同一个 open PR 才采用，中途出现第二个或身份变了立刻失败，截止时仍是 0 也失败。
main push 缺少 before 时，双父 merge 取第一父；单父提交只有在关联的已合并 PR 的
`merge_commit_sha` 等于 HEAD 且 base 为 `main`（squash merge）时才取其唯一父提交。
无法确认 base 时仍失败，不回退到移动分支或猜测父提交；GitHub 保留原有 event/input 来源。
`pnpm audit:capability-boundaries:snapshot` 只打印实测快照，不做台账或 base 比较。

### Lint warning ratchet（YUK-909）

`pnpm lint:ratchet` 对 `biome check .` 的 warning/info 总数只拦增长：每项不得高于上限，
低于不失败，并行 PR 不必各自改基线文件。CI static lane 传入比较基（`LINT_BASE_SHA`），
脚本取它与 HEAD 的分叉点，在该提交的临时 worktree 上实测一次，上限取「基线文件」与
「分叉点实测数」的较小值，所以实际基线始终是 main 的真实数字；本地不传比较基时只用文件。
基线在 `scripts/lint-baseline.json`：总数 + 逐 rule 计数（信息诊断单独计数）。基线文件
只降不升：PR 把任一总数调得高于分叉点的文件即失败，`lint:ratchet:update` 也拒绝上调；
收紧文件是可选的整理，随时可做。

Before a PR, run:

First run any invariant tests the diff touches. Then run this local gate:

```bash
pnpm typecheck
pnpm lint
pnpm audit:schema
pnpm audit:partition
pnpm audit:api-client
pnpm audit:capability-boundaries
pnpm audit:provider-lanes
pnpm audit:profile
pnpm audit:task-census
pnpm audit:draft-status
pnpm build
```

After push, the exact-head GitHub `CI Gate` runs separate static, audit, unit, DB,
migration, build and parity lanes. Every code change runs all retained invariant files in
the unit/DB lanes; only verified docs-only changes skip them. Each lane computes its plan after checkout, without waiting for a classifier job. DB files run in eight nonempty native Vitest shards; unit files run in two. The exact include lists live in
`vitest.shared.ts`, and `audit:partition` rejects missing, duplicate or unassigned
files and direct unmocked DB imports in unit files. The audit lanes run exactly the
commands listed in `.github/workflows/ci-gate.yml`: schema, dependencies, partition,
question-writers, API-contract, API-client, tool-params,
capability-boundary, architecture-deepening, practice-subowners, profile, learner-copy, no-learning-styles,
structured-judge, test-policy, task-census, draft-status (insert and pool-read), strict
flags, hub-sync-writers, provider-lanes, model-source, advisory-locks, relations and
mastery-provenance.
`audit:provider-lanes` checks lane wiring and attempt-truth (wrapper, legacy cost, zero-cost)
and runs in the policy audit lane.
`audit:relations` runs in that same lane as the default report-only command; dead edges and stale declarations do not fail the step.
`audit:mastery-provenance` runs in that same lane as the default report-only command; unguarded reads and stale tracked paths do not fail the step (`--strict` stays out of CI).
The build lane injects secret canaries into the build environment, scans
both SPA and Start browser artifacts, and verifies frontdoor token/exemptions via
an isolated listener. The parity lane runs `cargo test` plus the native/WASM/JS
parity suites with `REQUIRE_RUST_PARITY=1` for every code change, main push,
manual full invocation and unknown/invalid base. Only an explicit successful docs-only
plan may skip work. Missing planner output selects work, and planner failure fails the
lane. The
plan lives in `scripts/ci/gate-plan.mjs`. Local audit commands help with clear
attribution; the GitHub gate is authoritative.

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
declarations. Existing cases are inherited without retroactive certification.

The check enforces explicit admission and reports the exact registration; whether the
claim is true is for review to judge. Independent review must trace the named defect to
the assertion; use a scoped mutation or known failure when that relationship is
uncertain. Delete a case whose only outcome is a UI shape, config/DTO shape, helper
call, or implementation mirror. Do not label one of those cases as an invariant to
satisfy the check.

No fine-grained tests (owner 2026-10-11). The five invariants decide *whether* a test is
needed; this rule decides *where it enters*. An invariant carried by a helper is tested through
the nearest real boundary or its module's public entry, not the helper itself. Real boundaries
are a route, job, DB transaction (including lock/CAS/idempotency primitives exercised on real
Postgres), the settlement/grading chain, an agent tool contract, or a deterministic core
module's public entry (functions exported from the module index; TS↔Rust parity suites count).
One case per invariant; a table-driven case counts as one. Test each behavior once at its
nearest real boundary; do not keep both a unit and a DB version of the same behavior — once
the DB case proves it, delete the unit version. Before adding a case, first look for existing
cases to merge or delete; when behavior changes, update or delete the stale tests in the same
PR. Add a branch or boundary case only
when removing it would let a specific defect through that no other case catches, and name that
defect in `@fails-if`. Reject internal-helper tests, parameter permutations over the same path,
and assertions on mock interactions or call counts. Mock only external dependencies (provider,
network, clock, blob storage); DB-backed invariants belong in the DB lane on real Postgres.
When a PR adds new test lines (fixtures included), they target roughly 10% of new production
lines (non-test files under `src/`, `server/`, `web/`, `scripts/`, plus migration SQL); beyond
that budget the PR description must justify each invariant. This is a justification trigger,
not a hard cap; delete what cannot be justified. Test names and comments state the behavior —
no ticket numbers, review rounds, or status markers such as `UNRUN`/`prepared`.

Locally the base is `git merge-base HEAD origin/main`; use
`pnpm audit:test-policy --base <commit>` to reproduce a CI comparison. CI fetches history
and supplies `TEST_POLICY_BASE`. Manual dispatch requires the `test_policy_base` commit SHA.
A missing CI base or invalid base fails the check.

## Postman

`postman/api-endpoints.json` is the source of truth for the generated
collection. After adding or changing a route, update the spec, run
`pnpm gen:postman`, and optionally run `pnpm api:smoke [folder]`.
