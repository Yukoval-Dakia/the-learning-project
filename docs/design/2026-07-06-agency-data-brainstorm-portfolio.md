# 能动性 × 数据 Brainstorm Portfolio（2026-07-06）

> **命题**（owner）：最大化利用 AI 的能动性和我们的数据。**收敛参数**：全谱系分层（day-zero / data-flywheel / product-face）；红线可挑战但须标记，结算层（θ̂/FSRS/mastery 账本直写）零能动性不可协商。
>
> **流程**：ultracode workflow `wf_8f129ae5-eae`（47 agent / 3.37M tokens）——6 透镜并行生成（数据考古 / 议程权最大化 / 教研团拟人化 / 自我改进闭环 / 外部对标 / 红线挑战者）→ 语义去重 + backlog 对撞 → 逐条 Opus skeptic 攻击（必须实读代码核实 feasibility hook）→ Opus xhigh 终审综合。**漏斗：58 原始 → 39 去重 → 11 存活 / 27 击杀 / 1 漏审**（第 12 条「Provider×task_kind 舱位路由」的 skeptic 在 workflow 内结构化输出 5 次超限被静默丢弃，事后单独补审判 KILL，见附录 A——非存活合计 28，击杀率 72%）。
>
> **Owner 裁决（2026-07-06）**：Top-3 落 Linear —— 审题闸 **YUK-578** / 覆盖细目表 **YUK-579** / 运维看门狗 **YUK-580**；其余 8 条存活想法留档本 doc 待后续挑选；红线挑战组 3 条（knowledge_edge 升 A 档 / applied_in 通电 / 自动 dismiss 悬空提案）**未拍板**，取用时按报告第五节前置 gate 走。
>
> 同日相邻产物：AI pipeline 独立批判五单 YUK-573~577（judge 校准 / learner header / durable lane / registry 诚实化 / 主动开口）。

---

# 最终 Portfolio 报告：6 透镜存活想法终审

11 条想法穿过生成→去重→逐条对抗攻击后存活，全部 code-ground 属实、红线可控。下按三 horizon 分组、组内按对单用户产品的价值密度排序。每条已折入攻击轮的「缩到最小可验证切片」加固。**[强信号]** = 多透镜独立收敛。**[红线]** 分「挑战」（owner 需拍板扩权）与「尊重」（碰到但严格守住，仅告知）。

---

## 一、Day-zero（零数据可跑，最贴「可开始用」milestone）

### 1. 入池前审题闸：`teaching_quality` VerifyCheck　**[强信号·team-anthropomorphist + outside-benchmarks]**
- **机制&价值**：现有 verify 4 轴（grounding / copy_safety / knowledge_hit / kind_conformance）只保「题对不对、有没有抄」，不保「问得清不清、有没有第二个对的答案、干扰项有没有诊断力」。歧义题比事实错更隐蔽地污染 θ̂ 信号，**冷启期尤其值**——第一批题就干净，θ̂ 从 day-one 就不被坏题带偏。
- **能动性**：提案有界（confident-fail 只翻 `draft_status` 留 draft + 写 needs_review，不 promote）。
- **数据输入**：question(prompt_md/reference_md/rubric_json/choices) — 纯只读，无需运行数据。
- **feasibility hook**：`quiz_verify.ts`（verify-then-promote 骨架，L507 promote 翻 draft→active）+ `verify-framework.ts` 的 `CHECK_SETS_BY_TIER`（PLUGGABLE-CHECK 扩展点，solve_check/kind_conformance 就是照此后加的先例）。
- **effort**：S–M（加**一个** VerifyCheck 进 tier3/4，完全复刻 solve_check 落地路径）。
- **加固**：① 明确**删掉**「自博弈强解」半——它就是已 ship 的 `solve_check`（YUK-538/554），别重造轮子；② 「误区人格判别力轴」降级为独立第二刀、标 data-flywheel（需 misconception typed_state 做 grounded 人格种子），day-zero 版只给泛化 persona 当 report-only 别 gate；③ 只翻 `source='quiz_gen'` 的 draft，绝不碰 probe/教学容器题 writer（audit:draft-status 守的失效模式）；④ 落地前查 YUK-573 判据校准重叠面。

### 2. 供题治理：只读覆盖细目表观测面　**[强信号·agenda-maximalist + team-anthropomorphist]**
- **机制&价值**：现有 `scanCoverageGaps` 已在扫 KC × kind × difficultyBand × source-tier 四维覆盖点阵（R1–R4）并 auto-派题，但**没有任何 owner 可见的覆盖蓝图**。把这个既有点阵显性化成只读「细目表」，把「格子空 / 只有低可信源 / 无近-θ̂ 锚 / 只有 recall」四类结构洞（既有 gapKind）渲染成 owner 可见的教研蓝图，挂到 admin 观测四面旁。
- **能动性**：无（纯读观测面）。
- **数据输入**：`discoverSupplyTargets` 产出的 QuestionSupplyTarget[] + 历史 `experimental:question_supply` 事件。
- **feasibility hook**：`question-supply/target-discovery.ts`（discover）+ `route-planner.ts` + 历史事件流；零新写、零 LLM、零 schema。
- **effort**：S–M。
- **加固**（写进 issue 边界）：**(a)** 不引入 cognitive-level/Bloom 轴——全仓 `grep bloom|cognitive_level` 零命中，数据模型无此轴；**(b)** 不动 cooldown——7d 固定必须保留，adaptive 会重开 G-COST job-spam bug（`dispatcher.ts:48-63` 显式堵死的付费无界循环）；**(c)** 痛点优先级（卡前沿/复发误区/复习断档 → computePriority）拆成**独立 data-flywheel follow-up**，且改的是 priority 数值不是 cooldown。攻击关键洞察：per-run 硬顶 25 + 7d cooldown 下，单用户缺口几乎不可能积压 > 25，所以精细优先级几乎不 bind——**真正有边际价值的只有「让覆盖蓝图对 owner 可见」这一显示面**。

### 3. 作答态感知的答案泄漏护栏
- **机制&价值**：copilot 聚焦某练习题作答时，按该题「有无 attempt」区分揭示策略——未作答优先给下一步提示而非完整解。与 evidence-first 同向，防 AI 直接喂答案摧毁 θ̂ 作答信号。
- **能动性**：提案有界（只约束本轮揭示上限，copilot 仍纯被动 propose-only）。
- **数据输入**：`learning_record.attempt_event_id`（schema.ts:437）+ focused_entity{kind,id}（chat.ts:168）。
- **feasibility hook**：既有 `getActiveQuestionState()/countAttemptOutcomes()`（teaching 目录，已驱动 N=3 corrective chip）+ 复用 **YUK-574 的 header 注入管道**。
- **effort**：S–M（不建新管线，加一个 attempted:boolean + 一句软 prompt clause）。
- **加固**：① **砍掉「硬性禁止」**——对单用户自用产品是错配，owner 常合法要「直接给完整解」；降为软 nudge，可被用户一句话覆盖；② 「Khanmigo −50%」是课堂反作弊机制，语义错位，删；③ **先钉触发面真会共现**——若实测 owner 极少在 focused-question 面用 free-form copilot，退回只增强既有 teaching 节奏，避免 dark lane。

---

## 二、Data-flywheel（随事件积累解锁；标注所需数据量级）

### 1. 教学督导：copilot 授课质量评估账本（Part A）　**[强信号·team-anthropomorphist + outside-benchmarks]**　**[红线·尊重]**
- **机制&价值**：夜间 agent 按教学法 rubric（是否克制给答案 / hint-first / 触发自解释 / 命中已知 typed 误区）给每段 copilot 会话打分。系统将有 judge 校准（YUK-573）却**没有 tutor 校准**——copilot 天天授课无人问有效性；这是与 573 正交互补的净新增测量轴。
- **能动性**：议程高（自主选哪些对话复盘），但结论只写 `experimental:agent_note` 独立信道。
- **红线（尊重）**：碰「orchestrator 输出不喂 mem0」——结论**只落 agent_note，绝不回喂 mem0/θ̂/judge**。
- **数据输入**：`tool_call_log`（schema.ts:636，工具序列→判 hint-first vs 直给）+ 会话 transcript（event 流）+ misconception typed_state。所需量级：会话数 ≥ ~20 才出聚合结论。
- **feasibility hook**：`turns.ts`（会话读）+ `research_meeting_nightly.ts`（job 模板）+ `agency/server/notes.ts`（agent_note，有真实消费者 dreaming/coach/review）。
- **effort**：M–L（Part A only）。
- **加固**：① **切除 Part B**（「对照后续同-KC 作答评估这堂课有用吗」）——n=1 因果归因不可辨识，被动 copilot 单用户下会话稀疏、KC-scoped 更稀疏、同-KC 后续作答更稀疏且被 FSRS 彻底混淆；作为 YUK-506 落地后 follow-up 单开；② **评分器诚实化**——先手工标 5–10 段真实会话做 mini golden set 校准 prompt（沿用 573 校准纪律），否则拒发；③ 明确控制回路未闭合（note 仅供 owner 人读 + coach 弱加权，不驱动 copilot prompt 自动调参，闭合依赖 YUK-506）；④ 会话数 < 20 时 job 只累积不出结论。

