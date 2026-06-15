# b_anchor 可行性 spike — feature→b 锚源能不能做、怎么做、何时做

**Status**: Spike report (方向裁决，非实现)
**Date**: 2026-06-15
**Part of**: YUK-203 · B1 掌握诊断 · ADR-0043（半数据驱动 b）§4 Q2 「feature-based = explanatory IRT 监督学习，产 `b_anchor`，作为锚源绕开识别性墙」的可行性核实。
**Decision source**: 3-lane 研究 workflow（① 训练源数据集核实 / ② feature→b 建模法 / ③ 跨域 transfer + PPI 集成），来源逐条核验 venue / 同行评审 / 引用量。
**Upstream（被本 spike 服务的决策）**:
- `docs/adr/0043-difficulty-data-driven-recalibration.md`（半数据驱动 b 的四路线裁决；`b_anchor` 是其 §4 Q2 的「锚源」角色）
- `docs/adr/0042-mfi-selection-signal-three-layer-engine.md`（选题引擎；π_i 持久化缺口的来源）
- `docs/design/2026-06-15-difficulty-data-driven-research.md`（ADR-0043 承重研究，本 spike 的上游）
- `docs/superpowers/plans/2026-06-15-personalized-calibration-roadmap.md`（YUK-361，8 阶段；feature→b 落地序在 **Phase 6 — Active-PPI Recalibration**）

> **术语锚定（防混淆）**：本仓库没有 v0.4 roadmap 的「Phase 6」承载难度校准——难度校准的实施序在 **YUK-361 个性化校准 roadmap 的 Phase 6（Active-PPI Recalibration）**。下文凡说「Phase 6」一律指 YUK-361 Phase 6，不是 `v0.4-complete-form-roadmap.md` 的 Phase 6。原 spike 题面的「ADR-0043/roadmap Phase 6」即此。

---

## ⚠️ owner 复核纠正（2026-06-15，读本报告前先看这条）
spike 初稿把 baseline 框成「difficulty_proxy(1-5)」——**错**。owner 指出 + 对着代码核实纠正：
- **当前难度已是连续 logit b**（`item_calibration.b`），由 **ItemPriorTask 估、`source='llm_prior'`、低置信**；1-5 只是无标定兜底 proxy。**ItemPriorTask 本身已是 feature-based**（prompt 强制特征分解→b，已躲「直接打分 r≈0」）。故 b_anchor = ItemPriorTask（LLM **in-context** feature→b）的**训练升级版**，不是 vs 1-5、不是新东西；下文 ③节「vs difficulty_proxy / 新题覆盖增量」论据**作废**（ItemPriorTask 已覆盖全题）。
- **真 blocker = 数据**（无中文全科 item 级 b 标签），**非经济性**（owner 拍「无所谓经济性」→ Phase 6 不加经济闸，只留数据可行性 PoC；下文凡提「经济性 go/no-go 闸」作废）。
- **更轻近路**：LLaSA「学生能力模拟」prompt 升级 ItemPriorTask 方法（零数据零训练），先于训练 feature→b 试。
- **承重澄清**：active-PPI（firm-up）才是可靠性承重，冷启先验只管「新题/未答过」。优先级 π_i + active-PPI > 更好冷启先验。
- critic 三处收紧已采纳：胜过 proxy 的真增量收窄、「λ 兜底」只在 Phase 6 PPI 启动后成立、载体成本含 TS 自实现 PPI 栈。

详见 `docs/adr/0043-difficulty-data-driven-recalibration.md` 的「b_anchor 来源」节。**下文初稿正文保留作研究证据，但裁决以本纠正 + ADR-0043 为准。**

## ① 一句话裁决（三选一）

**`b_anchor` = 仅 scale 锚可行；full-per-item b 预测不可行；整体不拒。**

