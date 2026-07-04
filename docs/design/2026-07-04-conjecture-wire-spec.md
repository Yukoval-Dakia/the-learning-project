# conjecture-engine-dark-loop wire — Reconciled Spec

> **worklist #13 conjecture-wire** · owner 拍 **wire（不 retire）+ isolated path** · 2026-07-04
> parent: **YUK-538**（program tracker，14-item checklist）· master register §3 line 318-326
> 决策支持: `scratchpad/conjecture-wire-decisions.html`（4 决策点 × 12 选项拓扑可视化）
> 模型路由（owner 2026-07-01/03）: 设计相 designer + 双 Opus attack → reconcile; impl opus（守不变量）; review fable 终裁
> 配套设计: `docs/design/handoff/2026-06-27-prep-desk-conjectures.md` + `docs/design/2026-06-27-a13-ts-half-design.md`

---

## 1. TL;DR

conjecture probe lifecycle 是**建好 + DB-tested + 零 live caller** 的 producer/consumer 对：`serveProbeOnce`/`answerProbe`（producer）没人调，`reconcileConjecturePredictions`（consumer）nightly cron 真跑但输入集恒空 → `{reconciled:0}` 永远。两端 dark end-to-end。

owner 拍 **wire（不 retire）**，走 master register §3 line 323 的「isolated probe-answer path that cannot physically reach the FSRS/attempt write」。推荐组合 **4A + 3A + 2A + 1A**（每决策点选 A，全部 designer 推荐、全部守红线）：

| Q | 决策 | 切片代价 |
|---|------|---------|
| Q1 Probe serve 时机 | **A. accept 同 tx 派发** | `conjecture-accept.ts` +5 行（db.transaction 内调 `serveProbeOnce`，与 rate event 原子） |
| Q2 Probe answer 入口 | **A. conjecture card UI + judge run() pure** | ① `ConjectureDraft` schema +`probe_reference_md` ② `induce.ts` prompt 扩 ③ 新 route `POST /api/conjecture/probe/:id/answer` ④ prep-desk card UI 作答区 |
| Q3 Calibration reader | **A. 同波建 admin reader** | 新 route `GET /api/admin/conjecture-scores` + observe 面（mirror observability four-page） |
| Q4 MISCONCEPTION_PROMOTE flag | **A. 不翻，wire only** | 零代码（env default OFF） |

**这条组合守住全部红线**：ND-5、pool-invisibility、defer-flip-not-build、register「reader before producer」、n=1 cap ≤3。代价 = 1 schema 字段 + induce prompt 扩展 + 5 行 accept 接线 + 2 新 route + 1 UI 升级 + 1 admin observe 面。

---

## 2. Baseline（当前 dark 拓扑）

```
nightly cron ──wire──▶ conjecture proposal ──wire──▶ accept (UI)
                                                          │
                                            ┌─────────────┼─────────────┐
                                            ▼ (live)      ▼ (dark)      ▼ (dark)
                                       rate event    probe question  misconception node
                                            │              │ (serveProbeOnce 未调)
                                            │              ▼
                                            │         probe_result event (dark — 无 answer 入口)
                                            │              │
                                            ▼              ▼
                                      (admin 无 reader)  reconcile (cron) ──空跑──▶ prediction_score ──dark──▶ (无人读)
```

- **producer**（`serveProbeOnce`/`answerProbe`，`probe-lifecycle.ts:120/:203`）建好 + DB-tested（`probe-lifecycle.db.test.ts` 全绿），**零 production caller**——`acceptConjectureProposal` 只写 rate event，从不调 `serveProbeOnce`。
- **consumer**（`reconcileConjecturePredictions`，`reconcile.ts:262-273`）nightly cron 真跑，但 unscored `probe_result` 集合恒空 → `{reconciled:0}` 永远。`prediction_score` events 由此**从未写入**（consumer 无输入）。
- **下游**（`kc_typed_state` via `reconcile.ts:268`）已显式与 live misconception-confirmation 解耦（accept-time `source='soft'` mint，`MISCONCEPTION_PROMOTE_ENABLED` flag-gated OFF）。

---

