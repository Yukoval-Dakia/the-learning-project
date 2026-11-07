# server/ai — runner + domain tools

> Server 侧 AI 执行层。共享 task 契约与注入式 reader 在 [`src/ai/`](../../ai/README.md)，具体目录由 `src/capabilities/task-registry.ts` 组合（不持 key）。长期 tool 设计见 `/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/archive/superpowers/specs/2026-05-17-agent-context-tools-design.md`。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `runner.ts` | 统一把所有 task 送进 ExecutionAdapter（唯一实现是 `PiAgentAdapter`）；调用方用 `piToolMounts` / `piHooks` / `piAgents` / `piSkillDocs` / `piSessionReplay` / `nativeCompaction` / `piQueues` + `allowedTools` / `maxTurns`（`runTask`/`runAgentTask`/`streamTask`）|
| `execution-adapter.ts` | YUK-921 ExecutionAdapter seam：`PreparedExecutionQuery`/`ExecutionAdapter` 接口 + `ModelBinding` per-run 绑定 + `resolveExecutionAdapter` 决议 + 测试 seam `__setPiAdapterForTests`（P4 起 `ExecutionAdapterId` 只有 `'pi'`）|
| `pi-agent-adapter.ts` | YUK-921/YUK-1025 唯一执行引擎：`@earendil-works/pi-agent-core` `agentLoop` 同进程执行 + `pi:` 会话 id、`transformContext` 压缩、嵌套 agentLoop、`piHooks`/`piQueues` 转发。帧与 prompt 归一调用 `pi-runner-frames.ts`；工具包装与 provider wire 分别委托 `pi-tool-surface.ts`/`pi-provider-wire.ts` |
| `pi-tool-surface.ts` | 挂载 AgentTool 的唯一包装 owner：bridge schema 替换、参数契约 `prepareArguments` 修复、`tool_args_progress`/`coerced`/`contract_failed` 帧与 execute/attempt 观测；root 与嵌套 loop 共享同一份证据状态 |
| `pi-provider-wire.ts` | provider wire 的唯一 owner：auth/header（`x-opencode-session`）/retry/reasoning/timeout、预算 fetch 与非 2xx 捕获、上下文 token 上限、structured-submit wire 字段；root 与嵌套 loop 复用同一 `loopConfig`/`streamFn` |
| `pi-runner-frames.ts` | pi ↔ runner 协议纯归一：durable replay / SDK prompt → AgentMessage；pi 事件 → SDK-shaped `PiRunnerMessage`（`source:'pi'`，含 init / assistant / tool_result / result / task_* / compact_boundary）与嵌套 child usage 形状。不跑 loop、不发请求 |
| `pi-models.ts` | 从运行时 ModelProfile 投影执行模型；Pi builtins 只提供协议/compat/auth。`pi-provider-catalog.ts` 提供同源同步读面；订阅复用 anthropic，Token Plan 保留独立 endpoint/auth |
| `../../core/tool-call-contract.ts` | 共享 hook 契约真身：`PiHookBridge`、before/after 回调与调用/结果观测类型；不持执行体 |
| `pi-hooks.ts` | YUK-1022 hook 执行体（P4 起唯一的 tool-call 拦截面）：有序 `beforeToolCall` 闸第一 defined 即停，`afterToolCall` 失败日志吞掉、后项 defined 字段覆盖；消费 core 契约 |
| `../../core/subagent-contract.ts` | 子代理声明与纯构造真身：`AgentDefinition`、depth-one spec、内部 memoized decider、`createPiSpawnContract` 权限 gate 与 report-only 观察；不执行子 loop、不记付费结算 |
| `tools/pi-subagent.ts` | YUK-1022 嵌套子代理执行器：`PiSubagentHost` 契约 + `Task`/`Agent` AgentTool 构造；真实子 loop、模型目录校验、主模型继承、abort 血统仍由 adapter 拥有，task_* 帧由 `pi-runner-frames.ts` 构造、usage 归并由 adapter 累加 |
| `sdk-types.ts` | YUK-1025 vendored 帧类型：SDKMessage 线形（assistant/result/user/task_*）是 pi 事件的归一化目标形状——纯类型，零运行时依赖 |
| `sdk-terminal.ts` | 把归一化 assistant/result 帧适配为 lifecycle usage、thinking 元数据与终态证据；不持久化原始 CoT |
| `providers.ts` | provider 认证、任务选模与 execution policy；`task.<kind>.reasoning` 存 pi 思考层级名，按 models.dev `reasoning_options` 决议（effort 向上取整、toggle 映射、空档不发参数），`requested→applied` 记入 run 回执，`task.<kind>.override_global_pin` 优先级不变；`resolveTaskReasoning` 同时是 admin 配置读面投影与配置写校验的唯一 resolver（YUK-1808） |
| `@/core/config/custom-providers` | YUK-1563 ④ 自定义 provider 定义的纯真相源：类型、校验（slug/https URL/env 名/协议）、进程内注册表 + 目录联动端口；凭据只存 env 变量名（DB 水合/CRUD 在 `src/core/config/server/custom-providers-hydrate.ts` 与 observability 写面；目录联动端口由 `src/core/ai-runtime/server/custom-provider-config-integration.ts` 绑定，AI 实现在 `custom-provider-catalog-ports.ts`） |
| `model-catalog-overrides.ts` | 唯一手写模型事实例外源。按 provider/model 记原因，仅补目录缺项或实测差异，不接管选模 |
| `model-profiles.ts` + `model-catalog.ts` + `provider-models-check.ts` + `model-catalog.snapshot.json` | ModelProfile 读取运行时 models.dev 缓存和有据例外；缺项 unknown。已有 `/models` 核对、鉴权探针和刷新锁不变。`pnpm gen:model-catalog` 只重写离线快照。自定义 provider 的模型 bucket 在 `model-catalog.ts` 刷新时从其自身 /models 合成（`mergeCustomProviderBuckets`），合成前在刷新事务内重读定义表、不信任进程内 registry（YUK-1960），不进快照 |
| `log.ts` | run / event 留痕 |
| `provenance.ts` | source / `last_modified_by` 标记 |
| `../../capabilities/practice/grading/server/judge/` | Practice 判分实现；题型路由和 TaskSpec 由 Practice 拥有 |
| `tools/registry.ts` + `tools/register-capability-tools.ts` | 统一 Domain Tool Registry；完整 inventory 由 capability manifests 在进程启动期装配 |
| `tools/mcp-bridge.ts` | `executeDomainToolCall` 引擎中立共享管线（`tool_call_log`/`tool_use` mirror/`beforeExecute`/`interceptInput`/cancellation）——DomainTool 执行的唯一通道 |
| `@/ai/pi-tool-mount` | 完整 mount/options 共享声明、wire 命名与 custom AgentTool 构造；不执行 domain/remote 挂载 |
| `tools/pi-tools.ts` | DomainTool→AgentTool 编译与远程 MCP→AgentTool 连接/执行/关闭；消费共享挂载契约 |
| `tool-param-contract.ts` | YUK-1547/YUK-1559 C1/C6 共享工具参数契约：对 schema 期望 array/object 而模型给 string 的字段做恰好一次严格 `JSON.parse`，仅当结构类型匹配且过该子 schema 才采纳；修复失败抛 `[tool_param_contract]` isError（不 reach execute）。runtime 在 `pi-tool-surface.ts` 的 `prepareArguments` 包装统一挂载（pi 在 validateToolArguments 之前调它），preflight `yuk1547-admission-reopen.ts` 复用同一实现 |
| `../../kernel/tools/allowlists.ts` | surface-specific DomainTool 与 MCP allowlist |
| `../../capabilities/*/manifest.ts` 的 `copilotTools` | 查工具实现与暴露范围的入口；知识读取、练习供给、Copilot 事件读取等由业务模块拥有，runtime 只装配声明 |