### 2. AI 运维自监控看门狗（静默失败 flag）
- **机制&价值**：`overnight-digest` 已按 (task_kind,status) 算 status_breakdown，但**不 flag 静默失败**。加一个纯函数：本窗某 task_kind error 计数 > 平凡阈值 → 升为一等「degraded kinds」字段，附最近 N 条 error_message 原串。**~20 个夜间 cron，某 job 悄悄坏三周是真实风险面**——owner 不必刷 admin 面板才发现。
- **能动性**：无（纯读，标红旗标）。
- **数据输入**：`ai_task_runs`（schema.ts:618，task_kind/status/error_message）。
- **feasibility hook**：`overnight-digest.ts`（loadRunRows 已做窗过滤 + count，零 error_message、零基线）；直接搭在已通电的 `/today` 交班缕上。
- **effort**：S（M→S）。
- **加固**：① **砍掉整个成本/去重轴**（原轴 2）——单用户 AI lane 走便宜 mimo 或 owner Claude Max flat-rate 订阅，重算美元是噪声级，且 input_hash 重复重算是 owner 自己写 cron 的设计决策不需引擎「发现」；② 砍滚动基线回归 + 聚类框架——tiny-N 夜间 cron 上分母不成立，group-by top error 足够；③ 不新增 schema/cron/agent，规避 dark-lane；④ 验证：db 测播种一个连续 error 窗，断言 digest 标红回带 error 串。

### 3. 阶段性统考仪式 → 周期性非自适应校准探针　**[红线·尊重]**
- **机制&价值**：连续自适应流的 Pc 被选题钉死→confound θ̂；固定难度 probe 是采干净残差的唯一途径。在固定锚题集上算 `calibration_residual`（观测 vs θ̂ 预测），该列（schema.ts:1010）是**为此刻意预留的空列**（注释「fixed-anchor 残差，Wave2 复盘才写」），本条是其首个生产 caller。
- **能动性**：提案有界（LLM 只组固定难度卷，绝不写 θ̂/残差）。
- **红线（尊重）**：碰结算层但**严格守住**——统考经既有 attempt→`updateThetaForAttempt`→单写者 `state.ts` 入账，残差写走确定性代码，LLM 全程不碰 θ̂/残差值。
- **数据输入**：goal(scope) + question(objective) + mastery_state(theta_hat) + item_calibration 硬轨 b 锚。
- **feasibility hook**：`paper-submit.ts`（L673 走单写者路径）+ `recalibration_nightly.ts`（peer job）+ `calibration_residual`（schema.ts:1010）。
- **effort**：M（L→M，砍掉 UI 仪式）。
- **加固（决定性）**：① **producer + consumer 合并成一个交付**——`calibration_residual` 当前**零 reader 零 writer**，只建 producer = 教科书「建成不通电」。必须同时接一个确定性 consumer（如残差 gate θ̂ 精度/shrinkage 调整，或 surface「calibration drift」admin 信号）。**无 consumer 就不建**；② **删掉「统考仪式 / 见分晓心理节点 / delta-vs-上次 / product-face UI」**——单用户不值 L 级仪式，重构为 headless 阈值/夜 job。

### 4. applied_in 死边通电：掌握后迁移应用探针　**[红线·挑战]**
- **机制&价值**：某 KC 掌握越阈时，沿 `relation_type='applied_in'` 边找应用场景 KC，主动排入跨情境应用题（新 source `applied_transfer`）验证孤立掌握能否迁移。「孤立掌握」升级为「能迁移应用」。
- **能动性**：提案有界（只排 practice_stream_item，reasoning 可见可跳过，不写掌握账本）。
- **红线（挑战）**：正当挑战「死边留着没用」——applied_in 是 audit:relations 实测唯一死边。
- **数据输入**：`knowledge_edge(applied_in)` + **`MasteryProjection.mastery`（非 kt-estimator.pLFinal，后者带红线禁喂决策）** + practice_stream_item。
- **feasibility hook**：`practice_stream_item.source`（'frontier' 已是 `.$type<>` type-only 加宽先例，加 'applied_transfer' 同法无 migration）+ stream-composer。
- **effort**：M。
- **加固（关键——换掉动机）**：① **先跑 5 分钟 population 预检**：`SELECT count(*) FROM knowledge_edge WHERE relation_type='applied_in' AND archived_at IS NULL`，若 < 一手之数直接 shelve；② **成功判据禁止是「audit 转绿」**——同族三个 relation_type 消费者全部 dark-ship（flag 默认 OFF），若动机是「给审计第一个消费者」，只需再落一个默认关闭分支即可自欺转绿、零学习产出，是第 4 条 dark lane。判据必须是「flag-ON 且实际排入 ≥N 条且 owner 作答/engage」的 fired-and-observed gate；③ 挂 YUK-357 follow-up，issue 删除「救活已花成本的边」话术。

### 5. 夜间 job 性价比审计报告　**[强信号·data-archaeology + agenda-maximalist]**
- **机制&价值**：join `cost_ledger.task_kind` →（手维护映射）→ `proposal_signals` 采纳率 + `ai_task_runs` 产出量，输出「高成本/低采纳」夜间 producer 榜（如 `pnpm audit:llm-roi`）。owner 第一次看见每个夜间 job 的真实性价比。
- **能动性**：无（report-only，照抄 audit:relations/audit:calibration 的默认 exit 0 范式）。
- **数据输入**：cost_ledger(task_kind/cost) + proposal_signals(accept/dismiss) + ai_task_runs。所需量级：≥ 每个夜间 task_kind 跑 2–4 周 + 每类提案 ≥ 数十次采纳/驳回决策。
- **feasibility hook**：`getAdminCost`（ai-observability.ts:342，已按 task_kind 聚合）+ proposal_signals(schema.ts:903)。
- **effort**：S（M→S）。
- **加固**：① **删掉「预算仲裁官 / per-job 配额分配」**——红线自锁 propose-only 且「与调度正交、不改调度」，配额无消费者 DOA；② 删「稀缺 $」叙事——贵模型走 owner Claude Max flat-rate OAuth lane、边际≈$0，稀缺前提虚构；③ 正名为 report-only 审计，天然不 dark-lane；④ 注意 `proposal_signals.kind` 是「提案 kind」非「task_kind」，join 需一张手维护映射表（非零成本）；⑤ **horizon 从 day-zero 改标 data-flywheel**；⑥ 可作 YUK-572 的证据输入而非独立能动 lane。

### 6. 自动 dismiss 可证陈旧的 B 提案（inbox 清噪）　**[红线·挑战·安全侧]**
- **机制&价值**：夜链 agent 自动软 dismiss **仅目标实体已删（悬空 FK）**的 pending 提案，而非让 owner 逐条清。dismiss≠accept，只减噪不落结构写入，可 un-dismiss。
- **能动性**：议程权只朝安全方向扩（dismiss 侧直接行动风险远低于 accept 侧）。
- **红线（挑战·安全侧）**：碰「propose-only 覆盖面」，但只往 dismiss 方向。
- **数据输入**：experimental:proposal 事件 + proposal target 存活性。所需量级：随 inbox 陈旧行积累。
- **feasibility hook**：`dismissAiProposal`（actions.ts:936，per-kind、idempotent、写 decision signals 非结算写）+ inbox.ts。
- **effort**：S。
- **加固（缩到一个触发器）**：① **只做悬空目标**——「dup-with-accepted」已被写时 cooldown dedup 抑制、「超 TTL」琐碎，都删；② **不建新 lane**，piggyback 既有 `knowledge_maintenance`/`kc_dedup`；③ 复用 dismissAiProposal + `reason='structural_stale_target'` 保持可审计；④ **纠正自愈论证**——误 dismiss 会占 cooldown key **抑制**重提（隐藏有效项），非「下夜重提自愈」，故必须限死在「结构可证已删」；⑤ horizon 改标 data-flywheel；⑥ 验证：db 测建提案→删目标→sweep→断言 status→dismissed + 无结算事件。

### 7. knowledge_edge CREATE 升 A 档自动应用　**[红线·挑战·最大扩权]**
- **机制&价值**：mesh 边「新建」从 B 逐条人审升 A 档自动落地+撤销窗。其静态逆操作（`archiveKnowledgeEdge` + fold-visible archive）**已在 cascade-revert 里成型且经测试**——是全库唯一被焊死逆操作的 B 档写入，可逆性论证比 completion 还硬；archive 方向仍 B（ADR 判 IRREVERSIBLE）。
- **能动性**：提案层自主性上探至该 kind 自动应用（**目前 A 级 auto-apply = 0 kind，completion 是唯一先例**）。
- **红线（挑战·最大扩权）**：直接扩 propose-only 覆盖面。
- **数据输入**：knowledge_edge(from/to/relation_type/archived_at) + proposal_signals（accept/dismiss 史）。
- **feasibility hook**：`aiProposalKindStrength`（proposal.ts:127）+ `cascade-revert.ts`（classifyRow archive_edge 分支，L232）+ proposals.ts edge applier。
- **effort**：M–L（M→M-L）。
- **加固（先证价值再建）**：① **先不写代码，跑 proposal_signals 查询**取 knowledge_edge(edge_op=create) 历史 accept vs dismiss 比 + top_dismiss_reasons——**go/no-go gate：采纳率不显著高于其它 B kind 或 dismiss 有实质原因 → KILL**；② 承认「复用强度轴」为假——`kindStrength(kind)` 无 edge_op 入参，翻 knowledge_edge→A 会同时翻 archive→A，需**净新增 per-edge_op 子强度轴**；③ 承认 auto-apply 是 completion 专属手写件（专属 breaker/锁/TOCTOU），需**复制而非复用**骨架；④ 覆盖面限 nightly job 一条产线，copilot 即时 propose 不改；⑤ 消费 YUK-497（级联 revert 能力）做可逆性论证成立，非重提 497。**价值论证自省点**：「边下游消费弱」既是低风险来源也是低价值来源——为一类项目自认弱影响学习的写入移除唯一人审关卡，ROI 边际，须 gate 先证「高频低争议」。

---

## 三、Product-face（全新用户可感功能面）

