# server/ai — runner + domain tools

> Server 侧 AI 执行层。浏览器侧 task registry + prompt builder 在 [`src/ai/`](../../ai/README.md)（不持 key）。长期 tool 设计见 [docs/superpowers/specs/2026-05-17-agent-context-tools-design.md](../../../docs/superpowers/specs/2026-05-17-agent-context-tools-design.md)。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `runner.ts` | 统一把所有 task 送进 ExecutionAdapter（唯一实现是 `PiAgentAdapter`）；调用方用 `piToolMounts` / `piHooks` / `piAgents` / `piSkillDocs` / `piSessionReplay` / `nativeCompaction` / `piQueues` + `allowedTools` / `maxTurns`（`runTask`/`runAgentTask`/`streamTask`）|
| `execution-adapter.ts` | YUK-921 ExecutionAdapter seam：`PreparedExecutionQuery`/`ExecutionAdapter` 接口 + `ModelBinding` per-run 绑定 + `resolveExecutionAdapter` 决议 + 测试 seam `__setPiAdapterForTests`（P4 起 `ExecutionAdapterId` 只有 `'pi'`）|
| `pi-agent-adapter.ts` | YUK-921/YUK-1025 唯一执行引擎：`@earendil-works/pi-agent-core` `agentLoop` 同进程执行 + 事件→SDK-frame 归一（`PiRunnerMessage`，`source:'pi'`）+ `x-opencode-session` header 注入 + `pi:` 会话 id、durable 回放种子、`transformContext` 压缩、嵌套 agentLoop、`piHooks`/`piQueues` 转发 |
| `pi-models.ts` | loom provider → pi catalog 接线：`PROVIDER_PI_CATALOG_SPECS` 把 ResolvedProvider（含 oauth token）编译成 pi `Model`/`createProvider` 条目 |
| `pi-hooks.ts` | YUK-1022 hook 面（P4 起唯一的 tool-call 拦截面）：引擎中立 `PiHookBridge`（有序 `beforeToolCall` 闸 + 失败日志吞掉的 `afterToolCall` 观测器，isError 覆盖 failure 语义）|
| `tools/pi-subagent.ts` | YUK-1022 嵌套子代理：`PiSpawnContract`（`createSpawnDecider` 包成 beforeToolCall 闸）+ `PiSubagentHost`（子 loop 宿主、abort 血统、task_* 帧、usage 归并）+ `Task`/`Agent` AgentTool 构造 |
| `sdk-types.ts` | YUK-1025 vendored 帧类型：SDKMessage 线形（assistant/result/user/task_*）是 pi 事件的归一化目标形状——纯类型，零运行时依赖 |
| `sdk-terminal.ts` | 把归一化 assistant/result 帧适配为 lifecycle usage、thinking 元数据与终态证据；不持久化原始 CoT |
| `providers.ts` | provider 注册表（xiaomi / anthropic / zhipu / opencode-go）+ YUK-924 provider model binding（`models` / `modelDefaults`，config-over-catalog 的 config 层）|
| `model-profiles.ts` + `model-catalog.snapshot.json` | YUK-924 ModelProfile 注册表：models.dev 裁剪快照（`pnpm gen:model-catalog` 重生成，运行时零网络）+ binding→catalog→保守默认三层合并 + needsToolCall/isMultimodal fail-closed 能力门 |
| `log.ts` | run / event 留痕 |
| `provenance.ts` | source / `last_modified_by` 标记 |
| `../../capabilities/practice/server/judge/` | Practice 判分实现；题型路由和 TaskSpec 由 Practice 拥有 |
| `tools/registry.ts` + `tools/register-capability-tools.ts` | 统一 Domain Tool Registry；完整 inventory 由 capability manifests 在进程启动期装配 |
| `tools/mcp-bridge.ts` | `executeDomainToolCall` 引擎中立共享管线（`tool_call_log`/`tool_use` mirror/`beforeExecute`/`interceptInput`/cancellation）——DomainTool 执行的唯一通道 |
| `tools/pi-tools.ts` | `PiToolMount` 描述子 + DomainTool→AgentTool 编译 + 远程 MCP→AgentTool 桥 + `piCustomTool` 逃生门 |
| `../../kernel/tools/allowlists.ts` | surface-specific DomainTool 与 MCP allowlist |
| `../../capabilities/*/manifest.ts` 的 `copilotTools` | 查工具实现与暴露范围的入口；知识读取、练习供给、Copilot 事件读取等由业务模块拥有，runtime 只装配声明 |

