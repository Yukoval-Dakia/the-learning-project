# 教研团 · 教学法脑定稿 + 三脑合一 + SDK 原生实现 + 实施起点（capstone）

- **date**: 2026-06-18
- **status**: design capstone（三颗心脏深挖收口）
- **配套**: 愿景 `2026-06-18-private-teaching-research-team-vision.md`；panel `2026-06-18-jiaoyantuan-deliberative-panel-design.md`；抛弃归档。

> ⚠️ **2026-06-18 修正（YUK-416，DEFERRED）**：§1 的「mimo+Opus 模型异质 de-bias」+ cross-provider wrapper **已 defer**——唯 GPT 5.5 是 Opus 双强 peer 但未接 lane。panel 现跑单 lane Opus（adversarial-role + prompt-prior + SELECT-not-fuse，**更 SDK 原生**：同 provider 用 `Options.agents` map，不需 wrapper）；mimo 降为便宜 prompt-step；Phase 0 关系脑 Jury D2 校准改用 Opus self-consistency + owner 锚。重启见 YUK-416。

---

## 0. 教学法脑定稿（Phase 3）
- = 规划 panel 里**组长选完节点序列后的一个方法选择审议步**（不是新系统、不是平行 panel、不延后 v2）。
- **三段式**：确定性 `policy()` 收窄合法候选（type 层裁掉禁忌——`misconception_present` 时 `more_drill` 根本进不了候选）→ panel 在候选内 SELECT（教研员 A/B 提、魔鬼代言人用 `contraindicated_when` 开火、组长 SELECT-not-fuse）→ B5 verify 卡禁忌 → method 注解作 `draft_status` proposal 落备课台。
- **8 方法封闭枚举 palette**（`worked_example`/`completion_problem`/`open_problem`/`contrasting_cases`/`refutation`/`interleaving`/`reconstruction`/`socratic`）住 `src/core/pedagogy/method-library.ts`；每条带 `indicated_when`/`contraindicated_when` StateGuard + `evidence_refs`。
- `policy()` 只 key `θ̂ band / precision band / misconception_present / kc_is_rule_based`——**type 层装不下 style label**。
- **v1 不学 efficacy**（n=1 喂不满）；schema 锁住将来能加（method×粗bucket Beta + 证据先验 + 宽-CI abstention）。
- **三道机械锁防 learning-styles**：① type 锁（StateGuard 只能 key state）② **CI 扫描锁**（新增 `audit:no-learning-styles` denylist gate，接 `pnpm test`）③ 单测锁。**这是 v1 必做红线 gate。**
- **最 judge-dep**：R-PREC 闸门（低 precision → 加宽 scaffolding + `confidence='low'`）、efficacy 先 bootstrap 在客观可判子集、owner-correction 金锚。**kill 线**：若 misconception 信号噪声大到 R-PREC 永远压到保守集（退化成「永远 worked_example」）→ 退回 `teaching-skill.ts` 只选 turn-KIND，等 judge/calibration 成熟再启。
- `reconstruction` 是 palette 一项（对齐 **YUK-407**）。

## 1. SDK 原生实现裁定（核了 `sdk.d.ts` 0.3.168，**回溯适用于 panel**）
- **原生支持（直接用，别 hand-roll）**：`Options.agents: Record<string,AgentDefinition>`（异构 subagent，各自 prompt/tools/**model**/mcpServers/effort/maxTurns/disallowedTools）；in-process MCP（`createSdkMcpServer`）；context 隔离 + 并行；structured output（`outputFormat`）；hooks tracing。
- **非原生（必须留薄 wrapper）**：**per-subagent provider/auth**。`AgentDefinition` 只有 `model`、无 env/provider；`env` 在 `Options` 级且文档明文「**整体替换 subprocess 环境，不与 process.env 合并**」；上游 issue #25146「per-agent multi-provider」**closed-not-planned**。→ **跨 provider 异构（mimo + anthropic-sub 同一审议 = de-bias moat）只能用 per-call `runAgentTask + override`**（各 panelist 各自 `query()` 各自 env）。
- **拓扑裁定**：默认 **handler-orchestrated**（多 `runAgentTask` + `Promise.all`，复用 `selection-orchestrator.ts`）——因为跨-provider de-bias 是 moat + 可测 barrier + StructuredOutput 疤痕要求；同-provider 子步（如全 Opus verify）可用原生 `agents` map 拿真并行隔离。
- **runner 待补小接缝**：`RunTaskCtx.agents?` passthrough（NO-OP when omitted，照 `outputFormat` 接缝纪律，零回归）。
- **回溯更正早先 panel 设计 D 节**（手搓 `runAgentTask` 编排）：同-provider 部分迁原生 `agents` map；跨-provider 部分**保留**薄 wrapper（genuinely 非原生，别为「全原生」删掉）；不造第二条 orchestration 路。

