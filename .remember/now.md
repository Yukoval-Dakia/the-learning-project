# 当前 handoff — 2026-07-29

## Active line

- Architecture exit、Grounding 首切、YUK-804 均已合并。
- YUK-787 已随 PR #1098 合并并在 Linear Done；最终 CI Gate / OCR / CodeQL 全绿。
- 当前唯一 active 线是 YUK-795：
  `codex/yuk-795-accountability-loop`，PR #1101，基于 `origin/main@876a501a`。
- 已合入 GitHub CI 并行化及 DB/unit 长尾提速；不在本地
  重复跑 CI gate。

## 当前实现

1. YUK-795 的 deterministic rule 已在 Linear 开工评论中锁定：
   `skill_score_point >0`=hit、`<0`=miss、`=0`=neutral。
2. 同一 owner、同一 `(cause_category × knowledge_id)` 的有效 score 按时间折叠；
   单次 miss 不动排序，连续两次 miss → 0.25×，连续两次 hit → 1.15×。
3. hard flag 开启且 Tier-1 dissociation 到 `EMERGING` 时，持续命中提升到 1.25×；
   mixed/neutral/不足两条保持 1.0×。后续相反 streak 可逆转。
4. 接线目标是 research meeting 在 top-K 截断前重排 evidence cells；correction
   后的 probe_result 不进入 fold。
5. `MISCONCEPTION_HARD_CONFIRM_ENABLED` 仍默认 OFF：当前 Judge 没有
   `target_error_match`，不得把普通答错冒充 M-diagnostic；soft→hard 仍需 fresh owner
   confirmation。本票只把现有 hard-confirm verdict 接入 live consumer，不伪造 hard。

## 验证与远端

- YUK-795 已提交并推送为 PR #1101。
- 定向 unit：accountability 7/7；定向 DB：accountability 4/4；改动文件
  Biome 与 `git diff --check` 已通过。此前关联 reconcile/hard-confirm/nightly
  定向测试也已通过。
- main 新增 CI 并行 lanes：static/audits、unit、DB、migration、build、usability；
  aggregate 保留 required-check 名称并 fail closed。
- 只在本地跑改动范围的定向测试/格式检查；完整 gate 只监听 GitHub Actions/OCR。
- CI 方案说明：`docs/research/2026-07-28-ci-speedup.md`。

## 下一步

1. 只监听 PR #1101 的 GitHub Actions/OCR，处理远端失败或 review；不在本地重复
   完整 CI gate。
2. 全绿后合并，Linear YUK-795 对齐 Done。
3. YUK-814 真实 owner 数据 shadow/blind gate 必须单独执行；mock 不能代替。

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
