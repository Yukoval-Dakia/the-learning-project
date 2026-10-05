# YUK-346 — 主 agent mimo → GLM 可行性评估（actual-output 对照）

**日期**：2026-09-22
**状态**：评估完成，推荐「按 task 分级渐进」而非全量换
**基线 rev**：`8c14cedf4`（post-P4，`PiAgentAdapter` 唯一引擎）
**探针**：`src/server/ai/mimo-vs-glm-actual.db.test.ts`（真实 provider 调用 + testcontainer Postgres；CI 无 key 自动 skip）
**证据**：`docs/planning/evidence/2026-09-22-yuk346-*.json`（14 份，含 task_run_id / usage / cost / 输入输出 digest）

## 结论（TL;DR）

**GLM-5.2 作为主 agent 文本类任务的模型在技术上可行**：同一 pi 引擎、同一条 Anthropic-compat 通路（`open.bigmodel.cn/api/anthropic` + `ZHIPU_API_KEY`），`ctx.modelBinding` 显式 pin 即路由成功；判分 / 归因 / 教学三类任务输出质量与 mimo 持平（judge 满分口径一致、归因类别一致、教学正文质量持平或更结构化），时延同量级，边际成本为 0（coding plan 订阅内）。

**但不建议现在全量换**，四个具体约束：

1. **P4 回归先行**：pi adapter 把 `maxIterations:1` 映射成确定性 `error_max_turns`（两条 lane 都中招，~31 个 task kind）。与 GLM 无关、与任何 provider 都无关——已开 **YUK-1026**，不修它换谁都一样挂。
2. **视觉任务必须留 mimo**：catalog 里 glm-5.2 是 text-only（`attachment:false`）；MultimodalDirectJudgeTask / StepsJudgeTask / VisionExtractTaskHeavy 走图的 lane 只能留 mimo-v2.5-pro，或先补 glm-5.3-flash（`attachment:true`）的视觉证据再议。
3. **Sourcing schema 合规出现一次滑点**：glm-5.2 产了 `extraction_hash:null`（schema 要 string）——单样本、方向性信号，不是定论，但工具产出物的 strict-parse 容错率需要更多样本确认。
4. **编排者本体没测**：本探针覆盖代表性 AI task，不含 CopilotTask 编排 loop（piHooks/subagent/compaction 面）。换编排者前需要专项探针。

**推荐方案**：先修 YUK-1026 → 文本类后台任务（Attribution / TeachingTurn / SessionSummary / Judge 类）灰度 glm-5.2 → 视觉与 Copilot 编排留 mimo → glm-5.3-flash 作为 cheap-tier 候选补证据后纳入分级表。`AI_PROVIDER_OVERRIDE` 目前只支持 `anthropic-sub`，全局切换面如需 zhipu 值要另开实施票（本票不迁移）。

## 评估点逐项

### 1. 质量回归（工具调用稳定性 / 中文文言文）

探针选品：SemanticJudgeTask（语文文言文翻译判分）、AttributionTask（数学归因，mimo 已知时延压力点）、TeachingTurnTask（文言虚词教学 turn）、SourcingTask（needsToolCall 真工具循环，domain read tools + Exa remote MCP）。

| Task | lane | wall | in/out tok | parse_ok | 备注 |
|------|------|------|-----------|----------|------|
| SemanticJudge | mimo-v2.5-pro | 4.6s | 718/103 | ✅ | correct/1.0，3 个 required_points 全中 |
| SemanticJudge | glm-5.2 | 6.4s | 699/139 | ✅ | correct/1.0，rubric 逐字对齐 + 等价表述 notes |
| SemanticJudge | glm-5.3-flash | 5.6s | 699/229 | ✅ | correct/1.0，matched_points 引用学生原句（grounding 最细） |
| Attribution | mimo-v2.5-pro | 10.3s | 1006/378 | ✅ | primary=calculation + execution_slip，conf 0.85 |
| Attribution | glm-5.2 | 5.6s | 963/293 | ✅ | 同归因结论，且实际回代验算（4²−20+6=2≠0），conf 0.7 |
| TeachingTurn | mimo-v2.5-pro | 8.1s | 926/173 | ✅ | explain，口诀式四关系辨析 |
| TeachingTurn | glm-5.2 | 11.7s | 881/201 | ✅ | explain，结构化枚举 + 判别流程，内容正确 |
| Sourcing | mimo-v2.5-pro | 23.8s | 22.2k/532 | ✅ | query_knowledge(domain 桥) + Exa remote → 真题+schema 干净 |
| Sourcing | glm-5.2 | 16.6s | 22.3k/466 | ❌ | 跳过 domain read（knowledge_context 已够）→ Exa → 真题但 `extraction_hash:null` |

