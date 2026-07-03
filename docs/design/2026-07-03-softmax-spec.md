# Design — `default-softmax-selection-policy` (worklist #7) — RECONCILED FINAL

> **Status: reconcile 终裁稿（2026-07-03）。** Draft → Lens A（统计正确性）+ Lens B（工程/运行时）双对抗审 → 本终稿。全部存活 MAJOR 已修入；逐条裁决见附录 2（Attack 裁决 ledger）。
> Ground truth: main `f7726c6c`（session HEAD `8acc83dd` 的 verified ancestor；六个 touched 文件 `git diff --stat f7726c6c HEAD` 为空——工作树即 f7726c6c 态）。所有 file:line 已由终裁 pass 对 `f7726c6c` 逐个重接地（含双方争议行）。
> Inputs: master register `docs/design/2026-07-02-project-logic-master-register.md:394-402`（+`:35` F4, `:72`, `:223` #7, `:1186`）；scout `scratchpad/research/2026-07-02-worklist-softmax-scout.md`（含 OSS 附录五锚点）；Lens A / Lens B findings（全文收进 ledger）。
> Author lane: design only — no code, no Linear writes; owner adjudicates open questions.

---

## 0. TL;DR for the owner (read this first)

1. **威胁被精确化了（两轮修正后）**：register 的「2500× fat-tail 无界 blowup」不准确，draft 的「±2 logit 有界、只是杠杆问题」**只对首次 firm-up 成立**。精确说法：(i) 现行 λ=1 常数锚模式下 `b_calib` 恒 ∈ `[min label, max label]`（自归一化凸组合，`recalibration.ts:236-247`）；(ii) **首次 firm-up 时**全部标签共享同一锚 ⇒ 首个 `b_calib ∈ [b_anchor±2]`（label 写入时 clamp ±`MAX_RESIDUAL_LOGIT=2.0`，`personalized-difficulty.ts:168,179`）；(iii) 此后标签锚定 `effectiveB`（含 b_calib，`recalibration.ts:414`）⇒ **逐夜 ±2 棘轮（ratchet）**，`[b_anchor±2]` **不是**稳态不变量；(iv) Phase 7+ 非常数 m̂ 下连「标签凸组合」恒等式都不再成立。所以修的仍是**单样本杠杆 / bias-variance 旋钮**（非防溢出），但 bound 必须按 (i)-(iv) 分层陈述，不能写成无条件保证。
2. **曝光窗口是开放式的，不是「首夜」**：夜跑候选 SELECT（`recalibration_nightly.ts:130-145`）在 firm-up 后（`calibration_n == count` 且 `b_calib` 非 NULL）**不再重选该题**——被污染的 `b_calib` 冻结原值，`state.ts:819`（`effectiveB(calRows[0])`）**每天**把它喂进在线 θ̂，直到下一条新标签触发重算；而且**未截权时重算也不自愈**——fluke 的存量 π 让它在每次全量重算里保持 ~99% 质量。**截权的第二重收益正在于此：它使后续重算真正收敛。**（这修正让 cap 的论证更强，不是更弱。）
3. **Q4（softmax 数值护栏）已解决且强于 VW 基线**——`softmaxProbabilities`（`selection-signals.ts:232-248`）reduce-max 减法 + `−CLAMP_K(=700)` 下溢地板，`exp ≥ 9.9e-305` 永不硬清零。**零代码工作；探针关闭**；只加一条回归 pin。
4. **实际要 ship 的（register-blessed，零数据依赖）**：**median-相对 IPW 截权**（`w_j ≤ C·median(w)`，C=4 未经数据校准的保守初值）——终裁把 draft 的绝对 π-floor 方案（`π_MIN=0.05`/`W_MAX=20`）**降级**：双 lens 独立算出它让单条 fluke 仍占 42-48% 自归一化质量（不达自己声称的「mild」），且固定绝对 floor 随候选池 N 增大会把全部权重压平成无权均值（IPW 死掉）。median-相对形杠杆 ≈ `C/(C+n−1)`（C=4, n=12 → ~27%），**对 N 尺度不变**、对 outlier 鲁棒（median 不被 fluke 抬高）。**截权与其可观测性同 wave**：PR-1 内就把 clip 激活数 / min-max π 挂进 `RecalibrateResult` + 夜跑聚合日志（不留「无声注偏」窗口）。
5. **三个红线 caveat**：(a) C=4 是**未经数据校准的保守初值**（n=1：不从数据拟合）；(b) 截权**注入偏置换方差**（Ionides 2008 / Bottou 2013 截断权衡）——且偏置方向是**拉向高-π（高频被选）标签的自归一化均值**，即**部分重引入 IPW 本要去除的 selection bias**，**不是**「拉向锚」（λ=1 时锚代数上被消掉）；default-ON 的论证只立足于「首写不可逆 ⇒ 有界方差 > 无偏」，不立足于「保守拉锚」；(c) obp 把 clip 默认 off（∞）——我们默认 ON，因为场景是 small-n firm-up 不可逆资产，非 large-n 无偏 OPE；回滚旋钮 = `C = Infinity`（数学上精确还原旧行为，无需删代码）。

---

## 1. Current state & problem（grounded to `f7726c6c`，line-by-line，双 lens 修正后）

### 1.1 The selection → π_i → recalibration chain

```
softmax-selection.ts   candidate signals → L2 LLM weights (tryLlmOrchestration :471-509)
   │                    ├─ L1 fallback: mfiScore/diagnosticScore weights
   │                    └─ L2 fallback: legacy composeDailyStream (no π recorded)
   ▼
selection-signals.ts   softmaxProbabilities(weights, T=0.25)  → q  (Σ=1, all >0)
   ▼
selection-sampler.ts   inclusionProbabilities(q, n) → ε-mix floor → π   (Poisson IPPS)
   │                    sampleByWeight: independent Bernoulli(π) draws
   ▼
selection_observation  {date, stream_item_id, ref_id, policy, selected, π, signals}  (schema.ts:1664-1689)
   ▼
recalibration.ts       recordDifficultyCalibrationLabel: joins π by stream_item_id (:366-379),
   │                    b_label = impliedBLabel(θ, anchor, outcome)  [clamp ±2.0]
   │                    ⚠ anchor = effectiveB(calRow) — b_calib-INCLUSIVE (:414)
   ▼
recalibration_nightly  candidate SELECT: count≥12 AND (窗内新标签 OR calibration_n<count OR b_calib NULL) (:130-145)
   ▼
recalibration.ts       recalibrateQuestion → ppiPlusMean(pool, samples, λ*) → b_calib
   │                    ⚠ estimator anchor = b_anchor ?? b — NOT b_calib (:495)
   │                    [UNWINSORIZED 1/π  ← 本设计的修点]
   ▼
item_calibration       UPDATE b_calib   ← NULL→value 翻转 = 曝光起点
   ▼
state.ts               updateThetaForAttempt: effectiveB = b_calib ?? b_anchor ?? b (:819)
                        ← 在线 θ̂ 每日消费，不可回放
```

