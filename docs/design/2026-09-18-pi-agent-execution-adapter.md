# pi-agent 执行适配器：替换 Claude Agent SDK 的迁移设计（预备稿）

> **出处说明（YUK-1030 恢复）**：本稿 2026-09-18 写于 `feat/skill-fixture` 分支
> （commit `42e9a5a3d`，与 `docs/research/2026-09-17-multi-provider-agent-products.md`
> 同批提交），当时未随 fixture 打捞合入 main；现按原样恢复供 `PLAN.md` 引用解析。
> **落地状态**：本文是迁移前设计预备稿——YUK-921 P0–P4 已于 2026-09-21 全部交付
> （P4 SDK 退役 = YUK-1025），`PiAgentAdapter` 已是唯一执行引擎。现役实现的权威描述
> 以 `src/server/ai/AGENTS.md` 与 `docs/architecture.md` §5 为准；下文保留历史原文。

> **状态**：预备稿，待 owner 裁决。关联：YUK-921（方案一已批，实施搁置）、
> `docs/research/2026-09-17-multi-provider-agent-products.md` §5（方案 A/B/C/D）、
> YUK-1007（统一配置面板，per-run 模型配置的产品消费者）。
>
> **Owner 指令（2026-09-18）**：准备用自定义 pi-agent 替换现有 Claude Agent SDK，
> 目标 = 多 provider + 按 run 定义的模型配置。本文是开工前的设计与切分预备。

## 1. 现状盘点（SDK 给我们的东西）

`src/server/ai/runner.ts`（~1400 行）经 `@anthropic-ai/claude-agent-sdk@0.3.220`
spawn `claude` 子进程执行全部 ~50 个 TaskKind，四个入口：
`runTask` / `runAgentTask` / `streamTask` / `streamTaskCollecting`，另有
`runner-fn.ts` 的 `makeRunTaskFn/makeRunTaskTextFn` 间接层（~35 个调用文件）。

| SDK 能力 | 消费点 | pi 生态对应物 |
|---|---|---|
| tool-use loop（mcpServers/allowedTools/maxTurns） | 全部 agentic 任务 | `pi-agent-core` Agent loop + `AgentTool`（in-process，无需 MCP 包装）|
| PreToolUse 门 + canUseTool | spawn-contract.ts → director.ts | `AgentOptions.beforeToolCall`（可 block + terminate）|
| SDK 子代理 `Options.agents` + Task 生命周期事件 | agency meeting director、copilot subagents | 自研 spawn：嵌套 Agent 实例 + `turn_start/end`/`tool_execution_*` 事件映射 |
| nativeCompaction + sessionContext 重注入 | copilot-execution.ts:411 | `transformContext` + `shouldStopAfterTurn`（自研压缩提示词复用现有 compileCopilotSessionContext）|
| session persist/resume（sdkSession） | copilot sdkSessionId | 本地消息回放（loom 已拥有 copilot_run 持久历史；Anthropic 无服务端 resume，语义等价）|
| skills 装载（isolated CLAUDE_CONFIG_DIR + 白名单） | populate-skills.ts → quiz-gen 系 | skill 内容注入 system prompt 或保留文件装载语义由 DomainTool 读取 |
| `outputFormat` 结构化输出 | ctx.outputFormat（anthropic lane） | pi-ai `constrainedSampling: {type:'json_schema'}`（OpenAI/Anthropic/Bedrock/Gemini 支持；mimo 仍走既有 text-JSON fallback）|
| `settingSources` 隔离 | 防 repo CLAUDE.md/hooks 泄漏进产品上下文 | **不再需要**——无 CLI 子进程，天然无泄漏面 |
| `effort` / thinking blocks | YUK-923 reasoningEffort、sdk-terminal | pi-ai 统一 `reasoning: 'off'\|'minimal'\|'low'\|'medium'\|'high'\|'xhigh'\|'max'` + `thinking_*` 流事件；EffortLevel 是近似超集直接映射 |
| `maxBudgetUsd` | anthropic metered lane | loom 侧 lifecycle 预算门（本就是我们强制层）|
| env 全替换（key/oauth 互斥 dance） | buildAgentEnv | pi-ai auth resolution 替代（无子进程 env）|
| usage/cost（SDK result USD） | run-lifecycle / cost_ledger | pi-ai `usage.cost`（catalog 费率计算 = estimated；**见 §6 R1**）|
| Task 生命周期事件（task_started/progress/updated/notification） | onTaskEvent observer | `turn_start/turn_end/tool_execution_*` 映射到同一 observer 面 |
| spawn 子进程隔离 SIGTERM 语义 | YUK-980 启动尾段窗口 | in-process AbortSignal 传播（更简单，但 in-flight 语义要重验）|
| Dockerfile `sdkdeps` stage + audit-agent-sdk-runtime-version | 部署 | 随 SDK 退役移除；pi 为纯 TS 依赖可打 bundle（不再 external）|

