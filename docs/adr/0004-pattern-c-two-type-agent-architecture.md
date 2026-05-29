# ADR-0004 — Pattern C — 两类 Agent + 共享薄 harness

**状态**：accepted
**日期**：2026-05-15

**决策**：Agent 分两类：**后端目的型（Backend Purpose）** 和 **用户副驾驶（User Copilot）**。两类共享 task registry、provider/model selection、budget、tool allowlist 和审计表，但生命周期和会话语义不同。

> **2026-05-17 implementation update**: 两类 agent 与 proposal-only 原则继续有效；runner 实现已从早期 Vercel AI SDK 方案切到 `@anthropic-ai/claude-agent-sdk`（见 `src/server/ai/runner.ts`）。Tool calling 通过 Claude Agent SDK 的 `mcpServers + allowedTools + maxTurns` 执行。旧文中对 Vercel AI SDK / Claude Agent SDK 的取舍是历史上下文，不再代表现行实现。

---

## 调用约定

> **Status (2026-05-17)**: Provider Manager 已在 `src/server/ai/providers.ts` 落地；`src/server/ai/runner.ts` 通过 Claude Agent SDK 调用 provider/model，并用独立 `CLAUDE_CONFIG_DIR` 隔离用户本机 Claude 配置。

**不**自建 tool-calling loop。直接用 Claude Agent SDK 的 query loop；项目只维护：

- Provider Manager / Task Model Selector
- `TaskDef.allowedTools`
- Domain Tool Registry（计划中；当前只有 `KnowledgeReviewTask` 的本地 in-process MCP tool，见 `docs/superpowers/specs/2026-05-17-agent-context-tools-design.md`）
- `tool_call_log` / `cost_ledger` / `event` mirror

### Provider Manager (`src/server/ai/providers.ts`)

```typescript
type ProviderName = 'anthropic' | 'xiaomi' | 'openrouter' | 'gateway' | 'openai';

export function resolveTaskProvider(kind: TaskKind, override?: { provider?: ProviderName; model?: string }) {
  // 读 registry defaultProvider/defaultModel + provider env/baseUrl，
  // 返回 Claude Agent SDK runner 需要注入的 { apiKey, baseUrl, model }
}
```

当前只 wired `anthropic` + `xiaomi`。`openrouter` / `gateway` / `openai` 是预留 provider，不应在没有真实触发前补抽象。

### Task Model Selector (`src/ai/registry.ts`)

```typescript
type TaskModelConfig = { provider: ProviderName; model: string };
const taskDef = tasks[kind]; // registry.ts declares defaultProvider/defaultModel
```

每个 task 在 registry 里声明 `{ defaultProvider, defaultModel }`，runner 调 `resolveTaskProvider(kind, ctx.override)` 取 Claude Agent SDK 环境配置。`override` 字段支持测试或临时切换，不影响默认配置。

- `session` 是 opt-in 的上层抽象，仅 User Copilot 使用。
- `tools` 当前由领域 route 手动注入；未来第二个 tool-calling task 出现时再抽共享 Domain Tool Registry，由 task purpose 决定 allowlist。
- `budget` = Claude Agent SDK `maxTurns`（tool call 步数上限）；Backend Purpose Agent 通常 3-8，Copilot 可到 15。
- MCP 是当前 SDK 的 in-process transport adapter，不是产品级插件边界。

---

## 第一类：Backend Purpose Agent

| 属性 | 值 |
|---|---|
| 生命周期 | 短，用完即丢 |
| 对话历史 | 不存储 |
| 触发方式 | pg-boss cron / pg-boss job（用户 action 触发）/ HTTP 内联 |
| 审计 | `ai_task_runs` + `ai_tool_calls` + `ai_cost_ledger` |
| 输出 | 结构化对象，写 DB（Proposal / Suggestion / enriched rows） |

**Task 现状（2026-05-17，参考 `src/ai/registry.ts`）：**

