# 整个产品重新想 · 决策总账

> **这是什么**：2026-06-14「整个产品重新想」会话里,owner 逐项拍板的全部决策(算法轴 B1-B5 + 形态轴 A1-A4 + 关系结构 + 旧决策修正 + 文献地基)。既是决策留痕,也是 Phase 2 综合的输入。
>
> **配套文档**：Phase 0 现状地图(`2026-06-14-product-rethink-phase0-current-map.md`)/ Phase 1 大调研(`...phase1-research.md`)/ Phase 1.5 关系结构(`...phase1_5-relations.md`)/ GPT 外部稿(`~/Documents/ai_learning_tool_research_design.docx`)。

---

## 综合主线(Phase 1 两轴 through-line)

> 这是 Phase 1 最该记住的一句话级判断,后面所有 B/A 决策都从这里长出来。决策细节在 §1/§2,完整调研在 `...phase1-research.md`。

- **形态轴 through-line**:从「把所有状态平铺给一个全知用户」转向「AI 编排者每天/每刻策展出一条有理由的主线,把全貌降为可下钻的次级上下文」。Phase 0 四处现状(4-strip 聚合仪表盘 + 三 hero CTA / due+review_plan 双通道不对账 / Copilot 死占位 / 18-kind 均一必须 accept)是**同一反模式的不同切面——把「编排」甩给了用户**。应然 = 编排收归单编排者(D14),人保留**裁决权与方向盘,不是编排劳动**。
- **算法轴 through-line**:应然不是「造新引擎」,而是「**把已长在仓库里对的骨架收敛成一致形态,把已写入却没人读/被占位公式浪费的资产真正接通**」。是「收敛 + 接通」,不是推倒重建。
- **安心结论(load-bearing,定路线图基调)**:没有一个主题需要新引擎 / 新图数据库 / 新基础设施。工作主要是 UI 重排 + 接通已设计好的 seam + 现有零件按新叙事归位。与 GPT 稿「扩展性来自通用证据层不是万能模型」一致,且更进一步——**我们连证据层都基本有了,缺的是一致性**。→ 整条路线图增量极小、零新基建。

---

## 0. 全局原则(贯穿所有决策)

- **克制的策展**:AI 做选择,但封顶防波动、全量可下钻防隐藏、先轻版防押注——不在 AI 质量经使用验证前激进。
- **全局出手强度表(A/B/C,按「可逆性 × 后果」分)**:A 自动 + 撤销窗口 / B 逐条人审 / C 纯状态不进队列。这是 D14 单编排者的统一出手契约,管所有面(inbox kind / mem0 extraction / inline 动作)。
- **三轴正交**:`R`(FSRS 调度)⟂ `p(L)`(掌握诊断)⟂ `mem0`(个性化软画像)⟂ `KG`(结构)——各管各,不互相污染。
- **不计代价 ≠ 不计有效性**:工程代价/ROI 不作否决方案的理由(rethink 的意义);但「有效性天花板」(单用户无 cohort、开放/主观题 LLM 估难度差)如实保留。
- **慢热自校准**:owner 是唯一 n=1 真人,真实作答逐步成为 ground-truth 锚点。
- 既有红线延续:evidence-first / propose-only / 不动树 / 科目是视角 / 防循环注入五防 / 护栏两层语义。

---

## 1. 算法轴(B1-B5)

