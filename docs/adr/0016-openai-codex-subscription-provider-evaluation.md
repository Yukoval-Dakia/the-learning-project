# ADR-0016 — OpenAI Codex (via ChatGPT subscription) as alternate AI provider — evaluation

**状态**：proposed（评估阶段，不立即落地）
**日期**：2026-05-21
**前置 / 抵触**：
- 与 ADR-0003（defer-ai-provider-abstraction）抵触：ADR-0003 在 2026-05-17 revision 后明确"single Provider Manager + Anthropic-protocol providers (anthropic / xiaomi mimo)"，本 ADR 提议引入**非 Anthropic protocol 的 provider**，必须先 revisit ADR-0003
- 关联 ADR-0014（CapabilityRegistry）：capability 抽象是天然多 provider 友好的——同一 `steps@1` capability 可挂不同 provider 实现，是本 ADR 落地的好接口位
**来源**：用户提问 + 2026-05-21 调研（OpenClaw / Hermes Agent 项目证实 OpenAI 官方 OAuth path 允许第三方工具消费 ChatGPT 订阅余额）

---

## 决策（proposed）

**评估**引入 OpenAI Codex 作为本项目的第二 AI provider，通过用户的 ChatGPT 订阅（OAuth path）认证；**不立即落地**，先做 spike 评估三条具体不确定性后再决定。

如果 spike 通过，接入位点在 **`@openai/codex` TypeScript SDK** 这层（不直接走 Codex app-server JSON-RPC，也不走 OpenAI Agents SDK 重做 agent layer）。

如果 spike 不通过任何一条不确定性，本 ADR 标记 `rejected` 归档；后续重启需重新 spike。

---

## 背景

### 现状

- 项目通过自建 Provider Manager（`src/server/ai/providers.ts`）+ Claude Agent SDK 走 Anthropic protocol；当前两个 provider：`anthropic`（官方）+ `xiaomi`（mimo-v2.5* 系列，Anthropic-protocol-compat endpoint）
- AI 调用全部走 `runner.ts`，模型 ID 在 `src/ai/registry.ts` 按 task 配置（`mimo-v2.5-pro` 默认，`mimo-v2.5` fallback）
- ADR-0003（revision 2026-05-17）明文："Two providers wired today (anthropic + xiaomi); both speak Anthropic Messages protocol so they're transparently swappable via `ANTHROPIC_BASE_URL`"
- 用户当前 ChatGPT 订阅：Plus 级（**不是 Pro**）

### 触发点

2026-05-21 用户提及 OpenClaw / Hermes Agent 都能接 Codex via ChatGPT subscription，质疑早先"只能走 API key"的判断。调研证实：

- OpenAI 官方在 Codex CLI 的 app-server runtime 里提供 OAuth flow，第三方工具可让用户授权后消费 ChatGPT 订阅 quota
- ChatGPT Plus 配额：**~5h/week Codex 使用**（OpenAI 文档明示，硬上限）
- ChatGPT Pro 配额：显著更高（接近无限，未公开数值）
- OpenAI 提供三层接入：
  - **Codex app-server**（底层 JSON-RPC over stdio/WebSocket）— Hermes / OpenClaw / VS Code 扩展走这条
  - **`@openai/codex` SDK**（TS / Python）— wrap CLI，给应用嵌入用，是 OpenAI 官方推荐的第三方集成入口
  - **OpenAI Agents SDK**（`openai-agents`）— 对标 Claude Agent SDK 的高级 agent framework
- Vision 支持：Codex 底层走 GPT-5 系列，原生 vision-capable

### 为什么"评估而不立即落地"

本项目 (a) **正在跑** mimo-v2.5 这条路并工作中（M-1 + M0 plan 进行中），(b) Plus tier 配额可能撞上 e2e + cron + math vision judge 的总量，(c) Codex 的 tool use / structured output 跟 Claude 不同——本项目大量依赖 Zod schema 严格约束 LLM 输出，直接切换有未知风险。在 vision MVP 没跑通前评估 alternate provider 是过早抽象。

---

## 抵触关系：与 ADR-0003 的关系

ADR-0003（2026-05-17 revision）的核心论断：

> 现状 Two providers wired today (anthropic + xiaomi); both speak Anthropic Messages protocol so they're transparently swappable via ANTHROPIC_BASE_URL.
> 暂不引入跨 protocol 的 provider 抽象层，等真有第二种 protocol 出现再说。

本 ADR 触发了那个"等真有第二种 protocol 出现"的条件。OpenAI Codex 不说 Anthropic protocol，因此：

- **如果本 ADR 落地** → ADR-0003 必须 revision 或 supersede：Provider Manager 不再"single protocol"，需要引入"protocol adapter"层把 OpenAI Responses API / Codex JSONL 翻译成内部 unified shape
- **如果本 ADR rejected** → ADR-0003 保持现状，project 继续 single-protocol

这是个真实的架构岔路。本 ADR 不预先决策——spike 先跑。

---

## 三条必须验证的不确定性

spike 的目标是给这三条**每条一个明确 PASS / FAIL**：

### Uncertainty 1 — 配额是否够日常使用（Plus tier）

**问题**：Plus 5h/week 配额是否覆盖本项目"开发 + 测试 + 日常学习"使用？

**测法**：
- 估算 baseline：M-1 + M0 推完所有 task 总 LLM 时间（runner 已有 cost_ledger，能 trace）
- 估算稳态：每周日常学习（review + teaching + dreaming cron + maintenance）总 token / wall time
- 跑一次"M0 fixture e2e + 1 道 vision math judge + 1 次 dreaming cron"做实测时长

