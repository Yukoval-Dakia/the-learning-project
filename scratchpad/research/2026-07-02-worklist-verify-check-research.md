# Research Dossier — 单元 #8 verify-check: verify-check-sets-tier-solve-threshold

- **Base**: main @ `0291987e`（三腿全部对齐同一 base-ref）
- **Register 锚点**: `docs/design/2026-07-02-project-logic-master-register.md` 约 line 960-969, 1150, 1187
- **合成日期**: 2026-07-02
- **红线约束**（三腿共同遵守）: n=1 不拟合 item 参数；misconception/θ̂ 信号不写 mastery/p(L)/FSRS/difficulty；evidence-first 可追溯可回滚

---

## 单元与打磨目标

`CHECK_SETS_BY_TIER`（`src/server/quiz/verify-framework.ts:61-79`）为 tier3/tier4 声明了 `solve_check` 检查项，但唯一的 tier3/4 消费方 `src/server/boss/handlers/quiz_verify.ts` 只 import `checksForTier` 用来门控 `kind_conformance`/`material_grounding` 两项，从未 import/调用 `runSolveCheck`/`SolutionGenerateTask`，promote 谓词（:382-387）里没有 `solveCheckOk` 项。tier3/4 覆盖**全部 quiz_gen 产出的题**（`deriveSourceTier` 语义：素材出题→tier3，闭卷/搜索出题及其余情况→tier4，"everything else"），是当前**唯一物理生产 quiz_gen 题目**的验证路径。本单元要把这条已声明但未接线的 solve-check 通路坐实，判断该缺口是否为设计遗漏（vs 有意的架构决策）、量化影响面、并给设计 lane 提供接线方案的净指引与开放问题。

---

## Code-ground（现状 + stale 标注 + 残留缺口）

### 现状图

**1. tier→check 集合声明层**（config only，`verify-framework.ts:61-79`）：
- tier2 → `['structure_completeness','source_consistency','solve_check','dedup']`
- tier3 → `['structure_completeness','material_grounding','solve_check','kind_conformance','knowledge_hit']`
- tier4 → `['structure_completeness','grounding','copy_safety','knowledge_hit','kind_conformance','solve_check']`
- `checksForTier(tier)`（:81-83）纯读该 map，**这一层本身没有 bug**——tier3/4 确实"声明"了 solve_check，问题在下游消费。

**2. solve-check 实现**（`runSolveCheck`，`verify-framework.ts:262-403`）：输入 `SolveCheckQuestion` + `SolveCheckOptions{runTaskFn, profile, db?, solverModelOverride?}`；流程为调用**独立**的 `SolutionGenerateTask`（非出题模型同一次调用）→ 解析 `reference_solution.final_answer`/`answer_equivalents` → 按题型分叉：exact 题（choice/true_false/fill_blank 或有 `choices_md`，:157-168）用 `normalizeAnswer` 字符串比对（:337-356）；open 题复用 `runSemanticJudge`（`question-contract.ts:237`，:392），`SOLVE_CHECK_SEMANTIC_THRESHOLD=0.8`（:149）保守阈值——只有"confidently incorrect"（`coarse_outcome==='incorrect' && confidence>=0.8`）才判 `fail`（:393-401）；solver 抛错/空答案/无参考答案 → `'unsupported'`（无信号，不拦截，:309-334）。成本：exact 题 +1 次 LLM 调用，open 题 +2 次。

**3. tier2 消费方 `source_verify.ts`**（唯一真调用者）：`runSourceVerify()`（:282-576）在 `tierChecks.includes('solve_check')`（:357）为真时调 `runSolveCheck(...)`（:369-374），本地 `solveCheckToOutcome()`（:266-275，**未 export**）映射进 `checks[]`。promote 谓词（:382）`knowledgeAlive && !checks.some((c) => c.verdict === 'fail')`——solve_check 的 `fail` 与其它 check 的 `fail` 在这条通用数组式谓词里**权重完全相等**，`unsupported` 天然非阻塞。

**4. tier3/4 消费方 `quiz_verify.ts`**（缺口所在）：只 import `checksForTier`（:57），全文件搜索 `runSolveCheck`/`SolutionGenerateTask`/`SolveCheckQuestion` 零命中。`checksForTier(tier)`（:269）只用于两处门：`kindConformanceChecked`（:310）、`materialGroundingOk`/`kindConformanceOk`（:363-365, :372-373）。**`tierChecks.includes('solve_check')` 从未出现**。promote 谓词（:382-387）：
```ts
const promote =
  parsed.overall === 'pass' &&
  checksPass &&              // grounding + knowledge_hit，同一次 QuizVerifyTask 自我复核
  !isTooClose &&              // copy_safety
  materialGroundingOk &&
  kindConformanceOk;
```
无 `solveCheckOk` 项。`checksPass`/`grounding`/`knowledge_hit` 全部来自**同一次** `QuizVerifyTask` LLM 调用的自我复核（closed-book，只信出题 agent 自报的 `source_refs`，`task-prompts.ts:698`「本次质检是 closed-book，不联网检索」），没有任何独立第二模型重新解题。`grounding`/`material_grounding` 语义是"溯源/切题性"，不是"答案对不对"的独立求解验证——这正是 solve-check 要补的独立盲区，不是已被 `checksPass` 隐式覆盖。