两个真实抽样事件（PR-2 的 touch 面，Lens B F6 修正）：
- **日物化 / compose**：`softmax-selection.ts:373-376` `sampleByWeight(weighted, {temperature, targetCount, rng: deps.rng})`——prod 不传 `deps.rng` → sampler 内默认 `Math.random`（`selection-sampler.ts:162`）。
- **答后重排**：`stream-store.ts:1073-1076`（`reRankAfterAnswer`，`rng: opts.rng`），由 `advanceStreamItem` 的 `rerankDeps` 线程进来（`:708`, `:743`）——prod 同样不传。

### 1.2 The three hand-picked constants（f7726c6c 全部确认未变）

| Constant | Value | Site | Docblock honesty today |
|---|---|---|---|
| `SAMPLING_EPSILON` (ε) | `1e-3` | `selection-sampler.ts:64` | 操作性描述，**未标 uncalibrated**——唯一缺口。 |
| `DEFAULT_TEMPERATURE` (T) | `0.25` | `selection-constants.ts:47` | **已诚实**（"untuned"、"recalibration deferred"、T→π→IPW 方差权衡，`:42-45`）。 |
| `RECALIBRATION_MIN_LABELS` (n_min) | `12` | `recalibration.ts:257` | **已诚实**（"占位裁决（owner 可调）"、"保守起步"，`:253-255`）。 |

Fat-tail 量级（Lens A MINOR-5 修正后的精确表述）：ε-mix 地板 `π_floor = ε·(n/N)`（`selection-sampler.ts:146-147`）⇒ `1/π_floor = N/(ε·n)`——**随候选池规模 N 线性增长**。N=30, n=12 → 2500×；N=100 → 8333×。「2500×」是 N=30 的**下限示意，不是上限**——这既强化 cap 的必要性，也是绝对 floor 方案被降级的原因之一（见 Q1）。

### 1.3 Where the `1/π` weight enters unbounded — exact sites

- `ppiPlusMean`（`recalibration.ts:227-248`）：`correction += (label − λ·m̂)/π; weightSum += 1/π`。**无 cap**。**live estimator**（`recalibrateQuestion:527`）。
- `aipwMean`（`:139-158`）：同形。**Orphaned-but-exported**——只有测试 caller（确认：仅 `recalibration.test.ts` 引用）；文档标明它 = `ppiPlusMean(λ=1)`，为一致性同步 cap。
- `estimateLambdaStar`（`:191-219`）：`w=1/π` 进 `wSum/cov/varM`（`:202-215`），但**当前模式下对输出是死路**——常数锚 ⇒ `dm=0 ⇒ varM=0 ⇒ return 1`（`:216`），加权矩算完即弃。cap 它是为 Phase 7+ 继承 bound（届时是**启发式**，非证明过的方差最优 λ*——见 Q1 rider 3）。

positivity guard（`π>0` else throw，`:148-150`, `:195-198`, `:240-241`）正确且必须**先于** cap（cap 绝不救 ≤0 的 π）。

### 1.4 「不可逆」的精确语义（双 lens 修正后——本节推翻 draft 原 §1.4 的两处乐观误述）

- **bound 的分层真相（Lens A-A）**：
  - **每次重算**（现行 λ=1 常数 m̂）：`b_calib` = 标签的 Hájek 自归一化加权均值 ⇒ ∈ `[min label, max label]`。凸组合性质对任意权重（含 capped）成立。
  - **首次 firm-up**：此前 `b_calib` NULL ⇒ 所有标签的写入锚 = `effectiveB` = `b_anchor ?? b`（锚在采集窗内稳定的前提下）⇒ 全部标签 ∈ `[b_anchor±2]` ⇒ 首个 `b_calib ∈ [b_anchor±2]`。
  - **首写之后**：`recordDifficultyCalibrationLabel:414` 的标签锚 = `effectiveB`（**含 b_calib**），而 `recalibrateQuestion:495` 的估计锚 = `b_anchor ?? b`（λ=1 时锚被消掉，无关紧要）。夜 1 把 b_calib 推到 `b_anchor+2` 后，夜 2 的新标签 clamp 在 `[b_calib−2, b_calib+2] = [b_anchor, b_anchor+4]`——**±2 是相对当前 effectiveB 的逐夜棘轮，不是全局边界**。
  - **Phase 7+ 非常数 m̂**：`ppiPlusMean = λ·predictionMean(pool 无权项) + IPW 加权残差均值`——不再是标签凸组合，`[min,max label]` 也不成立。**任何 bound 都不得写进 estimator docblock 当无条件保证**（M1 遵此）。
- **曝光窗口（Lens A-B）**：不可逆单位是「**从首次 NULL→value 翻转起、到下一条新标签触发重算为止**的在线 θ̂ 消费窗口」——对低频被答题**无上界**（夜跑候选 SELECT 在 `calibration_n==count` 且 `b_calib` 非 NULL 时不再命中，`recalibration_nightly.ts:139-143`）。且**未截权时新标签触发的重算也几乎不自愈**：fluke 以存量 π 参与每次全量重算，保持支配（honest 权重 ~2.5/条 ⇒ 要 ~1000 条 honest 标签才把 2500 权重稀释到半数质量）。
- **修复对位（Lens B-F2）**：对这个不可逆写，配对的 audit 是 **firm-up 记录**（题、labelCount、per-batch min/max π、clip 激活数、写出的 b_calib、λ*）——它在重标定 job 里（PR-1），**不是** sampler seed（PR-2 的 selection-replay nicety，诚实降位）。
- **追溯修复通道**：`recalibrateQuestion` 全量重算 ⇒ cap ship 后对已 firm-up 的题跑**一次性 recompute pass** 即可把 cap 追溯应用到存量 b_calib（夜跑 stale 条件不会自动触发它们）——PR-1 可选步骤，见 §5。

### 1.5 Register 内部优先级分歧（surface for owner）

- 单元 §`:400` 评 **P1**（acute first-write-poisoning）；最终 roll-up `:1186` 评 **P2**（behavioral not integrity）；polish order `:223` #7 说 "ship now"。
- 可调和：winsorize 是 cheap-buildable-now 的结构 bound（现在做），但 urgency 排在 correctness-spine（#1-#6、#8-#9）之后。本设计遵此：**ship light path now，不当 P1 应急**。

### 1.6 Fallback 可观测性缺口（register `:399`(a)）

`tryLlmOrchestration`（`softmax-selection.ts:471-509`）三条 `return null` 路径，只有 `catch` 打日志（`:504-507`）。两条静默：`inputText.trim().length === 0`（`:478`）、`parsed.length === 0`（`:483`）。register 已 re-price 为 **P2 nicety**（fallback 是有测试的工作路径，非未记录 mutation）。

### 1.7 `selection_observation` 不记录什么（Q6 缺口）

Schema（`schema.ts:1664-1689`）记 per-item 结果：`π_i`、`policy`、`selected`、`signals` 快照。**不记**：sampler rng seed（prod 走裸 `Math.random`）、temperature、完整 pre-sample 权重/q 向量、targetCount、**哪条 fallback 路径生效**、clip 激活。选题决策**部分可重构**（π + signals），**不可确定性回放**（无 seed、无路径标签）。

---

## 2. Goals / Non-goals

