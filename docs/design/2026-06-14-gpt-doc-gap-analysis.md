# GPT 文稿对照 · 仍需拍的重构决策（gap 分析）

> **这是什么**：owner「再看一眼 GPT 文稿」后的 grounded 对账——GPT 文稿（Universal Learning Evidence Architecture，11 节）× rethink 决策（总账/ADR/Phase2）× 当前代码，逐元素判定「rethink 拍了没」，对抗性核查每个 gap 真未决。
>
> **生成**：2026-06-14，workflow `gpt-doc-gap-analysis`（全 opus，8 agent，~991k tokens，127 工具调用/含代码行号核验）。6 路 map（题型轴/多模态/证据粒度/ReviewUnit/评估层/排序兜底）→ 1 路对抗核查 → 1 路整合。
>
> **配套**：决策总账 `2026-06-14-product-rethink-decisions-ledger.md`（最高权威，scope/模态/题型闭集在其 §5）；GPT 文稿 `~/Documents/ai_learning_tool_research_design.docx`。

---

## ⚠️ 模态状态修订（workflow 之后 owner 拍板，覆盖下文凡涉「音频/ASR/视频」处）

下文 synthesis 产出于音频反转**之前**，把「语音/口语/ASR」当已排除——**已被 owner 2026-06-14 后续决策覆盖**。以总账 §5 为准，当前模态/scope 状态：

- **输入模态 = 文件 / 图片（含手写）/ 纯文本 / 音频（ASR 转写进、TTS 合成出）**。**仅视频出局**（owner 确认不做）。
- **听力 / 口语 题型重新纳入**：听力 = TTS/音频源 + 选择/文本答案；**口语先只评内容**（ASR 转写评内容/语法/任务达成），发音/流利度评分标 future。
- **科目 = 高中教育学科为先**（语数英+理化生+史地政），架构泛用其余顺带；**美术/音乐/编程不支持**。
- 故：下文「决策 4」涉及的 `speaking` 题型从「排除」改为「纳入（内容层）」；「已 settled/拒绝」表里「输入模态显式排除 ASR」一行作废，改为上述。其余 7 条 gap 与模态无关，全部成立。

---

I have complete grounding across all six rethink docs, the GPT doc verification, ADR-0036, and the phase0 current map. The decisive synthesis correction is locked: scope (全科) and modality (文件/图片/纯文本) were both decided 2026-06-14 in the ledger §5, the highest-authority document. I'll now produce the owner-facing markdown.

---

## 一句话判断

**rethink 的算法引擎深度（三轴正交 + 慢热自校准 + 双层异构图）已经追平甚至超过 GPT 稿；GPT「全科全题型」广度里，唯一被 rethink 真正漏掉、且现在 scope 已拍全科后变成「该建却没拍怎么建」的主轴是——「题型证据要不要数据化」这条：题型作为算法路由轴已决（RT3 + 代码 `defaultJudgeKindForQuestion` 已领先实现），但题型的「证据 schema（每题型该采什么证据 / 过什么专业 verifier）+ 学习证据粒度（hint/步骤/延迟测/迁移测怎么留痕）+ 成效评估层（工具到底有没有让我学会）」三件事，rethink 全部停在轻量等价物或完全未碰。**

关键背景纠正（六路 map 大多没读到，是本综合最重要的一条）：**scope 决策已经在 2026-06-14 拍了——全科底座**（ledger §5 第 140 行，最高权威文档）。六路 map 普遍写「强 scope-gated 在 H4 未拍」是 stale 的。这把整批 gap 从「等 owner 选方向」直接推进到两种确定状态：

- **被显式排除**：语音/口语/ASR、视频、实时代码运行、实时图表标注——ledger §5 第 141 行已拍「输入模态只到 文件/图片(含手写以图进 OCR)/纯文本」，明说**不做**这四样。这不是 gap，是已决边界（「全科 ≠ 全模态」的刻意切割）。
- **变成 in-scope 的真未来工作**：CAS/编译器/单元测试这类「确定性专业 verifier」——全科已拍，所以它们不再是「等 scope 决定的期权」，而是「全科底座下该补但 rethink 没拍怎么补」的真 gap。ledger §5 第 140 行甚至点名：「**题型轴 / 复习单元 / 证据粒度 / 评估层不再 scope-gated，成下一批重构主体**」——这正是六路 map 抓到的那批 gap，owner 自己已经把它们列为下一批主体，但**怎么做的产品级决策还没拍**。