### 1. 会话连接图收尾（折入既有 session_summary）
- **机制&价值**：练习/复习 session 结束后，把今天做过的题沿 related_to/contrasts_with 连到邻居 KC 渲染成图，每个节点一键把该 KC 作 scoped query 打进 copilot。「练完就散」升级为「练完看见知识网」——**KG mesh 对 owner 的首个可视化渲染面**。
- **能动性**：提案有界（生成只读 block + 预置 scoped query 入口，点不点由 owner）。
- **数据输入**：learning_session(本场 item) + knowledge_edge(related_to/contrasts_with)。
- **feasibility hook**：**扩展既有 `session_summary.ts`**（session-end 已 fire，写 artifact-shaped summary）+ CopilotChatRequest 已收 `primary_view` ref（chat.ts:153，scoped-query 入 copilot 只需 UI prefill）。
- **effort**：S–M（折入既有 lane，非新 artifact 类型/新 pg-boss lane）。
- **加固**：① **纠正价值前提**——related_to/contrasts_with **不是死边**（已有 find_knowledge_paths / hub-mesh / A5 消费者），真新意只是「消费对 owner 可见」，别宣称「激活死边」；② **不建新 lane**——folded 进既有 SessionSummaryTask 加一个 neighbor-KC block；③ **删自解释探针**（→ YUK-506，n=1 不可执行）；④ **边密度 gate**：邻居边 ≥ 2 才渲染，防稀疏冷图 ship 孤零节点（暗藏 data-flywheel 前置）；⑤ **内建 dark-lane tripwire**：埋点 neighbor block 点击/打开数，一周真实 session 内 owner 从不点 → 直接删。

---

## 四、Top-3 推荐

**① 入池前审题闸（`teaching_quality` VerifyCheck）— day-zero，最先做**
**② 供题治理只读覆盖细目表 — day-zero，并行做**
**③ AI 运维自监控看门狗（静默失败 flag）— S 级插缝，随手做**

**推荐理由**：三者共性——**全 day-zero 或 S 级、零红线、搭在已通电的 live 缕上**（审题闸骑 `CHECK_SETS_BY_TIER` live 消费点、细目表复用现成 discover + 事件流、看门狗扩已通电的 `/today` digest），因此结构性规避本项目的头号失效模式「建成不通电 dark lane」——这是选它们进 top-3 而非选更宏大想法的第一原则。

- **与「可开始用」milestone 时序**：milestone 正推冷启 day-one placement/profile（见近期 commit）。审题闸让第一批题 day-one 就干净、θ̂ 从头不被歧义题带偏；细目表让 owner 冷启就看见「这科哪些格子还没题」的教研蓝图。两者都是**冷启即兑现**，不等数据。看门狗保护冷启后立刻开跑的 ~20 条夜间 cron——它们一旦静默坏三周，整个 data-flywheel 的燃料就断了，S 级投入买的是全盘可靠性保险。
- **与在飞线协同**：审题闸与 **YUK-573（judge 校准）** 是同族的质量-gate 双轴（一个 gate 入池题质量、一个 gate 判分质量），可共享校准纪律；看门狗天然覆盖 573–577 新增的所有 task_kind。
- **单用户价值密度**：三条都是「小切片、真缺口、低风险」，合计 effort ≈ 一条中型 lane，却各闭一个真缺口。

**紧随其后的两个中期战略押注**（不进 top-3 因需数据/更大投入，但值得排队）：**教学督导 Part A**（与 573 正交互补的 tutor 校准轴，最 on-thesis，但 L 级 + 需 mini golden set + 会话积累）与 **Checkpoint 非自适应校准探针**（采干净 θ̂ 锚 + 点亮 `calibration_residual` 空列，但**必须同时接 consumer 否则是 dark lane**）。

---

## 五、红线挑战组（owner 需逐条拍板）

### A. 需拍板扩权（真动能动性边界）

| 想法 | 挑战的红线 | owner 要裁的决定 | 风险等级 |
|---|---|---|---|
| **knowledge_edge CREATE 升 A 档** | propose-only 覆盖面 / A 级仅 completion（当前 auto-apply = 0 kind） | 是否允许**第二个 A 档 auto-apply kind**。**前置硬 gate**：先跑 proposal_signals 查询证明 edge-create「高频低争议」，不达标即 KILL。承认需净新增 per-edge_op 子强度轴 + 复制 completion auto-apply 骨架（非复用），限 nightly 一条产线。 | **高**（最大扩权，须先证价值） |
| **applied_in 迁移探针** | 「死边留着没用」的处置 | 是否给 applied_in 死边一个下游消费者。**前置**：先跑 population SQL，边 < 一手直接 shelve。成功判据钉死为「owner 实际消费迁移题」，**禁止是 audit 转绿**（否则第 4 条 dark lane）。触发信号用 MasteryProjection.mastery，禁用 kt-estimator.pLFinal。 | **中**（动机须换、须防自欺绿灯） |
| **自动 dismiss 陈旧 B 提案** | propose-only 覆盖面（**dismiss 安全侧**） | 是否允许 agent 自动 dismiss **仅结构可证已删目标**的提案。dismiss 可 un-dismiss、写可审计 reason、单夜 cap 超限退全人审。 | **低**（安全方向、最小切片） |

### B. 碰到但严格尊重（仅告知，无需拍板）

- **Checkpoint 非自适应校准探针**：碰**结算层**红线，但 LLM 全程只组固定难度卷，`calibration_residual` 写走确定性 `state.ts` 单写者，LLM 绝不碰 θ̂/残差值。**唯一附加要求**：必须同时接一个确定性 consumer（producer+consumer 一体交付），否则触发「建成不通电」。
- **教学督导 Part A**：碰「**orchestrator 输出不喂 mem0**」红线，但结论**只落 `experimental:agent_note` 独立信道，绝不回喂 mem0/θ̂/judge**。控制回路诚实标注未闭合（仅 owner 人读 + coach 弱加权，闭合依赖 YUK-506）。

**结算层直写零能动性**这条不可协商红线：本 portfolio 全部想法均未触犯——无任何想法让 LLM 直写 θ̂/FSRS/mastery 账本（Checkpoint 的残差与 applied_in 的掌握读取都只读不写结算，A 档扩权限于 KG 边非结算层）。

---

## 附录 A：第 12 条补审——「证据驱动的 Provider×task_kind 舱位路由」（KILL）

workflow 内该条的 skeptic 5 次结构化输出均失败被静默丢弃，主 session 事后单独派 Opus skeptic 补审，判 **KILL**：

- **经济前提伪造**（决定性）：`src/server/ai/pricing.ts:41-53` 把 Opus 订阅 lane（anthropic-sub）成本诚实记 0（flat subscription 无边际），mimo 费率是文件头标注的 PLACEHOLDER——「每美元质量」的分母不存在。与被击杀的「预算仲裁官」死于同一条：owner flat-rate 付 Claude Max，「Opus 的钱」不随调用数增长，无可优化标的。
- **无反事实数据**：AI_PROVIDER_OVERRIDE / VISION_JUDGE_PROVIDER 都是 all-or-nothing 全局开关，任一时间窗内 ai_task_runs.provider 是单一常量，同 task_kind 从未在可比输入上跑过两个 provider，学不出 A vs B。
- **质量代理无归因链**：proposal_signals 按 (kind, cooldown_key) 聚合，无 provider/model 列，无 task_run_id→provider join。
- **残值被既有单拥有**：provider 间质量对比采样 = YUK-573 by design 的产出；provider 选择层 = YUK-576 的地盘。相减后独立增量为零。
- **复活条件**（若坚持）：等 YUK-573 落地复用其双 judge 采样、补 task_run_id→provider 归因链、范围收敛到 1-2 个高频 task_kind——届时它只是 573 的下游只读 dashboard，不足以独立立项。

## 附录 B：击杀名单（28 条，防复活留档）

- **工具效力账本 + Agent 自我复盘注入**：击杀，三层证据叠加：

**(1) 价值的一半已 shipped（换皮 adaptive-bias Facet A）。** 想法承诺的第二产物「给 proposer job 自己的结构化『我上轮为何被驳』失败模式前言，注入下轮运行上下文」正是 `src/server/proposals/adaptive-bias.ts` Facet A 已在做的事——文件头逐字写着：per-`(kind, relation)` digest「recent dismiss reasons ... injected into the Dreaming/Coach/Copilot proposal prompts so a frontier LLM can self-correct against the specific failure mode (in-context learning, §6)」。self-critique in-context 注入这一半是活线，不是缺口。

**(2) 「工具层下钻」相对已有的 kind 层近乎恒等（零增量）。** 实测 `proposal-tools.ts` 每个 propose 工具产出固定 kind（propose_knowledge_edge→knowledge_edge、propose_variant→variant_question、author_question→question_draft …，~13 工具 ≈ 1:1 映射到 kind）。accept/dismiss 结局只在 `proposal_signals` 的 cooldown_key 聚合粒度存在，adaptive-bias 已按 (kind, relation) 聚合。tool_name 维几乎就是 kind 维的重命名——「dismiss 第一次被归因到具体工具而非笼统 kind」这句站不住，kind 已经在归因了。

**(3) 唯一真新的切片（input_json 形状聚类）在单用户下数据饿死。** 结局聚合在内容派生的 cooldown_key 上、不在 input 形状上；要把 dismiss 归因到「入参形状」须 per-proposal 实例级 join（tool_call_log.output_json.proposal_id ↔ rate/dismiss 事件）+ 足量样本 + 一个想法只写了「入参形状」四字、没定义的聚类方法。单用户一夜的 question_draft/edge 提案是个位数，per-tool×per-shape 细胞长期 n=1..3，统计归因不可靠——号称 data-flywheel 实为「需要数月体量」。

**(4) owner 效力表 = 又一条 dark lane。** 红线明令 registry 降权/停用不自动化（且 YUK-576 已占「registry 诚实化」），所以「propose 降权/停用建议」只能是 owner 手读手动执行的报表；本项目已知失效模式就是「建成不通电」。self-critique 半已有活线可复用，效力表半新增一个无消费者的仪表盘。