## 关键约束
- Domain Tool Registry 是源头；pi mount 只是把 registry DomainTool 编译成 `AgentTool`（execute 委托共享的 `executeDomainToolCall` 管线，`tool_call_log`/`tool_use` mirror/`interceptInput`/output-schema 语义不变）。
- Xiaomi/MiMo 走 Anthropic-compatible 协议：思考内容表现为 assistant
  `content[]` 的 `thinking` block，不是 OpenAI-compatible 的字面字段
  `reasoning_content`。以真实返回的 thinking-block metadata 验证运行态，绝不持久化
  原始 CoT。每次 lifecycle attempt 独占一个 terminal evidence collector；result
  usage 存在时覆盖 assistant 累加值。
- skill 注入面（YUK-1022/P4）：pi 无文件系统 skill loader——调用方把 SKILL.md
  正文（`resolveCopilotSkillDocs`/`resolveNoteSkillDocs`/`resolveQuizGenSkillDocs`，
  命名空间名 `<subjectDir>--<pack>`）经 `piSkillDocs` 注入 system prompt；缺包时
  传 undefined，never throws。
- Read tool 返回语义化上下文（graph path / relation meaning / recent failure evidence）。
- Proposal tool 写 `event(action='propose')`；action/write tool 只包装已有 owner service（AttributionTask / VariantGenTask），不能让 LLM 传任意 mutation payload。
- release-critical FULL 审查的通用 confirmed state machine 仍在 `sealed-validation.ts`；
  collecting runner 额外透传 success `result` 为 `terminalText`，但不解释其结构；
  Copilot terminal Markdown 的回复收口归 capability，见其 `AGENTS.md`。

## ANTI-PATTERNS
- generic `/api/ai/[task]` 已整体退场；新 task 走 capability 领域 route / worker，禁止复活通用 dispatch 入口。
- 破坏性动作无直接 write tool——只能 propose，用户 accept 才执行。
- Claude Agent SDK 已退役（YUK-1025）：不要复活 `ctx.mcpServers`/`ctx.hooks`/`ctx.agents`/`ctx.skills`/`outputFormat`/`canUseTool`/`settingSources`/`buildAgentEnv` 等 SDK 面；任何 `@anthropic-ai/claude-agent-sdk` import 都会被 `audit:provider-lanes` 打红。

## Switchable AI provider lane (YUK-365, post-P4)

默认走 mimo-v2.5（xiaomi key-auth）。设 `AI_PROVIDER_OVERRIDE=anthropic-sub` 全局切到 **Opus 4.8 via owner's Claude Max 订阅（OAuth）** —— token 是 `claude setup-token` 生成的长效 `CLAUDE_CODE_OAUTH_TOKEN`，**绝不入库不打印**。**Token + `AI_PROVIDER_OVERRIDE` 必须对所有 AI 进程可见**（API + worker 各自在启动期跑 `loadEnv()`；`dev:local` 透传给 child；生产经 docker-compose `.env` 注入）。订阅 token 与 mimo 互斥。可选 `AI_PROVIDER_MODEL` 覆盖模型 id（lane 默认 `claude-opus-4-8`）；切到非 mimo 的其它 provider 若不设 `AI_PROVIDER_MODEL` 会 throw 明确 config 错（YUK-365 Finding 4）。Wiring 在 `providers.ts`（`authMode: 'key' | 'oauth'` + override 开关）+ `pi-models.ts`（oauth variant 把 `sk-ant-oat*` token 交给 pi anthropic-messages 驱动，自动走 Bearer 头）。

## Pi execution engine (YUK-921 → YUK-1025 P4 唯一引擎)

`PiAgentAdapter`（`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core` `agentLoop`，同 process 内跑）。P4 起它是唯一执行路径——`modelBinding.adapter` 只接受 `'pi'`，非 pi pin 一律 fail-closed config 错；needsToolCall=true kind 要求 `ctx.piToolMounts` 至少产出一件 pi-visible 工具，否则 startup throw（不许静默跑无工具循环）。

