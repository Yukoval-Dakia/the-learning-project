# AI pipeline re-think · 现状地图（understand 阶段）

**Date**: 2026-06-15
**Status**: Grounded current-architecture map（understand，不设计应然）
**生成**: workflow `ai-pipeline-current-map`（7 agent / 942k tokens / 170 工具调用，6 路并读 + 1 综合，全 opus，含 file:line 核验）
**触发**: owner——主 rethink 重想了 AI 的「逻辑」（每个引擎算什么，B1-B5），但 AI 的「pipeline」（怎么被调用/编排的机器）从没当一条轴拍过。本文是补这条轴的 understand 底图。

---

> **Supersession note (2026-06-15)**：本文是 understand 阶段快照。其「B1 校准代码侧零」类判断在 B1-W1（PR #414）后已 stale——仓库现已有 `mastery_state` / `item_calibration` / `ItemPriorTask` / θ̂ 更新接线。选题/校准/供给的应然实施序见 `docs/superpowers/plans/2026-06-15-personalized-calibration-roadmap.md`（YUK-361）。本文留作历史 pipeline 证据，非当前状态。

## 一句话现状

AI 调用走**三条互不共享路由层的独立漏斗** + 一个统一 runner 收口最大那条。**主漏斗**：27+ 个 AI task 在 `src/ai/registry.ts` 声明 task×model（实跑几乎全是 xiaomi/mimo-v2.5* 文本或多模态），经 `providers.ts:resolveTaskProvider` 解析端点/key，再经 `runner.ts` 三入口（runTask/runAgentTask/streamTaskCollecting）spawn Claude Agent SDK 子进程。编排发生在两个面：① **Hono route 同步面**（copilot chat SSE、review、plan 请求内直接 streamTask）；② **pg-boss worker 异步面**（OCR extract、auto_enroll、quiz_gen/verify、sourcing、variant、记忆 brief regen 等 durable job）。两面共用同一 runner + cost/run 留痕三表（ai_task_runs/cost_ledger/tool_call_log）。**另两条漏斗完全绕开统一路由各自硬编码**：记忆个性化层（mem0 → GLM-5.2 reconcile + 百炼 embedding，写死在 `memory/client.ts`）和 OCR 录入引擎（glm-ocr via ZHIPU，`EXTRACT_OCR_ENGINE` glm 默认/tencent 兜底）。

**整体形态**：「逻辑」侧（每个引擎算什么）被 B 系/ADR-0034~0039 主 rethink 全面重想；但「pipeline」侧（调用怎么发起、编排成什么形状、横切基建可信度）多半没被当一条轴重想——成熟的部分是既有工程沉淀，缺口的部分要么是 rethink 拍了数学但 pipeline 零实现，要么是结构性失明从未补。

---

## 六阶段现状（logic vs pipeline）

| 阶段 | 现状 | logic vs pipeline |
|---|---|---|
| **抽取** | 单 handler `processOneOcrJob` 三层分层流：逐页 OCR（字符+figure bbox）→ OCR 结构降为 hint → VLM 看全部页+hint 产跨页结构树（**VLM 是结构 SoT**）。默认 glm-ocr，tencent 永久兜底。VLM 失败回落 OCR per-page（永不硬失败）。成功后 inline fan-out auto_enroll | 逻辑（OCR-first/VLM-fallback）当 scope 铁律拍过；pipeline 机器健康。半截：①**命名漂移**（全链叫 tencent_ocr_extract 但默认引擎是 GLM）②auto-enroll 标注链**默认 observe-only 空转**（flag 默认 OFF，每 block 跑 LLM 只写审计零 domain 写入） |
| **生成** | **三条入库方向不一致并存**：quiz_gen→verify→promote（最成熟）/ sourcing→verify→promote / **variant_gen accept-first**（写 proposal→人 accept→materialize→verify，验证在已 active 之后=信任倒置）。**无单一 verify router**，四 verify handler 各自 result schema | 逻辑 rethink 拍透（ADR-0038/0039 + note_verify Amendment）但**全标 Phase 2 follow-up，代码零落地**。pipeline 仍是 pre-rethink 旧形态。连最易的 QuizVerify 'error' 通道也未实现 |
| **诊断校准** | 判分编排健康（双路由器 + JudgeInvoker + attempt→event 单 tx）。但 mastery 是纯 SQL 派生 view（180天窗+30天半衰期加权正确率，`evidence<3→0.5` 占位）。**慢热自校准四阶段代码侧存在感为零** | 判分编排 rethink 没碰、健康。但 event→mastery 派生被 rethink 要全面推翻（→mastery_state+PFA+慢热四阶段），**pipeline 零新实现**。grep `item_calibration/mastery_state/Urnings/fixed-anchor` 在 src 下**零业务命中**（全在 design doc）。无 Python 微服务、无 calibration task、难度唯一载体 `question.difficulty` 静态 integer 无回写 |
| **D14 编排** | `runCopilotChatImpl` 唯一编排者（chat\|chip × stream\|non-stream）。两层有限轮：**SDK maxTurns=6 + maxToolCalls=10 软停**（+ per-dim cap 250 nodes/1000 events）。context 四通道，五防注入有命名单测。copilotTools 经 manifest 贡献制启动期聚合进 DomainTool registry，全 mutation propose-only。SSE parse-before-stream | pipeline 机器成熟（architecture-redesign D14 + M5 teardown 产物）rethink 没碰——**正是新 pipeline 轴该映射但没拍的机器**。半截：①**超轮当 crash**（maxTurns=6 溢出 → SDK error_max_turns → runner 当崩溃，无 summarize-continue/re-prompt/UI affordance）②6 vs 10 双天花板不同步 ③copilotTools 贡献制**只半接线，worker 进程仍靠 bootstrap 全量注册** ④primary_view 走 HTML 注释 out-of-band 避开 SDK outputFormat（注释称 mimo 端点未证） |
| **记忆 mem0** | mem0ai/oss 运行时（P1 换血 GLM-5.2+百炼）。写：每 writeEvent→outbox→cron 批 50→addEventMemory(infer:true，**项目侧零 accept gate**)。reconcile（P2 已落地）：新记忆→search 邻居→GLM 判 KEEP_BOTH/SUPERSEDE/MERGE/RETRACT→write-ahead log→软取代 | pipeline 机器存在 rethink 没碰（记忆架构 design doc 落地）。P1 写血/P2 调和完整。**真半截：P3 读路径零实现**（grep searchMemories 在 src 零命中）——软取代标记目前**惰性写而不读**，已 SUPERSEDE 的旧记忆仍被两读点照常返回 |
| **横切基建** | 模型路由中央 task×model 映射**只覆盖主 funnel 1/3**（记忆/OCR 各自硬编码绕开）；provider union 5 个只 anthropic+xiaomi 真接线。prompt 装配成熟（profile-injected builder + subject-neutral + skill 动态加载三档）。护栏：DomainTool 预算真生效、maxTurns+timeout 真生效 | 逻辑侧 rethink 没把「哪引擎用哪模型/怎么演化/同步 route vs worker job」当轴拍。**成本可观测是结构性失明**（见下）。registry 模型选型注释（Sonnet 主力/Haiku 兜底/Opus 顶级）与实跑（全 mimo-v2.5*，无一 anthropic 真用）**完全漂移** |

