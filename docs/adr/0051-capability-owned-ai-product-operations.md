# ADR-0051 — Capability-owned AI product operations

**Status**: Accepted（Phase 0 closed；Phase 1 F1 implemented, review pending）
**Decision source**: owner 2026-08-02「直接启动 FULL」；YUK-840
**Amends**: `docs/superpowers/specs/2026-06-10-architecture-redesign-design.md` §2.1–2.2 的当前代码执行方式，不推翻其产品裁决
**Related**: YUK-767 · YUK-840 · YUK-841 · YUK-842 · YUK-847 · YUK-848 · YUK-849 · ADR-0004 · ADR-0021 · ADR-0032

## Context

上一轮 architecture deepening 已经完成静态 capability composition、`public` / `ui-public`
访问 seam、manifest route/job/tool 归属、proposal accept adapter、AI run lifecycle 与 typed API
client。它解决了“从哪里接入”，没有解决“谁拥有完整产品语义”。

在 `origin/main@19a97b89` 上，归一化 `(source file, resolved target module)` 后仍有：

- 538 条 capability → `src/server` 语义依赖；
- 70 条 `src/server` → capability deep 语义依赖；
- 63 条 cross-capability value 语义依赖；
- `agency / ingestion / knowledge / notes / practice` 组成一个非平凡 value SCC；
- 49 个 AI task 的 catalog、具体 DomainTool adapter 与若干 job handler 仍集中在中央
  runtime/quarry；领域 parse、校验、commit、outbox 与产品结果散落在 caller。

因此当前 `TaskDef`、`JobDecl` 和 tool manifest 是有用的 access/composition seam，但不是有足够
深度的产品模块。继续增加 wrapper、facade 或 manifest 字段不会自动关闭所有权。

## Implementation status (2026-08-08)

Phase 1 的首个竖切 F1 已在 YUK-847–849 实现，等待 PR exact-head CI / review：

- attribution、rerank 与 variant-gen 的 prompt/parser/预算迁入 `practice/tasks`；中央 registry
  只保留命名静态投影，既有 prompt hash 不变；
- `practice.failure-learning-attempt@v1` 从 committed attempt 事实事务性投递稳定 job identity；
  producer 不再知道 `attribution_followup` 队列；
- 两个 jobs、两个 concrete DomainTools 与 `author_question` variant operation 统一调用
  practice-owned Failure Learning；旧 knowledge job、中央 variant handler 与中央双工具实现删除；
- proposal 的 `caused_by_event_id` 指向精确 effective cause event；invalid model output 记永久失败，
  durable redelivery 不重复购买同一确定性 parse failure；
- dependency ratchet 从 `547 / 71 / 63` 收紧到 `531 / 70 / 62`。

这仍是 static modular monolith 内的本地 service seam，不是网络微服务。该变更尚未部署；由于
event-subscription bootstrap 不回放启动前历史，发布顺序必须是 worker-first，并在 subscription
active 后再替换移除了 producer raw send 的 app。

## Decision

### 1. Product operation 是顶层模块

一个需要 AI 的产品动作，以完整 operation 而不是单次模型调用为边界。owner capability 负责：

- typed input 与领域前置条件；
- prompt/output contract 与 fallback parse；
- 领域校验、幂等和最终 product outcome；
- transaction、event/outbox 与可回放因果链；
- route/job/tool 等 adapter 所需的窄接口。

route、pg-boss job、Copilot tool 和 cron 只是 operation 的入口或触发机制，不能各自重写一套
产品语义。

### 2. AI runtime 只拥有 model attempt

中央 AI runtime 负责：

- provider/model 解析与 SDK/wire adapter；
- upstream admission、预算、timeout、cancel 与 transient retry；
- SDK event → terminal result/error 的统一翻译；
- model-attempt usage、成本与审计留痕。

它不负责领域 parse 后的业务有效性、领域 transaction、proposal 语义或产品成功。观测上必须
区分 `model_attempt` 与 `product_operation`；模型 terminal success 不能冒充产品已经 parse、
commit 或交付成功。

### 3. Task contract 归 capability，中央 catalog 退化为 projection

后续以 capability-owned `TaskSpec<I, O>` 收住 input/output schema、prompt、model requirements、
tools、预算要求与 text fallback。中央 registry 在迁移期作为静态组合 projection 保留，不能继续
成为唯一语义真相源。第二个真实 wire protocol 出现前，不提前发明通用 provider plugin 接口。

### 4. 跨 aggregate 只走 owner contract

- 跨 capability 读走小而稳定的 public query port；
- 跨 capability 写走 owner use case，或在确有 durable/fan-out 价值时走事实 event；
- 单 Postgres 保留，但共享 table shape 不能替代写入不变量；
- 不做 blanket repository-per-table，也不把所有调用事件化。

### 5. 首个 ownership 竖切是 failure learning

`practice` 拥有“失败作答 → 归因 → 变式提议”的完整 product operation；`knowledge` 只提供
知识上下文查询与其自身 aggregate 写入。队列名 `attribution_followup` / `variant_gen` 在迁移中
保持稳定，避免部署兼容迁移。变式继续 propose-only，不能因架构迁移自动 accept/materialize。

首切必须删除旧的 knowledge attribution job ownership、中央 variant handler 与两个中央
tool adapter；如果新接口落地后旧实现仍并行存在，则不是完成。

### 6. 静态 modular monolith 保持

继续使用 Hono + Vite SPA + 独立 pg-boss worker + Postgres/Drizzle + R2。composition root 保持
静态、类型检查、无动态加载。当前没有独立发布团队、独占数据 owner 或必须网络隔离的故障域，
所以不拆微服务；也不建动态 plugin framework 或通用 workflow DSL。

## Enforcement

`pnpm audit:capability-boundaries` 同时执行 access seam 检查和三张 dependency debt ratchet：

1. capability → server；
2. server → capability deep；
3. cross-capability value edge 与非平凡 SCC。

baseline 使用 owner → target module 的语义边计数，不使用逐 import allowlist。当前快照与 baseline
必须精确一致：增长是 regression，下降则要求同一变更收紧 baseline，不能留下以后回涨的额度。
同一 owner-pair 内一删一增是此经济型 ratchet 的已知盲点，必须由真实 diff 的独立 review 补足。

## Consequences

- Phase 0 只建立决策、成本/容量前置与可递减 gate，不宣称现有债务已经解决。
- ownership migration 必须以竖切和 deletion test 交付，不能按目录做等价平移。
- capability manifest 继续承担 composition/ownership inventory；不会膨胀成 service locator。
- product-operation 观测与通用 durable handoff 在出现真实第二实例后再深化，不提前建空框架。
- YUK-832–836 保留为产品质量 backlog；FULL 不顺手改变其状态或验收。

## Rejected alternatives

- **拆微服务**：会把当前 SCC 变成网络循环和分布式 transaction，没有独立扩缩容/发布收益。
- **动态 plugin system**：当前静态 manifest 已足够，动态加载只增加运行时失败面。
- **600 条逐 import allowlist**：精确但维护成本不经济，会把文件移动变成架构税。
- **只包一层 typed helper**：旧 caller parse/commit/tool/job 保留时没有增加 depth，不满足 deletion
  test。