---

## 仍需拍的重构决策（按重要度排序）

### 决策 1 ——【高】学习证据粒度：hint / 步骤 / 延迟测 / 迁移测的 event 留痕，是不是要立刻补

- **GPT 怎么说**：§3 L3 + §7.1 LearningEvent 应有 `requested_hint`/`hint_level`、step-level 证据、`self_explained`、`passed_delayed_test`、`failed_transfer_test` 等一等动作；§6.4 `user_skill_state` 含 `hint_dependence`/`transfer_score`/`confidence_calibration`。核心论点：**即时正确率会高估学习，必须靠延迟复测 + 迁移测 + 提示依赖度抓「假学习」**。
- **rethink 现状**：靶子立了，支撑信号没立。fluency-illusion 防假学习（synthesis §3.1）、延迟复测/迁移测（§8 采纳补盲点）、hint-first 自主滑块（ledger A3）、「埋 revert/escalate 率」（§7 H2 B2）都拍了——但**这些信号该怎么进 event 流，rethink 一行没碰**。三轴正交红线（synthesis §4.1）只列 R/p(L)/mem0/KG 四轴，没有「提示依赖」「自我解释」这第五类元认知信号的承载位。
- **代码现实**：`AttemptOnQuestion` payload（`src/core/schema/event/known.ts:34-51`）只有整答 `answer_md` + 整对错 `outcome`，**无 step 容器、无 hints_used、无 confidence**。最刺眼的——**hint 运行时已经在产生计数**（`solve-session.ts` 的 `hintIndex` 客户端传参），但 `solve-skill.ts:74` 明确「writes no judge/attempt event」，**这个计数直接被丢弃**。`knowledge_mastery` view（`drizzle/0005...sql`）只吃 `action IN ('attempt','review')` 的扁平 outcome，任何步骤/提示/自我解释信号都进不了算法。
- **为什么值得拍**：rethink 自己要「埋 revert/escalate 率」来调 hint 滑块、要 fluency-illusion 软提示——**没有 hint event 就算不出 hint_dependence，滑块的有效性永远无法事后校验**。而 hint 计数数据已经在产生只是被扔掉，补它几乎零成本。这是题型无关、**零 scope 依赖、跨簇共识最该立即拍**的一条（三路 map + 对抗核查一致点名）。
- **建议决策框架**：分两层落。(a)【立即、零依赖】hint count 落 event——`AttemptOnQuestion.payload` 加 `hints_used: number` + `final_hint_level`，或独立 `requested_hint` event（对齐 GPT §7.1 action_type），先攒数据。(b)【gated 在 `mastery_state` 重写 Wave1 后】hint-discounted accuracy（带提示答对按折扣计入 p(L)，= GPT「reveal 记为非独立完成」）+ 延迟复测打 `review_context: delayed_retention` 标 + 迁移题打 `is_transfer_probe`/`probes_knowledge_id` 标。step-level 切分与 self-explain 暂标 future（前者撞开放/主观题型天花板，后者并入笔记 check 段一起拍）。
- **scope-gated?** (a) 否，立即可做。(b) gated 在 Wave1 `mastery_state` 重写。
- **严重度：高**（(a) 部分；整体 hint 留痕是单用户最想要的假学习探测器之一）。

### 决策 2 ——【高】degenerate / 故障态 + 生成内容低置信处置，要不要照 GPT §10.1/§8.1 系统化