综合：valuable 半已通电、novel 半数据饿死且近似 kind 层重命名、report 半 dark-lane。作为独立 M-L item 不成立。唯一可救的残片（把 Facet A 现有 digest 对非 edge kind 加一条 tool_name/粗 input-tag 分解行，复用已接线的 prompt 注入、不建新表、推迟到提案体量足够）应作为 adaptive-bias 的一行 follow-up note，不配开新单。
- **和解决策事后审计（reconciler 自省）**：击杀的核心不在接缝真伪（接缝真），而在价值机制建立在一个本架构不存在的信号上。想法的招牌价值是"交叉核对 reconciler 决策与 owner 后续行为（被合并的又被拆开重建？被取代的边又被重提？）"。但这是单用户全自动系统：memory 由 addEventMemory 从事件自动生成、owner 无手动拆分/重建 memory 的界面；edge/misconception 的 SUPERSEDE 决策发生在夜间 apply 事务内部、对 owner 完全静默、从不作为 proposal 呈现给 owner（reconciliation 走拓扑闸后写入期，不进 proposal_signals accept/dismiss 队列）。因此"owner 推翻信号"这个 ground truth 根本没有采集面——owner 从不 curate 这三类结构，"被 owner 拆开/重提"是虚构的用户行为。剩下唯一可探测的 reversal（被归档 tuple 后来又被系统重新提议）是二阶稀有事件且重度混淆——"图后来用新证据重新学到该边"≠"reconciler 当初判错"，无法区分。没有独立 ground truth，"reconciler 准确率"就退化成用另一个 LLM 给过去 LLM 决策打分（循环自证），恰是它声称要抓的"越并越错"却没有外部锚。加上"某 misconception 类上系统性过激"需要 per-category 样本量，单用户 SUPERSEDE 事件月单位个位数、reversal 近乎零，data-flywheel 实为 data-glacier，横轴被严重低估。此项目有明确"建成不通电"失效史 + ~20 个夜间 cron，一份没有真实消费闭环的自省报告 = 又一条 dark lane。
- **拒绝理由蒸馏 → 生成期负向约束/自查清单**：本条声称的核心价值（owner 拒绝语言 → 注入 proposer prompt → 同类被驳理由不再复发）已经由生产代码交付：adaptive-bias 的 top_dismiss_reasons digest 已在 dreaming/coach/copilot 三个 proposer 面在线注入，并已附带「识别为该 cell 的具体失败模式并避免复发」的指令。剩下的真实 delta 只有两点：(a) per-cell 原文 → 跨-kind LLM 聚类主题分类；(b) 生成前 self-critique rubric。(a) 对单用户是净负——聚类把 owner 的具体拒绝措辞抽象成「太臆测/已知/粒度错」的泛标签，恰恰丢掉现行 live 路径已保全的 concrete 特异性（对单人自用，具体 > 抽象）；且聚类需要一个自由文本 dismiss_reason 语料库，而该字段 nullable 可选、owner 极少手写、adaptive-bias 也只在 net-negative cell 才 emit，data-flywheel 燃料很可能永远不够（声称 data-flywheel 实为 data-starved）。(b) self-critique rubric 只是把现有「避免复发」注入重新包装成生成前自查框架，是一次琐碎 prompt 措辞调整，不配 M-effort build。整体是对一条已 ship live 机制的增量抛光，披着「正交」外衣。
- **选择遗憾 off-policy 挖掘**：想法的核心动作——「回放 softmax 当日跳过的低概率候选，找出错过项算选择遗憾」——在现有数据上没有底物。selection_observation 每天只落 selected=true 的被抽中项（含其 π_i + signals 快照），从不落被跳过的候选（selected=false 行零写入）。两个也是仅有的两个 writer（stream-store.ts:472 与 :1189）都硬编码 selected:true，且只遍历 result.sampledInclusion（抽中集），非抽中候选在 sampler 里算完即弃、从不持久化。因此「错过项」这个反事实对象在表里根本不存在——你无法从 selected-only 的行里知道某天候选池里有哪些题被跳过。off-policy regret mining 的前提是有反事实候选集，此处缺失。想把它做起来需要三段式：先改 writer 记录非抽中候选（instrumentation），再等数据积累（flywheel wait），再建估计器——这不是对现有接缝的 data-archaeology，horizon 标注 data-flywheel-on-existing-seam 是错的。signals 载荷零消费属实，但那是 selected 项的 signals，已同时物化进 practice_stream_item.signals，并非独一无二的未采金矿；真正需要的非抽中候选 signals 从不存在。
- **夜班调度总管：自适应 cron 门（run-planner）**：这条想法的两根价值支柱在代码前都塌了，剩下的核不值得一条 L-effort 高议程 AI lane。

**① feasibility_hook 真实（这不是击杀点，但要说清）**：cron 确实全硬编码在 `src/capabilities/{agency,practice,knowledge,notes}/manifest.ts` 的 `jobs[].schedule.cron`（agency 5、practice 12、knowledge 7、notes 1，全 `Asia/Shanghai`）。cost_ledger、`ai_task_runs`（schema.ts:611）都在。接缝真、语义没误读。红线②也守住了（结算 job 只 gate 触发不代写）。所以不是靠①②杀。

**杀点在④价值不成立——两个卖点都被既有机制吃掉了：**

**卖点 A「省夜间 LLM 花费」≈ 0。** 每个 backfill job 已经幂等自 gate：谓词是 `embedding IS NULL OR embed_version < N` 之类，`if (qs.length > 0)` 才调 `embedMany`（embed_backfill.ts 实测）。**没活时 job 就是一条有 index 的 `SELECT ... WHERE ... IS NULL LIMIT 100` → 0 行 → 直接 no-op，零 LLM 调用**。昂贵的 LLM 只在真有缺口时才烧。run-planner 的 staleness gate 顶多省掉「一条廉价 SELECT + worker 醒一拍」，救不下任何 LLM 成本——LLM 成本早就被「有没有 NULL 活」这个天然闸门 gate 住了。

**卖点 B「按依赖新鲜度正确排序」≈ 无。** job 间顺序是**静态拓扑序**不是 staleness 序：item_prior 04:20 → recalibration 04:50 → answer_class 05:00 → kt_estimate 05:10 → reference 05:20 → compose 05:30 → supply 06:00，每条 cron 注释显式写明「排在 X 之后让 Y 信号新鲜」。这个 DAG 由**数据依赖**固定（先验永远必须先于选题），陈旧度高低不会重排它。staleness planner 对一个拓扑固定的链没有排序增益。

**卖点隐含的「防 job-spam」也已在正确层解决**：question_supply 依赖 dispatcher 的 7d fingerprint cooldown（`recentDispatchExists`）+ per-run cap（question_supply_nightly.ts:11-56），confusable_contrast 同样有 per-run cap。中央 planner 是把已在 job 层的成本护栏重复一遍。

减去「幂等 no-op + 每 job cooldown/cap + 静态拓扑」之后，剩下的实质只有：把 ~20 条手算错峰分钟（受 YUK-383 collision unit test 守）合成一个声明式依赖序 runner。**那是一次确定性重构，不是「AI 值班调度」**——一旦抽掉 LLM 决策者，它就不是这条想法了。而想法的整个 framing 是「议程高：AI 拿是否/何时/次序触发权」，这个 AI 决策对一个基本确定性的问题（有 NULL 缺口就跑；按固定 DAG 排）只增成本/复杂度/dark-lane 风险。

**⑤ dark-lane 风险高**：这是一层盖在「已自 gate 的 job」之上的 meta-orchestration，单用户产品里典型的建成不通电候选。**⑥ day-zero 分类也错**：决策输入全是运营史（昨日 attempt 量、昨夜花费、近期成败率），day-zero 时 event/cost_ledger/ai_task_runs 皆空，planner 无信号可决策只能 fallback 全跑——真正解锁在 data-flywheel，不是 day-zero。
- **探索温度控制器：自适应 softmax T**：三条独立致命线，任一足以击杀：

(1) 直接违背一条已明文拍板的设计决策。ADR-0042:60 确实称温度为「唯一 tunable trade-off」——但同一行 + selection-sampler.ts:64 的常量注释把 firm-up 路径钉死为「只经 deferred T×ε replay harness（owner-gated，NG3）从真数据重调，绝不二次拍脑袋」，并明列「n=1 红线：不从数据拟合」。本想法「AI 按 θ̂ 精度/数据密度每会话提议 T」正是 spec 明令禁止的「二次拍脑袋 / 从数据拟合」，只是把拍脑袋外包给 per-session LLM。它不是新缝，是 spec 已经关掉的门。

(2) 机制与价值自相矛盾——T 是单一全局 batch 标量。价值主张「冷/薄 KC 抬温多探索、成熟 KC 降温多利用」要求 per-KC/per-candidate 行为，但一个会话的流混合了不同 precision 的多个 KC，单个 T 无法同时对冷 KC 探索、对成熟 KC 利用——抬温会摊平全部候选而非只摊平冷的。而它想要的 per-candidate 探索三条既有缝已经在做：KLP 打分对低-precision θ̂ 逐候选降权（selection-signals.ts:9-10，注释明写「只在冷启段 precision 低时显著」）、ε-greedy 下限（SAMPLING_EPSILON）、以及 LLM 编排层本就逐候选收到 θ_se/precision 可自行摊平权重。这个全局标量既冗余又比三者都粗。

(3) 不可验证的 dark lane（本项目已知失效模式）。recalibration / PPI power-tuning 在 ADR-0042:60 明确 deferred——没有任何在线反馈回路能证明 adaptive-T 优于静态 0.25。要建这个度量，就得先建正是被 defer 的 NG3 replay harness。等于上线一个零度量的 AI 旋钮，且 n=1 让 per-session precision/density 信号本身极噪。
- **分诊探针预算官：自适应 placement 深度**：三重致命，且互相叠加：

