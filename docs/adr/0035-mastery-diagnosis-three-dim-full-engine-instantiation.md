# ADR-0035 — 掌握诊断三维模型 + 四诊断器全实例化分轨

**Status**: Accepted (2026-06-14)
**Part of**: YUK-203（领域模型重构）—— 掌握诊断三维 + 标定地基。
**Decision source**: `docs/design/2026-06-14-product-rethink-decisions-ledger.md` §1 B1（最高权威拍板，第 32-49 行，含 owner 2026-06-14「照字面全实例化四引擎」覆盖）+ `docs/design/2026-06-14-b1-diagnostic-engines-foundation.md`（四诊断器机制 + n=1 可辨识性 + 慢热四阶段的逐条文献实证 + 对抗性权威审计，全文）+ `docs/design/2026-06-14-product-rethink-phase2-synthesis.md` §3.1-3.3 / §3.9 / §4.1（接口对账 + schema 落地 + 三轴正交红线）。
**Related**: ADR-0012（mastery 派生 view——本 ADR **supersede** 其「计算公式 first draft」一节的 `evidence_count < 3 THEN 0.5` 占位公式，view 派生原则本身保留）/ ADR-0028（知识级 FSRS：`R` 维真相源，本 ADR 与之共享 difficulty 输入但不互写）/ ADR-0005（FSRS 单 writer）/ ADR-0011（mastery 经 `query_knowledge` 读）/ ADR-0017（mem0 只读旁路，三轴正交其一）/ ADR-0029（review 引擎落既有原语；其 paper channel 与本三维诊断的关系由 B3 调度合并另文 supersede，非本 ADR）。

---

## 背景

掌握诊断当前是「双脑分裂无对账」：调度只认 `material_fsrs_state.due_at`（`R` 维，ADR-0028），展示/AI 用 `knowledge_mastery` PG view（`src/db/schema.ts:806`），二者从不互相校准（Phase 2 §3.1 grounded）。更要命的是 view 的占位公式硬伤——DDL（`drizzle/0005...sql`）`evidence_count < 3 THEN 0.5::real`（line 61）+ 30 天半衰期纯加权比值（line 22/62）：头三条证据一律假装 0.5、无先验、第一条证据不更新。这是 ADR-0012「计算公式 first draft，可调优」一节明示的临时占位（ADR-0012 第 102-103 行），现在到了换掉它的时点。

与此并行的是「四诊断器去向」的悬案：GPT 外部稿提议 IRT / CDM / KT / LLM 四个并行引擎都进决策（router）。Phase 1 大调研（`...phase1-research.md` §5）已判定 n=1 稀疏数据养不起四个**可信**引擎且四者大量重叠，收敛到「一个 PFA + LLM 先验」。但这条算法判断此前**只活在被压缩的对话里，从未存盘、从未过权威性审计**（B1 地基 doc §1，对应总账 §1 B1 第 43-44 行「来源诚实」自标）。`docs/design/2026-06-14-b1-diagnostic-engines-foundation.md` 是把这块地基补成正式存盘——四路独立调研（IRT / CDM / KT 族 / n=1 标定）+ 一路对抗性权威审计，全部联网核验，裁定无一条疑似编造。

本 ADR 把 B1 三维分层、四诊断器分轨、慢热四阶段、`item_calibration` / `mastery_state` 落地形态钉成结构决策。**核心张力**：owner 2026-06-14 拍板「照字面全实例化四引擎」（总账 §1 B1 第 42 行）——这覆盖了 B1 地基 doc §4.2「CDM 不实例化」的工程建议，但**不推翻**地基 doc 的 n=1 零信息结论。本 ADR 必须把「全建全存」（产品决策：期权 + 诊断丰富度 + 自校准残差）与「不信且不喂决策」（有效性天花板：n=1 无 cohort，Stocking 1990）显式钉成两件不能混淆的事。

## 决定

