# X 算法发现 × 现有学习算法框架 — 融合映射设计

> **类型**：设计文档（final，融合框架版 / 对抗评审融定稿）
> **日期**：2026-06-25（融合重写）；对抗评审融定 2026-06-26
> **源材料**：`docs/research/2026-06-25-x-algorithm-deep-dive.md`（X 2026 推荐算法深潜，§3-§7 架构、§10 迁移映射 + 反向洞见）
> **主线 Linear**：YUK-405（私人教研团 / 推荐引擎 rethink）；算法 issue 群在 YUK-203 / YUK-452 之下
> **设计意图基准**：报告 §10 的「抄架构纪律、拒数据前提哲学」结论，作为 agreed intent，不再重新论证。
> **本稿性质**：这**不是**「新建一个 X 推荐引擎」的设计。我们的学习算法框架已经成熟（FSRS 调度 + IRT/PFA 诊断 + active-PPI 标定 + KG + 冷启动专路 + 选题流水线），且大量决策已经落进既有 YUK issue 与 ADR。本稿是把 X 报告里**可借的每一条发现**，逐条**融进既有 issue / ADR 的归属**，并打上 VALIDATES / REFINES / ALREADY-BETTER / N/A / CONFLICTS 裁决。**前一版「独立引擎」叙述作废，被本融合叙述取代（见文末）。**

---

## 1. 摘要

- **这是一次融合，不是一个新引擎。** 框架已成熟：选题流水线（`softmax-selection.ts` Source→Hydrator→Scorer→Selector→SideEffect）、三轴正交（FSRS R / mastery p(L) / item b）、active-PPI π_i 标定、冷启动 KLP-冷簇 vs MFI-暖簇路径选择、KG 拓扑、内容理解独立层——**这些早已存在并接进既有 issue/ADR**。X 报告的作用是给它们做**外部印证**，外加少数几条**具体 REFINE**，再加一批 **n=1 下我们已更强**的地方。
- **X 主要是外部印证（VALIDATES）。** 最强的几条：基值打分层 per-candidate 纯（§4.4.4 印证 ADR-0042 score 层）、冷启动单独建先验路径（§6/§10 印证 YUK-435/YUK-452）、显式权重对抗隐藏系数（§5/§7 印证 ADR-0042 explicit-weights）、event-as-substrate（§3 印证 ADR-0044）、内容理解独立成层（§4.5 印证 YUK-482）、collect-live-defer-flip（§3/§8 印证 `feedback_defer_flip_not_build`）。
- **少数几条具体 REFINE（落到既有 issue）。** 作者多样性几何衰减乘子 → YUK-370；DAD 非短视 → YUK-446；grox-style plan-DAG → YUK-406；item_calibration 投影=确定性 fold → YUK-496；candidate-isolation **按名写进 ADR-0042（scoped 到基值层）+ 补缺失的 batch-invariance 测试** → ADR-0042/YUK-493；冷启 per-candidate cold-KC 探索乘子（小）→ YUK-435/452。
- **n=1 下我们已更强（ALREADY-BETTER）——别改方向。** X 结构性缺失而我们有的：item 难度/SE/后验方差（YUK-436 暗推升级 + live Elo-Fisher SE，YUK-361/461/439）、mastered→停止花预算（MEPV YUK-443）、typed-failure 错因/错步粒度（YUK-437/438）、把负信号当**诊断学习信号**而非仅排序压制（ADR-0036）、显式入代码可 diff 的权重、online per-attempt 更新（非冻结 checkpoint）、graph-Laplacian 先验（YUK-441）、per-KC 冷检测（非 per-account）、evidence-first 摆理由 surfacing（YUK-476）、owner 固定锚 b-offset（YUK-453）。
- **拒 1 个哲学（CONFLICTS）。** 拒「消除手工特征 / 让大模型 learn 一切」——§10 反向洞见明说：X 自己都退到「most heuristics」+ 单独冷启动先验路径。n=1 无训练流，手工特征/先验是 day-one 资产不是债务。连带拒：隐藏系数、embedding-recall 双塔、Kafka-events-as-training-feed、强制全链候选隔离（含 LLM 编排）、brand-safety/PTOS/OON 压制、冻结 checkpoint 推理。
- **单条最大收获**：X 是地球上数据最丰的 recsys，**即便如此它都不让主模型从零冷启动新用户、都保留手工启发式、都把权重藏起来不可审计**——这同时**印证**了我们 n=1 priors-first + 显式权重的全部核心决策，又**反衬**出我们在校准/SE/错因诊断/摆理由上结构性更适合学习这个 domain。

---

## 2. 立场更正

**要避免的反模式**：把 X 报告读成「这里有一个新的 X 推荐引擎要加进来」，于是去建一条与现有框架**并行的「X 引擎」**（新表、新 scoreCandidate 模块、新召回栈、新一套 follow-up issue 群）。这会与既有的 `softmax-selection` 流水线、ADR-0042 选题 seam、ADR-0035 三轴、YUK-203/YUK-452 算法 issue 群**重复登记同一职责**，制造碎片化（违 `feedback_no_scope_fragmentation`），并且把已成熟、已接线、已 dark-ship 的机制当成「待造」重写一遍。

**选定的框架**：把 X 的每一条可借发现，**融进既有 issue 的归属**——以现有 YUK-ID + ADR 为锚，给每条打 VALIDATES/REFINES/ALREADY-BETTER/N/A/CONFLICTS 裁决。绝大多数是「在既有 issue body 上补一条 X 印证/REFINE 注记」，不是新 issue。home 仍是 YUK-405（教研团/推荐 rethink）+ YUK-203/YUK-452 之下的算法 issue 群。ADR-0042/0043/0044 收文档级注记。**genuinely-NEW 几乎为零**（唯一候选见 §7 决策 f / §8.4）——这正是融合（而非新引擎）框架的全部意义。

---

## 3. 融合总表（THE CORE）

> 列：X 发现（§ref）｜ 现有归属（YUK-ID + ADR + path:line）｜ 裁决 ｜ 具体融合动作。按 6 个领域分组。代理分歧已在表内/§后注调和。

### 3.1 选题 + 召回（ADR-0042 / YUK-203）

