# server/ai — runner + domain tools

> Server 侧 AI 执行层。浏览器侧 task registry + prompt builder 在 [`src/ai/`](../../ai/README.md)（不持 key）。长期 tool 设计见 [docs/superpowers/specs/2026-05-17-agent-context-tools-design.md](../../../docs/superpowers/specs/2026-05-17-agent-context-tools-design.md)。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `runner.ts` | 统一把所有 task 送进 Claude Agent SDK `query()`；支持 `mcpServers` / `allowedTools` / `maxTurns`（`runTask`/`runAgentTask`/`streamTask`）|
| `providers.ts` | Anthropic provider（xiaomi/mimo 兼容端点）|
| `log.ts` | run / event 留痕 |
| `provenance.ts` | source / `last_modified_by` 标记 |
| `judges/` | 判分 capability 实现 |
| `tools/registry.ts` + `tools/bootstrap.ts` | 统一 Domain Tool Registry（源头）|
| `tools/mcp-bridge.ts` | 把任意 allowlist 包成 in-process MCP server + 写 `tool_call_log`/`tool_use` mirror |
| `tools/allowlists.ts` | 生成 surface-specific `mcp__loom__*` allowlist |
| `tools/{knowledge-readers,context-readers,query-events,query-mistakes}.ts` | read surface（返回语义化上下文）|
| `tools/proposal-tools.ts` | T-D4 propose/write 8 个工具（propose_*, attribute_mistake）|

## 关键约束
- Domain Tool Registry 是源头；MCP 只是 Claude Agent SDK 的 in-process 适配层。
- Read tool 返回语义化上下文（graph path / relation meaning / recent failure evidence）。
- Proposal tool 写 `event(action='propose')`；action/write tool 只包装已有 owner service（AttributionTask / VariantGenTask），不能让 LLM 传任意 mutation payload。

## ANTI-PATTERNS
- generic `app/api/ai/[task]` **只允许 `ReviewIntentTask`**；profile-driven→`profile_required`，manual-rescue→`requires_domain_route`，`needsToolCall`→`tool_task_requires_domain_route`。新 task 走领域 route / worker。
- 破坏性动作无直接 write tool——只能 propose，用户 accept 才执行。
