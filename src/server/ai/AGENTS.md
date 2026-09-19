# server/ai — runner + domain tools

> Server 侧 AI 执行层。浏览器侧 task registry + prompt builder 在 [`src/ai/`](../../ai/README.md)（不持 key）。长期 tool 设计见 [docs/superpowers/specs/2026-05-17-agent-context-tools-design.md](../../../docs/superpowers/specs/2026-05-17-agent-context-tools-design.md)。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `runner.ts` | 统一把所有 task 送进 ExecutionAdapter（默认 SDK `query()`，pi lane 见下节）；支持 `mcpServers` / `piToolMounts` / `allowedTools` / `maxTurns`（`runTask`/`runAgentTask`/`streamTask`）|
| `execution-adapter.ts` | YUK-921 ExecutionAdapter seam：`PreparedExecutionQuery`/`ExecutionAdapter` 接口 + Adapter A（SDK WarmQuery 包装）+ `ModelBinding` per-run 绑定 + `resolveExecutionAdapter`/`explicitProviderRouting` 决议 + `AI_ADAPTER_PI_KINDS` 灰度门 |
| `pi-agent-adapter.ts` | YUK-921 P1 Adapter B：`@earendil-works/pi-agent-core` `agentLoop` 单发执行 + 事件→SDK-frame 归一（`PiRunnerMessage`，`source:'pi'`）+ `x-opencode-session` header 注入 |
| `sdk-terminal.ts` | 把 SDK assistant/result 消息适配为 lifecycle usage、thinking 元数据与终态证据；不持久化原始 CoT |
| `providers.ts` | Anthropic provider（xiaomi/mimo 兼容端点）+ YUK-924 provider model binding（`models` / `modelDefaults`，config-over-catalog 的 config 层）|
| `model-profiles.ts` + `model-catalog.snapshot.json` | YUK-924 ModelProfile 注册表：models.dev 裁剪快照（`pnpm gen:model-catalog` 重生成，运行时零网络）+ binding→catalog→保守默认三层合并 + needsToolCall/isMultimodal fail-closed 能力门 |
| `log.ts` | run / event 留痕 |
| `provenance.ts` | source / `last_modified_by` 标记 |
| `../../capabilities/practice/server/judge/` | Practice 判分实现；题型路由和 TaskSpec 由 Practice 拥有 |
| `tools/registry.ts` + `tools/register-capability-tools.ts` | 统一 Domain Tool Registry；完整 inventory 由 capability manifests 在进程启动期装配 |
| `tools/mcp-bridge.ts` | 把任意 allowlist 包成 in-process MCP server + 写 `tool_call_log`/`tool_use` mirror；`executeDomainToolCall` 是引擎中立共享管线 |
| `tools/pi-tools.ts` | YUK-1021 pi 侧 mount：`PiToolMount` 描述子 + DomainTool→AgentTool 编译 + 远程 MCP→AgentTool 桥 |
| `../../kernel/tools/allowlists.ts` | surface-specific DomainTool 与 MCP allowlist |
| `../../capabilities/*/manifest.ts` 的 `copilotTools` | 查工具实现与暴露范围的入口；知识读取、练习供给、Copilot 事件读取等由业务模块拥有，runtime 只装配声明 |

## 关键约束
- Domain Tool Registry 是源头；MCP 只是 Claude Agent SDK 的 in-process 适配层。
- Xiaomi/MiMo 走 Anthropic-compatible 协议：思考内容表现为 assistant
  `content[]` 的 `thinking` block，不是 OpenAI-compatible 的字面字段
  `reasoning_content`。SDK 0.3.220 会把 omitted / `enabled` 都归一为 wire
  `adaptive`，不能用 Options 值伪称已发送 literal `enabled`；以真实返回的
  thinking-block metadata 验证运行态，绝不持久化原始 CoT。每次 lifecycle attempt
  独占一个 terminal evidence collector；result usage 存在时覆盖 assistant 累加值。
- 无 skill 的产品调用必须设 `settingSources: []`，避免仓库 `CLAUDE.md`、project
  hooks 和开发指令混入模型上下文；同时传稳定 `title`，不要为 ephemeral task 额外
  发起自动标题模型请求。显式 skill 调用必须设 `settingSources: ['user']`，只读取生成的
  isolated CONFIG_DIR 镜像，并用 `skills` 白名单收窄可见范围；不得加载 project/local。
