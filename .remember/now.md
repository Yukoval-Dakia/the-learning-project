# 当前 handoff — 2026-07-28

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

## CI 提速研究（2026-07-28）

- GitHub gate 已拆为 centralized changes + static/audits、unit、DB、migration、build、
  usability 并行 lanes；末端 aggregate 保留原 required-check 名称并 fail closed。
- owner 明确不再本地跑 CI；验证以本 PR GitHub Actions 为准。当前容器无 gh/remote/token，
  不伪造远端 timing，也不把本地 CI 设成前置。
- 方案与落地说明：`docs/research/2026-07-28-ci-speedup.md`。