**5. 生产入口佐证影响面**：`boss/handlers.ts:141-158` `quiz_gen` job 完成后自链 `quiz_verify` job；`quiz_gen.ts:685` INSERT 时 `draft_status:'draft'`。`deriveSourceTier`（`provenance.ts:129-168`）：`source==='quiz_gen'` 且 `generation_method==='material_grounded'` → tier3；其余 → tier4（"everything else"）。即**所有 quiz_gen 产出的题**（无论素材出题还是闭卷生成）走 tier3/4，唯一物理 handler 是 `quiz_verify.ts`。

### register 断言逐条 fresh/stale 判（全部 FRESH，无过时表述）

| register 断言 | 判定 | 证据 |
|---|---|---|
| `CHECK_SETS_BY_TIER` 为 tier3/4 声明 `solve_check` | FRESH | :64-70（tier3）、:71-78（tier4）均含 `'solve_check'` |
| `quiz_verify.ts` 只 import `checksForTier`，从不 import/call `runSolveCheck`/`SolutionGenerateTask` | FRESH | import 段（:33-60）+ 全文件 grep 零命中 |
| 只有 `source_verify.ts`（tier2）真调用 solve-check | FRESH | `source_verify.ts:369-374` 唯一调用点；`grep -rn "solve_check"` 全仓库仅两文件命中 |
| plan doc `docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md:236` 承诺"tier-3 分支：额外「素材grounding」检查+solve-check+题型规范" | FRESH | 原文逐字核对一致 |
| 后续 slice（`b8986d00`/`f1414e96`）落地 `kind_conformance` 但 solve-check 半从未落地 | FRESH | `git log -S "runSolveCheck" -- quiz_verify.ts` 全历史零命中 |
| 无独立 Linear/audit doc 记录该具体 gap（register 自陈） | 信息性，本 lane 未复核 Linear（MCP 未加载）；本地搜索仅命中 YUK-538 checklist 本身 | — |
| addendum 判 P1、Final P1、worklist 排第 8 | FRESH，可维持 | 影响面（tier3/4=quiz_gen 全量产出、唯一独立正确性验证手段缺失）未被后续提交削弱 |

**本单元是四条 P1 中 trace 最干净的一条**：无隐藏等价机制、无部分落地被漏记、无后续 commit 悄悄补上。

### 接线方案（供设计 lane 参考，唯一改动面 `quiz_verify.ts`）

1. import 段新增 `runSolveCheck`, `SolveCheckQuestion`, `SolveCheckResult`。
2. 在 `kind_conformance` 判定附近（:310 一带）新增 `tierChecks.includes('solve_check')` 门，构造 `SolveCheckQuestion`（字段与 `source_verify.ts:358-368` 完全同构）→ `runSolveCheck(...)`，`runTaskFn` 类型兼容，零适配层。
3. verdict→outcome 映射：`source_verify.ts:266` 的 `solveCheckToOutcome()` 未 export，需自建映射或提升到 `verify-framework.ts` 共享导出（避免两份手写映射漂移，DRY）；`VerifyAxis`/`VerifyAxisVerdict`（`verify-contract.ts:74-89`）已足够宽松，不需 schema 改动。
4. promote 谓词加 `solveCheckOk = solveResult?.verdict !== 'fail'`（`unsupported`/`pass` 均非阻塞，与 tier2 语义一致）。
5. 审计留痕：`unified.checks` 数组（:416-431）+ payload（:525-570）追加 `solve_check` 块。
6. 测试缺口：`quiz_verify.test.ts`（651 行，"solve" 零命中）需新增 pass/fail/unsupported 三路径 + promote 联动断言。

**不需要改**：`verify-and-promote.ts`（薄 tier-dispatcher，架构边界注释明确"绝不 import 或复刻两 handler 的 check 逻辑"）；`image-candidate-accept.ts` 的 cold-start 预提升分支（硬编码 `source==='web_sourced'`，只影响 tier2，quiz_gen 产出的行从未被预提升）。

### 成本与量级