- Read tool 返回语义化上下文（graph path / relation meaning / recent failure evidence）。
- Proposal tool 写 `event(action='propose')`；action/write tool 只包装已有 owner service（AttributionTask / VariantGenTask），不能让 LLM 传任意 mutation payload。
- release-critical FULL 审查的通用 confirmed state machine 仍在 `sealed-validation.ts`；
  collecting runner 额外透传 SDK success `result` 为 `terminalText`，但不解释其结构；
  Copilot terminal Markdown 的回复收口归 capability，见其 `AGENTS.md`。

## ANTI-PATTERNS
- generic `/api/ai/[task]` 已整体退场；新 task 走 capability 领域 route / worker，禁止复活通用 dispatch 入口。
- 破坏性动作无直接 write tool——只能 propose，用户 accept 才执行。

## Switchable AI provider lane (YUK-365)

默认走 mimo-v2.5（xiaomi key-auth）。设 `AI_PROVIDER_OVERRIDE=anthropic-sub` 全局切到 **Opus 4.8 via owner's Claude Max 订阅（OAuth）** —— token 是 `claude setup-token` 生成的长效 `CLAUDE_CODE_OAUTH_TOKEN`，**绝不入库不打印**。**Token + `AI_PROVIDER_OVERRIDE` 必须对三进程都可见**：大多数 AI 任务跑在 BACKGROUND pg-boss worker（`scripts/worker.ts`）里，所以放 `.env.local` 时三进程（Hono API / Vite / worker）各自在启动期跑 `loadEnv()`（`server/env`）读它——API 走 `server/index.ts`、worker 走 `scripts/worker.ts`（YUK-365 Finding 2 补：worker 此前不读 `.env.local`，背景 job 会回落 mimo），`dev:local` 也把 `.env.local` 透传给三 child。**生产/NAS**：token 经 docker-compose `.env` 同时注入 app + worker 两容器（`loadEnv` 只填空位，容器 env 永远赢）。订阅 token 与 mimo 互斥：oauth lane 在 SDK 子进程 env 里 SET `CLAUDE_CODE_OAUTH_TOKEN`、UNSET `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` + 四个 cloud-provider selector（`CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_ANTHROPIC_AWS`/`_FOUNDRY`，它们的优先级高于 OAuth token——YUK-365 Finding 1）（first-party endpoint only）。可选 `AI_PROVIDER_MODEL` 覆盖模型 id（lane 默认 `claude-opus-4-8`）；切到非 mimo 的其它 provider（如 `anthropic` 直连）若不设 `AI_PROVIDER_MODEL` 会 throw 明确 config 错（registry 默认 model 是 mimo id，非 mimo endpoint 不收——YUK-365 Finding 4）。**生产 SDK 版本前置**：`Dockerfile` 的 `sdkdeps` stage 必须装 `@anthropic-ai/claude-agent-sdk` 与 lockfile 同版；2026-07-31 验证版本为 `0.3.220`（bundled Claude Code `2.1.220`），旧版（如 0.3.143）CLI 会拒该 model id（YUK-365 Finding 3）。Wiring 在 `providers.ts`（`authMode: 'key' | 'oauth'` 判别式 + `AI_PROVIDER_OVERRIDE` 开关）+ `runner.ts`（`buildAgentEnv` 按 authMode 分支）。

## Pi execution lane (YUK-921 P1+P2 / YUK-1014 + YUK-1021)

第二条执行引擎：`PiAgentAdapter`（`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core` `agentLoop`，同 process 内跑，无 SDK 子进程）。门控是**三闸门**——`modelBinding.adapter:'pi'` pin（per-run 或 `AI_ADAPTER_PI_PROVIDER`/`AI_ADAPTER_PI_MODEL` env rollout pin，显式 caller binding 永远优先）∩ provider 属 `PI_LANE_PROVIDERS`（当前仅 `opencode-go`）∩ kind 在 `AI_ADAPTER_PI_KINDS`；缺一即 fail-closed config 错，无静默回落。P2 起 needsToolCall=true kind 也放行——但 adapter startup 要求 `ctx.piToolMounts` 至少产出一件 pi-visible 工具，否则照样 throw（不许静默跑无工具循环）。反向同样成立：`opencode-go` binding 不 pin pi 也会在 seam 处被拒（其 catalog 是 openai-completions/responses wire，SDK 子进程够不着）。