- **full-per-item b 预测 → 不可行（按已反证处理）**：逐题精确预测 IRT 难度 b 是公认难任务。业内最权威盲测（BEA 2024，667 道退役 USMLE MCQ，17 队提交）里最强系统 **RMSE≈0.288–0.308，几乎打不过「永远猜全局均值」的 DummyRegressor≈0.31**（top10 系统彼此差距 ≤0.009）；BERT/transformer 文本嵌入对难度相关仅 **ρ≈0.01–0.21**。在**理想同分布同语言**条件下都做不到逐题精准——跨到中文全科只会更差。
- **scale 锚（供原点+单位的标尺）→ 可行**：ADR-0043 §4 已锁 `b_anchor` 的真实职责**不是逐题真值，而是打破 n=1 logit 平移不变性**（`θ→θ+c, b→b+c` 似然不变），给 b 一个共同原点与单位。这个目标只需要锚在「不同题相对难易」上**大体单调正确**，弱信号（ρ≈0.2 级、正相关）即提供非零、方向正确的尺度信息——而这正是 feature→b 在文献里**能**达到的能力区间。
- **为什么整体不拒**：PPI（Prediction-Powered Inference，Science 2023）的核心定理保证「**预测任意有偏，用金标准样本量化偏差校正后，置信区间仍可证明有效**」——锚多烂统计结论都 valid，锚精度只影响 CI 宽窄；PPI++ 的 λ power-tuning 在锚质量差时自动 λ→0 退化到纯金标准推断（**不会比没锚更糟**）。所以「粗糙但单调合理的锚 + owner 客观题真值去偏」两段式下，feature→b 的低绝对精度从致命缺陷降级为「只影响收敛速度」。

**唯一硬下限 = 「不会比没锚更差」（λ→0 退化保护）。唯一仍按 propose-only 处理的格 = 中文阅读/语文 × 开放题**（ZPD-SCA 2025 负面直证 + 开放题真值非客观闭环、PPI 兜不住，ADR-0043 §代价 #4 已锁，本 spike 不推翻）。

---

## ② 若可行：数据集 + 方法 + 载体 + 集成形态

### 2.1 数据集 — 公开数据按「行为数据 vs 锚训练数据」细分（见 ④ 总论）

5 个候选公开数据集全部核实**真实存在、非编造**（arXiv / PMLR / ACL Anthology / CIKM proceedings / 官方 GitHub / Harvard Dataverse 交叉印证）。作 `b_anchor` 训练源的可用度排序：

| 数据集 | venue / 评审 | 难度标签 | 题面文本 | License | 学科·语言 | 作 b 训练源 |
|---|---|---|---|---|---|---|
| **ASSISTments**（FoundationalASSIST 子集） | KT/EDM 基准（EDM/LAK 系，杂 venue，被引上千） | **强**：显式 Rasch(1PL) item difficulty b | **齐全且罕见**（problem/answer/distractor text；但题面正文需邮件 `etrials+problembodies@assistments.org` 书面同意 ToU 后才发） | **CC-BY-NC-4.0**（非商用）+ Responsible Use | K6-8 数学 · 英文 | **最高**（唯一「IRT-b + 真题文本」双全） |
| **Eedi NeurIPS 2020**（Diagnostic Questions） | **NeurIPS**（CCF-A）竞赛 Track，PMLR v133 | 可派生 + 竞赛含难度任务 | 半残（题面是**图片**需 OCR/VLM；含 4 选项 MCQ + 误解 misconception 标签） | 竞赛条款（非纯开放直链） | 中小学数学 · 英文（图片） | **中**（误解标签 + MCQ 结构有价值，限英文数学 + 需 OCR） |
| **MOOCCubeX**（THU-KEG/学堂在线） | **CIKM 2021**（CCF-B），DOI 10.1145/3459637.3482010 | 无显式 b，理论可从作答正确率派生 | 部分有（exercise 含内容资源 + 637K concept；每题全文完整度**需实测核对**） | 学堂在线授权，GitHub 免费下载（研究用；**商用条款不如 CC 清晰，不确定**） | **中文 · 全科 MOOC**（4216 门课） | **战略最高**（唯一中文+全科），但 b 须自派生、题面完整度 + license 须实测 |
| **EdNet**（Riiid/Santa） | **AIED 2020**（CCF-C/CORE-A 区间），arXiv 1912.03072 | 无显式 b，可从 95M 交互派生 | **无**（questions.csv 仅 7 列匿名 item-id + tags，题干/选项不公开） | CC-BY-NC-4.0 | TOEIC 英语 · 英文 | **低**（无题面正文 → 无法做「题面→b」特征抽取） |
| **Duolingo HLR**（Settles & Meeder） | **ACL 2016**（CCF-A），Harvard Dataverse doi:10.7910/DVN/N8XJME | **无 item-difficulty**（仅 p_recall 记忆半衰期，与难度 b **构念错配**） | **MIT + Dataverse 开放**（可商用，最宽松） | L2 词汇 多语 · 无中文 | **低**（测遗忘率 r 非难度 b，无真题面） |

