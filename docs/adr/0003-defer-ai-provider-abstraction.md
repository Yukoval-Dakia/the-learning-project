# AI Provider 抽象推迟到真正需要切换时

> **Status (2026-05-17)**: Sub 0d 落地，下文"原决策"被 §2026-05-17 修订段更新——`providers.ts` 已存在，`xiaomi` 是当前默认 provider（12 个 task 全切），`anthropic` 退为预留 fallback。下文 §原决策 / §理由 / §触发条件 留作历史上下文，便于理解为何这一抽象在 Phase 1 大半时间被刻意延后。

---

## 原决策（2026-04，Phase 1 立项时）

**决策**：保持 Anthropic 直连（`@ai-sdk/anthropic`）作为唯一实现的 provider。`src/ai/registry.ts` 的 `Provider` 类型放宽为 `'anthropic' | 'openrouter' | 'gateway' | 'openai'` 以便未来扩展，但 `src/server/ai/runner.ts` 只实现 `anthropic` 分支，其它 throw `not implemented`。**不**在 Phase 1 提前建 provider factory / 多 provider 路由。

**理由**：

1. **Prompt caching 对 Phase 1b 成本影响巨大**。JudgeTask / AttributionTask 等任务会有大段重复 system prompt，Anthropic 原生 caching 可省 50-90% 重复 token 成本。走 OpenRouter 等代理层时 caching 行为不稳，可能完全失效。
2. **YAGNI**。当前没有第二 provider 的明确业务需求；提前做 factory = 过度设计。
3. **AI SDK 已封装好 model 接口**，切换 provider 是 ~1 天的局部重构（widen type + factory + env + cost harvest），业务代码零改动 —— **未来切换便宜，现在做抽象贵**。

**触发抽象化的明确条件**（任一满足，立即做 1 天 factory 重构）：

- 计划做跨模型评测（不同模型在同一 task 上的表现对比）→ 选 Vercel AI Gateway（observability 强）
- 想用 Gemini 等非 Anthropic 模型做 vision 实验 → 选 OpenRouter
- Anthropic prod 事故需要紧急 fallback → 选 OpenRouter
- 用户对 Anthropic 单点依赖的合规风险有顾虑 → 选 Gateway 或 OpenRouter

**2026-05-11 更新 (status: DEFERRED — Sub 0d 落地后实装)**：Sub 0d **计划**引入 `src/server/ai/providers.ts`（Provider Manager）+ `src/ai/registry.ts` 的 `resolveTaskModel()`（Task Model Selector），这是 ADR 原文所说"~1 天局部重构"的最轻实现——每个 task 在 registry 声明 `{ provider, model }`，provider 切换只改 registry 一行。

---

## 2026-05-17 修订：Sub 0d 落地，xiaomi 为当前默认 provider

**触发**：上文 §触发条件第 1 条 + 第 4 条同时满足——单用户希望在 Anthropic 直接 API 之外有 ToS-clean 的低成本通路（"用 Anthropic 协议但不走 Anthropic 订阅 OAuth，避开 ToS 限制"），且想体验 Anthropic 之外的模型（Mimo v2.5 系列）。该条件满足后立即按原 ADR 承诺做"~半天 factory 重构"，于 commit `cab0d7f`（2026-05-17）落地。

**实际状态**：

- `src/server/ai/providers.ts` ✅ 存在，导出 `resolveTaskProvider(kind, override?)`（详见 ADR-0004 §Provider Manager refresh）
- `src/server/ai/runner.ts` ✅ 经 `resolveTaskProvider()` 拿 `{ baseUrl, apiKey, model }`，不再直接 `import { anthropic } from '@ai-sdk/anthropic'`
- `src/ai/registry.ts` Provider 类型扩展为 `'anthropic' | 'xiaomi' | 'openrouter' | 'gateway' | 'openai'`；12 个 task `defaultProvider: 'xiaomi'`
- `fallbackChain` 字段保留 + 在 registry 实际填了（例：`{ provider: 'xiaomi', model: 'mimo-v2.5' }`），但 runner **目前不读**——保留作为未来 retry/降级的 schema 占位

**为何选 xiaomi 而非 OpenRouter / Vercel AI Gateway**：

1. **ToS clean**：Anthropic 订阅型 OAuth 凭据在第三方服务里跑会触 ToS，按需付费的 raw API key 又比 mimo 显著贵；mimo 是 Anthropic-protocol-compat 的独立第三方供应商，无身份转嫁问题
2. **Anthropic 协议 = 零代码改动**：mimo 暴露 `https://api.xiaomimimo.com/anthropic`，可经 `ANTHROPIC_BASE_URL` 直接路由，整套 system prompt / tool use / Claude Agent SDK query loop 都不动。OpenRouter / Gateway 也走 Anthropic 协议但加了一层抽象，未来按需启用
3. **单用户体量**：Phase 1 + Phase 2 总 task 调用量在 1k-10k 级别，定价 / 速率 / 偶发 5xx 都在 xiaomi 单 provider 容忍带内，没必要为 ~$5/mo 的负载上多 provider routing
4. **Prompt caching 行为**：mimo 端点的 cache 行为与 Anthropic 一致（实测 system prompt 命中），原 ADR 关于"代理层 caching 不稳"的担忧在协议-兼容（不是协议-转换）型供应商上消失

**Anthropic 不退场**：`anthropic` 仍在 PROVIDERS 表里，env 给 `ANTHROPIC_API_KEY` 即可整体回切，registry override 也支持单 task 切回（测试用）。

**E2E 验证**：commit `cab0d7f` 跑通 review session 结束 → SessionSummaryTask → mimo-v2.5-pro 返回 120 字 summary → cost_ledger 落 `provider=xiaomi, model=mimo-v2.5-pro, tokens_in=341, tokens_out=1063`。

**附带 budget 调整**：mimo-v2.5-pro 比 Anthropic Haiku 平均慢 ~2x；`SessionSummaryTask.budget.timeout` 30s → 60s 以避免 ~50% 的 E2E timeout abort（同样适用于其它 mimo-v2.5-pro text task）。这是 provider 切换的隐性 cost——Anthropic Sonnet 比 mimo-v2.5-pro 快但贵；选 mimo 接受这个 latency 代价。

---

## 接受的代价

- **2026-04 原决策的代价**：短期锁 Anthropic，单点故障没有备份路径——已通过 Sub 0d 落地解决
- **2026-05-17 修订后的新代价**：
  - 当前主链路锁 mimo，xiaomi 服务事故时需要手动 env 切回 `ANTHROPIC_API_KEY`（约 1 分钟操作）。**单用户工具可接受**
  - mimo-v2.5-pro 在 text task 上比 Anthropic Haiku 慢 ~2x；budget.timeout 整体上调以兼容
  - `openrouter` / `gateway` / `openai` 三 provider 仍未实装（throw `not implemented`）。若未来满足其它 trigger（跨模型评测 / Gemini vision 实验等）再按原 ADR 承诺扩展