## 关键约束
- Domain Tool Registry 是源头；pi mount 只是把 registry DomainTool 编译成 `AgentTool`（execute 委托共享的 `executeDomainToolCall` 管线，`tool_call_log`/`tool_use` mirror/`interceptInput`/output-schema 语义不变）。
- Owner 2026-10-03：旧 Xiaomi/Zhipu Anthropic-compatible 线路已移除。
  Xiaomi 与 `zhipuai-coding-plan` 使用 pi 原生 OpenAI Completions 预设，保留其
  thinking/tool-stream compat；输入模态与 toolCalling 取运行时 models.dev，不能从 SDK 快照或模型名推断。
  Claude 订阅只改变认证，复用原生 anthropic 的目录/协议/compat。
  原始 CoT 不持久化；每次 lifecycle attempt 独占 terminal evidence collector。
- skill 注入面（YUK-1022/P4）：pi 无文件系统 skill loader——调用方把 SKILL.md
  正文（`resolveCopilotSkillDocs`/`resolveNoteSkillDocs`/`resolveQuizGenSkillDocs`，
  命名空间名 `<subjectDir>--<pack>`）经 `piSkillDocs` 注入 system prompt；缺包时
  传 undefined，never throws。
- Read tool 返回语义化上下文（graph path / relation meaning / recent failure evidence）。
- 工具参数契约：string→JSON 修复只采纳严格解析且通过子 schema 的结果。structured-submit 的坏 JSON、漏提交、形状拒绝交给同 run 提交循环；同错误且输出 hash 重复立即终态，同错误但输出变化累计三次终态，墙钟余量与任务财务上限也收口。非 structured 的 root 与嵌套 loop 保留一次共享 contract correction。采纳修复记录 `tool_args_coerced`（仅 tool/path/length）；拒绝记录 `tool_args_contract_failed` 与递归脱敏后 ≤4KiB 参数，`args_source` 区分流式原文与解析重建。bridge-owned 工具先 execute 再拒绝，契约证据不能排在 executed-call 返回之后。
- Proposal tool 写 `event(action='propose')`；action/write tool 只包装已有 owner service（AttributionTask / VariantGenTask），不能让 LLM 传任意 mutation payload。
- release-critical FULL 审查的通用 confirmed state machine 仍在 `sealed-validation.ts`；
  collecting runner 额外透传 success `result` 为 `terminalText`，但不解释其结构；
  Copilot terminal Markdown 的回复收口归 capability，见其 `AGENTS.md`。

