# ADR-0049 — Conjecture-Engine Dark-Loop Wire（producer + consumer 通电 + A4 双读 reader）

**Status**: Accepted (owner 2026-07-04「wire（不 retire）」+ 推荐组合 4A+3A+2A+1A)
**Part of**: YUK-538 ⑬（conjecture-wire #13）。spec：`docs/design/2026-07-04-conjecture-wire-spec.md`。
**Decision source**: owner 2026-07-04 对话——猜测探针生命周期（`serveProbeOnce`/`answerProbe`）是**建好 + DB-tested + 零 live caller** 的 producer/consumer 对；consumer `reconcileConjecturePredictions` nightly cron 真跑但输入集恒空。owner 拍 **wire（不 retire）**，走「isolated probe-answer path that cannot physically reach the FSRS/attempt write」。
**Related**: ADR-0046（Rust 数值核——skill_score_point 是 TS 单点，窗口均 Rust-deferred）· ADR-0036（misconception promote，dark flag）· ADR-0044（event-sourcing 基建——probe_result/prediction_score 是 LOG-only experimental: actions）· a13 design `docs/design/2026-06-27-a13-ts-half-design.md` · 关系脑 roadmap `docs/planning/2026-06-27-relationship-brain-roadmap.md` U3-U8 · prep-desk handoff `docs/design/handoff/2026-06-27-prep-desk-conjectures.md`（UI design-gated）。

---

## 背景

A13 conjecture engine 的 dark-loop 两端都**建好但零接线**：

- **producer**（`serveProbeOnce`/`answerProbe`，`probe-lifecycle.ts`）——DB-tested，三不变量守好（pool-invisibility / ≤3 concurrent / ND-5），但 `acceptConjectureProposal` 只写 rate event、从不调 `serveProbeOnce`；answerProbe 无 caller。
- **consumer**（`reconcileConjecturePredictions`，`reconcile.ts`）——nightly cron 真跑，但找不到 `probe_result` events → `{reconciled:0}` 永远。

owner 不 retire（两端的红线守得对、价值真实），选 **wire**：接通 producer（accept 同步派发 probe）+ 接通 consumer answer 入口（owner 作答 → judge → outcome → answerProbe）+ 建 admin reader（A4：双读 prediction_score + auto-minted kc_typed_state），让「reader before producer」红线**真守**。

## 决定

### 1. Q1 — Probe serve 时机：accept 同步派发（atomic tx）

`acceptConjectureProposal` 在其既有 `db.transaction` 内、rate event + dark promotion 之后调 `serveProbeOnce({ db: tx, ... })`。drizzle 嵌套 `db.transaction` 在外 tx 内是 **SAVEPOINT**，`pg_advisory_xact_lock` 是事务作用域到最外层 tx——cap-serialize 锁跨整个 accept 成立。`cap_reached`（≤3 active 已满）容忍：accept 仍成功，本轮不派 probe（slot 释放后下轮补）。幂等由既有 rate-event short-circuit 守（re-accept 到不了 tx）。

**单写者**：`probe_reference_md`（判分金标）在 induce 时产一次，经 `ConjectureProposalChange` → `serveProbeOnce.referenceMd` → `question.reference_md`，从此不重生成。

### 2. Q2 — Probe answer 入口：judge invoker chokepoint + A5-a outcome→resolution 分流

新 route `POST /api/conjecture/probe/[id]/answer`（token gate，agency manifest）。**ND-5 边界 = `answerProbe`，NOT judge dispatch path。** judge 走 `createDefaultJudgeInvoker().invoke()`——同一 chokepoint submit.ts 也走，但 invoker 本身 judge-only：解析 route → 跑判分（含 semantic 的真 `runSemanticJudge` async LLM 路径）→ emit telemetry，grep `invoker.ts` 零 FSRS/attempt/event 写。submit.ts 的 FSRS 写在 judge 调用**之后**、submit 自己的代码里，不在 invoker 内；本 route 不走 submit.ts（自然不触 FSRS 写），唯一写是 `answerProbe` 的单个 `experimental:probe_result` event。

**早先「isolated registry path（`resolveJudge().run()`）」是缺陷（review PR #705 CRITICAL）**：base registry 的 semantic `run()`（`src/core/capability/judges/semantic.ts`）是 profile-validation STUB，返回 `coarse_outcome: 'unsupported'`——若 route 真走它，每个 free_text probe 都 fail-closed 422，永不写 probe_result，dark loop 保持黑暗。semantic 真判分路径是 `runSemanticJudge`，只能经 invoker dispatch 的 `if (route === 'semantic') return await runSemanticJudge(...)` 分支到达（`invoker.ts:146`）。route 已切换到 invoker 路径（PR #705 fix-lane）。

