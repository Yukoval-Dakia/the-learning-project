# Sub 0d: Agent Layer · Implementation Plan

> **⚠️ STATUS (2026-05-14)**: **DEFERRED — REFRESH REQUIRED BEFORE EXECUTION**
>
> 本 plan 写于 Phase 1c 设计之前，与"完工后"的 schema/命名漂移如下。**架构方向（Pattern C / 两类 agent / Proposal 三层交付 / Copilot 与 Dreaming/Maintenance lanes）依然有效**，但执行前需要 mechanical refresh。
>
> 已知漂移：
> - 全文 `mistake` 表 → 应改 `encounter`（Phase 1c.1 DROP mistake，见 ADR-0006）
> - Step 4.1 `link_mistake_to_node` + `mistake_knowledge_links` 表 → 现实是 `mistake.knowledge_ids jsonb`（post-1c.1 是 `encounter.knowledge_ids jsonb`）；要么用 jsonb，要么先开 ADR 提议拆 junction table
> - Step 3.1 `dreaming_proposals` (复数) / `maintenance_suggestions` (复数) → 现 schema `dreaming_proposal` (单数，已存在)；naming 统一一下
> - TaskKind 命名 `attribution` / `enrich_mistake` 等（camelCase）→ 现 registry 是 PascalCase（`AttributionTask`）；plan 步骤里的 task map keys 要同步
> - Phase 1c.1 后 `EnrichMistakeTask` / `JudgeMistakeTask` / `VariantGenTask` 想改成 `*Encounter*` 命名（与 ADR-0006 + 0008 一致）
> - Step 9 agent_sessions / agent_messages 与 ADR-0008 的 `learning_session(type='conversation')` **形态高度重叠** —— 应考虑 Copilot 直接用 learning_session 多态表而非新建一对表，避免双轨
>
> **执行前流程**：
> 1. 等 Phase 1c.1 + 1c.2 落地，schema 稳定
> 2. 跑一遍 refresh：grep 修上面 5 条漂移
> 3. 与 ADR-0004 / 0006 / 0008 重新对齐
> 4. 重新评估 Step 9 agent_sessions vs learning_session(type='conversation') 关系
>
> **预估**：refresh 自身 0.5-1 d；然后 Phase 1 (Step 0-8) 4-5 d、Phase 2 (Step 9-14) 3-4 d。
>
> ---

