# 当前 handoff — 2026-07-29

## Active line

- Architecture exit、Grounding 首切、YUK-804 均已合并。
- YUK-787 / YUK-795 已合并并在 Linear Done；main 为 `41fa2a07`。
- 当前唯一 active 线是 YUK-820：
  draft PR #1103（`codex/yuk-820-incremental-gate`），已实现到 Phase 2 unit
  selector required；第一轮 shadow/full-trigger gate 已绿，hard-switch CI 待跑。
- YUK-817/818/819 已 Done；不在本地重复完整 CI gate。

## YUK-820 增量 CI（2026-07-29）

1. `scripts/ci/gate-plan.mjs` 输出六条 lane boolean；unit-test-only、DB-test-only、
   UI、server 可跳无关 lane，global/unknown/base error 与 main push 全量。
2. 20 个历史真实 PR backfill：20/20 affected、0 fallback、19 个直接改动 unit
   test files 0 miss，474/9,661（4.91%），全部 final PR full gate success。
3. `scripts/ci/unit-shadow.mjs` 用 Vitest changed graph + source-scanning sentinels；
   PR 直接执行 affected required，selection 缺失/无效/空集安全 fallback full。
4. main push、global trigger、unknown/base/diff error 继续 full canary；artifact 保存
   selection + execution 元数据。
5. 证据见 `docs/audit/2026-07-29-unit-selector-backfill.md`；final-green backfill 的
   故障注入边界已明示，comparator 负控由 unit tests 固定。

## 下一步

1. 推送 PR #1103 hard-switch commit；workflow/selector self-change 仍是 full trigger。
2. CI/review 全绿后转 ready，merge 后看 main full canary。
3. YUK-814 真实 owner 数据 shadow/blind gate 必须单独执行；mock 不能代替。
