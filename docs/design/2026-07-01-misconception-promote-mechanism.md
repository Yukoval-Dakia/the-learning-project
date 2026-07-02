# MISCONCEPTION_PROMOTE：更科学的晋升机制设计

- **日期**：2026-07-01
- **状态**：设计完成 / 提案（待 owner 拍 Tier + 4 旋钮）。是 `2026-07-01-misconception-model-investigation-and-implementation.md` open-question #4（"翻 `MISCONCEPTION_PROMOTE_ENABLED` 吗、何时、怎么翻"）的**深答**。
- **相关**：YUK-531（RT1 身份基建，已 dark-ship）、YUK-440（kc_typed_state）、YUK-454（cause/misconception 系统）、YUK-468（probe）；ADR-0035（软轨红线）、ADR-0036（三层分离）、ADR-0046（proper-scoring Rust-first + FLIP deferred）
- **方法**：11-agent 设计工作流（4 正交科学视角 measurement/falsification/dynamics/pragmatic → synthesis → 3 视角对抗 review 科学严谨/红线可行/n=1 反过度工程 → 和解 tiered）。全部代码事实基于 origin/main `b0ceac0b`，主 session 直读复核。

---

## 0. 一句话结论

**"更科学"不等于"加个贝叶斯模型"。** 它 = **把这个代码库已经 ship 的证伪机器接进 promotion 决策**，用一个**可区分、独立性感知的两轨决策**替换 `recurrence ≥ 2`。绑定问题从"复发了吗？"变成 **"这些证据能不能把'持有误区 M'和'只是缺技能 S'区分开？"**（R3 可识别性 / SISM）。三个对抗 reviewer 一致收敛：**这个区分是定性的、n=1 安全的——它不需要贝叶斯后验**。故推荐 **Tier 1 now / Tier 2 defer（Rust-first）/ Tier 3 n=1 不建**。

---

## 1. 当前机制的精确形态（shipped，自 grounding）

> 全部 `file:line` = origin/main `b0ceac0b`。

1. **归纳**（nightly，确定性 `gatherConjectureEvidence` @ `src/server/conjectures/evidence.ts:86`）：把失败聚成 `(cause_category × knowledge_id)` cell；`recurrence_count` = 不同失败 attempt 数 ≥ `CONJECTURE_RECURRENCE_FLOOR`(=2, :28)。每 cell 快照 `theta_hat / theta_precision / baseline_p(= PFA p(L)) / probe_here(precision<1.5, :122)`。`induceConjecture`（Opus N=3 self-consistency）写 ai_proposal，带 `claim_md / knowledge_id / cause_category / confidence(主观 LLM 数) / recurrence_count / probe_md / discriminating(bool) / predicted_p / baseline_p_at_induction`。
2. **probe 轨（独立，当前 inert）**：`reconcile.ts` 用 `scorePrediction`（`scoring.ts:34`，Brier(predicted_p vs baseline_p) + log-loss + 单点 skill）打分 → 追加 LOG-only `experimental:prediction_score` 事件 → `upsertKcTypedState`。`confused-with-X` commit 门（`typed-state.ts:48` `nextTypedState`）要 `discriminating && recurrence≥2 && 具名 confused_with_kc_id`——但 `reconcile.ts:268` **硬编码 `confused_with_kc_id: null`**，故 `confused-with-X` 永不点亮。**"beats baseline" 窗口均值 + 标签 FLIP 是 Rust-owned + DEFERRED（ADR-0046）**；`scoring.ts` 是单点 JS stub，只 LOG 不翻。
3. **晋升**（`misconception-promote.ts`，flag `MISCONCEPTION_PROMOTE_ENABLED` 默认 OFF）：owner **accept** 一个 conjecture → 铸 misconception `source='soft'`, `status='active'`, `seen=recurrence_count`, `weight=归一 LLM confidence`，确定性 id `sha256(cause::kc)`（:85）+ `caused_by` 边。`K_PROMOTE=2`（:39）**冗余死闸**（所有 conjecture 已 ≥2，注释自陈）。真正的闸 = flag + human-accept。注释明写 **"only the probe one-shot (a LATER TASK) mints a HARD-confirmed weakness"** = **hard 轨（source='hard'）没建**。晋升**完全不看** probe/scoring/区分机器。