### Goals
- **G1** — 以**量化陈述的杠杆上界**约束任何单条低-π 标签对 `b_calib` 的影响（register `:399`(b)、`:223` #7）：capped 后单条标签自归一化质量 ≤ `C/(C+n_min−1)` ≈ 27%（C=4, n=12），对候选池规模 N 尺度不变。保守、暴露、未经数据校准。
- **G2** — cap 与其可观测性**同 wave**（Lens B-F1）：clip 激活数 / batch min-max π 随 `RecalibrateResult` + 夜跑聚合日志在 PR-1 一起落地；三个手拍常量 docblock 诚实化 + 字面量域用**单测 pin**（非死运行时 throw，Lens B-F7）。
- **G3** — 不可逆首写的 audit 主载体 = **firm-up 记录**（PR-1）；选题决策的**可重构性**（seed + 路径标签）作为独立的 selection-replay 收益（PR-2），不冒充 b_calib 污染的 headline 缓解（Lens B-F2）。
- **G4** — 两条静默 fallback-null 分支补结构化日志（register `:399`(a)，P2）。
- **G5** — 诚实 sanity-check（Q5）整套 softmax/IPW 装置是否配得上复杂度，既有确定性 legacy 路径呈报为常备降级案。

### Non-goals
- **NG1** — **不**重调 T、ε、n_min（n=1：无数据可拟合；只做诚实/守护/可观测，红线）。
- **NG2** — **不**收窄机制到 Shape-B 确定性选题（register `:401`：会饿死 calibration engine 的标签供给）。降级案呈报（Q5）但不建议采纳。
- **NG3** — **不**建 T×ε replay-calibration harness（真数据门，register `:399`(c)；未跑的 harness 本身就是反模式）。owner-gated 开放问题。
- **NG4** — **不**重写 estimator / sampler / recalibration engine——每个改动都是既有路径上的加性 bound（融进现有框架）。
- **NG5** — **不**动 `b_label` 值 clamp、`impliedBLabel`、FSRS/θ̂ 数学。

---

## 3. Decision table

Legend: **[LIGHT]** = smallest sufficient; **[FULL]** = fuller variant。反过度工程协议已撤回 → 两案并呈，verdict 行是建议，owner 拍板。

### Q1 — IPW 截权：形状与位置（**终裁改判：A → C**）

**Context**：`ppiPlusMean`/`aipwMean`/`estimateLambdaStar` 无界累加 `1/π`；obp 的 `lambda_` = `np.minimum(iw, λ)` 是绝对 cap 先例（默认 ∞/off）；Swaminathan & Joachims 2015：自归一化抑制部分 fat tail 但**不替代显式 clip**。Lens A-A 确认这是**杠杆/bias-variance 旋钮**（首写 regime 有界）而非防溢出——但 bound 分层见 §1.4。

| Option | Description | Assessment（含双 lens 定量攻击后） |
|---|---|---|
| **A. 绝对权重 cap**（draft 原推荐：`π_MIN=0.05`/`W_MAX=20`） | 每条 `1/π` 封顶固定 `W_MAX`。obp `lambda_` 形。 | ❌ **双 lens 独立否证该取值**：n=12、honest π≈0.4-0.5（w≈2-2.5，Σ≈22-27.5）时 capped-20 fluke 仍占 `20/42≈47.6%` ~ `20/47.5≈42%` 自归一化质量 → 首写仍被单条 fluke 拉 ~0.84-1.14 logit——不「mild」，且与 draft 自己拒 Ionides 的量尺（τ≫标签数）自相矛盾（W_MAX=20 > 11 同罪）。❌ **N-尺度病**：honest 权重 ≈ N/n 随池增长；固定 π_MIN 在大 N 时（典型 honest π < π_MIN）把**全部**权重压平到同一 cap ⇒ 估计器退化成无权均值，IPW 整个死掉。✅ 仅在 N 恒定且值重调后可用——作为文档化备选保留。 |
| **B. Ionides √n truncation**（`τ = √n·w̄`） | 阈值从本题自身标签导出（within-question 统计，n=1-safe）。 | ❌ 「1 条灾难 outlier + 11 条轻权重」正是实况 regime，而 `w̄` 本身被 outlier 抬高（11×1 + 1×2500 → w̄≈209，τ≈724 ≫ 11）——under-fix。维持 draft 的拒绝（Lens A 核算术无误）。 |
| **C. Median-相对 cap** `[LIGHT, 终裁推荐]` | `w_j ≤ C · median(w)`，median 取该题标签批的未截权重中位数，C 无量纲保守常数。 | ✅ **对 outlier 鲁棒**（median 不被 fluke 抬高——B 的死穴）；✅ **对 N 尺度不变**（median 自动跟踪 honest 权重尺度 ≈ N/n——A 的死穴）；✅ **杠杆闭式可陈述**：honest 权重近同质时单条 capped fluke 质量 ≈ `C/(C+n−1)`，C=4, n=12 → 4/15 ≈ **26.7%**（uncapped ≈99%）⇒ 首写最坏位移 ≈ 0.27×标签跨度（典型 ~0.5 logit，棘轮极端 ~1 logit），C=3 → 21%。⚠️ median over ≤12 点偏粗 + C 仍是手拍——但这两点弱于 A/B 各自的定量失效（draft 原拒绝理由被终裁推翻）。⚠️ 残余风险：若一批标签**过半**是低-π 探索抽样，median 被抬高、cap 放松——每条探索标签以概率 π 到达，过半概率极小，且 clip 可观测性（G2）使其可见。 |
| **D. Do nothing** | 依赖自归一化 + ±2 label clamp。 | ❌ 单条 4e-4 抽样仍 ~99% 支配首写与**每次**重算（§1.4）；register 明确拒绝（`:399`(b)、`:223` #7）。 |

**Verdict：C（median-相对 cap），`IPW_WEIGHT_CAP_C = 4` 为未经数据校准的保守初值（owner 域 3-5，开放问题 Q-b）。** 四个强制 riders：
1. C 标注「未经数据校准的保守初值（n=1 红线：不从数据拟合；median-相对形是 within-question 鲁棒统计，非跨学习者 item 参数拟合）」。
2. **偏置方向如实陈述**（Lens A-C）：λ=1 时锚代数上消掉（`b_calib = Σ(label/π)/Σ(1/π)`），截权**不可能**拉向 b_anchor；它拉向**高-π（高频被选=能力匹配）标签的自归一化均值**——即**部分重引入 IPW 存在意义上要去除的 selection bias**。这是 deliberate 的 bias-for-variance 交易（Ionides 2008 / Bottou 2013），非免费正确性。default-ON（对比 obp 默认 ∞/off）只立足于：首写不可逆 + 在线消费不可回放 ⇒ 有界方差严格优于无偏。
3. `estimateLambdaStar` 同步 cap 但**当前对输出是死路**（常数 m̂ → return 1 先于加权矩生效），Phase 7+ 激活后 capped-λ* 是**启发式**（Angelopoulos 闭式在 uncapped 估计器下推导；PPI++ 本身 **preprint-only**，arXiv:2311.01453，同行评审未确认——scout ③ 权威分级照录），非证明过的方差最优。
4. **回滚旋钮 = `C = Number.POSITIVE_INFINITY`**：cap 永不 bind ⇒ 数学上精确还原旧行为（positivity throw 保证 π>0），无需删代码——恰是 obp 的 default-∞ 语义（Lens B-F8）。