## 2. 目标架构（YUK-921 方案一落地形态）

```
                 ┌─ ExecutionAdapter (new seam in runner.ts) ─┐
  runTask ──────►│                                            │
  runAgentTask ─►│  Adapter A: ClaudeSdkAdapter (现有，保留)   │
  streamTask ───►│  Adapter B: PiAgentAdapter (pi-ai +        │
  streamTaskCollecting►      pi-agent-core)                   │
                 └────────────────────────────────────────────┘
```

- **Adapter 接口**：复用现有 `withPreparedSdkQuery`/`consumeSdkAttempt` 的形状——
  `prepare(options) → query(prompt) → AsyncIterable<UnifiedMessage>` + `close()`。
  `consumeSdkAttempt` 的消费循环（lifecycle/terminal/tool_call 记录）保持单一实现，
  把 `SDKMessage` 归一成内部 `RunnerMessage` 联合类型，两适配器各自产出。
- **Adapter B 内部**：`pi-ai Models` 集合（provider registry + auth + stream）+
  `pi-agent-core Agent`（tool loop）。DomainTool 不再经 mcp-bridge 包装成 SDK MCP
  server，而是直接编译成 `AgentTool`（schema 已有 zod → TypeBox 转换层需新写，
  ~薄）。远程 MCP（Exa web_search/web_fetch）保留
  `@modelcontextprotocol/sdk` 客户端，包一层 MCP→AgentTool 桥（~100 行，
  mcp-bridge.ts 反向）。
- **select seam**：`RunTaskCtx` 加 `adapter?: 'sdk' | 'pi'`（默认按 task kind →
  配置表决议，见 §4），registry/env override 继续生效。adapter 选择记录进
  `ai_task_runs` 与 provider_attempt identity（observability 不丢）。

### Provider 映射（pi-ai 内置/自定义）

| loom Provider | 现状 | pi-ai 落点 |
|---|---|---|
| xiaomi (mimo) | `XIAOMI_API_KEY` + `api.xiaomimimo.com/anthropic` | **内置 `xiaomi` provider**（env 名恰好相同）；token-plan 变体也有内置 |
| zhipu (glm) | `ZHIPU_API_KEY` + `open.bigmodel.cn/api/anthropic` | `createProvider` + `anthropicMessagesApi()` + baseUrl（或内置 zai coding plan 若端点等价，待核）|
| anthropic | `ANTHROPIC_API_KEY` | 内置 `anthropic` |
| anthropic-sub | `CLAUDE_CODE_OAUTH_TOKEN` (setup-token) | 内置 `anthropic` OAuth（`ANTHROPIC_OAUTH_TOKEN` env 或 CredentialStore 注入既有 setup-token——**待 spike 验证 setup-token 形态兼容**）|
| openrouter / gateway | 预留未接 | 内置 openrouter / `vercel-ai-gateway` |
| openai | 预留未接 | 内置 `openai`（API key）+ `openai-codex`（**ChatGPT Plus/Pro OAuth**，YUK-921 开放问题① 直接解锁 agent 级）|
| 新增 | — | xAI（grok，YUK-921 开放问题②：API key 与 OAuth 两形态皆有）、google、github-copilot、minimax、kimi、qwen、bedrock、vertex 等 15+ |

### Per-run 模型配置（本任务第二目标）

现状三层已就位：`tasks[kind].defaultProvider/defaultModel` →
`AI_PROVIDER_OVERRIDE/AI_PROVIDER_MODEL` → `ctx.override`。
pi 化后新增第四层消费面：

```ts
// RunTaskCtx 扩展（per-run 定义）
ctx.modelBinding?: {
  provider: Provider;
  model: string;
  effort?: EffortLevel;            // → pi reasoning level
  adapter?: 'sdk' | 'pi';          // 强制引擎（迁移期）
}
```

- 决议顺序不变：explicit ctx > env > registry。`resolveTaskProvider` 输出
  `ResolvedProvider`，pi adapter 侧 `models.getModel(provider, model)`。
- `ModelProfile`（YUK-924 binding→catalog→defaults 三层合并）保留作 loom 侧
  能力门（needsToolCall/isMultimodal fail-closed、structuredOutput、meteredUsd、
  timeoutClass/budgetClass）；pi 自带 catalog 用于 cost/limits，**loom binding
  层仍是权威**（mimo vision 覆盖等 operational override 不能丢）。
