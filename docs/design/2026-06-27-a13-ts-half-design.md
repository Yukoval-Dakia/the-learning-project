# A13 TS-orchestration 半边设计 + 实施计划（critic-corrected blueprint）

**来源**：YUK-440（A13 prediction-grounding loop + typed KC ledger）⊕ YUK-406（教研团 Phase 0 conjecture 引擎，「build once = same mechanism」）。owner 2026-06-26 拍：起 A13 TS 编排半。
**方法**：5-agent design workflow（3 Map scout 逐行核码 + Design 统合 + 对抗 Critic）。本文 = workflow design + critic 6 修正 fold 后的**实现蓝本**。
**Scope**：predict→store→outcome→score(stub)→update-typed-state→claim-survival loop + typed KC ledger + 例会 job + conjecture/probe-as-event + proposal + FSRS-decay 读。
**OUT**：Rust proper-scoring kernel（ADR-0046，仅 stub）· 备课台 UI（claude-design-gated）· consistency-gate（YUK-344）· matcher live-caller（YUK-400）。

---

## 1. Fork resolution（headline）

**YUK-440「建 `kc_typed_state` 表」 vs YUK-406「不建表、conjecture-as-event」= 两个互补层 + 一个被推迟的 ACT，三者分开排程。**

- **YUK-406 层 = conjecture/probe 是 EVENTS**。`writeAiProposal` default 分支（`src/server/proposals/writer.ts:86-95`）把任何非 `knowledge_node|knowledge_edge` kind 写成 `experimental:proposal` + `{ai_proposal}` payload，inbox 自动 derive → 新 `conjecture` kind **零 writer 改动**。`ExperimentalEvent`（`experimental.ts:186-197`）松守 `experimental:*` → `experimental:probe_result` / `experimental:prediction_score` **零 schema-file 改动**。
- **YUK-440 层 = typed KC ledger 是 single-writer PROJECTION over RESOLVED evidence**，逐字镜像 `mastery_state`（`schema.ts:870-914`，派生诊断投影 + `uniqueIndex(subject_kind,subject_id)` + advisory-lock 单写者）。
- **被推迟的不是 build，是 FLIP**。YUK-440 收紧措辞「ship loop + schema NOW；DEFER 『改善预测』claim」；owner 永久记忆 `feedback_defer_flip_not_build`（数据门只 gate 翻转不 gate build）。

**决定（committed for TS-half MVP）**：

| 层 | 何时 | 形态 |
|---|---|---|
| conjecture/probe/score = events | 现在 | 三个 `experimental:*`，走现有 escape hatch（零 schema-file 改动） |
| `kc_typed_state` 表 | 现在 | 命令式 single-writer upsert（`mastery_state` 模板），5-surface 注册 |
| typed-state 写触发 | 现在 | **仅确定性 probe-resolution**（confused-with-X / resolved / 回落 no-evidence），不需 scorer |
| **claim-survival FLIP**（让 score 移 label/`mastered`） | **推迟** | gate 在真 Rust scorer（ADR-0046）+ owner 数据；MVP 只 **LOG** 比较（append `prediction_score`），**绝不让 score 移 label** |

**ES 不分叉**：`kc_typed_state` 新表、ES fold 线（`src/core/projections/*`，YUK-471 W3 进行中）不碰它（同 `mastery_state` 与 ES 共存）；单写者纯从 event 派生，YUK-471 日后可加 `foldKcTypedState` reducer 复现（`materialized_id_index` 是 build-now-fold-later 先例）。**前提见 §修正-3：R(t) 不得进 written state，否则破投影纯度。**

**关键洞察（loop 闭合）**：mem0 无 p̂ 字段。把预测**绑在 conjecture 上**（`predicted_p`）= 诱导出的 claim 隐含对其 probe 的 p̂ → conjecture **就是** qualitative claim、probe outcome **就是** 预测测试、`scorePrediction(predicted_p, baseline_p, outcome)` **就是** claim-vs-baseline 打分。一个统一 loop = owner「build once」落地。

---

## 2. 数据模型

### 2.1 Conjecture proposal kind（`src/core/schema/proposal.ts`）