**净**：当前"机制" = `recurrence≥2 归纳 conjecture → owner 点 accept → 铸 soft misconception`。证伪原语全建好了，但喂一条独立 inert 的 `kc_typed_state` 轨，**没接进晋升**。无校准后验、无独立性加权、无"持有 M vs 缺技能 S"区分、无证伪/稳定性测试，hard 轨不可达。

---

## 2. 分 Tier 设计

| | 内容 | n=1 justified？ | Rust/ADR-0046 |
|---|---|---|---|
| **Tier 1（现在 ship，推荐）** | 区分门 + 稳定性 + 判决性实验二值 + dedup + 可达但 dark 的 hard 轨 + F1 bug 修复 | **完全是**——全计数/二值读/枚举，零拟合，0 新列 | **纯 JS 无数值核 → 零 ADR-0046 张力** |
| **Tier 2（defer）** | B₁ 贝叶斯后验（WoE + Kish n_eff + slip/guess 先验 + 定性 band） | **弱——推迟**：owner 每次在环里，B₁ 只 pre-filter；~16 个 n=1 无法校准的常量 | **B₁ 是净新数值核 → 必须 Rust-first** |
| **Tier 3（n=1 不做）** | 共存激活 `R(M,c,t)` + 类型分动力学 | **否**：单用户几乎不会让 5 类情境的 R 分叉 | — |

### Tier 1 — 最小、n=1 可 ship（推荐 NOW）

*已经更科学*的最小改动。全是**计数 + 二/三值读 + 枚举**——无数值核、无拟合、0 新列。

- **两轨管道**：`PromoteConjectureInput` 加 `source?: 'hard'|'soft'`（默认 `'soft'`）+ `misconceptionHardConfirmEnabled()` dark flag（OFF）。
- **F1 前置（与 source 参数一起落，不可拆）**：soft upsert 的 `onConflictDoUpdate` 必须**永不把 `source` 从 hard 回退成 soft**，且**不能无条件把 `archived_at` 重置为 null**；upsert 包 **misconception 命名空间 advisory lock**（镜像 `kc_typed:<kind>:<id>` → `misc:<id>`）。缺此，两轨组合是 live 降级/翻来覆去 bug（§4）。
- **区分门（真正的进步，n=1 安全）**：铸一个**持有的**误区要求 ≥1 个**可区分情境** = 高掌握度下的错误 **且** 应答**M-诊断性**（匹配 distractor tag / rubric facet——**不只是"意外答错"**；C1-O3：`p(L)` 单独当 δ 会放大高掌握度**手滑**）。就是两个事实（`p(L)` band + M-诊断性）的三值读，无累加器。
- **`isCrucial` 二值可采性门**：`discriminating && |predicted_p − baseline_p| ≥ δ_sep`，复用 `scoring.ts` 单点 `skillScorePoint`。**不用 Brier 窗口均值**（Rust-deferred）。
- **独立性感知证据（廉价形）**：`n_dedup` = 不同 `(question_id, session_window, judge_run_id)` 元组数（self-consistency 三连 / 重跑塌成 1 单位）。是 **dedup 计数**，非 Kish `n_eff` 算术——修掉计数陷阱最坏的部分而不上后验。**一个吵闹/重复的 judge 无法强推一次铸造。**
- **稳定性门**：`contextSpread ≥ 2`（反 bug 迁移，VanLehn；承重子条件——`Δt`/`nonRefutingProbes` 在 n=1 弱但免费 log）。
- **hard 轨：可达但 dark + 诚实**：`decideDissociation` 只在 `≥1 isCrucial confirmed & since 之后 0 retired & contextSpread≥2 & M-诊断 & 强制 owner 新鲜确认` 才 `soft→hard`，且**题池无能分离对手 M′ 的 probe 时封顶在 `emerging` 永不到 hard**（C1-O1：判决性实验只把 M 和 baseline 分开、不和对手 M′ 分开）。flag 关时结构上不可能返回 `HARD_CONFIRM`。
- **retire 臂（LIVE）**：probe `retired` / 长期不复发 → `weight` 衰减 → `fading` 显示投影。**`weight` 文档化为"存在-普遍度"（非单调、复活即 un-archive），绝不是每情境激活强度**（C1 watch：否则悄悄把红线禁的 OBJECT 标量搬回来）。
- **晋升后（精简）**：`last_discriminating_activation` recency → `{active, quiet}` band。复活即 un-archive（立即、无门）。
- **归档诚实**：`cause_category → resolution_class` **读时映射** → `{resolved（程序性）, dormant（直觉/本体性）}`；对持久类型"治愈"**机器不可表达**。0 列。