- **单题增量**：exact 题 +1 次 LLM 调用；open 题 +2 次。相对当前 tier3/4 每题已花 1 次 `QuizVerifyTask`，verify 阶段成本增加 **100%~200%**。
- **模型同源**：`SolutionGenerateTask`/`QuizGenTask`/`QuizVerifyTask` 三者 `defaultModel` 全为 `mimo-v2.5-pro`（`registry.ts:705,721,741`）——同模型同盲点（OF-4(ii)）是 register 早前单元已判 **KEEP** 的、owner 已知未拍板翻转的独立 tradeoff，本次接线不改变它，只是让 tier3/4 也开始承担这一已知局限，与 tier2 现状对齐，不引入新风险类别。
- **量级**：夜间 cron `question_supply_nightly` `DEFAULT_MAX_PER_RUN=25`（:49，硬顶）个供给目标/晚，每目标 `desiredCount` 典型 1-2（`target-discovery.ts:391`）；`AUTO_DISPATCHABLE` 含 `quiz_gen`（`dispatcher.ts:34`）；另有独立 `confusable_contrast_nightly.ts` 同路径；手动 `POST /api/questions/quiz-gen` 默认 `count=3`（`quiz_gen.ts:98,408`），无 cron 硬顶。**每晚数十道 quiz_gen 题全部落 tier3/4、今天零 solve-check 缓解地进 verify→promote→FSRS 池**——量化了 register "today with zero mitigation" 判定。
- **失败处置**：与 tier2 一致——`fail` → 保持 `draft_status='draft'`（不进池不 FSRS enroll），自动复用已存在的 `writeAgentNote`（:587-611，target `coach`，`signal_kind:'question_pool_gap'`，30 天软过期）旁路，不需新建处置逻辑。

### 契约边界核验

- **grading 契约零冲突**：solve-check 复用 `runSemanticJudge`（`question-contract.ts:237`）与真实学生判分共享底层判分原语，但调用参数完全独立（`judge_kind_override` 被 solve-check 强制设为 `'semantic'`，`verify-framework.ts:384`，与题目自身判分路由无关），两者是平行调用点，无共享状态/写路径交叉。
- **`audit:draft-status` 无关**：`quiz_verify.ts` 全程只有 UPDATE（:456-463 / :507-513），无 INSERT；`draft_status` 唯一 INSERT 站点是 `quiz_gen.ts:685`（已显式 set，通过审计）。接线不触碰该 audit 覆盖面。

### 残留缺口清单

1. 核心缺口（本单元主体）：promote 谓词无 `solveCheckOk`，`runSolveCheck` 零调用。
2. `solveCheckToOutcome()` 未 export——DRY 缺口。
3. 测试缺口：`quiz_verify.test.ts` 零 solve 覆盖。
4. 相邻但非本单元 scope：OF-4(ii) solver/generator 同模型（`mimo-v2.5-pro`）仍是 owner 未拍板的已知 tradeoff。

---

## 文献（带权威分级）

### 方向① round-trip consistency / self-consistency / self-correction

1. **Alberti, Andor, Pitler, Devlin, Collins (2019)** — "Synthetic QA Corpora Generation with Roundtrip Consistency". **ACL 2019 main**（CCF-A），引用 273（已核验）。QG→独立 QA 反向作答→仅保留一致样本；SQuAD2/NQ 逼近人类水平。本单元 solve-check 的祖师范式。局限：验证抽取式 QA，与本项目开放式/多步推理题不同构。
2. **Wang, Wei, Schuurmans, Le, Chi, Narang, Chowdhery, Zhou (2022/ICLR 2023)** — "Self-Consistency Improves Chain of Thought Reasoning in Language Models". **ICLR 2023**，引用 **7064**（已核验，地标级）。多采样多数投票显著提升（GSM8K +17.9pp 等）：单次 solve 有噪声，多次独立 solve 取一致性能降低误判率。局限：验证推理链内部收敛，非"生成 vs 独立求解"双向核验；增益幅度是 2022 年模型代测得，不可假设可迁移。
3. **"Self-Consistency Is Losing Its Edge..."**（arXiv 2511.00751，2025-11）。**preprint，未同行评审，需降权**。在 Gemini 2.5 复测：收益萎缩（HotpotQA +0.4%等），成本线性增长，高采样数下性能可能反降。指引：solve-check 若考虑多次 solve 取一致，边际收益随 solver 模型能力增强递减，应自适应而非均一采样。
4. **Huang, Chen, Mishra, Zheng, Yu, Song, Zhou (2024, ICLR, DeepMind)** — "Large Language Models Cannot Self-Correct Reasoning Yet"。**ICLR 2024**，引用未核实（429 限流，但被多篇 2024-2025 综述二次引用，可信度高）。**内在自我修正（无外部锚点）不但不提升、有时反而降低准确率**。与 solve-check 本质区别：solve-check 有外部锚点（已存的正确答案），而非"让 LLM 自己审自己"。**架构指引**：`solveCheckOk` 必须是"独立 solver 对照已声明答案"的外部核验，不能退化成生成该题的同一次调用自我背书。
5. **Miao, Teh, Rainforth (2023/ICLR 2024)** — "SelfCheck: Using LLMs to Zero-Shot Check Their Own Step-by-Step Reasoning"。**ICLR 2024**，引用 205（已核验）。与 #4 形成张力——对自查更乐观，但检查粒度是步骤级而非终局判断。二者分歧提示：self-check 有效性高度依赖检查粒度和是否有外部锚点；tier3/4 应偏向 #4 的外部锚点范式。
6. **"Reverse Question Answering..."**（arXiv 2410.15512）。**preprint，未核实同行评审，需降权**。LLM 生成有缺陷/不可答的题目时，同模型仍常"答对"这个有缺陷的题（Claude-Opus 场景 33%），数值推理域比文本域更严重。**关键警示**：单一 solver 一次通过不能保证题目无缺陷，尤其数值/计算密集题域假阴/假阳风险更高。

