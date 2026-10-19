# YUK-1507 — quiz_verify 验证通过改待准入，封直接 admitted 旁路

服务契约：ADR-0073 四源同门、YUK-1507、YUK-1445 C1、YUK-1547（Refs）；审计根 YUK-1388。

## 根因

`src/capabilities/practice/jobs/quiz_verify.ts` 的成功路径在 verify 通过（promote）
时调用 `publishQuestionGroupFromRow` 直写 `admission=admitted`，附
`marking_provenance=system_verified` + `independent_verification.verifier=
'independent_model'` 证据。这让 quiz_gen 题绕过 C1（`question_admission_run`）的
「两次独立解题一致 + 逐单元标定」准入，与 #1753 已修复的 source_verify 旁路同源。

serving 读面（`kernel/read-models/question-serving.ts`）要求
`scoring_admission_state='admitted'` 且未挂起/未撤回/`decideAutomaticServing` 通过，
所以直写 admitted 的题确实可出 —— 旁路是真实的。

## 变更（仅此文件 + 本文档）

成功路径的发布改为 `withheld(unverified_rules)`，保留 `quiz_verify@1` /
`outcome='passed'` 核验记录（evidence: overall + copy_safety）。publisher 的
`experimental:assessment_publish` 事务事件是既有 outbox；
`practice.question-admission-enqueue` 订阅只放行
`admission='withheld'` 且 lifecycle 仍 pending（`isPendingAdmission`：
withheld/unverified_rules、未撤回、未挂起）的发布，自动入队 C1。verify_hold 视角
不成立：本发布 `suspension:{suspended:false}` 保持 pending 可入队。

不新建入口、不临时直接入队、不改 `question_admission_run`/`enqueue`/UI/模型配置/
付费协议。`draft_status→active`、FSRS enroll-if-absent、复合子题同事务提升、
version CAS、`promotedElsewhere`、placement claim/unknown 保护全部保持原样。

## 重复投递 / 先行准入（pair-race）

与 source_verify 同一判据，提取为 `readBoundIndependentAdmission`（同事务锁
lifecycle FOR UPDATE，锁序 root question → lifecycle 与 publisher/C1 一致）：
`admitted` + 当前 revision 存在 `question_admission@*`/`passed` 行 + 该行
`revision_digest` 绑定当前已发布 `integrity_digest`（旧
`evidence.base_contract_digest` 仅作 base==published 兼容回退，YUK-1547 后它记的是
付费输入摘要）。

- **成功分支命中**：不重发 —— 不把 admitted 降回 withheld，也不把行归一 base
  重铸到 C1 的 resolved revision 上（重铸还会经 withheld 事件触发一次无收益的
  重复付费准入）。若仍挂 `verify_hold`（跨 lane 再挂起），走 publisher 既有
  dimension-only 路径清挂起，admission 维度显式回传原值；CAS conflict
  fail-closed 回滚。成功事件盖当前 generation + `kept_independent_admission` /
  `kept_revision_id` 审计标记。
- **失败/needs_review 分支命中**：`promotedElsewhere` 的 generation 绑定盖不住
  「A 记 withheld 代 → C1 admitted 推进一代 → 迟到失败投递误判非 stale」这一新
  交错（旧直准模式下 generation 不被第三方推进，结构上不可能发生）。命中时同样
  判定 stale：不折叠 admitted、不挂 verify_hold，事件仍如实写。

## 未改语义与边界

- `verify-and-promote` 的 owner override（`manual` provenance）不在本片；owner 显式
  手工准入是另一条已记账的 lane。
- C1 未命中绑定（准入的是更老 base 后行又变、他 policy、未准入）照常 withheld
  发布 —— 付费双解只认当前 revision 的绑定证据。
- 幂等不变：终态 verify 事件仍短路重复投递；并发窗口内双投递各自付费属既有行为。

## 验证与剩余风险

本线只做源码/静态检查（typecheck / lint / build）；不写测试、不触 DB、不跑运行
窗口。真实窗口验证（withheld→C1→admitted 端到端、重叠投递对账）由父线执行。

剩余风险：并发窗口内两份投递重复付费属既有行为（幂等 guard 之后才可重叠进 tx）；
kept 路径下失败投递的 verdict 只进事件不进 `question_admission_verification`
（与 source_verify 的 stale 跳过同惯例 —— 核验记录诚实归属其核验的 generation）。