## 3. 前置已清（F1）

PLAN.md cockpit 顶部「下一刀 = #13 conjecture wire**(owner 拍 A 隔离路径,前置:先修 misconception-promote 的 unlocked onConflictDoUpdate...)」中「前置 fix」**stale**——该 fix（**F1**）已修于 #1 kc-dedup PR #693 / YUK-543：

> `misconception-promote.ts` 的 unlocked `onConflictDoUpdate`（hard→soft 静默降级，无 advisory lock）已加固为 **advisory lock + monotone source**（`misconception-promote.ts` + 回归测试）。

本波无需重做 F1。本波在 F1 之上接 wire，soft track 与未来 hard track 并存时不会再静默降级。

---

## 4. 决策记录（4 Q × 裁决）

### Q1 — Probe serve 时机（producer wire 入口）→ **A. accept 同步派发**

`acceptConjectureProposal`（`conjecture-accept.ts`）当前不调 `serveProbeOnce`（producer dark 根因）。cap ≤3 + advisory lock + `draft_status='draft'` pool-invisibility 已**结构**防泛滥。

**裁决 A**：在 `acceptConjectureProposal` 的 `db.transaction` 内、写 rate event 后，调 `serveProbeOnce`（与 rate event 原子）。`cap_reached` 时 accept 容忍（不 fail——probe 派发是 best-effort enrichment，cap 触顶语义 = 「这次先不派发，活跃 probe 退一个再派」）。

**Alternatives rejected**：
- **B. nightly 批量派发**（`research_meeting_nightly` +新 step 扫 accepted-no-probe）——cron 复杂度↑ + 「accept 后等一夜」语义怪 + 扫描查询时序竞态风险（漏/双派）。owner 拍 A 是因为「accept 即派发」语义最干净 + 同 tx 原子（rate event + probe serve 一起回滚）。
- **C. admin 手动 trigger**（新 admin route + UI button）——缺自动化，owner 漏点 → probe 永不派发，与「教研团自动闭环」目标违。非长期形态。

### Q2 — Probe answer 入口（answerProbe wire）→ **A. conjecture card UI + judge invoker chokepoint**

owner 手评不合理（conjecture 的 `baseline_p`/`predicted_p` 是机器算的，对照也得机器判分才公平）。评价走 **`createDefaultJudgeInvoker().invoke()`**——judge-only chokepoint（submit.ts 也走它），解析 route → 跑判分 → emit telemetry，**零 FSRS/attempt/event 写**（grep `invoker.ts` 实证）。**ND-5 边界 = `answerProbe`，NOT judge dispatch**：submit.ts 的 FSRS 写在 judge 调用**之后**、submit 自己的代码里，不在 invoker 内；本 route 不走 submit.ts（自然不触 FSRS 写），唯一写是 `answerProbe` 的单个 `experimental:probe_result` event。

**硬前置**：扩 `induce` prompt 产 `probe_reference_md`（judge 金标来源）。当前 `ConjectureDraftT`（`business.ts:365-378`）只产 `claim_md`/`probe_md`/`predicted_p`/`discriminating`/`agreement_count`/`cause_category`/`recurrence_count`，**缺 reference**。single-writer 纪律 = reference 在 induce 时一次性产生（Opus 同时产 claim+probe+reference），不 runtime LLM 重生。

**实施链**（3 选项只区分触发入口，评价管线统一）：
1. `ConjectureDraft` schema +`probe_reference_md: z.string().min(1).max(2000)`（`business.ts:372` 后）
2. `induce.ts` prompt 扩（让 Opus 产 reference）+ `safeParse` 自动覆盖（:62/:69）
3. `research_meeting_nightly` `buildConjectureProposalInput` 把 reference 写进 proposal payload → `conjecture-accept` 从 proposal change 解析 reference → 传 `serveProbeOnce({ referenceMd })`（`probe-lifecycle.ts:121` 已支持该参数，:142 写入 `question.reference_md`）
4. 新 route `POST /api/conjecture/probe/:id/answer`（token gate）→ `createDefaultJudgeInvoker().invoke({ db, question, answer_md, subjectProfile })`（invoker 内部按 route 分发：semantic → `runSemanticJudge` async LLM；exact/keyword/steps → 同步 base `run()`）→ 按 coarse_outcome 映射 outcome/resolution → 调 `answerProbe({ outcome, resolution, answer_md })`
5. prep-desk conjecture card UI（`prep-desk.ts`）加 probe 作答区（已 surface unrun `probe_md`，加 textarea + submit → answer route）

