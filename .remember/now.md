# 当前 handoff — 2026-07-29

## Active line

- 当前代码 active 线是 YUK-820：Ready PR #1103
  （`codex/yuk-820-incremental-gate`）已实现到 Phase 2 affected unit required。
- 正在把 `origin/main@b5bdbe2a` 合入 PR 分支；main 新增 YUK-788/#1102 与
  YUK-803 cockpit 收口，冲突只在 `PLAN.md` / `.remember/now.md`。
- 产品线严格停在 YUK-814 的真实 owner 数据输入闸门；YUK-814 仍为 Backlog，
  不能用 synthetic/mock 代替真实盲评数据。

## YUK-820 增量 CI

1. `scripts/ci/gate-plan.mjs` 输出六条 lane boolean；unit-test-only、DB-test-only、
   UI、server 可跳无关 lane，global/unknown/base error 与 main push 全量。
2. 20 个历史真实 PR backfill：20/20 affected、0 fallback、19 个直接改动 unit
   test files 0 miss，474/9,661（4.91%），全部 final PR full gate success。
3. `scripts/ci/unit-shadow.mjs` 用 Vitest changed graph + source-scanning sentinels；
   PR 直接执行 affected required，selection 缺失/无效/空集安全 fallback full。
4. direct-test inventory guard 会在直接改动的 unit test 未入选时强制 full；
   main push、global trigger、unknown/base/diff error 同样 full canary。
5. 证据见 `docs/audit/2026-07-29-unit-selector-backfill.md`；final-green backfill 的
   故障注入边界已明示，comparator 负控由 unit tests 固定。
6. 手动 full Gate run `30428189107` 全绿；其 `unit-selector-report` 确认
   `required_mode=full`、退出码 0。当前 head 合并 main 后仍需 PR-attached CI。

## Grounding 收口与阻塞

- YUK-788 随 PR #1102 / merge commit `ff681b0c` 合并并 Linear Done；
  identity history gate、terminal reopen 约束与 owner feedback 回流均有回归证据。
- YUK-803 的 soft archive/hard 不变已在 PR #1080 / `a1fe8ab8` 落地；
  `conjecture-accept.db.test.ts` 21/21，Linear Done。
- YUK-814 环境 pre-flight 已通过；事实 blocker 是 6–10 个真实 owner 失败簇的
  数据来源/导出，不是 provider 凭据。

## 下一步

1. 完成 merge commit，跑 focused tests、typecheck、targeted Biome、YAML parse、
   partition audit 后推送。
2. 等 PR #1103 当前 head full-trigger CI；检查 selector artifact 与 review threads。
3. CI/review 全绿后合并，检查 main full canary，并将 YUK-820/Linear/cockpit 收口。
4. YUK-814 数据到位后才启动 shadow/blind gate；任一红线失败即停。

## Worktree / workflow 状态

- 当前 worktree：`/Users/yuqi/.codex/worktrees/9a32/the-learning-project`，
  branch `codex/yuk-820-incremental-gate`。
- owner 主工作树及其既存改动不在本轮修改作用域。