**买到**：证伪接进晋升；持有-M vs 缺技能不再混；一次坏考不能铸身份；吵闹 judge 不能强推（dedup）；非对称确认；F1 bug 修掉。**代价**：`misconception-promote.ts` 几十行 + 新 `hard-confirm.ts` + 锁/条件 set。旋钮：`δ_sep`、recurrence floor（已有）、recency 窗。**n=1 justified？完全是**——每个门是计数或二值读，零拟合，区分进步是定性的、单事件即触发。

### Tier 2 — 校准（defer 到 Rust scoring lane 后面）

加 **B₁ 贝叶斯后验**：`L_post = L₀ + (n_eff/n_dedup)·Σ δᵢ wᵢ`，`P_hold = σ(L_post)`，WoE 权 `wᵢ = ln(se/(1−sp))` 封顶 `w_max`，Kish `n_eff = n_dedup/(1+(n_dedup−1)ρ)`，`κ₀` 先验收缩，`π₀` 课程先验，定性 **band（5→3 塌）**。对抗轮修正：

- **删掉所有 SPRT / α-β / Wald A,B 语言**——阈值是对*实际的*封顶+收缩更新做**模拟标定的 operating points**（C1-O2, C3-O3）。
- **δ 变 M-诊断性加权**：`δᵢ = p(L)ᵢ · d_M(responseᵢ)`，门在掌握度的**下置信界**、非点估（C1-O3）。
- **Rust-first（ADR-0046 §4）**：log-odds/σ/WoE/Kish 是净新数值核 → 与 `scoring.ts` 窗口替换一起在 Rust 建，或 prototype-JS→**port→delete**（§5）。JS 只留编排 + band 离散。
- **`se/sp/ρ`** 现在只是固定 humility floor；**gold-set 混淆矩阵标定**是数字*有意义*的前提（C1-O5）。

**买到**：给 owner review 的一个**原则化 ranker/pre-filter**（更好排序 owner 看到什么）；`1/ρ` 天花板 + WoE cap 让 railroading 数值上不可能；先验→证据优雅收缩。**代价**：Rust 核 + ~8 个 n=1 无法验证的常量 + operating-point 模拟 harness；重新引入"读 p(L) 当 δ 又估自己潜变量"的张力（C3-O1）。**n=1 justified？弱——defer。** owner 每次铸都在环里，B₁ 只 pre-filter；且设计自己的算例显示五次可区分失败才勉强到 0.76——区分 regime 在 n=1 不到来。只在 (a) owner review 量大到需要校准排序 或 (b) Rust 核为 `scoring.ts` 落地时 B₁ 顺带便宜骑上 才证成。

### Tier 3 — 动力学（n=1 不做）

加**共存激活** `R(M, c, t)` + **类型分归档动力学**。对抗轮修正——synthesis 原版**不能照写 ship**：

- **把 `R` 拆成 `(cue_rate, override_reliability)`** 每情境（diSessa 二维）。只衰减 `override_reliability`（抑制消退→风险*升*）；对直觉/本体类型 `cue_rate` **保持在潜在水平不 passive fade**（Shtulman/Potvin）；activation-decay-toward-0 只留给 `procedural`。synthesis 的单标量指数衰减到 floor 对"持久类型"**经验上是反的**（C1-O4）。
- 仍是读时 fold（永不列），但它是**第二个遗忘调度器**、5 情境类 × 衰减常量、**5× 数据稀缺**（C3-O4）。