**Alternatives rejected**：
- **B. admin observe 面 + judge 自动机**——UI 轻，但学习者主流程永远看不到 probe，与「教研团自动闭环」目标违；admin 用久了 = 临时方案变永久。owner 拍 A 是因为 probe 必须在学习者主流程（prep-desk）暴露。
- **C. Copilot dock + judge 自动机**——Copilot 状态机改造大（何时问？错过 probe 时机？），超本单元 scope，与教研团过度耦合。

**判分公平性**：`baseline_p`/`predicted_p` 机器算，judge 机器判，对照对等；按 `question.kind` 路由 capability（short_answer→exact/keyword，步骤题→steps，图→multimodal_direct）。

**风险**：judge 返回 `unsupported`（reference 缺失 / kind 不匹配）的 fail-closed 处理；multimodal_direct 需 OAuth token（NAS `.env`，缺则静默回落 mimo 不报错——见 `feedback_ocr_first_vlm_fallback`）；judge cost 计入 `cost_micro_usd`（per probe answer）。

### Q3 — Calibration reader（prediction_score 消费）→ **A. 同波建 admin reader**

`prediction_score` events 本波 wire 后开始写入。register 红线：**「build/spec the calibration reader before the producer」**——producer 接通前必须有 reader。

**裁决 A**：新 route `GET /api/admin/conjecture-scores` + 简单 admin observe 面（mirror 既有 observability four-page 模式），SELECT `prediction_score` events render。read-only，不写状态。

**Alternatives rejected**：
- **B. defer 到 hard-confirm wire**——**违 register 红线**「reader before producer」：producer 接通后 prediction_score 攒数据但无人读 → 数据失检，owner 拍 hard-confirm flip 时缺数据基础。

**诚实呈现**：score 数值需诚实（brier/log_loss 不渲染为「准确度」；`skill_score_point` 是单点而非窗口均——窗口 aggregate → claim-survival flip 是 ADR-0046 Rust kernel 的活，本波不做）。

### Q4 — MISCONCEPTION_PROMOTE_ENABLED flag → **A. 不翻，wire only**

`acceptConjectureProposal` 当前 flag OFF 仅写 rate event；翻 ON 则 accept 真正 mint misconception + caused_by edge（F1 已加固 unlocked `onConflictDoUpdate`，hard-confirm 仍 dark）。

**裁决 A**：维持 `MISCONCEPTION_PROMOTE_ENABLED=OFF`。守 `feedback_defer_flip_not_build`——本波只 wire probe loop + reader，不耦合翻 flag。misconception mint 路径仍 dark（已 F1 加固 + DB-tested，潜伏不咬）。

**Alternatives rejected**：
- **B. 翻 ON（同时 mint）**——**违 defer-flip-not-build**：本波同时 wire + flip。且 track 不对称（hard-confirm 仍 dark，soft track live hard track dark → 边界 case 未探）。mint 路径上线需 runbook + 运维决策，超本波 scope。

---

## 5. 红线检查矩阵

