# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-27
> **【更新 2026-07-27 · Architecture exit 已通过，Grounding 产品阶段开始】**
> Architecture PR #1088 已合并为 `main@6b1beda6`；完整 exit gate 与 CI 通过。
> Grounding 项目已转 In Progress，严格按「真实数据闸门 → 猜想证据 → 干预准备 →
> 延迟/迁移结算 → canary」推进。

## NOW

- **唯一 active 线：Grounding · 猜想证据**
  - Branch：`codex/grounding-intervention-closed-loop`，基于 `main@6b1beda6`。
  - Worktree：
    `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/grounding-intervention-closed-loop`。
  - YUK-799：`ConjectureDraft` 已改为 `proposal | abstain`；proposal 显式携带
    `knowledge_id` 与 `evidence_event_ids`，越界引用计 invalid 反对票。
  - self-consistency：生产 N=3，至少 2 次语义收敛才返回 proposal；provider failure、
    invalid、abstain、分裂聚类均保留在 vote denominator。
  - abstain 由 nightly 持久化为独立 observability event，不写 proposal、不记
    retryable AI failure，成本和 task-run provenance 不丢。
  - YUK-800：`MindModelInductionTask.maxIterations` 1→2；无工具，第二轮只可补完 JSON。
- **验证态**
  - unit：505 files passed / 4 skipped；5759 passed / 33 skipped。
  - DB：387 files；4189 passed / 9 skipped / 1 todo。
  - migration 26/26；typecheck、lint、build、boundary / structured-judge audits 全绿。
- **在飞**
  - Architecture PR #1088 已合并；Architecture 项目 Completed。
  - Product PR #1089 正在独立 review + CI；YUK-799/YUK-800 In Progress。
  - Product branch/worktree 如上；主工作树不在本线写入。

## NEXT

1. 完成 PR #1089 独立 review + CI；合并并关闭 YUK-799/YUK-800。
2. 猜想证据剩余顺序：
   - YUK-804：所有新 probe attempt 持久化不可变题目快照；
   - YUK-787/795：单题 Judge 拆分答题正确性与目标错误复现；首个反证只
     `inconclusive`，第二个未教学独立 probe 才 `falsified`；
   - YUK-788/803：dismiss/reopen/cooldown、prior claim、soft archive/hard 不变。
3. 通过真实 owner 数据闸门 YUK-814 后，才进入 intervention snapshot、
   pedagogy、QuestionAuthor/Verify、隔离 FSRS、结算、Brief/Copilot/profile。

## PARKED

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