**买到**：每情境、负荷敏感、复活感知的风险——对多遇历史真更丰富。**代价**：~10+ 常量；5× 稀缺；即便是 fold 也与"M 上无调度器"精神张力；若映射升级为 `resolution_class` 列 + Opus 分类器则 5-surface 税。**n=1 justified？否。** 自用户几乎不会让 `R` 在 `symbolic/qualitative/real-world/transfer/timed` 分叉。Ship Tier 1 的 `{active, quiet}` recency band + 归档映射；两参数模型只在 n≫1 建。

---

## 3. F1 潜伏 bug（Tier 1 的硬前置）

`misconception-promote.ts` 的 `onConflictDoUpdate`（:175-188）在冲突时**无条件 set `source: parsed.source`**（对 dark 路径永远 'soft'）**和 `archived_at: null`**，且**整个 upsert 无 advisory lock**。今天单轨全 soft、无并发写 → 无害。但**一旦两轨并存**：重新 accept 一个 conjecture（同 `cause×kc` 的确定性 id）会**静默把一个 hard 节点降级成 soft + 复活已归档的边**——一个 live 降级/翻来覆去 bug。**修法（与 `source` 参数同一 PR）**：① conditional set——`source` 只允许 soft→hard 单向、永不回退；`archived_at` 不无条件重置；② `misc:<id>` 命名空间 advisory 锁（镜像 `upsertKcTypedState` 的 `kc_typed:` 锁）。**这是 dark 两轨翻转的硬前置，不能拆成独立 follow-up 之后再补。**

---

## 4. reconcile.ts:268 判定（对 2026-07-01 投资 doc 的修正）

上一份投资 doc 把"Phase 1 probe-resolution loop（修 `reconcile.ts:268` 的 null 硬编码）"叫"90% 的解锁"。本机制设计给出**更精确判定**：**promote-identity 的区分轴**（held-M vs 缺技能，走 `skillScorePoint`+`discriminating`）和 **`kc_typed_state` 的 `confused-with-X` 轴**（KC_a↔KC_b 混淆）是**两条不同的轴**。

- **对 promote 机制本身**：宣布 **B₂（新鲜读 `prediction_score`/`probe_result` 事件）为区分 SoT**，**不依赖修 reconcile.ts:268**。别在两条 inert 轨上再叠第三条 live 区分轨（C2-F5）。
- **reconcile.ts:268 死 ledger**（每 cell 卡 `no-evidence`）= **正交技术债**：要么把 :268 接真实 `confused_with` KC（服务 Option-B 关系轴 + YUK-533 confusable_with），要么退休 `kc_typed_state`——**单独 follow-up，明确不在 promote 机制 scope 内**。

两条轴都真实、互补，不矛盾——上次是我混谈了。**修正**：投资 doc 的"Phase 1 = 90%"应读作"服务 confused-with-X 关系轴的解锁"；promote-identity 轴有自己的区分门。

---

## 5. 具体接线

**改的文件/函数（Tier 1）：**

| 改动 | 文件 | 内容 |
|---|---|---|
| **新** `source?: 'hard'\|'soft'` 参 + `misconceptionHardConfirmEnabled()` | `src/capabilities/agency/server/misconception-promote.ts` | ~9 行；默认 `'soft'` |
| **F1 修（前置）** | 同上 | `onConflictDoUpdate` conditional：`source` 永不 hard→soft、`archived_at` 不无条件重置；**advisory 锁** `misc:<id>` |
| **新** `gatherDissociationEvidence` + `decideDissociation` | 新 `src/server/conjectures/hard-confirm.ts`（`reconcile.ts` 的姊妹、**不在其内**——import-ring 纯净） | ~30 行，纯读 `prediction_score`/`probe_result` 事件 + 稳定性事实；rival-probe 守卫；flag 关 ⇒ 不返回 `HARD_CONFIRM` |
| 扩展暴露 `n_dedup`/`contextSpread`/区分 flag | `src/server/conjectures/evidence.ts` | 计数 + 读 `baseline_p`/`p(L)`；**无列** |
| **原样复用** | `scoring.ts`（单点 `skillScorePoint`）· `probe-lifecycle.ts` · `conjecture-accept.ts` | isCrucial 判别 · 判决性实验产生器 · 身份铸造（+ 强制新鲜 hard 确认） |