- YUK-1007 配置面板成为该层的只读/覆盖 UI（phase-2，不在本 epic）。

## 3. 迁移切分（lane 化）

任务谱系：~50 TaskKind，needsToolCall=true 约 9 个，isMultimodal 约 10 个。
按风险分四批，每批独立 worktree + PR + exact-head CI Gate：

| 批 | 范围 | 验证 |
|---|---|---|
| **P0 骨架** | `RunnerMessage` 联合类型 + ExecutionAdapter 接口 + Adapter A 包装现有 SDK 路径（零行为变化重构）| 全量 scoped unit/DB 不变绿即不过；migrate bundle 边界复查（YUK-988 教训）|
| **P1 单发任务** | needsToolCall=false 的单发任务（judge/extract/summarize，占大头）走 PiAgentAdapter：`models.streamSimple` + text-JSON fallback；zhipu/xiaomi custom provider 落位 | 逐 kind 灰度 flag（`AI_ADAPTER_PI_KINDS`）；真实 provider actual-output 抽样封存（revision+digest+task_run id+model+cost，同既有 gate 纪律）|
| **P2 工具循环** | needsToolCall=true 任务：DomainTool→AgentTool 编译、mcp-bridge→MCP client 桥（Exa）、tool_call_log/tool_use mirror 等价写入、`shouldRecordToolCall` 语义保真 | spawn-contract 等价门（beforeToolCall）单测移植；tool 行为测试全量移植（jyeoo 先例）|
| **P3 copilot/subagent** | streamTaskCollecting、sdkSession→本地回放、nativeCompaction→transformContext、subagents→嵌套 Agent + spawn-contract 双闸、canUseTool 等价、steering/follow-up 对齐现有排队语义 | copilot_run durable 全链路 DB 测试 + 真实 SIGTERM/Stop/重投矩阵（不弱于 YUK-980/975 验收强度）|
| **P4 退役** | Adapter A 摘除 + SDK 依赖删除 + Dockerfile sdkdeps 移除 + audit-provider-lanes/agent-sdk-runtime-version 基线更新 + vitest.shared mock 更新（pi Faux provider）| 全 gate |

每批红线：auth/计费/lifecycle 语义不回退；`ai_task_runs`/cost_ledger/provider_attempt
形状不变；capability barrel 新增导出先查会不会把 pi 依赖链拉进 migrate bundle
（build:migrate 需要 `--external` 或直接排除——pi 纯 TS 无子进程可 bundle，
但仍要过一次 SDK 同款的依赖链审计）。

## 4. Per-run 模型配置的落地顺序

1. P0 先落地 `ctx.modelBinding` 类型与决议链（SDK adapter 也认——今天就能用）。
2. P1 起 pi adapter 消费同一决议；`AI_PROVIDER_MODEL`/`ctx.override` 语义对齐。
3. P3 后补：`AI_PROVIDER_OVERRIDE` 从全局单开关扩成 per-TaskKind 表
   （YUK-921 方案 D 的 hermes `auxiliary:`/Roo per-mode profile 思路），
   config 级声明面进 `providers.ts`，UI 面归 YUK-1007。

## 5. 不做的事（scope 护栏）

- 不引入 pi 的插件/extension 系统——provider 变更频率低，config 层足够
  （调研 §5.4 同款结论）。
- 不照搬 credential_pool 多账号轮换——单 owner 单订阅，列入候选不做。
- 不动 Domain Tool Registry / capability manifest 贡献制。
- 不改 destructive-action propose-only 边界。
- OAuth 登录交互（pi `login` 流程）不做 UI——token 继续 env/文件注入。

## 6. 风险与开放问题

- **R1 成本信号降级 → 已裁决（owner 2026-09-18）**：接受全量 estimated。
  anthropic metered lane 的 SDK result USD 是 contractual，pi `usage.cost` 是
  catalog 费率估算——`cost_basis:'reported'` 随 SDK 退役成为历史值，新 attempt
  一律落 'estimated' + cost_ref 指向 pi catalog 版本与模型 id。
  `execution.meteredUsd` 字段语义重写：不再区分"SDK 报账 vs 估算"，改为标记
  "该 lane 适用 per-run 预算门"；pi 侧没有 `maxBudgetUsd` option，预算执行统一
  收归 lifecycle 的 `budget.maxCost` 闸（本来就是我们唯一的强制层，不丢能力）。
- **R2 anthropic-sub setup-token 兼容**：pi anthropic OAuth 自带 PKCE 流；
  既有 `CLAUDE_CODE_OAUTH_TOKEN` setup-token 能否作为 credential 直灌
  （或经 `ANTHROPIC_OAUTH_TOKEN` env）需 spike；OAuth-only 请求头要求
  （user-agent/x-app/mcp__ 工具前缀——调研 §2.3）pi 是否内置需实读验证。