### B1 掌握诊断
- **三维分层**:`R`(FSRS,记忆,喂调度,per-item)/ `p(L)`(PFA logistic,掌握,喂诊断展示,含 transfer)/ `difficulty`(FSRS 的 D = PFA 的 β,两层共享输入桥)。
- **不对账**(Bjork 失用新论:storage/retrieval 两构念可双向解耦,健康间隔学习本就规律性背离;无对账先例,统一靠 forgetting-aware KT 内含遗忘)。背离信号重定义为 **fluency-illusion 防假学习软提示**(非 error-grade)。
- 删 `knowledge_mastery` view 的 `evidence<3→0.5` 占位,换 PFA logistic(有先验、第一条证据就更新)。
- **标定走全诊断栈但分轨**(不计代价 + 分轨)：**硬轨**(IRT 难度 b + 知识点 θ,客观题闭环,可 n=1 自校验)/ **软轨**(区分度 a、猜测 c、CDM、KT、开放/主观题型——标低置信,a/c 是 n=1 认识论死路 Stocking 1990)。
- **GPT「四诊断器」(IRT/CDM/KT/LLM)的最终去向 —— 全诊断栈照算照留(分轨标置信),但只有一个 PFA 作可信决策信号(+LLM 先验)**。否决的是 GPT「四个并行引擎都进决策」的 router,**不是**否决计算/保留它们的数据(理由 = n=1 稀疏数据养不起四个**可信**引擎,且四者大量重叠):
  - **IRT**:难度 `b` → PFA 的 `β`(= `difficulty` 维 = FSRS D 桥);能力 `θ` → 按知识点累积的 `p(L)`。**b/θ 进硬轨**(有 fixed-anchor 即可 n=1 估);区分度 `a` + 猜测 `c` → **软轨低置信**(需 cohort,Stocking 1990,n=1 死路)。
  - **CDM(DINA/DINO)**:它要的「细粒度 per-skill 掌握画像」由 **PFA 的 per-KC p(L) 覆盖**——PFA 直接读 `question.knowledge_ids`(= 已策划的 Q-matrix),不必另估 CDM。CDM 独有的 slip/guess 分解 + 离散 attribute 分类 → 软轨低置信(同 cohort 约束)。
  - **KT**:选 PFA(logistic、有先验、第一证据就更新、吃稀疏)而非 BKT/DKT/AKT(要序列数据/深网,n=1 喂不饱)。
  - **LLM**:不当判分诊断器,当**冷启先验 + 特征抽取**(直接 prompt 估难度 r≈0;抽教学特征 r≈0.78;模拟考生 ensemble),再由 fixed-anchor+PPI+Elo 慢热纠偏。
  - **数据保留(owner 2026-06-14 拍板「照字面全实例化四引擎」)**:真建 IRT 2PL/3PL + CDM DINA/G-DINA + KT 变体,带先验跑,输出全部**计算 + 持久化**(`item_calibration` 硬轨列 b/θ + 软轨列 a/c/cdm/kt + confidence/track/source 标),即使多为 prior-echo 也不丢。理由 ① **n=1 慢热**——**硬轨列(b/θ)**数据攒够后置信真实 firm up;② **自校准残差**需全栈合成估计 vs 锚点对比(PPI/fixed-anchor);③ **诊断丰富度**(下钻看 CDM attribute 画像/IRT 区分度)+ ④ **扩多用户期权**(管线先就位)。**关键诚实——实例化 ≠ 可信,有效性天花板不变**:软轨 a/c/slip/guess 在 n=1 结构性不可估(Stocking 1990),跑经典估计器多是原样回吐先验、零信息增量,**钉软轨低置信、绝不喂决策/调度**(软轨列「不是还没攒够,是结构性天花板」,allowlist 须写明,别误导未来读者以为数据多了就能信)。否决的是「软轨进决策」,不是「软轨不算/不存」。**此选择覆盖 B1 地基 doc §4.2「CDM 不实例化」的工程建议**——owner 为期权全建,doc 的 n=1 零信息结论保留作「为什么低置信」的依据。
  - → **一句话**:PFA 是落地综合体兼**可信决策信号**,把 IRT/CDM 在 n=1 可估的部分(b/θ/per-KC 掌握)吸收进单引擎喂决策;不可估的部分(a/c/slip/guess)照算照留但钉软轨低置信、不喂决策。把它们钉软轨**不是工程代价否决(违反「不计代价」),是 n=1 无 cohort 的有效性天花板**——「不计代价 ≠ 不计有效性」的直接体现。
  - ⚠️ **来源诚实**:此条是综合连接 [difficulty=PFA β=FSRS D(已落地)] + [Phase 1 §5 选 PFA 弃四引擎] + 标准心理测量 + n=1 限制;四诊断器深挖原文未存盘,系重建非逐字引用。
- **LLM 标定**:不直接 prompt 估难度(实证 r≈0);走 LLM 抽教学特征(r≈0.78)+ LLM 模拟考生(多 persona/ensemble/弱模型优先,客观题 r=0.75-0.82)。
- **自校准**:PPI(数学保证合成≥只用真答)+ fixed-anchor(owner 客观题确定判分作干净锚,残差=miscalibration 信号)+ active learning 选题(Fisher info p≈0.5 + 先验分歧最大)+ Elo/Urnings O(1) 追 θ(锁 item 难度防方差膨胀)。
- **零成本基线 gate**:全合成标定 vs「题型/知识点难度历史均值」朴素基线 head-to-head,不显著赢就回退轻量基线。
- transfer 只进 p(L)(不碰 R/调度)。
- **慢热四阶段**:① 纯 LLM 先验(全低置信,只信相对排序)② Elo 追 θ ③ fixed-anchor 纠偏 + PPI + 三自检 ④ per-knowledge 滚动达标解锁开放题外推。
- 呈现口径:置信区间/低置信标记,非干净「掌握度=78%」。