(1) 核心前提「探针平摊、需要 AI 分配预算」是对活代码的误读。placement-select.ts 的选题早已不是平摊——它把候选交给 LIVE collectCandidateSignals，用生产 KLP/MFI（最大信息量）选下一题（select.ts:5-10）。max-information 选题按定义就会把题量集中到最不确定的 KC。所谓「把预算分给模糊 KC 而非平摊」的问题在活路径上基本不存在，AI 再设一层 per-KC 预算的边际价值极薄。而且 seThreshold「收够即停」的早停已 live 且 per-run 可传参（placement-next.ts:47,140）——「自适应深度」这条命题里能落地的部分已经落地了。

(2) 三个 data_inputs 有两个不存在、一个是暗管。① 「KC 先验难度锚 b」——schema.ts:114 ADR-0035 SOFT track 明写 knowledge 表 NO b/difficulty 列；difficulty 只在 question 级（schema:301, 1-5）。propagate-priors.ts:16-22 明说 day-one b=0 对每个 KC，KC 级难度锚是 deferred future refinement。所以「按每 KC 先验难度不确定度」这个分配轴的数据方差在 day-zero 恒为零。② 「propagate-priors 结果」是 dark-ship：DAY_ONE_PRIOR_ENABLED=false（theta-grid.ts:84）+ 生产无 native .node binding（propagate-priors.ts:68-92，loadDayOnePriors 在 prod 恒返回 null NO-OP）。在一个 flag-off + 无 prod binding 的暗管上建预算官 = 复合 dark lane，正是本项目已知失效模式。③ 「先验熵」无任何地方 surface——loadDayOnePriors 只抽 mean_mastery + weakest-prereq，熵要新造，且因 b=θ=0 只反映 prereq-DAG 拓扑深度，不是校准出的不确定度。

(3) 单用户一次性事件，价值自愈。冷启 placement 每科只跑一次，用户答 ≤8 题一次；θ̂/FSRS/PFA 在随后几天真实练习中收敛，无论首轮 8 题怎么分配，「分配不优」在几天内自我修正。为单人自用产品的一次性 8 题分配投 M 工作量，ROI 属最弱一档。
- **练习流桶预算规划器：活动类型 mix 自适应**：这条想法的核心前提——「stream-composer 的固定 1:2 死交织是当前活行为，且 coach 只管学哪个知识、没人管四桶结构比例」——经 code-ground 是**误读**，攻击的是一条 fallback 路径，不是活路径。三点实锤：

(1) `(i+1)%2===0` 固定交织确实存在于 `composeDailyStream`（stream-composer.ts:83），但它是 **legacy/fallback 路径**，不是默认。`selection-constants.ts:36` `DEFAULT_SELECTION_POLICY='softmax_mfi'`（owner 2026-06-16 default-ON）。活路径是 `composeSoftmaxStream`（softmax-selection.ts），composeDailyStream 只在 `SELECTION_POLICY=legacy` 或 L2 catastrophic fallback 时命中。所以想法要「取代」的死交织在生产里根本不跑——针对它建 AI 提议层 = 造一条喂 fallback 的 dark lane（本项目已知失效模式）。

(2) 想法声称的「复习vs新学vs变式vs前沿结构比例」空档**已被 YUK-361 填上**。活路径把 variant+new_check+frontier **合池**成一个 sampler pool（softmax-selection.ts:307 `nonDueRaws=[...variantRaws,...newCheckRaws,...frontierRaws]`），经 **L2 LLM orchestrator 逐候选出权重+排布序**（tryLlmOrchestration → sampleByWeight），四桶 mix 是采样涌现、不是固定比例。这正是「AI 决定复习/新学/变式/前沿如何配比」——想法提的正是已通电的机制的粗粒度换皮。

(3) value prop「复习堆积日多给 due」**误解了系统**：due 是 backbone presence（softmax-selection.ts:277-291，ALL due hard-present，ND-5），不受任何比例控制——due 由 FSRS 定，不能「多给」。「前沿爆发日多给新学」也已由 sampler 池竞争 + `FRONTIER_QUOTA_RATIO=0.2` 保底（softmax-selection.ts:98，显式标 YUK-349 #3）自然发生。
- **选题信号点灯官：per-learner 信号激活议程**：这条想法建在一个对单用户产品无效的前提上，且把「一个布尔 flag 的收尾 go-live + 一个 N+1 batch 修复」包装成「AI per-learner 信号激活议程」子系统，违反 CLAUDE.md「smallest sufficient solution」并且是本项目已知失效模式「建成不通电」的教科书样本。逐条：

① 前提造假——「per-learner」在单用户工具里不存在。candidate-signals.ts:229-231 明写：mistake_variant / question / mastery_state 全无 user_id 列，「每条行就是 THIS learner 自己的」；代码里的 "per-learner" = SELF-STATE（这一个学习者对自己），不是人群维度。value 里「数据厚的学习者早享…数据薄的不被误导」是横跨多学习者的框架——本产品只有一个学习者，这种差异根本不存在。

② 可操作面只有 1 个布尔 flag，不是「信号集」。§9.2 三个 first-class 选题信号里，只有 misconceptionRecurrence 有 cheap reader + flag。另外两个（examRelevance / transferGap）不是 flag-gated——它们恒 undefined 是因为「无数据源」（SubjectProfileSchema 无 examWeight/syllabus 字段；mastery_state 无 kind 维度），要「点亮」得先建全新子系统（考纲权重表 / per-(KC,kind) 掌握度），没有 flag 可翻。所以 AI 的「信号激活决策权」实际只能作用于一个已存在的 boolean，「信号集随数据演化」的宏大叙事坍缩成「要不要给这一个信号翻 flag」。

③「数据薄不被噪声误导」的价值已由现有设计免费交付。信号是 NEVER-zero-fill：无数据恒返回 undefined，评分层据此 MFI-only 退化（candidate-signals.ts:272-277, 324-327）。无论 flag 开关，数据薄的学习者都不会被噪声信号误导——这是 by construction，不需要任何 AI 议程层。

④ 真正的 go-live 阻塞是机械的 N+1 batch 修复，不是议程决策。candidate-signals.ts:408-413 有显式 TODO：翻 flag 前必须把 aggregateMisconceptionRecurrence 从 per-candidate 串行聚合读改成批量。这想法把 go-live 当作零成本议程决定。