| X 发现（§ref） | 现有归属（YUK + ADR + path:line） | 裁决 | 具体融合动作 |
|---|---|---|---|
| 候选隔离 = per-candidate 可缓存打分，transformer mask 使每条候选分=纯函数、batch-order-无关（§4.4.4） | 基值打分层 `candidate-signals.ts:338-399`（mfiScore/klpScore/diagnosticScore per-candidate 纯，皆 from `(thetaHat,b,thetaPrecision)`）；核心数学 `src/core/selection-signals.ts:81,169,199`；ADR-0042 §1「L1 确定性证据基座」；YUK-493 同构核 | **VALIDATES** | X 独立印证「确定性基值打分层是 per-candidate 纯函数」。把不变量按名写进 ADR-0042，**且范围精确到基值层**：「candidate-signals 基值打分层（MFI/KLP/diag）MUST per-candidate 纯 + batch-order-无关（可缓存）；跨候选耦合**只允许**在三个明确命名的下游层——(1) 确定性后置乘子层（多样性/疲劳/OON，YUK-370）、(2) IPPS-sampler、(3) LLM 编排层；θ̂-更新路（漂 θ_global，YUK-466）显式排除」。这镜像 X 自己的 PhoenixScorer（隔离/可缓存）⊥ RankingScorer（非隔离后置处理）分层。**诚实前提**：我们今天**有** per-candidate 纯打分函数，但**没有** batch-invariance 测试——补测试才是真正的活（见 §3.6）。 |
| X 在重模型（transformer）里**强制**全链隔离以求可缓存/扩展性（§4.4.4） | LLM 编排器**故意违反**：`src/server/ai/selection-orchestrator.ts:112`（整批 prompt）+ weight/arrangement batch-耦合（ADR-0042 amendment「让 LLM 强」） | **CONFLICTS / REJECT**（自觉分歧，非 bug） | 不要引入 X 的「处处强制隔离」。n=1 无可缓存/延迟压力（一个学习者、夜间 compose + 廉价增量重排），用可缓存换 batch-aware 教学法 LLM 是对的。在 ADR-0042 记录**为何分歧**（§10：X 的隔离是它为规模付的让步，我们不付）。统计兜底 `statisticalWeights`（`softmax-selection.ts:479-481`）保留为 per-candidate-纯的缓存友好逃生路。 |
| 加权和价值 = 线性核心 + 后置乘子（§5：`combined=Σ P(action_i)·w_i` → offset 重标 → 作者多样性几何衰减 `(1−floor)·decay^pos+floor` → OON 乘子） | 基础价值=单一信息泛函（MFI/KLP）或 LLM 权重；多样性=`roundRobinBySubject`（`due-list.ts:136`，仅 subject，**不在 softmax 路径**）；疲劳/重复罚=ADR-0042 §6⑥⑦**已 spec 未实现**；YUK-370（kind/review_format 作 mix 维） | **REFINES → YUK-370** | X 的作者多样性**几何衰减乘子**是填 YUK-370/§6⑥⑦ 留给 LLM discretion 那个缺口的确定、便宜机制。给 YUK-370 加：确定性 same-family/kind/review_format 衰减 `multiplier(pos)=(1−floor)·decay^pos+floor`，作为 sampler 前对候选权重的后置乘子（按 `root_question_id` 家族 + `review_format` keyed）。**关键定位**：几何衰减按「同族候选中已排名位置」生效，其值对候选 X 依赖于哪些候选排在 X 前——**因此它本身就是跨候选的**，属上面命名的「确定性后置乘子层」，**不在** per-candidate 纯基值层内（否则与决策 (a) 的不变量自相矛盾）。这正镜像 X 把作者多样性几何衰减放进 RankingScorer 而非 PhoenixScorer。 |
| OON 乘子为冷启动/新用户加权（§5/§6：`NEW_USER_OON_WEIGHT_FACTOR`，故意多喂新用户探索内容） | KLP 冷启打分门控 `evidence_count < EARLY_KLP_N=4`（`candidate-signals.ts:389`，`src/core/selection-signals.ts:131,141`）；ε-greedy 下界（`selection-sampler.ts:64,147`）；ADR-0042 §6⑥ 反舒适区 ≥1 frontier；YUK-435（A3 KLP 冷启）、YUK-452 冷启 epic | **VALIDATES** YUK-435 + 冷启动-first | X 独立印证「为冷启动故意抬探索」——正是 KLP（θ̂ 波动时后验加权信息）+ ε-greedy 下界 + frontier 配额已在做的。连 X 都给冷启动单独簇 + 抬探索，外部证据**加速/去险** YUK-435 全量 live + 撑 YUK-452「靠先验 day-one」。无代码改动，作证据引入。 |
| 召回 ⊥ 打分序列分段（§6：召回用正向-only `Dense` 序列无 prediction_id；打分用更丰富 `DenseWithNotInterestedIn` 含负信号——两次独立调，各阶段不同表示） | 召回=结构候选生成（FSRS due + KG frontier + variant rotation，`due-list.ts`/`target-discovery`）；打分=`candidate-signals` θ̂/b/precision **+ misconception_recurrence 仅进打分/编排、绝不进召回**（`candidate-signals.ts:401-416`「SELECTION-ONLY」，`src/core/selection-signals.ts:60-68`）；ADR-0042 §1 L1/L2 分 | **VALIDATES** | X 记录的阶段分离——宽/正向倾向召回 vs 丰富/含厌恶打分——已是我们的架构：召回 mastery-无关结构性，打分叠加丰富诊断态（负信号 misconception_recurrence 正确限于打分、绝不进召回）。无新 issue，记录 X 印证既有边界。 |
| 暴力精确召回，非 ANN（§3b/§4.4.1：README 写「ANN」但代码是 `jnp.matmul` 全点积 + top_k；537K demo 够）+ §10「题库 ≪ 537K，brute-force 够，别上 ANN」 | 选题侧**完全无向量召回**——结构 SQL/FSRS/KG 查询（`due-list.ts` inArray、frontier CTE、family rotation） | **ALREADY-BETTER / VALIDATES** | 我们已严格比 X 的 brute-force 更简：结构召回更便宜、可解释、n=1 合身。X 反向洞见预防一个伪需求：若将来加语义候选召回，本规模暴力精确点积足矣——**不要** FAISS/ScaNN/HNSW。无 issue，记为防过度工程护栏。 |
| 负信号带负权重（§5：not_interested/block/mute/report 负权压制；§10 映射「预测会放弃/会挫败，负权」） | MFI 在 θ̂=b 峰（`src/core/selection-signals.ts:81`）→ 过难题信息分低=隐式压制难度失配；misconception_recurrence 是**正**极性（surface 失败做补救，意图相反）；ADR-0042 §6⑦ 疲劳罚（已 spec）；LLM 定性疲劳判断 | **ALREADY-BETTER**（+薄 REFINE） | n=1 下我们的 MFI 难度匹配是**有原理的**隐式厌恶压制，优于 X **学到的**负权（§10：我们无训练流去学负权，X 从海量 engagement 学）。核心 ALREADY-BETTER。薄 REFINE 给 YUK-370/§6⑦：把舒适区/挫败项做**显式 owner-定死的负乘子**（非学习），让「别用一串过难题打击」确定化而非 LLM-discretion——与多样性衰减乘子同属后置乘子层，配对。低价值，并入 YUK-370 refine，不另拆。 |
| X 无学习者级停止规则——无限 feed，唯一「停」=TopK + result_size 截断（§5） | YUK-443（MEPV stop-at-0.95）；容量护栏 `capacityGuard`/`DEFAULT_MAX=30` | **ALREADY-BETTER** | X 无「KC 掌握→停止花预算、转投不确定 KC」的类比。YUK-443 MEPV-停在-0.95 是 X 结构性缺失的学习域机制。不要引入 X 的 always-serve。X 的 TopK/截断只印证我们的容量上限，仅此而已。 |
| X per-candidate 短视 by design（正是这使候选隔离/可缓存）+ 贪心 TopK（§4.4.4） | live MFI/KLP/A7 同为短视贪心；LLM 编排 `arrangement`+批权重是已有的启发式非短视排序；YUK-446（DAD 非短视） | **VALIDATES（短视默认）+ REFINES → YUK-446** | X 印证短视贪心是合理默认。但：(a) LLM 编排的 arrangement 已是 ad-hoc 非短视排序，YUK-446 DAD 是其**有原理替代**（REFINE）；(b) 非短视 DAD **直接破** per-candidate-可缓存不变量——在 YUK-446 标注此张力：n=1 无缓存/延迟压力才令其可接受（同 §10 X 隔离是规模让步的道理），须是自觉权衡。net：n=1 可负担非短视，YUK-446 仍是有理由的未来分歧，但必须显式承担可缓存代价。 |

### 3.2 校准 + active-PPI（ADR-0042 / ADR-0043 / YUK-452）

> 旗标实测：`HIERARCHICAL_ELO_ENABLED=true`（`theta.ts:184`）、`SRT_ENABLED=true`（`theta.ts:234`）、`THETA_GRID_ENABLED=false`（`theta-grid.ts:54`）。**live SE 归属须精确**：当前 live 的 `thetaSe`/`theta_precision`/MasteryProjection 带由 **Elo-Fisher 路**（YUK-361 + YUK-461 harness，`se=thetaSe(row.theta_precision)` `state.ts:313`）产出；**YUK-436 是其上的 grid-Bayes 升级，处于暗推**（gated `THETA_GRID_ENABLED=false`，`klpScoreFromGrid` 永不取此值，`src/core/selection-signals.ts:42-43`）。

| X 发现（§ref） | 现有归属（YUK + ADR + path:line） | 裁决 | 具体融合动作 |
|---|---|---|---|
| 权重是**隐藏系数**，不在仓库——每个 engagement 权重/offset/OON 因子、整个 params 模块 + feature-switch 配置文件都缺席；「零硬编码、无默认、无配置文件」（§5/§7） | ADR-0042 explicit-weights；系数在代码内：`PFA_GAMMA=0.4`/`PFA_RHO=-0.2`（`src/core/pfa.ts:45-46`）、`ELO_K_GLOBAL=0.048`（`theta.ts:194`）、`DIFFICULTY_PROXY_WEIGHT=0.3`（`theta.ts:137`）、`RECALIBRATION_MIN_LABELS=12`（`recalibration.ts:257`）；注释「NO config table, NO env」（`theta.ts:161`） | **VALIDATES** | 印证 ADR-0042 explicit-weights + evidence 留痕（`feedback_ai_agency`）。X 最大可信度漏洞——真正调系统的数字不可审计——正是我们 module-const 模式禁止的。**给 ADR-0042 加一行**引 X §5/§7 作外部证据：隐藏系数=不可审计的 feed；任何人提议把权重搬进 DB/env 配置表时引此抵制（保持 code-reviewed const）。 |
| X **无** item 校准 / 无 SE / 无不确定性概念——phoenix 是纯多标签 engagement transformer（§4.4.5 两头=engagement logits + 连续 sigmoid，处处无难度/能力/后验方差） | live Elo-Fisher SE：Fisher `theta_precision`/`thetaSe`（`state.ts:313,316`，MasteryProjection `low_confidence`/`mastery_lo`/`mastery_hi` :266-273）（YUK-361/461，live）；YUK-436 grid-Bayes SE 升级（暗）；YUK-461 ECE/forward-AUC/κ harness（`src/server/calibration/*`）；YUK-439 σ²；item_calibration b/b_anchor/b_calib（`schema.ts:957-964`） | **ALREADY-BETTER** | 对 n=1 严格更合身：X 能跳过校准只因十亿曝光让 transformer 隐式吸收难度；n=1 无此信号流，**必须**带显式 per-item 难度 + 后验 SE 才知道何时信任薄先验。**精确**：使我们 ALREADY-BETTER 的 live SE 来自 Elo-Fisher 路（YUK-361/461），YUK-436 是其暗推的 grid-Bayes 升级。**无动作——这是要守的强项**。在 YUK-461 body 注「SE/ECE/forward-AUC 在大规模 engagement 栈无对应（X §4.4）——它们存在正因为我们 n=1 须量化先验信任度」。 |
| 冻结-checkpoint 推理，无训练循环（§4.4.6：「无训练代码…发布是冻结推理 checkpoint」，零 optimizer/grad/loss） | online Elo θ̂ in attempt tx（`updateThetaForAttempt`，`state.ts:482`）+ 序贯-Bayes grid fold（`state.ts:815-829` `gridUpdate`）；皆 per-attempt 更新 | **ALREADY-BETTER（n=1）** | 冻结 checkpoint 对 X 对（离线在 firehose 重训），对 n=1 灾难（无 firehose→checkpoint 永不进步→冷启动死循环，§10 洞见#1）。online per-attempt 是 n=1 正确选择：每答即当日 firm（YUK-361「每晚没 mastery_state 就是一天校准损失」）。**无动作**，记为已闭决策；不接受「离线训难度模型」重构。 |
| 模型 artifact 经 LFS，量级隐藏（§9：`oss-phoenix-artifacts.zip` 是 135B LFS 指针，真 `config.json` 磁盘不存在） | 无 artifact 依赖——校准是 TS 内闭式/online 数学（`core/theta.ts`、`core/pfa.ts`、`core/theta-grid.ts`），态在 Postgres（mastery_state、item_calibration） | **ALREADY-BETTER / N/A** | 我们无不透明二进制 blob；每参数是 const 或带 provenance 的 DB 行（item_calibration.source/calibration_weight/last_calibrated_at）。Rust 同构核（YUK-493）刻意保 bit-exact 可复现——与未版本化 LFS checkpoint 相反。**无动作。** |
| 候选隔离不变量：per-candidate 分=纯 fn of {user,history,self}，batch-order-无关、可缓存（§4.4.4，§10 行1 显式映射到同构核「确定性、parse-barrier、时时刻刻守不变量」） | YUK-493/YUK-495 同构 Rust 核（确定性红线，`project_rust_isomorphic_core`）；`effectiveB(row)` 纯（`recalibration.ts:90-93`）；per-KC θ̂ **读路**只依 (态, item) | **VALIDATES（scoped 到读/打分路）** | X 独立印证同构核要守的确定性/纯性不变量——但范围须精确：**打分/读路（读 effectiveB + θ̂/p(L)）是 (态,item) 纯函数**；**θ̂ 更新路不是**——`HIERARCHICAL_ELO_ENABLED=true`（live）下每次 attempt 还会按 domain 漂移共享 `θ_global`（`theta.ts:173`；effective ability = θ_global(domain)+θ_KC；`state.ts:712-714`；YUK-466 记录此跨-KC 耦合）。故不变量只锚定 batch 内打分/replay 计算（同构核 bit-exact 的对象），**不**锚定写态的更新路。强化路由此代码到 opus（`feedback_sonnet_weak_on_invariant_code`）。 |
| §10 反向洞见：对 n=1 拒「消除手工特征」——手工特征/先验是资产非债务，连 X 都保 ~18 filters + 3 score heuristics + 冷启动先验路径，README 退守「most heuristics」（§7 行4，§10 #2/#3） | 整个校准栈是「手工特征」：LLM `ItemPriorTask` b_anchor（YUK-361/`src/server/mastery/item-calibration.ts:41`）、固定锚 bucket→logit（YUK-453）、FSRS 理论、KG prereq 拓扑 | **VALIDATES / CONFLICTS-with-X-哲学** | X §10 是 `feedback_cold_start_first` 的权威外部表述：对 n=1 day-one，先验**就是**产品。印证 YUK-453（固定锚）不是 stopgap 而是正确架构。**给 YUK-452 epic body 加** X §10 引用（「连 X 都给冷启动单独建先验路径，而非指望主模型从零学」）抵御任何「等数据」异议。 |
| X 召回⊥打分用两条独立调优序列（§6：UserActionAggregation 调两次，召回=`Dense` 正向压缩无 prediction_id，打分=`DenseWithNotInterestedIn` 含负信号，长度/聚合不同） | 选题（MFI/KLP，ADR-0042）vs 校准（active-PPI π_i，ADR-0043）**已是分开信号路**；π_i selection-observation 喂 recalibration IPW（`selection-sampler.ts:6`，`softmax-selection.ts:78`）；选题本身**只读** effectiveB（`recalibration.ts:11-13`：离线写 b_calib、在线只读）；YUK-439 per-item σ²（Backlog） | **VALIDATES**（**非 REFINES**——前稿过报） | X 印证「估计-更新路 ⊥ 行动路 可用不同信号 conditioning」——这在我们**已是 live 架构**（recalibration 离线写 b_calib，在线路只读 effectiveB）。YUK-439 的 per-item σ²（管观测多快盖过 LLM 先验、σ² 是 per-item 非全局 λ）**本就是 YUK-439 自身 scope**，故为 VALIDATES 而非新增 refine。σ² ↔ X §6 conditioning-分离 只是**松散类比**（X 喂梯度训练、我们喂确定性 AIPW），不由 X 蕴含，勿借此抬高 σ²。 |
| 加权和价值函数含负反馈头在负权（§5：not_interested/block/mute/report 进 `negative_sum`） | 这是选题/价值函数发现（ADR-0042 MFI），非校准 | **out-of-scope**（路由到选题域） | 见 §3.1 负信号行；校准的 b/θ̂ 无「负 action 头」类比（二元 outcome 已带符号）。 |
| YUK-432/YUK-372「WIRED-BUT-INERT」陈旧旗标 | auto_rate 端到端：client `practice-api.ts:315`、PfSolo `PfSolo.tsx:193`、backend gate `src/capabilities/practice/api/submit.ts:735→761 recordDifficultyCalibrationLabel`、`recalibration_nightly` cron `manifest.ts:272`；DB 测试 `submit.db.test.ts` | **STALE → RESOLVED**（内部修正，X 无关） | 诊断「auto_rate 门卡死→label 恒空→b_calib 永 NULL」**已不成立**：产数据开关已开。caveat：b_calib 仍 NULL 直到每题攒 ≥12 labels（`RECALIBRATION_MIN_LABELS=12`）——这是良性 idle（机器开、数据在攒），非恶性死结。**裁决：YUK-432/YUK-372 正确标 Done，陈旧旗标顾虑已在现码解除。** |

