# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-29
> **【更新 2026-07-29 · YUK-820：DB affected gate 已合并，等待 live timing】**
> 真实 failed-head 回放确认 unit 21/21 捕获；同代码 PR/main 对照确认 unit 已降时但
> DB 仍是 354–355 秒关键路径。DB selector 已完成 20 个真实失败 run backfill，
> 初版 2 miss 已固化为 failure sentinels，最终 20/20 捕获；PR #1109 已合并。

## NOW

- **YUK-820 active：实现已合并，等待首条普通 server/API PR live acceptance**
  - PR #1109 / squash `1df65fd7` 已合并；final head CI Gate `30452431101` 全绿，
    13 个 review threads 已清零。
  - unit 真实失败 head：21/21 捕获，覆盖 18 PR；此前 3 个表面 miss 均为 DB partition。
  - #1108 PR/main 同代码对照：unit step 132→41s，但 DB job 仍约 355s，wall 394/404s；
    所以 owner 看到“没变短多少”属实，根因是 DB critical path 未增量。
  - DB 真实失败 head：20/20 捕获，覆盖 15 PR；纯 graph 初版 18/20，`quiz_gen.test.ts`
    与 `propose_edge.db.test.ts` 两个 out-of-graph reds 已成为 required sentinels。
  - exact #1108 tree：最终 selector 195/390 DB files；其 181-file 前序集合两 shard
    91+90 files、2,349 tests 全绿；新增 dynamic-import sentinels 由 full suite 覆盖；
    本机并发容器时间不冒充 GitHub runner 节省值。
  - main 已有 `db_selection`，selector/direct guard/source scan/dynamic import/failure
    sentinels/full fallback/empty-shard skip/artifacts 均已接入；两个 DB shards 共用前置
    job 生成的同一份 selection，杜绝瞬时 selector 分歧造成覆盖空洞。
  - #1109 因触及 CI 自身按设计 full：DB shard 测试 323.9s / 904.8s；第二 shard 是
    相对同代码历史约 326s 的极端长尾，不能冒充 affected 提速证据，也不归因于 selector。
- **YUK-814 保持 In Progress，停在真实数据输入闸门**
  - Harness 已随 PR #1105 / merge commit `ae02e020` 落到 main；真实 shadow/blind/canary
    尚未执行，仍需 production backup ZIP / 6–10 个合格真实 owner 失败簇。
- **近期已收口**
  - YUK-788 已随 PR #1102 / `ff681b0c` 合并并 Done；YUK-817/818/819 已 Done。

## NEXT

1. 下一条普通 server/API PR 读取 DB selector artifacts 与 GitHub job timing，验收真实
   wall-clock；本 selector PR 与 main canary 因触及 CI 自身必须 full，不能冒充 affected 样本。
2. YUK-814 获得 production backup 后按 inspect → shadow → blind → score 执行；不足 6 个
   eligible failure clusters 就继续积累，不用 synthetic/mock 代替。

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

- **YUK-814 真实执行** ← production backup ZIP / 6–10 个合格真实 owner 失败簇；
  harness、anthropic-sub 与本机工具链已就绪。
- **干预实现** ← YUK-814 grounding blind review 通过；不得先写产品状态机绕过门。
- **auto-intervention 扩大** ← 单 owner/cohort 10 次 canary 全部事后审阅，红线为 0。
