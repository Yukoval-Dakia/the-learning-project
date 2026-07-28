# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-29
> **【更新 2026-07-29 · YUK-787 最终收口】**
> main 已合入 CI 并行化及 DB/unit 长尾提速；YUK-787 已完成二次独立 probe、递归
> 证据 correction fold 与 projection repair，正在等待最新 main 上的最终 Actions/OCR。

## NOW

- **唯一 active 线：Grounding · 猜想证据 YUK-787**
  - Branch：`codex/grounding-probe-evidence-strength`；PR #1098。
  - Worktree：
    `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/grounding-intervention-closed-loop`。
  - 首次 incorrect 为 `evidence_for`；第二个独立 probe 才 `confirmed`；correct 为
    `retired`。同 conjecture advisory lock 关闭并发越门。
  - 两道 probe 由 induction/director 同次预生成；首次 evidence 与第二题 serve 原子提交。
  - 新结果持久化 rule version 与独立 probe ids；历史 v1 保留旧规则且不批量重解释。
  - correction 现在级联到 recurrence dependency：Teaching Brief、Scout、observability、
    hard-confirm 与 typed projection 均不再消费失效证据；restore 可重放恢复。
  - Prep Desk 与 serve cap 在 SQL 中先折 latest correction，再做 3-row bound；Scout 用
    keyset + scan ceiling，返回 `scan_truncated`。
- **CI 提速已并入**
  - main 已拆 static/audits、unit、DB、migration、build、usability 并行 lanes；
    DB reset 合批并拆为两路 shard，末端 aggregate 保留 required-check 名称并
    fail closed。
  - #1100 首次样本 DB shard 为 6m15s / 5m11s；5 次 median 验收仍由
    YUK-817/818 继续收数，不在本产品线扩张。
  - 按 owner 指示，不在本地重复跑 CI gate；只监听 GitHub Actions。
- **当前验证态**
  - 变更文件 Biome 与 `git diff --check` 已通过。
  - PR review 线程已逐项回复并解决；合入最新 main 后等待新一轮 CI/OCR。

## NEXT

1. PR #1098 最终 Actions/OCR 全绿后合并，Linear YUK-787 对齐 Done。
2. 严格串行启动 YUK-795：prediction_score / hard-confirm 真正影响 conjecture 命运。
3. 再推进 YUK-788/803：dismiss/reopen/cooldown、prior claim、soft archive/hard 不变。
4. 通过真实 owner 数据闸门 YUK-814 后，才进入 intervention snapshot、pedagogy、
   QuestionAuthor/Verify、隔离 FSRS、结算、Brief/Copilot/profile。

## PARKED

- **CI 后续调参**：只在 5 次非 docs-only GitHub timing 证明仍有必要时评估
  usability artifact 复用、DB 4-way shard 或 fork 数；不做 path-aware 测试跳过。
- **干预准备**：YUK-791/796；Planning Panel 仅为 Teaching Brief 控制区。
- **验证结算**：YUK-792；猜想与干预使用隔离 FSRS 状态，普通 KC/FSRS 不变。
- **协作与档案**：YUK-815 Brief/Copilot public reader；YUK-816 intervention history。
- **发布**：owner shadow/blind review；单 cohort 10-run canary；任一红线失败关闭
  auto-intervention flag。

## BLOCKED-ON

- **YUK-795** ← YUK-787 PR #1098 合并并 Done。
- **干预实现** ← 猜想/probe/Judge 的 v2 证据状态机与 owner 数据门通过。
- **真实数据扩大使用** ← 6–10 失败簇盲评：grounding ≥80%，学科幻觉、
  claim/probe 错配、严重事实错误均为 0。
- **auto-intervention 扩大** ← 单 owner/cohort 10 次 canary 全部事后审阅，红线为 0。
- **真实模型验收** ← owner 数据与 anthropic-sub 运行凭据；不得用 mock 代替。