## ANTI-PATTERNS
- generic `/api/ai/[task]` 已移除；新 task 走 capability 领域 route / worker。
- 破坏性动作无直接 write tool——只能 propose，用户 accept 才执行。
- Claude Agent SDK 已移除（YUK-1025）：`ctx.mcpServers`/`ctx.hooks`/`ctx.agents`/`ctx.skills`/`outputFormat`/`canUseTool`/`settingSources`/`buildAgentEnv` 等 SDK 面不存在；`@anthropic-ai/claude-agent-sdk` import 会被 `audit:provider-lanes` 打红。

## Switchable AI provider lane (YUK-365, post-P4)

产品默认在 `src/ai/task-spec.ts` 的 `DEFAULT_TASK_MODEL` 唯一定义为 `opencode-go/deepseek-v4.1-flash`，任务装配时补齐；有真实专用协议的任务保留显式绑定。`AI_PROVIDER_OVERRIDE` + `AI_PROVIDER_MODEL` 仍是模型应急 pin，认证变量 `OPENCODE_API_KEY`；它不改变 reasoning。Mem0 跟随全局模型 pair；无 pair 且无显式 MEM0_LLM_MODEL/BASE_URL 时继承 DEFAULT_TASK_MODEL，显式旧 memory 配置保留 GLM 专用路径。app 与 worker 必须看到相同配置。mimo-v2.5 系列已退役：存量 task/lane 模型配置明确报错，需清除或显式选择支持的 pair，不自动替换；mimo-v2.6 仍可选。

