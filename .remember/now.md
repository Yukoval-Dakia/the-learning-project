# 当前 handoff — 2026-07-29

## Active line

- Architecture exit 与 Grounding 猜想证据阶段已经收口。
- 当前没有代码 active lane；严格串行停在 YUK-814 的真实 owner 数据输入闸门。
- YUK-814 仍是 Backlog，不能用 synthetic/mock 代替真实盲评数据。

## 本轮完成

1. YUK-788 随 PR #1102 合并，merge commit `ff681b0c`，Linear Done。
   - pending / dismiss cooldown / active accepted / terminal reopen 统一进入 identity history gate；
   - terminal 后只允许同 `cause_category × knowledge_id` 的两条更新 failure 重开；
   - owner accept/edit claim 回流 deterministic 与 agent-led shadow lane；
   - correction、rollback、旧 proposal terminal、新 proposal active 均有反例回归；
   - exact head `83b857b0` 的 CI Gate 全绿、已产出 review thread 清零；review 已收敛到
     P2/minor，按 owner 规则不等待下一轮 OCR。
2. YUK-803 证据化关闭，Linear Backlog → Done。
   - 实现已在 PR #1080 / `a1fe8ab8`：edit archive soft node + live edges，hard 不动；
   - 当前基线实跑 `conjecture-accept.db.test.ts` 21/21。
3. Linear YUK-788、YUK-803、YUK-814 均已写入本轮实证；没有新建重复 follow-up。

## YUK-814 pre-flight 与阻塞

- PASS：Node、pnpm、Docker daemon、Claude Agent SDK、owner 主工作树中的
  `DATABASE_URL`、`CLAUDE_CODE_OAUTH_TOKEN`；未打印任何凭据值。
- FAIL：仓内没有 YUK-814 专属 blind-review dataset / scoring artifact。
- 配置 DB 指向 `127.0.0.1:5433`，当时无服务、无既有 compose volume；试启只创建
  全新空库。临时容器、network、volume 已全部删除，没有留下外部运行状态。
- 事实 blocker 是 6–10 个真实 owner 失败簇的数据来源/导出，不是 provider 凭据。

## 下一步

1. 数据到位后，从真实失败簇构造可复现 shadow packet，并将 YUK-814 置 In Progress。
2. 执行 owner-gold blind review：grounding ≥80%，学科幻觉、claim/probe 错配、
   严重事实错误均为 0；任一红线失败即停。
3. 只有 gate 通过后才启动干预实现与后续 10-run canary。

## Worktree / workflow 状态

- 当前 closeout worktree：
  `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-788-owner-feedback-loop`，
  已切到 `codex/yuk-803-evidence-closeout`，只用于提交 cockpit 收口。
- owner 主工作树 `/Users/yuqi/yukoval-projects/the-learning-project` 在
  `codex/yuk-812-agent-control-plane` 且有既存未提交改动；本轮只做只读 env pre-flight，
  未修改这些文件。
- YUK-817/818 的 5-run CI timing 收数仍是独立后续，不并入 Grounding active lane。
