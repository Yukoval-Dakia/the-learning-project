---
status: proposed
---

# ADR-0071 — AI provider/model fallback chain：主通道故障时按链换通道，不重复执行、不乱花钱

**Status:** Proposed（设计方向，2026-10-11）；尚未实施，先独立评审。
**Decision source:** owner 2026-10-11 「fallback能力也要做，支持fallback chain——按provider/model fallback。」；TEST 两起真实事故（见背景）。
**Tracking:** [YUK-1474](https://linear.app/yukoval-studios/issue/YUK-1474)。
**Related:** ADR-0065（pi 执行与回放）、ADR-0069/0070（同期拍板）；[YUK-1123](https://linear.app/yukoval-studios/issue/YUK-1123)（vision-judge fallback 绕 pin）、[YUK-1445](https://linear.app/yukoval-studios/issue/YUK-1445)（判分准入）、YUK-924（model profiles 能力门）、YUK-1341（mimo-v2.6-pro 工具环证据）、YUK-365（全局 provider pin）。

## 背景与问题

两起 TEST 事故坐实缺口：①10-07 23:06 → 10-10 09:54 JST，`opencode-go` 配额耗尽（`429 Go usage limit`，Retry-After 约 53 小时），109 个后台任务逐个撞死在同一通道上——没有任何机制读 Retry-After 或冷却；②10-11 05:30–05:48，小米通道约 20 分钟 503/429，8 个 run 失败。现状（代码核实）：`resolveTaskProvider`（`src/server/ai/providers.ts:596`）只有单点决议——chat env pin（`AI_PROVIDER_OVERRIDE`/`AI_PROVIDER_MODEL`）压过一切显式与 DB 绑定，无链；唯一跨通道重试代码是 vision judge 的专用旁路（`src/capabilities/practice/server/judge/provider-lane-fallback.ts`，整任务重跑形状，YUK-1123 要修的对象），但其分类器只认 `'api_error_result'`（`provider-lane-fallback.ts:40-42`），现役 pi lane 的 provider 失败不产生该 subtype——对所引事故类失败从不生效；且现役 pi lane 上 provider 的 429/5xx/连接失败以 `subtype:'error_during_execution'` 到达 runner（`pi-agent-adapter.ts:682-693`），被 `isTransientAgentFailure` 判为永久失败（`agent-run-error.ts:184-186`），连同通道的进程内重试也不触发。即现役**没有任何生效的跨通道或同通道重试**；provider 侧 Retry-After 从不被解析（全库只有我们自己在响应头**设置** Retry-After）。多 provider 支持本身保持不变，本 ADR 在其上加有序 fallback 链。

## 决定

### D1 链配置：按 lane/task kind 的有序 `{provider, model}` 列表；旧单 pin = 长度 1 的链

每条 lane（全局、vision judge、per-task kind）配置一个有序链。全局默认来自 env（如 `AI_PROVIDER_FALLBACK_CHAIN`，JSON 数组）；DB lane 行沿用现有优先级——全局 pin 保持 env kill-switch 恒压 DB（`resolveGlobalProviderSwitch`：env > `lane.global.*`，owner 裁决的 incident 语义不变），lane/task 级沿用 DB > env 同 key（`getLaneOverride` 现语义）。未配链时：现役 env pin / DB 单值 / registry 默认各读作长度 1 的链，现网配置字节兼容。启动期逐项校验：`resolveModelProfile` + `assertModelProfileCapabilityFit`（`model-profiles.ts:442`，needsToolCall/isMultimodal fail-closed）与凭证在场（`isProviderLaneReady`，`providers.ts:361`）；非法条目显式报告并**跳过**，跳过后链为空则按现行 config-error fail-closed。链仅在冷冷却与错误分类判定后前进，条目顺序 owner 随时可调。

### D2 粒度：agent loop 内**单次模型请求**级 fallback；工具绝不重执行

唯一跨链点在 `PiPreparedQuery.streamFn` → `deps.models.streamSimple`（`pi-agent-adapter.ts:1014-1027`）——根 loop 与嵌套子 loop 的每一次 LLM 调用都流经此处。fallback = 用下一链条目的 `PiModel`（`models.getModel` + 该条目自己的 apiKey/headers）对**同一份 llmContext** 重发本次请求：早前回合与工具结果原样留在 context，工具只在模型发 tool_call 时执行，重发 LLM 请求不会重跑工具。会话头按条目重置：`x-opencode-session` 只属于 opencode-go（`baseLoopConfig`，`pi-agent-adapter.ts:997`），跨链即按目标 provider 重建 header 包。链位置是 run 级单调前进（子 loop 与压缩回放沿用当前位置），绝不回退。**不新增第二执行路径**：ExecutionAdapter 仍只有 `'pi'`，链是 streamFn 的包装层。

### D3 错误分类：只在「确定未执行 / 确定未计费」时跨链；unknown-paid 永不跨链

跨链白名单（在 streamFn 包装层判定）：①发送前连接/DNS/TLS 失败（流确认零字节）；②429 配额或限速；③5xx 且零输出；④auth/配置错误（401/403/404-model 等）——跨链**同时报警**。不跨链：部分流已出、发送后超时、流中断但已有输出、一切付费效果未知的失败——维持现有 unknown-paid 规则：保留全额预留、停止、如实记录，`cost_basis='unknown'` 且 `cost_usd` 为 NULL（`ai_task_runs_cost_truth_ck`，`src/db/schema.ts:1575`，DB 层禁止 unknown 记 0）。代码事实：现役 pi lane 上 provider 失败以 `subtype:'error_during_execution'` 终态到达 runner（`pi-agent-adapter.ts:682-693`），不携带 `api_error_status`；`api_error_status===null` 混含流中断的 probe 结论（`agent-run-error.ts:11-12`）属已退役 SDK lane。故分类器必须在 streamFn 包装层直接读 pi 的错误面（`error` 事件 / `errorMessage` / `diagnostics[].error.code`），并以 pi 事件协议判「零输出」：`error` 事件先于 `start` 到达，或 `streamSimple` 同步抛出；一旦有事件交付给 loop 即锁死不可跨链。注意驱动内 `maxRetries`（`pi-agent-adapter.ts:1007-1009`）可能已在同通道重试过；runner 级 `isTransientAgentFailure` 白名单（`agent-run-error.ts:174`）保持不变，本分类器更严。唯一例外：per-task 显式 opt-in 的幂等读任务，由任务声明方自行担保重发安全。

### D4 冷却/断路器：PG 持久化，app+worker 共享；尊重 Retry-After；半开恢复

新表（provider+model 级，quota 信号升级为 provider 级）：冷却原因、截止时间、半开状态。冷却写读均走短事务，不在 provider 调用期间持锁——照搬 `provider_session_admission`（`provider-session-admission.ts`）的 PG 协调先例；**无 Redis**（架构既定）。429 带 Retry-After（如 53h）即冷却至该时刻，配额耗尽语义冷却整条 provider lane；链决议时先查表，已冷却条目**发起前**直接跳过——109 连拒的根因是「每次都照发」，冷却表让第二次拒绝发生在查表而非撞网。到期后半开：首个请求即探针，成功关闭、失败按退避再冷却。

### D5 门：判分只落准入模型；能力 fail-closed；embedding 不跨模型

- **判分/评级任务**：链条目必须挂在 YUK-1445 准入切片上（D17 `admitted_slice_id`，`src/core/schema/assessment/execution.ts:53-61`；未准入 ⇒ `unadmitted_model_executor`，escalation 只许 withhold/human_review）。链上无可用条目 ⇒ 按现策略标 undecided/withhold，**绝不让未准入模型静默判分**。
- **vision / 工具调用任务**：逐条目过 `assertModelProfileCapabilityFit`（'unknown' 即拒）。代码事实（`providers.ts` bindings）：toolCalling=true 已声明于 `xiaomi-token-plan` 的 `mimo-v2.6-pro`（`providers.ts:111-123`，YUK-1402 actual-output 证据）、opencode-go 的 `glm-5.3-flash`/`deepseek-v4-pro`/`mimo-v2.6-pro`、`zai-coding-cn` 的 `glm-5.3`、openai 的 `gpt-6-astra`；旧按量 `xiaomi` lane 的 `mimo-v2.6-pro` 无此声明（'unknown' ⇒ fail-closed）。Token Plan 证据不外推到按量或 OpenCode Go 同名模型（`src/server/ai/AGENTS.md`）——见 D9。
- **embedding**：不跨模型。向量空间随模型不同（DashScope `text-embedding-v4` @1024 维写死 Drizzle `vector(1024)` 列，`src/server/ai/embed.ts:18-19`），换模型即污染向量空间；走既有 direct-provider-attempt / `dashscope.embedding` admission lane 延迟重试。

### D6 成本：每次尝试按其所在 provider 的口径独立预留与记账；unknown 永不记 0

跨链把 run 切成多个服务段，每段按 `resolveAttemptCostTruth`（`attempt-cost.ts`）自己的 basis/ref 结算（reported USD / pricebook 或 pi-catalog 估算 / 订阅 contract-ref 估 0）。run 行 cost 三元组聚合规则：任一段 unknown ⇒ 整单 unknown（amount NULL）；否则各段求和、ref 注明段数与各段来源；混合订阅段（估 0）可安全并入。后台花费不设上限是 owner 决定，但每一笔都入账（§9-7 费用账本）。

### D7 可追溯：记请求链、实际服务方、跨链原因；provenance 指实际服务模型

run 行记录请求链与最终服务 provider/model（`ai_task_runs.provider/model` 已 NOT NULL）；每次跨链写一条事件：原因分类、错误状态、零输出证据、目标条目。判分 provenance 里的模型 = 实际服务段的模型。admin 读面（`providerAuthSurface` / admin-config-facts）扩链配置、冷却状态与**备份通道用量**。学习者侧状态行用平实措辞（如「主通道暂时故障，已用备用模型完成」），其 UI 归 Opus 线，不在本 ADR。

### D8 收编 YUK-1123：退役 vision-judge 旁路，走同一链同一门

删除 `runTaskWithLaneFallback`（`provider-lane-fallback.ts`，整任务重跑形状）与 invoker durable fallback 的 crossover 合并（`invoker.ts` 约 235-246）——它在现役 pi lane 上本就不生效；`VISION_JUDGE_PROVIDER`/DB `vision_judge` lane 升级为该 lane 的链输入（旧单值兼容为长度 1），vision judge 与所有任务同链同门同冷却。

### D9 默认链（提案）：`xiaomi-token-plan/mimo-v2.6-pro` → `opencode-go/mimo-v2.6-pro`

代码核实：①`xiaomi-token-plan` 是独立 provider（`providers.ts:111`，`XIAOMI_TOKEN_PLAN_API_KEY`，YUK-1402），与旧按量 `xiaomi`（`XIAOMI_API_KEY`）key 不互通，TEST 现役即此 lane；②两通道都有 `mimo-v2.6-pro`（text+image），同模型双通道成立，且两者各自的 toolCalling 声明都有自己的 actual-output 证据（Token Plan：YUK-1402；OpenCode Go：YUK-1341），故 needsToolCall 种类两个条目都可用，仍逐条过能力门；③旧按量 `xiaomi` lane 不在默认链（无 toolCalling 证据，且与 Token Plan 证据不互通）。其余通道（`anthropic-sub`、`zai-coding-cn` 等）仅凭各自能力/准入证据入链。顺序 owner 随时调整。

### D10 交付切片与验收

1. **离线故障注入**（OS 级网络阻断/本地代理，逐错误类一案）：跨链或不跨链的判定、预留与结算、工具零重执行、冷却被尊重（已冷却通道不被捶）、判分不落未准入模型、embedding 不跨模型。
2. **TEST 实跑**：主通道不可用（坏 base URL）时，一个后台任务 + 一轮 Copilot 在备份通道完成，回执含实际 provider/model、成本口径、跨链原因。
3. **边界协调**：与迁移线（DBOS / Start / budget transport）和特性线（YUK-1445 判分准入）对齐接缝；§9 八项承重能力不动；不新增第二执行路径（唯一引擎 PiAgentAdapter，链在 streamFn 包装层）。

## 硬边界（后果）

1. 只在确定未执行/未计费时跨链；unknown-paid 不跨链、不记 0（DB check 强制）。
2. fallback 单位 = 单次模型请求；工具与既有上下文绝不因跨链重执行或丢弃。
3. 判分只落准入模型，无可用即 undecided/withhold。
4. embedding 永不跨模型。
5. 冷却共享于 PG（无 Redis）；Retry-After 与配额信号必须尊重。
6. 环境单 pin 仍是 kill-switch（长度 1 链，不跨链）；唯一条目被冷却时链为空 ⇒ fail-closed，pin 不能绕过冷却。
7. §9 承重不动；花费不设上限但全额记账；不为链可用性绕过 YUK-924 能力证据门。

## 被拒绝的备选

- **整任务级 rerun**（现 vision-judge 旁路的形状）：丢弃已产出上下文、重复执行风险、双倍计费面——被 D2 单请求粒度取代（YUK-1123 退役原因）。
- **扩展现有 runner transient retry 为跨 provider**：它是 same-target、call-site opt-in 且 pinned routing 下关闭（`hasGlobalProviderOverride`），粒度与动机都不匹配 109 连拒。
- **Redis 冷却**：架构无 Redis；PG 已是跨进程协调面（session admission 先例）。
- **任意错误皆跨链**：unknown-paid 双花——被 D3 白名单拒绝。
- **把一条通道的能力证据外推到同名模型的其他通道**（如用 Token Plan 证据给按量 `xiaomi` 或反之声明 toolCalling）：违反 YUK-924 证据门纪律，被 D5/D9 拒绝。

## 未决问题

- 429 文本如何区分账号级配额与模型级限速（首版保守：见 Retry-After 即 provider+model 级冷却，quota 语义升级为 provider 级）。
- 半开探针载体：最小专用请求 vs 真实任务首请求。
- 混合口径聚合时 `cost_ref` 的具体编码；跨链事件的落表形状（事件脊 vs 专用明细）。
- per-task 幂等读 opt-in 名单（初始为空）。
- 学习者侧状态行的文案与呈现归 Opus 线，待其 UI 方接手。
- 链条目宜同 API 族；跨族（如 anthropic ↔ openai-completions）由 pi `transformMessages` 规范化 tool-call ID，接受 thinking 保真降级。
- 链前进产生的额外物理调用复用同一 attempt 的预留与率限窗口（与现行驱动内重试同等待遇），各物理调用按 D6 逐段结算。
