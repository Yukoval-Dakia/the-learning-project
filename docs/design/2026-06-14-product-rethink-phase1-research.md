# 整个产品重新想 · Phase 1｜大调研

> **这是什么**：Phase 1 大调研产出。9 主题（4 形态轴 + 5 算法轴）× 文献/产品双视角 = 18 路并行 opus 调研 → 9 路主题综合 → 2 轴总论 + 1 路 completeness critic。研究的是「我们这个 AI 学习工具在形态/算法上**应该**怎么设计」，对齐 Phase 0 §7 的 9 个靶子。
>
> **怎么读**：§1 两轴总判断，§2/§3 是 9 个 big bets（最该看的），**§4 completeness critic 抓到的跨主题硬矛盾是 Phase 2 必须先调和的**，§5 与 GPT 外部稿对照，§6 需 owner 拍板的关键决策。附录是 9 主题速览。
>
> **生成**：2026-06-14，workflow `product-rethink-phase1-research`（全 opus，30 agent，~2.6M tokens）。
>
> **三方关系**：本稿 = Phase 0 现状地图（我们是什么）的「应然」对面；与 owner 提供的 GPT 研究稿（`/Users/yukoval/Documents/ai_learning_tool_research_design.docx`）互为独立交叉验证（GPT 稿是单源，本稿是双视角×9主题并行交叉核）。三者在 Phase 2 综合。

---

## §1 两轴总判断

**形态轴 through-line**：产品形态应从「把所有状态平铺给一个全知用户」转向「**AI 编排者每天/每刻策展出一条有理由的主线，把全貌降为可下钻的次级上下文**」。Phase 0 四处现状（A1 的 4-strip 聚合仪表盘 + 三 hero CTA、A2 的 due/review_plan 双通道不对账、A3 的 Copilot 死占位、A4 的 18-kind 均一钉死必须 accept）是**同一个反模式的不同切面——把「编排」这件事甩给了用户**。应然是把编排收归单编排者（D14），人保留的是**裁决权与方向盘，不是编排劳动**。

**算法轴 through-line**：算法层的应然不是「造一个新引擎」，而是「**把已经长在仓库里的对的骨架收敛成一致形态，把已经写入却没人读/被占位公式浪费的资产真正接通**」。我们不缺基础设施，缺的是一致性与闭环。这是一条「收敛 + 接通」主线，不是「推倒重建」。

> **两轴共同的安心结论**：没有一个主题需要新引擎、新图数据库、新基础设施。工作主要是 UI 重排 + 接通已设计好的 seam + 把现有零件按新叙事归位。这与 GPT 稿「扩展性来自通用证据层不是万能模型」一致，且更进一步——**我们连证据层都基本有了，缺的是一致性**。

---

## §2 形态轴 · 4 个 big bets

1. **单编排者 + 自主滑块**。把前台 Copilot + 后台 4 job（dreaming/coach_daily/coach_weekly/goal_scope_propose_nightly）+ review_plan 收编成同一个 D14 编排者的不同召唤姿势，而非 4 个互不知情的人格。出手档位按「**改动范围 + 后果大小**」分（内联 assisted / Drawer 探索 / 后台 supervised-人审 checkpoint），**不按 UI 位置分**。lit（ATSA function-allocation）与 prod（Cursor/Copilot autonomy slider）独立交叉印证。零新基建：copilotTools 贡献制就是现成共享工具层，留痕用 actor_ref 分轨。

2. **策展定为四个面的统一动作**。A1 /today 改「AI 策展的今日之线」（3-5 缕候选 + 交班缕 + 完成度收尾，主线 + 下钻）；A2 加 `composeDailyStream` 薄编排层物化进 `practice_stream_item`（**不合并后端引擎**，双通道各擅其事 + 逻辑共享 `material_fsrs_state`/event 状态轴互相对账）；A4 把 18-kind 收敛到 7 个真裁决项的三档表。三处都是「AI 从全集选一小撮 + 给理由」，与 propose-only 两段式同构。四家竞品（Anki/Math Academy/ALEKS/Khan）**无一把聚合仪表盘当主入口**。

3. **上下文/记忆升级成两层正式契约**。(a) 会话级「工作记忆」——所有 surface（Drawer/inline/后台/composer）都写入、编排者都读取的短时上下文（当前面/focused_entity/上一轮练习结果/刚 dismiss 了哪条），Postgres 现成存；(b) 长时 attention prior——已拍板的 mem0 混合层，定位**只读旁路非真相源**，供编排者读但永不偏置 judge/FSRS。现状 `ambient_context` 只在 `chat.ts` 私有入参喂 Drawer，是雏形未成契约。竞品（Cursor @-mention / Granola context platform / Mem）一致指向这是可演进护城河。