⑤ 冗余控制层。信号 ON 时本来就只进 orchestrator prompt，orchestrator LLM 本来就自己决定怎么加权（selection-orchestrator 消费点）。在一个「已经拿到信号并自己加权」的 LLM 之上再加一层「AI 决定要不要让 LLM 看到这个信号」是纯冗余——最简方案是：batch 后永久翻 ON，让 undefined + orchestrator 既有加权处理数据稀薄，不需要新议程子系统。
- **前沿释放阈值调优师：mastery gate 自校准**：三条独立致命伤，任一即可击杀。(1) 核心机制打错杠杆：owner 在 YUK-551 spec docblock（learnable-frontier.ts 顶部）已明文裁定「置信度住在 band + FRONTIER_MASTERY_MIN_EVIDENCE，不在抬高 p(L) 阈值上」，并称『0.7 向 0.95 靠拢』在构念上 malformed——p(L) 是 σ(PFA logit) 的召回点估计，非 BKT 后验，惯例阈值 off-scale。本 idea 恰恰把 p(L) 阈值当自适应杠杆，正是被文档判为构念错误的动作；且 YUK-539 已 ship 复合判据（p(L)≥0.7 AND evidence≥4），自适应性已被有意放进 evidence floor。(2) 识别不能：固定 0.7 释放策略下永远观测不到 0.6/0.8 释放 KC 的下游结果，零阈值变异 → 「0.7 释放的后来翻车吗」的 dose-response 信号在数学上 unidentifiable，AI 是在单点上拟合曲线；idea 未提出探索/随机化臂。(3) data-starved dark lane：INVARIANT BLOCK 明载今日 frontier 因 sparse graph（无 prerequisite 边）byte-identically 为空，根本还没有释放发生；「per-domain」阈值又预设多 domain 各有足够释放 KC + 下游首练，对单用户 wenyan Phase-1 是幻想级数据量。L effort 换单用户省几道题，不值。
- **误区门诊：会诊纪要与处方（Remediation Dossier）**：这条把「data-flywheel」标签用错了：它不是等事件积累就自动通电，而是要先点亮三个 code-dark 前置——(1) misconception 晋升 active 走 MISCONCEPTION_PROMOTE_ENABLED 暗 flag（默认 OFF）+ 人工 accept 双门，单用户下 active 误区总体≈0；(2) confusable_with 边根本没有 live writer（misconception-confusable-read.ts 白纸黑字「Day-one genuinely EMPTY: no live writer mints confusable_with edges yet」，misconception_edge schema 注「DORMANT until PR-3 promotion writer lands」）；(3) confusable_contrast_nightly 挂 CONFUSABLE_CONTRAST_ENABLED 暗 flag、默认 NO-OP。即：这是给一个「病人群不存在、且产生病人的代码路径尚未接线」的空表，再叠一条新 nightly 会诊 cron + 处方 artifact + 派题——正中本项目已知失效模式「建成不通电」的 dark lane，且是 dark-on-dark 叠三层。前置是工程活不是数据活，horizon 标注失真。治疗动作面（对照题→练习流）YUK-533 已建（只是 dark），本条的真实增量仅剩一个 LLM 处方/纪要 artifact，且与 YUK-560 例会 deep-dive 侦察兵、YUK-531 probe-loop 同型。对单用户自用产品，为长期近乎空的 active 误区表养第 21 条夜间 cron，投入产出不成立。
- **月度学情通报：家书体叙事报告**：三重致命叠加，无最小可存活切片。(1) 引擎已存在——`memory_brief_note`(schema.ts:456) 由 Station 2A brief-writer(brief.ts:112 / registry.ts:661) 已经生产 recent_week/recent_months/long_term 三窗口叙事 markdown + evidence_ids，并且已经被 surface（query_memory_brief copilot 工具 + today copilot-summary 的 brief_global_md 首段）。本条把这个既有投影列为 data_input，本质是把「已生成、已surface的叙事」重新叙事一遍换个家书皮，不是新能力。(2) 招牌价值是虚构的——n=1 单用户产品里 owner=learner=唯一利益相关人，「写给家长/对外交代/家长会材料」这个 differentiator 没有真实对象，纯角色扮演；剥掉这层只剩「月度回望」，而回望原料 owner 已能通过 memory brief 读到。(3) dark-lane by construction——idea 自己写明「归档可回看而非进 inbox 裁决队列」，即无路由、无动作、无裁决；coach TodayPlan 被消费是因为它驱动行动，一个不进任何队列、纯归档的叙事文档正是本项目已知「建成不通电」失效模式的教科书样本，且它复述的数据流已被别处消费。
- **集体备课：单元教案编写（Unit Lesson-Plan）**：The idea's central value claim — that the "把一串 KC 编成教学流" layer is missing — is materially false. src/server/orchestrator/learning_intent.ts already materializes note_hub + N note_atomic + N note_long from a multi-KC LLM outline over the knowledge graph, persists it as a propose event through the agency inbox, and enqueues the N note_generate jobs on owner-accept. It is live-wired (proposal-appliers.ts / inbox.ts / actions.ts). So the pitched capability substantially exists as a user-triggerable path. The genuinely-new increment (prerequisite-topological ordering + autonomy over the frontier) is data-blocked into a dark lane: learnable-frontier.ts documents the graph is sparse today ("few/no relation_type='prerequisite' rows" → frontier returns sparse/[]), and frontier_fill_nightly exists only to PROPOSE temp prereq edges (weight 0.4) that the owner must accept before any frontier unit becomes readable. An autonomous 集体备课 job peered off frontier_fill would no-op indefinitely = the project's known 建成不通电 failure mode. After removing the false premise and the empty-frontier autonomy, the residue is a prompt/ordering tweak to the existing learning_intent path (prereq-aware atomic ordering + gradient examples in NoteGenerateTask), which is neither L-effort nor a new manifest job. For a single-user tool that can already trigger learning_intent on demand, the L investment is unjustified.
- **陪练教练：流畅度幻觉抽考**：三刀叠加致命。① feasibility_hook 语义误读：fluency_illusion_flag 不是「有 schema 位无生产写者」的无主孤儿，而是被明确预留给 B1 Wave2 A2 复盘判定的 roadmapped slot（schema.ts:963 注释 +allowlist kind:manual, expected_by 2026-09-30，与 sibling calibration_residual 配对为「fixed-anchor 慢热校准残差/锚校准路径才写」）。设计意图的置位触发是校准残差/复盘路径，不是「换情境迁移抖招题答错」。本想法要抢注这一列并重定义其触发语义，会与既定 A2 设计正面撞车——「首个 caller」是抢占别人 roadmap 的坑，不是填空白。② dark-lane-by-construction：全仓 fluency_illusion_flag 零 reader（已 grep 证实）。想法只造 writer，「送复盘」的消费面根本不存在——置一个没人读的 boolean = 本项目头号失效模式「建成不通电」的教科书案例。真正的价值（迁移探针+复盘时刻）压根不需要这个 flag。③ backlog 换皮（想法未自辩的那条）：conjecture/probe 引擎已通电（probe-lifecycle.ts，trigger→probe→predicted_p→Brier）。「预测 owner 会在自以为流畅的 KC 上栽迁移变式」本质就是一条特化 conjecture，落进已有 predicted_p/prediction_score 机制即可。想法只防了 applied_in 迁移探针碰撞，漏了更大的 conjecture 引擎重叠。剥掉 flag 抢注这层，残值退化成「给 FSRS 到期项插迁移变式」，与它自认同族的 applied_in 探针 + question_supply 选题家族无法区分，没有大到值得开新 job 的未占价值切片。
- **Prompt 冠军-挑战者影子 A/B（提示词自进化）**：五点合力击杀，任一都足以重伤：

(1) 归因键误读——致命。声称「ai_task_runs.input_hash（变体归因键）」是错的。读 src/server/ai/runner.ts:250 `inputHash()`：它是对 task 输入内容的 sha256（`createHash('sha256').update(JSON.stringify(stableInputForHash(input)))`），编码的是「喂了什么输入」，不是「用了哪版 prompt」。ai_task_runs（schema.ts:611-631）根本没有 prompt_version 列。要做变体归因必须新加列，接缝不是现成的——它甚至语义相反（input_hash 相同=输入相同，恰好能配对 A/B，但绝不是变体标签）。

(2) 下游信号→变体的 join 路径不存在。proposal_signals（schema.ts:903-921）是按 (kind, cooldown_key) 的 in-place 聚合计数器，没有 task_run_id、没有 per-proposal provenance。你无法把一次 accept/dismiss 归因到「哪版挑战者 prompt 产出了它」。「用下游真实质量信号打分」的整个前提缺一条 join 边——需要新建 per-proposal 溯源（走 event.task_run_id 可挂但要造），非现成。

(3) 单用户流量 = 统计 A/B 天然欠功效——本项目已知 dark-lane 失效模式的教科书案例。冠军-挑战者要宣布优胜需 per-task_kind 达统计显著。共 40 个 task_kind（task-prompts.ts case 计数），单用户产生的是涓流；多数 kind（GoalScope/LearningIntentOutline 等）一生跑个位数次，accept/dismiss 更稀（要 owner 真去接受/驳回）。「证据够了晋升」这道 gate 实际上永不 fire。这正是 CONTEXT 明列的「建成不通电」。

(4) 价值对单用户边际。owner 既是 prompt 作者又是唯一用户又是工程师——手改 prompt 几分钟、手动对比信号远比数月欠功效自动 loop 密。「不必凭直觉改词」站不住：owner 手 A/B 的信号量级碾压这条 loop。且 shadow 双跑在采样流量上翻倍推理成本，对自托管单用户订阅预算是差 ROI。

(5) 「every task_kind 挂挑战者」过度扩张：40 个 kind 里只有极少数（judge 类、propose 类）有自动化 outcome 信号；note-gen/tagging/structure/vision-extract 等无 accept/dismiss、无 judge，质量只能人工复审——恰是 owner 不愿做的事。
- **分歧驱动的 judge 升舱路由**：三条 data_inputs 里两条是虚构的，机制的一半凭空造出，价值面对单用户不成立，且高度符合本项目已知的「建成不通电」失效模式。逐条：

【① feasibility_hook 半真半误读】
- rejudge.ts 真实存在，但它的 correction 事件**只由用户手动申诉触发**（`experimental:appeal_request` → handleRejudge）。不是系统性采样，而是「单用户碰巧注意到并愿意申诉」的稀疏、有偏事件。想拿它算 per-(capability×题型) 分歧率，样本量对单用户接近于零且严重选择偏倚。
- vision-judge-config.ts 真实存在，但被**严重误读**为「per-judge 舱位覆盖接缝」。它其实是**进程级全局 env flag**（`VISION_JUDGE_PROVIDER`），两个调用点都是裸调 `visionJudgeProviderOverride()`（无参、读 process.env），**不接收任何 per-request/per-题型/per-capability 上下文**。而且它只覆盖两个 vision judge（multimodal_direct + steps），不是 idea 暗示的全 judge 面。要做「高分歧格子动态路由」需从零建一整套按请求上下文分派的路由层——这个接缝不是「覆盖」，是「不存在」。
- judges/index.ts 的 `judgeRouterV2` **按 kind 解析并只跑一个 judge，没有任何 ensemble/双 judge/集成 verdict**。grep 全仓无 ensemble 判分基建。所以「多 judge 集成分歧」这个 data source 是**编造的**——它是 YUK-573 要新建的东西，而 YUK-573 在代码里零引用（未落地）。

【③ backlog 换皮】idea 自己承认依赖 YUK-573（观测层）先落地。但「从测到 act」的增量对单用户几乎不产生额外价值（见下），本质是给一个尚未存在的观测层预支一个昂贵消费层。

【④ 价值不成立】单用户产品，判分总量极小。若判分可靠性重要，最小充分解（CLAUDE.md 明确的工程原则）就是**直接全局 `VISION_JUDGE_PROVIDER=anthropic-sub` 把所有 vision 判分升到 Opus**——这个全局杠杆已经建好、dark-ship 就绪，单用户的成本增量微不足道。per-cell 分歧驱动路由是对一个判分量极小的单用户的严重过度工程。

【⑥ 数据前置被低估 + 循环依赖】标 data-flywheel 但飞轮需要两个都不成立的前置：(a) 足够的申诉量（单用户罕见）；(b) 双 judge 采样基建（未建，且**恰恰是本 idea 要省的那笔算力**）。要知道哪些格子高分歧，得先广泛双判（贵）——等你测出来，钱已经花完了，路由无从省起。经典循环。

【② 红线】确实没碰结算直写——这一条不构成击杀，但不足以抵消上述。
- **主动自查重判 → judge_retraction 提案**：这条想法的核心机制建立在对接缝的语义误读上，且复活了一条团队刻意废弃的死路。

三点致命伤：