```ts
export const ConjectureProposalChange = z.object({
  claim_md: z.string().min(1).max(280),            // 2nd-person 信念单句（"你把链式法则当成导数相乘"）
  knowledge_id: z.string().min(1),                 // 挂靠单一 KC
  cause_category: CauseCategory,                    // 复用 src/core/schema/cause.ts
  confidence: z.number().min(0).max(1),            // 内部排序/校准 ONLY，read model 剥离，永不渲染
  recurrence_count: z.number().int().min(2),       // 取证下限 CONJECTURE_RECURRENCE_FLOOR=2
  probe_md: z.string().min(1).max(2000),           // 恰一道未跑的判别 probe
  discriminating: z.boolean(),                     // 见 §修正-4：probe 是否「仅此误解产此错答」（confused-with-X 写前置）
  corrected_by_owner: z.boolean().default(false),  // 备课台 edit 才翻 true（MVP 恒 false）
  predicted_p: z.number().min(0).max(1),           // claim 隐含「答对该 probe」概率（可证伪面）
  baseline_p_at_induction: z.number().min(0).max(1),// 诱导时 snapshot 的 PFA/θ baseline（要打败的数）
});
```
union 分支 `kind:'conjecture'`，`target.subject_kind:'mind_model'`（subject_id = knowledge_id）。provenance 复用 `BaseProposal.evidence_refs[]`（`proposal.ts:95-98`，event ids），不在 change 上重复。**MVP 不进 `acceptSupportedProposalKinds`**（propose-only；accept applier 随备课台 lane 落）。

### 2.2 三个事件（全走 escape hatch，零 schema-file 改动）

| action | 写者 | payload | 作用 |
|---|---|---|---|
| `experimental:proposal`(kind:conjecture) | `writeAiProposal` default | `{ai_proposal}` | 存 claim+predicted_p+baseline+probe；provenance=`caused_by_event_id` |
| `experimental:probe_result` | **PR-2 probe-outcome producer（§修正-2）** | `{conjecture_event_id, outcome:0|1, resolution, retrievability_at_judge}` | probe 判别结果（+ §修正-3 的 R(t) snapshot） |
| `experimental:prediction_score` | 例会 reconcile | `{conjecture_event_id, probe_result_event_id, brier_model, brier_baseline, log_loss_model, skill_score}` | scorePrediction(stub) 输出，kc_typed_state 证据行 |

### 2.3 `kc_typed_state` 表（mirror mastery_state；单写者 = `src/server/conjecture/typed-ledger.ts`）

`id` PK · `subject_kind`(default 'knowledge') · `subject_id`(=knowledge_id) · `typed_state`(default 'no-evidence'：no-evidence|confused-with-X|mastered，mastered=FLIP 后才写、MVP 不写) · `confused_with_kc_id`(loose text ref) · `lifecycle`(default 'open'：open|resolved) · `evidence_event_ids` jsonb text[](指回 event.id，loose，无 FK) · `last_evidence_at` · `updated_at`。`uniqueIndex(subject_kind,subject_id)` + `index(subject_id)`。

**5-surface 注册**：①`schema.ts` pgTable ②`db:generate` 迁移 ③`audit:schema`（单写者全列 day-one 写路径，无 allowlist）④`export-constants.ts` FK_ORDER 加 `'kc_typed_state'`（**置于 backup 集**，见 §修正-7）+ `SCHEMA_VERSION '4.9'→'4.10'` ⑤`tests/helpers/db.ts` ALL_TABLES 加 `'kc_typed_state'`（否则 resetDb TRUNCATE 漏扫、DB 测态泄漏）。pre-flight 必含 `reverse_lockstep.db.test.ts` + `backup-import.db.test.ts`（reverse-lockstep 守卫 module-load throw，漏 ④/⑤ 硬挂整个 backup collection）。

---

## 3. The loop + ADR-0046 stub

| 步 | 落点 | 同步? |
|---|---|---|
| predict | 例会诱导步产 `predicted_p` + snapshot `baseline_p_at_induction` | nightly |
| store | conjecture proposal 事件（预测存 payload 上） | nightly |
| outcome | **PR-2 probe-outcome producer（§修正-2）**：probe = 一道题 → 走现有 practice/attempt 答题路 OR job-内判分 → `experimental:probe_result.outcome∈0|1` | 事件驱动 |
| score(STUB) | reconcile：`scorePrediction(...)` 纯函数 | nightly |
| update-typed-state | `upsertKcTypedState`（仅确定性 probe-resolution + §修正-4 门） | nightly |
| claim-survival | **DEFERRED FLIP**：只 append `prediction_score`，不移 label | 推迟 |

**`scorePrediction` stub**（`src/server/conjecture/scoring.ts`）：三标量入（predicted, baseline, outcome）三标量出（brierModel/brierBaseline/logLossModel/skillScorePoint），纯函数无 DB 无 cohort = 结构 n=1-safe（DROP-7 clean）。头注 `// ADR-0046: proper-scoring = Rust-first SoT，本 TS 是占位 stub，待 Rust 线（crates/calibration-native）落地后 bit-exact 替换`。**绝不碰 crate、不 fork Rust kernel**。诚实声明：单点 skill-score 退化；真「beats baseline」= 窗口聚合 `1−mean(BS_model)/mean(BS_baseline)`，该聚合 + FLIP 也 Rust-owned + deferred。

