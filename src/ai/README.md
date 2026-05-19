# ai

Task 层抽象。**不是 chat()** —— 每种产物一个 Task；tool-calling 循环交给 server-side runner，不在浏览器执行。

详见 [docs/architecture.md § 五 AI 任务层](../../docs/architecture.md#五ai-任务层llm-task-layer)。

## 边界

- **浏览器端** (`src/ai/`)：注册表 + `runTask()` 客户端。不持 API key。
- **Server 端** (`app/api/ai/[task]` + `src/server/ai/`)：generic route 只接受 `needsToolCall=false` 的 single-shot task；tool-calling task 必须走领域 route，由该 route 注入正确的 MCP server / allowed tools。
- **Async worker** (`scripts/worker.ts` / pg-boss handlers)：复用同一个 runner 处理 OCR、归因、note generation、maintenance 等后台任务。

这样 PWA 离线时本地复习 / 错题录入仍可用，需要 LLM 的能力自然走在线。

## 加新 Task

1. 在 `registry.ts` 加 `TaskDef`（model / 预算 / 允许的 tool / 是否多模态）
2. 在 route 或 pg-boss handler 中调用 `runTask()` / `runAgentTask()` / `streamTask()`
3. 如需 tool calling，先建领域入口（例如 `/api/knowledge/review`），在该入口内注入 MCP server；不要通过 generic `/api/ai/[task]` 暴露半配置的 tool task
4. 写 `event` / `tool_call_log` / `cost_ledger` 留痕

破坏性操作（删错题、合并节点、reparent、archive）**没有直接 write tool**，只能 propose。用户 accept route 执行真实 mutation。

## Tool 设计

产品内 tool 的长期领域设计见 [Agent Context Tools Design](../../docs/superpowers/specs/2026-05-17-agent-context-tools-design.md)。当前实现只有 `KnowledgeReviewTask` 的本地 in-process MCP tool；统一 Domain Tool Registry 尚未落地。

当前已落地的 MCP/tool-call 状态：

- `src/server/ai/runner.ts` 支持 `mcpServers`、`allowedTools`、`maxTurns`，并把所有 task 统一送进 Claude Agent SDK `query()`。
- `src/ai/registry.ts` 只给 `KnowledgeReviewTask` 开了 `allowedTools: ['mcp__loom__write_proposal']`。
- `src/server/knowledge/review.ts` 在每次 `/api/knowledge/review` 请求内创建本地 `loom` MCP server，只暴露 `write_proposal` 一个 proposal tool。
- generic `app/api/ai/[task]` 遇到 `needsToolCall: true` 会返回 `tool_task_requires_domain_route`，不会尝试裸跑缺少 MCP server 的 tool task。
- 尚未实现：公共/standalone MCP server、外部 MCP 消费、统一 `DomainTool` registry、read tool 套件。

核心原则：

- Domain Tool Registry 是计划中的源头；MCP 只是 Claude Agent SDK 的 in-process 适配层。
- Read tool 返回语义化上下文，例如 graph path、relation meaning、recent failure evidence。
- Proposal tool 写 `event(action='propose')`，不直接改硬事实。
- Action/write tool 只能包装已有 owner service（如 AttributionTask / VariantGenTask），不能让 LLM 传任意 mutation payload。