(1) 「结论翻转则产出 judge_retraction 提案」是死卡路径，不是活的 propose-only lane。judge_retraction kind 确实在 manifest.ts:376 声明存在，但它是 **tier-C 无 accept applier** 的 proposal——accept 走 dispatch 壳 default throw `unsupported_proposal_kind 400`（YUK-44 收口），inbox 里渲染成「纯状态…折叠链到 AI 观察面」的只读观察卡，owner 根本无法对它采取行动（inbox-api.ts:48、proposal.ts:84、manifest.ts:365 注释均明证）。producer `writeJudgeRetractionProposal` 本身标了 `@deprecated`「本函数已无生产调用方」（producers.ts:409）。所以想法的产物是一张点不动的死卡——这正是本项目已知的「建成不通电 dark lane」失效模式的教科书案例。

(2) 红线论证是反的。想法声称「刻意不复用申诉的自动生效路径」以避免 AI 自纠间接扰动 θ̂。但 D15/YUK-316 恰恰做了相反决策并已落地：判分属软判断层 → rejudge 结果**直接生效**（correction event 留痕，无 proposal），且 θ̂ 安全性已由 rejudge.ts 里精心工程化的机制托管——双触发门（judgeDriven && bitFlip）、revert-only（只撤 θ̂ 不碰 FSRS）、第二实例原则、reproject marker（rejudge.ts:15-20、164-247）。FSRS 段刻意不重写（评级是用户确认动作）。「AI 自 rejudge 会扰动 θ̂」这个被声称的危险，结算层安全架构早已解决，而且解法明确不是 proposal。用 propose-only 包装非但不加安全，反而是把已废弃的死路重新捡回来。

(3) 可救的残余极薄且撞 YUK-573。剥掉错误的 proposal 包装后，剩下的只是「夜间抽样低置信/分歧判分 → enqueue 既有 rejudge job」——一层跑在 rejudge.ts 之上的采样 cron。而 573（双 judge 采样）本就是分歧发现机制，抽样出分歧判分喂 rejudge 是它的自然延伸，行动层不构成独立价值。
- **猜想记分牌 → 提案者信任分层（inbox salience）**：中心机制「按提案来源/cause 家族聚合成信任分层」在代码里无支撑：prediction_score 只对 conjecture 产生，且全部由单一 nightly job（reconcile.ts RECONCILE_ACTOR='research_meeting'）写出——没有第二个提案来源可比较；conjecture 的 proposed_change（ConjectureFactsSchema）也没有 cause_category 列可分组。因此「按来源/家族聚合」塌缩成一个全局标量，卖点「谁的提案更值得先看」在只有一个『谁』时消失。其次，idea 要消费的 Brier-vs-baseline 窗口聚合被 ADR-0046 显式 defer 给 Rust kernel（scoring.ts:15 / reconcile.ts:5,18-20 白纸黑字：单点 skillScorePoint「degenerate」，窗口聚合 Rust-owned+deferred），所以 backlog_collision:none 是假的——它 front-run 了被刻意围栏的 calibration-native。第三，n=1 owner-paced 答 probe、≤3 并发、nightly，scored 样本极稀（reconcile.ts:132-135 自称 unscored 集『naturally tiny』），信任信号长期是噪声，典型 dark-lane。红线本身不违（仅动排序不翻 label），但中心机制不可行。
- **提案者产物 golden 回归网**：feasibility_hook 的接缝在语义上被误读，核心机制不可迁移。YUK-548 的 golden 机制（capture-golden.ts / golden-reaudit.ts 实读确认）只有一件事：把冻结的 event log 用当前的 PURE DETERMINISTIC reducer（foldGoal/foldKnowledgeNode…）重新 fold，再用 diffSnapshots 做 EXACT-EQUALITY 比对。它的全部价值来自「同 events 过同 reducer = 逐字节相同输出」这个确定性——所以任何 diff 必然是 reducer 代码变更，非重解释。AI 提案器是随机 LLM 调用（Claude Agent SDK / mimo-v2.5），同输入同 prompt 重放每次产物都不同。把它塞进「replay + diff」= 每次运行都误报 DRIFT——正是 capture-golden.ts:145 注释里明确要避免的「dirty baseline that false-DRIFTs forever」失效模式。要让 diff 有意义必须把 exact-equality 换成语义 judge，那一刻你就在建 judge-golden set，即 YUK-573 的靶，而非与之互补。故「proposer 轴 vs judge 轴、非换皮」这个立论坍塌：比对提案器产物本身就 REQUIRES a judge。dark-lane 风险高：首跑就因非确定性满屏假 DRIFT，owner 立刻失信，lane 腐烂；且每次 prompt 变更要付 LLM 重放成本，而单用户改自己 prompt 的频率极低。ai_task_runs.input_hash 是 hash（schema.ts:618）非可重放的原始输入，声称的复用度进一步缩水。
- **生成后裁判：预发布批评门**：该想法的核心——「提案落库前插一道预发布质量闸，把劣质提案挡在 owner 注意力之外」——已由 SHIPPED 代码实现，且实现方式恰好否定了本想法的架构选择：(1) L1 确定性 rubric floor `validateProposalQuality`（src/capabilities/knowledge/server/rubric-validator.ts:417）已在 propose_edge.ts / proposal-tools.ts 写路径上于入 inbox 前 gate 提案，失败进 rubric_rejected 桶；(2) L2 adaptive-bias（YUK-174, src/server/proposals/adaptive-bias.ts）已把 accept/dismiss 历史 + rubric 失败回灌进 proposer prompt 做生成时 in-context 自纠（正是本想法号称新增的「两遍式自审」，但做成一遍改进而非浪费的第二次 critic 调用），并按 acceptance_rate 收紧 L1 gate。L2 的核心不变式明写「additive only, never suppresses L1 … tighten-only / never-lock」——项目已刻意选择确定性地板而非 LLM 否决，正是为规避本想法重开的能动性问题。因此 backlog_collision:none 是错的，它与已上线代码硬撞。价值层面对单用户自负矛盾：为守 propose-only 红线，kill 必须留痕进可回看的自驳回桶→owner 从审一个桶变审两个桶→零注意力节省（价值命题自灭）；若不审→对 surfacing 成本仅约 2 秒的学习产品，静默 LLM 软否决会杀掉好提案，弊大于利。声称 day-zero 亦被高估：LLM critic 相对已有免费确定性 L1 的边际价值来自 dismiss 模式学习（需数据、且 L2 已消费），冷启动时只是复述 proposer 自身 rubric 指令的裸 LLM 意见，每晚跑徒增成本/延迟，是项目已知「建成不通电」dark-lane 的典型候选。
- **晨间任务选单：选题议程权下放给学习者**：四刀叠加击穿：① 命名接缝语义误读——feasibility_hook 把 selection_observation 当「学习者选择回流的监督信号」，但读 schema.ts:1651-1689 + 存量注释，该表是 D17 active-PPI **off-policy 倾向性遥测**：`policy`/`selected`/`inclusion_probability(π_i)` 记的是 softmax_mfi **抽样器**对候选的纳入概率（IPPS 重标定慢热资产），`selected`=抽样器是否抽中，不是「人从 N 张卡里挑了哪张」。表里根本没有「N 选一的人类选择」字段。把它当人类议程选择的回流面 = 对承重 telemetry 的语义盗用，会污染重标定回放。② 该 lane 本身已是项目已知 dark lane——注释明写「零选题行为变更／不接进 composeDailyStream，行为变更是 Phase 3」，2+ phase 未通电；再往上叠一条「选择反哺策略」而**不指名下游 consumer/谁重训选题策略** = 教科书式「建成不通电」，正中项目已知失效模式。③ 数据前置被低估：单用户一天挑一张，≈365 label/年，作为选题策略监督信号统计上无望，data-flywheel 价值被严重高估。④ 「选择回流成监督信号」与已存在的 proposal_signals（schema.ts:903，已记 owner accept/dismiss + acceptance_rate + cooldown）实质重叠，是换皮而非新增。剩下唯一能扛住攻击的内核（早间多卡 N 选一 UI）恰好塌进 YUK-505 规划 panel，且其价值命题（对抗被动喂流疲劳／agency）是 MathAcademy 面向抗拒型 K-12 学生的动机工程，不迁移到「亲手造这套导师系统」的单一内驱 power-user。
- **失败即补：前置知识的即时补救插页**：核心卖点「复用既有作答后增量重排层插项，只改触发时机」是对 seam 的语义误读，一经戳破想法就失去身份。实读 stream-store.ts:908 的 reRankAfterAnswer：(1) 它只 churn **同一 KC**（answeredQuestionId 的 knowledge_ids）内的 θ̂-诊断项，source 严格限 variant/new_check；(2) 代码注释显式声明 frontier/结构可达性项在 θ̂ 移动下**冻结、不换**（940-941 行「reRank 只 churn θ̂-诊断项…placed frontier item 冻结」）——而「前置复习题」正是被设计冻结的那类结构 slot；(3) 它读 mastery_state 取的是**新鲜 θ̂**（collectCandidateSignals），既不读 p(L)、也不遍历 knowledge_edge(prerequisite)；(4) 触发点（745-749 行）是 `status==='done'` 无条件触发，**根本不 branch on outcome=failure**，且仅 softmax_mfi policy 下才跑。所以想法要的是「失败条件 + 跨 KC + 遍历 prereq 边 + 读 prereq p(L) + 插入被冻结的结构项」——这是一条与多条 load-bearing 不变量正面冲突的**全新机制**，代码里明写「改一侧前先读此注释，勿修好一边破了不变量」，不是「只改触发时机」。此外「于重试前即时插入」的时机在系统里**无落点**：练习流没有即时重试交互模型，reRank 是 post-commit 后 churn 待做尾巴，失败题已 done，不存在「重试 slot」让前置复习插在其前。红线未破（propose-only），但价值经不起推敲：prereq gap→复习 prereq 的路径**已由 frontier/topology gate 承担**（learnable-frontier.ts 沿 prereq 边算「前置全掌握」再 compose frontier 项），本想法只是把它提前到失败当下、失败触发——对单用户每日练习者，「隔夜重排」与「失败现场」的差是边际的（前置漏洞会在次日 frontier-composed 流里出现），却要为此对抗守卫森严的 seam。
- **校准换注意力预算：conjecture Brier 调节探针频率**：The idea's load-bearing signal — a per-KC/域 CALIBRATION measure — does not exist and is explicitly deferred. scoring.ts is a PLACEHOLDER stub emitting SINGLE-POINT Brier only; the window-aggregate "beats baseline" calibration is Rust-owned + deferred (ADR-0046, crate not built), and conjecture-scores.ts hard-declares score_basis:'single_point' precisely so no consumer mistakes it for calibration. You cannot judge "某 KC 已良好校准" from single-point Brier — calibration is an aggregate property that the codebase deliberately does not compute. Compounding this: the signal is data-starved for a single user. Scored probes require nightly induction → owner ACCEPTS conjecture → owner ANSWERS probe → reconcile scores it — an owner-gated trickle of a handful/week spread across many KCs; per-KC calibration would take months-to-years to be meaningful even if the aggregate math existed. This is a textbook match for the project's known "建成不通电" dark-lane failure mode: a budget knob wired to a dial with no needle. Finally the mechanism overstates autonomy — probes are owner-gated and already hard-capped (MAX_CONCURRENT_ACTIVE_PROBES=3, RESEARCH_MEETING_MAX_CONJECTURES=3); the only real tunable is gatherConjectureEvidence's salience sort, collapsing the grand "校准换注意力预算" framing into a marginal "also weight prior surprise" tweak that overlaps YUK-572's agenda-power layering.
- **A 档自愈式自动撤销（反证即回滚）**：红线未破（completion auto-apply 只迁移 learning_item.status，不写 θ̂/FSRS/mastery 结算账本；retract 只归档 item；触发器是确定性事件、LLM 不在回路），feasibility 主干接缝也真实存在——所以不是靠红线或“接缝不存在”击杀。击杀点在价值与语义前提同时坍塌：