**两层护栏惯例的诚实对表（Lens B-F4 修正）**：这是 estimator 内部鲁棒性 bound，不是用户侧限流——「warning 水位 vs 3-5× 硬顶」惯例不直接 gate 它。draft 原「只咬极端尾部 / 类比 3-5× headroom」的说法**撤回**：cap 会**常规性地**重塑整个低-π 探索带的贡献（这正是它的目的），是全带 bias-variance 再成形。median-相对形使「只咬远超批典型权重者」按构造成立（bind 点 = C× 批中位），但不冒充「罕见安全阀」。

### Q2 — 保护首次不可逆 `b_calib` 写（**终裁重排 (c) 的载体**）

| Route | Description | Assessment |
|---|---|---|
| **(a) 截权于源（= Q1）** | 直接压任何首写污染的量级，并**使后续重算收敛**（§1.4：未截权时重算不自愈——cap 的第二重收益，Lens A-B）。 | ✅ 最佳单杠杆。 |
| **(b) 首写抬闸 / 两夜一致确认** | NULL→value 首翻要求更高 n 或连续两夜一致（River burn-in 风味）。 | ⚠️ 结构上健全、便宜。❌ 直接换来「校准更晚启动」——撞数据门红线（gate 翻转不 gate 采集回报）。owner call（Q-c，designer 默认 no）。 |
| **(c) firm-up audit 记录**（**headline，PR-1**，Lens B-F2 改判自 sampler-seed） | `recalibrateQuestion` 返回 + 夜跑聚合日志携带 {labelCount, min/max π, clip 激活数, b_calib, λ*}——首写事件**可归因、可检查**。 | ✅ 与不可逆写**同一窗口**的 audit；近零成本（`RecalibrateResult` 已存在，`recalibration.ts:469-477/:543`）。 |
| **(c′) sampler seed**（PR-2，selection-replay nicety） | 种子化 prod 抽样使选题决策可重构（Anki `knuth_salt`/ts-fsrs `alea` 先例）。 | ✅ 值得做，但它重构的是**选题**窗口，不是 b_calib 污染窗口——诚实降位，不冒充 (c)。统计上无害：HT 无偏性只依赖记录的 π 正确，与 realized 抽签机制无关。 |
| **(d) 一次性追溯 recompute** | cap ship 后对 `b_calib IS NOT NULL` 的存量题跑一遍 `recalibrateQuestion`（全量重算语义 ⇒ 纯 re-run，幂等）。 | ✅ 修「冻结的已污染值」（§1.4）；夜跑 stale 条件不会自动触发它们。PR-1 可选步骤。 |

**Verdict：(a) + (c) 为 PR-1 核心，(c′) 归 PR-2，(d) 作 PR-1 可选一次性步骤；(b) 留 owner（Q-c）。**

### Q3 — 三个手拍常量的治理（ε / T / n_min）

| Lever | Description | Assessment |
|---|---|---|
| **Docblock 诚实** `[LIGHT]` | ε（`selection-sampler.ts:59-64`）补「未经数据校准的保守初值 / firm-up 路径」行——T、n_min 已诚实，ε 是唯一缺口。 | ✅ 免费。 |
| **域校验 → 单测 pin** `[LIGHT，Lens B-F7 改判]` | ~~运行时 `if(!(ε>0&&ε<1)) throw`~~——ε/n_min 是硬编码模块常量（NG1 又不做可配），字面量上的运行时 throw 永不可触发、不可测覆盖，是死代码（VW 的 `E_EXPLORATION_BAD_EPSILON` 先例适用于**运行时参数**）。改为**单测 pin 字面量域**：`expect(SAMPLING_EPSILON).toBeGreaterThan(0)` 等 + `IPW_WEIGHT_CAP_C > 1`。T 的运行时 guard 已存在且合理（T 是**传参**，`selection-signals.ts:234`）。 | ✅ 同等防护，零死代码。 |
| **可观测** `[LIGHT]` | 活跃 (ε, T, n_min, C) + clip 激活随 firm-up 记录/选题日志可见（并进 G2/Q2c）。 | ✅ 「cap 咬过没有」可回答。 |
| **做成可配** `[FULL]` | per-subject 温度等 config 面。 | ❌ NG1/NG3；推迟到 harness 时代（届时域校验升运行时）。 |

**Verdict：LIGHT 三件套（ε docblock + 字面量单测 pin + 可观测），明确不做可配。**

### Q4 — Softmax 数值护栏 — 探针结果（维持 draft，双 lens UPHELD）

**RESOLVED — 已实现且强于 VW 基线。** `softmaxProbabilities`（`selection-signals.ts:232-248`）：reduce-max 减法（`:238-243,245`，注释 `:214` 明拒 spread 爆栈）、`Math.max(−CLAMP_K, (s−max)/T)` 下溢地板（`CLAMP_K=700`，`:230,245`，`exp ≥ 9.9e-305` 正规 double）、非有限 score / `T≤0` throw（`:234,239-240`）。候选永不 `q=0→π=0→永不入 IPW 资产`（ADR-0043 §7）。

**Verdict：零行为变更；PR-2 折入一条回归 pin**（`softmaxProbabilities([1000,0],0.25)` 全 `>0`），防未来重构静默删掉 `CLAMP_K`。探针以项目有利方向关闭。

### Q5 — Anki 范围反例：整套装置值不值？（诚实 sanity-check + 降级案）

**反例**：Anki（28.9k★，数百万用户）零概率探索——确定性优先级 + 种子化确定性洗牌 + 硬日上限（`gathering.rs:62-89,188`）。**诚实解读**：Anki 没有个性化 item 难度校准引擎，从不需要 π_i。本项目的 softmax + Poisson-IPPS + 真-π 机器**存在意义就是喂 active-PPI 重标定**（`selection-sampler.ts:6,44-49`）；收窄到 Anki 式确定性 = 抽掉 calibration engine 的燃料（register `:401`）。**反向诚实**：校准赌注本身是未证明的 n=1 小体量 wager，live 量级未测（register `:402`，confidence medium）。

| Option | Assessment |
|---|---|
| **A. 留装置，便宜加固（Q1-Q3,Q6）** `[recommended]` | ✅ 保住校准赌注；winsorize 让赌注**更便宜地持有**（封顶其最坏失效）。 |
| **B. 回翻 `'legacy'` 确定性选题** | ⚠️ 合法降级案，零构建成本：`DEFAULT_SELECTION_POLICY`（`selection-constants.ts:36`）一常量翻回 → 确定性 `composeDailyStream`（现役 L2 fallback，`softmax-selection.ts:24-28`；constants 注释 `:13` 称 7 单测钉死）转正，softmax/IPW/重标定栈整体 idle。❌ 弃校准引擎数据源，逆项目主论题。呈报，不建议。 |
| **C. VW `enforce_minimum_probability` 注水法软地板** | ⚠️ **推测**（Lens A MINOR-8 改判）：ε=1e-3 线性 mix 对锁定 argmax 的扰动仅 `ε(1−n/N)≈6e-4`，无任何分析表明注水法扰动更小——原「perturbs less」表述撤回为 conjecture。仅当 Q6 可观测性显示 ε-mix 失真时再评。Defer。 |