**结论**：没有任何单一公开数据集能直接覆盖「**中文全科 + item 级 b + 题面文本**」三者——这是本项目的核心数据缺口。现实的两段式数据路径：
1. **方法学/上限校准**用 ASSISTments（IRT-b + 真题文本双全）/ Eedi（误解标签）这类**有 b 标签的英文源**，把「题面特征 → b」的回归方法与可达精度上限**离线标定**出来；
2. **中文全科迁移**用 MOOCCubeX 的中文作答数据**自派生 b**（从正确率/IRT），训中文 feature→b 锚。

### 2.2 方法 — 主路 ③ embedding→b 回归，事后 ① LLTM 可解释层，放弃 ④ 直接 zero-shot

四个方法族都核实过来源 venue / 评审：

| 方法 | 输入 | 报告精度 | 裁决 |
|---|---|---|---|
| **① Explanatory IRT / LLTM**（Fischer 1973；Freund 2008 SAGE APM 同行评审） | 人工设计认知因子 Q-matrix | 图形矩阵 Rasch-b 与 LLTM-b r=0.71；但 LR 拟合检验「几乎总显著→LLTM 被拒」、残差方差大，须升 LLTM+ε / LLTM-R | **当事后可解释性诊断层**，不当主预测器（自由文本题外推差、假设单维能力） |
| **② AIG 难度建模**（Gierl/Lai，医学 MCQ） | 题目模板生成因子 | 图形/类比 r≈0.71；前提是「有基于认知模型的难度理论」 | **不适用**：成熟于结构化/可算法生成题型（图形推理、医学 MCQ 变体），对中文全科开放/主观题无现成路径 |
| **③ LLM embedding → b 回归**（BEA 2024 锚定；arXiv 2502.20663 预印本） | BERT/ModernBERT/LLaMA embedding ± 语言学特征 → ν-SVR/penalized linear probing | 阅读理解 RMSE 0.59 vs baseline 0.92, r=0.77（预印本）；纯语言学特征与纯 embedding 精度相近 | **✅ 主路**：与 TS 栈 + 现成 LLM embedding 端点天然契合，中文全科只换 embedding 模型；性价比最高 |
| **④ LLM 直接/间接估难度** | 直接 prompt 问难度 / LLaSA 学生模拟反推 | **直接 zero-shot 不可靠**（中文 Qwen-max/GLM 低于随机，ZPD-SCA）；间接学生模拟（LLaSA, EMNLP 2024 已评审）更好 | **放弃直接 zero-shot**（系统性偏差，本栈近亲 Qwen/GLM 已负面直证）；间接学生模拟可作冷启动先验叠加，但需作答数据 |

**方法裁决**：主路走 **③ embedding→b 监督回归**；冷启动期可叠 **④ 的间接「学生模拟」**做先验；**① LLTM** 当事后可解释性诊断层；**放弃 ④ 直接 zero-shot**。这与 ADR-0043 §4 Q2「feature-based = explanatory IRT 监督学习」一致——explanatory IRT 是**监督回归**（embedding/特征 → 已标定 b），不是 LLM 自评。

