# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-29
> **【更新 2026-07-29 · YUK-820 affected required + Grounding 等待真实数据】**
> 20 个历史 PR backfill 已支持把 affected unit selector 切为 required；同时，
> Grounding 产品线仍严格停在 YUK-814 的真实 owner 数据闸门，不以 mock 代替。

## NOW

- **当前代码 active 线：CI/perf · YUK-820**
  - Ready PR #1103：`codex/yuk-820-incremental-gate` 正在合并
    `origin/main@b5bdbe2a`；手动 full Gate run `30428189107` 已全绿。
  - PR 的 unit-test-only / DB-test-only / UI / server 改动按 lane 选择；schema、
    migration、kernel/core、manifest、依赖、workflow/selector、测试配置和未知路径全量。
  - 20 个历史真实 affected PR：20/20 affected、0 fallback、20 个直接改动 unit test
    files 0 漏选，selected/full 累计 1,120/9,639（11.62%）；全部 final PR full gate
    success；#1059 额外验证空 import graph 会 fail closed 到 full。
  - affected unit 使用 Vitest changed graph + 自动发现的源码扫描 tests，并直接成为
    PR required；
    selection 缺失/无效/空集、base/diff/classifier 异常或 direct-test guard 失败均回退 full。
  - main push 永远 full canary；artifact 保存 selection 与 required execution 元数据。
- **产品线：YUK-814 保持 Backlog，等待真实数据输入**
  - Node、pnpm、Docker、Claude Agent SDK、`DATABASE_URL` 与 anthropic-sub OAuth token
    已做不泄密 pre-flight；凭据不是 blocker。
  - 仓内没有 YUK-814 专属盲评数据集/评分 artifact；需要 6–10 个真实 owner 失败簇，
    不能用 synthetic/mock 冒充。
- **已收口**
  - YUK-788 随 PR #1102 / `ff681b0c` 合并并 Done；identity history gate、terminal
    reopen 约束与 owner feedback 回流均有回归证据。
  - YUK-803 的 soft archive/hard 不变已在 PR #1080 / `a1fe8ab8` 落地，
    `conjecture-accept.db.test.ts` 21/21，Linear Done。
  - YUK-817/818/819 均已 Done；DB shard、unit 长尾与 JYEOO hard timeout 修复已在 main。

## NEXT

1. 完成 PR #1103 与最新 main 的合并，推送后核对当前 head 的 full-trigger CI、
   selector artifact 与 aggregate fail-closed。
2. 检查并处理 active review threads；当前 head CI/review 全绿后合并，随后检查
   main full canary，并将 YUK-820 与 cockpit/Linear 对齐收口。
3. 为 YUK-814 提供/导出 6–10 个真实 owner 失败簇；数据到位后先 shadow run，
   再做 owner gold blind review。
4. 只有 YUK-814 达到 grounding ≥80%，且学科幻觉、claim/probe 错配、严重事实错误
   均为 0，才依次启动 intervention snapshot、pedagogy、QuestionAuthor/Verify、
   隔离 FSRS、结算、Brief/Copilot/profile。

## PARKED

- **CI selector drift**：main full canary 或 direct-test guard 任一发现漏选，立即回退
  full required；不靠漂亮 selection ratio 压掉证据。
- **CI 后续调参**：usability artifact 复用、DB weighted shard / fork 数继续以
  GitHub timing 决定，不用删覆盖换漂亮指标。
- **干预准备**：YUK-791/796；Planning Panel 仅为 Teaching Brief 控制区。
- **验证结算**：YUK-792；猜想与干预使用隔离 FSRS 状态，普通 KC/FSRS 不变。
- **协作与档案**：YUK-815 Brief/Copilot public reader；YUK-816 intervention history。
- **发布**：YUK-814 通过后才做单 owner/cohort 10-run canary；任一红线失败关闭
  auto-intervention flag。

## BLOCKED-ON

- **YUK-814 shadow/blind gate** ← 6–10 个真实 owner 失败簇的数据来源/导出；
  anthropic-sub 与本机工具链 pre-flight 已通过。
- **干预实现** ← YUK-814 grounding blind review 通过；不得先写产品状态机绕过门。
- **auto-intervention 扩大** ← 单 owner/cohort 10 次 canary 全部事后审阅，红线为 0。
