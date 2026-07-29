# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-29
> **【更新 2026-07-29 · YUK-820 20-PR backfill + affected required】**
> PR gate 已从 docs-only 一位开关扩为 fail-closed lane planner；affected unit
> selector 经 20 个历史 PR 回放后已切 required；main/global/fallback 保持全量。

## NOW

- **唯一 active 线：CI/perf · YUK-820**
  - Draft PR #1103：`codex/yuk-820-incremental-gate` → `main@41fa2a07`；
    第一轮 full-trigger gate 与 artifact 已绿，等 hard-switch commit 的 CI。
  - PR 的 unit-test-only / DB-test-only / UI / server 改动按 lane 选择；schema、
    migration、kernel/core、manifest、依赖/测试配置和未知路径全量。
  - main push 永远 full canary；base/diff/classifier 异常同样 fail closed 全量。
  - 20 个历史真实 affected PR：0 fallback、19 个直接改动 unit test files 0 漏选，
    selected/full 累计 474/9,661（4.91%），全部 final PR full gate success。
  - affected unit 使用 `vitest list --changed=<merge-base>` + 源码扫描 sentinels 并
    直接成为 PR required；selection 缺失/无效/空集回退 full。
  - main push、global trigger、unknown/base/diff error 继续 full canary。
- **已收口**
  - YUK-795 / PR #1101 已合入 `main@41fa2a07`，Linear Done。
  - YUK-817/818/819 均已 Done；#1100 的 DB shard、unit 长尾和 JYEOO hard timeout
    修复已在 main。

## NEXT

1. 推送 PR #1103 hard-switch commit，核对 full-trigger run、selector artifact 与
   aggregate fail-closed；本 PR 因修改 workflow/selector 自身仍全量。
2. CI/review 全绿后将 draft 转 ready；merge 后以 main full canary 验证。
3. 再推进 YUK-788/803：dismiss/reopen/cooldown、prior claim、soft archive/hard 不变。
4. 通过真实 owner 数据闸门 YUK-814 后，才进入 intervention snapshot、pedagogy、
   QuestionAuthor/Verify、隔离 FSRS、结算、Brief/Copilot/profile。

## PARKED

- **CI selector drift**：main full canary 或 direct-test guard 任一发现漏选，立即回退
  full required；不靠漂亮 selection ratio 压掉证据。
- **CI 后续调参**：usability artifact 复用、DB weighted shard / fork 数继续以
  GitHub timing 决定，不用删覆盖换漂亮指标。
- **干预准备**：YUK-791/796；Planning Panel 仅为 Teaching Brief 控制区。
- **验证结算**：YUK-792；猜想与干预使用隔离 FSRS 状态，普通 KC/FSRS 不变。
- **协作与档案**：YUK-815 Brief/Copilot public reader；YUK-816 intervention history。
- **发布**：owner shadow/blind review；单 cohort 10-run canary；任一红线失败关闭
  auto-intervention flag。

## BLOCKED-ON

- **干预实现** ← 猜想/probe/Judge 的 v2 证据状态机与 owner 数据门通过。
- **真实数据扩大使用** ← 6–10 失败簇盲评：grounding ≥80%，学科幻觉、
  claim/probe 错配、严重事实错误均为 0。
- **auto-intervention 扩大** ← 单 owner/cohort 10 次 canary 全部事后审阅，红线为 0。
- **真实模型验收** ← owner 数据与 anthropic-sub 运行凭据；不得用 mock 代替。