### 方向② Automatic Item Generation（AIG）心理测量传统

1. **Gierl & Haladyna (eds., 2013)** — *Automatic Item Generation: Theory and Practice*（Routledge）。学术专著，编者为教育测量领域权威学者（Alberta CRC / ASU 名誉教授）。核心范式：cognitive model + psychometric model 双轨校验，而非单一 solver 判定。前 LLM 时代文献，与自由生成范式不同构，但"质量需多维验证、不能只靠单一自动信号"的哲学有指导意义——solve-check 应是多信号之一。
2. **"A suggestive approach for assessing item quality..." (2023, *Advances in Health Sciences Education*)**。Springer 专业期刊，DOI 可查，正式发表。专家盲评 + IRT（Rasch）统计特征双轨验证，AIG 题专家评分显著更高。**局限：IRT 依赖大样本（132 名学生答 28 题）**，与本项目 n=1 红线**直接冲突**，不可照搬统计验证层；但"内容维度独立于统计维度"的分层思路呼应项目既有红线。
3. **AI-GENIE**（PsyArXiv preprint，2026-04）。**preprint，未同行评审，需降权**。LLM 生成 + 网络心理测量学，依赖大规模人群作答数据（N=4964）估计结构效度，同样与 n=1 红线冲突，仅供流水线架构参考。
4. **"AI-powered Automatic Item Generation for Psychological Tests..." (2025, *Journal of Business and Psychology*)**。Springer/Kluwer，SSCI+Scopus，IF 4.9 Q1，正式发表。多智能体流水线（生成/内容评审/语言学/偏见评估/修订 agent 分工）。**直接支持**"solve-check 是流水线里独立质检 agent/gate，须显式接线而非隐式覆盖"——接线是架构完整性必要项，非锦上添花。

### 方向③ LLM-as-solver 验证可解性/正确性

1. **MATHWELL**（Christ, Kang, Grissom II et al., **EMNLP Findings 2024**，ACL Anthology 正式收录，CCF-A 下属）。用可执行代码能否跑通作为 solve-check 代理。**关键数据**：MATHWELL 66.4% 通过 EC，但通过 EC 的题里只有 74% 同时满足"可解+答案准确+教育适切"三项；GPT-3.5 EC 通过率 97.5%（远高于 MATHWELL）但教育适切性评分（75.5%）反低于 MATHWELL（86.5%）。**净结论：solve-check 必要不充分**，高通过率不代表质量高，不能替代其它规则校验。
2. **"Evaluating LLM-Generated Q&A Test: a Student-Centered Study"**（arXiv 2505.06591，2025-05）。**preprint，未确认接收，需降权**。IRT 混合格式模型测出区分度低、DIF 显著偏斜——solve-check 抓不到的偏差类型。依赖 N=45 学生实测，与 n=1 冲突，方法论提示"solve-check 通过≠无质量问题"。
3. **PLOS ONE 系统综述+网络 Meta 分析**（2026-01）。**同行评审、PubMed 收录，正式发表**，MERSQI+GRADE-NMA 方法学严谨但纳入研究证据强度低（GRADE "VERY LOW"，53% 研究质量偏低）。**明确指出学界缺乏"迭代/验证机制如何影响质量"的系统证据**——这意味着"solve-check 接线能提升多少可信度"无权威文献量化基线。
4. **Reverse Question Answering**（同方向①#6，交叉引用）——33% 假阳性率，数值域更严重。

### 文献对设计的净指引（原文保留）

