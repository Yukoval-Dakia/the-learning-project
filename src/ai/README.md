# ai

Task 层抽象。**不是 chat()** —— 每种产物一个 Task；tool-calling 循环交给 server-side runner，不在浏览器执行。

详见 [docs/architecture.md § 五 AI 任务层](../../docs/architecture.md#五ai-任务层llm-task-layer)。

## 边界

- **浏览器端** (`src/ai/`)：注册表 + SubjectProfile prompt builders。不持 API key，也没有通用 `runTask()` client helper。
- **Server 端** (`app/api/ai/[task]` + `src/server/ai/`)：generic route 仅接受 `ReviewIntentTask`。SubjectProfile-driven、tool-calling、manual-rescue task 必须走领域 route / worker，由该入口解析 profile、注入工具或补齐 ingestion context。
- **Async worker** (`scripts/worker.ts` / pg-boss handlers)：复用同一个 runner 处理 OCR、归因、note generation、maintenance 等后台任务。

这样 PWA 离线时本地复习 / 错题录入仍可用，需要 LLM 的能力自然走在线。

## 加新 Task

1. 在 `registry.ts` 加 `TaskDef`（model / 预算 / 允许的 tool / 是否多模态）
2. 在领域 route 或 pg-boss handler 中解析 `SubjectProfile`，再调用 `runTask()` / `runAgentTask()` / `streamTask()`
3. 如需 HTTP 入口，先建领域入口（例如 `/api/knowledge/review`）；不要通过 generic `/api/ai/[task]` 暴露 profile-driven、manual-rescue 或半配置的 tool task
4. 写 `event` / `tool_call_log` / `cost_ledger` 留痕

破坏性操作（删错题、合并节点、reparent、archive）**没有直接 write tool**，只能 propose。用户 accept route 执行真实 mutation。

## Tool 设计

产品内 tool 的长期领域设计见 [Agent Context Tools Design](../../docs/superpowers/specs/2026-05-17-agent-context-tools-design.md)。当前实现只有 `KnowledgeReviewTask` 的本地 in-process MCP tool；统一 Domain Tool Registry 尚未落地。

当前已落地的 MCP/tool-call 状态：

- `src/server/ai/runner.ts` 支持 `mcpServers`、`allowedTools`、`maxTurns`，并把所有 task 统一送进 Claude Agent SDK `query()`。
- `src/ai/registry.ts` 只给 `KnowledgeReviewTask` 开了 `allowedTools: ['mcp__loom__write_proposal']`。
- `src/server/knowledge/review.ts` 在每次 `/api/knowledge/review` 请求内创建本地 `loom` MCP server，只暴露 `write_proposal` 一个 proposal tool。
- generic `app/api/ai/[task]` 只允许 `ReviewIntentTask`；profile-driven task 返回 `profile_required`，manual-rescue task 返回 `requires_domain_route`，`needsToolCall: true` 返回 `tool_task_requires_domain_route`。
- 尚未实现：公共/standalone MCP server、外部 MCP 消费、统一 `DomainTool` registry、read tool 套件。

核心原则：

- Domain Tool Registry 是计划中的源头；MCP 只是 Claude Agent SDK 的 in-process 适配层。
- Read tool 返回语义化上下文，例如 graph path、relation meaning、recent failure evidence。
- Proposal tool 写 `event(action='propose')`，不直接改硬事实。
- Action/write tool 只能包装已有 owner service（如 AttributionTask / VariantGenTask），不能让 LLM 传任意 mutation payload。
