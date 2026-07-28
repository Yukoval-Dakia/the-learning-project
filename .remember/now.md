# 当前 handoff — 2026-07-28

## Active line

- Architecture exit、Grounding 首切、YUK-804 均已合并。
- 当前唯一 active 线是 YUK-787：
  `codex/grounding-probe-evidence-strength`，PR #1098。
- 已合入 `origin/main@13c2b858` 的 GitHub CI 并行化；不在本地重复跑 CI gate。

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

1. 推送 merge commit，监听 PR #1098 新一轮 GitHub Actions/OCR；处理新增阻塞项。
2. 全绿后 squash merge，Linear YUK-787 → Done。
3. 严格串行启动 YUK-795 prediction_score / hard-confirm 问责轨。
4. YUK-814 真实 owner 数据 shadow/blind gate 必须单独执行；mock 不能代替。
