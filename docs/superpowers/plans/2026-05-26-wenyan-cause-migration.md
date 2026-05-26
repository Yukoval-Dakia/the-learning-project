# YUK-83 — wenyan `profile.causeCategories` 100% migration

**Phase outline**: [`2026-05-26-track-1-followup-phase.md`](2026-05-26-track-1-followup-phase.md) W1.1
**Linear**: [YUK-83](https://linear.app/yukoval-studios/issue/YUK-83) — M1 Quick wins
**Date**: 2026-05-26
**Wave**: W1.1（M1 chain-merge 首位）
**估时**：2 pts

## 背景

[`docs/audit/2026-05-22-drift.md`](../../audit/2026-05-22-drift.md) §Phase-deferred 列：

> "ADR-0014 §Phase N+1 — 归因分类法 profile-driven（已落地 50% — math profile 已有完整 causeCategories；wenyan profile 部分迁移）— 仍在 incremental migration"

并明确："如果未来 wenyan profile 完成，本项可移到 Aligned"。

**Pre-flight 实证（2026-05-26）**：

| 检查 | 结果 |
|---|---|
| `pnpm audit:profile` baseline | ✅ 全绿（3 profiles, 0 invalid, 0 warnings） |
| `validateProfile()` 红线 | 不卡 wenyan —— 只校验结构性（unique id / schema 合规），不校验深度 |
| math `causeCategories` | 11 类（含 4 subject-specific：`calculation` / `method` / `unit_error` / `time_pressure`） |
| wenyan `causeCategories` | 7 类（全部 subject-agnostic：`concept` / `knowledge_gap` / `reading` / `memory` / `expression` / `carelessness` / `other`） |
| Profile-driven attribution 链路 | ✅ 已落地 —— `src/core/schema/cause.ts:validateCauseAgainstProfile()` 把 AI 输出 clamp 到 profile causes；`buildAttributionPrompt` 从 profile 渲染 taxonomy；`getCauseLabel/Priority` 走 profile lookup |
| Consumer hardcoded `CausePrimary` enum | 🟡 `src/ui/primitives/CauseBadge.tsx:10-19` + `app/(app)/review/page.tsx:73-82` 有 TS union；display-only，**不在本 lane 范畴**（不会卡 runtime，drift doc 只标 profile content） |

**结论**：drift 不是 validator 红线，是 wenyan 缺 subject-specific 归因通道，导致 AttributionTask 对文言文典型错因（词义 / 语法 / 句式 / 翻译方法）只能落到泛 `concept` 或 `expression`，失去 actionable 价值。

## Scope

**只改一个文件**：`src/subjects/wenyan/profile.ts`

新增 4 个 wenyan-specific cause categories（与 math 的 `method/calculation/unit_error/time_pressure` 对应，文言语义重映射）：

| 新 id | label | description | review_priority | variant_targetable | 对应 math 类 |
|---|---|---|---|---|---|
| `grammar` | 语法判断 | 词类活用、虚词功能、句式判断错误 | 4 | true | （wenyan-only） |
| `word_meaning` | 词义混淆 | 古今异义、一词多义、固定搭配辨析错误 | 4 | true | （wenyan-only） |
| `method` | 方法选择 | 翻译策略、审题方向、阅读分析方法选择不当 | 3 | true | `method` ↔ |
| `time_pressure` | 时间压力 | 限时阅读 / 翻译节奏失稳，步骤选择稳定性下降 | 2 | true | `time_pressure` ↔ |

**保留**全部现有 7 类（顺序、id、description、priority 不动），新增 4 类追加在 `carelessness` 前。

最终 wenyan `causeCategories.length === 11`，与 math depth 持平。

## 不在范围内

- ❌ 改 `CauseBadge.tsx` / `review/page.tsx` 的 hardcoded TS union（drift doc 不追踪此项；改了会扩散影响）
- ❌ 改 `VARIANT_CAUSE_STRATEGIES` map（已有 fallback 路径，新增 4 个 id 走 fallback "围绕「{label}」设计..."）
- ❌ 改 AttributionTask prompt（prompt 已 profile-driven，新 category 自动出现在 taxonomy 列表）
- ❌ 改 wenyan fixture（如果现有 fixture 没碰到新 cause id，不动；不为新 category 强加 fixture）
- ❌ math / physics profile 任何改动
- ❌ Subject-specific cause 命名规范统一（如有歧义留 ADR 触发条件，不在本 lane）

## Cross-cutting helpers

- **CC-5 `pnpm audit:profile` + `SubjectRegistry.register()`**：本 lane 唯一硬约束 —— audit 必须 green，否则启动期抛错

## Exit criteria

- [x] **Baseline** `pnpm audit:profile` green（pre-flight 已确认）
- [ ] wenyan `causeCategories.length === 11`，4 个新 id 合 `^[a-z][a-z0-9_]*$` regex
- [ ] `pnpm audit:profile` 后续 green，0 invalid / 0 warnings
- [ ] `pnpm test:unit -- profile` wenyan profile 单测 pass（新结构兼容）
- [ ] `pnpm typecheck` 通过
- [ ] drift log 2026-05-22 wenyan deferred 项可关（手动在下一次 `/audit-drift` 验证）

## Implementation steps

1. 编辑 `src/subjects/wenyan/profile.ts`：在 `causeCategories` 数组 `expression` 后、`carelessness` 前插入 4 个新条目
2. 跑 `pnpm audit:profile` → 期望 OK
3. 跑 `pnpm test:unit --run -- profile` → 期望全绿
4. 跑 `pnpm typecheck` → 期望 0 error
5. Pre-PR：`pnpm lint`
6. Commit 走 conventional commit + Closes [YUK-83](https://linear.app/yukoval-studios/issue/YUK-83)

## Risks

| 风险 | 缓解 |
|---|---|
| AttributionTask 对历史 attempt 重判时分配新 cause → 历史 mistake 列表 cause filter 不连续 | 历史 attempt 不重判；新 cause 只对 lane merge 后新 attempt 生效。`getCauseLabel/Priority` 已 fallback 到 `other`，不会断 UI |
| 新 cause id 与未来 ADR 命名冲突（例如 future "syntax" 替代 "grammar"） | 选 `grammar` / `word_meaning` 是 ADR-0014 §4 cause taxonomy 自由空间，无现有命名占用；如需 rename，迁移用 DB-level cause backfill cron（不在本 lane） |
| Consumer hardcoded `CausePrimary` TS union 没列新 id → TS 报错 | 已确认 union 类型是 `CausePrimary \| string`（CauseBadge `cause.primary: CausePrimary \| string`），不卡 |

## ADR 触发条件（本 lane 不触发）

- 若发现 wenyan 还需 `cultural_context` / `text_corpus_gap` 等 wenyan-only cause —— 留下次 phase 引入，避免单 PR 改太多