| 红线 | 守卫机制 | 验证锚点 |
|------|---------|---------|
| **ND-5**（probe 不写 FSRS/attempt/θ̂） | **边界 = `answerProbe`**（route 唯一写面，只写 `experimental:probe_result` event）+ judge 走 `createDefaultJudgeInvoker().invoke()`（judge-only，零 FSRS/attempt 写）+ 不走 `submit.ts`（submit 的 FSRS 写在 judge 调用之后、submit 自己的代码里） | `probe-lifecycle.ts:194` 注释 + `invoker.ts` grep 零 fsrs/attempt/event 写 + `probe-answer.ts` import createDefaultJudgeInvoker（非 judgeSubmit） |
| **pool-invisibility**（probe 不入 review pool） | `draft_status='draft'` + `due-list.ts:236` `notDraftQuiz` 永远排除 | `probe-lifecycle.ts:150`「INVARIANT #1 — 'draft' so due-list.ts:236 notDraftQuiz excludes it from EVERY review pool, forever」 |
| **defer-flip-not-build** | Q4-A flag 维持 OFF | env default `MISCONCEPTION_PROMOTE_ENABLED=OFF` |
| **reader-before-producer** | Q3-A 同波建 admin reader | 本 spec §4 Q3 + S4 切片 |
| **n=1 cap ≤3** | `MAX_CONCURRENT_ACTIVE_PROBES` + `pg_advisory_xact_lock` | `probe-lifecycle.ts:129`（serve lock）+ :132（cap check） |
| **answerProbe 幂等** | per-probe `pg_advisory_xact_lock(hashtextextended(probeQuestionId, 0))` + existing event check | `probe-lifecycle.ts:214` + :240-251 |
| **judge 金标来源**（single-writer） | induce 时一次性产 `probe_reference_md`，不 runtime LLM 重生 | 本 spec §4 Q2 实施链 1-3 |

---

## 6. 实施切片

### S0 — spec（本 doc）
本文件。随 PR 进库。

### S1 — Q2 硬前置：induce 扩 probe_reference_md
- `src/core/schema/business.ts:372` 后 +`probe_reference_md: z.string().min(1).max(2000)`
- `src/server/agency/conjecture/induce.ts` prompt 扩（Opus outputFormat +`probe_reference_md`，single-writer 产 reference）
- `safeParse`（:62/:69）自动覆盖新字段
- 回归测试：induce fixture 含 reference + parse 通过

### S2 — Q1：conjecture-accept 接 serveProbeOnce
- `src/capabilities/agency/server/conjecture-accept.ts` 在 `db.transaction` 内、写 rate event 后，调 `serveProbeOnce({ db: tx, conjectureProposalId, knowledgeId, probeMd, referenceMd, kind, difficulty })`
- `referenceMd` 从 proposal change 解析（proposal payload 已含，S1 扩了源头）
- `cap_reached` 时 accept 不 fail（best-effort）
- 回归测试：accept 后 probe question 行存在 + draft_status='draft' + reference_md 落地 + cap 触顶容忍

### S3 — Q2 主体：answer route + prep-desk card UI + judge routing
- 新 route `POST /api/conjecture/probe/:id/answer`（token gate，capability manifest 登记）
  - body: `{ answer_md }`
  - 按 probe question 的 `kind` 路由 judge capability（`defaultJudgeKindForQuestion`）
  - judge `run()` pure 评价 → `outcome: 0|1`
  - 调 `answerProbe({ db, probeQuestionId, outcome, resolution: 'confirmed', answer_md })`（resolution 本波固定 confirmed——retire 走 admin 另一个 route 或 defer）
  - judge cost 计入 `cost_micro_usd`
- prep-desk conjecture card UI（`prep-desk.ts` + card 组件）加 probe 作答区：textarea + submit → answer route
- fail-closed：judge `unsupported`（reference 缺失 / kind 不匹配）→ 不写 probe_result，surface 错误
- 回归测试：answer route happy path（judge → outcome → answerProbe → probe_result event）+ idempotency（重复 answer）+ fail-closed（unsupported）

### S4 — Q3：admin reader + observe 面
- 新 route `GET /api/admin/conjecture-scores`（token gate，observability manifest 登记）
  - SELECT `prediction_score` events（join conjecture proposal + KC）render
  - read-only
- admin observe 面（mirror observability four-page 模式）：score 数值诚实呈现（brier/log_loss 非「准确度」，`skill_score_point` 单点非窗口均）
- 回归测试：admin route read-only + 诚实 render

### S5 — 收尾：ADR + runbook + Linear
- ADR（conjecture-wire wire 决策记录，挂 ADR-0046 附近）
- runbook（multimodal_direct 需 OAuth token + judge cost 观测）
- Linear：本 spec 镜像 Document 挂新 YUK issue + YUK-538 ⑬ 勾

---

## 7. 代码锚点（code-ground）

