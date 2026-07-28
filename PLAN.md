# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-29
> **【更新 2026-07-29 · YUK-795 问责回路待远端验收】**
> YUK-787 已随 PR #1098 合入 main；当前把 prediction_score 接入同一 owner 的
> conjecture identity 生存排序，并让 hard-confirm Tier-1 verdict 进入真实消费者；
> 实现和定向验证已完成，下一步只走 GitHub Actions/OCR gate。

## NOW

- **唯一 active 线：Grounding · 猜想证据 YUK-795**
  - Branch：`codex/yuk-795-accountability-loop`；PR #1101。
  - Worktree：
    `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-795-accountability-loop`。
  - 规则已钉死：score point `>0`=hit、`<0`=miss、`=0`=neutral；连续一条不改变排序；
    连续两条 miss → 0.25×，连续两条 hit → 1.15×；hard flag 开启且 Tier-1
    `EMERGING` → 1.25×。
  - 聚合在同一 owner 的 `(cause_category × knowledge_id)` 身份，跨再归纳保留责任；
    correction 后的失效 probe 不计入 streak。
  - hard-confirm 进入同一 live reader/ranker；hard flag 仍默认 OFF，因为当前 Judge
    尚无诚实 `target_error_match`，且 soft→hard 永远需要 owner 当刻新确认。
  - 纯 fold、correction-aware DB reader、nightly top-K 前排序和 flag-on/fresh-owner
    fail-closed 路径均已有 unit/DB regression。
- **CI 提速已并入**
  - main 已拆 static/audits、unit、DB、migration、build、usability 并行 lanes；
    DB reset 合批并拆为两路 shard，末端 aggregate 保留 required-check 名称并
    fail closed。
  - #1100 首次样本 DB shard 为 6m15s / 5m11s；5 次 median 验收仍由
    YUK-817/818 继续收数，不在本产品线扩张。
  - 按 owner 指示，不在本地重复跑 CI gate；只监听 GitHub Actions。
- **YUK-787 已收口**
  - PR #1098 于 2026-07-29 合并；GitHub CI Gate、OCR 与 CodeQL 全绿，Linear Done。
  - 当前分支基于合并后的 `main@876a501a`。

## NEXT

1. 监听 PR #1101 的 GitHub Actions/OCR；不在本地重复完整 CI gate。
2. 处理远端失败或 review；全绿后合并并将 YUK-795 对齐 Done。
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

- **干预实现** ← 猜想/probe/Judge 的 v2 证据状态机与 owner 数据门通过。
- **真实数据扩大使用** ← 6–10 失败簇盲评：grounding ≥80%，学科幻觉、
  claim/probe 错配、严重事实错误均为 0。
- **auto-intervention 扩大** ← 单 owner/cohort 10 次 canary 全部事后审阅，红线为 0。
- **真实模型验收** ← owner 数据与 anthropic-sub 运行凭据；不得用 mock 代替。