1. **掌握 = 三维分层、各管各、不互相对账写回**（Phase 2 §4.1 三轴正交红线落点）。
   - **`R`（FSRS 记忆维度）** —— 不变，`material_fsrs_state`（知识点 keyed，ADR-0028/0005 单 writer），喂调度回答「记得牢不牢 / 何时复习（when）」，per-item。**不被 transfer credit / accuracy / mem0 污染。**
   - **`p(L)`（PFA logistic 掌握诊断）** —— 新建派生层取代 view 占位，回答「此刻会不会 / 迁移得了吗」，喂诊断展示 + 调度 what 信号。`logit(p) = β_kc + γ·success_count + ρ·fail_count`：**有先验**（`β` 来自 `item_calibration` 难度锚）、**第一条证据就更新**（删 `evidence<3→0.5`）、**含 transfer**（RT2 credit 注入，credit 只进 `p(L)` 不碰 `R`）。
   - **`difficulty`（共享桥）** —— FSRS `D` 与 PFA `β` **同 logit 语义，需 linking 对齐，非等号**（B1 地基 §6.1 + 审计 M3：IRT 的 `b` 是「θ 度量上的位置」，PFA 的 `β` 是「logistic 回归 KC 难度截距」，FSRS 的 `D` 是「记忆难度非作答难度」，直接等号会掩盖度量差）。**唯一允许的跨轴共享 = 共享输入（作答 correctness/RT），各自独立估计，不共享估计值**：`D` 走 FSRS review、`β` 走 PFA 梯度，**不互写**（Phase 2 §4.1 C4 红线，否则正交在 difficulty 处破）。
   - 呈现口径：**置信区间 / 低置信标记**，非干净「掌握度 = 78%」；慢热期一律低置信只信相对排序。

2. **删 `knowledge_mastery` view 的 `evidence<3→0.5` 占位，换 PFA logistic**——本 ADR 据此 **supersede ADR-0012「计算公式」一节**的占位草稿（`evidence_count < 3 THEN 0.5` + 纯加权比值）。ADR-0012 的「mastery 是派生量不存为状态字段」原则**保留不动**；变的只是派生公式的承重引擎：从「无先验加权比值 + 三证据前回中位」换成「有先验、第一条证据即更新的 PFA logistic」。`p(L)` 仍是派生层，落 `mastery_state` 新表（取代 view 占位，Phase 2 §3.9）：`p_l + ci + success/fail_count（含 transfer）+ beta 桥 + calibration_residual + fluency_illusion_flag`。

3. **四诊断器全实例化 + 持久化（owner 2026-06-14 拍板，覆盖工程建议）**。真建 **IRT 2PL/3PL + CDM DINA/G-DINA + KT 变体**，带先验跑，输出**全部计算 + 持久化**进 `item_calibration` 新表（Phase 2 §3.9 第 231 行）：**硬轨高置信列 `b`/`θ` + 软轨低置信列 `a`/`c`/`cdm`/`kt` + `confidence` + `track` + `source`**。即使产出多为 prior-echo 也不丢。全建的理由共四条（总账 §1 B1「数据保留」条）：① **n=1 慢热**——硬轨列（`b`/`θ`）数据攒够后置信真实 firm up；② **自校准残差**需全栈合成估计 vs 锚点对比（PPI / fixed-anchor）；③ **诊断丰富度**（下钻看 CDM attribute 画像 / IRT 区分度）；④ **扩多用户期权**（管线先就位，多用户来时 a/c/slip/guess 才结构性可估）。

4. **关键诚实——实例化 ≠ 可信，PFA 是唯一可信决策信号**（有效性天花板，决定 #3 的边界，不可被 #3 软化）。
   - **PFA 是唯一喂决策 / 喂调度的诊断信号**。它把 IRT 的 `b`/`θ`、CDM 的 per-KC 掌握在 n=1 **可估的部分**吸收进单一 logistic（PFA 的 logistic 形态正是 1PL 充分统计量精神的回归化身，稀疏稳健，B1 §4.1）；不可估的部分另建另存但不进决策。
   - **软轨 `a`/`c`/CDM slip/guess 在 n=1 结构性不可估**——不是数据不够，是 n=1 在定义上不提供这些参数赖以定义的「跨考生能力方差」（B1 §3 可辨识性矩阵；承重证据 = Stocking 1990，Psychometrika Q1，摘要逐字核到，本 corpus 最硬地基）。跑经典估计器（DINA/DINO/G-DINA/RUM 的参数估计机器、BKT 的 p(S)/p(G)）多是**原样回吐先验、零信息增量**，只让管线不崩、不是被数据校准过。
   - 因此：软轨列**钉低置信、隔离呈现、绝不喂决策 / 调度 / 硬轨自校验闭环**。allowlist 标 `resolves_when: phase` 时**须写明「软轨列置信上限受 n=1 无 cohort 约束，是结构性天花板，非纯时间问题」**（B1 §6.3 + 总账 §1 B1），否则会误导未来读者以为「等数据多了就能信」。**把 a/c/slip/guess 钉软轨不是工程代价否决（不违反「不计代价」），是「不计代价 ≠ 不计有效性」的直接体现。**
   - ⚠️ **机制推断 vs 实证的边界（B1 §3 审计 M1/M2）**：「IRT 的 a/c 与 CDM 的 slip/guess 是同源死路」是本文档的机制综合判断，**非 Stocking 1990 的逐字结论**（Stocking 证的是 IRT 样本结论；同源到 CDM 是桥接推断）。落 spec 不得写成「Stocking 证明了 CDM slip/guess 不可估」。

