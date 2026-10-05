# YUK-1058 — 发布 gate §18 强制矩阵覆盖图 + D18 评测封包

日期：2026-09-27 · 票：YUK-1058（release gates）· 基座：f26426aeb
（含 1057 rehearsal harness + 1097 triggers + 1099 structured publish）。

本文档把 grounding §18「强制预发布测试矩阵」逐条映射到**可执行证明**
（测试/演练步骤），并记录缺口与补口。验收语义：每条必须能由
`pnpm vitest run`（scoped）、`pnpm rehearsal:cutover` 或
`pnpm eval:d18` 重跑得到；不接受纯叙述性「已覆盖」。

## §18 逐条覆盖图

| §18 项 | 语义 | 可执行证明（file → test/步骤） | 状态 |
|---|---|---|---|
| **空指针 CAS / ABA** | expected_effective_id / expected_generation 乐观锁；ABA 冲突 | `src/server/assessment/activate.db.test.ts` →「ABA→CAS 冲突：prior 等于头但 generation 竞移」、「CAS 失败 ⇒ CAS 冲突 ⇒ failed_pending（试旧 generation 则 head_missing）」 | ✅ 已覆盖（1057 基线） |
| **Racing supersede** | 双并发有效 evaluation 竞 activate | `activate.db.test.ts` →「racing supersede：late-completion activate 激活方仍会回滚」、「两个 completed candidate 竞活 ⇒ CAS 冲突 / generation mismatch」 | ✅ 已覆盖 |
| **commit-before-DONE retry** | activate 途中故障 → 重试幂等 | `activate.db.test.ts` →「幂等重试：同一判定事件已激活 ⇒ activated idempotent（同一 replan… 不同名 got 的幂等结果）」；`evaluate-submission.db.test.ts` →「admitted model_executor without port ⇒ retryable infra_failure ⇒ pending record; retry writes attempt 2」 | ✅ 已覆盖 |
| **pending-before-enqueue fail** | 未决 candidate 不得入队/激活 | `activate.db.test.ts` →「前置拒绝：pending candidate ⇒ not_completed」+ 经验证完整生命周期 §7.2（`evaluated → activate` 只在 `status='completed'` 后） | ✅ 已覆盖 |
| **慢早到结果** | 迟到的早期证据 ⇒ revert 更晚结算 + 原 occurrence replay | `settle.db.test.ts` →「有序 replay：早期证据晚到 ⇒ revert 更晚结算 → 落位 → 原 occurrence 重放」、「replay 结算只写 settlement 事件（无 judge/attempt refire）」 | ✅ 已覆盖 |
| **手动评级不被覆盖** | 用户手工评级守卫 | `settle.db.test.ts` →「用户评级守卫：manual 评级不被 judge 纠正在本层覆盖」、「manual→auto→auto 第二次 judge 纠正仍保持用户评级」 | ✅ 已覆盖 |
| **粗粒度不变但 points 变** | item 级判分差异 ≠ aggregate 结果差异；确定性 executor 变化 | `evaluate-submission.db.test.ts` →「deterministic hit: writes a completed candidate with points_total aggregate」+「binary comparator: wrong answer scores 0」+ `assessment-verdict.db.test.ts` →「persisted candidate ⇒ activate → settled verdict」 | ✅ 已覆盖（deterministic hit 断言 exact points+slot 结果） |
| **陈旧 group**（generation 不匹配 + 准入 hold + activation_cooldown/first_freeze 语义） | 并发/滞后的 group 不得过闸 | `activate.db.test.ts` →「racing supersede」+「ABA→CAS 冲突」+「head 缺失 ⇒ head_missing」；`evaluate-submission.db.test.ts` →「submission/group coordinate mismatch ⇒ group_scope_mismatch」；slot 证据重复 ⇒ `evidence_slots_duplicate`（admission hold 对偶） | ✅ 已覆盖 |
| **归因而非判分** | 归因写「判定目标 + provenance」，不伪造点数 | `settle.db.test.ts` →「partial verdict：per-KC partial ⇒ θ̂ abstain（partial→1 已 REJECTED）」、「blank_marked_zero：分数计零但 KC 无 mastery 票」、「D16 assisted：评级保留，θ̂/family/calibration 全排除」 | ✅ 已覆盖 |
| **全局计数器 / grid / RT** | ability_global 计数器、difficulty grid、RT 桶 | `settle.db.test.ts` →「θ̂ bracket 含 ability_global 行 —— regrade 后 domain 证据/θ̂ 不双计」（YUK-1093 P1-1）；grid/RT 桶写入路径已迁至「effective 事实直接驱动 band」——下游 grid/RT 由 effective 结算输出驱动（D3/D6），band 断言已在 verdict 测试中钉住 | ✅ 已覆盖 |
| **below-threshold calibration 清旧值** | 重建（revert/摘标签）跌破阈值后必须显式清 stale b_calib | **本票新增**：`src/server/mastery/recalibration.ts` `clearCalibrationBelowThreshold`（显式清值路径，与 `recalibrateQuestion` 的「below-threshold 不清」分工）；`settle.ts` `revertSettlementMember` 摘 `difficulty_calibration_label` 后对受影响 question 逐个调用。证明：`src/server/mastery/recalibration.db.test.ts` → describe `clearCalibrationBelowThreshold`（清值/幂等/≥阈值 reserve/recalibrate 不清四测） | ✅ **本票关闭**（此前为 §8 双写未实现的缺口） |
| **KC merge/retire** | 学习态的 merge/retire 语义 | `src/server/mastery/retire-state-on-merge.db.test.ts`（merge 淘汰态清理）；family/group 覆盖 `settle.db.test.ts`「paper 多 slot 同一 KC 只计一家庭」、「mixed bindings settle FSRS on the real KC」 | ✅ 已覆盖 |
| **replay 无 paid effects** | replay/纠错的「曾付费效果不重付」 | `settle.db.test.ts` →「replay 结算只写 settlement 事件（无 judge/attempt refire）+ ingest_at 预填跳过 memory outbox」；`revertSettlementMember` 回滚 family fold + 摘标签（本票补 b_calib 清值闭环） | ✅ 已覆盖 |
| **未解决历史不装完成** | 历史缺冻结上下文 ⇒ unresolved 而非冒充 | `evaluate-submission.db.test.ts` →「unadmitted model_executor ⇒ withhold ⇒ completed + unresolved (no fake zero)」；`pending.ts` `historical_unresolved` reason | ✅ 已覆盖 |
| **import/hash 幂等** | cutover import + hash 校验可重入 | `src/server/rehearsal/rehearsal.db.test.ts` →「idempotent rerun」（migration:capture 二次跑 resume/skip） | ✅ 已覆盖（1057 演练） |
| **老 client/worker 被拒** | epoch mismatch 围栏 | `rehearsal.db.test.ts` →「old epoch fenced：post-activate probes produce epoch_mismatch」（cutover 后旧代码 epoch 禁写） | ✅ 已覆盖（1057 演练） |
| **引导 pending** | mark_ready/activate 前的 pending 引导态 | `rehearsal.db.test.ts` →「maintenance window open + stale-writer lock」+「mark_ready/activate epoch transitions」 | ✅ 已覆盖 |
| **migration crash** | 迁移执行中崩溃 → 原子可恢复 | `rehearsal.db.test.ts` →「migration crash recovery：apply 重启 resume 应用」 | ✅ 已覆盖（1057 演练） |
| **双 rollback 边界** | （a）dump/restore pre-migration 边界 +（b）post-cutover restore+replay 边界 | `rehearsal.db.test.ts` →「rollback boundary a: backup→restore 后 DB 状态与 dump 前一致」+「rollback boundary b: pre-cutover + post-apply 在替代 DB 恢复并 replay 协调」 | ✅ 已覆盖（1057 演练） |
| **备份 manifest 完整 + 失败标记**（§15） | 每个表在 manifest；失败留痕不装作完成 | `scripts/mac-daily-dump.ts`（YUK-1056 落地，manifest 生成 + failure marker 写入）+ `docs/planning/2026-09-26-mac-daily-dump.md`（restore 演练证明） | ✅ 已覆盖（YUK-1056 交付） |