| Task | 模型 | 状态 | 触发 | 输出 |
|---|---|---|---|---|
| `AttributionTask` | mimo-v2.5-pro | ✅ 已实装 | user action / pg-boss | 错题归因（10 类 cause）+ analysis |
| `KnowledgeProposeTask` | mimo-v2.5-pro | ✅ 已实装 | user action / pg-boss | 0-3 条 propose_new 知识点 |
| `KnowledgeEdgeProposeTask` | mimo-v2.5-pro | ✅ 已注册 | maintenance / nightly | 0-5 条 knowledge_edge proposal |
| `SessionSummaryTask` | mimo-v2.5-pro | ✅ 已注册 | review session end | ≤120 字 session summary |
| `LearningIntentOutlineTask` | mimo-v2.5-pro | ✅ 已实装 | `/api/learning-intents` | 1 hub + N atomic outline |
| `NoteGenerateTask` | mimo-v2.5-pro | ✅ 已实装 | pg-boss `note_generate` | atomic artifact sections |
| `VariantGenTask` | mimo-v2.5-pro | ✅ 已注册 | pg-boss `variant_gen` | draft `question(source='mistake_variant')` |
| `TeachingTurnTask` | mimo-v2.5-pro | ✅ 已实装 | `/api/teaching-sessions/*` | Active Teaching turn |
| `ReviewIntentTask` | mimo-v2.5-pro | ✅ 已实装 | Review Orchestrator | 一句话 session intent |
| `KnowledgeReviewTask` | mimo-v2.5-pro | ✅ 已注册，tool-call | maintenance | tree / mesh mutation proposal |
| `VisionExtractTask` | mimo-v2.5 | ✅ 已实装（manual rescue only） | `POST /api/ingestion/[id]/rescue` | bbox blocks |
| `VisionExtractTaskHeavy` | mimo-v2.5 | ✅ 已实装（manual rescue only） | 同上 | bbox blocks |

**与旧 ADR-0004 版本差异**：原计划的 `EnrichMistakeTask` 已拆分为 `AttributionTask`（归因）+ `KnowledgeProposeTask`（知识点提议）。VisionExtract* 在 ADR-0002 修订（2026-05-11）中改为 manual rescue tool，不参与自动 cascade。`DreamingTask` / `MaintenanceProposeTask` / `BlockAssemblyTask` 作为 lane 级编排概念保留，但当前 registry 以更具体的 task 和 pg-boss handler 承载。

**破坏性操作（删题、合并节点）没有直接 tool**——AI 只能 propose，走 Proposal/Suggestion 流程，用户最终确认。

---

## 第二类：User Copilot（Sidebar Orchestrator）

| 属性 | 值 |
|---|---|
| 生命周期 | 长，跨页面累积 |
| 对话历史 | `agent_sessions` + `agent_messages` 写 DB |
| 触发方式 | 用户从侧边栏拉起 |
| 工具集 | 全权限（所有 backend purpose tools + UI 上下文读取） |
| UI 位置 | 侧边栏，不改动现有主界面 |

调用方在 `msgs` 中注入当前页面上下文（当前 mistake_id / review session state 等）；Copilot 通过工具主动 pull 领域数据。最终演化为系统超级入口：用户无需知道底层 task，直接说"帮我分析这道题"。

---

## 排除的外部框架

| 框架 | 排除理由 |
|---|---|
| Hermes Agent | Python，语言栈不符（ADR-0001） |
| OpenClaw | 个人助手形状，不可嵌入 |
| Claude Agent SDK | **已采用为现行 runner**；旧版排除理由已被 2026-05-17 implementation update supersede |
| OpenAI Codex CLI | coding agent CLI，非可嵌入框架 |

---

## 理由

1. **Claude Agent SDK 已满足需求**：query loop + MCP tools + maxTurns 已是完整 agent harness。手建 loop = 重复造轮子。
2. **prompt caching 与 Anthropic 原生绑定**：system prompt 长时 90% 省；走代理层 caching 行为不稳。
3. **两类 agent 形态差异显著**：budget / session / 触发方式三轴都不同，强行统一成一个框架比分开更复杂。
4. **破坏性操作只走 propose**：AI 不直接 mutate，保证 evidence-first 原则（见 ADR-0002、`docs/architecture.md`）。

---

## 接受的代价

- Copilot session 存 DB 增加 schema 和查询复杂度（`agent_sessions` + `agent_messages` 两张表）。Phase 2 实施时再加，不提前建。
- `budget`（max steps）需要逐 task 调参，没有自动推断机制——靠运行日志观察后手调。
