# 当前 handoff — 2026-07-29

## Active line

- Architecture exit 与 Grounding 猜想证据阶段已经收口。
- 当前唯一代码 active lane 是 YUK-814 离线闸门 harness：
  `codex/yuk-814-grounding-gate`。
- YUK-814 已是 In Progress；真实 shadow/blind/canary 仍停在 owner 数据输入闸门，
  不能用 synthetic/mock 代替。

## YUK-814 已构建

1. `pnpm grounding:gate inspect|shadow` 读取 Loom backup ZIP，只恢复到自动删除的
   pgvector Testcontainer；不读取用户 `DATABASE_URL`，不写生产 proposal/event。
2. 候选链复用生产 failure correction fold、cause×KC recurrence、pending/history/
   accountability gate、不可变 evidence enrichment 与图片上限；额外硬排除
   `payload.__synthetic=true` 和 `synthetic:*`。
3. deterministic backup-hash sampling 选 6–10 簇；blind review 与 private lineage 分目录，
   盲评文件不含 event/question/KC/task-run ids，图片保留 question/parent/answer 角色。
4. `score-blind` 仅在所有 owner labels 完整、grounding ≥80%、学科幻觉/
   claim-probe mismatch/严重事实错误均为 0 时 PASS。
5. `init-canary` 只接受 blind PASS；canary score 要求同一 owner/cohort、10 个不同真实
   intervention、全部事后审阅、监控 refs、停机演练与零红线。

## 验证

- synthetic harness smoke（非 gate 证据）：backup restore 后 12 failures → 6 eligible，
  输出明确 `gate_passed=false`；凭据缺失时 shadow 在启容器前 fail。
- unit：512 files / 5,824 passed / 33 skipped；新增 pure gate tests 8/8。
- DB：390 files / 4,263 passed / 9 skipped / 1 todo；新增生产读链 test 1/1。
- migration 26/26；typecheck、lint、schema/partition/profile/draft、完整 `pnpm test`、
  Vite + server/worker/migrate build 全绿。
- 所有 Testcontainer 已退出；仓内没有 raw backup、shadow packet 或真实 owner 数据。

## 下一步

1. 提交 PR，听独立 review + CI Gate；合并只代表 harness ready，YUK-814 不 Done。
2. 用 production `/api/_/export?include_assets=1` 获取 backup，先跑 inspect；
   eligibility 不足 6 则继续积累真实使用，不制造错误。
3. eligibility 满足后 shadow → owner blind review → score；任一红线失败即停。
4. 只有 blind PASS 后才启动干预实现与后续 10-run canary。

## Worktree / workflow 状态

- 当前 worktree：
  `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-814-grounding-gate`，
  branch `codex/yuk-814-grounding-gate`。
- owner 主工作树 `/Users/yuqi/yukoval-projects/the-learning-project` 在
  `codex/yuk-812-agent-control-plane` 且有既存未提交改动；本轮只做只读 env pre-flight，
  未修改这些文件。
- YUK-817/818 的 5-run CI timing 收数仍是独立后续，不并入 Grounding active lane。