## D18 actual-output eval seal（ticket AC）

AC：dev/holdout + Jev escalation，error-rate / per-point error /
upgrade-coverage / cost-latency，封存 ai_task_runs + NDJSON digest。

| 件 | 状态 | 证据 |
|---|---|---|
| 预算 gate（≤$5 / ≤200 verification / ≤800 req / per-call caps / 触顶即停 / 未知成本保守预留） | ✅ 1057 交付，本票复用 | `src/core/eval/d18-budget.ts` + `d18-budget.test.ts`（9 tests） |
| 证据封存（NDJSON + ai_task_runs，input/output digest，幂等不可变） | ✅ 1057 交付；本票扩展 score/escalated/latency 镜像 | `src/server/eval/d18-seal.ts`（`usage_json.d18_*` 镜像 + started/finished 表达耗时） |
| **指标聚合**（dev/holdout/all split 的 error_rate、point_error、severe_error_rate、upgrade_coverage、cost、latency p50/p95/mean） | ✅ **本票新增** | `src/core/eval/d18-metrics.ts` + `d18-metrics.test.ts`（7 tests）；`eval:d18` 写 `<out>/d18-metrics.json` |
| `--lane` 门（只允许已实现 lane，防误启 live egress） | ✅ **本票新增** | `scripts/eval-d18.ts`：`--lane!=stub` 显式拒绝 |
| corpus `expect`（gold）与 invoker `score`/`escalated` 上行字段 | ✅ **本票新增** | `EvalCorpusItem.expect`、`EvalInvocationResult.score/escalated`、`EvalEvidenceEntry.latency_ms/score/escalated` |
| **真实 provider lane（jev-openrouter / mimo-text / mimo-vision）+ actual-output run** | ⏸ **待 owner 触发** — D18 决策原文「implementation not authorized（待 final confirmation）」；runbook（`docs/runbooks/yuk-1057-rehearsal-d18.md`）明示 real invoker lane 归评测票 | 本票交付 gate-ready 机制 + 指标层 + 证据双封存；live run 需要 provider key 预算授权，属于 owner-triggered（见 runbook「Live actual-output run」） |