**Verdict：A——留而加固；B 作为常备降级案显式呈报 owner（比本设计的任何代码都便宜——单常量回翻）；C 降为 evidence-gated 推测。**

### Q6 — 可观测性：选题决策 audit（**终裁修正 touch 面 + 复用**）

| Option | Description | Assessment |
|---|---|---|
| **A. 种子化 prod sampler + log seed/path** `[LIGHT, recommended]` | **复用 `mulberry32`（`src/server/calibration/rng.ts:14`，经 `calibration/index.ts` re-export，`simulator/forward-sampler.ts` 已在用）——不新写 PRNG**（Lens B-F5 改判 draft 的「inline 一个」= duplicate building）。seed 从可记录值派生（localDate + 事件种别 + stream/attempt id 的整数 hash），注入点在**最外层 prod caller**并经 DI 线程穿透（Lens B-F6 修正）：物化/compose 路径 → `softmax-selection.ts:376` 的 `deps.rng`；答后重排 → `advanceStreamItem:708` `rerankDeps.rng` → `reRankAfterAnswer:743/:899` → `stream-store.ts:1076`。**两个独立抽样事件各需独立可记录 seed。** 日志载体：先走既有 job/结果日志惯例（夜跑 `console.log('[recalibration_nightly] result', …)` 同风格；register `:427` 对姊妹单元背书 `src/server/ai/log.ts` 式结构化惯例——FULL 时采纳其 shape），不发明新 log 形状。 | ✅ 选题决策可重构（idempotent re-materialization 是**期望的**行为副产品）；与 Q3 可观测、register (a) 静默分支日志一笔落。 |
| **B. `selection_decision` 全量 audit 表** `[FULL]` | 新表持久化 seed/T/targetCount/权重向量/路径/clip。 | ❌ 新 pgTable = 5 面登记税（schema/migration/audit:schema/export-constants FK_ORDER+SCHEMA_VERSION/db.ts ALL_TABLES）。Defer（owner 选项）。 |
| **C. 只 log 静默分支（无 seed）** | 关 register (a)，不管 replay。 | ⚠️ 不足以支撑 (c′)。 |

**Verdict：A。**（定位诚实：这是 selection-replay 收益 + register (a) 闭口，**不是** b_calib 首写 audit 的主载体——那在 Q2(c)/PR-1。）

---

## 4. Mechanism design (file:line level)

### M1 — Median-相对 IPW 截权 + clip 可观测（Q1-C + Q2c）— `src/server/mastery/recalibration.ts`

- **新常量 + batch helper**，声明于 `RECALIBRATION_MIN_LABELS`（`:257`）旁：

  ```ts
  // 未经数据校准的保守初值（n=1 红线：不从数据拟合；median-相对形是 within-question
  // 鲁棒统计，非跨学习者 item 参数拟合）。owner 域 3-5。
  // 语义：单条标签 IPW 权重 w=1/π 封顶于 C·median(批内未截权重)。杠杆闭式：honest 近同质时
  // 单条 capped fluke 的自归一化质量 ≈ C/(C+n−1)（C=4,n=12 → ~27%；uncapped ~99%）。
  // 为什么 median-相对而非绝对 floor：honest 权重尺度 ≈ N/n 随候选池 N 增长，固定绝对
  // floor 在大 N 时把全部权重压平成无权均值（IPW 死）；median 对 outlier 鲁棒（不被 fluke 抬高）。
  // 偏置方向（如实）：λ=1 时锚代数消掉，截权拉向高-π（高频被选）标签的自归一化均值，
  // = 部分重引入 IPW 要去除的 selection bias——deliberate bias-for-variance（Ionides 2008 /
  // Bottou 2013），非免费正确性。default-ON（对比 obp 默认 ∞）因场景是首写不可逆的 small-n
  // firm-up。**回滚 = Number.POSITIVE_INFINITY**（cap 永不 bind = 精确旧行为，不删代码）。
  export const IPW_WEIGHT_CAP_C = 4;

  /** 批内截权：w_j = min(1/π_j, C·median(1/π))。positivity throw 由 caller 先行（cap 不救 ≤0）。 */
  function cappedIpwWeights(pis: number[]): { weights: number[]; clipped: number } { … }
  ```

- **`ppiPlusMean`**（`:239-245`）：先跑既有 per-元素 positivity throw（`:240-241`，**必须先于 cap**），再一次性算 batch capped weights；`correction += (label − λ·m̂)·w; weightSum += w`。
- **`aipwMean`**（`:152-153`）：同 cap（orphaned-but-exported，与 `ppiPlusMean(λ=1)` 文档恒等式保持一致）。
- **`estimateLambdaStar`**（`:202-215`）：同 cap 进 `wSum/wMean/cov/varM`。**call-site 现场注释**（Lens B-F9，per 项目 phase-deferred-comment 惯例）：「常数锚模式下 varM=0 → return 1 先于加权矩生效，本 cap 当前对输出是 no-op；Phase 7+ 非常数 m̂（`:456-460`）激活后为启发式（λ* 闭式在 uncapped 估计器下推导），非证明过的方差最优」。
- **Bound 陈述纪律（Lens A-A）**：docblock 只写 regime-conditional 保证——「λ=1 常数 m̂ 下 b_calib ∈ [min label, max label]（自归一化凸组合，capped 后仍是）；首次 firm-up 时 ⊆ [b_anchor±2]；此后为相对 effectiveB 的 ±2 棘轮；Phase 7+ 非常数 m̂ 下两者皆不成立」。**禁止**把 `⊆ [b_anchor±2]` 写成无条件 estimator 保证。
- **Clip 可观测（Lens B-F1，同 PR）**：`RecalibrateResult`（`:469-477`）加 `clipActivations: number; minPi: number | null; maxPi: number | null`（`recalibrateQuestion:543` 返回处填充）；`recalibration_nightly.ts` 的 `RecalibrationNightlyResult` 加聚合 `clip_activations`（+ 可选 min-π 极值），随既有 `console.log('[recalibration_nightly] result', …)`（`:185`）出口。**注偏改动与其可检测性同 wave。**

### M2 — 种子化 prod sampler + 路径/静默分支日志（Q6-A + register (a)）— PR-2

- `import { mulberry32 } from '@/server/calibration/rng'`（**不新写 PRNG**）。seed = 简单整数 hash(localDate ‖ 事件种别 ‖ 触发 id)，**记录进日志**。
- 注入点（Lens B-F6 修正后的 touch 面）：
  - compose/物化事件：prod caller 构造 `deps.rng = mulberry32(seed)` 传入 `softmax-selection.ts` 的 compose deps（消费点 `:376`）。
  - 重排事件：`advanceStreamItem`（`stream-store.ts:708`）的 prod caller（route handler / job）注入 `rerankDeps.rng`（→ `:743` → `:899` → `:1076`），**独立 seed**。
