# 当前 handoff — 2026-07-28

## Active line

- Architecture exit 已完成并经 PR #1088 合并：`main@6b1beda6`。
- 当前唯一 active 线是 Grounding「猜想证据」：
  `codex/grounding-intervention-closed-loop`。
- Grounding 项目已 In Progress；YUK-799/YUK-800 已 In Progress。

## 当前实现

1. `ConjectureDraft` 是 `proposal | abstain` discriminated union。
2. proposal 强制携带 `knowledge_id` 与至少两条 `evidence_event_ids`；调用方校验
   必须来自确定性 evidence cell，伪造引用计 invalid vote。
3. N=3 self-consistency 必须 ≥2 次语义收敛；abstain、invalid、provider failure、
   分裂聚类都不能被分母吞掉。
4. 全部 provider 调用失败仍抛错；合法 abstain / 无共识不会伪装成 provider 故障。
5. nightly 对 abstain 写 `experimental:conjecture_abstained`，保留 reason、
   evidence refs、votes、task-run ids 与成本；不写 conjecture proposal、不记 AI failure。
6. `MindModelInductionTask.maxIterations=2`，无工具，第二轮仅允许补完输出。

## 已验证

- unit：505 files passed / 4 skipped；5759 passed / 33 skipped。
- DB：387 files；4189 passed / 9 skipped / 1 todo。
- migration 26/26；typecheck、lint、build、boundary / structured-judge audits 全绿。
- 定向 closed-loop DB 含真实 event parse/write abstain；director 兼容路径 20/20。

## 下一步

1. 提交、开 PR、独立 review + CI，关闭 YUK-799/YUK-800。
2. YUK-814 真实 owner 数据 shadow/blind gate 仍必须单独执行；mock 不能代替。
3. 下一 slice：YUK-804 attempt-time snapshot，再做 YUK-787/795 二次独立 probe 与
   target-error-aware Judge；历史 v1 不批量重解释。
