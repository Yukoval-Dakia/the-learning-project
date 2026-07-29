# 当前 handoff — 2026-07-29

## Active line

- Architecture exit、Grounding 首切、YUK-804 均已合并。
- YUK-787 / YUK-795 已合并并在 Linear Done；main 为 `41fa2a07`。
- 当前唯一 active 线是 YUK-820：
  draft PR #1103（`codex/yuk-820-incremental-gate`），已实现到 Phase 2 unit
  selector shadow，等 GitHub full-trigger gate 与 artifact。
- YUK-817/818/819 已 Done；不在本地重复完整 CI gate。

## YUK-820 增量 CI（2026-07-29）

1. `scripts/ci/gate-plan.mjs` 输出六条 lane boolean；unit-test-only、DB-test-only、
   UI、server 可跳无关 lane，global/unknown/base error 与 main push 全量。
2. `scripts/ci/unit-shadow.mjs` 用 Vitest changed graph 预测 affected files，合并
   source-scanning sentinels；selector failure 安全 fallback full。
3. required unit 继续执行 full suite 一次，同时写 JSON；shadow 只对账 full failure
   outside selection、直接改动 test miss 与 selection ratio。
4. step summary + `unit-selector-shadow` compact artifact 留证；selector/comparator
   nonblocking，full unit exit code保持硬 gate。
5. 本地已通过 21 条定向 unit、typecheck、audit:partition、audit:dependencies、
   workflow YAML parse、定向 Biome；`pnpm lint` 仅被本机未跟踪 `.ykv` 索引阻塞。
6. 方案与 shadow 语义见 `docs/research/2026-07-28-ci-speedup.md`；本阶段绝不把
   affected set 设为 required。

## 下一步

1. 等 PR #1103 在 GitHub 全量验证；workflow/selector self-change 是 full trigger。
2. 收至少 20 个混合 PR shadow artifact，零漏选前不 hard switch。
3. YUK-814 真实 owner 数据 shadow/blind gate 必须单独执行；mock 不能代替。