1. solve-check 正确范式已有强共识（Alberti 2019 / Huang 2024 双向印证）：必须"独立 solver 求解→对比已声明答案（外部锚点）"，不能是同一次生成调用自证清白。
2. 单次 solve-check 通过 ≠ 题目无问题（MATHWELL + RQA 双支撑）：应是必要不充分的一项，与其它 check 并列，不应赋予否决性权重压倒其它信号。
3. 多次 solve/多数投票边际收益随 solver 能力增强递减（Wang 2022 vs 2511.00751 对照）：不建议无差别对所有题跑固定次数多重 solve，若升级应做自适应采样。
4. AIG 心理测量分层校验哲学（Gierl & Haladyna 2013 / JBP 2025）与项目既有红线天然对齐：内容维度（solve-check）应与统计/表现维度（mastery/θ̂/FSRS）严格分离，无需为 solve-check 结果设计任何回写 mastery/FSRS 的旁路。
5. 数值/计算密集题域的 solve-check 可靠性证据薄弱且偏负面（RQA）：若题库含数理内容，落地时应标注该已知局限。
6. "迭代/验证步骤对生成题质量的量化提升"是文献空白（PLOS ONE 2026）：无法引用现成数字，设计文档不应编造或外推收益百分比。

---

## 产品先例（带一手引用）

1. **Google Research `language/capwap`**（一手，`filter_round_trip.py::model_fn/main`，`google-research/language`）。round-trip consistency 教科书实现：独立 BERT QA 模型重新预测答案 span，`is_consistent = (start==start_positions-1 and end==end_positions-1)`，不一致样本**静默丢弃**，无审计记录/reason 字段。n=1 契合（per-item 判定）；evidence-first **不契合**（离线批处理丢弃、不留痕，本项目 `SolveCheckResult{verdict,reason,compared_by}` 已优于此先例，不应向它看齐降级）。二值判定不适合本项目珍贵的 n=1 内容——三态设计是合理收紧。
2. **`openai/evals` modelgraded fact → `promptfoo` 生产化**（一手，`promptfoo/promptfoo:src/matchers/llmGrading.ts::matchesFactuality/getFactualityScoreLookup`，源头 `openai/evals:evals/registry/modelgraded/fact.yaml`）。A-E 五档判定+可配置阈值映射 pass/fail。这是"评判"（judge 对比两段文本）非"独立重解再比对"——更接近 quiz_verify.ts 已有的 `SemanticJudge` 消费，但 solve-check 开放题分支正是"round-trip + LLM-judge"组合，比 promptfoo 单纯 judge 更严格一档。reason 字段+可配置阈值与本项目习惯契合，佐证已有输出契约设计。CI 断言场景是二值无降级选项，不适用本项目三态需求。
3. **`Questgen.ai`**（`trishcho/Questgen.ai-master`，一手）——**与本 bug 结构完全同构的反面先例**。`main.py::AnswerPredictor.predict_answer`（独立求解器）**从未被** `QGen.predict_mcq/predict_shortq`/`BoolQGen.predict_boolq` 调用——组件建了、线没接。更甚者 `BoolQGen.predict_boolq()`（:196-217）是"答案先行"设计：先 `random.choice([0,1])` 掷硬币定答案再反向条件生成问题，从未验证生成的问题真能推出该硬编码答案。唯一"过滤"（`mcq.py::filter_phrases/MCQs_available`）是结构/可用性检查（Levenshtein 去重+Sense2Vec 语义向量），无正确性验证。**诊断价值最高**：广泛 fork/教程引用的 OSS 库，验证能力已实现但未接进生成路径，和本单元 `runSolveCheck` 已实现、`quiz_verify.ts` 不 import 完全同一失效模式——支持"这是接线遗漏而非设计争议"的判断。
4. **`asahi417/lm-question-generation`（lmqg）**（一手，`lmqg/automatic_evaluation.py::compute_metrics`）。round-trip 思想（`QAAlignedF1Score`）产品化为**训练/评测阶段离线 benchmark 指标**（对标静态 dataset 算聚合分数），无 per-item gate/pass-fail 分支。提醒真实设计分叉：round-trip 信号可用作①离线模型质量评测或②线上逐条准入闸（本项目用法②，Google CapWAP 同构）。lmqg 做法不直接迁移，但确认 round-trip 信号本身学术界验证有效。
5. **Onyx（`onyx-dot-app/onyx`）**（一手，含负向 grep 证据）。`backend/onyx/chat/` 全量 grep `quote|verify|extract|hallucinat|no_answer` **零命中**任何"生成后回查引用是否存在/矛盾"的确定性验证。缓解手段是**结构性**的（编号 JSON 引用降低幻觉需求），README 原文："What the LLM sees is far simpler to reduce noise/hallucinations"。反例价值：Onyx 能跳过验证是因为有替代信任机制（用户可点开引用编号核实源文档）；本项目 tier3/4 生成的题目**本身就是终态内容**，没有并列的原始引用可查——Onyx 式"结构性信任"路径**不成立**，零 solve-check 覆盖就是真实零缓解。
6. **Khan Academy Khanmigo**（**二手**，官方博客 blog.khanacademy.org 两篇）。"math agent" 实时验证计算/检查数学表达式，构建计算器工具用确定性计算代替 AI 预测式生成解数值题；上线走 A/B 测试 gate（正向指标提升概率超阈值+guardrail metrics 无负面才放量）。未公开代码，机制描述停留在产品叙述层（未说明校验失败后阻断/重生成/仅记录）。方向上支持"独立验证是必要工序"，但 A/B rollout gate 依赖群体样本量，**不满足 n=1 约束**，只能借鉴"有专门独立校验步骤跑在入池前"的结构性思路。
7. **Duolingo Max**（**二手**，官方博客 blog.duolingo.com）。主要依赖人在回路：专家撰写初始 prompt/持续人工复核准确性和语气+事后用户举报机制训练模型。未发现公开的自动化"生成后独立核验"细节。反例价值：人工审阅规模建立在专职课程设计师团队上，"事后举报再训练模型"对 n=1 更不成立（信号量不足以支撑训练）。进一步说明本项目没有 Duolingo 式替代缓解手段可用。

