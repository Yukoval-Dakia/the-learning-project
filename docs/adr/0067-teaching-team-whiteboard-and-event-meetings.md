---
status: accepted
---

# ADR-0067 — 教研白板与事件例会：教研团协调中心

**Status:** Accepted（设计方向，2026-10-10）；尚未实施。
**Decision source:** owner 2026-10-10「我们后台有一些定时的agent会进行分析和产出。但是我一直模糊的觉得他们的配合有限，并且定时这种办法不够『智能』，没能更快更准确的抓住信息」，按设计草案推进并转成本 ADR（[YUK-1449](https://linear.app/yukoval-studios/issue/YUK-1449)）。
**Tracking:** [YUK-1449](https://linear.app/yukoval-studios/issue/YUK-1449)。
**Related:** ADR-0066（实时自适应学习目标）；ADR-0017（逐事件 memory ingest 先例）；owner 愿景语料 `docs/superpowers/specs/2026-06-18-private-teaching-research-team-vision.md`、`2026-06-18-jiaoyantuan-deliberative-panel-design.md`、`2026-06-18-jiaoyantuan-integration-and-build-start.md`、`docs/design/2026-06-25-recommendation-engine-x-algorithm-mapping.md`；设计草案（细节真相源，绝对 artifact 路径）`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/yuk1388/stage4/final/teaching-team-design-draft.md`。

## 背景与问题

后台已有一批定时 agent：规划脑（coach_daily/weekly）、关系脑（conjecture 链）、教学法脑（intervention/recommend）、若干夜链与巡检。YUK-1388 第四批审计坐实了 owner 的模糊感觉，问题不在 agent 不够多，而在四点（证据见草案 §1，审计产物 S13-A22/A02/A25/A27/A63、I01-M025/M048/M091、R01 运行普查）：

1. **互相不读**：三脑交班简报从未被证明比直接安排更有用；BKT 夜链数值零消费者。
2. **产出到不了行动**：coach_daily 模型报成功但 `today_plan=null`（success ≠ 交付）；部分提醒按钮只记点击不执行。
3. **失败无人认领**：46 个失败任务与 46 条死信无消费者（已立 YUK-1409）。
4. **只能靠时钟获得触发机会**：事件基础设施（事件脊、订阅 checkpoint/delivery、job DAG，S13-A43 KEEP）已经存在且被裁定保留，协调却仍挂在 cron 上。

同时，owner 的愿景语料里早有一套教研团设计：三脑合一于同一个夜间例会 job 与同一张备课台（integration capstone §2）；审议 panel——教研员 A/B 异质 lane、魔鬼代言人攻领先草案、教研组长 SELECT-not-fuse、单轮 N=2、blackboard SOP、确定性闸门（panel design §A–§D）；以及 X 算法映射给出的 grox-style plan-DAG refine（eligibility 门 + 并行 plans + SKIP 级联 + 缓存/TTL 输出 → YUK-406，「本轮最高价值 REFINE」）。其中 Phase 0 关系脑（确定性 `research_meeting_nightly`：取证 → Opus N=3 self-consistency 归纳 → ≤3 conjecture 提案 → 一次性 probe → confirm/refute）已 CODE-LIVE（YUK-405 2026-07-23 勘误）；审议 panel 的任务种类 `planning_panel`/`planning_critic`/`planning_judge` 在 `src/` 零命中，从未实施（Phase 2，阻塞于 B1/B3，异质 lane 前提又被 YUK-416 推迟）。

本 ADR 把这两条线合起来：**用事件召集的例会 + 一块白板 + 一个主席，把已存在的分析能力变成一个协调中心**。它是决策记录，不是实施 spec；触发表、逐链处置映射、发现条目的字段形状等细节以草案为真相源，本文只钉决定与边界。

## 决定

### D1 教研白板 = 事件脊上的投影，不是新存储

白板上的「发现」（Finding）是事件脊上的一种 experimental 事件（需要 owner 确认的走现有 proposal 体系），白板本身是 typed read-model 只读投影。更正、撤回、supersede、checkpoint 恢复全部复用事件脊现有协议，不建第二条消息总线、第二张自有写者的「发现表」、第二个 proposal inbox。

这是对 owner panel 设计中 blackboard SOP 的落板化：原设计中 blackboard 是 job 内存装配的 evidence pack（「不必落新表」），服务于单次例会；现在它升级为跨例会持久的共享发现层——分析者互相读白板，不再互相交班私有简报。防自喂红线保留：发现的 `evidence_refs` 只能指向学习事实事件（作答、判分、更正、录入原件），不得指向另一条发现的文字；模型写的发现是「机器门验收前的判断」，schema + 证据存在性 + 有效性不过就不落板。

### D2 三层触发：例会保留，触发从时钟改为事件阈值，时钟只留真批处理

不是「事件取代时钟」，而是分层（草案 §2.1 修正一）：

- **L1 逐事件确定性反应**：现有事件订阅（探针上架、干预准备、结算聚合）原样保留，不经过会议；
- **L2 阈值召集的例会**：跨事件聚合后才值得开会的信号（同 KC 连续错、录入一批新题、考试窗口、计划变更）经防抖后召集；
- **L3 真正的批处理**：校准、清理、周回顾留在时钟/DAG；现有 sweep 类 cron 是漏事件正确性兜底，保留。

触发表 T1–T9（事件 → 召集谁 → 防抖 → 预算）见草案 §4.1；阈值全部是登记在案的确定性参数，模型不改阈值。这同时兑现 X 映射给 YUK-406 的 grox-style plan-DAG refine：触发表就是 eligibility 门（多数召集短路，如求助直派不开会），DAG `dependsOn` 承接 SKIP 级联，发现的有效期与 `source_freshness` 即缓存/TTL 输出。所有召集是现有 pg-boss/DBOS 队列上带终态回执的 job，订阅声明走 capability manifest 的 `subscriptions.handlers`，不新增传输层；pg-boss → DBOS 逐家族迁移期内落在当前宿主随迁（S13-A53 条件不破）。

owner 愿景中的「教研例会 = sleep-time job」由 L2 承接并改造：`research_meeting_nightly` 的确定性取证与归纳能力保留（YUK-1449 明示「真正的例会保留，改为阈值触发并升级为协调中心」），触发从纯时钟改为 T1/T4 阈值 + 日级兜底。

### D3 主席 = 教研组长：一次例会恰好一个被验证的决定

草案的「主席」就是 owner panel 设计的**教研组长（Synthesizer-Judge）**：唯一 writer、structured、SELECT-not-fuse（在发现与候选动作中择一，不融合）、组长经 propose 落 proposal-as-event。每次例会产出**恰好一个决定**（或显式弃权）：封闭决定集（swap_item / adjust_review / serve_probe / defer_with_reason / abstain）、reasons 引用 finding id 与底层事件、预登记 expected_effect、写入后**回读 canonical 练习流验证实际变化——没有改变 = 本次例会失败**，记入失败面（与 YUK-1409 合流），不报成功。这沿用供题链「fail-closed 提交后验证」原则，直接堵死 coach_daily 式 success≠交付。

panel 设计中仍然成立的思想，折进新例会作为主席裁决面的组成：

- **异质 lane**：真分歧召集时教研员 A/B 异质视角仍是设计方向；受 YUK-416 现实约束，当前以单 lane Opus + adversarial-role + prompt-prior 运行，异质重启条件见 YUK-416，不假造分歧。
- **魔鬼代言人**：攻击领先草案，无 evidence_ref 的 objection 自动降权。
- **select-not-fuse / 单轮 N=2**：主席选不融；不开多轮辩论，不做 N>2 凑多样性（完整 swarm 已被 owner panel 设计拒绝，MAST 依据不变）。
- **确定性门控与「仅被触发才召集」的成本规则**：`shouldRunPlanningPanel` 式闸门语义保留——能确定性解决的不召集、不调用模型；会议只在触发表命中时召开。
- **owner 在 judge 之上**：高风险/不可逆动作走现有 proposal + 确认 + 撤销，不由例会自行生效；例会输入必须包含 owner 已拒绝方向的反馈摘要。

### D4 A25 裁定：影子 agent 例会线不是 owner 的 panel，删除成立但先 census + drain

审计 S13-A25 建议 DELETE 的 `research_meeting_agent_nightly`（agent director/scout 第二执行线，`src/capabilities/agency/manifest.ts`），**经源码与愿景文档核查，不是 owner 的审议 panel，而是独立的「议程权分层」实验**：

- owner 的 panel（panel design §B/§C）= 教研员 A 巩固 ‖ B 前沿异质 lane + 魔鬼代言人 + 组长 SELECT；其任务种类 `planning_panel`/`planning_critic`/`planning_judge` 在 `src/` 零命中——panel 从未建过，不存在被删除的对象。
- A25 线源自 YUK-572（2026-07-06 owner 拍板的议程权分层）：单一 charter agent 持议程权 + depth-1 evidence-scout、propose-only、与确定性例会并排的 shadow 对照线，凭数周对比证据决定翻转。它是 anti-swarm 的单脑 + 条件侦察兵，没有 A/B 竞争 lane、没有批评者、没有 select——与 panel 是两条设计谱系。

因此删除 A25 不删除 panel；panel 仍然有效的思想已按 D3 折进新例会。删除按 YUK-1449 owner 已拍板的顺序执行，前置义务：

1. **census**：kill switch `RESEARCH_MEETING_AGENT_ENABLED` 默认 OFF ≠ 从未通电——先核查运行 flag、claim/nonce lease、未终 run 与任何真实产出；
2. **drain**：停 orchestrator DAG 节点（现由 `dependsOn: ['research_meeting_nightly']` 硬边排在确定性会议之后），清空在途义务，再删 wrapper；不删历史 SQL、原始事件与已批准产物；
3. **能力保留**：共享 evidence/probe 工具留给真实 consumer；scout 外部取证若 census 证明有真实运行与产出，以白板成员身份重新登记，不保留独立编排线；
4. **决策闭合**：YUK-572 的 P2「shadow 对照 → 证据翻转」实验由本 ADR 取代——它要回答的问题（agent-led 例会是否优于确定性例会）由新结构回答：议程权收进主席、触发收进触发表、产出收进白板并按链度量。

### D5 现有链路逐一处置

三脑并入白板；coach_daily 计划产出先由主席决定接上 canonical stream 证明 parity 后退役为白板「规划分析」成员；coach_weekly 改周盘点；A02 BKT 夜链删除（零消费者）；A47 对比需求迁入普通供题执行器；A38 停夜写、信号暂不入板；A25 按 D4；A27 nudge/chip 改 typed 动作 + 执行回执并补 native wrong-streak producer；A29 memory brief 保留为事件驱动并缩到真实 consumer scope；供题/校准/结构维护/运维 cron 保留为批处理；Copilot 会话不在本设计范围。完整映射表与每条的理由、保留边界见草案 §6——凡与审计裁决不一致处以草案的理由为准，S13 DELETE/SIMPLIFY 对象随 consumer 迁入新路径的 PR 删除，不做独立大扫除。

### D6 有用性按链预注册度量

每条链预先登记「它应改变什么动作、观察窗、最低效果」；窗口内从未改变动作的链进简化/删除流程（沿用审计波次纪律：先停 producer，drain，再删）。分母是「被引用的决定」而不是「写出的文字」。机械层现在就能量；学习层（帮助后独立检查通过率、预测封存对照）等真实使用达到预注册样本量后才启动。coach_weekly 的周回顾固定附这张盘点表。

### D7 成本与 veto

每次召集有调用上限（例会 ≤2 次模型调用，周回顾 ≤3 次；超过即弃权并记失败面）；后台召集合计花费走 cost_ledger 设每日上限，触顶当日不再召集非安全类例会，具体数值由 owner 定（先量一周现状基线，只低不高）；防抖即省钱；每条触发链独立 kill switch。**Copilot 学习者主动会话不计入、不设上限（YUK-1373 owner 裁决），本设计只约束后台召集。** Owner 否决条件七条见草案 §11（再产出待批阅长文、报成功却无实际变化、费用失控、第二总线、兜底降级成等例会、未批准触碰承重能力、危机或隐私进白板——任一出现即否决本设计）。

## 硬边界（后果）

1. **8 项 pre-AI 承重能力不削弱**（`docs/planning/2026-10-07-ts-migration-and-ui-rewrite-prep.md` §9）：FSRS 调度与选题 seam、掌握度 base 层与 calibration、统一题库与不可变 Judgment、OCR 确定性抽取、提议+确认+撤销、pedagogy 确定性 shortlist 与 today 兜底、运行日志与费用账本、housekeeping cron 语义。碰到它们的删减须 owner 明确批准。
2. **确定性兜底不可降级**：例会缺席/失败/弃权时，今日安排回落到现有确定性兜底（FSRS due 骨干 + today 兜底），练习流永远不依赖例会可用。
3. **危机与隐私永不进白板**：危机识别与支持是独立协议（YUK-1398），例会不诊断、不排队、不降级它；finding 只引用证据 id 不复制私密正文，派生读取遵守用途边界（YUK-1408 方向）。
4. **不出现第二事件总线或第二 proposal inbox**：白板=投影、触发=manifest 订阅、执行=现有队列/DAG——「不加平行总线」是验收项。
5. **学习者可见面只有一个决定**：其余全部留板默认不推；维护类内部建议永不推给学习者；白板对 owner 默认只读可见。
6. **`docs/superpowers/` 是 owner 的愿景语料，不是可归档的流程历史**：S13-A01（docs/superpowers 历史流程语料，DELETE/W0）执行时，其「将有效决定归并进现行 ADR」的路径对本 ADR 成立——但愿景与设计文档（vision §11–§13、panel design、integration capstone、X-algorithm mapping、phase0 plan）必须保留为**活跃参考**，不得随历史语料一起退出默认上下文或降级为仅归档索引；它们是本决策与后续 panel/教学法工作的语义来源。

## 分阶段交付（对齐 AGENTS.md 交付阶段）

1. **帮助靠谱（W1）**：白板投影 + finding 事件类型（只读管理页）；T1/T3/T4 接通，补 wrong-streak producer；主席只做可拒绝的短诊断/探针决定；nudge/chip 改 typed 动作；失败面与 YUK-1409 合流。
2. **按真实时间安排（W2）**：主席接管今日安排（canonical stream + parity 证明后退役 coach_daily）；T2/T5/T6 接通；A47 迁普通供题、A38 停夜写、A02 删除、A25 完成 census 后删除。
3. **说清不知道并检验（W3）**：finding 全面携带 confidence/unknown 与「不知道什么」；白板成为「系统对我会不会的判断」的唯一解释面；猜想→探针→独立检查闭环在白板可追；expected_effect 进对照集。

## 被拒绝的备选

- **「事件取代时钟」的单层方案**：逐事件开会与现有逐事件订阅撞车且浪费——改为 D2 三层。
- **白板作为新存储/第二总线**：双写漂移、更正协议全要重造——改为 D1 投影。
- **主席写一段综合文字**：正是 coach_daily 的失败模式（模型 success、today_plan=null）——改为 D3 typed 决定 + 回读验证。
- **完整 swarm / 多轮辩论 / N>2**：owner panel 设计已拒（MAST），本 ADR 不复活。
- **保留 A25 影子线等翻转证据**：其对照问题已被新结构回答，保留只是保留一条无消费者的第二编排线——按 D4 删除（先 census）。
- **删除确定性夜会 `research_meeting_nightly`**：它是 owner 批准的 Phase 0 关系脑且 CODE-LIVE（YUK-405/406，YUK-406 的验收由 YUK-1449 承接）——保留并升级为阈值触发的协调中心。

## 未决问题

- 防抖参数初值（连续错几题召集、考试窗口多大、日兜底几点）是工程判断，待真实使用校准。
- 主席是否处处需要模型：T6 设置变更很可能纯确定性就够；T1「上探针还是给帮助」也许确定性规则更好——先按「能确定性就不调用模型」实施。
- 每日后台预算数值：现状夜链日均花费基线未量，先量一周再定（owner 定值）。
- A38 EZ 轴信号是否值得恢复：待可靠 RT 与个人对账，可能永久退役。
- scout 外部取证的独立价值：取决于 census 结果（D4.3）。
- 白板对 owner 的透明度 UI 形态（管理页形态、是否设「教研白板」页签）：UI 阶段决定，遵循设计 pre-flight。
- 与 pg-boss→DBOS 家族迁移的交接面：迁移顺序可能调整各阶段落地顺序，不调整处置结论。
- 真实效果全部未知：没有真实使用前，finding→决定→学习收益的任何数值都是预注册假设，不是承诺。
