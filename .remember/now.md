# 当前 handoff — 2026-07-29

## Active line

- Architecture exit 与 Grounding 猜想证据阶段已经收口。
- 当前唯一代码 active lane 是 YUK-814 离线闸门 harness：PR #1105，branch
  `codex/yuk-814-grounding-gate`。
- YUK-814 已是 In Progress；真实 shadow/blind/canary 仍停在 owner 数据输入闸门，
  不能用 synthetic/mock 代替。
- YUK-820 已随 PR #1103 / `7dd15a8e` 落到 main，不再是 active lane。

## YUK-814 已构建

1. `pnpm grounding:gate inspect|shadow` 读取 Loom backup ZIP，只恢复到自动删除的
   pgvector Testcontainer；不读取用户 `DATABASE_URL`，不写生产 proposal/event。
2. 候选链复用生产 failure correction fold、cause×KC recurrence、pending/history/
   accountability gate、不可变 evidence enrichment 与图片上限；额外硬排除
   `payload.__synthetic=true` 和 `synthetic:*`。
3. deterministic backup-hash sampling 选 6–10 簇；blind review 与 private lineage 分目录，
   盲评文件不含 event/question/KC/task-run ids，图片保留 question/parent/answer 角色。
4. blind packet 固定 requested count 与 selection SHA-256；删项/改 evidence、provider
   global override、dirty worktree 都 fail closed。所有 owner labels 完整、grounding ≥80%、
   学科幻觉/claim-probe mismatch/严重事实错误均为 0 才 PASS。
5. `init-canary` 只接受 blind PASS；canary score 要求同一 owner/cohort、10 个不同真实
   intervention、全部事后审阅、监控 refs、停机演练与零红线。

## 验证

- synthetic harness smoke（非 gate 证据）：backup restore 后 12 failures → 6 eligible，
  输出明确 `gate_passed=false`；凭据或 provider lane 配置不符时在启容器前 fail。
- 初始 full pre-PR：unit 512 files / 5,824 passed / 33 skipped；DB 390 files /
  4,263 passed / 9 skipped / 1 todo；migration 26/26；typecheck、lint、audits、
  完整 `pnpm test` 与 build 全绿。
- review fixes：grounding artifacts + provider preflight targeted unit 17/17；candidate DB
  regression 1/1；typecheck、partition audit、build 与 clean-revision smoke 全绿。
- PR #1105 pre-merge head `4f3bf05e` 的 CI Gate 全绿、active review threads 0；随后因
  main 新合入 YUK-820 产生 cockpit 冲突，已按两条线真实状态合并，需听新 head CI Gate。
- 所有 Testcontainer 已退出；raw backup、shadow packet 与真实 owner 数据均未提交到版本库。
  本轮收尾时明确检查本 worktree 的 `.tmp/yuk-814/` 为空；后续 gitignored 制品仍须
  按 runbook 单独核查与清理，不能从 git 状态推断不存在。

## 下一步

1. 推送 main merge commit；只听 PR #1105 新 head CI Gate。active thread 保持为 0 后合并；
   harness 合并不等于 YUK-814 完成。
2. 用 production `/api/_/export?include_assets=1` 获取 backup，先跑 inspect；
   eligibility 不足 6 就继续积累真实使用，不制造错误。
3. eligibility 满足后 shadow → owner blind review → score；任一红线失败即停。
4. 只有 blind PASS 后才启动干预实现与后续 10-run canary。

## Worktree / workflow 状态

- 当前 worktree：
  `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/yuk-814-grounding-gate`，
  branch `codex/yuk-814-grounding-gate`。
- owner 主工作树 `/Users/yuqi/yukoval-projects/the-learning-project` 在
  `codex/yuk-812-agent-control-plane` 且有既存未提交改动；本轮未修改这些文件。