**复用原语（无新机器）**：`gatherConjectureEvidence` cause×KC cell · `scorePrediction` 单点 · `serveProbeOnce`/`answerProbe` · `discriminating` 旗标 · `source/status/seen/evidence/weight/archived_at` 列 · 确定性 `misc_<sha256(cause::kc)>` id + `onConflictDoUpdate` · `misconceptionPromoteEnabled()` 模式 · `fading`/`retracted` 显示投影。

**Rust-deferral 边界（ADR-0046）：**
- **Tier 1 全 JS 且合法 live**——计数 + 枚举 + 时间戳，**无数值核 → 零 ADR-0046 张力**。这是"单 ship Tier 1"的决定性优势。
- **Tier 2 B₁ = 净新数值核 → Rust-first**（§4），与 `scoring.ts` 窗口均值替换一起，或 prototype→port→delete（§5）。
- **Rust-gated + dark**：Brier**窗口均值**（C2），`source: soft→hard` 标签翻转（behind `MISCONCEPTION_HARD_CONFIRM_ENABLED`）。
- **Live（非确认标签翻转）**：retire → `weight` 衰减/`fading`；复活即 un-archive（立即、无门）。

**新 schema 列？** **Tier 1 & Tier 2 各 0 列**——两轨翻转、后验、retire、recency、归档全是读时投影 + `experimental:*` log 事件 + 现有 `evidence` jsonb。**唯一可选列** `resolution_class` 只在 Tier 3 想要 Opus 分类器覆盖时——触发 5-surface 税（schema/migration/audit:schema/export FK_ORDER+SCHEMA_VERSION bump/db.ts ALL_TABLES）。默认走 `cause_category → resolution_class` **读时映射**。

---

## 6. 红线合规（7 条 × 3 tier）

| # | 红线 | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|---|
| 1 | M 上不**写** mastery/θ̂/p(L)/FSRS/difficulty | **PASS**——读 `baseline_p`/`p(L)`；只写 `source/status/weight/seen/evidence/archived_at`；band 是投影；`.strict()` 机检 | **PASS**——后验算不存 | **PASS iff** `R` 留 fold；`weight` 文档化为普遍度 |
| 2 | n=1 无**拟合**参数 | **PASS**——只计数+二值读 | **WATCH**——冻结系数仍是影子估计器叠 `p(L)`；`se/sp` 不得从该学习者拟合 | **WATCH**——5 类衰减 n=1 永不验证 |
| 3 | promote-not-copy + human-accept | **PASS**——同确定性 id upsert；**F1 修**；hard **强制新鲜** owner 确认 | 继承 | 继承 |
| 4 | ADR-0046——confirm-flip Rust-deferred，无 JS 翻转 | **PASS（干净）**——无数值核 | **CONDITIONAL**——B₁ 算术**必须 Rust-first** | 继承 |
| 5 | cold-start day-one 可用 | **PASS**——authored catalog + owner-hard n=0 即活；evidence-hard 门诚实地高 | **PASS**——`π₀` 先验即 n=0 后验 | **PASS**——`R_prior` 收缩 |
| 6 | anti-guilt——无裸 confidence/计数过 wire | **PASS**——server 侧 band 枚举 | **PASS**——float 不过 wire | **PASS** |
| 7 | 新列（5-surface 税）必要？ | **PASS——0 列** | **PASS——0 列** | **1 可选**（`resolution_class`，可用读时映射避免） |

---

## 7. Current vs Proposed