### 3.3 掌握度 + 诊断（ADR-0035 / ADR-0036）

> 前提更正（须传播）：**YUK-420 已 Done**，`evidence<3→0.5` 占位在 5 个消费者**已无效**——全读 `getMasteryProjection`（`tree.ts:93`、`node-page.ts:195`、`review-plan-tools.ts:179`、`knowledge-readers.ts:163`、`src/server/questions/detail.ts:308`）；view DDL 里 `0.5::real` 分支仍在但对 mastery 是死码，唯一残留 view 读是正交的 `last_active_at`（`knowledge-readers.ts:169`）。任何引「占位仍在 5 消费者」的 lane plan 应更新。

| X 发现（§ref） | 现有归属（YUK + ADR + path:line） | 裁决 | 具体融合动作 |
|---|---|---|---|
| signed-action 输入编码 `actions_signed=2·actions−1`——「没喜欢」是显式 −1 不是 null（§4.4.3） | PFA 证据编码——`src/core/pfa.ts pfaLogit` + `PFA_GAMMA/PFA_RHO`；`state.ts:316,698-701`；冷启 NULL `state.ts:289-293`；ADR-0035 p(L) 轴 | **VALIDATES** | X 独立印证核心 PFA 决策：把负观测建为**signed、分开加权**信号（fail→ρ），null 留给**无观测**（冷启缺行）。**X 的三态（engaged +1 / saw-but-didn't −1 / never-saw null）我们已全覆盖**：correct（γ）/ fail-got-wrong（ρ）/ no-attempt（缺行）。注意**勿混淆**：「做错」是**正观测带负 outcome**（ρ），**不是** X 的「−1 缺席」。无代码改。引此论证保留分开的 fail-斜率 ρ 而非折成正确率。 |
| signed −1 编码 vs typed-failure（§4.4.3：X 把每动作塌成 ±1，无「哪种负」粒度） | YUK-437（A8 distractor→misconception typed fail）；`mistake_variant.cause_category`（`schema.ts:1153`）、`failure_reasons`（`schema.ts:1149`） | **ALREADY-BETTER** | **不** REFINE YUK-437——我们严格更细。X 每动作类型一 ±1 bit。YUK-437/A8 把**具体所选 distractor→具体 misconception**（typed fail），YUK-438 把**具体失败 rubric step→具体 KC**。X 无 per-distractor/per-step 分类。YUK-437 保持原样，借鉴方向为空。 |
| 多 action 预测头含负反馈索引 `NEGATIVE_FEEDBACK_INDICES=[14,15,16,17]`（§4.4.5） | 诊断信号层：PFA 二元 + SRT 连续 outcome `state.ts:660-670`；YUK-437 typed fail；YUK-438 step-grading；ADR-0035 | **REFINES（窄）→ YUK-438/YUK-437** | 可借的是「一次 attempt 多 typed outcome 通道」，我们已做（二元、time-aware SRT、per-step、per-distractor）。唯一具体 refine：X 显式**负**头（预测厌恶事件）提示保留**专用负诊断通道**区别于「无成功」——PFA（ρ）与 YUK-437 已如此。给 YUK-438 加一行：step-grade**失败**须保持一等观测（ρ），绝不降权为「缺失」。「多头→加权价值函数」大部分属**选题域（ADR-0042 MFI）**，不复制进 mastery。 |
| X phoenix 前向路径**不消费**负头；仅 home-mixer `ranking_scorer` 消费负极性（§4.4.5/§5） | YUK-437、YUK-438；`misconception` 表 `schema.ts:118`；cause attribution YUK-462；ADR-0035/0036 | **ALREADY-BETTER** | 本域最锋利洞见。X **预测**负反馈只为**在排序里压制候选**——负信号**从不更新**学习者/内容模型。我们反着且更强：typed 负（错 distractor、失败 step）是**诊断学习信号**，驱动 p(L)（ρ）、提升 misconception 节点（YUK-437/ADR-0036）、喂 cause attribution（YUK-462）。学习工具里负信号的诊断用途是全部意义；X 结构性丢弃它。无改动，记为自觉分歧。 |
| engagement **序列**作信号——UserActionSequence 喂 transformer **学**相关性，无显式 per-item 能力态（§6，§4.4.3） | 显式 per-KC θ̂/p(L) 态：`mastery_state` 表（`schema.ts:755` 区）+ online Elo/PFA 单写者 `updateThetaForAttempt` `state.ts:482`；YUK-348/YUK-361；ADR-0035 | **VALIDATES（via §10）** | §10 反向洞见直适用：序列-作-唯一信号需海量跨用户训练流学相关性；n=1 冷启动那是死循环。我们的选择——**显式、先验种子的 per-KC 态**（LLM b-先验 + online Elo + PFA，day-one 可用）——是正确的 n=1 反转。外部印证去险/加速 YUK-348/YUK-361，且**不**追序列-transducer 学习器。仍可保留序列**作估计器输入**，但承重对象是显式态。 |
| 无 graph-Laplacian 类比——X 经学到的双塔嵌入在训练语料上平滑，非在 typed KC 图上 Laplacian 平滑（§4.4.1） | YUK-441（A5 graph-Laplacian 先验 `p(θ)∝exp(−½λθᵀLθ)`，**仅对称/`related_to` 边**；`contrasts_with` 是反向信号不进平滑）；ADR-0035，gated YUK-344，Backlog（无码） | **ALREADY-BETTER / NEW-to-X** | X 这里无可借——其「平滑」从嵌入训练涌现，n=1 不可得。YUK-441 是 n=1 正确替代：对单一能力向量的先验（无跨人估计）、「用即 firm」（λ→0 一旦直接似然到）。这是 X **无法表达**的最干净机制，正因我们缺 X 的数据前提。YUK-441 保持为承 KG 路径，别把双塔映上去。 |

### 3.4 冷启动（epic YUK-452）