5. **慢热自校准四阶段，时间序列不能跳**（Phase 2 §3.3 + B1 §5.2，逐阶段支撑强弱已审计标注）：
   - **① 纯 LLM 先验** —— 全低置信只信相对排序；LLM 不当判分诊断器，只当冷启先验 + 特征抽取（直接 prompt 估难度 `r≈0`，承重源 Acquaye 2026；抽教学特征 `r≈0.78`，Hoyl 2026 NN+IRT；模拟考生 ensemble `r=0.75-0.82`，Acquaye + SMART/Scarlatos 2025 EMNLP CORE-A）。支撑**中（弱地基，预印本为主）**。
   - **② Elo/Urnings 追 `θ`** —— O(1) 在线更新能力，**锁 item 难度防方差膨胀**（n=1 下 Elo/Urnings 只用 θ-更新半边，item-更新半边必须锁死用外部锚——多 agent 系统的 item 在线更新在 n=1 退化回「b 需 cohort」同一道墙，B1 §5.3 审计 G4）。支撑**强**（Pelánek 2016 + Klinkenberg 2011 Math Garden + Bolsinova et al. 2022 Urnings——非「Brinkhuis & Maris」，作者已订正）。
   - **③ fixed-anchor 纠偏 + PPI + 自检** —— owner 客观题确定判分作干净锚，残差 = miscalibration 信号；PPI 数学保证「合成标定 + 真答 ≥ 只用真答」；active learning 选题（Fisher info p≈0.5 + 先验分歧最大）。支撑**强**（PPI/Angelopoulos 2023 Science 逐字核到 + Kolen & Brennan 2004 linking 奠基 + Stocking 1990）。
   - **④ per-knowledge 滚动达标解锁开放题外推** —— **零文献兜底，全栈最薄一环（B1 §7.2 审计 G1）**：降级为「**propose-only + 显式低置信的产品假设**」，外推结果靠 owner 复盘回执（A2 复盘自校准 UI）事后校验，**不当成已标定**。

6. **R 与 p(L) 不对账**（Bjork 失用新论：storage strength 与 retrieval strength 两构念可双向解耦，健康间隔学习本就规律性背离；无对账先例）。二者背离**不触发任何自动修正、非 error-grade**，只在复盘面做 **fluency-illusion 防假学习软提示**（「这点你近期答得顺但间隔拉长后留存可能虚高」，落 `mastery_state.fluency_illusion_flag`）。这是三轴正交红线①的具体落点。

## 后果

**正面**
- 占位公式（`evidence<3→0.5`、无先验、第一证据不更新）退场，换成有先验、第一条证据即更新、含 transfer 的 PFA logistic——ADR-0012 派生原则零损伤，只换承重引擎。掌握诊断从「头三条证据假装 0.5」升级为冷启即可用。
- 三维各管各 + difficulty 共享输入不共享估计值，把「双脑分裂无对账」的隐含设计正式钉成 R⟂p(L)⟂difficulty 三轴正交红线（Phase 2 §4.1），FSRS when 数学永不被 credit/accuracy 污染。
- 四诊断器全建全存：硬轨（b/θ）随真实作答慢热 firm up 有真实价值；软轨保留 = 自校准残差全栈对比的输入 + 诊断下钻丰富度 + 多用户期权（管线先就位，到时 a/c/slip/guess 才结构性可估）。
- 算法判断首次过权威性审计存盘（B1 地基 doc，22 源联网核验、裁定无编造），「为什么 PFA 而非四引擎」「为什么 a/c 不可估」从被压缩对话升格为可追问的正式地基。

