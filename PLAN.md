# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-28
> **【更新 2026-07-28 · GitHub CI 并行化落地】**
> CI gate 已拆 static/audits、unit、DB、migration、build、usability 并行 lanes；
> aggregate 保留原 required-check 名称，不要求本地跑 CI、不减覆盖。

## NOW

- **Grounding · 猜想证据首切已落 main**
  - YUK-804 / PR #1097 已合并为 `main@96579df`：attempt-time question evidence
    snapshot、shared-parent fail-close、mutable-row legacy 保守降级均已落地。
  - 下一产品 slice 仍是 YUK-787/795（二次独立 probe + target-error-aware Judge）；
    尚未因本次 CI 研究启动实现。
- **CI 提速**
  - GitHub workflow 已完成并行化；docs-only 判定收敛为单一 fail-closed `changes` job。
  - 待本 PR GitHub Actions 首跑验证 lane 结果与 required aggregate；无需本地复跑 CI。

## NEXT

1. 猜想证据后续顺序：
   - YUK-787/795：单题 Judge 拆分答题正确性与目标错误复现；首个反证只
     `inconclusive`，第二个未教学独立 probe 才 `falsified`；
   - YUK-788/803：dismiss/reopen/cooldown、prior claim、soft archive/hard 不变。
2. 通过真实 owner 数据闸门 YUK-814 后，才进入 intervention snapshot、
   pedagogy、QuestionAuthor/Verify、隔离 FSRS、结算、Brief/Copilot/profile。

## PARKED

- **CI 二次提速**：usability artifact 复用与 DB fork 调参等 GitHub timing 后再决定；
  不做 path-aware 测试跳过。
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