| X 发现（§ref） | 现有归属（YUK + ADR + path:line） | 裁决 | 具体融合动作 |
|---|---|---|---|
| 冷启动是**独立路径**非主模型微调——专用 Phoenix 冷簇 + 单独 topic 召回 + 抬 OON + Snowflake age-decode（§6/§10「连 X 都给冷启动单独建先验路径」） | KLP-冷 vs MFI-暖 regime split `candidate-signals.ts:389-393`（YUK-435 Done，ADR-0042）；YUK-452 epic priors-first；专用探针 `placement-select.ts`（YUK-468） | **VALIDATES** | regime-split 正确的外部铁证。无码改。在 YUK-452 epic body 引 §10 作第三方佐证：冷路须是独立先验-first lane，非「等主估计器收敛」。去险 inc-B/inc-D 先 ship。 |
| X 新模型经 shadow-traffic / 5% Kafka 采样**先在线收集**再决定是否翻（§3/§4.4.6/§8）——collect-live, defer-the-flip | `feedback_defer_flip_not_build`（已锁决策）；`THETA_GRID_ENABLED` dark-ship + A1 SRT retro-validation（`audit:calibration` report-only **永不翻 flag**）+ selection_observation π_i 在线收集 | **VALIDATES** | X 在地球级数据下仍 collect-live-then-defer-flip——直接印证 `feedback_defer_flip_not_build`：机制先实现 + 接线 + 收集穿到 live，只 defer 最终翻转绑 harness 读数；collect 不通电=数据永不来=死循环。无码改，作权威外部背书（§8.3 propagate）。 |
| 抬 OON 探索为新用户做**后置乘子**——`NEW_USER_OON_WEIGHT_FACTOR` gated on account-age<阈，**只乘 in_network==false 的候选**（§5；`ranking_scorer.rs:220-239`） | KLP 后验积分本身 `candidate-signals.ts:389`；ε-greedy 下界 `selection-sampler.ts:64,147`；frontier 配额 | **REFINES（小，per-candidate）+ 部分 ALREADY-BETTER** | X 的 OON 因子是**per-candidate 乘子**（只乘 out-of-network 候选）。其忠实对应是 **per-candidate cold-KC 探索权重乘子**（只乘 `evidence_count < EARLY_KLP_N` 的冷候选），**不是全局 sampler temperature**（全局温度抬整个分布熵，粒度错）。诚实 caveat：KLP **已**对 θ-不确定性积分而探索（Fisher-over-后验，比 X 手调标量更有原理），故这是小附加旋钮非主机制。给 YUK-452/YUK-435 follow-up 加 per-candidate 冷-KC 乘子，**绝不**做成全局温度旋钮。 |
| §10 反向洞见——「消除手工特征/让模型学一切」不迁移给 n=1；先验/手工特征是 day-one 资产；连 X 保 ~18 rule filters + 3 score heuristics + 建先验-first 冷路（§7「most heuristics」，§10 #1-3） | 已锁决策 `feedback_cold_start_first`、`feedback_defer_flip_not_build`；epic YUK-452「先验 day-one 可用」；YUK-453 固定锚（Done）；seed.ts thin-prior | **VALIDATES** | 两条已锁信念最强外部背书。无改动；把 §10 作「为何不等数据」权威引用折进 YUK-452 与任何冷启动 ADR。 |
| X **对用户不 surface 任何东西**——分是黑箱，权重 OSS 都藏（§5/§7） | YUK-476（P4 surface per-KC θ̂/p(L)/mastery 带可见不确定性，Backlog/High）；`state.ts` θ̂ EAP + `effectiveB` 读路 live，零 UI | **ALREADY-BETTER** | 我们 evidence-first + 摆理由（教研团愿景）；X 故意不透明。YUK-476 方向不变——X 是**反衬案例**印证差异化，非可抄模型。surface 不确定性正是反黑箱招。 |
| Snowflake age-decode 作新用户**探测器**（`days_since_creation==0`，§6） | per-KC `evidence_count < EARLY_KLP_N` 冷-regime 探测 `candidate-signals.ts:389` | **ALREADY-BETTER** | 我们 **per-KC** 探测冷，非 per-account——n=1 下一个学习者同时有冷有暖 KC，全局 account-age 切换粒度错。无改动。 |
| KG/prereq 拓扑作冷先验——X 无（仅社交图），其「单独 topic 召回」是弱聚类类比（§6） | YUK-455 prereq mastery-risk 传播 + frontier（dark-ship）；YUK-441 graph-Laplacian；ADR-0034 | **ALREADY-BETTER / 无 X 等价** | prereq DAG + Laplacian 平滑是 X **不可能有**的 day-one 先验资产（§10 #2）。别指望 X refine YUK-455/YUK-441——无可借。保持原样。 |
| 加权和的 score 归一化 offset（`NEGATIVE_SCORES_OFFSET`，§5：当负反馈项使 `combined<0` 时重基到正区间以保可比） | tempered-softmax over 非负权重（`selection-constants.ts:36,47`，`DEFAULT_TEMPERATURE=0.25`；`softmax-selection.ts`） | **N/A（无框架对应）** | X 的 offset 是**输出-score 归一化**（修复 combined<0 区间），与 YUK-453 的**难度尺度原点**（logit b-offset）是不同轴的不同量，**不应**互映。我们 tempered-softmax 跑在非负权重上，根本不产生 combined<0 区间，故无 offset-修复需求。**前稿把它映成 YUK-453 ALREADY-BETTER 是范畴错误，撤回。** |
| X 是 population recsys，**无单一可信用户**为难度尺度定 day-one 原点 | YUK-453 固定锚 owner b-offset（Done，ADR-0043）——`item_calibration.source='fixed_anchor'`，bucket→logit | **ALREADY-BETTER** | owner 固定锚给难度尺度 day-one 共同原点/单位——X 结构性缺（无单一可信用户）。印证 priors-first，无可引入。（这是与上一行 `NEGATIVE_SCORES_OFFSET` 正交的独立点，不是它的对应物。） |
| 飞轮 YUK-188/186 vs frontier-空-day-one YUK-474 | `discoverSupplyTargets` frontier=活 `learning_item` 引用的 KC；day-one 无 learning_item→frontier 空→零供给 | **VALIDATES YUK-474 降级 / YUK-188-186 framing 待对齐** | X 冷路不等飞轮——从**独立先验路径**（冷簇+topic 召回+抬 OON）+ 生成/探索内容服务新用户，绝不从主引擎累积态（§6/§10）。裁决：YUK-474 把动态供给降为 **refill-only** 被 X **印证**（body 已确认 refill 降级 + learning_item 依赖）。在 YUK-474 引 §6/§10 确认 refill 是正确角色；若 YUK-188/186 仍承载「飞轮转」framing，在 YUK-452 标其 day-one superseded（先核 body 再落注）。 |

### 3.5 KG/边 + 两轴 + 内容理解（ADR-0034 / ADR-0035 / ADR-0038）

> 实测：选题**不** traverse `knowledge_edge`（`candidate-signals.ts`/`target-discovery.ts`/`practice/server/*.ts` grep `knowledge_edge` 零命中）；嵌入（`embed_backfill.ts`）喂内容理解**非召回**（唯一消费者 `tag-knowledge.ts`、`kc_dedup_nightly.ts`）；`applied_in` 是唯一确认死边（`audit-relations.ts:228-231` 故意无 specialized 条目）；`contrasts_with` **已有**特化消费者——`knowledge-readers` paths 反向邻接（`audit-relations.ts` NOTE ~227-233），故**非**死边、**不**走 Laplacian。