- 静默分支日志：`softmax-selection.ts:478` 与 `:483` 各补 `console.warn('[softmax-selection] L2 empty-input|parsed-empty → statistical fallback')`；编排出口 log 生效路径（softmax-main / L1 / L2）+ seed。
- ε docblock 诚实行（`selection-sampler.ts:59-64`）+ 字面量域单测 pin（M3 并入）。
- **无 migration、无 schema**（seed 列 defer，Q-d）。

### M3 — 常量治理（并入 PR-1/PR-2 各自文件）
- 单测 pin：`SAMPLING_EPSILON ∈ (0,1)`、`RECALIBRATION_MIN_LABELS > 0`（整数）、`IPW_WEIGHT_CAP_C > 1`。**不加运行时 throw**（Lens B-F7：硬编码字面量上的 throw 是不可触发的死分支）。T 已有运行时 guard（传参，合理），不动。

### M4 — Q4 回归 pin（并入 PR-2）— `selection-signals` 测试
- `softmaxProbabilities([1000, 0], 0.25).every(q => q > 0)`——钉 `CLAMP_K` 下溢地板。

---

## 5. Implementation slices (PR granularity + pre-flight)

**Pre-flight（每 slice，per `preflight-typecheck-after-all-edits`）**：全量 `pnpm typecheck` + touched-file biome **在所有 edit（含 biome --write）之后**；targeted 测试覆盖**import 被改模块的全部测试**（PR-1：`recalibration.test.ts` + `recalibration_nightly.db.test.ts`；PR-2：`selection-sampler.test.ts` + stream-store 测试 + softmax-selection 测试 + `selection-signals` 测试）。CI 是权威闸。

- **PR-1 [core, ship first] — median-相对 IPW 截权 + clip 可观测（M1 + M3 recalibration 侧）。**
  Touch：`recalibration.ts`（常量 + helper + 3 estimators + `RecalibrateResult` 扩展）、`recalibration_nightly.ts`（聚合字段 + 日志）。Tests 见 §6（**数值杠杆断言**，非「不再支配」的散文断言——Lens B-F3）。可选步骤：一次性追溯 recompute（Q2-d；若存量 `b_calib IS NOT NULL` 行为零则天然 no-op）。**无 migration、无 schema、无 UI。** Maps to register `:223` #7 / `:399`(b)。
- **PR-2 — 种子化 prod sampler + 路径/静默分支日志 + ε 治理 + Q4 pin（M2 + M3 sampler 侧 + M4）。**
  Touch：物化/重排的 prod caller（seed 构造）+ `softmax-selection.ts`（deps 线程 + 2 静默分支 warn + 路径 log）+ `stream-store.ts`（rerank DI 线程）+ `selection-sampler.ts`（docblock）+ 测试（seed 确定性：同 seed 同选集；`selection-signals` CLAMP_K pin；常量域 pin）。**无 migration**（log-only）。Maps to register `:399`(a) + Q2(c′)/Q3/Q6-A。
- **[DEFERRED, not a PR now]** — `selection_decision` audit 表（Q6-B，5 面登记税）；常量 config 面（Q3-FULL）；T×ε replay harness（`:399`(c)，真数据门）；VW 注水法地板（Q5-C，conjecture）。各 owner-gated。

**Slice 纪律**（`fanout-lane-full-gate`）：pre-PR 跑全仓 gate 含 `pnpm audit:schema`（本两 PR 无新业务字段，仍跑）；若未来 Q-d 选 seed 列 → 走 pgTable-column 登记 + export/backup 测试清单。

---

## 6. Tests & gate

| Concern | Test（数值断言） | Config |
|---|---|---|
| **Q1 杠杆上界（quantitative）** | 11 honest 标签 @π=0.5（w=2, label=0.0）+ 1 fluke @π=4e-4（label=+2.0）：capped（C=4 → cap=8）fluke 质量 = 8/30 ≈ 26.7% ≤ `C/(C+n−1)`+tol；`b_calib ≈ 0.53 < 0.6`；uncapped 对照 `≈ 1.98 > 1.9`。 | unit（`recalibration.test.ts`） |
| **Q1 凸组合保持** | 随机 π 向量（capped）：`b_calib ∈ [min label, max label]`（λ=1 常数锚 regime）。 | unit |
| **Q1 no-op on 同质输入** | 全-moderate-π（无权重 > C·median）→ capped == uncapped 逐位相等 + `clipActivations === 0`。 | unit |
| **Q1 回滚恒等** | `C = Infinity` ⇒ 输出与旧实现逐位相等。 | unit |
| **Q1 λ*==1 inert-in-phase** | 常数锚 → `estimateLambdaStar` capped 后仍返回 1。 | unit |
| **Q2c clip 可观测** | fluke 批 → `RecalibrateResult.clipActivations === 1`，`minPi === 4e-4`；nightly 聚合累加正确。 | unit + db |
| **Q3 常量域 pin** | `SAMPLING_EPSILON ∈ (0,1)`、`RECALIBRATION_MIN_LABELS ≥ 1`、`IPW_WEIGHT_CAP_C > 1` 字面量断言。 | unit |
| **Q4 下溢地板 pin** | `softmaxProbabilities([1000,0],0.25)` 全 `>0`。 | unit |
| **Q6 seed 确定性** | 同 seed → `sampleByWeight` 选集逐位相同；异 seed →（统计上）不同。 | unit |
| **回归（positivity、IPPS 预算）** | 既有 `selection-sampler.test.ts` Monte-Carlo（经验频率 ≈ π）+ `Σπ=n` 保绿。 | unit |
| **重标定 job 完整性** | `recalibration_nightly.db.test.ts` 绿（cap 不改候选选择，正常数据上 `updated/skipped` 计数不变）。 | db |

**Pre-PR gate（全量，per CLAUDE.md）**：`pnpm typecheck`、`pnpm lint`、`pnpm audit:schema`、`pnpm audit:partition`、`pnpm audit:profile`、`pnpm audit:draft-status`、`pnpm test`、`pnpm build`。**Evidence contract**：附 `pnpm test` + `pnpm typecheck` 原始输出尾部，非转述。

---

## 7. Open questions (owner-level)

- **Q-a（优先级调和）**：单元 §400 P1 vs roll-up `:1186` P2。默认：ship PR-1 **now**（polish order #7），但排在 correctness-spine #1-#6/#8-#9 之后。确认？
- **Q-b（cap 形状 + 值）**：终裁改判 median-相对 `C=4`（单条杠杆 ≈27% @n=12；C=3 → ~21%，C=5 → ~31%）。owner 确认 C 初值与「单条 fluke 最坏拉 ~0.5（典型）/ ~1 logit（棘轮极端）」的可接受性；只会经 deferred harness 从数据重调，绝不二次拍脑袋。
- **Q-c（首写确认闸——Q2b）**：要不要两夜一致 / 更高首写 n，换「校准更晚启动」？（Designer 默认：**no**——(a)+(c)+(d) 已够；确认闸与数据门红线相抵。）
- **Q-d（seed 持久化——Q6）**：log-only（PR-2 默认）还是 `selection_observation` 加 seed 列（全回放，付 column 登记税）？（默认 log-only，列 deferred。）
- **Q-e（常备降级案——Q5）**：确认知悉 `DEFAULT_SELECTION_POLICY → 'legacy'` 是零代码 Anki 式确定性回退（在树、有测试、是现役 L2 fallback）；维持「留装置 + 加固」还是质疑校准 ROI？（Designer 默认：keep + harden。）
- **Q-f（T×ε replay harness——register `:399`(c)）**：真数据门（`selection_observation` 体量）。何时回看？（Not now；NG3。）
- **Q-g（追溯 recompute——Q2d，新增）**：PR-1 是否附带对存量 `b_calib IS NOT NULL` 题的一次性 recompute pass（幂等、有界；当前存量可能为零 ⇒ no-op）？（Designer 默认：**yes**，成本近零。）