| 维度 | 当前（shipped） | Tier 1（现在提案） | +Tier 2 | +Tier 3 |
|---|---|---|---|---|
| 晋升触发 | `recurrence≥2` 计数 | 区分门(M-诊断)+`n_dedup≥2`+`contextSpread≥2`+owner accept | 校准 `P_hold` band | — |
| 持有-M vs 缺技能 | 混谈 | **二值区分门**（定性） | soft `δ` 折扣 | `discriminating`-only `R` |
| judge 保真/独立性 | N 相关 = N 独立 | dedup 塌（吵闹 judge 封顶） | WoE `se/sp` cap + Kish `1/ρ` 天花板 | — |
| 确认语义 | 只 `soft`，无 hard | 非对称 hard 轨、**dark**、rival-诚实、强制新鲜确认 | `P_hold ≥ τ_hard` | — |
| bug 迁移 | 无 | `contextSpread≥2` 守卫 | — | — |
| 降级/锁 bug | **潜伏（F1）** | **修掉**（conditional set + 锁） | — | — |
| 晋升后生命 | 静态节点 | `{active, quiet}` recency band | — | `(cue_rate, override_reliability)`、正确衰减方向 |
| 归档 | 无 | 类型分读时映射；持久类型"治愈"不可表达 | — | 动力学驱动 |
| schema 成本 | — | **0 列** | **0 列** | 1 可选 |
| Rust 边界 | 单点 Brier logged | **全 JS 无核** | B₁ **Rust-first** + 窗口均值 deferred | — |

---

## 8. 对抗轮和解 ledger（保留科学诚实痕迹）

| 对抗发现 | 裁决 | 去向 |
|---|---|---|
| 区分（held-M vs 缺技能）是真进步且**定性、n=1 安全**（三家收敛） | **CONCEDE + 抬升** | Tier 1 核心 |
| `contextSpread≥2` 反 bug 迁移廉价 n=1 安全 | **CONCEDE + 留** | Tier 1 |
| 类型 taxonomy → **读时归档标签**，0 列 | **CONCEDE** | Tier 1 |
| "它*是* Wald SPRT α=.05/β=.20" | **CONCEDE 全删框架** | Tier 2 用模拟 operating points |
| δ=p(L) 单独放大高掌握**手滑** | **CONCEDE** | 区分门必须 **M-诊断**、每 tier |
| 判决性实验分 M vs baseline、**非 vs 对手 M′** | **CONCEDE** | 无 rival-probe 时封顶 `emerging` |
| B₁ 后验是净新数值核 → ADR-0046 Rust-first | **CONCEDE** | B₁ → Tier 2 + Rust-first |
| 全 B₁ 累加器是 human-gate 在 n=1 不需要的并行估计器 | **CONCEDE** | B₁ → Tier 2 defer |
| soft upsert 静默**降级 hard→soft + un-archive**；无锁（F1） | **CONCEDE——硬前置** | Tier 1 wiring |
| hard 翻转做成 owner-**可选** | **CONCEDE** | Tier 1：强制新鲜确认 |
| B₃ `R` 衰减对直觉/本体类型**反了**；塌 diSessa 二维成单标量 | **CONCEDE** | Tier 3 拆 `(cue_rate, override_reliability)`；单标量版不 ship |
| §5 "n≈2→soft mint" 与自己的数学矛盾（需 ~5 单位） | **CONCEDE** | 删该说法 |
| WoE 累加器教科书正确；`R`-as-function；"治愈"不可表达；两层分；非对称确认 | **DEFEND——留** | 保留（WoE 只在 Tier 2 激活） |
| `se/sp/ρ` 未标定 | **PARTIAL** | 现在固定 humility floor；gold-set 标定是 Tier 2 前提 |
| `kc_typed_state`/`reconcile.ts:268` 死 ledger | **DECOUPLE** | 正交轴；单独 follow-up，非本机制 scope |

---

## 9. Owner 决策

