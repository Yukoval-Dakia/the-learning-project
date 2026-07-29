# 当前 handoff — 2026-07-29

## Active line

- YUK-820 已从 closeout 重新进入 In Progress：owner 指出 CI wall-clock 几乎未缩短，
  真实同代码对照确认 unit affected 生效但 DB 仍是关键路径。
- 当前 branch `codex/yuk-820-failure-backfill` 已实现 fail-closed DB affected selector，
  full pre-PR 与独立 review 已通过，待 PR/CI/merge。
- YUK-814 harness 已随 PR #1105 落到 main；真实 shadow/blind/canary 仍停在 production
  backup / 6–10 个合格真实 owner 失败簇输入闸门，不用 synthetic/mock 代替。

## YUK-820 当前证据

1. Unit 真实失败 head 回放：21/21 捕获，覆盖 18 PR；20 affected、1 full fallback。
   早先 3 个表面 unit miss 经历史 inventory 证明均属于 DB partition。
2. PR #1108 affected run `30447000426` 对 main full run `30447542212`：unit step
   132→41s（-69%），runner time 1,070→905s（-15.4%），但 DB job 仍约 355s，
   wall 394/404s；所以 owner 的观察成立。
3. DB 真实失败 head 回放：20/20 捕获，覆盖 15 PR；纯 graph 初版 18/20，两个真实
   out-of-graph failures `quiz_gen.test.ts` / `propose_edge.db.test.ts` 已固化为 failure
   sentinels，重放后 0 miss。
4. #1108 exact tree：最终 selector 195/390 DB files；其 181-file 前序集合已跑两 shards，
   1,219+1,130 tests 全绿（另 3+6 skipped）；新增 dynamic-import sentinels 由 full suite 覆盖。
   本机并发 Testcontainers wall 不冒充
   GitHub runner 的节省值。

## 实现

- `gate-plan.mjs` / workflow 新增 `db_selection=skip|affected|full`。
- `scripts/ci/db-affected.mjs`：Vitest changed graph + full historical inventory、direct-test
  guard、source-scanning/dynamic-import tests、failure sentinels、unsafe/empty/error full fallback、safe argv、
  empty-shard skip、per-shard execution artifacts。
- main push、schema/migration/config/workflow/kernel/core/unknown 与 selector 自身改动继续 full。
- 证据文档：
  - `docs/audit/2026-07-29-unit-selector-backfill.md`
  - `docs/audit/2026-07-29-db-selector-failed-head-backfill.md`

## 下一步

1. PR required CI 全绿后 merge；本 PR 和 main canary 都因触及 CI 自身必须 full。
2. 下一条普通 server/API PR 用 DB selector artifacts + GitHub job timing 验收真实 wall。

## Worktree / workflow 状态

- 当前 worktree：`/Users/yuqi/.codex/worktrees/9a32/the-learning-project`。
- owner 主工作树仍在 `codex/yuk-812-agent-control-plane` 且有既存改动；本轮未触碰。
- 临时 replay worktrees 已清理；Testcontainers 已退出。
- full pre-PR：390 DB files / 4,263 tests、migration 26/26、build、lint、typecheck、
  focused 36/36 全通过；independent `codex review --uncommitted` 无 finding。