| X 发现（§ref） | 现有归属（YUK + ADR + path:line） | 裁决 | 具体融合动作 |
|---|---|---|---|
| grox = 独立异步内容理解层；VLM 分类器 + 多模态嵌入器写回 Strato 供下游（§4.5/§1） | YUK-482 录入=富信号源（ADR-0034，**Done**）；`ingestion/server/{structure.ts,vision.ts,tagging.ts,cold-start-bridge.ts}`；`practice/jobs/{embed_backfill.ts,item_prior_backfill.ts}` | **VALIDATES** | 外部印证「内容理解作独立异步可缓存层、写信号回存储供下游」是成熟生产模式，确认 YUK-482 已 ship 的 framing 正确（录入不是「填题库」，是 X-grox 级信号抽取）。给 YUK-482 加一行引 X-grox §4.5 作 prior art（VALIDATES 注，非对已闭 issue 的 refine）。 |
| grox banger `quality_score>=0.4` → 质量/主题分类（§4.5） | `ItemPriorTask` 难度先验——`src/server/ai/item-prior.ts`、`item_prior_backfill.ts`、`src/core/schema/item_prior.ts`（写 item_calibration b，YUK-348/361，ADR-0035） | **ALREADY-BETTER** | 我们的类比对我们的目的更强：grox banger 是 population 质量分（需 engagement 流）；我们是 LLM 引出的 per-item 难度**先验**，n=1-safe（b LOCKED，绝不从 cohort 反拟合——YUK-453 红线）。grox topic-classifier 映射 `tagging.ts` KC-tagging，已 live。无动作。 |
| grox 多模态嵌入器 V2/V5（truncate-1024 + L2 renorm）（§4.5） | `embed_backfill.ts`（EMBED_VERSION-stamped 幂等，`embedding IS NULL OR embed_version<V`）→ `match-similarity` → `tag-knowledge`/`kc_dedup_nightly` | **ALREADY-BETTER / REFINES** | 已有幂等版本化 embed-backfill（比 grox stub-多的版本更好工程化）。**Refine**：仅当嵌入成本/存储成问题时借 grox 的 **Matryoshka 截断纪律**（V5 截 1024 + L2-renorm）——记为 embed job 上的薄可选注，非新 issue。关键：嵌入保持**内容理解/匹配**信号（tagging+dedup），**非召回引擎**（见下行）。 |
| grox VLM grading/PTOS 分类器跑 VLM 作 instrument（§4.5；temp≈0） | YUK-485 整页 vision grading（`Answer.input_kind=image`/`Judgment.judge_kind=multimodal_direct`）；YUK-482 ③ 手写抽取（`tencent_mark_parser.ts:298`→`wrong_answer_md`） | **VALIDATES** | X 独立印证「VLM-作-instrument、整数/低温、整内容非裁切」——匹配我们已验证的「整页 vision > 本地切割」。给 YUK-485 加外部佐证：grading-VLM 属**内容理解层**（异步可缓存 annotation 写回），与选题解耦。**手写信号现状更正**：手写**已被下游消费**（`auto-enroll.ts:1096-1097` `detectStudentWork` 读 `node.extraction_evidence.handwriting`），前稿「抽了又丢」是 YUK-482（已闭）的旧问题陈述，撤回。是否专门接进 **cause-attribution 链**是单独问题——见 §7 决策 f / §8.4 的 candidate-NEW（需 code 核；若确未接，因 YUK-482 已 Done 须作 NEW follow-up，非 refine）。 |
| 推荐**不** traverse 图——图经双塔嵌入（§2.3/§4.4.1） | YUK-441 A5 graph-Laplacian 先验；选题 grep 确认零 `knowledge_edge` 命中 | **VALIDATES（图入先验，非入召回的决策）** | X 印证：召回**不需** traverse typed 图，学到的相似面足矣。**因此 YUK-441 是图对 n=1 唯一应承重处**——作对 per-KC θ 向量的 Laplacian 平滑**先验**（诊断轴，**仅 `related_to`/对称边**），非召回 traversal。给 YUK-441 加：引 X §2.3「图-作-先验，非图-作-召回」是自觉、外部印证的分离。 |
| X 双塔是在海量 engagement 流上**学到**的嵌入召回（§4.4.1/§10） | YUK-441 Laplacian（`related_to`）vs embedding 召回，for n=1 | **CONFLICTS / REJECT（embedding 召回）— ALREADY-BETTER（Laplacian）** | §10：双塔学到的召回需我们没有的训练流（冷启动死循环）。让图承重，**Laplacian-作-先验严格优于** embedding 召回：对单向量的先验（零跨人估计）、day-one 可用、`λ→0` 优雅退化到独立。**不要**提 embedding-召回推荐塔。X 外部印证拒此备选。 |
| 死边 `applied_in`（§3b 曾建议给它消费者） | YUK-357 audit:relations 死边检测（ADR-0034 治理）；`audit-relations.ts:228-231`；YUK-455 prereq 传播（`prerequisite` 的 specialized 消费者）；`knowledge-readers` paths 反向邻接（`related_to`/`contrasts_with` 的 specialized 消费者） | **REJECT（别硬塞消费者）— VALIDATES 审计前提** | X §10：不驱动下游决策的结构**留 inert 没问题**——X 保 ~18 filters 但不假装每信号都承重。所以**不要**为清审计造人工 `applied_in` 消费者。合法的边→消费者接线是 `prerequisite→诊断回传`（YUK-455 inc-E）、`related_to→Laplacian`（YUK-441）、`contrasts_with→knowledge-readers paths 反向邻接`（已 live）。`applied_in` 是今天唯一无真消费者的边。给 YUK-357 加注：「X §10 确认死边-作-inert 可接受；仅当真消费者出现才升 specialized，绝不为满足审计」。 |
| 重 brand-safety/可见性/PTOS 过滤（§4.1 广告、§4.5 PTOS、§5 OON） | 无 home（单人）；最近结构类比：YUK-350 Verifier Router 质量门（ADR-0038） | **REJECT（brand-safety/PTOS）— REFINES（仅质量门类比）** | brand-safety/可见性过滤/OON 压制对 n=1 **不相关**：owner 信自己上传、无对抗内容、无广告库存。**不要**移植。唯一可借内核：grox banger `quality_score>=0.4` 是**内容进可消费池前的门**——结构上是我们的 verify-then-promote（YUK-350）+ auto-enroll 源层毕业。给 YUK-350 加：X-grox 印证数值质量阈作 promotion 门（单一 owner-set 数字，非隐藏权重），区别于我们丢弃的安全过滤。 |
| 召回-seq ⊥ 打分-seq 两独立信号通道——召回正向-only `Dense`，排序 `DenseWithNotInterestedIn` 含负（§6） | YUK-482 两轴：content/propose 轴 ⊥ error/mastery-performance 轴（`feedback_propose_is_content_axis`） | **VALIDATES** | X 独立跑两正交信号通道做两活（召回 vs 打分），负信号仅在打分通道。外部印证我们**两轴正交**：content/propose 信号（题面/KC-tagging）绝不与 performance/error 信号（对错/misconception）混。给 YUK-482 引 §6 确认混通道（如我们已拒的「答错→propose」概念错位 cron）是工业反模式。无码改，作防回归护栏。 |
| 内容理解 annotation per-item 可缓存（§4.4.4/§3 Redis 缓存） | YUK-482/`embed_backfill.ts` 幂等 per-item 写；`item_prior_backfill.ts` per-item b；ADR-0035 mastery_state per-KC | **VALIDATES（工程纪律）** | per-candidate-可缓存不变量干净适用内容层：每 item 抽取信号（嵌入/难度先验/tags/grading verdict）是该 item 内容的纯函数、版本 bump 时可缓存可重盖（已 `embed_version`/`embed_content_hash`）。无动作，印证幂等-backfill 设计形态对。 |
| eligibility-gated 并行 plans（8/9 返 None）+ 无分时保守默认 `MediumRisk`（§4.5） | YUK-344 写时结构一致门（ADR-0034）；`rubric-validator.ts` relationGate + topology gate（环硬拒） | **VALIDATES（弱）** | X「信号缺时保守默认 + per-plan eligibility 门」同我们写时门纪律（硬拒环、warn 传递冗余）。次要：印证 YUK-344 硬拒-vs-warn split 业界对齐。无动作。 |
| 非对称 typed token；`actions_signed=2·a−1` → 显式 −1 表「未做」非 null（§4.4.3） | YUK-367 attempt-payload discriminated 子 schema（objective 结构化，open 自由文本；ADR-0035/0043） | **VALIDATES** | 两印证：(a) X 用 discriminated 非对称 token schema（候选 token 无 action 嵌入）——印证我们 per-kind discriminated union；(b)「显式 −1 非 null」——核心已由 PFA signed γ/ρ 全数 discharge（见 §3.3）。唯一残留微点（verifier 确定的 objective payload 对「展示但未做」项优先显式值而非 null）薄到不值单拆 issue，作 VALIDATES 脚注，非 REFINE（见 §7 决策列表已移除原 (c)）。 |

### 3.6 域模型容器 + Rust 核 + 跨切元层（YUK-203 / YUK-493 / YUK-405-406 / YUK-496 / ADR-0042 / ADR-0044）