| 组件 | 锚点 | 备注 |
|------|------|------|
| `serveProbeOnce` | `src/capabilities/agency/server/conjecture/probe-lifecycle.ts:120` | 参数 `ServeProbeOnceParams`（含 `referenceMd?`），返回 `served\|cap_reached`，advisory lock :129，cap ≤3 :132，写 question 行 draft_status='draft' :150 |
| `answerProbe` | `probe-lifecycle.ts:203` | 参数 `AnswerProbeParams`（db/probeQuestionId/outcome 0\|1/resolution/retrievabilityAtJudge?/answer_md?），幂等锁 `hashtextextended` :214，写 `experimental:probe_result` event，不写 attempt/FSRS（ND-5 :194） |
| `ConjectureDraft` schema | `src/core/schema/business.ts:365-378` | 当前 7 字段，缺 `probe_reference_md`（S1 加） |
| `acceptConjectureProposal` | `src/capabilities/agency/server/conjecture-accept.ts:90/:188` | 当前只写 rate event，S2 加 `serveProbeOnce` 调用 |
| `induce` | `src/server/agency/conjecture/induce.ts:62/:103/:144` | prompt + safeParse + draft 输出，S1 扩 reference |
| `reconcileConjecturePredictions` | `src/server/conjectures/reconcile.ts:262-273` | nightly cron 空跑（baseline），wire 后开始有输入 |
| judge `run()` pure | `src/core/capability/judges/{exact,keyword,semantic,multimodal_direct,steps}.ts` | `JudgeCapabilityRunner = { manifest, run }`，run pure 不写 FSRS/θ̂ |
| `defaultJudgeKindForQuestion` | `src/core/schema/judge-routing.ts:41` | 按 question.kind 路由 judge capability |
| prep-desk conjecture card | `src/capabilities/shell/server/prep-desk.ts:23-28` | 已 surface unrun `probe_md`（serve on accept），S3 加作答区 |
| F1（已修） | `src/capabilities/agency/server/conjecture/misconception-promote.ts` | advisory lock + monotone source（#1 kc-dedup PR #693） |

---

## 8. 不做（defer）

- **Q4 翻 `MISCONCEPTION_PROMOTE_ENABLED` flag**——owner 运维决策 + runbook，超本波 scope（defer-flip-not-build）。
- **hard-confirm wire**（`MISCONCEPTION_HARD_CONFIRM_ENABLED`）——仍 dark，挂 YUK-536 Tier-1 promote。
- **retire path**（park producer behind allowlist）——owner 拍 wire 不 retire，retire 路径不建。
- **calibration 窗口 aggregate**（`skill_score_point` → claim-survival flip）——ADR-0046 Rust kernel 的活，本波只建单点 reader。
- **answer retire resolution**（probe 主动 retire）——本波 answer route 固定 `resolution: 'confirmed'`；retire 走 admin 另一个 route 或 defer。
- **probe reuse-into-attempt path**——master register §3 line 323 显式禁（违 pool-invisibility），本波 judge run() pure 物理隔离。

---

## 9. follow-up（本波不闭，落 Linear）

- **YUK-536** Tier-1 promote（hard-confirm wire + 证伪机器接进 promotion）——本波 wire 后有 prediction_score 数据基础，YUK-536 可据此推进。
- **窗口 calibration reader**（窗口 aggregate → claim-survival flip）——ADR-0046 Rust kernel。
- **probe retire admin route**（主动 retire probe，非 confirmed）。
- **judge `unsupported` 治本**——若 reference 缺失率高，考虑 induce prompt 加固或 fallback。

---

## 10. 对抗 review 与修正

主 session Opus self-review（code-grounded，读 `probe-lifecycle.ts` / `conjecture-accept.ts` / `induce.ts` / `business.ts:365-378` / `judges/exact.ts` / `reconcile.ts:250-290`）。**7 条发现，3 条 block S2/S3 实施正确性**。

### Lens A — 红线轴

#### A1【BLOCK S2】`serveProbeOnce` 自带 `db.transaction` → 与 accept 同 tx 嵌套语义未核
spec §4 Q1-A / §6 S2 说「在 `acceptConjectureProposal` 的 `db.transaction` 内、写 rate event 后调 `serveProbeOnce`」并强调「与 rate event 原子」。