`lane.global.reasoning` 存 `{level}`，默认 `{level:'high'}`。任务 `task.<kind>.reasoning` > 全局 > 目录默认；所有模型共用 `resolveTaskReasoning` 的向上取整/toggle/none 规则，receipt 带 source 和 requested→applied。flash 目录档位 low/high/max；无 reasoning 配置位的模型记录 none。

## Xiaomi official Token Plan (YUK-1402)

独立 provider `xiaomi-token-plan`，`authMode:key`，仅服务端读取
`XIAOMI_TOKEN_PLAN_API_KEY`。`AI_PROVIDER_OVERRIDE=xiaomi-token-plan` 与
`AI_PROVIDER_MODEL=mimo-v2.6-pro` 必须同时对 app / worker 可见。
`XIAOMI_TOKEN_PLAN_REGION` 支持 `cn|sgp|ams`，默认 `cn`；
`XIAOMI_TOKEN_PLAN_BASE_URL` 可显式覆盖 OpenAI-compatible `/v1` URL。
默认端点为 `https://token-plan-<region>.xiaomimimo.com/v1`。
Token Plan `tp-` key 与按量 `XIAOMI_API_KEY` 不互通，旧 `xiaomi` lane 不变。

`pi-models.ts` 从 Xiaomi 原生模型复制协议、thinking/tool-stream compat，
模型事实共享 models.dev 的 Xiaomi 条目，注册独立 pi provider；不能把按量或 OpenCode Go
同名模型证据当成 Token Plan 证据。
仅 `model-catalog-overrides.ts` 的 `xiaomi-token-plan/mimo-v2.6-pro` 已获本 lane 工具实测准入：
[Sourcing actual-output](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/planning/evidence/2026-10-10-pi-tool-loop-xiaomi-token-plan-mimo-v2.6-pro-actual.json)
封存真实生产入口、durable task run、工具执行与输出 schema 校验；
[Copilot actual-output](/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/planning/evidence/2026-10-10-pi-copilot-xiaomi-token-plan-mimo-v2.6-pro-actual.json)
封存单轮 durable worker 成功、四次 domain tool 执行及四条成功 `tool_use` mirror。
其他模型的 toolCalling 为 unknown，能力门仍拒绝。

生产视觉 rescue 与 vision judge 走同一 Token Plan `/v1` pi text+image 模型；
`MIMO_VISION_*` 只供 `pnpm preflight:vision`，不改变生产 runner。
该独立 probe 经 `resolveTaskProvider('StepsJudgeTask', visionJudgeProviderOverride())`
解析 lane/provider/model/凭据，按目录 api 分发 wire 形状（openai-completions
→ `/chat/completions`，anthropic-messages → Messages SDK）；`MIMO_VISION_BASE_URL`
可显式覆盖端点（host 须过模型端点 allowlist），`MIMO_VISION_MODEL` 优先于
product model。配置错/凭据缺失按 TaskConfigError 退出码 2 如实失败，
oauth-file lane 不能从脚本侧探测。
全局 env pin 下 vision judge 不重试 registry-default fallback。
字符级 GLM/Tencent OCR 保留专用 credentials，不属于此 AI lane。
Mem0 抽取与直接调和通过 `mem0/llm-config.ts` 走同一 Token Plan `/v1`
模型/credential/region/base URL，缺配置明确失败，无按量 fallback；pin 端点与任务
执行同过模型端点 host allowlist（YUK-1646）；embedding 保留
DashScope。pi cost 只按 catalog 估值记录。

## OpenRouter chat/agent lane (YUK-1695)

