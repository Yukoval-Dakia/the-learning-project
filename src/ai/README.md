# ai

Task 层抽象。**不是 chat()** —— 每种产物一个 Task；tool-calling 循环交给 server-side runner，不在浏览器执行。

详见 [docs/architecture.md § 五 AI 任务层](../../docs/architecture.md#五ai-任务层llm-task-layer)。

## 边界

- **浏览器端** (`src/ai/`)：注册表 + SubjectProfile prompt builders。不持 API key，也没有通用 `runTask()` client helper。
- **Server 端** (`server/` + `src/server/ai/`)：generic `/api/ai/[task]` route 已退场。所有 task 都走 capability 领域 route / worker，由该入口解析 profile、注入工具或补齐 ingestion context。
- **Async worker** (`scripts/worker.ts` / pg-boss handlers)：复用同一个 runner 处理 OCR、归因、note generation、maintenance 等后台任务。

这样 PWA 离线时本地复习 / 错题录入仍可用，需要 LLM 的能力自然走在线。

## 加新 Task

1. 在 `registry.ts` 加 `TaskDef`（model / 预算 / 允许的 tool / 是否多模态）
2. 在领域 route 或 pg-boss handler 中解析 `SubjectProfile`，再调用 `runTask()` / `runAgentTask()` / `streamTask()`
3. 如需 HTTP 入口，建 capability 领域入口；不要复活 generic `/api/ai/[task]`
4. 写 `event` / `tool_call_log` / `cost_ledger` 留痕

破坏性操作（删错题、合并节点、reparent、archive）**没有直接 write tool**，只能 propose。用户 accept route 执行真实 mutation。

## Tool 设计

产品内 tool 的长期领域设计见 [Agent Context Tools Design](../../docs/superpowers/specs/2026-05-17-agent-context-tools-design.md)。当前实现保留 `KnowledgeReviewTask` 的 legacy `write_proposal` MCP tool，同时已经落地统一 Domain Tool Registry、MCP bridge、M1/M2 read tools，以及 Wave 3 / T-D4 proposal/write tools。

当前已落地的 MCP/tool-call 状态：

- `src/server/ai/runner.ts` 支持 `mcpServers`、`allowedTools`、`maxTurns`，并把所有 task 统一送进 Claude Agent SDK `query()`。
- `src/ai/registry.ts` 仍只给 legacy `KnowledgeReviewTask` 开了 `allowedTools: ['mcp__loom__write_proposal']`；新 DomainTool callers 应使用 `src/server/ai/tools/allowlists.ts` 生成 surface-specific `mcp__loom__*` allowlist。
- `src/server/knowledge/review.ts` 在每次 `/api/knowledge/review` 请求内创建本地 `loom` MCP server，只暴露 `write_proposal` 一个 proposal tool。
- `src/server/ai/tools/bootstrap.ts` 注册统一 DomainTools；`mcp-bridge.ts` 能把任意 allowlist 包成 in-process MCP server，并写 `tool_call_log` / `tool_use` mirror（ADR-0011 §1.1 promote 自 `experimental:tool_use`）。
- `src/server/ai/tools/knowledge-readers.ts`、`context-readers.ts`、`query-events.ts`、`query-mistakes.ts` 提供 read surface。
- `src/server/ai/tools/proposal-tools.ts` 提供 T-D4 full 8：`propose_knowledge_edge`、`propose_knowledge_mutation`、`attribute_mistake`、`propose_variant`、`propose_learning_item_completion`、`propose_learning_item_relearn`、`propose_record_links`、`propose_record_promotion`。
- generic `/api/ai/[task]` 已整体退场；不要为新 task 建通用 dispatch 入口。
- 尚未实现：公共/standalone MCP server、外部 MCP 消费、Copilot drawer / Dreaming / Coach 具体 runtime 接入。

核心原则：

- Domain Tool Registry 是源头；MCP 只是 Claude Agent SDK 的 in-process 适配层。
- Read tool 返回语义化上下文，例如 graph path、relation meaning、recent failure evidence。
- Proposal tool 写 `event(action='propose')`，不直接改硬事实。
- Action/write tool 只能包装已有 owner service（如 AttributionTask / VariantGenTask），不能让 LLM 传任意 mutation payload。
