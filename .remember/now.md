# 当前 handoff — 2026-07-29

## Active line

- Architecture exit、Grounding 首切、YUK-804 均已合并。
- 当前唯一 active 线是 YUK-787：
  `codex/grounding-probe-evidence-strength`，PR #1098。
- 已合入 `origin/main@e7155fe5` 的 GitHub CI 并行化及 DB/unit 长尾提速；不在本地
  重复跑 CI gate。

## 当前实现

1. probe route 只把 Judge 粗判映射为 `outcome`；resolution 在 lifecycle 事务内折叠。
2. 首次 incorrect → `evidence_for`；第二个独立 probe incorrect → `confirmed`；
   correct → `retired`。同 conjecture advisory lock 关闭并发竞态。
3. induction/director 同次生成两道 probe；首次 evidence 与 follow-up serve 原子提交。
4. 新结果保存 recurrence rule version 与独立 probe ids；历史 v1 不重解释。
5. Teaching Brief、即时反馈、survival report 与 evidence MCP 明确区分 preliminary / confirmed；
   n=1 不解锁 scoped practice。
6. Agency public reader 折叠 probe result 自身 correction 及 recurrence dependency correction。
7. Teaching Brief、Scout、observability 与 hard-confirm 只消费有效证据；restore 恢复资格。
8. reconcile 对已有 anchor 的 correction 做 typed-state replay；失效证据删除，restore 后恢复。
9. Prep Desk / active cap 在 SQL 中先折 latest correction 再限 3 行；无历史 backlog 扫描。
10. Scout history 使用 `(created_at,id)` keyset、去重、10× scan ceiling 与
    `scan_truncated`，避免 OFFSET 漂移和无界调用。

## 验证与远端

- 变更文件 Biome、`git diff --check` 已通过。
- PR #1098 的已知 review 线程均已逐项回复并解决。
- main 新增 CI 并行 lanes：static/audits、unit、DB、migration、build、usability；
  aggregate 保留 required-check 名称并 fail closed。
- 合并 main 后只监听 GitHub Actions/OCR；不在本地跑完整 CI gate。
- CI 方案说明：`docs/research/2026-07-28-ci-speedup.md`。

## 下一步

1. 推送最新 main merge commit，监听 PR #1098 新一轮 GitHub Actions/OCR；处理新增阻塞项。
2. 全绿后 squash merge，Linear YUK-787 → Done。
3. 严格串行启动 YUK-795 prediction_score / hard-confirm 问责轨。
4. YUK-814 真实 owner 数据 shadow/blind gate 必须单独执行；mock 不能代替。

## CI 测试长尾二次提速（2026-07-29）

- 分支：`codex/yuk-817-ci-test-speedups`（基于 `origin/main@13c2b858`）。
- PR：#1100；GitHub run `30378606905` 全绿，独立 OCR review 的 clean-exit
  timeout classification 发现已修复并 resolve。
- YUK-817：`resetDb()` 的 54 条逐表 TRUNCATE 合为一条 multi-table TRUNCATE；
  CI DB lane 使用 Vitest `--shard=1/2`、`--shard=2/2` matrix，aggregate 仍 fail closed。
- YUK-818：Step9 invariant suite 对 `src/app/scripts` 建一次 immutable source snapshot；
  PfPaper autosave 测试只把 production 800ms timer 映射为 10ms，必须保持 pending
  窗口的 exit/pagehide 用例映射为 100ms；覆盖/断言不减。cold tsx CLI 测试在 full
  suite 的 scheduler contention 下放宽到 20s，隔离运行仍约 2–3s。
- YUK-819：JYEOO 在 POSIX 以独立 process group 启动，timeout kill 整组；新增
  grandchild 与 wrapper 已退出但后代仍持 stdio 的回归用例。Windows 保留 direct-child
  fail-safe。
- 验证：两 DB shards 覆盖 388 files（4,204 passed / 9 skipped / 1 todo）；unit
  509 files（5,781 passed / 33 skipped）；migration 26/26；typecheck、tracked lint、
  schema/dependency/partition/API/profile/copy/draft/hub-sync audits、build 全绿。
- GitHub 首个完整样本：DB shard 6m15s / 5m11s，对比旧 critical path 13m12s；
  unit 2m42s，前一轮 2m14s，对比旧基线 2m16s，未证明 20% median 改善。
- YUK-817/818 必须继续收满 5 次非 docs-only GitHub timing；YUK-819 在 #1100
  合并且 Linux gate 保持绿色后可 Done，当前不虚报 median 提速百分比。