### B2 知识表示
- **不做 bi-temporal**(结构是 timeless 不变量;「不再为真」≈curation 纠错 epistemic 而非 valid-time;单用户不问历史结构态)。YUK-344 推翻原第一条。
- **双层异构图**(否决 GPT 三层平行图):树骨架(`parent_id` 只读)+ 同构 typed-edge 网(5 核心)+ 渐进晋升的 misconception 异构层。
- **三层分离**:身份层(节点/边/misconception)/ 观测层(event 唯一真相,错因现活这)/ 派生层(mastery/credit,不写回)。

### 关系结构(Phase 1.5 RT1-4)
- **RT1 错因图谱**:升,但「晋升而非复制」(同 effective_cause 同知识点跨 attempt 复现 ≥k 才 propose 晋升、人审 accept);独立 `misconception` 表(不进树/不加 subject 列)+ `misconception_edge` 异构边(caused_by/confusable_with/observed_in/remediated_by)。SISM 措辞收紧为「并列/可共存建模」(非统计独立)。**gated 在一致性闸地基之后。**
- **RT2 credit**:派生量,不物化回边;复用 prerequisite **反向**遍历 + `encompassing_weight` nullable 列(不新建 encompasses 边);credit **进 p(L)**。
- **RT3 题型**:不建图,留 `question.kind` 字段 + `SubjectProfile.judgePolicy.routeByKind` 配置。
- **RT4 治理**:5 核心 relation_type enum **闭集** + `experimental:*` 受闸逃逸阀;`weight` 钉死 confidence-only;promote 走 migration+ADR 摩擦;新增 `audit:relations` 脚本。
- **一致性闸地基(YUK-344 重定向,priority High,独立前置)**:写入期结构一致性闸(环检测/方向矛盾/传递冗余,补 rubric-validator 语义闸之外的拓扑层)+ 写入期调和环(复用 P2 骨架)+ 取代复用 CorrectionKind。**代码侧零实现,是 RT1/RT2/RT4 共同前置。**

### B3 调度
- **合并引擎**(收回双通道):一个 AI 编排引擎通盘吃 FSRS due + frontier + mastery + mem0 prior + AI 判断产出今日流。**合并 what+mix,FSRS when 数学不并进 AI**(独立真相源)。三约束:确定性硬约束嵌入(到期必复习/孤儿 draft 排除作 hard constraint)+ 可解释可追溯 + fallback。
- **frontier 一等公民**(prerequisite-gating 递归 CTE);**空 frontier LLM 填充**(语义+课程结构猜临时 frontier,低置信 propose-only,慢热被真实边替换)。
- 复习配比 = AI 每日建议;review_plan 直接退役并入引擎。
- **FIRe 不单独加**:A 面(涨掌握)= B1 transfer credit 已做;B 面(抵扣 due)砍/押后(地基软 only justinmath.com 无学术论文 + 耦合 R 制造信号混乱)。信号保持正交:R / p(L)+transfer credit / difficulty。

### B4 记忆
- **P3 读路径接通**(`searchMemories` wrapper:topK 放大 + superseded 过滤 + recency 半衰期重排;两消费者 search_memory_facts + brief searchFacts 透明获益)。= task #23。
- 喂信号收窄(携带自然语言陈述的 event 才喂;数值留结构表)。三轴正交升级架构红线。
- **mem0 extraction gate(证据驱动)**:semantic-trait(偏好/习惯/弱点)加 accept gate(pending + 来源 episodic 事件链 + 时间戳 + 一键 reject/edit,编排只读 accepted)/ episodic 客观事件全自动可撤。证据:Gharat WSDM'26(记忆 summary 73.17% 有偏)+ Jiang AIES'19 + Sharma ICLR'24 + Chaney RecSys'18。诚实标:「semantic 比 episodic 更易固化」无 head-to-head 直证,是机制+间接实证推断。
- 「AI 关于你的记忆」透明视图 + 一键 retract。

### B5 出题
- **统一 verify 契约**(三闸 OCR/QuizGen/Variant 收敛到 QuizGen 五轴多信号模板,verify-then-promote = GPT 稿 Verifier Router)。
- plan-then-generate + 客观题确定性校验(答案对得上语料即放行,不烧 LLM,接 B1 客观题 anchor)+ item-model 变式(人 accept 模板/代码确定性实例化,杜绝所见≠入库)。
- Variant 翻转 verify-then-promote;auto-enroll source-tier 灰度(先 authentic + 客观题 + 确定校验通过)。
- QuizVerify 扩 'error' 通道(独立无依赖,先做)。
- 难度/客观校验/对比题/迁移题/题型存储已在 B1/RT1/RT3 钉。