> **For agentic workers:** REQUIRED SUB-SKILL — `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。每步 checkbox `- [ ]` 追踪进度，完成后改 `- [x]` 并 commit。
>
> **不要在 Phase 1c.1 落地之前启动 Sub 0d。** 上面 STATUS 警告解释原因。

**Goal**：落地 Pattern C 两类 agent 架构。不自建 harness — 直接用 Vercel AI SDK `generateText/streamText` + `maxSteps`，并在 `runner.ts` 加 `model?` / `baseURL?` 注入（任何 Anthropic-compatible 端点均可用）。重点：共享 tools 池 + 首批 backend purpose agents（AttributionTask / EnrichMistake / JudgeMistake）+ Proposal 三层交付（收件箱 A + 就地 B + Copilot 推送 C）+ User Copilot sidebar 基础框架 + Phase 2 夜间 agent（Dreaming / Maintenance）。

**ADRs**：`docs/adr/0004`（Pattern C）、`docs/adr/0003`（Provider 抽象延迟）

**前置条件**：Sub 0c 完成（pg-boss + SSE lane + job_events 表已就绪）。

**预估**：6-8 d 单人推进，分 Phase 1（Step 0-8）和 Phase 2（Step 9-14）。

---

## Phase 1 — Foundation + 首批 Purpose Agents + Proposal UI

### Step 0: Provider Manager + Task Model Selector

- [ ] **Step 0.1**: 新文件 `src/server/ai/providers.ts` — Provider Manager：

  ```typescript
  type ProviderName = 'anthropic' | 'openrouter' | 'vercel-gateway';

  const PROVIDERS: Record<ProviderName, { baseURL?: string; apiKeyEnv: string }> = {
    anthropic:        { apiKeyEnv: 'ANTHROPIC_API_KEY' },
    openrouter:       { baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
    'vercel-gateway': { baseURL: 'https://ai-gateway.vercel.sh', apiKeyEnv: 'VERCEL_AI_GATEWAY_TOKEN' },
  };

  export function getProvider(name: ProviderName) {
    const { baseURL, apiKeyEnv } = PROVIDERS[name];
    return createAnthropic({ baseURL, apiKey: process.env[apiKeyEnv]! });
  }
  ```

  `.env.example` 加 `OPENROUTER_API_KEY=` 和 `VERCEL_AI_GATEWAY_TOKEN=`（均为空，注释说明 optional）。

- [ ] **Step 0.2**: 在 `src/ai/registry.ts` 加 Task Model Selector：

  ```typescript
  type TaskModelConfig = { provider: ProviderName; model: string };

  const TASK_MODELS: Record<TaskKind, TaskModelConfig> = {
    attribution:    { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    enrich_mistake: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    judge_semantic: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    dreaming:       { provider: 'anthropic', model: 'claude-opus-4-7' },
    maintenance:    { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    // 其余 task 按 architecture.md §5.1 补齐
  };

  export function resolveTaskModel(
    kind: TaskKind,
    override?: Partial<TaskModelConfig>,
  ) {
    const cfg = { ...TASK_MODELS[kind], ...override };
    return getProvider(cfg.provider)(cfg.model);
  }
  ```

- [ ] **Step 0.3**: `src/server/ai/runner.ts` 改为调 `resolveTaskModel(ctx.kind)`，移除原来的硬编码 model string。`TaskContext` 加可选 `modelOverride?: Partial<TaskModelConfig>`。

  > 注意：`cache_control` on tool definitions 有已知 bug（vercel/ai #3820），非 Anthropic 直连时 tool schema 缓存可能失效；system prompt 级 caching 透传正常。

- [ ] **Step 0.4**: `AgentToolSet` 类型 = `Record<string, Tool>`；`buildToolSet(keys: string[])` helper 从全局工具 registry pick allowlist，加到 `src/server/ai/tools/index.ts`。

- [ ] **Step 0.5**: `pnpm typecheck` 通过，`pnpm test` 绿。

---

### Step 1: 共享 Read tools 池

- [ ] **Step 1.1**: 新目录 `src/server/ai/tools/`，文件 `read.ts`，实现以下 tools（均为 `tool()` from AI SDK）：

  | Tool | DB 操作 |
  |---|---|
  | `search_knowledge_by_concept` | fulltext search knowledge_nodes |
  | `get_knowledge_node` | by id |
  | `get_node_neighbors` | edges 表 join |
  | `find_similar_mistakes` | by knowledge_id |
  | `get_recent_mistakes` | recent N by created_at |
  | `get_weak_points` | mastery < threshold |
  | `get_question` | by id |

- [ ] **Step 1.2**: 导出 `READ_TOOLS` 常量（Record<string, Tool>），所有 backend purpose agents 默认包含。

- [ ] **Step 1.3**: 集成测试 `tests/tools/read.test.ts`（testcontainer，验证 search + get）。

---

### Step 2: 共享 Write tools 池

- [ ] **Step 2.1**: 新文件 `src/server/ai/tools/write.ts`：

  | Tool | DB 操作 | 限用 Task |
  |---|---|---|
  | `create_knowledge_node` | INSERT knowledge_nodes | AttributionTask, NoteGenerateTask |
  | `link_mistake_to_node` | INSERT mistake_knowledge_links | AttributionTask |
  | `update_ai_delta_mastery` | UPDATE mastery delta，可回滚 | 指定 Task |

- [ ] **Step 2.2**: `AgentToolSet` 类型 = `Record<string, Tool>`；helper `buildToolSet(keys: string[])` 从全局 registry pick。allowlist 硬编码在每个 task 定义里，不动态计算。

- [ ] **Step 2.3**: 集成测试 `tests/tools/write.test.ts`。

---

### Step 3: Propose-only tools + Proposal schema

- [ ] **Step 3.1**: Drizzle schema 加两张表：

  ```sql
  dreaming_proposals (
    id          uuid PK default gen_random_uuid(),
    kind        text NOT NULL,     -- problem|knowledge|quiz|summary|note_section_update
                                   -- learning_item_completion|learning_item_relearn|block_merge|variant
    payload     jsonb NOT NULL,
    reasoning   text,
    status      text NOT NULL DEFAULT 'pending',  -- pending|accepted|dismissed
    target_ref  text,              -- e.g. "mistake:uuid" | "knowledge:uuid"
    proposed_at timestamptz NOT NULL DEFAULT now(),
    decided_at  timestamptz
  )

  maintenance_suggestions (
    id             uuid PK default gen_random_uuid(),
    kind           text NOT NULL,  -- delete_mistake|merge_knowledge|archive|reset_fsrs
    target_ref     text NOT NULL,
    reasoning      text,
    status         text NOT NULL DEFAULT 'pending',  -- pending|accepted|dismissed|rolled_back
    snapshot_json  jsonb,          -- 执行前快照，支持回滚
    proposed_at    timestamptz NOT NULL DEFAULT now(),
    decided_at     timestamptz,
    rollback_until timestamptz
  )
  ```

  索引：`(target_ref, status)` on both tables（支持 Proposal delivery B）。

- [ ] **Step 3.2**: 新文件 `src/server/ai/tools/propose.ts`：

  | Tool | 写表 |
  |---|---|
  | `propose_completion` | dreaming_proposals kind='learning_item_completion' |
  | `propose_merge` | maintenance_suggestions kind='merge_knowledge' |
  | `propose_archive` | maintenance_suggestions kind='archive' |
  | `propose_delete_mistake` | maintenance_suggestions kind='delete_mistake' |

- [ ] **Step 3.3**: `pnpm db:generate && pnpm db:push`（testcontainer 环境）。

- [ ] **Step 3.4**: 集成测试 `tests/tools/propose.test.ts`。

---

### Step 4: AttributionTask — 首个 backend purpose agent

- [ ] **Step 4.1**: 新文件 `src/server/ai/tasks/attribution.ts`，实现 `runAttributionTask(mistakeId, db)`：
  - tools allowlist: `READ_TOOLS` + `create_knowledge_node` + `link_mistake_to_node`
  - budget: 5 steps
  - system prompt: 归因 + 知识点挂载指令（含 prompt caching header）
  - 返回 `{ cause: string, knowledge_ids: string[], degraded: boolean }`

- [ ] **Step 4.2**: 注册到 `src/ai/registry.ts` 的 task map。

- [ ] **Step 4.3**: 集成测试 `tests/tasks/attribution.test.ts` — seed 一条 mistake → runAttributionTask → 验证 knowledge link 写入。

- [ ] **Step 4.4**: `POST /api/mistakes/:id/attribution` route handler（触发 inline，也可被 pg-boss job 调）。

---

### Step 5: EnrichMistakeTask

- [ ] **Step 5.1**: 新文件 `src/server/ai/tasks/enrich_mistake.ts`：
  - 组合 Attribution + propose_completion + 知识图谱关联搜索
  - budget: 8 steps
  - 返回 `{ cause, knowledge_ids, similar_mistakes, proposals_created: number }`

- [ ] **Step 5.2**: 注册到 registry，route handler `POST /api/mistakes/:id/enrich`。

- [ ] **Step 5.3**: 集成测试。

---

### Step 6: JudgeMistakeTask

- [ ] **Step 6.1**: 新文件 `src/server/ai/tasks/judge_mistake.ts` — semantic judge：
  - tools allowlist: READ_TOOLS only（只读，不写）
  - budget: 3 steps
  - 返回 `Judgment` 对象写 DB

- [ ] **Step 6.2**: 注册 + route + 集成测试。

---

### Step 7: Proposal delivery A — 收件箱

- [ ] **Step 7.1**: `GET /api/proposals` — 聚合 dreaming_proposals + maintenance_suggestions，支持 `?status=pending&kind=all&limit=20`。

- [ ] **Step 7.2**: `PATCH /api/proposals/:type/:id` — accept / dismiss（maintenance accept 时执行 snapshot → mutate，写 decided_at）。

- [ ] **Step 7.3**: `app/proposals/page.tsx` — 收件箱页面：按 kind 分组，每条显示 reasoning + payload 摘要 + accept/dismiss 按钮。

- [ ] **Step 7.4**: 导航 badge：`GET /api/proposals/count?status=pending` → 返回数量 → 导航栏 badge 展示。

- [ ] **Step 7.5**: E2E 测试（Playwright 或 vitest + fetch）：seed proposal → GET → PATCH accept → 验证 status 变更。

---

### Step 8: Proposal delivery B — 就地展示

- [ ] **Step 8.1**: `GET /api/proposals?target_ref=mistake:{id}` 复用 Step 7.1 的 endpoint（加 target_ref filter）。

- [ ] **Step 8.2**: `app/mistakes/[id]/page.tsx` 加载时 fetch pending proposals → 内嵌 `<PendingProposals />` 组件（卡片形式，accept/dismiss inline）。

- [ ] **Step 8.3**: 知识节点页（`app/knowledge/[id]/page.tsx`）同样加 pending proposals 展示。

---

## Phase 2 — Copilot + Dreaming + Maintenance

> Phase 2 在 Phase 1 全部完成 + 稳定后开启。以下 Step 9-14 视为 handoff 规格。

### Step 9: agent_session + agent_messages schema

- [ ] Drizzle schema：

  ```sql
  agent_sessions (
    id         uuid PK,
    started_at timestamptz,
    last_active_at timestamptz,
    metadata   jsonb   -- { current_page, context_ref, ... }
  )

  agent_messages (
    id         bigserial PK,
    session_id uuid FK agent_sessions,
    role       text,   -- user | assistant | tool
    content    jsonb,
    created_at timestamptz
  )
  ```

---

### Step 10: User Copilot 基础实现

- [ ] `src/server/ai/copilot.ts` — `runCopilot({ sessionId, userMsg, pageContext, db })`：
  - tools allowlist: 全部（READ + WRITE + PROPOSE）
  - budget: 15 steps
  - 启动时从 DB 加载 session history（最近 N 条）
  - 结果写 agent_messages

- [ ] `app/api/copilot/route.ts` — SSE streaming handler，调 `streamCopilot()`。

- [ ] Copilot sidebar 组件 `src/ui/CopilotSidebar.tsx` — 基础 chat UI，读 pageContext from URL/store。

---

### Step 11: Proposal delivery C — Copilot 主动推送

- [ ] Copilot session 启动时：`SELECT count(*) FROM dreaming_proposals WHERE status='pending'` + maintenance_suggestions 同。

- [ ] 若 count > 0，第一条 assistant message 注入："昨晚我生成了 {N} 条提议，要现在看吗？"

- [ ] 用户说"看" → Copilot 逐条展示 + accept/dismiss inline（调 Step 7.2 的 API）。

---

### Step 12: DreamingTask — 夜间 pg-boss cron

- [ ] pg-boss cron：每天 18:00 UTC（北京 02:00）触发 `dreaming-scan` job。

- [ ] `dreaming-scan` worker：扫 mastery > 0.8 且 14d 未触达、久未练习等候选 → 每候选 enqueue 一条 `dreaming-unit` job。

- [ ] `dreaming-unit` worker：调 `generateText({ maxSteps, tools, ... })` with DreamingTask prompt → 写 `dreaming_proposals`。

- [ ] 重批量（变式题双 pass）走 Anthropic Batch API（submit → 次日 cron poll 结果）。

---

### Step 13: MaintenanceProposeTask — 每日 cron

- [ ] pg-boss cron：每天扫相似度高节点对（cosine > 0.9）、归档候选（60d 无访问）等。

- [ ] 每候选 → `generateText({ maxSteps, tools, ... })` with MaintenanceProposeTask prompt → 写 `maintenance_suggestions`。

- [ ] `snapshot_json` 在 accept 执行前拍快照，`rollback_until = now() + 30d`。

---

### Step 14: VariantGenTask

- [ ] pg-boss job（由 EnrichMistake 或用户手动触发）。

- [ ] 调 `generateText({ maxSteps, tools, ... })` → 生成新 Question（source='mistake_variant', draft_status='draft'）。

- [ ] 双 pass 验证：enqueue `variant-verify` job，另一个 model 跑 VariantVerifyTask。

---

## 测试策略

- 每个 task 有独立集成测试（testcontainer），seed 数据 → run → assert DB 结果。
- tools 单元测试可 mock DB（Read tools），集成测试用 testcontainer（Write / Propose tools）。
- Copilot E2E：Playwright 打开 sidebar → 输入 → 验证 agent_messages 写入 + proposal 展示。

## 验收清单（Phase 1）

- [ ] runner.ts `model?` / `baseURL?` 注入：传 OpenRouter baseURL 后 AttributionTask 仍能跑通
- [ ] AttributionTask 在 mistake 创建后能自动触发并挂载知识节点
- [ ] Proposal 收件箱展示 pending 条数 badge
- [ ] accept maintenance_suggestion 执行变更 + 存 snapshot（可手动 rollback 验证）
- [ ] 就地展示：打开一道有 pending proposal 的错题，proposal card 内嵌可见