**PASS 条件**：稳态使用 ≤ 4h/week（留 20% 安全边距），且开发 + 测试不会瞬间打满

**FAIL 后果**：Plus 不够用，要么升 Pro（成本 $200/month）要么放弃 ADR

### Uncertainty 2 — Structured output 兼容性

**问题**：本项目 18+ task 用 Zod schema 严格约束 LLM 输出（JudgeResultV2、AttributionOutput、NoteVerification etc）。Codex 走 GPT-5 系列 + OpenAI Responses API 的 `strict: true` mode 跟 Claude 的 tool_use enforced JSON 行为是否等价？

**测法**：
- 选 3 个 task：`AttributionTask`（小 schema）、`NoteVerifyTask`（中 schema）、`SemanticJudgeTask`（大 schema 含 evidence array）
- 让每个 task 在 Codex 跑 10 次，Zod parse 成功率 + retry 次数 + 端到端延迟
- 对比同 task 在 mimo-v2.5-pro 的 baseline

**PASS 条件**：Codex 三个 task Zod parse 成功率 ≥ 95% 且延迟 ≤ mimo baseline 的 2x

**FAIL 后果**：需要在 Codex 这条路上写 "JSON repair" 层，反而比 mimo 更复杂

### Uncertainty 3 — Vision math judge 的实际效果

**问题**：M2 phase 的 `steps@1` vision judge——Codex（GPT-5 vision）和 mimo-v2.5（如果支持 vision）在数学手写草稿判分一致性 / 准确率上谁更强？

**测法**：spike 后 deferred — 等 M2 vision judge baseline 跑通，再用同一组 fixture 同时跑 Codex + mimo，比对 score 一致性 + 同图重判稳定性

**PASS 条件**：Codex 不显著差于 mimo（abs(score_diff) ≤ 0.15 on 10 fixtures）

**FAIL 后果**：vision 这条路 mimo 已经够用，没必要切

---

## Spike 范围（Phase X，命名待定）

**Goal**：在 1-2 day 内回答 Uncertainty 1 + 2（U3 等 M2 之后跑）。

**Scope**：
- 安装 `@openai/codex` + Codex CLI；走一次 OAuth 用 Plus 订阅认证
- 实现一个 `src/server/ai/providers/codex.ts` adapter — 把内部 `runTask(kind, input, ctx)` 形态翻译到 Codex SDK 的 `runAgent` / `runOnce`
- 跑 3 个 task 各 10 次，记 Zod parse 成功率 + 延迟 + 配额消耗
- spike report：`docs/superpowers/specs/2026-05-XX-codex-spike.md`，给 U1 + U2 各一个明确 PASS / FAIL

**Non-scope**:
- 不替换现有任何 task 的 provider 路由（spike 只读不写 prod）
- 不引入 OpenAI Agents SDK（如要重做 agent layer，是独立工作量）
- 不做 vision judge 测试（U3 在 M2 之后）

**Spike 入口的最小 abstraction**:

```ts
// src/server/ai/providers/codex.ts
import { runAgent } from '@openai/codex';

export interface CodexAdapterInput {
  taskKind: string;
  systemPrompt: string;
  userInput: unknown;
  responseSchema?: z.ZodTypeAny;
}

export async function callCodex(input: CodexAdapterInput): Promise<{ text: string }> {
  // wrap @openai/codex.runAgent
  // 走 OAuth 已认证的 Codex CLI
  // 把 systemPrompt + userInput 喂进去，要求结构化输出
  // 返回 text；Zod parse 由调用方继续做（保持与 mimo path 同行为）
}
```

**注意**: 这一层故意做得**极薄**——spike 不引入复杂抽象。如果 U1/U2 都 PASS，再做 ADR-0003 revision + 设计正式的 protocol adapter 层。

---

## 决策树

```
spike U1 (配额)
├── PASS → 继续 U2
│   ├── PASS → ADR 状态 → accepted；启动 ADR-0003 revision 流程
│   │            后续 ADR-0017 设计正式 protocol adapter 层
│   └── FAIL → ADR 状态 → rejected；归档 spike report
└── FAIL → ADR 状态 → rejected
              （升 Pro $200/month 决策属于另一个 ADR；本 ADR 不预设）
```

---

## 成本对照（参考，非决策依据）

| 路径 | 成本（月） | 配额 | 备注 |
|---|---|---|---|
| 当前 mimo-v2.5 | 按 token 计费 | 无硬上限（按额度） | 项目跑了 1+ month，未撞额度 |
| Codex via Plus | $20/月（已有订阅） | 5h/week | 单用户工具 + 个人学习用，可能够 |
| Codex via Pro | $200/月 | 显著更高 | 仅在 U1 FAIL 才考虑 |
| OpenAI API key 直连 | 按 token 计费（无订阅 path） | 无 | 不在本 ADR 范围（变成单纯多 provider 抽象） |

---

## 后续

- 本 ADR 不阻塞当前 vision MVP（M-1 + M0 + M2 + M3 plan）
- spike 优先级：**M-1 + M0 完成后再考虑启动**——避免分散 attention
- 如果 spike 启动，spike report 命名 `docs/superpowers/specs/2026-05-XX-codex-spike.md`
- 用户没 Pro tier 这一点是个 hard constraint，不要在 spike 阶段假设有