判读：

- **文言文/中文域无回归**。judge 三家一致判 correct 且 evidence 全部落在 required_points 内；teaching 两家都给出正确的「而」四关系辨析，GLM 结构更完整。
- **工具调用链在 GLM 上真实工作**：domain 工具桥（第一轮 placeholder fixture 时 glm-5.2 正确调用 `expand_knowledge_subgraph` 并按「不确定不编造」策略返回空结果）与 remote Exa MCP（语义化 fixture 下 glm-5.2 产出真实 `source_url`/`extract`）两段都实证。GLM 跳 domain read 是 judgment 差异不是不稳定——knowledge_context 已含语义锚点。
- **一次 schema 滑点**：glm-5.2 sourcing 输出 `extraction_hash:null`（应为 string）→ parse_ok=false。mimo 同任务 schema 干净。单样本，需要更多 sourcing 样本才能定性为稳定性差异。
- **parse_ok=false ≠ 模型差**：第一轮 placeholder KC fixture 下两家都按「不确定不补题」策略返回空 questions，撞上 schema 的 empty-result 自定义校验——fixture 语义度的问题，不是能力问题（证据见 run 1 文件已重写，最终版 fixture 为「因式分解法解一元二次方程」）。

### 2. provider 接法（anthropic vs openai compat）—— P4 后已是定局

ticket 写作时担心的「SDK 吃不吃 openai 形态」已不存在：Claude Agent SDK 退役后 `PiAgentAdapter` 是唯一引擎，`PROVIDER_PI_CATALOG_SPECS`（`providers.ts:298`）把 **xiaomi / zhipu / anthropic-sub 三条 lane 统一编译成 `anthropicMessagesApi()` 自定义 provider**（`pi-models.ts:99-125`）。

- **zhipu lane 已接线且本探针实证**：`PROVIDERS.zhipu` = `open.bigmodel.cn/api/anthropic` + `ZHIPU_API_KEY`（key 作 anthropic key 转发）；catalog bucket `zhipuai-coding-plan` 含 glm-5.2 / glm-5.3-flash 等。`ctx.modelBinding={adapter:'pi',provider:'zhipu',model:'glm-5.2'}` → `profile_source:'binding'` 正常 resolve、执行、落 `ai_task_runs`。
- **openai-compat 形态只在 opencode-go lane**（pi builtin，`opencode.ai/zen/go`，`OPENCODE_API_KEY` + `x-opencode-session` 头）——那是另一套订阅端点，与 GLM coding-plan anthropic 端点互斥，二选一即可，无需并存。
- **glm-5.2 是 coding-plan 专属**：标准 `/api/paas/v4` 端点 403（providers.ts 注释），所以接法没有备选——就是现有 zhipu lane。

### 3. 成本 / 时延

成本（单次探针 run，evidence `cost` 字段）：

- mimo-v2.5-pro（metered 公价 pricebook）：judge ~$0.0004、attribution ~$0.0008、teaching ~$0.0006、sourcing ~$0.0037。
- glm-5.2 / glm-5.3-flash（coding plan）：catalog 费率全 0 → `cost_basis=unpriced`，订阅内边际成本 $0。

→ **量级上 GLM 全胜**：主 agent 全量任务每天若数百~数千 run，mimo 按量计费 vs GLM 订阅内零边际成本。⚠️ 注意 coding-plan quota 是按交互式编码负载设计的，~42 个 task kind 的后台 AI 负载能否吃下需向套餐配额核实——探针回答不了运营配额问题。

时延（wall_ms，单样本）：

