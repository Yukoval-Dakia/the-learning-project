# 当前 handoff — 2026-08-02 Architecture Deepening FULL / YUK-840

## Owner direction and tracker

- Owner 明确：「直接启动 FULL」。
- Linear project：`Architecture Deepening FULL — 语义、成本与运行所有权`（In Progress）。
- F0 milestone `Truth, contracts, ratchets`：
  - YUK-840 In Progress：phase spec + 双向 dependency ratchet；
  - YUK-841 Todo / blocked by YUK-840：AI attempt 单一成本真相；
  - YUK-842 Todo / blocked by YUK-841：跨进程 provider-lane admission。
- YUK-767 已记录 owner 信号升级；多用户 schema/auth 保持独立范围。

## Active checkout

- worktree：`/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-840-full-f0`
- branch：`codex/yuk-840-full-f0`
- base：`origin/main@19a97b893dfc9aae62701f00451010fd2be71c7b`
- 原 checkout `codex/yuk-812-agent-control-plane` 的脏改与其它 worktree 均未触碰。

## YUK-840 local implementation

- ADR-0051：capability owns product operation；AI runtime owns model attempt；静态 modular monolith
  保持；首个竖切为 practice-owned failure learning。
- Phase 0/1 execution addendum：锁定 F0 串行依赖、Phase 1 current/target/delete map、exit gates 与
  out-of-scope。
- `audit:capability-boundaries` 已从单向 access seam 加深为同一 AST scan：
  - capability→server 538 semantic edges；
  - server→capability deep 70；
  - cross-capability value 63；
  - nontrivial SCC = agency/ingestion/knowledge/notes/practice。
- baseline 是约 140 个 owner-pair 桶，不是逐 import allowlist；actual 必须与 baseline 精确一致。
  增长失败；下降也要求同一 diff 收紧 baseline，防止留下回涨 headroom。
- parser 区分 type/value，alias/relative 归一化；mixed/side-effect/literal dynamic/require 是 value；
  non-literal dynamic import/require fail closed。
- package 增加 print-only `audit:capability-boundaries:snapshot`；默认 CI audit 名称不变。

## Validation so far

- `pnpm audit:capability-boundaries`：PASS，538 / 70 / 63 exact。
- `pnpm vitest run --config vitest.unit.config.ts scripts/audit-capability-boundaries.test.ts`：
  1 file / 10 tests PASS。
- owner 提醒前已完成 typecheck、全仓 lint 与 build，均 PASS。
- **Owner 追加指示：gate 不要在本地跑。** 此后不再重跑本地 gate；完整验证只交给
  exact-head GitHub CI。
- 两路独立只读 review 发现并已修复 1 类 P1：nested `public/ui-public/manifest`
  子路径不得伪装成 top-level entrypoint。修复后两位 reviewer 都确认无未解决
  P0/P1。
- 新增 server→capability deep、无 SCC 的单向 cross-capability value 与三类 nested
  entrypoint characterization；移除 unit suite 内重复的全仓 baseline scan。这些 review 后改动
  **没有在本地跑 gate**，由 exact-head CI 验证。

## Still required before delivery

1. commit/push/open PR；由 exact-head GitHub CI 执行完整 gate，绿后才能将 YUK-840 标 Done。
2. Linear capture gate：review 未留下 P0/P1；重复 AST parse 仅为 P2 经济性建议且已通过
   移除重复 repo scan 缩小开销，不新建 follow-up。

## Displaced but still open

- YUK-596 transport/Stop 与 30-case burn-in 已交付；内容质量仍 HOLD。
- YUK-832–836 保持 open/PARKED，未因 FULL 启动而取消、完成或降级。
- FULL 当前不触 UI；任何后续 UI 仍需 owner design pre-flight 批准。