- **归一约定**：pi 事件在 adapter 边界转成 SDKMessage 形状（assistant/result frame + `source:'pi'` provenance），`consumeSdkAttempt`/`sdk-terminal`/lifecycle 零改动。toolResult 归一成 `user` frame（tool_result block）。
- **工具循环**（`tools/pi-tools.ts`）：`ctx.piToolMounts` 三种 mount——`piDomainMount(BuildMcpServerOptions)` 把 registry DomainTool 编译成 `AgentTool`（zod→JSON Schema 薄转换，execute 委托 `executeDomainToolCall`）；`piRemoteMcpMount(serverName, RemoteMcpHttpConfig, toolNames)` 用真 `@modelcontextprotocol/sdk` client 桥远程 MCP（Exa），connect+listTools 失败在 startup 即响；`{type:'custom'}` 逃生门给非 registry 工具（KnowledgeReviewTask 的 `write_proposal`、agency director/evidence servers）。wire name 统一 `mcp__<server>__<tool>`——`allowedTools`/`recordToolCall`/allowlist 语义零漂移。`options.maxTurns`→`shouldStopAfterTurn` 计数→terminal `error_max_turns`。
- **copilot/subagent/compaction 面**（YUK-1022，P4 后为唯一面）：`piHooks`（有序 before 闸 + after 观测器）、`piSessionReplay`（durable turns 回放进 `context.messages`，`pi:<uuid>` 标记复用 `agent_sdk_session_id` 槽）、`piSkillDocs`（SKILL.md 正文拼 systemPrompt）、`piAgents`（深度一嵌套 agentLoop，子 loop 不见 spawn 工具，usage/cost 归并父终态）、`nativeCompaction`（transformContext 85% 触发 prune 至 60% + bounded sessionContext 重注入 + `compact_boundary` 帧）、`piQueues`（steering/follow-up，已接线但零 caller）。嵌套 agent 生命周期帧（task_started/progress/updated）直接喂 `onTaskEvent` durable 投影。
- **opencode-go 会话头**：每请求必须 `x-opencode-session`，注入 `ai_task_run.id`（attempt 级 fencing 身份）；缺了 endpoint 400 MissingSessionID。key-auth：`OPENCODE_API_KEY`。
- **能力声明 evidence-gated**：opencode-go 的 pi catalog JSON 不带 `tool_call` 位，`providers.ts` 的 binding 就是权威分类——`modelDefaults.capabilities.toolCalling:false`，逐模型在 `models` 里翻 `true`，且只在 `docs/planning/evidence/2026-09-21-pi-tool-loop-<model>-actual.json` 有封存 run 之后才许声明。当前已验证：glm-5.3-flash（tool loop 实跑但 8 turn 未收敛）、deepseek-v4-pro（全绿）。
- **cost 诚实**：pi `usage.cost` 是 catalog 费率估值 → `resolveAttemptCostTruth` 落 `estimated` + `pi-catalog:<provider>/<model>` ref，绝不冒名 reported/contractual。
- **abort 语义**：caller abort / `close()` 不产 terminal frame——lifecycle 的 `aborted` 标志独占取消真相；provider 侧 abort（stopReason='aborted' 且我们没发信号）归一为 `error_during_execution`。`close()` 同时释放远程 MCP client socket。
- **bundle 边界**：pi 依赖链（aws-sdk/genai/openai 等）+ MCP client 随 server/worker bundle 进 `dist/*.cjs`；`build:migrate` 标 `@earendil-works/*` 与 `@modelcontextprotocol/sdk` external + adapter/桥内 dynamic import——migrate bundle 不含 pi/MCP 代码且永不会 require 它（YUK-988 教训）。
- **已知延迟画像（actual-output 封存 `docs/planning/evidence/2026-09-19-pi-adapter-*`）**：glm-5.3-flash ~11s、grok-4.6 ~51s、mimo-v2.5-pro ~57-60s+ 贴边 60s task budget——跨 provider 选模型必须尊重 per-kind timeout，mimo 在 AttributionTask 上两过一超。