4. **「静态硬判据先行、软 confidence 后迁」的统一兜底 + 单用户硬顶熔断**。四主题最大共同风险 = 策展/置信质量未经真实日用验证（A4 的 confidence 字段只覆盖 1/18 kind 且校准从未验证）。务实路径：先用零成本硬判据（kind 可逆性表 / mastery view 阶段 / 启发式规则）拿 80% 价值且完全可解释，把软 triage 推迟到埋点观测真实分布、校准验证后。**单用户没有第二个审计人**，所以自动写入门槛必须比工业 HOTL 更严（一键可 revert + 单位时间 auto-apply 上限超限退回全人审）。

---

## §3 算法轴 · 5 个 big bets

1. **掌握 = 共享潜状态的双层派生**。记忆维度（FSRS R/S/D，回答「记得牢不牢、何时复习」）+ 证据维度（PFA 式 logistic 派生 p(L)，回答「此刻会不会、迁移得了吗」）两层读同一批 event 各自派生，对外折叠成单标量 + 离散档。**删掉 `knowledge_mastery` view 的 `evidence<3→0.5` 占位 + 纯比值公式**，换成有先验、第一条证据就更新的 logistic 派生。这是整轴最刺眼的债。（⚠️ 与算法轴 bet 2 的 B3 有硬矛盾，见 §4）

2. **调度收敛成「一个 picker + 一个组装层 + 共享掌握状态」**。FSRS 管 *when*（何时复习），新建确定性 selector 管 *what*（学什么），stream/卷架做 *mix*（组装）。`variant-rotation` 的 `pickProbeForKnowledge`（ADR-0030 §5 明写的「唯一可替换 selection step」）升级为 selector 复习侧子步骤，`review_plan`（ADR-0029 separate paper channel）退化为 proposer。**「可学边界」立一等公民**——用 prerequisite-gating（已有的 prerequisite 边 + 一条递归 CTE）算 `learnable_frontier`，不重建 ALEKS 全局 knowledge space。这是图谱相对纯 FSRS-per-card 的核心增值。

3. **知识结构层坚决不做 bi-temporal 双时间轴**。prerequisite/typed 边是 timeless 结构不变量，「不再为真」几乎总是 curation 纠错而非世界变了；单用户不问「2 个月前这棵树长啥样」。从 Graphiti 借的精确改正为「**借写入期调和环 + 结构一致性闸（环检测/方向矛盾/传递冗余）**」，不是「抄双时间轴」。时序真值翻转的需求归位三处已存在的地方：时变 learner state → events 派生；不可变 epistemic 轴 → event 表 append-only；会过时矛盾的会话事实 → mem0 episodic。**⚠️ 这与 owner 既有承诺 YUK-344 第一条（给 knowledge_edge 补 valid_at/invalid_at）正面冲突，需 owner 拍板。**

4. **记忆最高 ROI = 接通已写入的软取代读路径**。P1（GLM+百炼换血）、P2（pg-boss 调和 + jsonb 软取代 + reconciliation_log）都已 live，唯一缺口是 P3 读侧：软取代写了没人读，两消费者还在召回已取代 fact。一个 `searchMemories` wrapper（topK 放大 + superseded 过滤 + recency 半衰期重排）两消费者透明获益。喂信号按「mem0 能力边界」切：**显式自然语言陈述喂 mem0，行为数值留结构表**（mem0 本就不从数值推断）。三轴正交（FSRS⟂mem0⟂KG）从口头约定升级为架构红线。

5. **录入/出题三条信任闸收敛到同一形态**。同一个 propose→verify→入库问题现状三套不一致答案（OCR-path 的 min 弱链单信号 / QuizGen-path 的五轴多信号 gate / Variant-path 的 accept-first 反模式）。应然 = 把 QuizGen 成熟的多轴 gate 抽象成**共享 verify 契约**让另两条复用，统一「verify-then-promote」。出题升级 plan-then-generate + 客观题确定性校验（答案对得上语料即放行，不靠再问一次 LLM）+ VariantGen 走 item-model（人 accept 模板、确定性代码实例化）。难度从静态 default=3 升级为可随作答证据后验更新的单人贝叶斯 1-5 微调。