**代码事实**（`probe-lifecycle.ts:127`）：`serveProbeOnce` 自己 `return db.transaction(async (tx) => { ... })`。drizzle 在已有外层 tx 内调 `db.transaction` 走 SAVEPOINT 嵌套——cap_reached return 仍能正常传播（不 throw，OK），但「同 tx 原子」的真实语义是「SAVEPOINT 回滚而非主 tx 回滚」，且 `pg_advisory_xact_lock(PROBE_SERVE_LOCK_KEY)` 在 SAVEPOINT 内释放在 SAVEPOINT 释放在主 tx commit 时——**与「同 tx 一起回滚」措辞不符**。

**修正**：要么 (a) `serveProbeOnce` 增 `tx?: Tx` 注入重载，accept 端传外层 tx 复用（推荐——`ServeProbeOnceParams.db: Db` 改 `Db | Tx` 已兼容），要么 (b) spec §4 Q1-A 把「同 tx 原子」措辞改为「accept 后顺序调用（非同 tx），cap_reached 容忍」放弃原子性宣称。S2 实施前必须二选一，否则代码会写出未预期的 SAVEPOINT 行为。

#### A2【S2 硬前置，初次判断收窄】proposal change 缺 `probe_reference_md`；accept 端未消费已有的 `probe_md`

**代码事实（核实后，初次判断过严）**：`ConjectureProposalChange`（`proposal.ts:409-420`）**已含** `probe_md` / `discriminating` / `predicted_p` / `baseline_p_at_induction` / `corrected_by_owner`；`buildConjectureProposalInput`（`research_meeting_nightly.ts:153-167`）**已透传**这些字段 draft→change。spec §6 S2 笼统说「从 proposal change 解析」没核实哪些字段在、哪些缺——接地不够，但「全不在」是误判。

**真正缺的四环**：
- (a) `ConjectureDraft`（`business.ts:365-378`）缺 `probe_reference_md`——源头 schema 要加
- (b) `ConjectureProposalChange`（`proposal.ts:409`）缺 `probe_reference_md`——payload schema 要加
- (c) `buildConjectureProposalInput`（`research_meeting_nightly.ts:153-167`）未透传 `probe_reference_md`（draft→change 缺一环）
- (d) `acceptConjectureProposal`（`conjecture-accept.ts:97,168-181`）**未消费已有的 `probe_md`**（在 change 里但 accept 没读）+ 未读新加的 `probe_reference_md`

**`kind` / `difficulty` 不必加 schema**——`serveProbeOnce` 默认 `'short_answer'` / `3`（`probe-lifecycle.ts:123-124`）。本波 conjecture probe 统一 short_answer 即可（multimodal probe 是 follow-up，走 multimodal_direct judge 时再判 kind 路由）。

**修正**：S1 拆四步（见末尾「修正后的切片」）。

#### A3 judge `run()` 不是全 pure — `multimodal_direct` 调 LLM 有副作用
spec §5 红线矩阵 + §4 Q2 把 judge `run()` 统称「pure 不写 FSRS/θ̂」。exact/keyword/steps/semantic 的 `run()` 确实 pure（`exact.ts` `cost_class: 'local'`，纯字符串比对）。但 `multimodal_direct` 是 vision LLM 调用——**不写 FSRS/θ̂（ND-5 仍守）但非 pure**（网络 + cost + 可能 fail）。

**修正**：§5 红线矩阵 ND-5 行措辞从「judge run() pure」改为「judge run() 不写 FSRS/attempt/θ̂（可能调 LLM 产生 cost，但不写学习状态）」。ND-5 守卫机制本身**未破**——精确化的是声明。

