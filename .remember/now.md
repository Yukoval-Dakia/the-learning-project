# 当前 handoff — 2026-07-28

## Active line

- Architecture exit 已完成；Grounding 首切 PR #1089 已合并：
  `main@0966e1a1`，YUK-799/YUK-800 已 Done。
- YUK-804 不可变题目证据已随 PR #1097 合并到 `main@96579dfa`。
- 当前唯一 active 线是 YUK-787：
  `codex/grounding-probe-evidence-strength`。

## 当前实现

1. probe route 只把 Judge 粗判映射为 `outcome`；resolution 在 lifecycle 事务内
   由纯函数折叠同 conjecture 的持久化历史。
2. 首次 incorrect → `evidence_for`；第二个独立 probe incorrect → `confirmed`；
   correct → `retired`。同 conjecture advisory lock 关闭并发双 preliminary 竞态。
3. 新结果持久化 recurrence rule version 与 probe ids；旧 confirmed 不重解释。
4. Teaching Brief 新增 `outcome_evidence_for`，不开放 scoped practice；即时反馈和
   survival report 同步分级。
5. evidence MCP 输出 `single_observation` / `independent_recurrence` /
   `legacy_confirmed_unverified` / `counterevidence`，防止下游自我强化。
6. discriminating UI 文案从绝对断言降为“尝试区分这一猜想的题”。
7. review 揭示第二题原本只有测试 caller；现由 induction/director 预生成两道不同题，
   首次 `evidence_for` 原子 serve 第二题；旧 v1 proposal 保留单题终结规则且不写 v2 rule
   stamp，避免历史 active probe 永久占槽。

## 已验证

- 原提交 unit：506 files passed / 4 skipped；5788 passed / 33 skipped；review
  follow-up 定向 unit 206/206。
- 定向 DB 140/140；完整 DB gate 按 owner 指示改由 GitHub Actions 判定，本地不再重复跑。
- migration 26/26；typecheck、lint、build、boundary / API contract audits 全绿。
- `audit:projection` 在迁移后的临时 Postgres 上 0 drift。

## 下一步

1. push PR #1098 的 production follow-up seam 修复，监听 GitHub Actions，完成独立
   review + CI 后合并并对齐 Linear。
2. YUK-787 合并后才启动 YUK-795 prediction_score / hard-confirm 问责轨。
3. YUK-814 真实 owner 数据 shadow/blind gate 仍必须单独执行；mock 不能代替。