---

## §4 Completeness critic：Phase 2 必须先调和的硬矛盾

> 9 主题各自标 high confidence，但跨主题有真矛盾。**这些不调和不能进 Phase 2 综合**。

### 跨主题硬矛盾（最严重）

1. **【掌握信号 B1 vs B3 直接打架】** B1 主张双层（PFA p(L) 喂展示 + FSRS R 喂调度，两层对账），明确反对把 retrievability 当掌握；B3 主张废弃 `knowledge_mastery` view、用 FSRS R 作展示+调度的**唯一**信号。两者落到同一段 SQL + 同一张表，改造方向相互覆盖。**Phase 2 必须强制二选一或显式分层（R 喂调度 / p(L) 喂诊断展示 / accuracy 仅旁观），不能两个 high 并列放行。**

2. **【依赖顺序无人厘清】** A2、B3 重度依赖 `knowledge_mastery` view 派生阶段信号与 frontier 排序，但 B1、B3 又要重写/废弃这张 view。**A2 的 block↔interleave 阶段判定建在一个即将被改写的信号上**——view 重写必须先于 A2 落地。

3. **【bi-temporal 立场分裂 + 撞 owner 承诺】** B2 明确反对 YUK-344 第一条（knowledge_edge 加双轴），但 B4 在 coverage_gaps 里仍**默认 P4 bi-temporal 存在**。两个知识/记忆主题对同一份设计稿的 P4 持相反立场却互不引用。**必须作为单点决策，由 owner 拍板。**

4. **【mem0 attention prior 是孤儿输入】** A1/A2/A3/B3/B4/B5 六个主题都把 mem0 列为输入，但**没有任何一个**给出「mem0 软信号与 FSRS-R / frontier / confidence 的加权/优先级关系」。横切六主题的空白契约。

5. **【encompassing/FIRe 三处重复口径不一】** A2（软压缩顺延 due 抵扣）、B1（图 credit 传播）、B3（encompasses relation_type 预留）、B5（错因驱动选题）是同一机制的四个切面，但没人统一。应合并成单一 ADR。

### 横切全栈的缺口

- **UI/交互形态层整体缺位**：A 轴全部（A1/A2/A4 + B4 retract UI）只到「结构形态」不到「交互形态」，像素/交互层留白——直接进实现会在 handoff 集体卡住（需 claude design）。
- **confidence 校准方法论全栈缺失**：A4/B5/B1 都依赖「AI 自报置信度可信」，但无人给验证方案。
- **所有数值阈值无可移植基线**：n=1 单用户固有约束，需统一「先埋点观测 N 周再定参」前置阶段，而非 9 处各自盲试。
- **degenerate/故障态设计几乎全缺**：单用户无第二人审计，故障态最危险，却只有 A4 提了熔断。
- **冷启动/空池/稀疏图缺失**：竞品全假设内容预存，我们是「现录现算」——题库空/prereq 边稀疏/证据不足时每个 surface 的退化形态无人定义。
- **event 表读放大无人评估**：6 主题同时请求时从 event 流即时算，需跨主题「物化 vs 即时算」统一决策。

### 弱证据（标 high 但实为推断，Phase 2 降权）

- B5「难度 warm-start 单人贝叶斯」自承无现成 recipe、纯自创。
- A1「66 天习惯养成」作者自己削弱到弱版本但正文仍当强结论。
- B1「FSRS stability 与 p(L) 应正相关做对账」标来源「综合推断」，无文献，且是未验证假设。
- B4「importance 信号 + MERGE 守卫 + 透明 retract」自承设计稿没有、未实测。
- B5「古文开放题用 provenance 锚 ground-truth」自承缺实证——**古文鉴赏/论述题的验证环实际没有可行方案**。

---

## §5 与 GPT 外部稿对照