`openrouter` 同时是 typed 判分 lane（原生 `/api/v1/systemone`，`typed-primitive-runner.ts`）和 pi chat/agent lane：pi 内置 `openrouter` provider 的 OpenAI-compatible / Anthropic 传输，经 `pi-models.ts` 的 lane 列表按目录事实重投影，协议模板来自 `pi-provider-catalog.snapshot.json`（`pnpm tsx scripts/gen-pi-provider-catalog.ts` 重生）。可运行集 = 运行时 models.dev openrouter bucket ∩ pi 内置列表 ∩ 必需事实齐全；离线快照不含 chat 目录，所以无缓存时没有可运行的 openrouter chat 模型。`implementedProviderIds()` 刻意排除 openrouter：无 auth probe 模型、不做 `/models` 核对，因此启用它不产生后台流量或花费。费用：非 `typesafe/jev*` 模型走 `pi-catalog` estimated，且需目录费率卡，否则 unknown；`typesafe/jev*` 仍走 typed 的 reported/pricebook 路径。选模只经 task 配置 / 全局 pin，代码无默认 openrouter 模型。

## Pi execution engine (YUK-921 → YUK-1025 P4 唯一引擎)

`PiAgentAdapter`（`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core` `agentLoop`，同 process 内跑）。P4 起它是唯一执行路径——`modelBinding.adapter` 只接受 `'pi'`，非 pi pin 一律 fail-closed config 错；needsToolCall=true kind 要求 `ctx.piToolMounts` 至少产出一件 pi-visible 工具，否则 startup throw（不许静默跑无工具循环）。