**baseline 读**（n=1-safe）：`getMasteryProjection(db,[kc]).get(kc)?.mastery ?? 0.5`（`state.ts:280`）= p(L)=σ(γ·succ+ρ·fail−β)，读学习者自己计数，`b` read-only（`state.ts:507`），无 cohort、无 item-param fitting。
**mem0 读**：`searchMemories(...)`（`search-memories.ts:121`，read-only attention prior，降级空）喂诱导 prompt；`predicted_p` 由 LLM 诱导，非 mem0 直读。

---

## 4. 例会 job（§修正-1：clone goal_scope_propose_nightly，NOT dreaming_nightly）

**文件**：`src/capabilities/agency/jobs/research_meeting_nightly.ts`，clone **`goal_scope_propose_nightly.ts`**（= thin candidate-picker + dedup + ONE structured-output task + `writeAiProposal` + failure-swallow，`queue:'llm'`）——**不是** `dreaming_nightly`（那是 MCP tool-agent loop，其 `beforeExecute` cost-cap 只在 agent tool-call 时触发，本 job 的确定性 sequential 流根本不碰 MCP tools）。

**顺序步骤**：
1. `getFailureAttempts(db,{since})`（`queries.ts:166`）近窗。
2. **recurrence 聚合（NEW）**：每条 attempt 跑 `effectiveCauseForFailureAttempt`（`cause-policy.ts:36`，user cause 胜 agent judge），按 `(primary_category × knowledge_id)` 滚 cell，`count ≥ CONJECTURE_RECURRENCE_FLOOR(2)` 入选。
3. **§修正-5 cap**：按 salience 取 **top-K cells（CONJECTURE_MAX_CELLS_PER_RUN）**；每 cell `getMasteryProjection` 取 baseline + `retrievabilityForKc` 取 R(t)（仅用于 cell salience 排序，**不进 written state**，§修正-3）。
4. **induceConjecture**：Opus **N=3** self-consistency（`anthropic-sub` OAuth lane）→ claim/probe/`confidence=agreement/N`/`predicted_p`/`discriminating`；全 agent-judge 无 owner cause 时 `confidence ≤ JUDGE_ONLY_CONFIDENCE_CAP(0.5)`。**每 run Opus-call 预算 = K×N，文档化**。
5. **propose**：`writeAiProposal(...kind:'conjecture')`，propose-only。
6. **reconcile**：读上轮 conjecture + 其 `probe_result` → `scorePrediction`(stub) → append `prediction_score` → `upsertKcTypedState`（确定性 probe-resolution 写，§修正-4 门）。**claim-survival FLIP 不接**。

**注册**（唯一登记面，不碰 `scripts/worker.ts`/`handlers.ts`）：agency manifest `jobs.handlers` 加一条，cron 错开（如 `'20 4 * * *'`），`queue:'llm'`。cost cap = **结构性 per-run proposal 上界**（CONJECTURE_MAX_PROPOSALS）+ goal_scope 记的 pre-LLM-reads-rethrow / LLM-half-swallow 非对称。

---

## 5. Critic 6 修正（fold 进上文，逐条溯源）

1. **[MAJOR] clone target**：→ `goal_scope_propose_nightly`（sequential structured-output）非 `dreaming_nightly`（MCP agent-loop，cost-cap 不触发）；`queue:'llm'` IS load-bearing。已 fold §4。
2. **[MAJOR] dark loop**：probe-outcome **producer** 不能 defer，否则 reconcile 永跑空集、`prediction_score` 永不攒 = 违 `feedback_defer_flip_not_build`（collect 不通电=死循环）。→ **PR-2 必含最小无-UI probe→outcome 路**（probe 是题 → 走现有 practice/attempt 答题事件，OR job-内对 probe 已知答案判分）。已 fold §2.2/§3。
3. **[MEDIUM] R(t) 破投影纯度**：R(t)（wall-clock 依赖）若影响 written `typed_state`/`lifecycle`，投影非 event-log 纯函数 → `foldKcTypedState` 无法复现 → 破 ES-no-fork。→ R(t) **只用于 cell 排序/display，不进 written state**；judge 时的 R(t) snapshot 进 `probe_result` 事件供日后 fold 位重放。已 fold §2.2/§3/§4。
4. **[MEDIUM] confused-with-X 语义**：单次 failed probe 可能是该误解 OR 无关因；单 confirm 即写 confused-with-X = YUK-344 consistency-gate 要防的（Phase 0 故意省）。→ `confused-with-X` 写前置 = `discriminating:true`（仅此误解产此错答）**且** ≥2 证据（recurrence_count）；否则落更软的 open 态待二次确认。**明确**：即便 post-Rust-scorer，beats-baseline 只 license「定性轨更会预测此学习者 probe 结果」，**非「误解确认」**。已 fold §2.1/§2.3。
5. **[MEDIUM] Opus cost 无界**：→ top-K cells + N=3 + per-run Opus-call 预算文档化。已 fold §4 步3/4。
6. **[MEDIUM] 跨包深 import**：不泄漏 private `cardFromState`/`scheduler`；→ practice capability 暴露 **public `retrievabilityForKc`**；ts-fsrs v6 `get_retrievability` 签名 impl 期经 context7 核（net-new，grep=0）。
7. **[MINOR] FK_ORDER vs replayable 措辞**：→ 既然 §修正-3 保证 R(t) 不进 written state（纯 event-derived），表理论可 fold-replay；但 MVP 仍入 FK_ORDER backup（安全选择，且 prediction_score 证据链值得备份）。措辞对齐：可 fold ≠ 必须排除备份。