| 维度 | GPT 稿 | Phase 1 调研 | 判断 |
|---|---|---|---|
| 掌握建模 | 三态 mastery/retrievability/transfer + IRT/CDM/KT/LLM 四诊断器 | 双层 FSRS R + PFA p(L)，折叠单标量 | **呼应**，Phase 1 更落地（PFA 而非 BKT/DKT，因单用户稀疏数据），但内部 B1vsB3 还在打架 |
| 知识表示时序 | 未强调 bi-temporal | **明确反对**结构层 bi-temporal，主张写入期调和环 | Phase 1 更明确，且撞 YUK-344 |
| 验证评分 | Verifier Router 多评分器路由 | 统一 verify 契约 + 客观题确定性校验 | **强呼应** |
| AI 教练 | Hint Ladder H0-H5 策略引擎 | 自主滑块 / 出手档位 | **呼应**，GPT 的 H0-H5 更具体可直接借 |
| **错因图谱** | **三层 KG 之一：Misconception graph 一等实体** | **未作为 big bet 出现** | ⚠️ **GPT 稿的增量 / Phase 1 的盲点**——错题驱动工具的核心资产，Phase 2 要补 |
| **延迟复测/迁移测** | **一等评估变量（防假学习）** | A2 提了复盘改周期性留存校验，未强调 transfer test | ⚠️ GPT 稿更强，Phase 2 要补 |
| 扩展性哲学 | 通用证据层 + 学科插件 | 收敛已有骨架 + 接通资产 | **同构**，都指向「不靠万能模型」 |
| 工程假设 | Neo4j/Kafka/Feature Store/多用户/学校集成 | 全部留在 Postgres/单用户/无图库 | Phase 1 守住我们的约束（GPT 稿那些要剥离） |

**两个值得警惕的盲点**：错因图谱（Misconception graph）和延迟迁移测（防假学习）——GPT 稿有、Phase 1 没作为 big bet。Phase 2 综合要把它们补进候选。

---

## §6 需 owner 拍板的关键决策（最高优先汇总）

1. **【最高优先·撞既有承诺】bi-temporal 去留**：YUK-344 第一条（knowledge_edge 补 valid_at/invalid_at）是否推翻？(A) 降级为条件触发 + 升写入期调和环为主线 + 加结构一致性闸；(B) 维持原 P4 全量。两路独立反对 (B)。是否授权据此修订 `memory-architecture.md §4.1/§8.2/§8.4`。
2. **统一掌握信号二选一**：调度真相 = FSRS R 还是 accuracy？展示 = 单标量怎么折叠？诊断 = p(L)？accuracy 去留？（B1 vs B3 强制调和）
3. **scope：全科 vs 文言文深耕**（承上次讨论）——算法轴判断暗示架构已泛用、扩科主要是补打样 + 学科 verifier，不是重构。是否把产品愿景定为「通用底座 + 学科插件」（呼应 GPT 稿）？
4. **AI 出手主动性最终档默认值与可调性**：inline 解题默认「给提示」还是「给完整解」？（Khanmigo 教训=强制 Socratic 赶走用户，必须可调）
5. **AI 替人选择性隐藏的边界**（触及「AI 能动 vs 人掌控」红线）：策展 due 能接受 AI 裁掉部分到期项不主推吗？A 档自动应用初期放哪几个 kind？
6. **错因图谱要不要做**（GPT 稿增量，Phase 1 盲点）——Misconception 作为一等实体进 KG？

---

## 附录 A｜9 主题速览

**形态轴**
- **A1 一天入口**（high）：/today 从聚合仪表盘 → AI 策展今日之线（交班缕 + 3-5 候选缕 + 完成度收尾）。借 Math Academy quest log + Khan dashboard 重心转移。
- **A2 练习旅程**（high）：不合并后端引擎，加 `composeDailyStream` 薄编排层当对账点；五状态由 item 掌握阶段推导（block→interleave）；复盘改周期性留存校验。
- **A3 AI 角色**（high）：单编排者收编 4 人格；自主滑块按后果非 UI 位置分；上下文升级成跨 surface 正式契约。
- **A4 读 vs 判**（medium）：18-kind → 三档（A 自动可撤 / B 逐条裁决 / C 状态动作不进队列）；成功指标从 dismiss 数切到 appropriate-response-rate。
- **算法轴**
- **B1 掌握建模**（high*）：删 0.5 占位，PFA logistic 双层派生 + 对账。*与 B3 硬矛盾。
- **B2 知识表示**（high）：不做 bi-temporal，做写入期调和环 + 结构一致性闸。撞 YUK-344。
- **B3 调度/可学边界**（high*）：picker+组装层+共享状态；learnable_frontier 一等公民（prerequisite-gating CTE）。*与 B1 硬矛盾。
- **B4 记忆闭环**（high）：落 searchMemories wrapper 接通 P3 读路径；喂信号按 mem0 能力边界切。
- **B5 录入/出题**（high）：三信任闸收敛共享 verify 契约；plan-then-generate + 客观题确定性校验 + item-model 变式。
