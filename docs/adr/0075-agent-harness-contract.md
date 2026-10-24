---
status: accepted
---

# ADR-0075 — Agent harness 契约：工作单、边界契约、领域写入者、需求门控

**Status:** Accepted（设计方向，2026-10-18，含 owner 当日 19:48 三项决定与 20:20 协调线对照补充 §10）；**尚未实施**——本文是决策落档，不代表任何软件已实现；owner 已批决定与实际实现状态始终分开陈述。
**Decision source:** owner 2026-10-18「原地打转需要治本」「harness的优化是个系统工程，不是一个guard可解决。没人学习时后台自适应降频。你给的修复票治标不治本」；同日 19:48 原话「**两件都允许 空闲按推荐 主席层也现在做**」（设计稿 §9）；同日 20:20 协调线并入对照补充、20:23 owner 指示 auto-compact（设计稿 §10，含 owner 20:11「工具没做统一吗」、20:16 skills/MCP/按需加载、20:23「auto-compact 也要做，先看开源」）。**normative 真相源（仓库外绝对路径）**：`/Volumes/YukovalSBak/yukoval-projects/tlp-status/discussions/agent-harness-redesign.md`（SHA256 `3b82bd872f16bef1c3cd6111a7538983e0ca9158bc8f48f9761c31df4e820ef5`，622 行，代码基准 `origin/main` @ `9ce433fa2`）。**§9 与 §10 是最新决定，优先级高于正文中的推荐/推迟表述；§10 对 §2/§5 的修订以 §10 条文为准**（本文已消除相互矛盾的有效门槛）；本文与设计稿冲突处，以设计稿（含 §9、§10）为准。
**Tracking:** [YUK-1559](https://linear.app/yukoval-studios/issue/YUK-1559)（本文档落档）；受处置票据见「票据处置」。
**Related:** [ADR-0004](0004-pattern-c-two-type-agent-architecture.md)、[ADR-0039](0039-single-orchestrator-action-strength-tiers.md)（A/B/C 出手档）、[ADR-0053](0053-copilot-durable-subagent-mailbox.md)、[ADR-0056](0056-native-task-tool-result-into-live-parent.md)、[ADR-0065](0065-pi-execution-and-conversation-replay.md)、[ADR-0067](0067-teaching-team-whiteboard-and-event-meetings.md)（**Amendment 2026-10-18**，随本文生效）、[ADR-0069](0069-single-supply-agent.md)、[ADR-0072](0072-question-bank-agent-tools.md)；YUK-572 spec `docs/design/2026-07-06-yuk572-agent-meeting-lane-spec.md`；TT 草案（ADR-0067 指定的细节真相源）；工具面清单 `tlp-status/discussions/agent-tools-inventory.md`（INV）；运行审查证据 `tlp-status/review/loom-runs-20261018/`（summary / AR / IR / DJ / TB，本文证据缩写同设计稿）；工具对照 `tlp-status/review/harness-benchmark-20261018/`（tools-vs-notion-linear.md、harness-vs-codex-cli.md @ `8c076942`，§10 的依据；context-management-survey.md，§10.5 的依据与其 A1–A9 验收节）。

## 背景与问题：记账单位是「一次调用有没有返回」，不是「一件工作有没有交付」

过去 10 天（TEST 2026-10-07 至 10-18）的运行审查坐实：模型的**判断**大体是对的（KR 要合并重复子树、Dreaming 认出双胞胎、research_meeting 指出 S5 判错、Copilot 只要回答质量都不错），失败集中在判断**落地**这一段——工具不保证结果、循环不知道何时算做完、输出一不合格整批扔掉、发现的问题没有主人、调度只看时钟不看需求、指标只数运行次数（设计稿 §0、§1.2 否决项）。观察到的症状归于五个结构性根因加一个放大器（§1.3）：

| 根因 | 一句话 | 关键证据（设计稿 §1.3） |
|---|---|---|
| **C1** 边界契约是函数签名，不是模型能执行的契约 | 输入可为 `unknown`、错误是 zod 原文、幂等靠自觉、输出不合格整批拒、门槛没校准 | KR 748/748 失败（AR P1-2）；QuizGen 55% 批次作废（AR P1-5）；source_verify 误杀 68 题、离线复算 ≥53 应过（DJ §1.2）；同一学习意图接受两次长出 6 对双胞胎（IR F5） |
| **C2** 一次运行没有「工作单」 | 只声明上限，不声明目标、交付物、完成条件、进展口径；结局只有自停或撞上限被杀 | KR 同错重复 591 次；Sourcing 172 M token 只出 21 题（TB §4.2）；`success` 只表示「模型返回了」 |
| **C3** 每个 agent 自己拼局部世界，每个领域多个写入者 | 无共享版本化全局快照，无「一个领域一个写入者」规则 | 新知识点挂根（IR F5b）；六个结构提议生产者互相看不见（IR F5）；记忆吃系统流水线（DJ F1） |
| **C4** 发现没有主人、没有状态、没有执行者 | agent note 是软提示：不去重、无 `resolved_by`、收件人无能力处理 | S5 判错被 5 晚发现 10 条 note 零动作（AR P1-4）；收件箱 45 条、17/26 卷入冲突（IR F1/F5） |
| **C5** 后台由时钟驱动，不由需求驱动 | 每晚整张 DAG 无条件开闸，节点不问「今晚有没有该我做的事」 | 97.6% token 花在学习者零活动期（AR 0.1）；零产出记 succeeded；frontier_fill 人不接受就每晚补 5 条（IR F1） |
| **C6**（放大器）记账单位是 run 不是交付 | 无轮数、cache、失败费用、无「token 换多少交付」指标，C1–C5 连续 10 天无人发现 | 133 次失败里 127 次 `cost_usd` NULL；TEMP 解除上限生效 10 天无跟踪（AR P1-1） |

已否决的候选根因：预算数值太紧/太松（TB：旧上限误杀真实产出、放开又失控烧 164 M token——光调数字恰证明根因在 C2）、模型能力不足（判断常对，是落地失败）、provider 不稳定（429×109 换 provider 即消失；熔断并入 C2 运行信封）（§1.2）。

治本办法：把**工作单元**立为一等契约，贯穿工具、循环、输出、发现、调度五层；**guard 只放最外圈，当最后的保险**（§0）。

## 决定

### D0 总原则：五层契约 + 最外圈 guard（§2 总原则）

1. 五层一起换：工具（C1）、循环（C2）、输出（C1 同层的边界契约）、发现（C4）、调度（C5）；C6 记账贯穿全程。
2. **guard 只放最外圈**：guard 触发即主机制失效，当作 harness 缺陷记入 C6 计分板（M7，目标 0），不是正常现象，更不是设计手段。
3. **复用现有部件**：DomainTool 注册表、`executeDomainToolCall`、pi 适配器钩子、`structuredOutputTool`、事件脊、proposal、job DAG、`job-yield`、`inventory-projection`；不建没有 live consumer 的子系统。
4. rewrite-prep §9 八项 pre-AI 承重能力不降级；破坏性操作走 proposal 的内核（ADR-0004/0025）保留，仅 D5 两类 owner 已批的自动动作例外。

### D1 边界契约（C1：工具、输出、门槛）（§2.1 + §10.1）

**C1-0 工具统一收尾（§10.1，owner 20:11「工具没做统一吗」）。** 按能力全量清单收敛：**一个能力一个共享工具**。KnowledgeReview 私有 `write_proposal`（`review.ts`）迁到共享注册表工具后删除；**无运行时消费者的 `MAINTENANCE_TOOLS` 名单删除**——§2.1 原「KR 改挂 `MAINTENANCE_TOOLS`」的路线由本条取代；Dreaming 不再展开继承 `KNOWLEDGE_REVIEW_TOOLS`。

**C1-1 只保留一个工具平面。** 一切产生领域写入或提议的 agent 工具走 DomainTool 注册表、面级名单和 `executeDomainToolCall`；`piCustomTool` 只留给纯读临时工具与测试。KR 用注册表的 `propose_knowledge_mutation`/`propose_knowledge_edge`（共享工具，挂载面按 C1-0 收敛，不新增无消费者的工具名单）。远程 MCP（Exa）每次调用补 `recordToolCall`，同进 `tool_call_log` 与 `cost_ledger`（YUK-1557）。**组合期契约检查（结构约束，不是 guard）**：注册时对 `effect ∈ {propose, write, control}` 的工具，`inputSchema` 顶层或一级字段为 `z.unknown()`/`z.any()`/无约束 record 即拒绝启动（做法同 `validateComposition` 拒绝 cron/dependsOn 冲突），让 KR 类事故结构上不可能再发生。

**C1-2 错误要让模型能行动。** 失败结果改固定信封：`{ error_kind: invalid_input|precondition_failed|duplicate|not_found|transient|forbidden|fatal, retryable, same_args_will_fail, fix:[{path,expected,received}], existing_ref? }`，在 `phaseError` 一处生成，zod issue 直接映射 `fix`；`tool_call_log` 另记 `error_kind`。**`fatal` 类（§10.1 补）**：契约坏、TypeError、权限拒绝——直接结束本次运行并生成 `harness_defect` finding，不回喂重试。**P0-a（§10.1，最先修）**：bridge 返回的错误今天没有标 `isError`（`pi-tools.ts:168`），模型与打转检测都会把失败当成功；此修先行，见 D8。**确定性安全修复只做两类且每次记录**：①声明为 object 的字段收到能 JSON.parse 成 object 的字符串，按对象处理；②可选字段收到 `null` 当未填。超出即「猜」，不做。

**C1-3 幂等落在领域键上。** `DomainTool` 增加可选 `idempotencyKey(input)`，一切 propose 工具必须声明；bridge 在 `beforeExecute` 前查 pending，命中返回 `duplicate` + `existing_ref`，不再写入（复用 `pendingProposalWithAnyCooldown`，不建新表）。领域键：knowledge_mutation 的 merge/split/reparent 必须给键；image_candidate 用 URL（替代单次运行内的 `seenCooldownKeys`）；题目入库用 `source_ref` 规范 URL + 全库向量近邻（复用 `bank-search` 向量通道，DJ §2.5 LIGHT），不再只认 `canonical_content_hash` 与「共享知识点」n-gram。**applier 侧**：所有 accept 路径先取 `acquireProposalDecisionLock`、锁内重查 rate；在 applier 注册处做成强制包装，不靠各 applier 自觉（learning_item accept 是当前唯一漏网路径）。

**C1-4 输出契约：能修就修，不扔掉付过钱的产出。** ①一切输出结构化对象的任务走 `structuredOutputTool`（一次 submit 工具调用 + strict JSON），优先迁 QuizGen、Sourcing `web_fetch_candidates`、NoteGenerate、KR；`parseTaskOutput` 只留给单轮旧任务，parse 前做 C1-2 那两类确定性修复。②**批次按条目验收**：合格入下游、不合格带 `reason` 回模型或进失败面；无一条合格才判 empty。③**同一次运行内修一次**：submit 校验不过时把 `fix[]` 作为 submit 错误结果返回、允许修正 1 次（此时上下文已命中 provider 缓存，约 95% 按缓存读计价，修一次边际成本远低于重跑）。④**verifier→修复回路**：QuizVerify/NoteVerify 输出 typed `suggested_fix`；单字段确定性修正自动修一次再复核（最多 1 次）；需模型修的排现有 `NoteRefineTask`（复用 TaskKind）；仍不过才作废并写失败面。

**C1-5 门槛要可校准。** 每道确定性门保留**完整拒绝理由**（修 `source_verify.ts:964,996,1069` 三处丢弃 reason 的 map），并提供「只重放确定性检查」入口：零 AI 成本、**不领付费额度**（DJ §1.3 FULL）。门的误拒率进计分板（用固定 68 题已知真题小集重放）。source_verify 一致性检查算法改 containment：用题干+选项（不含 `reference_md`），两侧先做数学归一化（DJ §1.2 LIGHT）——这是确定性门的算法缺陷，修掉即治本。

**C1-6 描述规范（§10.1）。** 每个工具的描述写明「何时用 / 何时别用 / 下一步去哪（兄弟工具名）/ 一个例子 / 常见错」，长度设上下限（现状从一句话到 3100 字两极分化）。

**C1-7 读工具的「下一步」与字段选择（§10.1）。** 读工具结果给出下一步指向（例：`query_events` 结果不含判分时明确指向 `get_attempt_context`）；支持 `fields` 字段选择与游标 + `hasNextPage` 分页。

**C1-8 按需暴露：工具与技能（§10.1，owner 20:16）。** 每个任务只常驻小核心工具集 + 两个元工具：`find_tools`（按意图检索工具并把选中的加入 `state.tools`）与 `load_skill`（加载版本化技能包：说明、例子、坑，及其携带的工具）。pi-agent-core 已核实支持 `agent.state.tools` 轮次间整组替换、`getSteeringMessages` 注入、`transformContext`、`beforeToolCall`/`afterToolCall` 钩子；今天没有运行中改工具集的用法（Copilot 每轮常驻 35 个工具、8 个从未被调用）。**MCP 继续只做传输层**。验收：Copilot 每轮常驻工具 ≤10、提示 token 下降、未被调用的工具不进上下文。

**C1-9 输出预算（§10.1）。** domain bridge 与 remote MCP（Exa）两个出口都做中段截断并标注原始大小；`tool_call_log` 留全量。

**删除**：KR `write_proposal` 及 custom mount；`DREAMING_TOOLS` 的 `propose_record_links`/`propose_record_promotion`（kind 已 tombstone 却仍在生产，IR F7）；`parseTaskOutput` 在已迁任务上的调用；ServingHold 无条件「重新检查来源」按钮（归界面线）。

**guard 位置（唯一）**：同一 `(tool, args_hash, error_kind)` 在一次运行里第 2 次出现即 `same_args_will_fail=true` 且**不再执行**，返回缓存错误。

### D2 运行契约：给每次运行一张「工作单」（C2）（§2.2 + §10.2）

**C2-1 `TaskDefinition` 增加 `contract` 字段**：`{ deliverable: 'submit'|'tool_effects'|'text', progress: ToolEffectPredicate[], landing: { atFraction: 0.8 }, partial: 'accept'|'reject' }`（后台任务默认 accept）。这是 YUK-572「charter 化」的机器可检查版本；多数单轮任务取默认值不改行为。

**C2-2 RunMonitor 挂 pi 适配器，所有运行都挂**（含子 agent，同一入口）：`makeBeforeToolCall`/`makeAfterToolCall` 无条件组合内建 RunMonitor 再接业务 `piHooks`；`finishTurn` 与 `maxTurns` 解耦；收尾消息经现有未接线的 `getSteeringMessages` 注入。RunMonitor 在 P0-a 修好前**不得依赖 pi 的 `isError`**（bridge 错误今天未标记，见 C1-2），或直接解析 bridge 错误信封（§10.2）。维护四个计数：重复调用 `(tool, input_hash)`（按输入算，输出带 `context_budget` 不可比）、连续无进展轮数（`contract.progress` 不命中）、同类错误（`error_kind+path`）连续次数、累计输入 token。状态机 **progressing → stalled → landing → landed | failed**：

- **stalled**：只读重复第 2 次、同类错误第 2 次、或连续 N=3 轮无进展——重复只读不再执行（返回缓存结果并附「结果与之前相同」），注入收尾引导「用已有结果完成交付；缺什么写进 unfinished」；
- **landing**：stalled 后又 2 轮无进展，或 token/时间用到信封 80%——工具面收窄到只剩 submit，只读面全关；
- **landed**：submit 成功；允许 `partial: true` 与 `unfinished[]`；
- **failed**：landing 下 2 轮仍无 submit。

landing 有**预算触发与进展触发两个入口（§10.2）**：预算侧照 Codex rollout budget 形状——先提醒剩余，到信封 80% 注入一次收尾（同时收窄工具面），信封 100% 终止；进展侧仍按 stalled→landing 状态机判定。

**上下文管理与 auto-compact（§10.2 + §10.5，owner 20:23「auto-compact 也要做，先看开源」）。** 调研结论：没有可直接插入 pi 的开源插件；业界做法收敛为「旧工具输出遮蔽为一行占位（保留头部与原始大小），不拆调用-结果配对」；pi-mono coding-agent（MIT）的 compaction 只借摘要提示词与切点规则，**不引入包**；Anthropic 服务端 context editing / `clear_tool_uses` 只对原生 Claude 有效，**不作主方案**。LIGHT（推荐）：新增 `src/server/ai/pi-context-mask.ts` 并扩展 `pi-agent-adapter.ts` 的 `makeTransformContext`——所有多轮任务默认「遮蔽 + 现有裁剪（`pi-agent-adapter.ts:955-1019`）」；切点「粘住」（写回状态或稳定切点），避免每轮滑动打掉 prompt cache（未测，P0 计分板验证）；送出前**历史校验独立实现、独立验收**（`validatePiHistory` 丢弃非零 → `harness_defect`），与窗口控制分开做、分开验收。**§10.5 更正 §10.2**：Sourcing `mo94wa3t` 的 400 实为某条 toolCall 缺函数名的**历史残缺**，不是超窗——不得再用作窗口溢出的证据。FULL：仅 Copilot 在遮蔽之上再加模型摘要；**后台任务不用模型摘要**（外部研究：摘要使任务多跑 13–15%、LLM 压缩多花 24–94% token）。验收指标 **A1–A9**（定义与初值见调研报告验收节：A1 历史类/超窗类 400、A2 峰值提示占比、A3 加权输入 token 同等交付下降、A4 遮蔽后重复抓取、A5 交付不退化、A6 缓存稳定、A7 校验丢弃计数、A8 边界前移次数、A9 仅 FULL 的 Copilot 摘要保真），阈值待 P0 记账数据重定；**归 P2（C2）**。

由此「被杀时丢掉全部已花 token」变成「交出能交的部分」。

**C2-3 「成功」改成交付语义**：`ai_task_runs` 增加 `outcome ∈ delivered|partial|empty|failed` 与 `yield_units`（迁移只加列，`status` 保留）；由 job 层在下游校验后回填，口径复用并同源于 `job-yield`。DAG 节点 stalled 时改标新终态 **`degraded`**（不再记 succeeded），硬下游视作 soft 依赖：可照跑但记 stale。

**C2-4 信封退为外圈**：`timeout`/`maxIterations` 按 TB §5.2 按任务表起步（例：KR 600 s + 40 轮），只在 RunMonitor 失效时起作用。**token 信封改加权单位（非缓存输入 + 输出，§10.2 修订）**，阈值待 P0 计分板数据重定，**不沿用旧绝对值**——§2.2 的 Sourcing「8 M 输入」例与 §5.3 P2 的「p95 ≤8 M」验收随本条作废，以重定后的加权信封为准。聊天车道 `maxCost` 用 token 估价接线（失败运行也计价，补 127 个 NULL）。`system_config` 的 `task.*.budget` 覆盖**必须带 `expires_at`**，过期不采用、状态页显示仍生效的覆盖（TEMP 挂 10 天的事故根源）。provider/配额冷却：`retry-after` 超 1 小时即在该 provider lane 设冷却标志；**配额耗尽（429 + 长 retry-after）归终止类（§10.2）——写 lane 冷却且 pg-boss 不再重投**。

**Copilot 持久会话（YUK-1373）**：不加数量上限、不加花费上限；RunMonitor 照常——它停的是「同参重复、同错重复、无进展」，不限花费。Copilot 的交付物是给学习者的回答，landing 意味着「基于已有结果回答并说明还缺什么」，不是「已停止」（AR P2-10 的 9 次无回答中 5 次属此类）。owner 若不同意，可只对 Copilot 关 landing、保留缓存返回。

**删除**：「调高上限让真实工作做完」路线（TB 已证不可行）；仅为调查临时解除全部上限（改由计分板供数）。

**guard 位置（YUK-1558 由此降为最外圈）**：同一 `(tool, input_hash)` 实际执行 5 次（缓存返回不算执行）硬停并记 `loop_detected`；单次运行 token 超信封（加权单位）1.5 倍硬停。两者都计入计分板 guard 触发数。

### D3 全局快照与领域写入者（C3）（§2.3）

**C3-1 WorldSnapshot 是一组确定性只读投影，不是新存储。** 每个后台 agent 输入固定带 `world` 段（各段几百到 2K token，代码生成、不调模型、按水位重建）：`tree_outline`（复用 `get_subject_graph_overview`/`loadTreeSnapshot`；修 IR F5b 挂根）、`pending_digest`（复用 `listProposalInboxRows`；写前去重避冲突）、`open_findings`（C4 投影；不重复发现）、`bank_health`（DJ §2 SQL + `inventory-projection`；给 Maintenance 与供题员）、`learner_activity`（`event.actor_kind='user'` 排除测试标记；§3 调度信号，替换 Copilot 头部的运维数字）。工具执行用**同一份快照**校验：`parent_id` 不在 `tree_outline` → `precondition_failed`；引用 `pending_digest` 中已有 merge 涉及的节点 → `precondition_failed` + `existing_ref`。

**C3-2 领域所有权表（单写入者）**——每个领域只有一个有议程权的写入者，其他人写 finding 不直接提议：

| 领域 | 唯一写入者 | 其他 agent |
|---|---|---|
| 知识树结构（章级以上 propose_new / merge / split / reparent / archive） | **Maintenance**（KR 经注册表共享 propose 工具接入，挂载面按 C1-0 收敛） | Dreaming/Coach 去掉 `propose_knowledge_mutation`，改写 `structure_issue` finding；kc_dedup 结果同样作 finding 交 Maintenance；Copilot 在学习者明确要求时的结构提议保留（学习者发起，YUK-270） |
| 新叶子知识点（打标签时） | `tag_knowledge`（保留自动建点） | 父节点默认取同科目最近邻 KC 的父节点；无候选才挂根且同时写 `structure_issue` finding |
| 学习计划落树 | `learning-intent` accept | 用 `tree_outline` 选现有章（不再固定挂 `seed:<科目>:root`）；加锁见 C1-3 |
| 知识关系边 | `frontier_fill` + `knowledge_edge_propose` | 去掉 Dreaming/Coach 的 `propose_knowledge_edge`；actor 改真实来源（现写死 `'dreaming'`） |
| 题库入库 | **备题员**（ADR-0069 D1，`store_sourced_question` 唯一入库闸） | 双管线并跑期 dispatcher 也遵守 shadow `stop`；之后按 ADR-0069 D6 退役旧路由；题库卫生作 finding 交 Maintenance 走现有撤回/合并 |
| 判分结论 | 判分引擎（`judge_run`/`rejudge`，申诉路径 `appeal.ts`） | 任何 agent 怀疑判错写 `grading_suspect` finding；执行者是系统发起的申诉再走 `rejudge` |
| 学习者记忆 / 笔记 | memory brief（只吃学习者证据）/ NoteGenerate→NoteVerify→NoteRefine | — |

**C3-3 上下文卫生**：简报读取与「要不要重算」只计学习者证据（`actor_kind='user'` 或判分/复习/作答类事件；system/cron/agent 流水线只进 `meta:*`）；`scope-tagger` 对 id 不在 knowledge 表的 `subject_kind='knowledge'` 事件不生成 `topic:` 范围；测试与验收流量按 `derivation_policy` 受限用途打标签（记忆、θ、Copilot 叙述都不吃）；现存 4 条测试提交走现有纠正路径作废再重算。

**删除**：Dreaming、Coach 的结构写工具；kc_dedup「近 7 天新建」窗口（改每晚全量知识点自连接，38 节点近零成本，另加「同名+同父」确定性规则）；Copilot 头部上下文的运维计数。

**guard 位置**：每生产者同类 pending 上限 N，达到即跳过本次写入（正常情况下快照 + 幂等使之不可达）。

### D4 发现有主：最小可用的 ADR-0067 白板（C4）（§2.4）

**C4-1 finding 是事件脊上的一种事件**（与 ADR-0067 D1 一致：不建新表、不建第二总线）：`experimental:finding`，payload 含 `kind ∈ grading_suspect|structure_issue|bank_hygiene|bank_gap|note_quality|data_quality|harness_defect|learner_signal`、规范化的 `subject_key`、`statement`、`evidence_refs[]`（**只能指向学习事实事件或系统事实行——防自喂红线**）、`owner`（由 C3-2 所有权表按 kind 确定性给出，不由模型选）、typed 封闭集合的 `proposed_action`（每 kind 对应 1–2 个现有执行器）、`confidence: certain|likely|unknown`。状态由投影推导：open → adopted → resolved | expired | retracted（复用事件脊 correct/supersede 协议）。

**C4-2 去重与计数**：同 `(kind, subject_key)` 已有 open finding 时新报告只加 `seen_count` 并补 evidence_refs，不生成新条目；快照给各 agent 自己领域的 open finding 并明确「已在白板上的不要再报」——「5 晚 10 条 note 重复发现 S5」变成 1 条 finding，之后每晚新增成本为 0。

**C4-3 每种 kind 都有执行者，全部是现有部件**：`grading_suspect` → 系统发起申诉 + `rejudge` job（对不可变原判分做新评估，不覆盖原判；exact 判错先用确定性最终答案抽取复判，仍不一致且作答长文本交 SemanticJudge）；`structure_issue` → Maintenance 下一次运行出**整体变更集**提议（同次运行提议带同一 `change_set_id`）；`bank_hygiene`/`data_quality` → 确定性 job（重复簇合并提议、只重放确定性检查、嵌入回填，零 AI）；`bank_gap` → 备题员 GapTicket（ADR-0069 D2：缺口单来自白板）；`note_quality` → `NoteRefineTask` 自动修一次；`harness_defect`（工具连续失败、guard 触发、门误拒率超阈值）→ **不交给任何 agent**，进状态页与 Linear capture，由人或工程线处理——「工具坏了」任何 agent 都修不了，必须出系统；`learner_signal` → ADR-0067 的例会和主席。`leave_agent_note`/`read_agent_notes` 迁移成 finding 的写入/读取（工具名可保留），`AgentNoteTarget` 由所有权表替代（发 note 的 agent 不再自选收件人）；历史 note 事件保留只读。

**C4-4 收件箱卫生**（确定性部分，无需 owner 拍板；proposal 本身就是 owner=学习者的 finding）：①写入时取代：同 cooldown_key 已有 pending 时旧的写 `correct` 变 stale（复用 `retractAiProposal`）；②接受时连带：merge/split 被接受时同事务把引用被归档节点的 pending 一并 stale；③读侧可裁决性检查：目标不存在/版本不匹配/已满足的默认折叠「已失效·系统判定」；④**TTL：pending 超 14 天且目标有变动自动 stale**；⑤理由过滤从整段丢弃改为只处理命中片段。

**删除**：agent note 作为独立频道的语义；`judge_pending_reconcile` 在 `pending_ids` 为空时写的观测事件；`supply_inventory_shadow` 影子事件（stop 判断转正后）。

**guard 位置**：每次运行写 finding 条数上限（例如 5 条），超出合并成一条摘要（正常情况下 C4-2 去重使之不可达）。

### D5 首批 A 档自动动作：仅 owner 已批的两类（§6 决定 1 + §9）

owner 2026-10-18 19:48 拍板「两件都允许」。**系统可自行执行、留记录、一键撤销的只有这两类**：

- **(a) 判分疑似错误自动重判**：`grading_suspect` finding 触发系统发起申诉并走 `rejudge`（新评估，不改写原判事件；学习者可见结论替换原判分）；exact 判错先用确定性最终答案抽取复判，仍不一致且作答为长文本交 SemanticJudge（AR P1-4 LIGHT）。
- **(b) 无作答记录的同名同父重复知识点自动合并**：判定条件为**同名、同父、两边都没有任何作答记录**，全部满足才自动执行；留记录、可撤销。**仅此合格情形**覆盖 kc_dedup 文件头「只提议」的铁律。

其余动作（新建知识点、改关系、合并**有**作答记录的点、付费抽图）仍然逐条问 owner；不合格的进收件箱等批。这是 ADR-0039 出手档的首批 A 档（ADR-0039 Amendment 2026-06-15 记录：15 B + 3 C + 0 A），**不是 A 档全面铺开**——铺开仍属 D8 中维持推迟的 FULL 项。

### D6 需求门控：后台自适应降频（C5）（§3 + §9 决定 2）

**原则**（§3.1）：①没有需求就不做，而不是给花费设上限——降频不设金额或数量上限，与 ADR-0069 D4（供题花费不设上限、AI 生成数量不设硬顶）一致；需求一来照常不限量。②判断全部确定性，不调模型；阈值登记在案，模型不能改（与 ADR-0067 D2 一致）。③学习者回来立刻恢复，不等下一个 02:30。

**信号**（§3.2，全部来自现有表）：A 学习者活跃度（`last_user_event_at`、近 7 天活跃天数，排除测试标记）；A' 时间压力（goal 无日期列，先读 metadata 或学习者陈述，读不到就不用）；D 未满足需求（库存低于目标、到期无可出题、open GapTicket 或 `bank_gap`）；I 待裁决积压（各生产者 pending 数量与最老天数）；S 数据新鲜度（各段水位自上次成功运行以来有无变化）；F 有主发现（本领域有无 open finding）。

**活跃度分档**（§3.3；档位判定值经 owner §9 决定 2 拍板）：

| 档位 | 判定 | 反思类 agent（coach / dreaming / research_meeting / memory global+meta） | 供题 | 结构维护（Maintenance / kc_dedup / frontier） | 确定性批处理 |
|---|---|---|---|---|---|
| 活跃 | 最近 24 h 有学习者事件，或 A' 在考试窗口内 | 满足 S 或 F 时运行 | 按 D 补足目标库存，不设上限 | S 或 F 满足时运行 | 照常 |
| 近期 | 1–3 天 | 有新学习者证据才运行一次，按水位幂等 | 按 D 补足 | 只在 S（树变化）或 F 满足时运行 | 照常 |
| **空闲** | **3–14 天** | **不运行** | 只补到「回来即可练」：每个活跃目标保证前 2 次练习有可出题，然后停 | 只在 F 满足时运行 | 只跑零 AI 部分 |
| **休眠** | **14 天以上** | 不运行 | 不运行 | 不运行 | 只跑 housekeeping |

**机制**（§3.4，复用 DAG，不建新调度器）：①`JobDecl` 增加可选 `eligibility: (signals) => { run: true } | { run: false, reason }`，orchestrator 在 enqueue 前求值，不合格节点标新终态 **`not_needed`**（detail 写原因，如 `idle: no learner evidence since …`）。②`not_needed` 的依赖语义是软的：下游视同 succeeded 但没有新数据，按自己的 eligibility 决定；**不**沿用 `skipped` 的硬边连坐。③DAG 外的 LLM cron 能进 DAG 的进 DAG、不能进的套 `withEligibility` 包装；每分钟轮询空闲时只做几次 SELECT 保留。④**唤醒**：事件订阅注册表加一条监听学习者事件的订阅，只在档位从空闲/休眠回到活跃时触发（带防抖），确定性召集「回来即可练」：今日安排走确定性兜底（FSRS due 骨干）、刷新该学习者活跃 scope 的记忆简报（只吃学习者证据）、给到期缺题 KC 发 GapTicket——即 ADR-0067 D2 的 L1/L2 召集，触发源是档位变化事件，不新增传输层。⑤零产出 ≠ 成功：`job-yield` 判 stalled 的节点终态 `degraded`；**连续 2 晚 degraded 自动降 `not_needed` 并写 `harness_defect` finding**（KR 10 晚 succeeded 的反面）。⑥正反馈生产者（frontier_fill）的 eligibility 同时看 I：自己名下 pending 达上限即 `not_needed`。

**任何时候都在跑的最低集合**（§3.5）：housekeeping（rewrite-prep §9 第 8 项，语义与时区不动）、漏事件兜底（memory brief sweep、outbox recover、`judge_pending_reconcile` 非空才写、`copilot_run_reconcile`）、学习者事件触发的 L1 反应、C6 计分板汇总（零 AI）、零 AI 卫生检查（重复簇检测、确定性重放、嵌入回填按 S 判断）。

**与现有架构的关系**（§3.6）：02:30 锚点、补跑窗、tick、硬边软边全部保留；DBOS 迁移不受影响。对 ADR-0067：**D2 修订**（L3 批处理也加 eligibility——空闲期 97% 花费正在 L3，Sourcing 占全部美元成本 69%）；**D7 修订**（后台日上限降为报警水位，见下）。两项修订的正式落档在 ADR-0067 Amendment 2026-10-18。

**预期效果**（§3.7，预注册假设非承诺）：基线为 10-11 至 10-17 学习者零活动 7 天：402 M 输入 / USD 11.44（约 57 M、USD 1.63 一天）；目标空闲日输入 token ≤ 基线空闲日的 **5%**。

### D7 交付记账与评估（C6）（§2.5、§5.1、§10.3）

**C6-1 补齐原始记录**（YUK-1557 + TB §6.4 + §10.3）：`usage_json` 增加 `numTurns`、`cacheReadTokens`、`cacheWriteTokens`（适配器已有数，只差落库）；**逐响应 usage（§10.3）**：每次模型响应记一条 usage（cached / cache_write / output 分开、带轮次号），失败与 abort 也合成终态并估价；**多轮任务 transcript 落 blob（带保留期）并记 `ai_task_runs.transcript_ref`——回放集依赖它**；`tool_call_log` 每次调用只留一行；Exa 与入库 agent 的工具调用都记；**失败运行也按 token 计价**（补 127 个 NULL `cost_usd`）；Sourcing 运行与 `supply_executor_*` 建 task_run 关联；笔记、准入等失败状态 lifecycle 一律带 `failure_reason`。

**C6-2 harness 计分板**：确定性每日汇总 job（挂 observability 已有 cron 宿主，不新建调度），从原始表算 §5.1 指标并按任务、按生产者拆分，写进 `meta:` 投影供状态页（tlp-status）读取；coordinator 每 4 小时巡检，越线走 Linear capture。

**C6-3 回放集与回归闸（不含任何测试代码）**：把本次审查事故输入封存为 TEST 回放集（KR 运行、Copilot S5 提问、Sourcing 缺口、33 个 QuizGen 失败批次、68 道 source_verify 被拒题、24 份空笔记输入）。确定性部分零 AI 重放；agent 部分在 TEST 上用真实 provider 跑并封存 exact revision、输入/输出 digest、task-run ID、provider/model/cost（合 AGENTS.md actual-output 要求）。每次改 prompt、工具 schema 或模型，合并前重跑相关子集作为 PR 证据；**付费重跑受每周 USD 20 预算约束**。按 Owner rules（2026-10-12），此处不含测试代码；若要把某段回放固化成 scoped test，先单独提交文本方案等 owner 批准。

**指标（M1–M7，基线全部来自 TEST 10-07 至 10-18 真实数据；§5.1）**：

| # | 指标 | 基线 | 目标 |
|---|---|---|---|
| M1 | 零产出 token 占比（outcome ∈ failed/empty 的输入 token ÷ 全部） | ≥40%（失控失败运行 164.4 M / 411.2 M） | ≤10%（P2 后 ≤15%，P4 后 ≤10%） |
| M2 | 打转（一次运行同 `(tool, input_hash)` 实际执行 >3 次） | KR 271 次、Copilot 48、RM 19；失控 4 次 | 0 |
| M3 | 被丢弃的付费产出（按任务） | QuizGen 55%；source_consistency 68/198（≥53 应过）；笔记 24/31；KR 748/748 | QuizGen ≤10%；误拒 ≤5%（回放集）；笔记 ≤10%；KR 写入成功率 ≥90% |
| M4 | 收件箱积压 | 45 条、最老 9.6 天、可关 9 条、17/26 卷入冲突 | 可关 = 0；无超 14 天；冲突 ≤10% |
| M5 | 重复率 | 新入库 48/276（17%）；6 对同名双胞胎 | ≤2%；0 |
| M6 | 空闲期花费 | 约 57 M / USD 1.63 每天 | ≤ 基线的 5% |
| M7 | guard 触发数 | 未记录 | 0；触发即 harness 缺陷，生成 finding |

**计分板口径（YUK-1647，2026-10-21）。** M3/M4/M5 由 `harness_scoreboard` 的 `parts[]` 逐子项给出分子/分母与 `basis`，不再用单一代理定义：M3 = QuizGen 终止批次、source_verify 题目终判、NoteGenerate 终态迁移、KR propose 工具调用；M4 = 窗口结束时刻收件箱投影的 pending 条数、最老天数、可关条数（目标缺失/归档或 `expected_version` 失配）、卷入冲突条数（与另一 pending 行共享被引用知识点）；M5 = 提交回执 duplicate_exact/source/near_dup 加 QuizGen exact duplicate 除以窗口新建题数、窗口内同父同名知识双胞胎。基线列中 M4「可关 9 条」「17/26 卷入冲突」是人工读数，确定性口径按定义重算，不承诺逐条相同；重算步骤与 NOT_RUN 交接见 `docs/planning/2026-10-21-yuk1647-harness-scoreboard-real-metrics.md`。

**测量纪律**：before/after 均取 TEST 真实运行（夜链自然运行 + 回放集真实 provider 重跑，不用 mock）；每阶段至少观察 3 个完整夜晚或跑完一轮回放集，封存 revision、digest、task-run ID 与费用；付费重跑在 USD 20/周内。**删除**：`kt_estimate_nightly`（写了没人读）、`axis_state_nightly` 夜写、`HUB_SYNC_MODE=off` 时 `hub_sync_recovery` 的每分钟 cron。
> **实施记录 2026-10-21（YUK-1560）**：kt 夜链已随 YUK-1576 删除，axis manifest 与 batch writer 已删。`hub_sync_recovery` 每分钟 cron **保留**：它是 Notes generation/verification handoff 与 claim 的唯一恢复地板（ADR-0052），删掉会丢漏发恢复；hub-sync 自身在 `HUB_SYNC_MODE=off` 时已在 `runHubSyncCycle` 入口短路。

### D8 阶段计划与已批范围（§5，经 §9/§10 修订）

**已批实施范围 = LIGHT（P0–P4）+ 主席层提前**；其余 FULL 项维持推迟。每阶段验收为可量化指标（摘自 §5.3，完整口径以设计稿为准）：

- **P0-a（§10.1，最先修，先于其余阶段）**：bridge 错误补 `isError` 标记（`pi-tools.ts:168`）——今天模型与打转检测都会把失败当成功；RunMonitor 对 `isError` 的依赖以它为前提（见 D2）。产品代码修复由独立 lane 承担，不属于本文档范围。
- **P0 记账地基**（C6-1/C6-2 + YUK-1557 扩展 + override 带 `expires_at` + 计分板与状态页读取）：计分板对 10-07 至 10-18 重算 M1–M6 与审查报告相差 ≤±2%；TEST 连续 24 h 每条 `ai_task_runs` 有 numTurns 与 cache token（usage 按逐响应落一条，§10.3）、无重复工具行；Exa 进 `tool_call_log`；失败运行 `cost_usd` NULL 为 0。
- **P1 边界契约**（C1 全部 + YUK-1553 schema/锁/父节点 + 1551 + 1552 + 1534 剩余 + 1555 笔记部分）：组合期契约检查上线（启动时有 `unknown` payload 即失败）；3 晚自然运行 KR 写入成功率 ≥90%、QuizGen 被丢批次 ≤10%、笔记空失败 ≤10%；68 题回放 ≥45 过、原通过题 0 回退；新增同 cooldown_key pending 重复 = 0；TEST 副本并发接受同一学习意图 2 次只生成 1 棵子树；新入库重复率 ≤2%。
- **P2 工作单**（C2 全部 + YUK-1558 降为外圈 + 1555 Copilot 部分 + §10.5 上下文遮蔽/auto-compact 与独立历史校验）：先 report-only 观察 3 晚（只记录状态机不干预）再开 stalled/landing；回放集 KR、Copilot S5、Sourcing 长跑三输入重跑 M2 = 0、落入 stalled 的运行 ≥80% 以 landed（含 partial）结束；3 晚自然运行 Sourcing 单次加权 token p95/p99 对 P0 重定的加权信封校验（§10.2，不沿用旧 8 M 绝对值）；上下文管理按 A1–A9 验收（初值见调研报告验收节，阈值待 P0 数据重定）；M1 ≤ 15%；M7 计数可见。
- **P3 需求门控**（§3 全部 + `degraded`/`not_needed` 两终态 + 删 `kt_estimate`/`axis` 夜写/`hub_sync` cron）：TEST 至少 3 个空闲档日 M6 ≤ 基线 5% 且 `dag_orchestration_node.detail` 逐节点说明不跑原因；唤醒验收 = coordinator 在 TEST 做一次带测试标记的真实会话（不进记忆），10 分钟内完成「回来即可练」准备（今日安排可出、缺题 KC 收到 GapTicket）；零产出节点不再显示 succeeded。
- **P4 发现有主、上下文快照、领域写入者**（C3、C4 + YUK-1549 合并 + 1407 闭环部分 + 1554 + 1556）：S5 类事实 1 晚内恰好 1 条 `grading_suspect` finding 且被执行（申诉加重判，或按 D5 进 A 档），之后同 subject 新增 LLM note 为 0；M4 达标；新叶子挂根 = 0（无同科目候选时除外、且必须有对应 finding）；简报无系统流水线叙述、无新学习者证据时重算 0 次；现有重复子树与 33 个重复簇由 Maintenance 各出 1 份变更集提议、owner 一次确认。
- **主席层提前（§9 决定 3，覆盖原 P5 推迟）**：ADR-0067 **D3 主席决定、D6 指标与白板管理页现在也做**，不等「连续 7 天中 ≥3 天有学习者事件」的使用触发；排在 **P1 之后**；白板管理页走 UI pre-flight 与 owner 三次设计检查。D3/D6 的决策内容不变（恰好一个被回读验证的决定、按链预注册度量）；学习层有用性数值在真实使用达到预注册样本量之前仍是预注册假设——**提前的是实施时点，不是测量结论**。
- **维持推迟的 FULL 项（§9 未批，不得当作已批推进）**：A 档自动应用的全面铺开（超出 D5 两类）、回放集固化为每次 prompt/模型变更的强制闸、WorldSnapshot 覆盖所有面（含 Copilot 全量）、Copilot 的模型摘要压缩（§10.5 FULL：仅 Copilot、遮蔽之后叠加；后台任务不用，A9 只在该项启动时验收）。原触发条件不变。
- **顺序依据**（§5.3）：P0 不做则后续验收无数据；P1 先于 P2（工具坏时进展检测只会让失败更早结束、产出不增）；P3 可与 P1/P2 并行（不依赖契约，独立拿到 M6 大部分收益）；P4 依赖 P1 的 Maintenance 工具已修好；**P1/P2 的验收依赖 P0 落地**。各阶段 before/after 指标按 D7 测量纪律执行。

## 与既有 ADR 的关系（§4.4）

- **ADR-0004**：proposal-only 内核保留；「budget 逐 task 手调」的已接受代价由 C2 工作单 + C6 计分板取代（上限不再是主要停止机制，信封数值用计分板数据定）。
- **ADR-0039**：C4-4 的取代/过期/连带失效是系统状态维护，不是出手，不改变 A/B/C 分档；真正的 A 档候选即 D5 两类，经 owner 已批成为首批 A 档。
- **ADR-0053/0056/0065**：RunMonitor 挂 pi 适配器同一钩子、子 agent 同一入口；ADR-0065 的上下文裁剪只控长度，不能当进展信号（Sourcing 383 条消息 75 M 那次运行证明裁剪挡不住打转）。
- **ADR-0067**：D1 白板 = 本文 C4 的最小实现；D2/D7 按 D6 修订、D3/D6 实施时点按 §9 提前（正式落档见其 Amendment 2026-10-18）。
- **ADR-0069**：D1「无进展终止」由 C2 通用实现，不在备题员单独写一套；D2 缺口单来自白板（C4 `bank_gap`）；D4 不设上限与 §3.1 一致；D6 并跑期 dispatcher 遵守 shadow `stop`。
- **ADR-0072**：入库去重的向量与全文通道复用 `search_bank` 内部检索；是否授 Maintenance `read_bank`/`check_bank` 属 ADR-0072 未决问题 3，本设计建议授予（题库卫生上下文）。

## 票据处置（§4.1、§4.2、§4.3）

| 票 | 处置 | 归到 |
|---|---|---|
| YUK-1557 | **切片，P0 最先做** | C6-1 |
| YUK-1553 | 切片三块：schema → C1-1；锁 → C1-3；父节点 → C3-2 | C1/C3 |
| YUK-1555 | 切片两块：笔记 → C1-4 + C6-1；Copilot → C2-2 landing | C1/C2/C6 |
| YUK-1551 | 切片（门算法缺陷即治本）；界面部分归界面线 | C1-5 |
| YUK-1552 | 切片 | C1-3 领域键 + C3-1 `bank_health` + C4 `bank_hygiene` |
| YUK-1534 | 退役（已合入 `0eab50567`，只放宽了一个字段）；剩余并入 | C1-2 / C1-4 |
| YUK-1558 | **保留止血 → 由 C2 吸收为最外圈**；guard 触发计入计分板；不再承担「防打转」主责 | C2-2 / C2-4 |
| YUK-1549 | 合并进本设计后退役（设计由本文承担，实施拆进 C3/C4 切片，不另出设计） | C3-2 + C4 + §3 |
| YUK-1407（并入 1550） | 拆开：判分语义（`exact.ts:79` 只比首行）**保留**，属判分正确性非 harness；「发现了不纠正」→ C4 `grading_suspect`→`rejudge`；人工复核悬空 → C4 执行者表 | C4 |
| YUK-1554 | 切片；界面部分归界面线 | C4-4 |
| YUK-1556 | 切片 | C3-3 |
| YUK-572 | 建议以「被 ADR-0067 D4 和本设计取代」关闭；YUK-1085 并入 C2/C3 切片后关闭；spawn-contract 原样保留（已有真实 consumer） | C2-1 / C3-2 |
| YUK-1449 | 保留为学习者侧协调伞票；当前阶段范围 = 发现有主（C4）+ L3 资格门（§3）+ 主席层（§9 决定 3 提前，P1 之后） | C4 / D6 / ADR-0067 |

## 硬边界（后果）

1. **自动动作仅 D5 两类**：同名同父且双方无作答记录的合并、判错自动重判；其余（新建知识点、改关系、合并有作答记录的点、付费抽图）一律 proposal + owner 逐条确认。不得借「降频/报警水位」扩大自动面。
2. **guard 只在最外圈**；guard 触发即 harness 缺陷（M7 目标 0），不得把 guard 当正常停止机制或设计手段。
3. **ADR-0067 D7 日上限降为报警水位 ≠ 删除其他预算/守卫**：每次召集调用上限（例会 ≤2 次模型调用、周回顾 ≤3 次）、每链 kill switch、Copilot 学习者主动会话豁免（YUK-1373）、按任务执行信封（D2 C2-4）、付费重放 USD 20/周、付费抽图逐条确认，全部保留有效。
4. rewrite-prep §9 八项 pre-AI 承重能力不降级；housekeeping cron 语义与时区不动。
5. 确定性兜底不可降级（练习流永不依赖例会可用）；危机与隐私永不进白板（ADR-0067 硬边界 3 沿用）；finding 的 `evidence_refs` 防自喂红线不可破。
6. 不建没有 live consumer 的子系统；不出现第二事件总线或第二 proposal inbox。
7. 无 owner 批准的测试文本方案，不写测试代码；测试不阻塞开发（Owner rules 2026-10-12）。
8. 本文所有预期数字是**预注册目标，不是承诺**；未实测前不得当作已验证结果汇报；owner 已批决定与实现状态分开陈述。

## 被拒绝的备选（§1.2、§4.2、§4.3）

- **调预算数值**（调高或调低上限）：TB 证明旧上限误杀真实产出（Sourcing 55% 的题出自超 120 s 运行）、放开又失控烧 164 M token——光调数字不解决根因。
- **归因模型能力不足**：判断常对（KR 合并判断、Dreaming 认双胞胎、research_meeting 抓 S5、Copilot 回答质量），失败在落地。
- **归因 provider 不稳定作为根因**：429×109 换 provider 消失；属运行时韧性，熔断并入 C2 信封。
- **单独加一层「agent 间协调」**：候选根因 g 不独立——由 C3（快照/单写者）+ C4（发现有主）联合造成，单独加协调层修不了。
- **YUK-572 的议程权/scout 深化路线**：瓶颈不在议程权与取证深度；更多议程权只会在坏契约上花更多 token；charter 化改为 C2-1 机器可检查契约。
- **等 shadow 对照翻转**：owner 无真实使用，可预见未来无法裁决；按 ADR-0067 D4 先 census、再 drain、然后删除。
- **照搬 Codex CLI 机制（§10.4）**：模型自评为主判据、计划工具、后台写摘要压缩、后台 resume、无限重连——都依赖有人在场；且本设计的重复检测、进展检测、领域幂等键与 C3/C4/C5 比 Codex 更严，不得以「业界参考也没有」为由削减。

## 未决问题（§7）

- `contract.progress` 谓词需逐任务定义；定不好会过早收尾长任务——P2 的 report-only 3 晚观察期即为此风险准备。
- A' 时间压力信号：goal 表无日期列，先读 metadata 或学习者陈述，读不到则该信号不用。
- Maintenance 是否授 `read_bank`/`check_bank`：ADR-0072 未决问题 3，本设计建议授予。
- ingestion agent（不在 `ai_task_runs`）与 Copilot 前台交互延迟未评估。
- P0 之前的历史数据只能部分重算（cache token 永久缺失），基线只能用本次审查数字。
- Copilot 的 landing 若 owner 日后不同意，可只对 Copilot 关闭 landing、保留缓存返回（§2.2）。
- auto-compact 切点「粘住」对 prompt cache 的实际效果未测，P0 计分板按 A6 验证（§10.5）。

## 来源映射（本文 → 设计稿）

D0 ← §2 总原则；D1 ← §2.1 + §10.1（C1-0 统一收尾、C1-6 描述规范、C1-7 读契约、C1-8 按需暴露、C1-9 输出预算、fatal 补类、P0-a）；D2 ← §2.2 + §10.2 + §10.5（加权 token 信封、上下文管理与 auto-compact、mo94wa3t 归因更正、landing 双入口、429/配额终止）；D3 ← §2.3（C3-1…C3-3 + 删除 + guard）；D4 ← §2.4（C4-1…C4-4 + 删除 + guard）；D5 ← §6 决定 1 + §9；D6 ← §3（§3.1–§3.7）+ §9 决定 2；D7 ← §2.5 + §5.1 + §10.3（逐响应 usage、transcript blob）；D8 ← §5.2/§5.3 + §9 决定 3 + §10（P0-a 前置、信封修订、A1–A9 归 P2、Copilot 摘要列 FULL 推迟）；ADR 关系 ← §4.4；票据处置 ← §4.1–§4.3；根因与证据 ← §1；否决备选 ← §1.2/§4.2/§4.3/§10.4；未决 ← §7。**§9/§10 优先级最高**：正文与之冲突的推荐/推迟/数值（如原 P5 主席层推迟、Sourcing 8 M 输入信封、KR 挂 `MAINTENANCE_TOOLS`）已被覆盖，本文按新条文书写，不保留相互矛盾的有效门槛。