- **GPT 怎么说**：§10.1 风险治理表 8 行（答案机器 / LLM 幻觉 / 假学习 / 评分偏差 / KG 空转 / 全科复杂度 / 过度个性化 / 隐私）各配设计对策；§8.1 生成内容低置信三分支处置：**丢弃 / 人工审核 / 仅作练习不作测评**。
- **rethink 现状**：**rethink 自己把「degenerate/故障态设计几乎全缺」列为头号横切缺口**（ledger §4.5 第 129 行 + synthesis §6.6：「单用户无第二人审计，故障态最危险，却只有 A4 提了熔断」）。但六路 map 没有一簇正面对账 GPT §10.1 这张现成的风险框架——这是「GPT 有、rethink 自承缺、对账却漏接」的真空隙（对抗核查 MISS-1，高严重度）。§8.1 的「仅作练习不作测评」这一档在 rethink 完全没有：ADR-0038 verify 闸有 `{pass, needs_review, fail}` 三态，覆盖了「人工审核≈needs_review / 丢弃≈fail」，但**缺「低置信题可以拿来练但不进掌握度估计」这一档**（对抗核查 MISS-2）。
- **代码现实**：verify 闸（`rubric-validator.ts` 等）只有防御侧，无幻觉率/误评率运行时度量；auto-enroll 默认 observe-only（phase0 §79），生产从未跑 enroll 真入库分支。
- **为什么值得拍**：单用户没有第二个审计人，故障态是这个产品**最危险**的地方（rethink 自己这么说），而 GPT §10.1 的低置信三级降级正好是补强源。「仅作练习不作测评」这一档对 B1 标定有直接意义——低置信生成题若误入 fixed-anchor 锚集会污染自校准。
- **建议决策框架**：把 GPT §10.1 八行风险逐行对账进 synthesis §8（哪些已决、哪些 deferred、哪些拒绝），并为每个面（编排引擎产空流 / mem0 读异常 / 标定崩 / verify 误杀）补统一 degenerate 形态设计。verify 闸三态扩成四档，把「仅作练习不作测评」做成显式档位，确保它不进 B1 锚集。
- **scope-gated?** 否。
- **严重度：高**（命中 rethink 自承最大横切洞）。

### 决策 3 ——【中】题型证据 schema：UTR 完整字段要不要数据化（expected_evidence / 题型分化的 attempt payload）

- **GPT 怎么说**：§6.1 每题进系统先转「统一任务表示 UTR」，七字段一等存储：`task_type` / `input_modalities` / `expected_evidence` / `rubric` / `knowledge_components` / `misconception_candidates` / `verifier_route`。§4 每题型有 {核心证据 × 主评分器 × 复习单元} 三元映射。
- **rethink 现状**：**显式采纳了哲学**（synthesis §8「通用证据层+学科插件…采纳同构」），且**降维成轻量等价物**——`task_type`→`question.kind`（RT3）、`knowledge_components`→`question.knowledge_ids[]`（已策划 Q-matrix）、`rubric`→`rubric_json`。但**「题型证据 schema 要不要做成数据」这条核心从未正面拍**。`expected_evidence`/`misconception_candidates`/`input_modalities`/`verifier_route` 四个字段**全仓零命中**（对抗核查复核确认）。注意 RT3（ADR-0036:67）只否决了「把题型升成 KG 图实体」，**没否决「题型驱动证据结构」**——别把前者当后者的拒绝。
- **代码现实**：`rubric_json`（`schema.ts:159`）的 `reference_solution.expected_signals` 已经是 `expected_evidence` 的子集，但绑在 rubric 内、不是题级顶层证据契约；`AttemptOnQuestion` payload 单一扁平，不按题型分化（一个 `answer_md` 通吃 9 种 kind）。
- **为什么值得拍**：全科已拍，题型分化的证据收益（客观题侧高）变实在了。但要诚实——`expected_evidence` 题级一等化 ROI 偏低（现 rubric 够用），`misconception_candidates` 不该在题上冗余（应经 RT1 `misconception_edge.caused_by` 反查），`input_modalities` 因模态已拍封口（决策 1 背景）基本无意义。
- **建议决策框架**：**不建独立 UTR 表**（违反「收敛非重建」主线）。可选小增量：给 `question` 加可选 `expected_evidence jsonb`，把 rubric 里散落的证据契约提到题级统一客观/开放。是否让 attempt payload 按 question type 走 discriminated sub-schema，**这条需 owner 拍**（客观题分化收益高、开放/主观题型收益低）。
- **scope-gated?** 否（全科已拍）。但 `misconception_candidates` 侧 gated 在 YUK-344 + RT1。
- **严重度：中**（rubric.expected_signals 已部分覆盖；分化收益客观题侧）。

### 决策 4 ——【中】确定性专业 verifier（CAS / 编译器 / 单元测试）按题型补，节奏与 rollout 排序