- **归一约定**：pi 事件在 adapter 边界转成 SDKMessage 形状（assistant/result frame + `source:'pi'` provenance），`consumeSdkAttempt`/`sdk-terminal`/lifecycle 零改动。P2 起 toolResult 也归一成 SDK `user` frame（tool_result block）。
- **P2 工具循环**（`tools/pi-tools.ts`）：调用方把**同一份 mount descriptor** 喂两侧——`ctx.mcpServers`（SDK）+ `ctx.piToolMounts`（pi）。三种 mount：`piDomainMount(BuildMcpServerOptions)` 把 registry DomainTool 编译成 `AgentTool`（zod→JSON Schema 薄转换，execute 委托共享的 `executeDomainToolCall` 管线——`tool_call_log`/`tool_use` mirror/`beforeExecute`/`interceptInput`/output-schema 字节级等价）；`piRemoteMcpMount(serverName, McpHttpServerConfig, toolNames)` 用真 `@modelcontextprotocol/sdk` client 桥远程 MCP（Exa），connect+listTools 失败在 startup 即响；`{type:'custom'}` 逃生门给非 registry 工具（KnowledgeReviewTask 的 `write_proposal`）。wire name 统一 `mcp__<server>__<tool>`——`allowedTools`/`recordToolCall`/allowlist 语义零漂移。`beforeToolCall` 翻译 `ctx.canUseTool`：deny→`{block,reason}`、`interrupt:true`→`terminate:true`（pi 硬停）、allow+`updatedInput`→throw（P3 面）、null→block fail-closed。`options.maxTurns`→`shouldStopAfterTurn` 计数→terminal `error_max_turns`。spawn-contract 的 `agents`/`hooks`/`skills`/`nativeCompaction` 是 P3 面——声明即在 startup throw（ResearchMeetingDirectorTask 因此暂不 pi-eligible）。
- **opencode-go 会话头**：每请求必须 `x-opencode-session`，注入 `ai_task_run.id`（attempt 级 fencing 身份）；缺了 endpoint 400 MissingSessionID。key-auth：`OPENCODE_API_KEY`。
- **能力声明 evidence-gated**：opencode-go 的 pi catalog JSON 不带 `tool_call` 位，`providers.ts` 的 binding 就是权威分类——`modelDefaults.capabilities.toolCalling:false`，逐模型在 `models` 里翻 `true`，且只在 `docs/planning/evidence/2026-09-21-pi-tool-loop-<model>-actual.json` 有封存 run 之后才许声明。当前已验证：glm-5.3-flash（tool loop 实跑但 8 turn 未收敛）、deepseek-v4-pro（全绿）。
- **cost 诚实**：pi `usage.cost` 是 catalog 费率估值 → `resolveAttemptCostTruth` 落 `estimated` + `pi-catalog:opencode-go/<model>` ref，绝不冒名 reported/contractual。
- **abort 语义**：caller abort / `close()` 不产 terminal frame——lifecycle 的 `aborted` 标志独占取消真相；provider 侧 abort（stopReason='aborted' 且我们没发信号）归一为 `error_during_execution`。`close()` 同时释放远程 MCP client socket。
- **bundle 边界**：pi 依赖链（aws-sdk/genai/openai 等）+ MCP client 随 server/worker bundle 进 `dist/*.cjs`；`build:migrate` 标 `@earendil-works/*` 与 `@modelcontextprotocol/sdk` external + adapter/桥内 dynamic import——migrate bundle 不含 pi/MCP 代码且永不会 require 它（YUK-988 教训）。
- **已知延迟画像（actual-output 封存 `docs/planning/evidence/2026-09-19-pi-adapter-*`）**：glm-5.3-flash ~11s、grok-4.6 ~51s、mimo-v2.5-pro ~57-60s+ 贴边 60s task budget——跨 provider 选模型必须尊重 per-kind timeout，mimo 在 AttributionTask 上两过一超。
