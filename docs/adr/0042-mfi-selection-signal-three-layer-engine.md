# ADR-0042 — MFI 调度信号 + 选题引擎三层三明治 + order 切分

**Status**: Accepted (2026-06-15)
**Part of**: YUK-203 · AI pipeline re-think · 调度轴 B3 · D14 编排面。
**Decision source**: owner 2026-06-15 逐问压实（「上 MFI 强自适应怎么做」→「MFI 会怎样改造现有选题」→「新设计里的选题引擎」→「落成 design doc」→ 决策点 A/B 拍定）。完整实施形态见 `docs/design/2026-06-15-selection-engine-three-layer-design.md`（rev 2，经 4 视角独立 critic）。
**Related**: **ADR-0037（合并引擎——本 ADR 是其「选题引擎欠规约 blocker」的形态落地 + 引入 MFI 新维度）** · ADR-0035（mastery_state 三维 + 四引擎——θ̂/b 来源、MFI 的 difficulty×p(L) 交叉派生）· ADR-0030（variant-rotation probe selector——降为 L1 复习侧子步骤）· ADR-0028（知识级 FSRS *when* 单 writer——只读约束）· ADR-0039（A/B/C 出手强度——今日流撤销链 blocker）· ADR-0041（copilot reach——copilot 改今日流边界 blocker）。

---

## 背景

ADR-0037 拍板了调度合并引擎的**架构裁决**（一 AI 引擎吃 FSRS due + frontier + mastery + mem0 + AI 判断；FSRS *when* 不并进；到期 hard constraint；frontier 一等公民；review_plan 退役），但代价节明列「三约束具体形态欠规约（blocker）」——选题引擎怎么把多维输入合并成今日流决策从未落地。同时 owner 2026-06-15 拍板要 **MFI（最大 Fisher 信息）强自适应选题**（选 `argmin |b_q − θ̂|` 的题 = 最诊断的题），这把 MFI 从 B1 自校准手段（ADR-0035 慢热阶段 ③ 的 active-learning 选题）**提升为调度引擎的日常选题信号**——一个语义跃迁，够格 ADR 级追溯。本 ADR 固化选题引擎的形态决策。

## 决定

### 1. 三层三明治架构（确定性信号 → LLM 编排 → 确定性约束）

核心张力：ADR-0037 要「AI 编排」，但 MFI/due/frontier 是确定性数学、硬约束不能交给 LLM 软化（§6.2 B6：prompt 软约束被 LLM 软化）。解 =

- **L1 确定性信号层（非 AI）**：算 FSRS due（只读）+ frontier 递归 CTE（depth-limit + cycle guard）+ 每题 MFI score + mastery p(L) + 到期项确定性保序 + variant-rotation 路由，喂给 L2。
- **L2 LLM 编排层（AI 引擎，D14 下）**：产 what（非到期主推哪些）+ mix（非到期项穿插 + 新知/巩固配比）+ reason。**不决定**到期项相对序、到期项 presence。
- **L3 确定性 post-filter（非 AI）**：守 invariant 全集（到期 presence/保序、recall、反舒适区、frontier 配额、临时边占比、配比 cap、幻觉剔除），物化进 `practice_stream_item`。

**L1 预防 vs L3 守的责任分配**：能 L1 预防的不留 L3（recall 不喂 MFI、draft 过滤、容量截断）；只能结果层守的才 L3（presence、保序、配额）。

### 2. order 切分（critic 三视角收敛的核心修正）

**到期项相对序 = FSRS *when* 契约，不交给 LLM**。原设计让 L2 管 what+mix+order，但 critic 证明：L3 只守到期项「存在」不守「顺序」时，LLM 把今天到期的排第 8 位 = 实际拖延复习 = `due_at` 退化成布尔 `is_due`，破 FSRS when 正交。切法：

- **到期项相对序**：L1 确定性 `due_at ASC` 排序 + L3 保序守（有界延迟 ±k 位）。
- **非到期项（frontier/巩固）穿插**：L2 mix 决定。
- L2 职责收窄为 what/mix/reason —— 同时提 L2 可测性（order 确定性可测）。

### 3. MFI = difficulty×p(L) 交叉派生信号，非第三轴

MFI 不是独立第三轴（三轴仍是 R=FSRS when / p(L)+transfer=mastery / difficulty）。MFI 是 `f(b, θ̂)` 的派生计算：b（difficulty 轴，来自 `item_calibration`）× θ̂（p(L) 轴，来自 `mastery_state`）。**载体**：θ̂ 在线更新用 **Elo + b 锚死外部锚**（urnings-elo 核验：MFI 强自适应下 Elo 优于 Urnings——后者 adaptive-selection 校正 O(|items|) + mandatory MH + 闭式 SE 在 n=1 small-N 退化；Elo fixed-adaptive 有 negative bias 但 O(1) 可控）。**recall 类不喂 MFI**（L1 信号源头切断，守 ADR-0030 原题重复 invariant）。**多 KC 题用 θ̂_min**（最薄弱 KC），须与 mastery VIEW 聚合规则协调。