### 产品先例对设计的净指引（原文保留）

1. "生成→独立复解→比对→闸"是行业反复独立发明的标准模式（Google Research / openai-evals→promptfoo / Khan Academy math agent 三条互不相关血统收敛），solve-check 方法论站得住，本单元要解决的是"已经做好的东西为什么没接上"。
2. 最强指引来自 Questgen.ai 反面实证：验证能力已实现却从未被生成路径调用，是 OSS QG 生态**真实发生过、广泛 fork 传播**的失效模式，与本单元诊断完全同构，坐实修复方向是接线缺口而非重新设计判定逻辑。
3. 本项目现有三态设计（pass/fail/unsupported + 0.8 保守阈值）已比大多数先例更适配 n=1（Google CapWAP 是二值+静默丢弃，对应训练语料场景），不需向先例对齐降级。
4. Onyx/Duolingo 两条反例共同确认：本项目没有"跳过独立验证"的替代信任机制可用（无并列引用可查、无专职人工审校团队），排除"维持现状用别的方式补偿"选项。
5. Khan Academy 的 A/B-gate rollout 不可移植（依赖群体统计），但"独立确定性/专用校验步骤跑在响应前"的结构性思路与本项目 `CHECK_SETS_BY_TIER` 分层设计一致；本项目"按来源可信度分层配置校验强度"在各先例中无直接对标，可视为合理领域扩展。

---

## 三腿冲突与一致点

### 一致点（三腿独立收敛，不重复论证）

- **根因诊断一致**：Code lane 结构性诊断（声明层有、消费层缺）+ Lit lane 方法论确认（round-trip 是有效范式，非需要重新设计）+ OSS lane 实证同构案例（Questgen.ai `AnswerPredictor` 建了不用）三方独立收敛到同一结论——**这是接线遗漏，不是"要不要做 solve-check"的设计争议**。
- **三态判定优于行业先例**：Code lane 描述的 `pass/fail/unsupported` + 保守阈值 0.8，被 OSS lane 显式对比 Google CapWAP 的二值+静默丢弃后判定"已经优于该先例，不需要向它看齐降级"。
- **内容维度 vs 表现维度分离**：Lit lane（AIG 传统 + JBP 2025 多 agent 框架）与项目既有红线（misconception/θ̂ 不写 mastery/FSRS）方向一致，solve-check 结果不应设计任何回写 mastery/FSRS 的旁路——三腿均未提出相反方案。
- **无替代缓解手段可用**：OSS lane（Onyx/Duolingo 反例）与 Code lane（今日 tier3/4 零缓解量化：夜间数十题/晚全部零门径进池）相互印证，"今天零缓解"是真实敞口而非可被其它机制隐性补偿的假象。

### 冲突/张力点（显式列出，不抹平）

1. **否决性权重 vs 必要不充分定位的张力**（最重要）：
   - Code lane 的接线方案是把 `solveCheckOk` 加进 promote 谓词的 AND 链（`solve_check fail → 不 promote`），这与 tier2 `source_verify.ts` 现有的 `!checks.some(fail)` 全数组否决式语义完全一致（对称、无特殊处理）。
   - Lit lane 净指引 #2 明确警告："solve-check 应被当作必要不充分的一项，**不应赋予否决性权重压倒其它信号**"——依据是 MATHWELL 实证（EC 通过率高≠人工质量高）和 RQA 实证（33% 假阳性，同模型对自身缺陷题仍会"答对"）。
   - **这两者字面上矛盾**：Code lane 的最小改动方案（复用 tier2 的否决式模式）恰恰是 Lit lane 认为有风险的设计。需要设计 lane 显式决策：是否延续 tier2 已有的否决式语义（一致性论据：tier2 已如此运作，owner 若已接受该权重分配则扩展到 tier3/4 是保持一致而非引入新风险），还是根据文献建议引入非否决式的降权/软信号处理（一致性论据：文献证据更贴近"是否应该给否决权"这个具体问题）。**Code lane 未讨论这个张力**（其"不需要改的地方"分析停留在架构面，未触及权重设计合理性）。