## 2. 三脑合一（一个例会 job + 一张备课台）
三颗心脏住在**同一个夜间 sleep-time 例会 job**（clone `dreaming_nightly.ts`），产出汇成**同一张备课台**（proposal-as-event + 三层渐进披露）：

```
夜间教研例会 job（关系脑 Phase 0 已落地的宿主，确定性闸门按需触发 panel）
 ├ 关系脑(Phase 0, prompt-step)   复盘 event → ≤3 conjectures（关于你大脑的信念）
 ├ 规划 panel(Phase 2)            教研员A‖B 提计划 → 魔鬼代言人挑路线 → 组长 SELECT 节点序列
 │                                （conjectures 喂进规划输入；产 predicted_* → 确定性对账 → 分桶 credit）
 └ 教学法脑(Phase 3, 同 panel 续一步) 对每个选定节点：policy 裁候选 → panel SELECT method → B5 verify
 │                                （method 注解参数化 teaching-skill.ts / resolveNoteSkill：投递层知道用哪种 pedagogy）
 → 汇成备课台：≤3 浮现 + 一个 dissent badge，owner 采纳/改/不要 → 落 calibration 锚
```
- **共享底座**：event log + proposal-as-event + mem0 CORE（copilot 无写权）+ provider lane（YUK-365）+ evidence-log 三表 + 确定性闸门。
- **三轴正交守恒**：规划/教学法只决「学什么 + 怎么学」；**FSRS（R 轴）单写者不被污染**，method 对「何时」一律 defer FSRS。
- **相位**：Phase 0 关系脑（无硬前置）→ Phase 2 规划 panel（依赖 B1 YUK-348 / B3 YUK-349）→ Phase 3 教学法脑（最 judge-dep，依赖 misconception 成熟 + B5 verify YUK-350）。

## 3. 实施起点（真正能动手的第一步）
**Phase 0 关系脑 thin slice（YUK-406）= 唯一现在无硬前置、可干净起跑的。** 规划 panel / 教学法脑都 Phase 2/3，**硬阻塞于在飞的 B1（YUK-348）/ B3（YUK-349）/ misconception / B5（YUK-350）**。

→ **建议第一步**：把 **YUK-406 Phase 0 写成实施 plan（superpowers writing-plans）+ 拆 sub-issue**，先把「夜间例会 job + conjecture 引擎 + 备课台（与 YUK-403 `/review` 统一）」端到端跑起来，两周 alive/kill 验（你会点开 / conjecture 确认率非退化 / 不变 backlog）。规划 panel 的 `RunTaskCtx.agents?` 接缝 + SDK 原生迁移在 Phase 2 接线时做。

## 4. 待 owner 决策（汇总，多数 Phase-2/3 落地期）
- **Phase 0（现在）**：第一学科实例（数学/理科可核对域=共识）、冷启动门 N、触发 cron vs inactivity、备课台是否就用 `/review` 统一面。
- **教学法脑**：冷启 precision=1 闸 / method 注解落 `practice_stream_item` vs plan step / `misconception_category→flawed-model` 映射（per-profile）/ efficacy 开闸时机 + owner-correction 加权。
- **panel**：挂 `coach_weekly` vs 新 job / 闸门阈值 / per-run cost cap $ / A&B prior 轴。
- **Phase 2/3 何时 greenlit**（决定 Linear epic 现在建还是等 B3 落地）。