### 4. 运行时形态 = hybrid（决策点 A）

nightly 预产骨架 + 作答后增量重排。平衡 θ̂ 实时性（MFI 要反映当前能力，纯 nightly 隔夜滞后）与 LLM 成本（纯 on-demand 每进 /practice 付一次）。现状 lazy compose on first read 是自然演进起点。`advanceStreamItem`（作答推进）后触发增量重排（只重跑受影响知识点的 L1+L2，非整流）。

### 5. 守住 ADR-0037 banked 约束 + 补决策总账 §6 ⑥⑦

FSRS when 不并进 / 到期 hard constraint（H8）/ frontier 一等公民 + 配额 / mem0 只读软提示（H5，ADVISORY_ONLY，不可机械验证靠 L3 due presence 兜底）/ 三轴正交 / fallback 退化到现有 `composeDailyStream`（非纯 due，保留 frontier）。**补 §6 ⑥⑦**（原 design doc rev1 漏接）：反舒适区约束（每日 ≥1 frontier/transfer）+ fatigue/repetition 惩罚 + review_format 5 分类作 mix 第二维 —— 全进 L3 post-filter。

## 2026-06-15 Amendment — 编排档2（LLM 出权重 + sampler + π_i）+ Urnings-lite sequencing

owner 2026-06-15 拍「让 LLM 强一些」（承 copilot 全能 + 成本无所谓立场）后，把 §1 的 L2/L3 分工**精化为「档2」**——LLM 当主脑、统计降为薄 sampler，同时不破 π_i positivity。承重设计 = `docs/superpowers/plans/2026-06-15-personalized-calibration-roadmap.md`（YUK-361，8 阶段）+ `docs/design/2026-06-15-question-supply-target-discovery-architecture.md`（供给引擎，Phase 8）。

**核心机制（让 LLM 强而不破 π_i）**：**LLM 对每个候选输出 weight/score（+ role + arrangement + reason），一个薄 tempered-softmax sampler 按权重抽样落具体题，π_i = 该抽样分布的 inclusion probability。** LLM 主导「选哪些题 + 怎么排 + 为什么」；只要 sampler 温度 T>0，每个 LLM 给正权重的候选 π_i>0（满足 ADR-0043 §7 要求的 positivity，**正是它指定的「真随机抽样、非确定性 top-item 事后归一化」**）。

**层归属精化（取代 §1 的 L2「产 what+mix+reason」/「统计选题」二分）**：
- **L1 确定性** = LLM 证据基座（候选集 + 信号 MFI/θ̂/θ_se/b/b_source/due_urgency/frontier/recall_eligible **+ 三信号扩充**）。**信号集扩充（2026-06-15，owner「加上」+ GPT 研究稿 §9.2 复习推荐公式）**：原信号偏 MFI 中心（≈ weakness×near-θ + due forgetting + frontier prereq）；补 **`exam_relevance`（考纲/目标相关度）/ `misconception_recurrence`（错因图谱复发——错因当选题信号，非只 mistake_variant 存着）/ `transfer_gap`（同知识点跨题型表现差）** 三个 first-class 信号进 L1 向量，喂档2 LLM 加权——选题维度不止 MFI。（§9.2 其余项 forgetting/weakness/prereq/fatigue/repetition 已分别由 due/MFI/frontier/L3 覆盖。）
- **L2 LLM = 主脑**：输出**每候选权重 + role + 安排 + reason**，直接塑造选哪些、怎么排、为什么（pedagogical 排序/主题连贯/fatigue/learner 叙事——纯 MFI 算不出的）。**不再只是「带和配比」。**
- **薄 sampler**：LLM 权重 → tempered-softmax 抽样 → 落题 + 记 π_i。唯一存在理由 = 让 LLM 选择 π_i 合法 + 防 capitalization-on-chance。统计层从「选题器」降为「按 LLM 权重抽样的 sampler」。
- **L3 = 薄不变量守卫**（退成安全网，非 co-decider）。

**4 条不可让铁律（最小集，其余全给 LLM）**：① 不写 b（difficulty 单写者只读，三轴正交）；② 到期 presence（所有今日到期项必在流）；③ recall 不换题（ADR-0030）；④ 容量 + draft 排除 + dedup。**注意「到期相对序」不在铁律里**——本 amendment 取档2（LLM 排非到期 + 加权，到期序仍 L1 确定性保序）；**档3**（LLM 连到期 intra-day 顺序也排，L3 守 presence + bounded-delay cap，FSRS 仍拥有「哪一天」）是 owner 随时可开的更强档，本 amendment 暂不取。