**A5-a outcome→resolution 分流**（retire 语义从 §8 defer 移入本波）：
- judge `'incorrect'` → outcome=0 → `'confirmed'`（学习者答错判别探针 → 猜测成立 → reconcile 下次 nightly mint 软态 confused-with-X）
- judge `'correct'` → outcome=1 → `'retired'`（猜测被反驳）
- judge `'partial'`/`'unsupported'` → **fail-closed** 422，不写 probe_result，探针保持 active（slot 未消费，owner 可重答或走 admin）

fail-closed 的诚实：partial 在判别探针上不 cleanly discriminate，注入 n=1 校准锚会污染软态信号。

### 3. Q3 — Calibration reader：admin 双读（A4 fix）

新 route `GET /api/admin/conjecture-scores`（token gate，observability manifest），READ-ONLY。spec §6 S4 原案只 SELECT `prediction_score` events——但 A4 发现 consumer 会在 confirmed probe 上 auto-mint `kc_typed_state`（typed_state='confused-with-X'），producer 接通后这些**结构性软态变更**owner 无观测面。**修正**：reader 双读——
- (a) `prediction_score` events（LOG-only 校准锚，诚实 brier/log_loss/skill_score_point 单点 proper score，`score_basis='single_point'` 非「准确度」非窗口均——ADR-0046 Rust-deferred）
- (b) `kc_typed_state` WHERE `typed_state='confused-with-X'`（reconcile auto-mint 的结构性软态，provenance=`evidence_event_ids`）

### 4. Q4 — MISCONCEPTION_PROMOTE_ENABLED flag：不翻，wire only

flag 保持 OFF（dark default）。wire 只接通 probe 生命周期 + reader，不动 promote 闸。promote 翻 flag 是独立决策（owner 手动 + hard-confirm 路径，见 ADR-0036 RT1）。

### 5. answerProbe 幂等：faithful outcome 上报

`AnswerProbeResult` 扩展带 `outcome: 0|1`，幂等路径返回**记录的** outcome/resolution（非当前请求值）。重答不覆盖记录；corrupt row（invalid outcome/resolution）surface 500 不 paper-over。

## 红线守恒矩阵

| 红线 | 守法 | 证据 |
|------|------|------|
| **ND-5**（probe 不写 FSRS/attempt/θ̂） | judge 走 `createDefaultJudgeInvoker().invoke()`（judge-only chokepoint，零 FSRS/attempt 写——ND-5 边界是 `answerProbe`，不是 dispatch path）+ answerProbe 只写 probe_result event | `probe-answer.ts` import createDefaultJudgeInvoker + `invoker.ts` grep 零 fsrs/attempt/event 写 + `probe-lifecycle.ts:194` 注释 |
| **Pool-invisibility** | `serveProbeOnce` 写 `draft_status='draft'` + `source='mind_probe'`，due-list `notDraftQuiz` 排除 | `probe-lifecycle.ts:165-170`（已存，S1/S2 未动） |
| **≤3 concurrent active** | `pg_advisory_xact_lock` + count-then-insert 在 tx 内 | `probe-lifecycle.ts:129`（已存） |
| **Reader before producer** | A4 双读：prediction_score + kc_typed_state | `conjecture-scores.ts` loadConjectureScores 两 query |
| **n=1 calibration 诚实** | skill_score_point 单点 proper score，非窗口均；无「accuracy」字段 | `conjecture-scores.ts` score_basis + scoring.ts 单点 |

## Consequences

- **producer 通电**：accept conjecture → 同步派发判别探针（≤3 cap，best-effort）。
- **consumer 通电**：owner 作答 → judge → outcome → probe_result event → reconcile 下次 nightly mint 软态 + 写 prediction_score LOG。
- **owner 观测面**：admin reader 看校准锚 + auto-minted 软态，无盲区。
- **retire 语义**在本波就引入（非 defer）——猜测被反驳的探针 retire，不 mint confused-with-X。
- **未做（S3b）**：prep-desk card 作答区 UI 是 design-gated（`docs/design/handoff/2026-06-27-prep-desk-conjectures.md`），需 design pre-flight + owner approve，本 ADR 不含。
- **multimodal probe**：probe question kind 默认 `short_answer` → semantic judge（local cost）。multimodal probe（kind 带图 → multimodal_direct judge OAuth lane）是 follow-up，runbook 见 conjecture-wire runbook。