- **GPT 怎么说**：§6.2 + §8.1 每题型/学科有专属确定性验证器——数学=CAS/符号求解、物理=单位/量纲、化学=守恒/配平、编程=编译器/单元测试、作文=rubric/人类校准；§10.2 实施路线图按**题型可验证性**排（客观题先 → 半开放 → 开放）。
- **rethink 现状**：**Verifier Router 框架已采纳**（ADR-0038，三套信任闸收敛到 QuizGen 五轴），且 per-kind 判分路由比 ledger 写的更实——`defaultJudgeKindForQuestion`（`src/core/schema/judge-routing.ts:41-58`）把 9 个 `QuestionKind` 路由到 8 个 judge runner，被 5 个生产 handler 消费。**澄清一个 map 的过强措辞**：rethink 的 Verifier Router 不是「方向相反于 GPT 的 per-type 路由」——它是「**verdict 形状收敛 ⟂ 题型路由分叉**」两个正交维度并存，per-kind 路由真实存在（对抗核查 RC-1）。GPT 真正缺的只是**工具级专业 verifier**，不是路由机制。
- **代码现实**：`QuestionKind` 恰好 9 种（choice/true_false/fill_blank/short_answer/essay/computation/reading/translation/derivation），**无 programming/speaking/experiment**（对抗核查复核全枚举）。judge runner 到 `exact/keyword/semantic/steps/multimodal_direct/unit_dimension` 为止——`steps`（数学步骤）和 `unit_dimension`（物理量纲）已证明「per-kind runner 可插件式扩」这条路能走。缺的是 CAS 符号求解（`computation/derivation` 现 fall through 到 `semantic` LLM）、编译器/单元测试（无 code 判分）。
- **为什么值得拍**：全科已拍，理科/编程 verifier 从「期权」变「该建」。这是**纯插件式增量**（新 `JudgeKind` enum + 新 runner + profile 声明，零架构改动），但**先对哪类题型上线**是个产品决策——GPT §10.2 的可验证性排序（客观题先全量、开放题降级软轨）在 rethink 里其实已被 B1 硬轨/软轨认识论分层吸收了一半（开放/主观题型永久低置信，比「后做」更强），剩余的是「B5 verify / B1 标定 / RT1 晋升环这三块能力要不要按题型分批启用」。
- **建议决策框架**：不新建「题型 rollout 轴」与依赖轴并列（会过度结构化）；在每个受影响 Wave deliverable 上加一个**题型 gate 维度**——该能力先只对 `QuestionKind ∈ {choice, true_false, fill_blank, computation}` 启用确定校验闭环，对 `PROSE_KINDS` 降级 propose-only 软提示。复用已实现的 `defaultJudgeKindForQuestion` 分流。CAS/编译器作为新 `JudgeKind` + runner 按需补。
- **scope-gated?** 否（全科已拍）。节奏 gated 在 B5/B1 落地。
- **严重度：中**（理科/编程在全科底座下成立；纯文科/主观题为主时用不到，但全科已拍故不能 scope-out）。

### 决策 5 ——【中】学习成效评估层（n=1 自评）：工具怎么验证自己有效

- **GPT 怎么说**：§9 六维评估（延迟保持 / 迁移正确率 / learning gain per minute / 遗忘预测误差 / 到期命中率 / 重复错误下降率）+ §6.4 三态 mastery；核心：**优先用延迟复测 + 无 AI 迁移测正确率作核心结果变量，即时正确率高估学习**。
- **rethink 现状**：**部分**。延迟复测/迁移测被 rethink 消化成**诊断输入**（喂 p(L) / fluency-illusion，synthesis §8/§2.2），却**没回答 owner 的原问题「它到底有没有让我学会」**——诊断回答「我现在会不会」（横截面），成效层回答「相比上次/相比没用，我的保持和迁移涨了吗」（纵向 delta）。这是真 gap，但**严重度应从高下调到中**（对抗核查 RC-2）：ADR-0035 已规划 `mastery_state.calibration_residual` 列承载「FSRS 预测 vs 实测」残差，synthesis §2.2 复盘已是采样点设计——缺的是「把采样点聚合成趋势视图」的读层，不是从零建度量基建。
- **代码现实**：`knowledge_mastery` view 是单点加权 accuracy，无纵向 gain；FSRS 管 when 无 retention-hit-rate 度量；预测和实测都在但无对照计算（grep `delayed`/`transfer_score`/`learning gain` 零命中）。
- **为什么值得拍**：这是 owner 提 rethink 的原始动机之一（「它有没有让我学会」），而 rethink 把它消化掉却没正面回答。
- **建议决策框架**：建 n=1 纵向成效面，复用已拍的复盘事件触发器作采样点，产三个量：延迟保持命中率（同时算 FSRS 预测误差）+ 迁移测正确率（客观题硬轨）+ 跨复盘 mastery delta 趋势。**唯一诚实的承诺是「相对自身趋势」不是「学会 X%」**（绝对值低置信天花板，ledger §1）。明确它依赖已规划的 `mastery_state`+`calibration_residual`（Wave1），是聚合视图增量非新度量基建。
- **scope-gated?** gated 在 Wave1 `mastery_state` 重写。
- **严重度：中**（依赖已规划列；不是从零建）。