**温度旋钮（唯一 tunable trade-off）**：T 越低 = LLM 越主导 = π_i 越尖 = 后期 active-PPI（ADR-0043 阶段③ / roadmap Phase 6）的 IPW 方差越大。可调，且 recalibration deferred + PPI++ power-tuning 自降级兜底。

**运行时（hybrid，承 §4）**：LLM 编排**夜间一次**（成本）；作答后增量重排走**纯统计 sampler**（用更新后 θ̂ 重算权重——若不重跑 LLM 则用上次 LLM 权重 + 新信号，便宜）；**两级 fallback**：LLM 挂→纯统计 sampler（MFI 当权重）→ 再挂退确定性 `composeDailyStream`。

**refine 关系**：本 amendment 精化 ADR-0042 §1/§2（L2 从「what+mix+reason」升为「per-candidate 权重」；统计层 = sampler 非 chooser）+ ADR-0037「一个 AI 引擎」→「AI 编排（权重/安排/叙事）+ 统计 sampler（item+π_i）+ 确定性守（信号+铁律）」。

**Urnings-lite sequencing**（roadmap Phase 0 / Task 1）：Urnings 作 uncertainty 方向灵感，**非**当前 production 的 paired-comparison 在线引擎；当前路径 = Elo/MLE θ̂ + θ_precision 不确定性 + b 锚只读 + π_i 持久化，full Urnings deferred 到离线 replay spike（Phase 7）。详见 `docs/design/2026-06-15-urnings-lite-calibration-amendment.md`。

**诚实天花板**：mimo-v2.5 连贯性（LLM 越主导越吃模型推理上限，→ YUK-346 换 GLM 评估的又一理由）；signal-fidelity（信号分桶 high/mid/low 喂 LLM，sampler 用真实数值兜 π_i）；π_i 方差随 T（见旋钮）。

## 后果

**正面**
- ADR-0037 的选题引擎 blocker 从「欠规约」落成可实施的三层形态 + 责任分配表。
- order 切分守住 FSRS when 正交（critic 抓出的真破口），同时提 L2 可测性。
- MFI 强自适应有了 grounded 载体（Elo over Urnings）+ 守 ADR-0030 的信号源头切断。

**代价 / 风险（诚实标）**
- **MFI 喂 LLM 失真**：LLM 对 prompt 原始浮点不敏感，MFI 可能「被携带但未被使用」。缓解：order 收回 L1（MFI 进确定性保序）+ prompt 分桶 + 诊断日志记输入最高 MFI vs 输出排名差。
- **capitalization on chance**（B1 §5.3）：θ̂ 不准 MFI 系统性偏好 a/c 误差题。缓解：b 锚死、θ̂ SE 宽降权、cap 曝光率 + 观测触发率。
- **mastery B1 前偏斜**：未校准 VIEW 对 evidence<3 给保守默认 → frontier KC 读为低掌握 → 巩固偏见反馈循环。缓解：B1 前用 evidence_count 驱动 mix、prompt 传播 is_placeholder。
- **mem0 软约束不可机械验证**：LLM 可能把 mem0 prior 当硬偏好。缓解：ADVISORY_ONLY 标注 + L3 due presence 唯一硬兜底。
- **数据前置**：mastery_state + item_calibration 两表 gated B1 载体 wave；过渡用 `question.difficulty`（1-5）+ evidence_count 做 crude MFI 先 prototype。
- **~14 实施 blocker**（运行时形态细节/并发/数据契约/观测/测试/衔接）见 design doc §6，实施前定。

## 备选（已否决）
- **纯 LLM 选题**——否决：硬约束被软化、数学被幻觉、mem0 注入面大。
- **纯确定性加权选题**——否决：丢 ADR-0037「AI 编排」主线（frontier 空填充、mix 动态配比、mem0 软提示），退回 Phase 0 双脑。
- **order 全归 L2**（rev 1 原案）——否决（critic 三视角收敛）：到期项相对序是 FSRS when 契约，L2 重排 = 破正交。
- **MFI 作独立第三轴**——否决：MFI 是 difficulty×p(L) 派生，等同 difficulty 轴会误导写进 item_calibration.difficulty 列。
- **Urnings 作 θ 载体**——否决（urnings-elo 核验）：MFI 强自适应下 adaptive 校正 O(|items|) + MH + 闭式 SE 在 n=1 退化，不划算；Elo fixed-adaptive 可接受。
- **nightly-only / on-demand-only 运行时**——否决（决策点 A）：前者 θ̂ 隔夜滞后违 MFI 实时诉求；后者每进 /practice 付 LLM 成本 + 并发。hybrid 平衡。