---

## 2. 形态轴(A1-A4)

### A1 一天入口
- `/today` 改 **AI 策展今日之线四层**:交班缕(夜链 forethought,event 派生)+ 今日主缕(策展 3-5 候选)+ 次级副歌(4-strip/KPI/周热力降为可下钻)+ 完成度收尾锚。
- 缕数封顶 5、上限内 AI 动态(1-5,防凑数防波动);**策展主推但全量可下钻——「策展 ≠ 隐藏」**;交班缕先轻(event 派生可解释)后叙事化;三 hero CTA 降级(动作类型非今日下一步)。

### A2 练习旅程(算法侧已在 B3 定)
- **流为脊柱**:流(默认入口,合并引擎产出)驱动,散题/卷=作答动作、卷架=存档、复盘=回看,均从流派生/回流(非五平级视图随意跳)。
- block↔interleave 用 **B1 p(L) 掌握阶段**驱动(新知 block / 巩固 interleave)可用户 override;切换阈值=产品决策+埋点(不声称文献规定)。
- **复盘改事件触发**(掌握阶段跃迁 / 每 N 次)周期性留存校验 + 日常流轻量回执。**复盘 = B1 自校准 UI 落点**(考 R 留存 + transfer 换情境 = owner n=1 锚点入口)。

### A3 AI 角色
- **单编排者一起统一叙事**(后台 4 job dreaming/coach/review_plan/goal_scope + 前台 Copilot 合为同一 D14;actor_ref 分轨保可观测)。
- 自主滑块默认 **hint-first**(可一次性走到完整答案,交还用户控制,防 Khanmigo 教训;提示具体形态待定)。
- 上下文升级两层契约:会话级工作记忆(所有 surface 写入/编排者读取,纳入「刚 dismiss 哪条」)+ 长时 attention prior(mem0 只读)。防循环注入五防必守。

### A4 读vs判
- **全局出手强度表 A/B/C**(可逆性 × 后果):A 自动 + 撤销窗口(乐观应用,不打断不强制确认)/ B 逐条人审 / C 纯状态不进队列。
- A 档 kind 用**静态可逆性**兜底(不靠 confidence,数据基础不足);defer/archive/judge_retraction 移出裁决面(snooze / agent-notes 旁观)。
- 指标落两档健康信号(A 档 revert 率 / B 档 dismiss 率),不追抽象 appropriate-rate。

---

## 3. 已锁旧决策的修正