1) 两个“硬反证”触发器都不成立。(a)「item 被人工重开」= owner 已经动手了，人工 reopen 本身就是那次人类干预；事后自动 retract 该 proposal 只是记账，交付不了“无需人点撤销”的核心价值。(b)「同 KC 下次 attempt 判错」是把噪声信号误标为“硬反证”——结算层（PFA/FSRS）存在的全部意义就是平滑单次失手；一次做错并不证伪“可完成”，据此自动回滚会 thrash（complete→错一题→auto-retract→再 complete）。这直接证伪了 one-liner 的旗舰主张“净风险单调下降”：auto-retract 引入了自己的误撤/抖动风险。

2) novel 触发器的数据前置被低估。answer 表 learning_item_id 为 nullable 且“unused/DEFER per Map §B3”（schema.ts:566-570），attempt 只挂 question_id。要把完成后的错题反查回被完成 item 的 KC，需要现搭 attempt→question→KC→learning_item 映射——不是 data-flywheel 靠积累解锁，而是一段未建的连接工程，被 data_inputs 一句“attempt/判定事件流”糊过去。

3) 对单用户自用产品价值不匹配。A 档是 experimental、breaker 硬顶 30、单用户真实并发极低——撤销窗内又被硬反证命中的样本是“少之又少的零头”；而手动撤销入口已存在（读模型已 surface reverted 态，A 档卡本就有撤销 CTA）。为了自动化掉一个近零频、已有手动兜底的动作，去跨 anti-swarm 红线新增“agent 主动回滚”动作面，是典型的成本/风险 > 收益，且极易变成又一条“建成不通电”的 dark lane（触发器要新挂一个 attempt 事件消费者去盯窗内完成项，A 档 firing 量却极低）。

剥掉两个 failing 触发器后不剩任何 agentic 内核，只剩 reopen 时的一点 provenance 记账——那已不是这条想法的本体。核心不 hold，故 KILL 而非 KEEP_WEAKENED。
- **copilot note_update 升 A 档（proposal 侧接线）**：三处致命误读，任一即足以击杀：

1) **「copilot 亲写的 note_update 提案」不存在。** 全仓 `note_update` 唯一生产者是 `src/capabilities/notes/server/note-refine-proposals.ts:writeNoteRefineProposal`（`actor_ref: 'note_refine'`），由 note-refine nightly/trigger 管线调用。copilot 侧零 note 工具——`notes/manifest.ts` 不在 copilotTools 贡献名单里（只有 copilot/agency/knowledge/ingestion/practice 五包贡献工具，notes 不在内）。所以「copilot 亲写、仍 B、待接线」的那个对象根本不存在。dreaming_nightly.ts:359 对 note_update 是**消费**（读 pending 后 enqueue 一个 dreaming-kind refine），也不是 copilot 且仍走同一管线。

2) **note_update 提案是 A 档的溢出桶，不是「同一可逆性论证下的另一半」。** `runNoteRefine`（note-refine.ts:268-276）在写任何东西之前就裁 mutator（auto-apply）vs propose：`gate(summary)==='propose'（ops>3 或 new_blocks>2）|| patchTouchesVerifiedBlock` 才写 note_update 提案，reason_md 原文「超过 mutator v0 阈值，转入人工审批」。即：满足想法自定护栏（ops≤3 && new_blocks≤2 && !user_verified）的补丁**早已在 mutator 路径 auto-apply、根本不会变成 note_update 提案**。残留只有 breaker-tripped 的小补丁，而对它们 auto-apply 恰好击穿 YUK-358/ADR-0040 刻意造的反失控速率熔断。想法与它自己的护栏自相矛盾。

3) **强度档 flip ≠ auto-apply。** `aiProposalKindStrength` 是收件箱分桶视图轴（inbox-tier.ts）；A 档卡来自独立 auto-applied 读模型（`experimental:completion_autoapply` 事件），pending 的 A-strength 提案仍落 B 裁决块（inbox-tier.ts:8）。completion 的 auto-apply 是 proposal-tools.ts 里逐 kind 手写的内联物化（配 undo-event），不是通用「A→自动应用」机关。把 note_update 从 B 翻 A 几乎是 no-op，绝非「接线成本低」——真要从提案侧 auto-apply 得新造 copilot 生产者 + 内联 apply + 撤销事件，且重复 mutator 路径已做的事。
- **夜链清道夫：自动软归档从未晋级的陈旧草稿题**：三条独立的击杀线，任一足以 KILL，合起来是干净的 KILL：

1) 核心价值前提是**假的**（code-ground）。想法的价值论断是「draft 池随夜链单调膨胀，拖慢 supply/dedup 且污染统计」。但每一个下游消费者都已经用共享谓词 `notDraftPredicate`（`src/db/predicates.ts` = `draft_status IS NULL OR draft_status != 'draft'`）排除 draft：placement-select.ts:152、stream-store.ts:182/220、variant-rotation.ts:170/196、**target-discovery.ts:625（supply 的可用池计数，review FINDING #1 显式过滤 draft，注释「草稿不是可用 item，不该被当作已覆盖而压制 refill」）**。也就是说 draft 对 supply 饱和度计数、练习池、复习、FSRS 全部不可见 —— 「拖慢 supply/dedup、污染统计」在代码里不成立。draft 累积的唯一真实成本是原始表行数（单用户，微不足道）+ owner 审核面变长。

2) 机制**已经存在**，是换皮。`src/server/questions/write.ts:337 archiveQuestion` 已实现「软归档=重新置 draft_status='draft' + metadata.archived_at（可 un-archive）」，且刻意不引入 `draft_status='archived'` 新值。想法的「墓碑归档（un-archive 即撤销）」逐字就是这套既有 infra。

3) 与**刻意的产品设计对撞**。YUK-402 建了 owner manual gate `/drafts`（draft-review.ts），是一个 human-in-the-loop 审核面，owner 逐条 enable / force-enable / archive。自动软归档「超 N 天未 promote」的 draft = 在 owner 看到之前**静默清空他的审核队列**（archived_at 被 draft-review 查询排除）。想法把这个 feature-removal 反向包装成「库存维护从 owner 手里拿走」的好处 —— 恰恰违背 manual gate 的设计意图。
- **A 档扩权安全基建三件套：统一行动账本 + 分桶断路器 + 可逆性准入闸**：这是为「不存在的第二个 A 档 kind」预建的 speculative generality，正中本项目自己记录的「建成不通电 dark lane」失效模式。三条子件都真实存在（feasibility_hook 文件全对），但它们解决的痛点是「每加一个 A kind 要复制 completion 那套锚+读模型+撤销接线」——而 N=1：代码里 completion 是唯一 A 档 kind（proposal-tools.ts 注释「completion 是唯一 A 档 kind」），且全走 experimental:* 事件（未 live），backlog（YUK-573~577 + 572/560/505/506/531...）无任何 A 档扩权 issue，无第二 kind 在飞。DRY 抽象在 N=1、无 N>1 roadmap 时是 YAGNI：正确做法是等真有第二 A kind（如 edge auto-apply）落地时随那条 kind 的工作一起泛化，让基建 day-one 被真实流量压测——而不是先建三件护栏（per-kind 断路器拆桶、泛化账本、准入闸）等着没有流量的车道。对单用户自用产品，blast radius = owner 一人，误 apply 当场可见可手撤，M-L 投入买的是「未来多 kind 连坐冻结」这种当前物理上不可能发生的场景（只有一个桶里只有一个 kind）。断路器现状更暴露 mismatch：decide-breaker 数的是全局 event.action='rate'（裁决速率代理信号），根本不是 per-kind auto-apply 计数——「per-kind 窗+per-entity 硬顶」不是收紧现有桶，是重定义断路器测量对象，为多 kind 世界重写一个当前只服务粗粒度速率护栏的组件。