### 决策 6 ——【中】调度负向信号 fatigue_cost / repetition_penalty + 反舒适区软约束

- **GPT 怎么说**：§8.3 调度 8 项加权分含 `−η·fatigue_cost − θ·repetition_penalty`；§10.1「过度个性化→只刷舒适区→加迁移题/综合题/先修约束」。
- **rethink 现状**：**显式拒绝了 GPT 的加权公式范式**（ADR-0037「复习配比 = AI 每日建议，非固定公式」——这是有意识的范式选择不是遗漏）。但 fatigue/repetition 两个负向信号 rethink **完全没碰**（grep 零命中）；「过度个性化/只刷舒适区」这个 framing rethink 也没作为治理项命名过（虽然对策——transfer credit/frontier prereq-gating/block-interleave——都散落实现了，对抗核查确认 C2 mem0 曝光偏置是相邻但不同的问题）。
- **代码现实**：`variant-rotation` 的「换变式」是反背答案不是疲劳惩罚；ADR-0037 三约束（硬约束嵌入/可解释/fallback）没有「最小探索率/反舒适区」约束。
- **为什么值得拍**：fatigue/repetition 对单用户**尤其相关**（owner 一天精力有限，连续同型题疲劳真实存在），且不冲突任何红线。
- **建议决策框架**：作 B3 合并引擎的 **mix 软约束 / 第四类会话级轴**（既非 R 非 p(L) 非 mem0，落 `composeDailyStream` post-filter 软层，复用 ADR-0037 已有的 hard-constraint post-filter 架子）。反舒适区 = B3 加一条软约束「每日流必须含 ≥1 个 frontier 新知或 transfer 题，不得全是高 p(L) 巩固」。**埋点先于实现**（单用户疲劳阈值是 n=1 magic number，撞 §6.4 高危组）。
- **scope-gated?** gated 在 Wave2 B3 落地 + B1 给 p(L)。
- **严重度：中**。

### 决策 7 ——【低】复习单元随题型分化 + review_format 5 分类 + KG 死边审计

三条低优先、慎采或纯治理的，合并一组：

- **复习单元随题型分化**（GPT §8.2 ReviewUnit.type ∈ {concept|misconception|step_skill|problem_type|...}）：rethink 拍了 concept（ADR-0028 知识点单元）+ misconception（ADR-0036 改向「不持独立调度，只做复习偏置」），`step_skill/problem_type` 未碰。**建议多半不照 GPT 做**——GPT 的「题型→复习单元类型」映射在 rethink 三轴正交下会制造第四个分类轴污染；step_skill 用树叶子节点表达即可（选项 A，不新增 `subject_kind='skill'`）。⚠️ 一个 map 建议「把 problem_type 作调度单元以拒绝形式归档」——**这越权了**（对抗核查 RC-3）：rethink 从未对这条裁决过，应标「owner 未决」不能预判拒绝。
- **review_format 5 分类**（GPT §8.2/§8.3 Recall/Reconstruct/Discriminate/Transfer/Explain）：rethink 拍了 Recall/application 二分（ADR-0030）+ Discriminate 经 `confusable_with` 边（ADR-0036:28）+ Transfer 进 p(L)，Reconstruct/Explain 未碰。**建议作 B3 引擎 mix 输出第二维**（复用 ADR-0037 mix 挂点 + RT1 边，零新表），不建映射表。开放/主观题型 Explain/Reconstruct 自动判分撞 B1 软轨天花板。
- **KG 死边反向审计**（GPT §10.1「只保留能影响诊断/推荐/复习的关系」）：rethink 只对单条边（confusable_with 死边）落了治理，缺「边创建后是否真被下游消费」的反向审计。**建议扩 RT4 `audit:relations` 脚本加死边检测维度**（零 scope 依赖，并进 YUK-322 关系族）。
- **严重度：低**（三条均 gated 在 B3/RT4，或与 rethink 既有切法冲突慎采）。