- 无系统性回归：glm-5.2 在 Attribution（5.6s vs 10.3s）和 Sourcing（16.6s vs 23.8s）更快，在 TeachingTurn（11.7s vs 8.1s）和 Judge（6.4s vs 4.6s）更慢。glm-5.3-flash 与 glm-5.2 同量级。
- 09-19 封存的 mimo Attribution ~57-60s 贴边 60s budget 本次**未复现**（10.3s）——应为当日端点拥塞而非固定画像，但说明 mimo lane 有尾部时延波动史。
- glm-5.2 binding `defaultEffort:'high'` → 产出 thinking block（evidence `thinkingBlocks`），重任务会加时延；时延敏感 kind 可用 `modelBinding.effort` 调低（glm-5.2 仅支持 high/max；glm-5.3-flash 支持 low/high/max）。

### 4. 全换 vs 按 task 分级

**推荐分级，理由如下**：

| 分级 | 模型 | 依据 |
|------|------|------|
| 文本后台任务（Attribution/Teaching/Judge/Summary/Tagging 等） | **glm-5.2 可入** | 质量持平、零边际成本、时延同量级 |
| 轻量/cheap-tier | glm-5.3-flash 候选 | judge 实测持平且 grounding 最细；binding 已标 `budgetClass:'cheap'` + `timeoutClass:'durable-heavy'` |
| 视觉/多模态任务 | **留 mimo-v2.5-pro** | glm-5.2 text-only；glm-5.3-flash `attachment:true` 但无视觉任务证据 |
| Sourcing/工具产出物 | 暂留 mimo 或加 retry | GLM 出现一次 `extraction_hash:null` schema 滑点，样本不足 |
| Copilot 编排者本体 | **本票未覆盖** | needsToolCall+piHooks+subagent+compaction 面需专项探针 |

## 附带发现：P4 lane 级回归（YUK-1026）

探针第一轮 5 个 `maxIterations:1` 任务（judge×3 + teaching×2）**全部** `error_max_turns`，含 mimo 现网 lane——与 provider 无关。机制：`pi-agent-core` 的 `shouldStopAfterTurn` 在每个已完成 turn 后无条件回调，adapter 闭包 `completedTurns>=maxTurns` 即 cap → maxTurns=1 时第 1 turn 必被误杀（模型实际已产出 100-212 tokens 的干净答案）。SDK 时代 maxTurns=1 =「最多 1 turn」，单 turn 答案是成功。这是 YUK-800 的确定性回归版（SDK 时代 ~42% 概率性 → pi 时代 100%）。影响 ~31 个 task kind。探针以 `budgetOverride.maxIterations:4` 相位隔离出真实质量信号（5/5 success + parse_ok），as-configured 相位证据独立封存为 `*-asconfigured.json`。**这是换不换 GLM 都必须先修的 blocker。**

## 证据索引

`docs/planning/evidence/`（rev `8c14cedf4`，2026-09-22 实测）：

- `2026-09-22-yuk346-semanticjudgetask-{xiaomi-mimo-v2.5-pro,zhipu-glm-5.2,zhipu-glm-5.3-flash}.json` — 放宽预算相位（质量信号）
- `2026-09-22-yuk346-semanticjudgetask-*-asconfigured.json` — as-configured 相位（YUK-1026 证据）
- `2026-09-22-yuk346-attributiontask-{xiaomi-mimo-v2.5-pro,zhipu-glm-5.2}.json`
- `2026-09-22-yuk346-teachingturntask-{xiaomi-mimo-v2.5-pro,zhipu-glm-5.2}.json` + `*-asconfigured.json`
- `2026-09-22-yuk346-sourcingtask-{xiaomi-mimo-v2.5-pro,zhipu-glm-5.2}.json` — 含 `domain_tool_calls`（tool_call_log）+ `remote_exa_evidence`

每份含：code_revision、task_run_id、status/finish_reason、wall_ms、usage（含 thinkingBlocks）、cost（basis+ref）、input/output sha256 digest、parse_ok/parse_error。

## 方法与局限

- 真实 provider 调用 + testcontainer PG（ai_task_runs / tool_call_log 落库核对），CI 无 key 整体 skip。
- **单样本每格**：结论是方向性，不是统计显著。尤其 sourcing 的 schema 滑点需多样本复核。
- SemanticJudge/TeachingTurn 的质量信号来自放宽预算相位（`maxIterations:4`）；as-configured 结果独立记录。
- Sourcing fixture 为合成 KC（语义名「因式分解法解一元二次方程」）；Exa 结果随公网内容波动。
- 未覆盖：CopilotTask 编排 loop、视觉任务、glm-5.3 旗舰、长会话 replay/compaction 面、coding-plan 配额承压。