2. **"独立求解"是否真正满足文献要求的"外部锚点独立性"**：
   - Code lane 确认 solve-check 调用架构上独立（`SolutionGenerateTask` 是与出题 agent 分开的调用，非同一次生成里的自述），Lit lane #4（Huang 2024）要求的正是"外部锚点"（有独立于生成过程的参照物）而非"同一次调用自证"——在**调用架构**层面，Code lane 的方案满足文献要求。
   - 但 Code lane 同时指出 solver 模型与 generator 模型**同源**（均为 `mimo-v2.5-pro`，OF-4(ii)），并将其定性为"已知且 owner 已判 KEEP 的独立 tradeoff，非本单元 scope"。Lit lane 未直接讨论"同模型不同调用"这一具体情形是否仍算"外部锚点"——文献区分的是"有无 ground-truth/参照锚点"，不是"锚点生成模型是否与出题模型同源"。**两腿在这一点上没有直接矛盾**，但存在术语精度上的落差：Code lane 用"独立调用"论证合规，Lit lane 的"外部锚点"标准并未明确排除同源模型场景——这是一个需要设计 lane 显式厘清的边界情况（是否需要额外强调 solver 模型选择的独立性，还是维持现状即可），不应被合并进"已解决"。

3. **多样本/自适应采样：Code lane 未纳入方案范围，Lit lane 提出但无定论**：
   - Lit lane 净指引 #3 建议若升级 solve-check 应做自适应多采样（对首次未通过/低置信的题追加采样），并引用 Wang 2022（正面，7064 引用）vs arXiv 2511.00751（negative/preprint，未同行评审）两篇结论相反的文献，本身内部尚有分歧（自身也不构成稳定共识，只是同一方向下随模型代际变化的观察）。
   - Code lane 的接线方案是单次 solve（无多样本），未讨论是否要引入采样策略。这不是矛盾，而是 Lit lane 提出了一个 Code lane 完全没有触及的设计维度，需要设计 lane 判断是否纳入本次接线范围还是留作后续增量。

4. **成本-收益量化的真空**：
   - Code lane 精确量化了成本侧（+100%~200% verify 阶段 LLM 调用，每晚数十题规模）。
   - Lit lane 净指引 #6 明确指出"迭代/验证步骤对生成题质量提升"是文献空白（PLOS ONE 2026 综述原话），无法引用任何论文给出"接上 solve-check 能把 tier3/4 可信度提升 X%"的数字。
   - OSS lane 同样没有提供该量化（Khan Academy 二手来源提到 A/B gate 机制但未公开具体提升数字）。
   - **三腿共同确认这是一个无法用现有外部证据填补的真空**：设计文档若要论证"值得付出 100-200% 成本"，只能基于本项目自身的定性推理（"今天零缓解"的敞口判断）或未来自建的 before/after 观测，不能援引任何外部文献/先例数字。这不是矛盾，而是三腿一致标记的证据边界，需要在设计文档中显式承认而非填补假数字。

5. **数值/计算题域的可靠性折扣，仅 Lit lane 提出，Code/OSS 未覆盖**：
   - Lit lane（RQA arXiv，未同行评审，需降权）指出数值域 solve-check 假阳性率高于文本域。
   - Code lane 的成本/量级分析未按题型域（文本 vs 数理）拆分，未讨论是否应对数理题设置不同的 solve-check 阈值/权重。
   - OSS lane 未涉及此维度。
   - 需设计 lane 判断本项目题库是否含足量数理/计算类内容以决定是否需要专门处理，若判断"该文献证据强度低（unverified preprint）+ 本项目题域占比不明"可合理搁置，但应显式记录搁置理由而非静默忽略。

---

## 设计相输入（净指引 + 开放问题 + 建议的对抗验证角度）

### 净指引（三腿汇总后对设计方案的收敛建议）