- **bi-temporal 推翻** → YUK-344 重定向为一致性闸地基。
- **FIRe 砍**(地基软 + 信号混乱;A 面已在 B1)。
- **wenyan 去主角化**(PR #406,中性 general profile,YUK-347;YUK-249「改名语文」方案待裁——被中性 general 取代)。
- **文献措辞收紧**:66 天/2σ 别当承诺(改 instigation+context stability / mastery gating 机制);SISM「并列可共存」非「独立」;Kestin 别外推为「AI≈最佳人类辅导」;DIAL-KG 非共识、语义不逐字对应。

---

## 4. 文献地基(审计结论)

- 整体扎实、**无整篇编造**。硬地基:学习科学族(testing effect / interleaving / Dunlosky PSPI)+ B1 对账(Bjork 经典)+ B4 gate(Gharat/Jiang/Sharma/Chaney 顶会)。
- 软地基(已处理):FIRe(已砍)+ 几处措辞(已收紧)。
- 标准固化:文献调研须核来源真实性 + 权威性(memory `feedback_research_source_authority`)。

---

## 4.5 横切全栈缺口(Phase 1 §4 completeness critic 带出,跨主题未消化)

> 这些不是某个 B/A 的局部决策,是 critic 抓到的「9 主题各自 high、合起来有洞」的横切缺口。上文决策大多没正面消化,Phase 2 路线图与 §5 开放决策须覆盖。

- **degenerate / 故障态设计几乎全缺**:单用户无第二人审计,故障态最危险,却只有 A4 提了熔断。每个面(编排引擎产空流 / mem0 读路径异常 / 标定崩 / verify 闸误杀)的退化形态需统一设计。
- **冷启动 / 空池 / 稀疏图**:竞品全假设内容预存,我们是「现录现算」。题库空 / prereq 边稀疏 / 证据不足时,每个 surface(today 流 / frontier / mastery 展示)的退化形态无人定义。(空 frontier 已在 B3 定 LLM 填充,其余未定。)
- **event 表读放大「物化 vs 即时算」未统一决策**:6 主题同时从 event 流即时算掌握/frontier/credit,跨主题需统一物化策略(在 `knowledge_mastery` view 重写时一并定)。
- **confidence 校准方法论**:A4/B5/B1 都依赖「AI 自报置信度可信」。B1 已给自校准慢热四阶段 + 零成本基线 gate 作答案;A4 改用静态可逆性兜底已部分绕开;**B5 出题置信仍悬空**。
- **UI / 交互形态层整体缺位**:A 轴只到「结构形态」不到「交互/像素形态」,handoff 会卡——交 claude design,不在本轮综合(见 [[feedback_claude_design_workflow]])。
- **弱证据降权清单(Phase 1 §4,逐条索引)**:B5 难度贝叶斯 warm-start 自承纯自创(无现成 recipe)/ A1 66 天习惯(已收紧为弱版)/ B1 stability↔p(L) 对账假设(已**废**,改不对账)/ B4 importance+透明 retract 未实测 / B5 开放/主观题型 provenance 锚无实证(**有效性天花板**,审计确认)。审计已逐条处置,此处留索引防遗忘。

---

## 5. 待 owner 后续拍的开放决策(Phase 2 收口候选)

- **scope —— 已拍(2026-06-14):全科底座**(非单一科目深耕)。架构本就泛用,扩科 = 补打样数据 + 学科 verifier。→ YUK-249「改名语文」基本作废(general 中性默认已对,语文只是众科目之一);**题型轴 / 复习单元 / 证据粒度 / 评估层不再 scope-gated**,成下一批重构主体。
  - **科目范围 —— 高中教育学科为先**(语数英 + 理化生 + 史地政),架构泛用故其余顺带(owner 估 ~9 成学习场景)。**明确不支持:美术 / 音乐 / 编程**(美术=产出性证据不契合;音乐=需演奏/听辨声学分析,超出 ASR/TTS;编程= owner 无支持计划)。英语含听力/口语(音频经 ASR/TTS 纳入,见输入模态条)。
  - **影响 —— 题型轴从「全科全题型」开放命题收成有限可枚举集**:客观题(选择/填空/判断,全科)/ 计算推导(数理化)/ 证明(数学逻辑)/ 作文论述(语文英语史政)/ 阅读理解(语文英语文综)/ 实验探究报告(理化生,文本+图片)/ 图表地图读图(地理生物物理数学,图片)/ 听力(英语,TTS/音频源 + 选择/文本答案)/ 口语(英语,ASR 转写评内容/语法;发音评分 future)/ 文言文阅读(语文,早期打样、与其余科目平权)。**编程 / 美术 / 音乐 不在内**。per-task-type {证据 schema × 验证器 × 复习单元} 因此是闭集设计目标,不是开放工程。
- **输入模态 —— 已拍(2026-06-14,含音频修订):文件 / 图片(含手写,以图片进 OCR/VLM)/ 纯文本 / 音频(ASR 转写进、TTS 合成出)**。**不做**视频、实时代码运行、实时图表标注。→ 音频经 **ASR 转写为文本进证据流**(原音频按 OCR-first/VLM-fallback 同理同步留存兜底,见 [[feedback_ocr_first_vlm_fallback]]),**TTS 供听力题音频源 + 教练语音输出**。GPT 依赖音频的题型(听力/口语)**重新纳入**;编程/美术/音乐仍出局。**口语已拍(2026-06-14):先只评内容**(ASR 转写评内容/语法/任务达成),**发音/流利度评分标 future**(需专用 pronunciation 模型,超出纯 ASR)。**视频确认不做。****注**:ASR/TTS 是 owner 声明已有的能力,当前 ingestion 管线(OCR/VLM)尚未接 ASR,接线是新工。
- **各数值阈值**(缕数上限/撤销窗口/k 晋升/新知复习配比/per-kind 半衰期/auto-enroll 灰度阈值/block-interleave 切换/外推闸门)——统一「先埋点观测 N 周再定参」。
- 错因晋升、credit 物化、promote——全 gated 在一致性闸地基之后。
- 自主滑块提示具体形态(几阶递进)。
- misconception_edge 单多态表 vs 四窄表;reconciliation_log 知识侧/个性化侧共表与否。
- schema 落地(item_calibration / mastery_state / misconception / encompassing_weight)+ Python 微服务范围 + 各需 ADR。