- **R3 mimo/zhipu 行为差异**：Anthropic-compat 端点在 pi anthropic-messages
  适配下的 thinking 归一、structuredOutput:false 约束、空/无结构输出失败
  （09-13 实证过的判官解析失败形态）要重跑 actual-output 矩阵。
- **R4 in-process 隔离**：SDK 子进程消失后，llm 调用与宿主同 loop；
  超时/泄漏/CPU 尖刺的隔离边界转给 lifecycle AbortSignal + worker 进程边界，
  YUK-980 语义重验。
- **R5 pi-agent-core loop vs run-lifecycle 边界**：分析结论 = **组合，不是二选一**。
  两者本在不同层：pi loop 是「turn 引擎」（流→tool dispatch→下一 turn 的事件
  序列），run-lifecycle 是「durable envelope」（admission lease+fencing、CAS 终态
  结算、cost truth、wall-clock 预算）——pi/opencode/hermes 都没有等价物，它是
  本项目的护城河，**必须保留在外层**。真实冲突点只有七处，全部有解：
  (a) **会话状态所有权**：pi `Agent.state.messages` 是长命内存态，loom 每 run 从
      durable reader 重建 context——解法：pi agent 当 per-run scratch，`transformContext`
      由 loom 控制，不采用 pi 的 sqlite session backend（不与 copilot_run 真相双写）；
  (b) **排队语义**：pi steering/follow-up 是 run 内注入，loom ADR-0062 是 job 级
      durable FIFO——解法：禁用 steering/follow-up，Copilot 排队语义不变；
  (c) **权限门面**：SDK 的 PreToolUse+canUseTool 双闸是 SDK 特有形状，pi 只有
      `beforeToolCall` 单钩——spawn-contract 已按 toolUseId 记忆化，单钩反而更简；
  (d) **maxTurns**：pi 无内建——`shouldStopAfterTurn` 计 turn 数实现；
  (e) **structured output**：SDK 是终文 outputFormat，pi 是 tool-arg
      `constrainedSampling`——语义微差，用「emit_result 工具」模式或保留
      text-JSON fallback，按 kind 裁决；
  (f) **compaction**：SDK 内部 autoCompact+SessionStart hook 重注入是黑盒，
      pi `transformContext`（每 turn 前置）反而是更显式的挂点，YUK-945 的
      manual compact 经验直接迁移；
  (g) **终态证据**：SDK 有唯一 `result` 消息，pi 是 `agent_end`+final assistant
      message+usage——写一层 pi-terminal adapter 归一到 `TerminalResultEvidence`。
  「哪个更现代」的诚实回答：turn 引擎层 pi 更现代（provider-agnostic、thinking
  一等公民、parallel tool、TypeBox 校验、无 CLI 子进程包袱）；执行信封层
  run-lifecycle 比所有 agent 产品都强（admission fencing、CAS settlement、
  cost truth）——这是别的产品没有的生产硬化，**组合两者而不是替换**。
  选型待 spike：`agentLoop`（低层，context 全由 loom 控）vs `Agent` 类
  （带 stateful session，绕开其消息所有权）。
- **O1** codex-sub 用途（YUK-921 原开放问题①）：pi openai-codex OAuth 已内置，
  agent 级可行——但产品面是否要让 codex 跑 agentic 任务仍待 owner 圈定。
- **O2** grok 形态（原开放问题②）：pi xAI = API key；订阅 OAuth 形态 pi
  coding-agent 侧有 /login xAI——产品侧只需 API key 即可，确认即可关闭。

## 7. 建议的 Linear 结构（开工时再建）

- **YUK-921** 转 In Progress 作 umbrella epic（方案一重启，owner 已示意）。
- 子票按 §3 批次：P0 adapter seam / P1 单发 lane / P2 工具循环 / P3 copilot /
  P4 退役；另立 spike 票：R2 token 兼容 + R3 mimo actual-output 探针 +
  pi-agent-core vs 自研 loop 裁决（R5）。
- 关联登记：YUK-1007（配置面板=per-run config 消费者）、YUK-346
  （mimo→GLM 可行性被本 lane 吸收关闭）、YUK-856（provider attempts 观察面
  在本 lane 的验收依赖）、YUK-588（成本预算正交后续）。

## 8. Sweep 上下文（2026-09-18 快照）

全库 1011 票：Done 908 / Canceled 39 / Duplicate 10 / **未 Done 54**
（In Progress 3、Triage 3、Backlog 48、Todo 0、In Review 0）。
sweep 策略与分桶见会话回复；与本 epic 同泳道的票已列入 §7。