### 2.3 载体 — C 离线预训练 + 查表（唯一与 ADR-0043 两时间尺度同构）

| 载体 | 描述 | 裁决 |
|---|---|---|
| A. 纯 LLM-embedding 内联（Hono/worker 在线推断 b） | ❌ **不推荐**：LLM zero-shot 对中文难度信号弱甚至反向（ZPD-SCA）；内联推断耦合在线回路、违背 ADR-0043 §4「b 信息源在单人在线回路之外」 |
| B. Python 侧车（独立服务跑 explanatory IRT + PPI） | 中性：PPI/active-PPI 工具链（statsmodels/`ipd` R 包/PPI++）多在 Python/R；但本项目是 Node 三进程，引侧车增运维面，且 b 校准是批量慢尺度无需常驻 |
| **C. 离线预训练 + 查表** | ✅ **裁决**：离线训 feature→b + 离线跑 active-PPI 去偏 → 产 `b_anchor/b_calib` 写进 `item_calibration` 表，运行时纯查表。**载体 = `scripts/` 下离线 job + pg-boss 周期触发，结果落 PG 表** |

理由完全由 ADR-0043 的两时间尺度结构推出：b 慢、静态、回路外（§4「b 静态、θ 快」），根本不需要在线/内联，PPI 批处理天然离线，worker 周期性 recalibrate 即可。

### 2.4 集成形态 — 插进 YUK-361 Phase 6 的数据流

```
                       [YUK-361 Phase 6 — Active-PPI Recalibration / deferred]
题面内容 (passage+question+options, 中文)
      │
      ▼ feature→b 模型（③ embedding→b 监督回归，离线，载体 C）
   b_anchor  ──────────────────┐  (item_calibration.source='feature_anchor', 供标尺/原点+单位)
                               ▼
   item_calibration.b_anchor (先验)         ← Phase 6 拆列（现状单列 b，源已有 'llm_prior'|'fixed_anchor'|... 槽位）
                               │
                               ▼
   active-PPI + IPW/AIPW rectifier ◄──── owner 客观题真值（IRT 反推 b，非裸判分，ADR-0043 §deferred #6）
        │  λ power-tuning（锚烂→λ→0 退化到纯金标准）
        │  π_i = 真随机抽样 inclusion prob（ADR-0042 编排档2 tempered-softmax sampler，§deferred #7 positivity）
        ▼
   item_calibration.b_calib (去偏后)         ← Phase 6 拆列
        │
        ▼ 每次更新后 Kolen-Brennan linking 重对齐 θ 标尺（§deferred #4）
   下游：MFI 选题（ADR-0042，b 视为准静态常数）/ θ Elo 快尺度
```

**接缝已经存在**：`src/db/schema.ts` 的 `item_calibration.source` 列注释已列 `'llm_prior' | 'fixed_anchor' | ...` provenance 槽位——`'feature_anchor'` 直接进这个枚举；YUK-361 Phase 6 的 `b` → `b_anchor`/`b_calib` 拆列已在 roadmap 写明（roadmap §Phase 6 Outcome + `src/server/mastery/item-calibration.ts` 注「evolve writer to b_anchor/b_calib in Phase 6」）。**锚只进 b 半边**，θ 半边 Elo 永远视 b 为固定常数（两时间尺度，ADR-0043 §4）。

---

## ③ vs `difficulty_proxy`（1-5）baseline — 强在哪 / 何时值得切

| 维度 | 现状 `difficulty_proxy`（ADR-0043 §3） | feature→b_anchor（Phase 6） |
|---|---|---|
| 信息源 | owner 手填 1-5 序数 | 题面内容（客观、可复算、覆盖新题） |
| 标定 | 序数当 interval、斜率无来源（§3 已 refuted「线性当真值」） | 监督回归到 logit 标尺（虽弱但有标定方向） |
| 覆盖 | 仅 owner 填过的题 | **所有题自动出锚**（含未作答新题，冷启动友好） |
| 失败模式 | 静默错（无去偏机制，仅降权 0.3） | PPI 去偏 + λ 兜底，**失败可控退化（不劣于无锚）** |
| 当前权重 | 0.3 降权占位 | Phase 6 才上线，先验级 |

