# ai

Task 层抽象。**不是 chat()** —— 每种产物一个 Task；tool-calling 循环交给 Vercel AI SDK，不自建。

详见 [docs/architecture.md § 五 AI 任务层](../../docs/architecture.md#五ai-任务层llm-task-layer)。

## 边界

- **浏览器端** (`src/ai/`)：注册表 + `runTask()` 客户端。不持 API key。
- **Workers 端** (`workers/src/`)：拿到 `runTask` 调用后查注册表，跑 Vercel AI SDK 的 `generateText` / `streamText` / `generateObject`，把结果回传。

这样 PWA 离线时本地复习 / 错题录入仍可用，需要 LLM 的能力自然走在线。

## 加新 Task

1. 在 `registry.ts` 加 `TaskDef`（model / 预算 / 允许的 tool / 是否多模态）
2. 在 `workers/src/index.ts` 的 dispatch 表里注册 handler
3. handler 用 Vercel AI SDK 跑（如需 tool calling，把允许的 tool 喂进 `tools: {}` 参数）
4. 写 `evidence_json` / `ToolCallLog` / `CostLedger` 留痕

破坏性操作（删错题、合并节点）**没有直接 tool**，只能 propose（详见 architecture § 五-2 propose-only 列表）。