---

## Appendix 1 — red-line compliance checklist

| Red line | How this design complies |
|---|---|
| **n=1 — 不拟合 item 参数** | 唯一新常量 `IPW_WEIGHT_CAP_C=4` 标「未经数据校准的保守初值」；median-相对形是 within-question 鲁棒统计（批内中位数），非跨学习者拟合；无 T/ε/n_min 重调（NG1）。 |
| **两层护栏惯例** | 如实对表：estimator 内部 bound 不受该惯例直接 gate；且**不再**冒充「3-5× headroom 罕咬安全阀」（Lens B-F4 撤回）——cap 常规重塑低-π 探索带，是 deliberate bias-variance 旋钮；median-相对使 bind 点 = C× 批典型权重（按构造只咬远超典型者）。 |
| **反过度工程已撤回 → 两案并呈** | 每个 Q 呈 LIGHT+FULL（Q1 C vs A-文档化备选；Q6 log vs 表；Q3 诚实 vs 可配；Q2 b/d owner 选）。 |
| **Evidence-first 可追溯可回滚** | 不可逆首写配**同窗口** firm-up audit（PR-1，clip/min-max π/λ*）；选题决策 seed 化可重构（PR-2）；回滚旋钮显式（`C=∞` 精确还原）；追溯 recompute 通道（Q-g）。 |
| **数据门只 gate 翻转不 gate build** | PR-1/PR-2 全部今天可建可 ship、零数据依赖（register `:223` #7）；唯一数据门项（T×ε harness）deferred 不阻塞。 |
| **不重写引擎 / 融进现有框架** | cap 是既有 estimator 内的加性 bound；seed 走既有 `rng?` DI 参数；PRNG 复用 `calibration/rng.ts` 的 `mulberry32`（不新写）；日志走既有 job-result 惯例；无新引擎无重写（NG4）。 |
| **不删 pre-AI 特性** | legacy `composeDailyStream` 确定性路径保留并作为降级案呈报（Q5-B），绝不提议移除。 |

---

## Appendix 2 — Attack 裁决 ledger（reconcile 终裁，全部 file:line 已对 f7726c6c 抽验）

### Lens A（统计正确性轴）

| # | Finding | 裁决 | 理由（code-grounded） |
|---|---|---|---|
| A-A | 「b_calib ∈ [b_anchor±2]」是首写+常数锚性质，非全局保证；标签锚经 effectiveB（含 b_calib）反馈成棘轮；Phase 7+ 恒等式破裂 | **ACCEPT（MAJOR，已修入 §0.1/§1.4/M1）** | 抽验成立：`recalibration.ts:414` 标签锚 = `effectiveB(calRows[0])`（b_calib-inclusive）；`:495` 估计锚 = `b_anchor ?? b`；λ=1 时锚消掉 ⇒ b_calib = 标签加权均值，首写后标签 clamp 在 `[b_calib±2]` ⊄ `[b_anchor±2]`。非常数 m̂ 下 `ppiPlusMean` 非标签凸组合，代数正确。M1 明令禁止把 `⊆[b_anchor±2]` 写成无条件 estimator 保证。 |
| A-B | 曝光窗口开放式非「首夜」；未截权时重算不自愈 | **ACCEPT（MAJOR，已修入 §0.2/§1.4）** | 抽验成立：`recalibration_nightly.ts:139-143` HAVING——firm-up 后 `calibration_n==count` 且 `b_calib` 非 NULL ⇒ 三条件全 FALSE ⇒ 不再入选，b_calib 冻结；新标签触发的重算中 fluke 以存量 π 保持 ~99% 质量（honest w≈2.5/条，稀释到半数需 ~10³ 条）。修正**强化** cap 论证（收敛性收益）+ 派生 Q-g 追溯 recompute。 |
| A-C | 截权偏置方向非「拉向锚」；是拉向高-π 标签均值 = 部分重引入 selection bias | **ACCEPT（MAJOR，已修入 §0.5/Q1 rider 2）** | 代数抽验成立：λ=1 常数 m̂ ⇒ `b_calib = Σ(label/π)/Σ(1/π)`，b_anchor 消掉；capping 只改相对权重，拉向高-π（高频被选=能力匹配）标签的自归一化均值。default-ON 论证改立足「首写不可逆 ⇒ 有界方差>无偏」，弃「保守拉锚」。 |
| A-F | `W_MAX=20`（`π_MIN=0.05`）定量不达自称目标（fluke 仍占 42-48%）+ 与拒 Ionides 的量尺自相矛盾 | **ACCEPT（MAJOR，Q1 verdict 改判 A→C）** | 算术复核成立：11×w=2 + capped 20 → 20/42=47.6%；@π=0.4（w=2.5）→ 20/47.5=42%。draft 拒 B 用「τ≫标签数」量尺而 W_MAX=20>11 同罪。加上 N-尺度病（见 A-MINOR-5）终裁弃绝对 floor，采 median-相对 C=4（杠杆闭式 C/(C+n−1)≈27%）。 |
| A-MINOR-5 | fat-tail 权重 = N/(ε·n)，随 N 无界；2500 是 N=30 下限 | **ACCEPT（已修入 §1.2）** | `selection-sampler.ts:146-147` 公式抽验成立。此发现是 Q1 改判 C 的第二决定性理由：固定绝对 floor 在大 N 时把全部权重压平 ⇒ IPW 退化成无权均值。 |
| A-MINOR-6 | capped λ* 是 Phase 7+ 启发式，非证明过的方差最优；当前 inert | **ACCEPT（已修入 Q1 rider 3 / M1 call-site 注释）** | `recalibration.ts:210-216` 抽验：常数 m̂ ⇒ dm=0 ⇒ varM=0 ⇒ return 1（加权矩算完即弃）——inertness 成立；capped 矩下的 λ* 与 Angelopoulos 闭式推导前提不符，标启发式。 |
| A-MINOR-7 | PPI++ preprint-only，draft 沿袭「已确立方法」语气 | **ACCEPT（已修入 Q1 rider 3）** | scout `:62-66` 本就旗标 arXiv:2311.01453 preprint / 同行评审未确认；终稿引用处显式降级权威档。 |
| A-MINOR-8 | 「注水法扰动 argmax 更小」无根据 | **ACCEPT（已修入 Q5-C）** | 线性 mix 对锁定项扰动 `ε(1−n/N)≈6e-4`，无对比分析 ⇒ 改标 conjecture，evidence-gated defer 不变。 |

### Lens B（工程/运行时轴）