**[MINOR] proposals.kinds 非 gate-enforced**（`validateComposition` 只查唯一性）——加条目正确无害，reviewer 别 block。

---

## 6. 实施计划（PR-1 = YUK-406 Phase 0 event 引擎；PR-2 = YUK-440 typed-ledger + loop）

**PR-1（纯 event 层，可独立 2-week 验收）**
1. proposal kind：`proposal.ts` 加 `'conjecture'` + union + `ConjectureProposalChange`；更新 `inbox-meta.unit.test.ts`（supported∪unsupported===aiProposalKinds，conjecture 入 unsupported）；manifest `proposals.kinds` + inbox-api kindMeta（`isAcceptSupported=false`，现有 ProposalCard 渲染，非备课台）。gate：`pnpm test:unit` 命中 proposal/inbox-meta + typecheck。
2. 例会 job：clone `goal_scope_propose_nightly`，recurrence 聚合 + top-K cap + induceConjecture(N=3) + propose-only + per-run 预算；manifest jobs.handlers 注册；DI seam 注入 fixture DB 测。gate：`pnpm test:db` 命中 job 测（propose-only、cap 生效、conjecture 事件 provenance 回链）。
   - **验收 tripwire（Anki-export）**：产物 = conjecture-with-provenance（claim + evidence_refs 回链 event + 未跑 probe）= Phase 0 必须的「不可导出物」（导不进 flashcard）。能完整导成 Anki 卡 = 退化成「带叙述的 SRS」= KILL。

**PR-2（typed-ledger + 预测接地 loop）**
3. `kc_typed_state` 表（5-surface §2.3）。gate：`audit:schema` + export/backup 测 + `test:migration`。
4. 单写者 `upsertKcTypedState`（advisory lock `kc_typed:knowledge:<id>` 独立 namespace，纯从 event 派生，§修正-4 门）。gate：DB 测（并发串行化、确定性转移、evidence 接线）。
5. `scorePrediction` stub + public `retrievabilityForKc`（§修正-6）。gate：unit 测（公式/clamp/n=1 三标量；R∈[0,1] 复用单实例）。
6. **probe-outcome producer（§修正-2）** + reconcile 接入：predict→outcome→score(stub)→append prediction_score→update-typed-state；FLIP 不接（只 LOG）。gate：DB 测（prediction↔outcome 按 KC+窗口 join、append、kc_typed_state 仅 probe-resolution 写、**断言 score 不移 label**、R(t) 不进 written state）。

**n=1 安全（贯穿）**：scorePrediction 三标量无 DB/cohort；baseline 读自己计数、`b` read-only、不估 item param；不碰 crate。DROP-7 clean。
**Linear**：无需新 issue——fork-reconciliation + critic 6 修正记进 YUK-440 + YUK-406（权威父单）。

---

## 7. Open decision（owner）

**已决（不需 owner）**：fork=互补两层+推迟 FLIP · conjecture=propose-only · 三事件松守 escape hatch · clone goal_scope_propose_nightly/queue llm · predicted_p 绑 conjecture · claim-survival FLIP gate 在 Rust scorer+owner 数据 · 6 critic 修正全 fold。

**唯一真 fork（排程/风险胃口）**：`kc_typed_state` 表落本 wave 哪个 PR？
- **(推荐) split**：PR-1 先独立 ship 纯 event 层（= YUK-406 Phase 0 conjecture engine，独立验收 + 自然 checkpoint）；PR-2 加表 + loop。
- **combined**：表+event 同 PR 一次落（少一次 wave 协调，但与 canonical doc「Phase 0 event-only」分期张力更大）。

两者都建表（owner build-not-gate + YUK-440 ship-schema-now 已定调），分歧仅排程。