#### A3b【CRITICAL，已修】base registry semantic `run()` 是 STUB — 真判分路径是 invoker dispatch
spec §4 Q2 原案「judge run() pure 按 defaultJudgeKindForQuestion 路由 capability」隐含「base registry 的 `run()` 是 runtime 判分」。**代码事实不符**（review PR #705 CRITICAL 锁定）：`src/core/capability/judges/semantic.ts` 的 `run()` 返回 `coarse_outcome: 'unsupported'`——是 profile-validation STUB，**不是 runtime 判分**（`src/core/capability/judges/index.ts` 注释确认「server execution goes through JudgeInvoker ... not core registry runners directly」）。semantic 的真路径是 `runSemanticJudge`（async LLM），只能经 `createDefaultJudgeInvoker().invoke()` dispatch 的 `if (route === 'semantic') return await runSemanticJudge(...)` 分支到达（`invoker.ts:146`）。exact/keyword/steps 的 base `run()` 确实是 runtime，但 short_answer/free_text probe 走 semantic——若 route 真按 spec 原案调 base registry，每个 free_text probe 都 fail-closed 422，永不写 probe_result，dark loop 保持黑暗。

**修正**（已落地，PR #705 fix-lane）：route 改调 `createDefaultJudgeInvoker().invoke({ db, question, answer_md, subjectProfile })`——同一 chokepoint submit.ts 也用。ND-5 未破：grep `invoker.ts` 零 FSRS/attempt/event 写，judge-only。原 spec 把 invoker 误称「submit.ts 的 judgeSubmit（attempt 域耦合 wrapper）」是错的——submit.ts 用 invoker 作 judge chokepoint，但 FSRS 写在 submit 自己代码里、judge 调用之后，**不在 invoker 内**。本 route 不走 submit.ts，自然不触 FSRS 写。详见 ADR-0049 §Q2 + 红线矩阵。

#### A4【BLOCK S3】consumer 自动触发 — `kc_typed_state` upsert 漏出 reader 视野
spec §4 Q3「reader before producer」红线只建 `prediction_score` reader。

**代码事实**（`reconcile.ts:264`）：`reconcileConjecturePredictions` nightly cron 在每个 confirmed probe 上调 `upsertFn` 写 `kc_typed_state`（`proposed: 'confused-with-X'`）——**结构性状态变更，不是 log**。producer wire（S2/S3）→ `probe_result` events 开始累积 → consumer 下次 nightly 自动跑 → typed_state 被自动 mint。spec §6 S4 的 admin reader 只 SELECT `prediction_score` events，**不观测 typed_state 变化** → 「reader before producer」红线**未真守**：producer 接通后系统会自动改 KC 软状态而 owner 无观测面。

**修正**：S4 admin reader 必须双读——(a) `prediction_score` events（已有）+ (b) `kc_typed_state` where `proposed='confused-with-X'` 且 `evidence_event_ids` 含 probe_result（区分 hard/soft track）。否则 wire 后会出现 owner 看不见的自动状态变更。

#### A5【语义风险，follow-up】resolution=confirmed + outcome=1（probe 反驳 conjecture）→ reconcile 仍 mint confused-with-X
spec §4 Q2 alternatives rejected 把 retire defer 了，固定 `resolution: 'confirmed'`。但 `reconcile.ts:267` 只看 `pr.resolution === 'confirmed'` 决定 `proposed: 'confused-with-X'`，**不看 outcome**。语义上 outcome=1（学习者答对 probe → conjecture 不成立）时仍 mint confused-with-X = **假阳性软状态**。

**这是 reconcile.ts 既有语义，不是 wire #13 引入**——但 wire 后首次有真实数据流过，本波必须显式处理：

- 选项 (a)：S3 answer route 按 outcome 分流 resolution——`outcome=0 → 'confirmed'`（conjecture 成立），`outcome=1 → 'retired'`（conjecture 被反驳，retire 语义本波就引入而非 defer）。这要求 retire path 进 S3 而非 §8 defer。
- 选项 (b)：保留 resolution=confirmed 单值，但在 §9 follow-up 显式标注「reconcile 把 outcome=1 也当 confirmed mint」为已知语义缺陷，挂 Linear 阻断 hard-confirm flip。
- **推荐 (a)**——retire 不是「主动 retire probe」（§8 defer 的是 admin 主动 retire），而是「answer outcome 驱动的 conjecture 反驳」语义，是 producer 闭环的必要半边。S3 必须含 outcome→resolution 映射。