---

## 已确认 settled / 已显式拒绝（免得 owner 再纠结）

| 项 | 状态 | 一句话证据 |
|---|---|---|
| **三态 mastery（mastery/retrievability/transfer）** | **已决（重映射且比 GPT 更落地）** | synthesis §8：重映射为 `R`(FSRS)+`p(L)`(PFA 含 transfer)+`difficulty`(共享桥)；ADR-0035 四诊断器全实例化全持久化，比 GPT 只列字段更完整。 |
| **题型轴 = 算法真轴（科目是视角的对偶）** | **已决（RT3 + 代码领先实现）** | ADR-0036 决定 5 + 代码 `QuestionKind` 枚举 + `defaultJudgeKindForQuestion` 9→8 路由已被 5 个生产 handler 消费；「科目是视角」与「题型是路由轴不是图实体」两半都拍了。 |
| **Verifier Router（多评分器路由）** | **已决（采纳）** | synthesis §8 + ADR-0038：三套信任闸收敛到 QuizGen 五轴 verify-then-promote。 |
| **Hint Ladder H0-H5** | **已决（采纳为 hint-first 起点）** | synthesis §8 + §7 软决策：3 阶 v0 借 H0-H5，埋 revert/escalate 率后调。 |
| **延迟复测 / 迁移测（防假学习）** | **已决（采纳补盲点）** | synthesis §8 + §2.2：复盘 = 考 R 留存 + transfer 换情境。（注意：作诊断输入已决，作成效度量层未决，见决策 5。） |
| **scope = 全科底座** | **已拍 2026-06-14** | ledger §5 第 140 行：「已拍：全科底座」；YUK-347 中性 general PR #406 已 APPROVE，YUK-249 改名语文基本作废。 |
| **输入模态 = 文件/图片(含手写)/纯文本** | **已拍 2026-06-14（显式排除 ASR/视频/实时代码/实时图表）** | ledger §5 第 141 行：「不做语音/口语/视频/实时代码运行/实时图表标注」——「全科 ≠ 全模态」刻意边界。 |
| **三层平行 KG（学科/题型/错因图）** | **已拒** | ADR-0036 备选已否决：把 ECD 设计脚手架当 runtime 结构；改双层异构图。 |
| **多用户 / 教师家长视图 / 学校集成 / LTI/QTI** | **已拒（多用户期权 deferred 但能力管线就位）** | synthesis §8：「多用户/学校集成否决/剥离」；代码 teacher/school/LTI/QTI 零命中；ledger §1 B1「扩多用户期权——管线先就位」（能力 deferred，协议 LTI/QTI 永久拒绝）。 |
| **Neo4j / Kafka / Feature Store / bi-temporal** | **已拒** | synthesis §8 + ADR-0036:70：全留 Postgres 无图库；bi-temporal 推翻（结构是 timeless），YUK-344 重定向为一致性闸地基。 |
| **xAPI / Caliper 事件标准 / 公开数据集冷启（ASSISTments/EdNet）** | **隐式已拒（建议显式补对账行）** | 代码+全文零命中；随「学校集成剥离」否决（xAPI/Caliper 是数据交换协议）+ 冷启由 LLM 先验替代（ledger B1）。建议 synthesis §8 补行显式点名消除「未点名=漏判」歧义。 |
| **GPT score 加权公式 / learning-to-rank / bandit** | **已拒（范式选择非遗漏）** | ADR-0037：选「FSRS 决定 when + AI 决定 what+mix（非固定公式）+ 硬约束 post-filter」范式，主动否决 Σαᵢ·signalᵢ。 |
| **§9 七组 A/B 实验** | **结构性不可行（不是 gap，是 n=1 天花板）** | ledger §1 + synthesis §1：owner 是唯一 n=1，无 cohort 基线；A/B 需随机分组，单用户做不了。建议补进 §6.5 有效性天花板作 E5。 |