**强在哪**：(1) 覆盖全题库含新题（proxy 只能覆盖手填过的）；(2) 客观可复算，去掉 owner 主观序数噪声；(3) 进 PPI 框架后**有正式去偏 + 有效性保证**（proxy 没有，只能降权硬扛）。

**何时值得切 —— 不是现在**。值得的触发条件 =
1. **PPI 能启动**：owner 客观题真值攒到 ~数十题级、θ 已稳（ADR-0043 §4 阶段③ / YUK-361 Phase 6）；
2. **π_i 持久化缺口已补**（ADR-0042 编排档2 的 tempered-softmax sampler 落 `selection_observation`，YUK-361 Phase 1+5）——这是 active-PPI IPW rectifier 的硬前置（无真随机抽样 inclusion probability → positivity 不满足 → rectifier 无法启动 → feature→b_anchor 上线也无意义）；
3. **去偏侧真值构造做对**：PPI 的 `Y` 必须是「锚定 θ 的 IRT 反推难度 b」而非裸判分（ADR-0043 §deferred #6），否则会把 b 校成 response-rate 残差。

**在那之前**，`difficulty_proxy` 降权 0.3 占位是**正确的慢热形态**——上 feature→b_anchor 而无 PPI 去偏，等于把弱预测 + 跨域噪声直接灌进 b，**比 proxy 更糟**。

---

## ④ 公开数据用途细分 — 行为数据（拒）vs 锚训练数据（采）

这是 spike 对「能不能用别人的数据」的明确切分，根因是 **n=1 识别性**：

| 用途 | 是哪种数据 | 裁决 | 理由 |
|---|---|---|---|
| **行为数据**（别人的作答序列直接进 owner 的 θ/掌握/调度回路） | EdNet 95M 交互、Duolingo 13M traces、ASSISTments 1.7M 作答**直接喂 Elo/PFA/BKT** | **拒** | owner 是 n=1 单人；他人作答混入会污染 owner 能力轨迹（θ 半边），违背三轴正交与 ADR-0043 §4「b 信息源在单人在线回路之外」。Elo/Urnings item 半边的合法性本就依赖「多人打同题」，n=1 失效（ADR-0043 备选已否决） |
| **锚训练数据**（别人的「题面 ↔ 已标定 b」配对，离线训 feature→b 映射器，产物只是一个**回归权重**，不进 owner 回路） | ASSISTments 的 (problem text, Rasch-b)、Eedi 的 (MCQ, 难度)、MOOCCubeX 中文的 (exercise, 派生 b) | **采** | feature→b 是 explanatory IRT 监督学习，学的是「题面特征 → 难度标尺」这个**跨人不变的映射**，不是某个人的能力。产物（回归头/embedding probe）应用到 owner 的题面上出 `b_anchor`，再由 owner 自己的客观题真值经 PPI 去偏——**他人数据只塑形了标尺方法学，没进 owner 的能力估计** |

**一句话**：拒「借别人的作答当 owner 的行为证据」（n=1 红线），采「借别人的 题面↔b 配对训一个离线难度标尺映射器」（feature→b 锚源的合法本意）。License 上 ASSISTments/EdNet/Eedi 多为 CC-BY-NC（非商用研究用），本项目是自用工具，研究用途内可用；商用边界与 MOOCCubeX 条款须实测核对（见不确定项）。

---

## ⑤ 诚实天花板 + 不确定项（哪些需真跑小原型才能定）