**代价 / 风险**
- **「全实例化」的认识论陷阱**：跑了 DINA/G-DINA/IRT-2PL/3PL 不等于有了可信的 a/c/slip/guess。最大风险是未来读者（或 AI）看到 `item_calibration` 软轨列有数就当真喂决策——必须靠 `confidence`/`track` 列 + allowlist 显式「结构性天花板非纯时间问题」注释 + 本 ADR 决定 #4 三重防线堵死。**实例化 ≠ 可信是本 ADR 最易被侵蚀的红线。**
- **慢热第④阶段外推零文献**：「客观题硬轨标定外推到古文开放题」压在无文献支撑的产品假设上（B1 §7.2），只能 propose-only + 埋点事后验证，不能当净结论。
- **锚来源传导性缺口（B1 §7.4 审计 G3）**：硬轨「θ+b 站得住」的地基质量 = 锚的质量；n=1 锚题难度要么来自 LLM 先验（预印本、英文域、古文迁移未验证），要么来自公开题库（古文有吗）。「θ/b 进硬轨」不可继承「锚已可靠」的隐含假设——锚来源 + 锚质量须作独立风险项追踪。
- **difficulty 共享是潜在破口**：`D≡β`「同 logit 语义需 linking」必须落地为「同输入两独立估计」而非「同估计两处读」，写边界要 linking 对齐层；一旦实现偷懒成「FSRS D 直接当 PFA β 读」，正交红线在 difficulty 处破（Phase 2 §4.1 C4 明文标的待钉破口，本 ADR 即其钉死处）。
- **软轨列长期 NULL / 低置信触发 `audit:schema` 债**：`item_calibration` 软轨列 + `mastery_state` 慢热未启用列在慢热期长期 NULL，须进 allowlist `resolves_when: phase` 并附结构性天花板注释（Phase 2 §3.9）。
- LLM 标定承重数字全是 2025-26 预印本、英文数学/阅读域，对古文（项目核心科目）**零直证**（B1 §7.3 审计 G2，比「未评审」更要命的 external validity 缺口）；落地数字须按 B1 §8 核验表的修正口径引用（r≈0.87→arXiv:2504.08804；r≈0.78→NN+IRT 非 random forest；SMART→EMNLP 2025 CORE-A），不得引到错论文。

## 备选（已否决）
- **GPT 稿「四个并行引擎都进决策」router**（IRT/CDM/KT/LLM 各出一票喂决策）——否决：n=1 稀疏数据养不起四个**可信**引擎且四者大量重叠（Phase 1 §5）；PFA 在 Gervet 2020 九数据集的逻辑回归占优区间正落在 n=1 数据规模下极限（head-to-head 强实证，B1 §4.3）。否决的是「四引擎进决策」，**不是**否决计算/保留它们的数据（决定 #3）。
- **B1 地基 doc §4.2「CDM 根本不实例化估计器」的工程建议**——被 owner 2026-06-14「照字面全实例化」覆盖（决定 #3）：doc 的 n=1 零信息结论**保留**作「为什么钉软轨低置信」的依据（决定 #4），但估计器照建照存（产品决策：期权/诊断丰富度/自校准残差）。「跑且存」与「不信且不喂决策」是两件事。
- **保留 `knowledge_mastery` view 的 `evidence<3→0.5` 占位继续调优**——否决：占位的三项硬伤（头三证据假装 0.5、无先验、第一证据不更新）是结构性的，调参数解决不了，必须换引擎（决定 #2）。
- **选 BKT/DKT/AKT 作掌握引擎**（含「BKT + 强先验」对称变体）——否决：BKT 即便贝叶斯化/灌强先验，仍受「单技能结构 + slip/guess item-level 不可估」所限（先验只让管线不崩、零信息增量），DKT/AKT 要跨大量学生交互 n=1 凑不出一个 batch；PFA 参数随交互而非学生数增长、per-KC 计数对单点更新更平滑——这才是弃 BKT 的根本理由，非仅「序列短」（B1 §4.3 审计 G5）。
- **引入遗忘感知 KT（DKT-Forget/HawkesKT/KPT）补记忆维**——否决：与 FSRS 的 `R` 维重叠不互补，让 KT 维重复建模 `R` 已管的遗忘正是「耦合 R 制造信号混乱」同款风险，违反三轴正交（B1 §4.4，亦即 FIRe B 面被砍同理）。
- **difficulty 三层「直接等号」（D = β = b 一处估处处读）**——否决：掩盖 IRT/PFA/FSRS 三者度量差，破坏跨轴独立估计；降格为「同 logit 语义、需 linking 对齐、共享输入各自独立估计」（决定 #1，B1 §6.1 审计 M3）。