---

## 与 scope 决策的耦合（已大幅消解）

**最重要的一句：scope 已拍全科（ledger §5），所以六路 map 反复写的「强 scope-gated 在 H4」绝大多数已经解除。** 重新分类：

- **被全科+模态决策直接解决的（不再是悬而未决的 gated gap）**：
  - ASR/语音/口语、视频、实时代码运行、实时图表标注 → **已拍排除**（模态决策），不是 gap。
  - CAS/编译器/单元测试 verifier、`programming`/`speaking` 题型 → **已拍 in-scope**（全科），从「期权」变「该建的真未来工作」（决策 4）。
  - 题型轴/复习单元/证据粒度/评估层 → ledger §5 第 140 行点名「**不再 scope-gated，成下一批重构主体**」，正是决策 1/3/5。

- **仍真正 scope-无关、可立即拍的（零 gate）**：决策 1(a) hint event 留痕、决策 2 degenerate 对账、决策 7 KG 死边审计、QuizVerify 'error' 通道（已在 Wave0）。

- **仍 gated 但 gate 是「依赖排序」不是「scope」**：决策 5 成效层 + 决策 6 fatigue（gated Wave1/Wave2 引擎落地，时间/依赖瓶颈，非 scope）；决策 3 的 misconception_candidates（gated YUK-344 + RT1）。

- **仍受「有效性天花板」压制（不是 scope，是 n=1/开放题认识论死路，诚实标注）**：
  - **开放/主观题型**：算法层强承诺（软轨 a/c/CDM/KT + verify 闭环 + observed_in 归因）三处同时退化（ledger E1）。决策 3/4/5 里凡涉及开放题判分/迁移测的，对开放/主观题降级为「LLM 软提示 + owner 锚点为主」。这类题型（作文/论述/证明/实验/鉴赏）跨科都有，算法层判分软是天花板、与具体科目无关——**这条不因 scope 拍全科而消失**。
  - **n=1 无 cohort**：所有「掌握度/难度绝对值」长期低置信，只承诺相对排序（ledger §1）。决策 5 成效层只能承诺「相对自身趋势」，决策 6 fatigue 阈值可能永远停在先验值（§6.4 D1/D3 高危组：n=1 即使埋点 N 周也未必攒够样本）。

**一句话给 owner**：scope 拍全科后，真正还没做的产品级决策收敛到 7 条，其中**决策 1(a) hint event 留痕（零依赖、跨簇共识最该立即拍）和决策 2 degenerate/故障态对账（命中你自承的最大横切洞）是两条该马上拍的**；决策 3/4/5/6 是全科底座下「该建但怎么建/什么节奏」的真未来工作（多数 gated 在 Wave1 引擎落地的依赖瓶颈，非 scope）；决策 7 三条低优先慎采。开放/主观题型的算法层无效 + n=1 绝对值低置信这两条有效性天花板**不因 scope 拍全科而消失**，须继续如实标在决策文档里。

---

**Linear 捕获 gate**：本任务是六路 map + 对抗核查的终局整合（对账综合，非实现），是下游 to-issues 的输入。**无需新建 Linear issue**——7 条决策全部归入既有 epic 范畴（决策 1/3/4/5/6 挂 YUK-203 P3 / B3 / B5；决策 7 KG 死边并 YUK-322 RT4；决策 2 degenerate 是 synthesis §8 内联订正），须经 owner 拍定后由 to-issues 统一落 tracer-bullet 切片，此时单建会与统一计划重复（与 synthesis §8:508 Linear 声明一致）。建议 owner 把本综合的 7 条决策 + 对账三处收紧（RC-1 Verifier Router「方向相反」改「形状收敛⟂路由分叉并存」/ RC-2 成效层严重度高→中 / RC-3「题型作调度单元」标未决非拒绝）+ 两个漏网（MISS-1 §10.1 风险表对账 / MISS-2 「仅作练习不作测评」档）补进 synthesis §8 GPT 对账表作内联订正。