### 诚实天花板（结构性，工程救不了）
1. **feature→b 绝对预测力本就弱**：BEA 2024 同分布英文条件下几乎打平常数 baseline（RMSE 0.29 vs 0.31）；BERT ρ≈0.01–0.21。`b_anchor` **只能当标尺锚，永远不能当逐题真值**——这强化而非削弱 ADR-0043 的现有裁决。
2. **跨语言+跨域+跨科目三重 shift 叠加**：跨语言 zero-shot 阅读理解 exact-match 平均掉 ~55.8% / F1 掉 ~50%；难度的强特征（cohesion/长度类语言特征）高度语言依赖（中文分词/句法/字词频与英文不同构），是 transfer 最先崩的部分。**naive transfer 按大概率不可用对待**，靠 PPI 用 owner 真值去偏兜，不靠 transfer 本身准。
3. **中文阅读/语文 × 开放题格负面直证**：ZPD-SCA（中文阅读，Qwen-max 30.61%/GLM 26.59% 低于随机 33.3%，系统性高估文本难度）。该格 PPI 兜不住（开放题真值非客观闭环）→ **propose-only**，不上 feature→b_anchor。**数学/理科/客观题格 ZPD-SCA 不覆盖，不按已反证处理**（数学难度强特征如步骤数/运算复杂度跨语言更稳定）。
4. **b vs a/c/slip/guess 分水岭**：feature→b 只能产位置参数 b；区分度 a / 猜测 c / slip 结构性不可识别（需跨考生方差，连锚都救不了，ADR-0043 §代价 + Stocking 1990）。

### 来源真实性诚实标注（防预印本当权威）
- **同行评审正面锚**：PPI（**Science 2023**, DOI 核到）/ Active-PPI（**ICML 2024 Oral**, PMLR v235）/ LLaSA（**EMNLP 2024**）/ Freund 2008（**SAGE APM** 同行评审）/ BEA 2024（**ACL Anthology workshop** 评审）/ Can-LLMs-Estimate-Cognitive-Complexity（**ACL 2026 Main 已接收**，结论偏正面）。
- **预印本（作风险信号，不当定论）**：ZPD-SCA（arXiv 2508.14377，未见刊，负面直证）/ 阅读理解 RMSE 0.59 那篇（arXiv 2502.20663）/ Text-Based Item Difficulty（arXiv 2509.23486）。
- **诚实声明**：文献里**不存在**「同一 feature→b 模型在英文数学训、直接迁中文全科 item」的端到端直证实验——本 spike 的跨域结论是从相邻证据（跨语言 transfer 普遍降级 + 难度预测天花板低 + 中文负面信号）**组合推断**，不是直证。
- **二进制未解析项**：BEA overview PDF 与 ReCo PDF 二进制未逐字核验，精确数字（0.29/0.31、667 题、17 队）来自多个独立 snippet 一致转述，勿当逐字精确值。

### 需真跑小原型才能定的（spike 给不了，要 PoC）
1. **MOOCCubeX 实物**：每道 exercise 的题干完整度、其 license 商用许可边界、交互-题目对齐质量——须下载实物核对，**不确定**。
2. **Eedi 当前（2026）获取入口**是否仍开放——须查最新竞赛条款，**不确定**。
3. **feature→b 在中文全科的真实可达精度上限**：用 MOOCCubeX 自派生 b 训一个 embedding→b probe，跑 held-out ρ/RMSE，看是否达到「单调正相关」这个 scale-锚最低 bar——这是上 Phase 6 前唯一必须先验证的数字。
4. **mimo/Qwem embedding 对中文难度的信号强度**：本栈 embedding 端点出的向量对难度排序到底是 ρ≈0.2（够当锚）还是 ≈0（不够），须实测——ZPD-SCA 测的是 LLM *zero-shot judge*，不是 *embedding→监督回归*，二者机制不同，不能直接画等号，所以这条仍需独立 PoC。

---

## 给 ADR / roadmap 的具体修订建议（增量标注，不另开 issue）