1. **接线本身无争议，应该做**：三腿一致确认这是纯粹的接线遗漏（声明存在、消费缺失），行业有反复独立发明的正面先例（Google/openai-evals/Khan Academy）与一个高度同构的反面实证（Questgen.ai），文献方法论确认 round-trip/独立求解范式有效。设计方案应聚焦"怎么接"而非"要不要接"。
2. **接线范围**：唯一需改文件 `src/server/boss/handlers/quiz_verify.ts`（import + 调用点 + verdict 映射 + promote 谓词 + 审计留痕 + 测试）。`verify-framework.ts`/`source_verify.ts`/`verify-and-promote.ts`/schema 层均不需改。
3. **独立求解架构已合规，权重语义待决**（见冲突点1）：solve-check 复用架构上独立的 `SolutionGenerateTask` 调用，满足文献"外部锚点"要求；但是否给予 promote 谓词否决权，需要设计 lane 显式权衡"与 tier2 一致性"vs"文献对否决权的警示"，不能默认照搬 tier2 模式而不留痕决策依据。
4. **不需要为 solve-check 结果设计任何回写 mastery/FSRS 的机制**——三腿均未发现相反证据，且直接呼应项目红线。
5. **不应在设计文档中援引任何"接线后可信度提升 X%"的量化数字**——三腿共同确认该证据在外部文献中是空白，只能用定性论证（今日零缓解敞口）或后续自建观测支撑。

### 开放问题（留给设计 lane 决策，非本 dossier 应给出答案）

1. **`solveCheckOk` 在 promote 谓词中的权重设计**：延续 tier2 的全否决式语义（`fail→不promote`），还是引入更软的处理（如"仅在其它 check 也有疑虑时才生效"或记录但不阻断）？需要设计 lane 明确给出理由并对照 tier2 现状是否需要同步复议。
2. **是否需要引入多样本/自适应采样**（Lit lane 提出，Code lane 未覆盖）：单次 solve 是否足够，还是应对"低置信/首次未通过"的题追加采样？若纳入，采样次数/触发条件如何定？这会直接影响 3.（成本量化）的最终数字。
3. **数理/计算密集题域是否需要差异化处理**（Lit lane RQA 警示，Code/OSS 未覆盖）：本项目题库中数理占比多大？是否值得为这类题设置不同的 solve-check 置信阈值或额外校验？还是当前证据强度（unverified preprint）不足以支撑特殊处理，应显式记录搁置理由。

### 建议的对抗验证角度（供后续对抗 lane / 设计评审使用）

1. **权重决策的可回退性检验**：若设计 lane 选择否决式语义，要求提供"若未来发现否决式导致误杀率过高，如何观测到、如何降级为软信号"的具体机制（不能是"以后再说"），呼应 evidence-first 可追溯可回滚红线。
2. **verdict 映射函数的 DRY 检验**：若两个 handler（`source_verify.ts`/`quiz_verify.ts`）各自手写 verdict→outcome 映射而不是提取共享函数，应视为设计缺陷（同 register G4 精神），对抗验证应检查该函数是否被提升到 `verify-framework.ts` 并被两处消费。
3. **测试覆盖的空白检验**：`quiz_verify.test.ts` 目前 651 行零 solve 相关断言，接线 PR 必须新增 pass/fail/unsupported 三路径 + promote 联动断言；对抗验证应确认这些测试真实覆盖"solve_check fail 但其它 check 全 pass"这一边界场景（验证 promote 谓词确实被 solve_check 单独否决，而非被其它 check 掩盖）。
4. **成本预算的实际生产验证**：接线上线后应观测实际 tier3/4 题目量级 vs 预估的"每晚数十题"，以及 solve-check 触发 fail 的实际比例，避免设计阶段的成本估算（100-200%）与生产实际脱节；这也是唯一能填补 Lit lane 指出的"文献量化空白"的现实路径（自建 before/after 观测）。
5. **OF-4(ii) 同源模型盲点的显式记录检验**：即使本单元不解决该 tradeoff，设计文档也应显式记录"solver 与 generator 同为 mimo-v2.5-pro"这一已知限制及其被 owner 判定 KEEP 的引用来源（避免后续单元/评审误以为该限制未被评估过）。

---

## 三腿来源文件清单

- Code lane 核心文件：`src/server/quiz/verify-framework.ts`、`src/server/boss/handlers/source_verify.ts`、`src/server/boss/handlers/quiz_verify.ts`（唯一需改）、`src/server/quiz/verify-and-promote.ts`、`src/core/schema/verify-contract.ts`、`src/core/schema/provenance.ts`、`src/server/boss/handlers/quiz_gen.ts`、`src/server/question-supply/dispatcher.ts`、`question_supply_nightly.ts`、`docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md:236`、`src/server/boss/handlers/quiz_verify.test.ts`
- Lit lane 关键引用见各条目内嵌 DOI/venue/引用量
- OSS lane 关键仓库：`google-research/language`（capwap）、`promptfoo/promptfoo` + `openai/evals`、`trishcho/Questgen.ai-master`、`asahi417/lm-question-generation`、`onyx-dot-app/onyx`、Khan Academy/Duolingo 官方博客（二手）
