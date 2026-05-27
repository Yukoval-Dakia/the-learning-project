# Wave 1 Post-Ship Lane W-A — Fix Plan

**Driver**：master coordinator prompt（Lane W-A scope，合并 audit `docs/audit/2026-05-27-wave1-postship-drift.md` 的 W-01 + W-04 + W-06）。
**Linear**：YUK-99。
**Lane branch**：`lane/w-a-brief-writer-wire`（worktree at `worktrees/w-a-brief-writer-wire/`）。
**Base**：fresh `main` at `c320446` (YUK-66 ship)。

---

## Erratum (YUK-101, 2026-05-27 iter2)

Post-ship `/code-review` against PR #163 surfaced two false claims encoded
in §1.1 / §1.3 / §2 below. They are not retroactively rewritten — the body
remains the historical record of what was decided at lane-launch time —
but readers must take the corrections below as authoritative:

* **F2 (sweep is NOT the belt-and-braces)**: §1.1 #2 says "生产 worker 会
  retry，event 本身已落 DB" and §1.1 idempotency note implies a daily-sweep
  backstop. The implemented sweep handler (`buildMemoryBriefSweepHandler`
  in `src/server/memory/triggers.ts`) iterates **stale brief_note rows**
  via `listStaleBriefScopes`, not orphan events. A missed
  `enqueueEventMemoryIngest` has **no automatic recovery in the current
  architecture** — the Mem0 fact layer permanently misses the event. The
  proper fix (transactional outbox: scan `event` rows where
  `ingest_at IS NULL`) is captured in YUK-101.

* **F14 (DB tests do NOT run the real boss path)**: §1.1 #3 + #4 claim
  "DB test 路径：不 override，跑真 boss". Vitest sets `process.env.VITEST`
  in **both** unit and DB pools (see `src/server/boss/client.ts:33` for
  the established pattern), and `defaultMemoryIngestEnqueuer` early-returns
  under `VITEST`. No vitest run — `pnpm test:unit`, `pnpm test:db`, nor
  full `pnpm test` — exercises the real dynamic-import path. The iter2
  band-aid is the module-resolution pin test
  `iter2 F6: dynamic-import targets for defaultMemoryIngestEnqueuer still
  resolve` in `queries.test.ts`; the structural fix is YUK-101.

The follow-up plan that lands these corrections in code:
[2026-05-27-wave1-postship-iter2-plan.md](./2026-05-27-wave1-postship-iter2-plan.md).

---

## 0. 目标

修两个 P1 silent dead path，让 ADR-0017 §"Write triggers (three paths)" #1 真正激活。范围 minimal：

1. **W-01** — `writeEvent()` 在每次 INSERT 完成后 fire-and-forget enqueue `MEMORY_EVENT_INGEST_QUEUE`。
2. **W-04** — `.env.example` 补 `OPENAI_API_KEY` + 6 个 `MEM0_*` 键；README 加 Mem0 / OPENAI setup 段。
3. **W-06** — 不需要单独动代码；W-01 wire 后 scope_tagger 自动 fire `meta:orchestrator_self` ingest job。Commit message 提一句。

**显式不在 scope**：W-02 / W-03 / W-05、advisor / review 路径、events/queries.ts 任何 unrelated refactor。

## 1. 设计选择

### 1.1 W-01 — 在 writeEvent 注入 enqueueIngest hook

约束：

- `src/server/events/queries.ts` 是 unit-test 友好层。直接静态 import `getStartedBoss` 会让 unit-test（含 route-level mock 链）拉 pg-boss 进 bundle。
- `writeEvent` 已有大量 caller（producer 在 route handler 与 boss handler 都有），不能 require 每个 caller 注入 boss。
- ADR-0017 §"Write triggers" 设计是「event creation 即 enqueue」—— 必须挂在 SoT INSERT 之后，否则总会有 caller 漏。

方案 — **fire-and-forget 默认 boss + optional override**：