**推荐路径（决断）**：**现在 ship Tier 1。Tier 2 defer 到 Rust `scoring.ts` lane 后面。n=1 不建 Tier 3。** Tier 1 就是 n=1 能证成的全部进步（区分 + 稳定性 + 判决性实验二值 + human-accept），零 ADR-0046 张力，还修 F1 真 bug。Tier 2-3 是 n≫1 机器，且各自还得先落它们的对抗修正才能*更晚*ship——所以今天推迟零成本。

**只有 owner 能拍：**
1. **哪个 tier now**——推荐 **Tier 1**（强推），或 Tier 1 + 在 §5 port-delete 下 prototype Tier 2。
2. **authored-hard 权威（n=0 seam）**：owner 断言"我知道这是持有的"能否**直接**铸 `source='hard'` 绕过证据门？（策略非代码，cold-start-first 杠杆。）
3. **`kc_typed_state`/`reconcile.ts:268` 死 ledger**：接真 `confused_with` KC，还是退休 ledger？（单独 scope 决策，C2-F5。）
4. **Tier 1 旋钮（唯一现在活的）**：`δ_sep`（proper-distractor 分离度 ≈0.20 Köhn-Chiu-Wang）· recurrence floor（`n_dedup≥2`，已有）· `{active,quiet}` recency 窗 · `cause_category → resolution_class` 映射（哪些 cause = procedural vs intuitive/ontological）。
5. **Tier 2 旋钮（仅 B₁ ship 时，全 owner/课程先验、绝不拟合）**：`π₀`（每 subject-profile 普遍度）· `κ₀`（先验强度）· `se/sp`（每保真 band）+ `ρ`（每相关 tier）+ `w_max` cap（humility floor 到 gold-set 混淆矩阵存在前）· `τ_surface/τ_promote/τ_hard/τ_retire`（**模拟**定，非 Wald）。前提：judge 可靠性研究（C1-O5）。

---

## 10. Linear follow-up 映射（挂 YUK-531 / A5 S4 / ADR-0036 RT1 / ADR-0046，搜重后）

1. **Tier 1 impl**——`source` 参 + `hard-confirm.ts` + 区分/contextSpread 门 + recency band + 归档映射。
2. **F1 作为 dark 两轨翻转的硬前置**——`source` 永不回退 + `misc:<id>` advisory 锁。**与 (1) 同 PR，不拆。**
3. **Tier 2 B₁ Rust-first 核**——blocks on / rides `scoring.ts` 窗口替换（ADR-0046）。
4. **gold-set judge 可靠性标定**——为 `se/sp/ρ`。
5. **rival-separating-probe authoring 能力**——解锁诚实 M-vs-M′ hard-confirm。
6. **`reconcile.ts:268` / `kc_typed_state` 死 ledger 决策**——接真 confused_with 或退休。
7. **Tier 3 拆-`R` `(cue_rate, override_reliability)` 模型** + 可选 `resolution_class` 列（5-surface 税）。

> F1-F5 无一值得*新*父单——按 capture gate 折进上述。**本 doc 是提案，phases 未获 owner 批前不预建实施 issue**（避免加剧 Linear 腐败）。

---

## 附录 — 科学依据锚点（详见 2026-07-01 投资 doc 附录 A）
- **区分/可识别性**：R3 CDM——M ≠ 缺技能 只有在"有技能仍暴露 M / M 产生独特错答"时可识别（SISM, Kuo/Chen/de la Torre 2018）。distractor（开放题=编码错误）是提供分离的观测。
- **判决性实验/证伪**：Popper crucial experiment；R2 VanLehn **bug 迁移**（闪烁的 bug 不铸稳定身份，稳定的是 impasse）。
- **独立性/judge 保真**：R5——LLM judge 误差**系统相关**（两次抽样非独立）；distractor 域模拟保真 31-47%，开放题更差。
- **共存/不根除**：R1 Shtulman & Valcarcel (2012)——朴素概念被**抑制非删除**、可逆、负荷下复活；单调 mastery→0 是范畴错误。diSessa 二维 `(cuing, reliability)`。
- **proper scoring / Brier skill**：R3 + `scoring.ts`（单点 live，窗口均值 Rust-deferred ADR-0046）。
