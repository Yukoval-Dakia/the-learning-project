# AI Provider 抽象推迟到真正需要切换时

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

**接受的代价**：

- 短期锁 Anthropic，单点故障没有备份路径。**单用户工具可接受**（停机几小时不致命）。
- 未来切换需要专门一个 PR，不能"顺手"切。**用触发条件文档对冲**：条件一旦满足，明确开新 PR。