---

## 已坏/半截（broken_or_half，带 file:line）

- **成本可观测对 99% 调用恒 0**：mimo 任务 `cost_ledger.cost` 恒 0（runner.ts:62-64 注释自承 mimo 端点不回 total_cost_usd）；`tool_call_log.cost` 恒写 0；**整条记忆 funnel 对三表一行不写**（grep src/server/memory cost_ledger 零命中，纯黑盒）；`cost_ledger.cost` 单 real 列混 USD（mimo 恒0）+RMB（GLM-OCR），admin SUM(cost) 出无意义数。
- **rate-limit 写好零接线**（rate-limit.ts:49 零生产调用）；**maxCost/fallbackChain phase-deferred 标 INACTIVE**（registry.ts:14-39）；**outputFormat seam 全仓零用量**。
- **慢热校准四阶段纯空地**（src 下零业务命中）。
- **mem0 P3 读路径零实现**（软取代标记惰性写不读）。
- **auto-enroll enroll 真入库分支生产从未跑**（flag 默认 OFF）。

---

## 决策输入（pipeline 缺口，待逐项拍）

1. **慢热自校准四阶段编排的 pipeline 载体怎么建**——纯空地零实现。载体待定：纯 Node 内联 vs Python 微服务侧车；calibration task 进 registry；新表 mastery_state/item_calibration。全是新 Linear/新表。
2. **AI 成本可观测怎么从「99% 恒 0」变可信**——烧钱标定栈上线前的地基：mimo 按 token×单价本地折算 / cost_ledger 加 currency 列归一 / 记忆 funnel 接 writeCostLedger / tool_call_log per-tool 成本。
3. **三条独立 AI funnel（主 mimo / 记忆 GLM / OCR glm-ocr）该不该统一到一个路由层**——与成本可观测耦合。
4. **三条生成链方向相反怎么收敛到统一 verify 契约**——逻辑已 rethink（ADR-0038）但 pipeline 零收敛（variant accept-first 反模式、四套异形 result schema 原样未改）。
5. **copilot → 真正全能**（owner 2026-06-15 拍方向，成本不计）——三子决策：①够得着全部 task（通用 task 调用 vs 包更多工具）②异步长程（不被 6 轮掐 + 超轮一等处置）③**写隔离 = checkpoint 草稿层**（详见 `2026-06-15-copilot-agentic-checkpoint-draft-layer.md`，design-in-progress）。

---

## 给 decide 阶段的提示

- **「逻辑已重想 vs pipeline 没建」是本轴主轴线**：B 系拍了数学，但 mastery_state/慢热校准/统一 verify **代码零落地**——pipeline 实施本身就是 Wave 0-2 的主体。
- **成本可观测（#2）是横切前置**：任何烧钱栈（慢热校准 LLM ensemble、copilot 全能长程）上线前，「这周烧多少/哪引擎产的」必须可信，否则 runaway 不可观测。
- **copilot 全能（#5）是 owner 当前主攻**：checkpoint 草稿层已单独落 design doc，conflict 语义 + diff 面 + 够得着全部 task + 异步长程 待续。