- **pi 1.0 transcript**：system prompt/skills 与工具声明进入 system-role messages；`convertToLlm` 保留 system。压缩前 replay system deltas 并保留当前 instructions/tool loadout，不能随旧历史裁掉。
- **归一约定**：pi 事件在 adapter 边界转成 SDKMessage 形状（assistant/result frame + `source:'pi'` provenance），`consumeSdkAttempt`/`sdk-terminal`/lifecycle 零改动。toolResult 归一成 `user` frame（tool_result block）。
- **工具循环**（`@/ai/pi-tool-mount` 声明/构造；`tools/pi-tools.ts` 执行装配）：`ctx.piToolMounts` 三种 mount——`piDomainMount(BuildMcpServerOptions)` 只构造描述子，server `buildPiDomainAgentTools` 把 registry DomainTool 编译成 `AgentTool`（zod→JSON Schema 薄转换，execute 委托 `executeDomainToolCall`）；`piRemoteMcpMount(serverName, RemoteMcpHttpConfig, toolNames, db)` 只构造描述子，server `connectPiRemoteMcp` 用真 `@modelcontextprotocol/sdk` client 桥远程 MCP（Exa），connect+listTools 失败时必需 mount 在 startup 即失败，`CopilotTask` 的可选 Exa 例外（连接/列工具失败即降级：run 继续、系统提示声明网页搜索不可用、原因记 `usage_json.transport.startup_dependency_failures`），具备 db 与 run 时，每次成功/失败调用自身写一行 `tool_call_log`（`task_run_id` = 当前 run）并记 unknown-cost ledger；`{type:'custom'}` 逃生门给非 registry 工具，owner 自记日志。wire name 统一 `mcp__<server>__<tool>`——`allowedTools`/`recordToolCall`/allowlist 语义零漂移。runner 只镜像 spawn 工具，不再为同一次执行写第二行（YUK-1557）。`options.maxTurns`→`finishTurn` 计数→terminal `error_max_turns`——cap 只在 completed turn 带 toolCall（循环本意续跑）时触发；clean end_turn 自然退出报 success（YUK-1026，SDK parity）。
- **copilot/subagent/compaction 面**（YUK-1022，P4 后为唯一面）：`piHooks`（有序 before 闸 + after 观测器）、`piSessionReplay`（durable turns 回放进 `context.messages`，`pi:<uuid>` 标记复用 `agent_sdk_session_id` 槽）、`piSkillDocs`（SKILL.md 正文拼 systemPrompt）、`piAgents`（深度一嵌套 agentLoop，子 loop 不见 spawn 工具，usage/cost 归并父终态）、`nativeCompaction`（沿用 85%/60% 策略，基数取目录 context/input 较小值，阈值至少 1；裁剪保留最新完整工具调用/结果组 + bounded sessionContext 重注入 + `compact_boundary` 帧）、`piQueues`（steering/follow-up，已接线但零 caller）。嵌套 agent 生命周期帧（task_started/progress/updated）直接喂 `onTaskEvent` durable 投影。
- **opencode-go 会话头**：每请求必须 `x-opencode-session`，注入 `ai_task_run.id`（attempt 级 fencing 身份）；缺了 endpoint 400 MissingSessionID。key-auth：`OPENCODE_API_KEY`。
- **端点与限额（YUK-1563 ③）**：所有已接线 Pi 模型的 base URL、context/input/output 限额和输入模态取运行时目录；SDK 默认值不能覆盖。目录缺必需事实时不执行。模型级 `provider.npm` 的 Anthropic/OpenAI-compatible 声明优先于协议快照，已选模型协议变化也保留旧事实并记 finding；没有已接线模板的模型不自动启用。OpenCode Go 已知端点路径与协议矛盾时不执行。Anthropic SDK 追加 `/v1/messages`，Pi 传输适配去掉目录端点末尾 `/v1`，目录读面保持原值。Memory 全局 pin 与 typed runner 同读目录端点且共用同一可运行性门（`executablePiModel` / `getModel`）；未 pin 的 Memory 显式 `MEM0_LLM_MODEL` / `MEM0_LLM_BASE_URL` 保留旧 GLM 配置；无显式配置时继承产品默认（但端点 host 须过模型端点 allowlist，YUK-1654），未增加自定义 provider 能力。
- **思考层级配置（YUK-1806，替代 YUK-1547 原生透传）**：per-task DB 键 `task.<kind>.reasoning` 存 `{level}`（pi 层级名：off|minimal|low|medium|high|xhigh|max；legacy `{"reasoning_effort":"<level>"}` 兼容读作同一 level）。决议在 `resolveTaskReasoning`（providers.ts）：effort 模型在 `reasoning_options.values` 内直取、缺失向上取整（顶档封顶）；toggle 模型任一非 off level → thinking 开（carrier 'high'）；`reasoning_options` 为空 → 不发参数用模型默认；`off` → lane 协议可表达 disable（thinkingFormat 或 anthropic-messages，且 level map 未关 off）时 `applied:'off'`、wire 发 `thinking:{disabled}`/effort:'none'；否则 `applied:'none'`、不发字段；非层级名 → config error。应用结果以 `requested→applied` 写入 run 回执 `reasoning` 字段，可回查不静默降级。wire 发 pi 侧完成（`streamSimple` `reasoning` + 模型 `thinkingLevelMap`；pi `clampThinkingLevel` 只收到目录已支持的 level），loom 不拼 vendor wire 字段。`options.effort` 与 task level 同设仍 fail-closed（单一 writer）。
- **per-task opt-in 全局 pin 例外（YUK-1547）**：`task.<kind>.override_global_pin=true` 是显式 opt-in——仅当该 task 的 `task.<kind>.provider`+`.model` pair 完整且可服务（provider 已实现 + 模型过可运行事实门 `executablePiModel`）时，该 pair 优先于 env `AI_PROVIDER_*` 与 DB `lane.global.*`；per-call override arg 仍更高；未 opt-in 任务严格保持旧层序；pair 不完整/不可服务 → 明确 config error，不回落到 pin/default。解析结果冻结为 `selection_rule`（env_pin/task_pair_priority/call_override/global_pin/task_config/registry_default），写入 `model_profile_resolved` 与 reopen 预检回执。
- **能力来自运行时 models.dev 目录**：所有已接线模型的能力、限额、输入模态和推理档位取 `model_catalog_cache`，无缓存则用 `model-catalog.snapshot.json`。缺字段为 unknown，不编造数值。`model-catalog-overrides.ts` 只补缺项或已实测差异；execution policy 不声明能力。新文档里消失的模型保留上一版条目并记 `model_absent`。已选模型能力或已知端点变化保留旧条目并记 `capability_changed`；两类 finding 的 owner 均为 YUK-1563。不改 system_config 里的模型 id。warn 只在该状态第一次出现时打。`version` 含 findings 与 provider `/models` 核对，缺席集合变化也会让 API watcher 重载。
- **provider 核对与探针**：已实现的 provider 会拉自己的 `/models`。列表可读和推理可用分开记。列表 200 不能把同轮探针的 401/403 写成 ok。核对结果不删目录模型。provider `/models` 里消失、目录里还在的模型记 `model_absent`，条目保留。列表这次没读成时保留上次的 listed/catalogOnly/providerOnly，也保留已经结算的 provider_list absence；失败只写在 list 状态上。删掉 key 或换成另一把 key 才清掉这些 absence。探针回执只对产生它的 key 指纹有效；key 换了就作废并重新探测。claim 只记下这一把 key 的列表结果和未完成探针，不把上一把 key 的认证结果写到新指纹上。没有 key 时推理状态是 `unconfigured`，这个 provider 的过时 `model_absent` 清掉。刷新先在锁里登记 claim，再在锁外发探针。请求已送出但没读到响应头（超时或连接重置）记 unknown，一小时内不再探测。429/5xx 和已经返回的 4xx（含 400/404）只记一条 unsettled，带上 http 状态和错误类型，一小时内不再探测。models.dev 断开时，provider 列表里重新出现的模型会去掉过时的 absent。主键冲突换 id 重试，不把没写入的探针当成已入账。已消耗 token、已被接受，或已到达 provider 但没读到 usage 的探针先记为 owed，`cost_ledger`（`task_kind=model_catalog_auth_probe`）接受后才是 booked。没读到的 usage 是 unknown/null，不是 0。目录事务失败也入账。只有成功是推理 ok，401/403 是 `auth_failed`。
- **自定义 provider（YUK-1563 ④）**：定义（baseURL / key env 名 / 协议）存 `custom_provider` 表，凭据值只按 env 名引用，永不入库或入日志；env 名必须以 `_API_KEY`/`_TOKEN` 结尾，共享基础设施/云凭据名（`DATABASE_*`、`POSTGRES_*`、`INTERNAL_TOKEN`、`AWS_*` 等）拒绝，因为值会作为 Bearer 发到该 provider。**模型端点 host allowlist（YUK-1646/YUK-1654）**：`base_url` host 必须来自运行时 models.dev 目录声明的端点（合成 `custom:*` bucket 不算来源），加上代码声明的 first-party 端点（anthropic/openai 直连根、Xiaomi Token Plan 三区、DashScope embedding 双端点与北京 workspace MaaS host `ws-tcvd1h9009b55vr0.cn-beijing.maas.aliyuncs.com`）；保存（PUT）和执行解析（`resolveTaskProvider`）都校验，`/models` 读取前也复核对等 host，非目录 host 报明确错误；非默认端口必须由目录端点自身声明，否则拒绝（allowlist key 为 `host[:port]`）。**api_key_env 与 provider 绑定（YUK-1654）**：绑定表由 `providers.ts` 的 `providerKeyEndpointBindings` 从 PROVIDERS + 目录 bucket + 代码例外端点合成（fresh per call，经 `setProviderKeyEndpointBindingsSource` 注入 core），内置 provider 的凭据 env 只能配给自家端点（`ZHIPU_API_KEY` 只发 open.bigmodel.cn、`OPENAI_API_KEY` 只发 api.openai.com、Token Plan key 只发三区），内置端点也只收自家凭据 env，跨 provider 或占用内置端点配其它 env 名一律 422 `provider_key_env_not_bound`（保存与执行解析双点强制，legacy 行 fail closed）。运维 env 端点同过 allowlist：`MEM0_LLM_BASE_URL`（未 pin 回退，`llm-config.ts`）、`MEM0_EMBEDDING_BASE_URL`（`client.ts` 构建期 + `embed.ts` 发送前）、`MIMO_VISION_BASE_URL`（`xiaomi-token-plan.ts` / preflight 脚本）、`XIAOMI_TOKEN_PLAN_BASE_URL`（`tokenPlanEndpointOverride`，只接受三区）——不在白名单即拒绝发送，不静默回退。执行解析按实际发送的 catalog bucket 端点校验；registry 与 bucket 不一致（PUT 后刷新未完成或 kept）时 fail closed，不向旧 bucket 端点发 key。allowlist 只约束模型端点，不限制 agent 的网页浏览 / fetch 工具。provider id 是 `custom:<slug>`，`readProviderId`/`isProviderImplemented` 接受它（chat lane；typed 任务拒绝），无默认模型——显式 model 必填。模型列表来自它自己的 `/models`（协议决定的 header 与端点；自定义 provider 不发鉴权探针，PUT 触发的共享刷新可能带上内置 provider 到期的 1-token 探针），能力字段按模型 id 复用目录同 id 条目（优先同协议 bucket，排序取首个，绝不借用源条目的端点/协议）；目录没有或缺必需事实的 id 不进可运行集，面板 `runnable_models` 与 `getModel` 保存检查同源。每个定义在 `model-catalog.ts` 刷新时合成/合并自己的 `custom:<slug>` bucket；registry 未水合成功时刷新保留既有 bucket，不当作“全部删除”。成功 listing 后消失的 id 保留旧条目并走 provider_list absence finding，pinned 模型能力变化保留旧事实并记 `capability_changed`；listing 失败只写状态、bucket 原样。删除定义时先删行，再在刷新锁内清 bucket/check/finding（prune 失败告警，下次刷新清残留），仍引用它的任务配置在下次解析 fail-closed。选模与回退链策略不变；面板/日志只显示 已配置/未配置/认证失败。
- **structured-submit wire policy**：`structured-submit.ts` 拥有 wire 决议、接受校验与安全修正循环。`forcedToolChoice=false` 发 auto，其他值保留 named force；能力例外在 `model-catalog-overrides.ts`。Flash thinking 历史曾拒绝 named force，本轮探针接受但未执行工具 strict schema；不能把 `structured_output` 目录位当作字段约束保证。修正上下文仅含 schema 字段/类型/JSON 位置，不含字段值、未知键名、作者答案、判定或另一路结果；校验通过直接完成。
- **cost 诚实**：terminal usage 累加本次父loop全部assistant回合，再合入child usage；durable replay不计入本次用量。pi `usage.cost` 是 catalog 费率估值 → `resolveAttemptCostTruth` 落 `estimated` + `pi-catalog:<provider>/<model>` ref；ChatGPT-login 订阅路由同 basis 但 ref 前缀 `pi-catalog-subscription`（含 timeout/failure 变体），spend-gate 不计该前缀——订阅估算不是付费。Copilot 与教学提示尝试另在 `usage_json.help_latency` 封存四段时延，失败、超时和取消都留下，未知费用保持 null。
- **abort 语义**：caller abort / `close()` 不产 terminal frame——lifecycle 的 `aborted` 标志独占取消真相；provider 侧 abort（stopReason='aborted' 且我们没发信号）归一为 `error_during_execution`。`close()` 同时释放远程 MCP client socket。
- **bundle 边界**：pi 依赖链（aws-sdk/genai/openai 等）+ MCP client 随 server/worker bundle 进 `dist/*.cjs`；`build:migrate` 标 `@earendil-works/*` 与 `@modelcontextprotocol/sdk` external + adapter/桥内 dynamic import——migrate bundle 不含 pi/MCP 代码且永不会 require 它。
- **已知延迟画像（actual-output 封存 `/Volumes/YukovalSBak/yukoval-projects/tlp-docs/repo-docs/docs/planning/evidence/2026-09-19-pi-adapter-*`；YUK-1983 后短任务档默认 timeout=120s）**：glm-5.3-flash ~11s、grok-4.6 ~51s、mimo-v2.5-pro ~57-60s（当时贴边 60s 档，两过一超）——跨 provider 选模型必须尊重 per-kind timeout。
