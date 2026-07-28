# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-28
> **【更新 2026-07-28 · 猜想证据进入不可变题面快照切片】**
> Architecture PR #1088 与 Grounding 首切 PR #1089 已合并；YUK-799/YUK-800
> 已 Done。当前只推进 YUK-804，干预实现继续受真实数据闸门约束。

## NOW

- **唯一 active 线：Grounding · 猜想证据**
  - Branch：`codex/grounding-question-snapshots`，基于 `main@0966e1a1`。
  - Worktree：
    `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/grounding-intervention-closed-loop`。
  - YUK-804：新 attempt event 持久化最小不可变题目证据快照；question part 同时
    冻结 shared parent，缺失 parent 失败关闭。
  - Practice 持有快照读取端口；Ingestion 只经 `public.ts` 调用。四条生产 attempt
    写路径全部落快照，历史事件保持可解析。
  - 失败投影只接受 snapshot question id 与 event subject 一致的数据；新事件归纳
    只读快照，题面编辑后不再把新题面与旧错答配对。
  - legacy attempt/review 无快照时保持保守降级：题目或 parent 已变更即不进入证据包。
- **验证态**
  - unit：505 files passed / 4 skipped；5779 passed / 33 skipped。
  - DB：388 files；4201 passed / 9 skipped / 1 todo。
  - migration 26/26；typecheck、lint、build、boundary / API contract audits 全绿。
- **在飞**
  - YUK-804 已完成本地 pre-PR gate，待 commit、PR、独立 review 与 CI。
  - Product branch/worktree 如上；owner-dirty 主工作树不在本线写入。

## NEXT

1. 提交 YUK-804 PR，完成独立 review + CI；合并后将 YUK-804 对齐 Done。
2. 猜想证据后续顺序：
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