1. `writeEvent` 函数末尾在 INSERT 成功 / no-op 之后调一个 module-private `fireMemoryIngest(eventId)`。
2. `fireMemoryIngest` 通过 **dynamic import** 拉 `getStartedBoss()` + `enqueueEventMemoryIngest`，包在 try/catch，错误 swallow 到 `console.error`（生产 worker 会 retry，event 本身已落 DB）。
3. 提供 `_setMemoryIngestEnqueuerForTests()` 模块级 setter（默认 no-op），让 unit-test 注入 spy；DB test 不注入 → 走 real path（但 DB test 也跑在 testcontainer 内，pg-boss 起得来）。
4. **重要不变**：DB test 的 `writeEvent` 默认要能 enqueue 真 boss，否则 W-01 acceptance 不真。但 unit-test 不能拉 pg-boss。所以：
   - **默认路径**：dynamic import `getStartedBoss()` — `pg-boss` 是 server-only，dynamic import 不会进 unit-test sync bundle。
   - **unit-test 路径**：每个 test 在 import 后调 `_setMemoryIngestEnqueuerForTests(spy)`；test 结束 reset 回默认。
   - **DB test 路径**：不 override，跑真 boss（已有 testcontainer + DATABASE_URL）。

idempotency：fire-and-forget 失败不能让 INSERT rollback —— enqueue 是次级效果，事件 SoT 是 `event` 表那行。

### 1.2 W-04 — env.example + README

- `.env.example` 在「AI provider keys」附近加：
  - `OPENAI_API_KEY=` 必填注释（YUK-37 / ADR-0017）。
  - `MEM0_EMBEDDING_MODEL=` `MEM0_EMBEDDING_DIMS=` `MEM0_LLM_MODEL=` `MEM0_PGVECTOR_COLLECTION=` `MEM0_PGVECTOR_HNSW=` `MEM0_PGVECTOR_DISKANN=` `MEM0_ANTHROPIC_BASE_URL=` 6 个 optional 注释 default 值（来自 `client.ts:3-7`）。
- README §Self-host on NAS / Prerequisites 之后插一节简述 Mem0 / OPENAI 需求 + 指向 ADR-0017 errata。

### 1.3 W-06 — 跟着 W-01 解

scope_tagger.ts 已 attach `meta:orchestrator_self`；W-01 wire 后该 scope 会自动进 ingest payload metadata。Commit message 提及。

## 2. TDD 顺序

1. Failing unit test：`src/server/events/queries.unit.test.ts`（如果文件不存在，加在现有 queries.test.ts 里也行 —— 但 queries.test.ts 是 db test，所以新增 unit-only 文件更干净）。
   - Test: `writeEvent(...)` triggers injected enqueuer with the inserted event id.
   - Mocks db.insert 通过 stub，但 `parseEvent` 真跑（确保 valid event）。
2. Run → fail（enqueuer not invoked）。
3. Production fix：`queries.ts` 加 `fireMemoryIngest` + `_setMemoryIngestEnqueuerForTests`；`writeEvent` 调用。
4. Run → pass.
5. （可选）DB-level smoke：现有 queries.test.ts 的 `writeEvent` describe block 是 DB test —— 加一项验证 `_setMemoryIngestEnqueuerForTests(spy); writeEvent(real db); expect(spy).toHaveBeenCalledWith(eventId)`。这同时验证 setter 在真 INSERT 路径上工作。

## 3. Files touched

- `src/server/events/queries.ts` — 加 `fireMemoryIngest` + `_setMemoryIngestEnqueuerForTests` + writeEvent 调用 + 头注释提 ADR-0017 trigger #1
- `src/server/events/queries.test.ts` — DB-level write 调用 enqueuer 的断言（注入 spy / 复原）
- `src/server/events/queries.enqueue.test.ts` — 新 unit-only test 文件（与 queries.test.ts 并行，按 audit:partition 标准走 vitest.unit.config.ts）
- `.env.example` — OPENAI_API_KEY + 6 MEM0_*
- `README.md` — Mem0 / OPENAI 段
- `docs/superpowers/plans/2026-05-27-wave1-lane-w-a-fix.md` — 本 plan

## 4. Pre-PR gate

按 CLAUDE.md «Before PR»：

```
pnpm typecheck
pnpm lint
pnpm audit:schema
pnpm audit:partition
pnpm audit:profile
pnpm test
pnpm build
```

全绿 → commit on lane branch (no push). Master coordinator 做 chain-merge。

## 5. Commit / closeout

- Single commit on `lane/w-a-brief-writer-wire`，含 `Closes YUK-99` + `Co-Authored-By: Claude Opus 4.7`.
- Audit doc reference 提 W-01 / W-04 / W-06 三项都解。
- Driver 接收：worktree path + commit SHA + gate 结果。
