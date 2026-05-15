# Pattern C — 两类 Agent + 共享薄 harness

**决策**：所有 LLM agent 调用统一走 `runAgent()` 共享 harness（基于 Vercel AI SDK），不引入外部 agent 框架（Hermes / OpenClaw / Claude Agent SDK 均排除）。Agent 分两类：**后端目的型（Backend Purpose）** 和 **用户副驾驶（User Copilot）**。

---

## 调用约定（不自建 harness）

**不**自建 `runAgent()` wrapper。直接用 Vercel AI SDK `generateText / streamText + maxSteps`，通过 **Provider Manager** + **Task Model Selector** 管理 model 与 provider。

### Provider Manager (`src/server/ai/providers.ts`)

```typescript
type ProviderName = 'anthropic' | 'openrouter' | 'vercel-gateway';

export function getProvider(name: ProviderName) {
  // 读各自 env var，构造 createAnthropic({ baseURL?, apiKey })
}
```

所有 Anthropic-compatible 端点（OpenRouter、Vercel AI Gateway）通过 `baseURL` 注入，不改任何业务代码。

### Task Model Selector (`src/ai/registry.ts`)

```typescript
type TaskModelConfig = { provider: ProviderName; model: string };
const TASK_MODELS: Record<TaskKind, TaskModelConfig> = { ... };

export function resolveTaskModel(kind: TaskKind, override?: Partial<TaskModelConfig>)
  : LanguageModel
```

每个 task 在 registry 里声明 `{ provider, model }`，runner 调 `resolveTaskModel(ctx.kind)` 取 model 实例。`override` 字段支持测试或临时切换，不影响默认配置。

- `session` 是 opt-in 的上层抽象，仅 User Copilot 使用。
- `tools` 来自共享工具池（`search*` / `write*` / `propose*`），由 purpose 决定 allowlist。
- `budget` = `maxSteps`（tool call 步数上限）；Backend Purpose Agent 通常 3–8，Copilot 可到 15。
- 注意：`cache_control` on tool definitions 有 vercel/ai #3820 bug，非 Anthropic 直连时 tool schema 缓存可能失效；system prompt 级 caching 透传正常。

---

## 第一类：Backend Purpose Agent

| 属性 | 值 |
|---|---|
| 生命周期 | 短，用完即丢 |
| 对话历史 | 不存储 |
| 触发方式 | pg-boss cron / pg-boss job（用户 action 触发）/ HTTP 内联 |
| 审计 | `ai_task_runs` + `ai_tool_calls` + `ai_cost_ledger` |
| 输出 | 结构化对象，写 DB（Proposal / Suggestion / enriched rows） |

**已知 task（Phase 1 现有 + Phase 2 规划）：**

| Task | 模型 | 触发 | 输出 |
|---|---|---|---|
| `EnrichMistakeTask` | Sonnet | user action / pg-boss | 归因 + 提议 + 知识点关联 |
| `JudgeMistakeTask` | Sonnet | pg-boss | 判题结论 |
| `VariantGenTask` | Opus | pg-boss | `DreamingProposal kind='variant'` |
| `DreamingTask` | Opus + Batch | pg-boss cron 每日 02:00 BJT | `DreamingProposal`（多种） |
| `MaintenanceProposeTask` | Sonnet + Batch | pg-boss cron 每日 | `MaintenanceSuggestion` |
| `BlockAssemblyTask` | Sonnet | pg-boss | `DreamingProposal kind='block_merge'` |

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
| Claude Agent SDK | 形状 OK，但 community provider（Max 订阅）不支持 custom tools |
| OpenAI Codex CLI | coding agent CLI，非可嵌入框架 |

---

## 理由

1. **Vercel AI SDK 已满足需求**：`generateText` / `streamText` + tool calling 已是完整 agent harness。手建 = 重复造轮子。
2. **prompt caching 与 Anthropic 原生绑定**：system prompt 长时 90% 省；走代理层 caching 行为不稳。
3. **两类 agent 形态差异显著**：budget / session / 触发方式三轴都不同，强行统一成一个框架比分开更复杂。
4. **破坏性操作只走 propose**：AI 不直接 mutate，保证 evidence-first 原则（见 ADR-0002、`docs/architecture.md`）。

---

## 接受的代价

- Copilot session 存 DB 增加 schema 和查询复杂度（`agent_sessions` + `agent_messages` 两张表）。Phase 2 实施时再加，不提前建。
- `budget`（max steps）需要逐 task 调参，没有自动推断机制——靠运行日志观察后手调。
