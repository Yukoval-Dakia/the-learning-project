# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-29
> **【更新 2026-07-29 · YUK-823：TypeScript 7 GA 性能收口待 PR live cache 验收】**
> main 已是 TS7 native compiler；本线补齐官方 TS7 + TS6 side-by-side、native watch
> 与跨 CI run 的增量 buildinfo。实测默认 4 checkers 最优，不盲目加核。

## NOW

- **YUK-823 active：实现与本地 full gate 已通过，等待 PR CI cache 冷/热对照**
  - TS7 full median 5.73s，TS6 fallback 33.41s（5.83x）；TS7 cold buildinfo 5.32s，
    warm median 0.584s（9.12x）。
  - `@typescript/native` 提供 TS7 `tsc`；`typescript` 官方 alias 到
    `@typescript/typescript6`，`typecheck:legacy` 现为真实 `tsc6` 且不污染 TS7 cache。
  - `typecheck:watch` 已接 TS7 native watcher；CI static lane 以 compiler/config +
    commit key 缓存 `tsconfig.tsbuildinfo`，可从最新兼容状态增量恢复。
  - 默认/1/2/4/6/8/10 checkers 三轮实测中，固定 4 最快；维持 TS7 默认值，避免高核
    配置在本机和小型 CI runner 上增加重复工作与内存。
  - full pre-PR：TS7/TS6 typecheck、lint、standalone audits、5,891 unit tests、
    4,263 DB tests、26 migration tests 与 build 全绿。
- **YUK-820 保持 In Progress：实现已合并，等待首条普通 server/API PR live acceptance**
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

1. YUK-823 开 PR；记录首次 cold cache miss 与同一 head rerun cache hit 的 Typecheck
   step timing，确认 cache restore/save 后再 merge。
2. 下一条普通 server/API PR 读取 DB selector artifacts 与 GitHub job timing，验收真实
   wall-clock；本 selector PR 与 main canary 因触及 CI 自身必须 full，不能冒充 affected 样本。
3. YUK-814 获得 production backup 后按 inspect → shadow → blind → score 执行；不足 6 个
   eligible failure clusters 就继续积累，不用 synthetic/mock 代替。

## PARKED

- **YUK-824 本地 lint 假红**：Biome 精确忽略 sanctioned `.ykv/**` code-index cache；
  不扩大 `files.maxSize`，不混入 YUK-823。
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