| # | Finding | 裁决 | 理由（code-grounded） |
|---|---|---|---|
| B-F1 | PR-1 无声注偏、可观测性拖到 PR-2 | **ACCEPT（HIGH，已修入 G2/M1/PR-1）** | `RecalibrateResult`（`recalibration.ts:469-477`）+ 返回点 `:543` + 夜跑聚合 `console.log`（`recalibration_nightly.ts:185`）抽验存在 ⇒ clip 可观测近零成本。截权与其可检测性同 wave 是本设计自身 evidence-first 立场的必然。 |
| B-F2 | 不可逆写的配对 audit 是 firm-up 记录，非 sampler seed | **ACCEPT（HIGH，已修入 Q2 重排 + G3）** | 概念正确：seed 重构的是选题窗口，θ̂ 污染由 b_calib 经 `state.ts:819` 驱动。firm-up 记录升 headline（PR-1）；seed 降位 selection-replay nicety（PR-2），不冒充。 |
| B-F3 | 绝对 cap @π_MIN=0.05 不满足 G1（42% 残余杠杆）；三路出路 | **ACCEPT（HIGH，与 A-F 合并改判）** | 同 A-F。采出路 (c)（重开 C）+ 出路隐含的「测试须数值断言杠杆界」（§6 第一行）。 |
| B-F4 | 「只咬极端尾部 / 3-5× headroom 类比」与 ε-mix 自身设计矛盾 | **ACCEPT（MEDIUM，已修入 Q1 对表 + Appendix 1）** | ε-mix 按设计产出 π∈[4e-4, ~0.1] 探索带，绝对 π_MIN=0.05 常规咬全带 ⇒ 类比撤回；保留「两层惯例不 gate estimator 内部」的正确半句；median-相对形使「只咬远超批典型者」按构造成立但不冒充罕见安全阀。 |
| B-F5 | `mulberry32` 已存在（duplicate building）；日志应走既有惯例 | **ACCEPT / PARTIAL（HIGH，已修入 M2）** | 抽验成立：`src/server/calibration/rng.ts:14` 实现并导出 `mulberry32` ⇒ import 复用，不新写（ACCEPT）。日志载体 PARTIAL：方向采纳（复用既有惯例、不发明新 shape），但 `ai/log.ts` 是 AI-task-run 域（`writeAiTaskRunStarted` 等）——立即落点取 job/结果日志惯例（夜跑 `:185` 同风格），ai/log-style 结构化事件作 FULL 选项（register `:427` 背书其 shape）。 |
| B-F6 | PR-2 call-site 图错：`:376` 在 softmax-selection.ts 非 stream-store；漏 `:708/:743` 重排线程；两独立抽样事件各需独立 seed | **ACCEPT（MEDIUM，已修入 §1.1/M2）** | 抽验成立：grep `sampleByWeight(` 命中 `softmax-selection.ts:376` + `stream-store.ts:1073`（rng 在 `:1076`）；`advanceStreamItem:708` `rerankDeps` → `:743` → `reRankAfterAnswer:899` 线程确认。touch 面按实改写。 |
| B-F7 | 硬编码常量上的运行时域 throw 是不可触发死分支 | **ACCEPT（LOW，已修入 Q3/M3）** | ε/n_min 是模块字面量且 NG1 不做可配 ⇒ throw 永不可达且不可测覆盖；VW 先例的 ε 是运行时参数，类比不成立。改单测 pin；T 的运行时 guard（传参）保留。 |
| B-F8 | 回滚旋钮未陈述 | **ACCEPT（LOW，已修入 Q1 rider 4 / M1 docblock）** | 适配 C 形后回滚值 = `C = Number.POSITIVE_INFINITY`（cap 永不 bind ⇒ 逐位还原；positivity throw 保证 π>0）——恰为 obp default-∞ 语义；§6 加回滚恒等测试。 |
| B-F9 | `estimateLambdaStar` cap 的 no-op-until-Phase-7 注释必须在 call site | **ACCEPT（LOW，已修入 M1）** | 项目 phase-deferred-comment 惯例直接适用；`:216` early-return 先于加权矩生效已抽验。 |

### 双方 UPHELD（终稿保留的 draft 正确项）

Q4 softmax 护栏（reduce-max + `CLAMP_K=700` 地板，强于 VW——双 lens 独立 CONFIRMED，探针关闭）；±2 label clamp 现值（`personalized-difficulty.ts:167-168,179`）；「杠杆旋钮非 blowup guard」的核心 reframe（regime-conditional 后仍成立且优于 register 措辞）；positivity-throw-先于-cap 顺序；`aipwMean` orphaned-but-exported；Ionides √n·w̄ 拒绝算术；ε-mix `Σπ'=n` 精确 + positivity airtight + 记录的 π 是真边际入选概率（2500× 是**正确的** IPW，非 bug）；seed 化不偏 HT 估计（audit-only）；Anki 反例的诚实处理 + 单常量降级案（`selection-constants.ts:36`；「7 单测」出处 `:13` 注释）；与 YUK-539 evidence-floor / YUK-557 无重复接缝；audit:schema/partition 自洽（两 PR 无新业务字段）。

### Draft 侧行号勘误（终裁 re-ground 发现，已在正文改正）

- `tryLlmOrchestration` 实际 span `:471-509`；两条静默 null 在 `:478` 与 `:483`（draft 写 `:473/:479`）；catch log 在 `:504-507`（draft 写 `:508-511`）。
- `sampleByWeight` compose 站点在 `softmax-selection.ts:373-376`（draft 的 M2 误归 `stream-store.ts:376`——即 Lens B-F6）。
- 夜跑候选 HAVING 全 span `:130-145`（draft 写 `:139-143`，为 OR 三条件行，无实质错）。

---

## 附录 — Owner 决策实录(2026-07-03,AskUserQuestion)

开放问题七项处置:

1. **Q-e 方案级择一(两案并呈)**:owner 拍「**保留+加固(推荐)**」——median-相对截权 + 种子化 sampler + 可观测面照本 spec 落地;零代码降级旋钮(`DEFAULT_SELECTION_POLICY→'legacy'`)作为逃生阀留案不启用。
2. **Q-b cap 数值**:owner 拍 **C=4**(单样本杠杆 ≈27% @n_min=12,域 3-5 中位)。代码注释原样标注「未经数据校准的保守初值,非拟合结果」;回滚 = `C=Infinity` 逐位还原。
3. **Q-a 排期**:按 designer 默认自决 **ship now**(本单元即当前刀)。
4. **Q-c 首写两夜一致确认闸**:按 designer 默认自决 **no**(换校准更晚启动,不值)。
5. **Q-d seed 载体**:按 designer 默认自决 **log-only**(加列 = 5 面登记税,log 可逆可升级)。
6. **Q-f T×ε replay harness**:真数据门,**defer**(数据门只 gate 翻转不 gate build 不适用——harness 本身依赖真实分布回放,无分布可放)。
7. **Q-g 存量 b_calib 一次性追溯 recompute**:按 designer 默认自决 **yes**(幂等近零成本,随 PR-1 附带;修复开放式曝光窗口的 fluke 存量污染)。

Linear:YUK-558(parent YUK-538)。