| X 发现（§ref） | 现有归属（YUK + ADR + path:line） | 裁决 | 具体融合动作 |
|---|---|---|---|
| 可组合 `Source→Hydrator→Filter→Scorer→Selector→SideEffect` trait 框架，各阶段独立并行/串行（§4.2） | YUK-203（umbrella）+ ADR-0042 选题 seam；`softmax-selection.ts:198-407`（每阶段都在）；`candidate-signals.ts`（Source/Hydrator）；`selection-observations.ts`（SideEffect） | **VALIDATES** | 印证（ADR-0042 编排档2）把选题建为显式分阶段编排 + 确定性纯核 + SideEffect telemetry。外部证据该形态是正确工业模式——去险保留现有手写编排而非塌回单函数。**无码改。** |
| 把六阶段形式化为通用可复用 trait（任意 pipeline 组合）（§4.2） | 同上 | **CONFLICTS / REJECT**（n=1 过度工程） | X 需通用 trait 因它跨服务网格组合**多条** pipeline（ForYou/ScoredPosts/ads/WTF）。我们只**一条**日流。泛化成 trait 框架加间接、零第二消费者。§10 纪律=借**结构**非规模机器。保留具体 `composeSoftmaxStream`。 |
| 候选隔离不变量：每候选分=纯 fn of {user,history,self}，batch-order-无关 ⇒ 可缓存可单测（§4.4.4；§10 行1） | YUK-203 + ADR-0035（三轴）；`candidate-signals.ts` per-refId 打分（mfi/klp/diag from `(thetaHat,b,thetaPrecision)`）；`softmax-selection.ts:13-18` 四铁律；运行时断言 `assertL3Invariants:540` | **VALIDATES + 标 GAP（非 ALREADY-BETTER）** | **纠正前稿错断言**。candidate-signals 基值打分**确实** per-candidate 纯（属性属于该模块），但**当前无任何 batch-invariance 运行时断言/测试**——`assertL3Invariants`（`softmax-selection.ts:540`）断的是**另一族**不变量（due-presence + intra-day order + recall-lock + capacity/dedup，即 `:13-18` 四铁律），**从不**断 per-candidate 打分纯性或 batch-order 无关性。X §4.4.4 的 batch-invariance 性质在我们代码库**今天没有对应测试**（X 自己 `test_recsys_model.py:79-92` 也只测 mask 结构、从不断言跨候选 logit 相等）。故这**不是**「我们已做更强」，而是**待补缺口**：把不变量按名写进 ADR-0042（scoped 到基值层，见 §3.1 r1）+ 补 batch-invariance 差分测试（复用 YUK-493 §spike 的 `Object.is` 范式）才是真正的活。 |
| Rust 用于 serving/编排/store（home-mixer/thunder），JAX **仅**用于学到的模型（phoenix）；Rust 无 autodiff/训练（§1/§4.4/§4.4.6） | YUK-493；`docs/design/2026-06-24-rust-napi-calibration-beachhead.md`；背景「绝不蹭 AI/LLM」 | **VALIDATES** | X 独立印证 YUK-493 beachhead 边界：Rust 做**确定性定形数值计算**，绝不做学到/训练的模型。X 把承梯度部分放 JAX 正因它需训练；n=1 无训练流，整个数值核是定形→**理想** Rust 目标。加速/去险 YUK-493 红线「不含 item 参数标定 / b 处处只读」。**无改动；在 design doc 背景引 X 作外部验证。** |
| 双塔 split + **brute-force 精确点积 top-K，无 ANN**（§4.4.1/§10 行2） | YUK-493 Phase 0+（coldstart-core）；候选规模远低于 X 537K | **VALIDATES（负向建议）** | X 自己 demo 用 brute-force 非 ANN，印证 YUK-493 **不应**引 ANN/index 依赖（ANN 库会破 napi/WASM bit-exact）。去险 YUK-493 子决策——无需 ANN crate。 |
| 候选隔离使分**可缓存**（§4.4.4/§8） | YUK-493 #41 recompute badge（Phase 0+，WASM 客户端） | **REFINES → YUK-493** | 基值打分层 per-candidate 纯（candidate-signals）是 #41 badge 能作 WASM-local 纯重算的理由：per-candidate θ̂/p(L) 打分是纯函数 → 可**客户端、即时、离线**跑，结果与服务端 napi 同（bit-exact 同构核）。给 YUK-493 Phase 0+ 注加：「candidate-isolation 纯性（X §4.4.4）正是 recompute badge 能作 WASM-local 纯重算的原因——无服务端往返；但注意纯性目前**仅打分路成立、θ̂ 更新路因 θ_global 漂移不成立（YUK-466）」。 |
| home-mixer = 多服务多语言 gRPC+mTLS+Kafka+Redis 网格（§8） | 跨切：capability-manifest + Hono + pg-boss（三进程，单代码库） | **ALREADY-BETTER（对我们约束）** | X 多服务网格是行星级 fan-out 所迫。我们 capability-manifest 贡献模型（`server/app.ts` + `register-capability-jobs.ts`）单代码库给同样可组合性、无网格税。借 trait/贡献纪律（已有），拒部署拓扑。 |
| 内容理解**异步预计算**离 serving 路、写回 store、serve 时廉价读（grox §4.5；thunder Kafka §4.3；side effects fire-and-forget §3/§4.1） | YUK-405/406（教研团 rethink，例会/sleep-time job；`project_private_teaching_team_vision`）；已 live crons `dreaming_nightly`/`coach_daily`/`coach_weekly`（`agency/manifest.ts:34-49`） | **VALIDATES** | X「预计算异步→从 store serve」直接印证例会-job-预计算→备课台-serve 形态。且我们**已 ship Phase 0**（夜间 agency/knowledge crons 预计算，serve 路读）。外部确认「异步为你而备」是对的工业分离。加速 YUK-405/406——Phase 0 管道已在。**无改动；引为「例会应保持 async/off-path」验证。** |
| grox 是 **DAG task-plan executor**：9 并行 plans、per-plan eligibility 门（8/9 短路 None）、依赖 SKIP 级联、缓存 annotation 带 TTL（§4.5） | YUK-406（Phase 0 关系脑 / conjecture engine 预计算结构） | **REFINES → YUK-406** | 现夜间 jobs 是独立单体 cron。X grox 示下一步结构：把例会建为**预计算 plan 的 DAG，带 eligibility 门 + 缓存/TTL 输出**，让 conjecture engine + 关系脑作 gated 并行 plans（多数短路）而非一大 job。给 YUK-406 加：「把例会结构化为 grox-style plan-DAG——见 X §4.5」。**本域最高价值 REFINE。** |
| grox 分类器写回 typed metadata（banger 分/安全 verdict/嵌入）到 store，与排序解耦（§4.5/§10） | YUK-482（录入=富信号源）+ ingestion→判分 pipeline（YUK-484/485） | **VALIDATES（§10 已映射）** | 我们 ingestion→grading 层（GLM-OCR + Opus 整页 vision）正是 grox 角色：独立异步缓存内容理解写回 KG/DB。印证保持独立层喂预计算、非内联进选题。无新动作（属 ingestion 域）。 |
| thunder serving **仅按 recency 排、零 ML**——所有 ML 在下游（§4.3） | 跨切：due-list/FSRS 调度确定性，AI 选题在下游（`softmax-selection` L1 确定性核 vs L2 LLM） | **VALIDATES** | 镜像我们的 split：底层确定性调度/due-投影（`composeDailyStream` 纯核、FSRS），AI/LLM 打分叠上带兜底。印证「确定性地板 + AI 天花板」分层。无改动。 |
| engagement 发到 **Kafka 作训练样本**（5% 采样，`RerankingKafkaSideEffect`）喂持续重训——数据飞轮（§3/§4.4.6/§8） | YUK-496 + ADR-0044/ADR-0006（event=SoT）；selection_observation π_i SideEffect（`selection-observations.ts`） | **CONFLICTS / REJECT（训练-流目的）** | §10 反向洞见逐字适用：X event 为**训练模型**；我们**无训练流**（n=1）。采「发 event 喂重训」=冷启动死循环。我们 event 流目的根本不同且正确：`fold(events)→projection` + cascade-revert + θ̂/FSRS 快照（ADR-0044 §1/§3），**确定性**重建非学到。**不要**把 event log 重框为训练 feed。 |
| event log 作下游 replay/derive 的持久 substrate（§3/§8 Kafka 多簇） | YUK-496（item_calibration 投影 tail）+ ADR-0044 §1 fold reducer | **VALIDATES（event-作-substrate 决策）** | **结构**思想——event 是持久源、投影是派生/可缓存——共享且被印证。印证 ADR-0006/0044「event=SoT，projection=cache」。给 YUK-496：item_calibration 应像其它 ADR-0044 投影表从 attempt/fixed-anchor event **fold**（`src/core/projections/<table>.ts` reducer + IO 壳），**非**训练或命令式漂移。加注：「item_calibration 投影=确定性 fold(attempt+anchor events)，镜像 X event-作-substrate（§3）但拒 X train-from-events 目的（§10）——b 只读、无参数拟合」。 |
| 选题 **SideEffect 发 telemetry**（π_i/served history/impression）供后用，fire-and-forget 离响应路（§3/§4.1） | `recordSelectionObservation` π_i（`selection-observations.ts:1-8`「active-PPI 重标定必需的慢热资产」） | **VALIDATES** | 我们 π_i SideEffect 与 X RerankingKafka 副作用结构相同（记选题 telemetry 离路供后重标定）。**差异（显式注）**：我们喂**确定性** active-PPI/IPW 估计器（YUK-439），X 喂**梯度训练**。同管道、反下游——正是 §10「借架构、拒数据前提」。印证 π_i telemetry 设计（YUK-361/439）对。无改动。 |

---

## 4. 重点 REFINES（按 issue 落地）

每条 REFINE = 哪个既有 issue 拿什么具体增补 + 一行实现注。（注：原稿列在此的 YUK-439 / YUK-482 / YUK-485 / YUK-367 经对抗评审重判为 VALIDATES，已移出本节，见 §3 对应行。）

- **ADR-0042 选题（候选隔离不变量命名 + 补缺失测试）**：(i) 加 candidate-isolation 不变量，**scoped 到基值层**——「candidate-signals 基值打分层（MFI/KLP/diag）MUST per-candidate 纯 + batch-order-无关（可缓存）；跨候选耦合只允许在三个命名下游层：① 确定性后置乘子层（多样性/疲劳/OON，YUK-370）、② IPPS-sampler、③ LLM-编排层；θ̂-更新路（θ_global 漂移，YUK-466）显式排除」。(ii) **诚实记录**：我们今天有 per-candidate 纯打分函数，但**无** batch-invariance 测试（`assertL3Invariants` 断的是 due/recall/capacity 另一族）——补该测试是真正的活，非「已做更强」。实现注：测试范式复用 YUK-493 §spike 的 `Object.is` 差分，scoped 到基值层；镜像 X PhoenixScorer⊥RankingScorer 分层。

- **YUK-370 多样性/疲劳（确定性几何衰减乘子）**：加 (i) 确定性 same-family/kind/review_format **几何衰减乘子** `multiplier(pos)=(1−floor)·decay^pos+floor`，作 sampler 前对候选权重的后置乘子（按 `root_question_id` 家族 + `review_format` keyed）——**明确归入「确定性后置乘子层」（跨候选，不在基值纯层）**，落实 ADR-0042 §6⑥⑦ 至今未实现的多样性/疲劳；(ii) 可选 owner-定死的舒适区**负乘子**（别用一串过难题打击，确定化非 LLM-discretion）。实现注：现 `roundRobinBySubject`（`due-list.ts:136`）是离散版、且不在 softmax 路径——升级为连续乘子并搬进 softmax 流（后置乘子层）。

- **YUK-446 DAD 非短视**：加两注——(i) DAD 是 LLM 编排当前 ad-hoc 非短视 `arrangement` 的**有原理替代**；(ii) DAD **破** per-candidate-可缓存不变量，仅因 n=1 无缓存/延迟压力才可接受，须自觉承担可缓存代价。实现注：与 ADR-0042 candidate-isolation 不变量对账标注张力。

- **YUK-438（+ YUK-437 重申）typed 负诊断通道**：加一行——typed 负 outcome（失败 step / 所选 distractor）须保持一等 **ρ-加权诊断观测**，绝不降权为「缺失」；显式是 X 的**反面**（X 预测负只为排序压制、从不喂学习器，§4.4.5/§5）。实现注：文档/范围守，非新码。

- **YUK-441 graph-Laplacian（图入先验非召回，仅 `related_to`）**：加引 X §2.3——「图-作-先验，非图-作-召回」是自觉、外部印证的分离；n=1 下 Laplacian-作-先验严格优于 embedding 召回。实现注：保持 YUK-441 为图（**仅 `related_to`/对称边**）唯一承重处（诊断轴），`λ→0` 优雅退化；`contrasts_with` 不入平滑（它已有 paths 反向邻接消费者）。

- **YUK-350 Verifier Router 质量门**：加 X-grox banger `quality_score>=0.4` 印证——数值质量阈作内容进池前 promotion 门（单一 owner-set 数字，非隐藏权重），区别于丢弃的 brand-safety/PTOS 过滤。

- **YUK-406 关系脑/例会（grox-style plan-DAG）**：把例会结构化为 eligibility-gated 并行预计算 plan 的 DAG + 缓存/TTL 输出（引 X §4.5），让 conjecture engine + 关系脑作 gated 并行 plans 而非单体 cron。实现注：Phase 0 管道（`dreaming_nightly`/`coach_*`）已在。**本轮最高价值 REFINE。**

- **YUK-496 item_calibration 投影**：投影 = 确定性 `fold(attempt + fixed_anchor events)` per ADR-0044 §1（reducer + IO 壳），镜像 X event-作-substrate（§3）但拒 train-from-events（§10）；b 只读、无参数拟合。

