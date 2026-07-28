# 当前 handoff — 2026-07-29

## Active line

- Architecture exit 已完成；Grounding 首切 PR #1089 已合并：
  `main@0966e1a1`，YUK-799/YUK-800 已 Done。
- Grounding「猜想证据」YUK-804 已由 PR #1097 合并到 `main@96579df`；下一产品
  slice 是 YUK-787/795，尚未启动实现。

## 当前实现

1. 新 attempt event 带 `schema_version=1` 的最小不可变题目快照：题面、参考、
   选项、图像、figures、question version、updated_at。
2. question part 同时冻结 shared parent；缺失 parent 失败关闭。
3. 四条生产 attempt writer 均落快照：solve、paper、mistakes ingestion、enroll。
4. Practice 持有 snapshot reader，Ingestion 只经 Practice `public.ts` 调用。
5. 失败投影校验 snapshot question id 必须等于 event subject；新事件的 conjecture
   evidence 只读快照，不查 mutable question row。
6. legacy attempt/review 无快照仍可解析；题面或 parent 已编辑/变更时保守省略，
   不配对旧答题与新题面。

## 已验证

- unit：505 files passed / 4 skipped；5779 passed / 33 skipped。
- DB：388 files；4201 passed / 9 skipped / 1 todo。
- migration 26/26；typecheck、lint、build、boundary / API contract audits 全绿。
- 定向 DB 153/153：四条 writer、snapshot reader、失败投影、编辑后归纳均覆盖。

## 下一步

1. 下一 slice：YUK-787/795 二次独立 probe 与 target-error-aware Judge；历史 v1
   不批量重解释。
2. YUK-814 真实 owner 数据 shadow/blind gate 仍必须单独执行；mock 不能代替。

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