### Lens B — 价值轴

#### A6 n=1 calibration value 显式承认 = 结构性 + 数据基建，非数值
master register §3 line 321 已警告「n=1 下 wire 是否真产生 calibration signal vs trickle noise」。spec §1 TL;DR / §4 Q3「诚实呈现」段**回避了正面回应**——只说「brier/log_loss 不渲染为准确度」。

**修正回应**：n=1 下本波 wire 的真实价值 = (i) **教研团自动闭环结构完整**（probe 真派发真评价真 reconcile，不再是 dark loop），(ii) **未来 n>1 / 多 KC 的数据基建**（probe_result events 攒起来才有可能做窗口 calibration）。单点 brier/log_loss 在 n=1 下方差极大，**无统计意义**。§1 TL;DR 应显式声明「本波不声称产出可用的 calibration 数值；声称的是闭环通电 + 数据开始累积」，与 owner `feedback_useful_product_not_vase`（要好用有用不是花瓶）一致——「管道平衡优先于再建引擎」的体现。

#### A7 induce prompt 扩展 LLM cost — 现有 self-consistency N=3 已是 3× Opus，加 reference 不显著
spec §4 Q2 风险段提到「judge cost 计入 cost_micro_usd」但没量化 induce 扩展的 cost。

**代码事实**（`induce.ts:106-115`）：`induceConjecture` 已跑 N=3 次 Opus self-consistency samples，每次都带 `outputFormat: zodToJsonSchemaOutputFormat(ConjectureDraft)`。S1 加 `probe_reference_md` 字段进 schema = 同一次 Opus 调用多产一个字段，**边际 cost ≈ 0**（output token 增加几十 token）。cost 真正变量在 S3 的 judge——而 exact/keyword/steps 是 `cost_class: 'local'` 零成本，只有 multimodal_direct 走 vision LLM（且 probe question kind 默认 `'short_answer'`，多数走 local judge）。**fairness OK**：reference 是 induce 时 Opus 产，judge 时机器对机器，无 human-in-loop 不公平。

### 修正后的红线矩阵（替换 §5 ND-5 + reader 行）

| 红线 | 修正后守卫 |
|------|-----------|
| ND-5 | **边界 = `answerProbe`**（route 唯一写面）。judge 走 `createDefaultJudgeInvoker().invoke()`——judge-only（grep 零 FSRS/attempt 写；semantic 真 LLM 路径 `runSemanticJudge` 经 invoker dispatch 到达，base registry `run()` 是 STUB 非 runtime——A3b）。不走 submit.ts（FSRS 写在 submit 自己代码里、judge 调用之后，不在 invoker 内） |
| reader-before-producer | S4 admin reader **双读** prediction_score events + kc_typed_state 软状态变更（A4） |

### 修正后的切片（替换 §6 S1 + S3）

- **S1（修正，收窄）**：(a) `ConjectureDraft`（`business.ts:372` 后）+`probe_reference_md`（b）`ConjectureProposalChange`（`proposal.ts:419` 后）+`probe_reference_md`（c）`buildConjectureProposalInput`（`research_meeting_nightly.ts:166` 后）透传 `probe_reference_md: induced.draft.probe_reference_md`（d）`induce.ts` prompt 经 `outputFormat: zodToJsonSchemaOutputFormat(ConjectureDraft)` 自动让 Opus 产 reference（schema 加字段后 outputFormat 自带，无需手改 prompt 文本）+ `parseSampleDraft` safeParse 自动覆盖（:62/:69）。`probe_md`/`predicted_p`/`discriminating`/`baseline_p_at_induction` 已在 change——不动
- **S2（修正）**：`serveProbeOnce` 增 `Db | Tx` 重载或显式 `tx` 注入（A1），accept 端复用外层 tx；cap_reached 容忍
- **S3（修正）**：answer route 按 outcome 分流 resolution——`outcome=0 → 'confirmed'`、`outcome=1 → 'retired'`（A5 选项 a，retire 语义从 §8 defer 移入）
- **S4（修正）**：admin reader 双读 prediction_score + kc_typed_state（A4）