1. **ADR-0043 §4 Q2 feature-based 行**补风险标注：feature→b 绝对预测力本就弱（BEA 2024 同分布≈打平常数 baseline；BERT ρ≈0.01–0.21），定位只能是「标尺锚」绝不可当逐题真值——强化现有裁决。
2. **ADR-0043 §代价「中文阅读格负面直证」**：把 ZPD-SCA 明确标为**预印本未见刊**，补 Can-LLMs-Estimate（ACL 2026 接收，偏正面）作对冲——该格图景是「矛盾未收敛」而非「已反证」，与现有「数学/理科不按反证处理」措辞一致。
3. **ADR-0043 §deferred #1（π_i 持久化）= YUK-361 Phase 6 真正的 gating blocker**：在 spec 升级优先级标注——没有真随机抽样 inclusion probability（positivity），active-PPI IPW rectifier 无法启动，feature→b_anchor 上线无意义。π_i 来源已闭合到 ADR-0042 编排档2 tempered-softmax sampler（YUK-361 Phase 1+5）。
4. **载体裁决「C 离线查表」**写进 YUK-361 Phase 6 spec，避免后人误选内联 LLM-embedding（中文 zero-shot 反向风险）。
5. **`item_calibration.source` 枚举**在 Phase 6 拆列时补 `'feature_anchor'` provenance 值（现注释 `'llm_prior'|'fixed_anchor'|...` 已留槽位）。

---

## Linear issue 捕获门

本 spike 为只读研究（无代码变更），所有可执行 follow-up 均落在**既有 YUK-361 / ADR-0043 spec 内**，无需新建顶层 Linear issue：

- 上述 5 条修订建议是对 **ADR-0043 + YUK-361 Phase 6** 的增量标注，应在 spec 更新时并入，而非另开 issue（避免与 YUK-361 重复）。
- ④「需真跑小原型才能定」的 4 项（MOOCCubeX 实物核对 / Eedi 入口 / 中文 feature→b 精度 PoC / 本栈 embedding 难度信号实测）应作为 **YUK-361 Phase 6 的前置 spike 子项 / blocker 注释**，由 YUK-361 epic 统一承载，不宜在本子任务零散开 issue。

若 owner / 统合阶段认为「§deferred #1 π_i 持久化缺口」或「中文 feature→b 精度 PoC」需独立可追踪，建议作为 **YUK-361 子项 / blocker**，而非新顶层 issue。

---

## Sources（按 venue/评审分层）

**同行评审（权威锚）**
- Prediction-Powered Inference — *Science* 382:669-674 (2023), DOI 10.1126/science.adi6000
- Active Statistical Inference — Zrnic & Candès, ICML 2024 Oral, PMLR v235 pp.62993–63010
- LLaSA "LLMs are Students at Various Levels" — EMNLP 2024
- Freund, Hofer & Holling (2008) — *Applied Psychological Measurement* 32(3), SAGE
- BEA 2024 Shared Task overview & systems — ACL Anthology 2024.bea-1.*
- Can LLMs Estimate Cognitive Complexity of RC Items? — arXiv 2510.25064（ACL 2026 Main 接收，偏正面）
- Explanatory item response models tutorial — ScienceDirect

**会议/期刊（数据集来源）**
- EdNet — Choi et al., AIED 2020 (Springer LNAI 12164) / arXiv 1912.03072
- Eedi NeurIPS 2020 Education Challenge — Wang et al., PMLR v133 pp.191-205 / arXiv 2007.12061
- MOOCCubeX — Yu et al., CIKM 2021, DOI 10.1145/3459637.3482010 / github.com/THU-KEG/MOOCCubeX
- Duolingo HLR — Settles & Meeder, ACL 2016 / Harvard Dataverse doi:10.7910/DVN/N8XJME
- ASSISTments FoundationalASSIST — huggingface.co/datasets/ASSISTments/FoundationalASSIST

**预印本（风险信号，非定论）**
- ZPD-SCA — arXiv 2508.14377（未见刊，中文阅读负面直证）
- Text-Based Item Difficulty Modeling — arXiv 2502.20663 / 2509.23486 / aclanthology 2025.aimecon-sessions.5
- PPI++ — arXiv 2311.01453（→ Annals of Applied Statistics 在途）
