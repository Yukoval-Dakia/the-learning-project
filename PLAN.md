# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
> 更新于：2026-07-28
> **【更新 2026-07-28 · 单次探针不再冒充确证】**
> Architecture、Grounding 首切及 YUK-804（PR #1097）均已合并。当前只推进
> YUK-787；YUK-795 与干预实现保持未启动。

## NOW

- **唯一 active 线：Grounding · 猜想证据**
  - Branch：`codex/grounding-probe-evidence-strength`，基于 `main@96579dfa`。
  - Worktree：
    `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/grounding-intervention-closed-loop`。
  - YUK-787：Judge 只产出 `outcome`；事务内纯 fold 读取同 conjecture 的历史
    `probe_result`，首次 incorrect 为 `evidence_for`，第二个独立 probe 才
    `confirmed`，correct 仍为 `retired`。
  - 同 conjecture 写入有独立 advisory lock；并发两个 probe 只允许一个越过确证门。
    新事件带 rule version 与参与判定的 probe ids；旧 confirmed 原样 replay。
  - Teaching Brief、即时答题反馈、evidence MCP 与生存报告均区分 preliminary /
    confirmed；n=1 不解锁 KC 专项练习。
  - 两道独立 probe 由 induction/director 同次预生成；首次 `evidence_for` 与第二题
    serve 同事务提交，生产路径可真正到达 `confirmed`，旧 proposal 缺第二题时失败关闭。
  - 备课台 discriminating 标签已从绝对断言降为“尝试区分这一猜想的题”。
- **验证态**
  - 原提交 unit：506 files passed / 4 skipped；5788 passed / 33 skipped；review
    follow-up 定向 unit 206/206。
  - 定向 DB：140/140；完整 DB gate 改由 GitHub Actions 判定，本地不再重复跑。
  - migration 26/26；typecheck、lint、build、boundary/API audits 全绿。
  - `audit:projection` 在迁移后的临时 Postgres 上为 0 drift。
- **在飞**
  - YUK-787 PR #1098 已处理首轮 review；生产 follow-up seam 修复待 push 后重新监听
    独立 review 与 GitHub CI gate。
  - Product branch/worktree 如上；owner-dirty 主工作树不在本线写入。

## NEXT

1. 提交 YUK-787 PR，监听 GitHub Actions，完成独立 review + CI；合并后将
   YUK-787 对齐 Done。
2. 猜想证据后续顺序：
   - YUK-795：prediction_score / hard-confirm 真正影响 conjecture 命运；
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