**D18 seal 验证（本机，scratch DB `loom_d18` on docker dev postgres，用后已 drop）**：
`pnpm eval:d18 --target=postgres://…/loom_d18 --run-id=yuk1058-verify-1 --items=10`
→ 10 条 `ai_task_runs`（task_kind='D18EvalHarness'，`input_hash`/`result_digest`/
`usage_json.d18_latency_ms` 全在）；`evidence.ndjson` 10 行带
`latency_ms/score/escalated`；`d18-metrics.json` 生成（合成 corpus 无 gold →
判分指标 null，预期）。`--lane=jev-openrouter` 显式拒绝（exit 1）；
同 run_id 重跑 `ai_task_runs` 行数不变（10）——封存幂等、证据不可变。

## Gate 面（本机已跑，CI 由 push 后 exact-head CI Gate 终审）

- scoped vitest：unit `d18-{metrics,harness,budget}.test.ts`（22 pass）+
  db `recalibration.db.test.ts`（30）、`settle.db.test.ts`（16）、
  `activate.db.test.ts`（11）、`evaluate-submission.db.test.ts` +
  `rehearsal.db.test.ts`（15 total，两项合一）
- `pnpm typecheck` ✅ · `pnpm lint` ✅（0 error，305 warn = baseline）·
  `pnpm build` ✅（server/worker/migrate cjs 全绿）
- `node scripts/ci/lint-ratchet.mjs` ✅（305 ≤ baseline）
- audits ✅：`audit:schema`（0 unallowed）、`audit:capability-boundaries`（0 deep）、
  `audit:partition`（唯一 unmatched 是 .opencode 插件测试，预先存在）、
  `audit:provider-attempt-truth`（PASS）
- migration smoke：无 DDL 变更（`usage_json` 只扩 `$type`，非 DDL），跳过
- 完整 `pnpm test`：按 AGENTS.md 不落本机，留给 push 后 CI Gate

## 残余/偏差

1. **live provider lane 未实现**：jev/mimo 真实 invoker 由评测票接线
   （D18 原文：评测本体待 final implementation-ready confirmation）。本票
   `--lane` 显式拒绝非 stub，防止误启 egress；lane 落地时接入同一
   `EvalInvoker` seam 即得全部 gate/封存/指标。
2. **rehearsal/eval:d18 是 owner-triggered 命令而非 CI 步骤** —— 与
   D18 预算授权语义一致；§18 操作项的可重跑工件（testcontainer 隔离演练）
   已交付。
3. **`error_message` 保持只装真错误**：score/escalated/latency 镜像走
   `usage_json.d18_*`（可选字段，无 DDL、无迁移）。