- **YUK-493 Rust 同构核**：加 (i) 基值打分层 per-candidate 纯性（X §4.4.4）是 #41 recompute badge 能 WASM-local 纯重算的理由（注：仅打分路纯，θ̂ 更新路因 θ_global 不纯，YUK-466）；(ii) X Rust-serving/JAX-model split（§4.4）外部印证「Rust=确定性计算、绝不学到模型」红线；(iii) X brute-force-非-ANN demo（§10）印证无 ANN 依赖；(iv) **补缺失的** batch-invariance 差分断言（X 仅测 mask，我们今天也没有——这是缺口非强项）。

- **YUK-435/YUK-452 冷启探索（per-candidate cold-KC 乘子）**：加**只乘冷候选**（`evidence_count < EARLY_KLP_N`）的 per-candidate 探索权重乘子，镜像 X `NEW_USER_OON_WEIGHT_FACTOR`（X 也只乘 in_network==false 候选）。实现注：**绝不**做成全局 sampler temperature（粒度错，抬整分布熵）；KLP 已对 θ-不确定性积分而探索，故此为小附加旋钮非主机制；保持 Fisher-over-后验比手调标量更有原理。

---

## 5. 我们已更强的地方（ALREADY-BETTER，n=1）—— 别改方向

这一节告诉 owner **哪里不要因 X 而转向**。X 作为地球上数据最丰的 recsys，恰恰**结构性缺失**以下学习-domain 机制——它们正是我们 n=1 的差异化资产：

- **item 难度 / SE / 后验方差（live Elo-Fisher SE：YUK-361 / YUK-461；grid-Bayes 升级 YUK-436 暗推；σ² YUK-439）**：X 无 item-difficulty、无 SE、无 posterior-variance（纯 engagement transformer，靠 population scale 隐式吸收难度）。n=1 无 population，故 Fisher SE（`thetaSe(theta_precision)` `state.ts:313`，live）、ECE/forward-AUC/κ harness、active-PPI σ² 不是 polish 而是「何时信任薄先验」的全部装置。X §4.4 没有可比对象。
- **掌握→停止花预算（MEPV YUK-443）**：X 是无限 feed，唯一「停」是 TopK/result_size 截断（=我们的容量上限 `capacityGuard`/`DEFAULT_MAX=30`）。「KC mastered→停止花预算、转投不确定 KC」是 X 结构性缺的学习机制。
- **typed-failure 错因/错步粒度（YUK-437 / YUK-438）**：X 每动作一 ±1 bit；我们 per-distractor→misconception（`mistake_variant.cause_category` `schema.ts:1153`）、per-step→KC。严格更细，借鉴方向为空。
- **负信号当诊断学习信号（ADR-0036 / YUK-437 / YUK-462）**：X 预测负反馈**只为排序压制**，从不更新学习者/内容模型；我们让 typed 负驱动 p(L)（ρ）、提升 misconception 节点、喂 cause attribution。学习工具里这是全部意义。
- **显式入代码可 diff 的权重（ADR-0042）**：`PFA_GAMMA=0.4`/`PFA_RHO=-0.2`/`ELO_K_GLOBAL=0.048`/`DIFFICULTY_PROXY_WEIGHT=0.3`/`RECALIBRATION_MIN_LABELS=12`，「NO config table, NO env」（`theta.ts:161`）——X 把每个调系统的数字都藏起来（§5/§7），不可审计。
- **online per-attempt 更新（`updateThetaForAttempt` `state.ts:482`）**：X 冻结 checkpoint（§4.4.6）需离线 firehose 重训；对 n=1 是死循环。每答即当日 firm。
- **graph-Laplacian 先验（YUK-441）**：X 的「平滑」从嵌入训练涌现，n=1 不可得；Laplacian 对单向量先验是 X 无法表达的机制。
- **per-KC 冷检测（`candidate-signals.ts:389`）**：X 用 per-account Snowflake age-decode；我们 per-KC——n=1 下一个学习者同时有冷暖 KC，account-age 粒度错。
- **evidence-first 摆理由 surfacing（YUK-476）**：X 是黑箱（§5/§7），权重 OSS 都藏；我们 surface θ̂/p(L)/mastery 带可见不确定性。X 是反衬，不是模型。
- **owner 固定锚 b-offset（YUK-453）**：给难度尺度 day-one 共同原点；X 是 population recsys 无单一可信用户故结构性缺。
- **运行时断言的教学不变量（`assertL3Invariants` `softmax-selection.ts:540`：due-presence + intra-day order + recall-lock + capacity/dedup）**：X 无此教学域守卫。**注意**：这族不变量**不是** candidate-isolation——后者在我们代码库**尚无** batch-invariance 测试，是缺口非强项（见 §3.6 / 决策 a），勿混为已更强。
- **单代码库 capability-manifest（无服务网格）**：X 被行星级 fan-out 逼成 gRPC+mTLS+Kafka+Redis 多服务网格；我们贡献制单库给同样可组合性、零网格税。

---

## 6. 拒绝迁移（CONFLICTS）

X 的核心赌注是「海量用户 × 海量 engagement 流持续训练一个大 transformer 取代手工特征」。我们是 n=1、冷启动、day-one 必须靠先验可用。可迁移的是**结构纪律**，不是**数据前提哲学**。逐条拒，皆系到已锁决策：

- **「消除手工特征 / 让大模型 learn 一切」（§1 赌注1、§7、§10 #1-3）**：n=1 无 batch、无持续训练、无 5% 采样。「让 transformer 做重活」=冷启动死循环（无数据→无模型→无推荐→无数据）。连 X 都退到「most heuristics」+ 单独冷启动先验路径（§7/§10）。系到 `feedback_cold_start_first` + `feedback_defer_flip_not_build` + YUK-452。**这是 §10 反向洞见的核心，也是单条最大收获的反面。**
- **隐藏系数（§5/§7）**：权重不在仓库、不可审计。恰恰反着做——我们权重入代码、可 review、可 diff（ADR-0042 explicit-weights）。
- **embedding-recall 双塔作召回（§4.4.1）**：需我们没有的训练流。让图承重应走 Laplacian-作-先验（YUK-441，仅 `related_to`），非学到的双塔召回。
- **Kafka-events-作-训练-feed（§3/§8）**：我们 event 流是 `fold→projection` 的确定性 substrate（ADR-0044/ADR-0006），不是训练样本源。不要把 event log 重框为训练 feed（YUK-496）。
- **强制全链候选隔离（含 LLM 编排）（§4.4.4）**：X 为可缓存/规模处处强制隔离；我们故意把隔离 scoped 到基值层、在三个下游层（后置乘子 / sampler / LLM 编排）确定地或自觉地耦合（ADR-0042 amendment「让 LLM 强」）换 batch-aware 教学法——n=1 不付 X 的规模/缓存代价。
- **泛化六阶段为通用 trait 框架（§4.2）**：X 需通用 trait 因组合多 pipeline；我们只一条日流，泛化=零第二消费者的间接。保留具体 `composeSoftmaxStream`。
- **brand-safety / PTOS / OON 压制（§4.1/§4.5/§5）**：单人无受众可保护、无广告库存、无对抗上传。全丢，只留 grox 数值质量阈作 promotion 门（→ YUK-350）。
- **冻结-checkpoint 推理（§4.4.6）**：对 X 对（离线重训），对 n=1 是死循环；用 online per-attempt 更新。

---

## 7. 决策清单（owner 拍板）

> 这些是融合**浮现**出的、需 owner 拍板的决策。每条 = 问题 + 选项 + 我的建议（及理由）+ 触及 issue。（原稿决策 (c) signed-−1 经评审降为 VALIDATES 脚注，已并入 §3.3/§3.5，不再单列；其余决策重编号 a-f。）

1. **(a) 把候选隔离收为 ADR-0042 显式不变量 + 补缺失的 batch-invariance 测试？**
   - 选项：① 按名写进 ADR-0042（**scoped 到基值打分层 candidate-signals**）+ 记录三个故意耦合的下游层（后置乘子 / IPPS-sampler / LLM-编排）+ 显式排除 θ̂-更新路（θ_global 漂移，YUK-466）+ **补 batch-invariance 差分测试**；② 不动，留隐性约定。
   - **建议：①。** X §4.4.4 独立印证此决策，且这是 YUK-493 同构核 bit-identical replay 需要的不变量。**关键诚实更正**：我们今天**有** per-candidate 纯打分函数，但**没有** batch-invariance 测试——`assertL3Invariants` 断的是 due/recall/capacity 另一族（**不是**「已做更强」）。命名 + 补测试（复用 YUK-493 §spike 的 `Object.is` 范式，scoped 到基值层）才是真正的活。范围必须精确到基值层：YUK-370 的几何衰减乘子是**跨候选**的，属后置乘子层，**不在**纯基值层内（否则与本不变量自相矛盾，镜像 X PhoenixScorer⊥RankingScorer）。
   - 触及：**ADR-0042、YUK-493（+ YUK-466 引用、YUK-370）**。

2. **(b) 翻 YUK-436 grid-Bayes 暗路？（X-independent conviction call）**
   - 选项：① 翻 `THETA_GRID_ENABLED`（现 `false`，`theta-grid.ts:54`）/ ship grid-Bayes 升级（更丰富后验）；② 保持 live Elo-Fisher SE（已在）+ grid 暗推，YUK-436 慢推。
   - **建议：①，但明确标 X-independent。** **更正**：live SE/后验带**已经**由 Elo-Fisher 路（YUK-361 + YUK-461 harness，`thetaSe(theta_precision)`）shipped；YUK-436 是其上的 grid-Bayes **升级**（暗，gated）。X **结构性无** SE，故**不能**「印证 SE 方向」——这是纯内部 conviction call（SE 是我们 n=1 的 ALREADY-BETTER 差异化），列在此**仅因融合勘察顺带暴露了 dark-vs-live 状态，非 X 驱动**。决策语义是「翻暗路」，**不是**「SE 当前缺席」。
   - 触及：**YUK-436、YUK-461、YUK-361**。

