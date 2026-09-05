# server/ai — runner + domain tools

> Server 侧 AI 执行层。浏览器侧 task registry + prompt builder 在 [`src/ai/`](../../ai/README.md)（不持 key）。长期 tool 设计见 [docs/superpowers/specs/2026-05-17-agent-context-tools-design.md](../../../docs/superpowers/specs/2026-05-17-agent-context-tools-design.md)。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `runner.ts` | 统一把所有 task 送进 Claude Agent SDK `query()`；支持 `mcpServers` / `allowedTools` / `maxTurns`（`runTask`/`runAgentTask`/`streamTask`）|
| `sdk-terminal.ts` | 把 SDK assistant/result 消息适配为 lifecycle usage、thinking 元数据与终态证据；不持久化原始 CoT |
| `providers.ts` | Anthropic provider（xiaomi/mimo 兼容端点）+ YUK-924 provider model binding（`models` / `modelDefaults`，config-over-catalog 的 config 层）|
| `model-profiles.ts` + `model-catalog.snapshot.json` | YUK-924 ModelProfile 注册表：models.dev 裁剪快照（`pnpm gen:model-catalog` 重生成，运行时零网络）+ binding→catalog→保守默认三层合并 + needsToolCall/isMultimodal fail-closed 能力门 |
| `log.ts` | run / event 留痕 |
| `provenance.ts` | source / `last_modified_by` 标记 |
| `judges/` | 判分 capability 实现 |
| `tools/registry.ts` + `tools/register-capability-tools.ts` | 统一 Domain Tool Registry；完整 inventory 由 capability manifests 在进程启动期装配 |
| `tools/mcp-bridge.ts` | 把任意 allowlist 包成 in-process MCP server + 写 `tool_call_log`/`tool_use` mirror |
| `tools/allowlists.ts` | 生成 surface-specific `mcp__loom__*` allowlist |
| `tools/{knowledge-readers,context-readers,query-events,query-mistakes}.ts` | read surface（返回语义化上下文）|
| `tools/proposal-tools.ts` | central mixed-seed `author_question` 与其余 proposal tools；Failure Learning concrete tools 由 Practice manifest 装配 |

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
  发起自动标题模型请求。显式 skill 调用暂保留 omitted settingSources，维持已验证的
  isolated CONFIG_DIR skill discovery，并继续用 `skills` 白名单收窄可见范围。
- Read tool 返回语义化上下文（graph path / relation meaning / recent failure evidence）。
- Proposal tool 写 `event(action='propose')`；action/write tool 只包装已有 owner service（AttributionTask / VariantGenTask），不能让 LLM 传任意 mutation payload。
- release-critical FULL 审查的通用 confirmed state machine 仍在 `sealed-validation.ts`；
  collecting runner 额外透传 SDK success `result` 为 `terminalText`，但不解释其结构；
  Copilot terminal envelope 的解析与回复收口归 capability，见其 `AGENTS.md`。

## ANTI-PATTERNS
- generic `/api/ai/[task]` 已整体退场；新 task 走 capability 领域 route / worker，禁止复活通用 dispatch 入口。
- 破坏性动作无直接 write tool——只能 propose，用户 accept 才执行。

## Switchable AI provider lane (YUK-365)

默认走 mimo-v2.5（xiaomi key-auth）。设 `AI_PROVIDER_OVERRIDE=anthropic-sub` 全局切到 **Opus 4.8 via owner's Claude Max 订阅（OAuth）** —— token 是 `claude setup-token` 生成的长效 `CLAUDE_CODE_OAUTH_TOKEN`，**绝不入库不打印**。**Token + `AI_PROVIDER_OVERRIDE` 必须对三进程都可见**：大多数 AI 任务跑在 BACKGROUND pg-boss worker（`scripts/worker.ts`）里，所以放 `.env.local` 时三进程（Hono API / Vite / worker）各自在启动期跑 `loadEnv()`（`server/env`）读它——API 走 `server/index.ts`、worker 走 `scripts/worker.ts`（YUK-365 Finding 2 补：worker 此前不读 `.env.local`，背景 job 会回落 mimo），`dev:local` 也把 `.env.local` 透传给三 child。**生产/NAS**：token 经 docker-compose `.env` 同时注入 app + worker 两容器（`loadEnv` 只填空位，容器 env 永远赢）。订阅 token 与 mimo 互斥：oauth lane 在 SDK 子进程 env 里 SET `CLAUDE_CODE_OAUTH_TOKEN`、UNSET `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` + 四个 cloud-provider selector（`CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/`_ANTHROPIC_AWS`/`_FOUNDRY`，它们的优先级高于 OAuth token——YUK-365 Finding 1）（first-party endpoint only）。可选 `AI_PROVIDER_MODEL` 覆盖模型 id（lane 默认 `claude-opus-4-8`）；切到非 mimo 的其它 provider（如 `anthropic` 直连）若不设 `AI_PROVIDER_MODEL` 会 throw 明确 config 错（registry 默认 model 是 mimo id，非 mimo endpoint 不收——YUK-365 Finding 4）。**生产 SDK 版本前置**：`Dockerfile` 的 `sdkdeps` stage 必须装 `@anthropic-ai/claude-agent-sdk` 与 lockfile 同版；2026-07-31 验证版本为 `0.3.220`（bundled Claude Code `2.1.220`），旧版（如 0.3.143）CLI 会拒该 model id（YUK-365 Finding 3）。Wiring 在 `providers.ts`（`authMode: 'key' | 'oauth'` 判别式 + `AI_PROVIDER_OVERRIDE` 开关）+ `runner.ts`（`buildAgentEnv` 按 authMode 分支）。