3. **(c) 冷启探索：加 per-candidate cold-KC 探索乘子？**
   - 选项：① 加 **per-candidate** 冷-KC 探索权重乘子（只乘 `evidence_count < EARLY_KLP_N` 的冷候选）；② 不动，靠现 KLP 后验积分 + ε-greedy + frontier 配额。
   - **建议：① 但低优先级。** **更正粒度**：X `NEW_USER_OON_WEIGHT_FACTOR` 是 **per-candidate** 乘子（只乘 in_network==false 候选），忠实对应是 per-candidate 冷-KC 乘子，**不是全局 sampler temperature**（全局温度抬整分布熵、粒度错）。我们已 ALREADY-BETTER（KLP 是 Fisher-over-后验的有原理探索，优于 X 手调 OON 标量），故乘子只是小附加旋钮。值得做但不紧急。
   - 触及：**YUK-435、YUK-452**。

4. **(d) 给 `applied_in` 一个消费者，还是正式退役（YUK-357）？**（代理分歧，已调和）
   - 调和：前一版（selection §3b）曾建议给 `applied_in` 一个 prereq-召回消费者来清审计；KG 代理**明确 REJECT** 为清审计造人工消费者（X §10：死边-作-inert 可接受）。采 KG 裁决。
   - 选项：① 留 `applied_in` 死/inert，YUK-357 按设计 report-only 工作，仅当真诊断/复习/推荐消费者出现才升 specialized；② 正式从核心 `relation_type` 退役 `applied_in`；③ 硬塞消费者清审计（**不建议**）。
   - **建议：①。** 合法边→消费者接线是 `prerequisite→YUK-455`、`related_to→YUK-441 Laplacian`、`contrasts_with→knowledge-readers paths 反向邻接（已 live）`；`applied_in` 是今天**唯一**无真消费者的边。给 YUK-357 加注「X §10 确认死边-作-inert 可接受」。owner 可另决是否升 `audit:relations` 为 CI gate（现 report-only）。
   - 触及：**YUK-357**（+ 关联 YUK-455/YUK-441）。

5. **(e) 形式化选题流水线阶段？**
   - 选项：① 在 ADR-0042 文档化阶段契约（Source→Hydrator→Filter→Scorer→Selector→SideEffect，轻量）；② 建通用可复用 trait 框架（X §4.2）；③ 不动。
   - **建议：①，明确拒 ②。** X 印证分阶段形态（VALIDATES），但泛化成 trait 框架对只有一条日流的 n=1 是过度工程（CONFLICTS）——零第二消费者。文档化契约（含 candidate-isolation 不变量，见 (a)），保留具体 `composeSoftmaxStream`。
   - 触及：**ADR-0042、YUK-203**。

6. **(f) 有没有 genuinely-NEW 值得独立 follow-up？**
   - **建议：实质上没有——但有一条候选需核实。** 几乎每条可借发现都归到既有 issue（VALIDATES/REFINES/ALREADY-BETTER/N/A/CONFLICTS）。**唯一候选**：手写信号→**cause-attribution** 的专门接线。手写**已被下游消费**（`auto-enroll.ts:1096-1097` `detectStudentWork`），但 YUK-482 **已 Done**——若 cause-attribution-specific 接线确实未通（须 code 核），它**不能**作为对已闭 issue 的 refine，须作**单条 NEW follow-up**（小接线，挂 YUK-203/YUK-462，**非新引擎**）；若已通则无 NEW。其余最接近 NEW 的两条——确定性多样性几何衰减乘子、grox-style plan-DAG——分别已有家 YUK-370、YUK-406，不另拆（守 `feedback_no_scope_fragmentation`）。

---

## 8. 与 Linear 的关系

**原则**：注记/更新**既有** issue，**不**开并行新 issue 群（这正是本稿要点）。home 仍是 **YUK-405**（教研团/推荐 rethink）+ **YUK-203 / YUK-452** 之下的算法 issue 群。

### 8.1 既有 issue 拿到 X 注记（body 增补，非新 issue）

- **YUK-370**：确定性几何衰减多样性乘子（属后置乘子层、跨候选）+ 可选 owner-定死舒适区负乘子（§3.1 / §4）。
- **YUK-446**：DAD 作 LLM ad-hoc 非短视的有原理替代 + DAD 破可缓存不变量（仅 n=1 可接受）（§3.1 / §4）。
- **YUK-439**：**VALIDATES**——X §6 估计-路 ⊥ 行动-路 conditioning-分离印证既有 per-item σ²（非全局 λ）+ live effectiveB-只读分离；σ² ↔ X §6 仅松散类比，非 X 蕴含（§3.2）。
- **YUK-438（+ YUK-437 重申）**：typed 负 outcome 保持一等 ρ-加权诊断观测（§3.3 / §4）。
- **YUK-441**：图-作-先验非图-作-召回，引 X §2.3；**仅 `related_to`/对称边**入 Laplacian，`contrasts_with` 不入（§3.3 / §3.5 / §4）。
- **YUK-482（Done）**：grox §4.5 独立异步层 prior-art VALIDATES + §6 两轴正交防回归护栏（确认已 ship framing，非对已闭 issue 的 refine）；手写信号现状更正（已被 auto-enroll 消费，撤回「抽了又丢」）（§3.5）。
- **YUK-485**：X §4.5 VLM-作-instrument 整页判分佐证（§3.5）。
- **YUK-350**：grox 数值质量阈作 promotion 门（§3.5 / §4）。
- **YUK-406**：例会结构化为 grox-style plan-DAG（最高价值 REFINE）（§3.6 / §4）。
- **YUK-496**：item_calibration 投影=确定性 fold，拒 train-from-events（§3.6 / §4）。
- **YUK-493**：基值层 per-candidate 纯性→WASM badge（仅打分路，θ̂ 更新路因 θ_global 不纯）+ Rust/JAX split 印证 + 无 ANN + **补缺失的** batch-invariance 测试（缺口非强项）（§3.6 / §4）。
- **YUK-435 / YUK-452**：冷启 regime-split 外部印证（§10）+ per-candidate 冷-KC 探索乘子（非全局温度）+ 飞轮 framing day-one 现实记录（§3.4 / §4）。
- **YUK-461 / YUK-361**：live SE/带=Elo-Fisher 路（YUK-361/461，live）；YUK-436 是其上 grid-Bayes 暗推升级；SE/ECE/forward-AUC 在 engagement 栈无对应、存在正因 n=1（§3.2）。
- **YUK-466（Done）**：θ̂ = θ_KC + θ_global 跨-KC 漂移（`state.ts:712-714`，`theta.ts:173`）——candidate-isolation 不变量须 scoped 到读/打分路、排除 θ̂-更新路（§3.2 / §3.6 / 决策 a）。
- **YUK-453 / YUK-455 / YUK-443 / YUK-348 / YUK-367 / YUK-462 / YUK-344 / YUK-474**：各拿一条 VALIDATES/ALREADY-BETTER/N/A 注（见 §3 对应行）。

### 8.2 ADR 文档级注记（非 Linear issue）

- **ADR-0042**：candidate-isolation 不变量按名（**scoped 到基值层** + 三个故意耦合的下游层 + 排除 θ̂-更新路）+ **补缺失 batch-invariance 测试** + LLM 编排故意分歧记录 + 选题阶段契约（决策 a/e）。
- **ADR-0044**：YUK-496 item_calibration fold 注 + event-作-substrate VALIDATES / train-from-events REJECT（§3.6）。

### 8.3 前提更正（须跨 lane 传播，非新 issue）

- **YUK-420 已 Done**：`evidence<3→0.5` 占位在 5 消费者已无效（§3.3 头注）；任何引「占位仍在 5 消费者」的 plan 应更新。
- **YUK-432 / YUK-372 陈旧旗标已解除**：auto_rate 端到端产 label、`recalibration_nightly` 已注册；b_calib NULL 仅因攒 label 中（良性 idle），二者正确标 Done（§3.2）。
- **live SE 归属**：live `thetaSe`/MasteryProjection 带由 **Elo-Fisher 路（YUK-361/461，live）** 产出；**YUK-436 是其上 grid-Bayes 升级、处于暗推**（`THETA_GRID_ENABLED=false`）。任何把 live SE 归给 YUK-436、或暗示 SE 当前缺席的 plan 应更正（§3.2 / 决策 b）。
- **candidate-isolation 现状**：基值打分层 per-candidate 纯（属性），但**无** batch-invariance 测试；`assertL3Invariants` 断的是 due/recall/capacity 另一族（§3.6）。任何称「我们已运行时断言更强的候选隔离」的 plan/注应更正——这是缺口非强项。
- **YUK-466（Done）**：`HIERARCHICAL_ELO_ENABLED=true` 下 θ̂=θ_KC+θ_global、θ_global 跨-KC domain 漂移——任何称「per-KC θ̂ 更新是 (态,item) 纯函数」的 plan 应更正（仅读/打分路纯）。
- **YUK-439 正确 Backlog**：`b_prior_sigma2` 列今天不存在（grep 零命中），机器（π_i selection_observation、AIPW rectifier、`item_calibration.calibration_weight`）已在但旋钮未建（§3.2）。
- **YUK-474 refill-only 验证**：day-one frontier 空（`discoverSupplyTargets` 依赖活 learning_item）；YUK-474 降级为 refill-only 被 X 印证（body 已确认）。若 YUK-188/186 仍承载「飞轮转」framing，先核 body 再标 day-one superseded（§3.4）。

### 8.4 genuinely-NEW follow-up

**实质上无；一条候选待核实。** 几乎每条可借发现归到既有 issue（见 §7 决策 f）。唯一候选 = 手写信号→**cause-attribution** 专门接线：手写已被下游消费（`auto-enroll.ts:1096-1097`），但 YUK-482 **已 Done**，故若该 specific 链确未通须作**单条 NEW follow-up**（挂 YUK-203/YUK-462，小接线非新引擎）；已通则无。不建并行新 issue 群——守 `feedback_no_scope_fragmentation`，也守本稿融合（非新引擎）立场。

### 8.5 文档同步

按惯例（`feedback_docs_sync_to_linear`），本 repo doc 落定后用 `save_document` 同步成挂 YUK-405 的 Linear Document 镜像（repo 为源、Linear 为镜像）。

---

> **作废声明**：本融合稿取代前一版「Evidence-First 复习/推荐引擎 — X 算法架构纪律映射设计」的**独立引擎（standalone-engine）叙述**。框架已成熟；X 的角色是外部印证 + 少数 REFINE + 标出我们 n=1 已更强处，全部融进既有 YUK issue 与 ADR，不另起并行「X 引擎」。
