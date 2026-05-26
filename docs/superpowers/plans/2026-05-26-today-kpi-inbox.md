# YUK-84 — `/today` KPI inbox pending count

**Phase outline**: [`2026-05-26-track-1-followup-phase.md`](2026-05-26-track-1-followup-phase.md) W1.2
**Linear**: [YUK-84](https://linear.app/yukoval-studios/issue/YUK-84) — M1 Quick wins
**Date**: 2026-05-26
**Wave**: W1.2（after W1.1 chain-merge）
**估时**：2 pts

## 背景

[`docs/design/2026-05-15-design-brief-v2.1.md`](../../design/2026-05-15-design-brief-v2.1.md) §1.3 要求把 `/today` 的 vanity metric「知识点数」替换为 actionable 的 "AI 提议 pending"。

**Pre-flight 实证（2026-05-26）**：

| 检查 | 结果 |
|---|---|
| `/today` 第三格 label | 已是 `AI 提议 · 待审` |
| 当前 count 来源 | 3 组 legacy client query：knowledge node proposals + edge propose events + artifact generate events |
| `/inbox` 来源 | `app/api/proposals/route.ts` → `listProposalInboxPage()` 统一 inbox reader |
| drift | UI wording 已提前落地，但 KPI loader 和 `/inbox` source-of-truth 仍不一致 |

**结论**：本 lane 的核心不是改文案，而是让 `/today` 第三格使用统一 proposal inbox pending count，避免 `/today` 与 `/inbox` 对同一批 AI proposal 给出不同数字。

## Scope

- 新增 `/api/today/proposals` summary endpoint
- 新增 `src/server/today/proposal-kpi.ts`，复用 `listProposalInboxPage(db, { status: 'pending' })`
- `/today` 第三格只读新 endpoint，不再手写 edge/node/artifact 三套 pending 过滤
- 保留点击跳 `/inbox`
- 保留 breakdown trend，但按统一 `AiProposalKind` 汇总

## 不在范围内

- ❌ 改 `/inbox` 列表 UI
- ❌ 改 proposal lifecycle / ranking / signals
- ❌ 删除第四格「知识点」（当前 issue 验收只要求第三格；是否重排 KPI 留后续 UX lane）
- ❌ 引入新 proposal kind

## Cross-cutting helpers

- **CC-4 Proposal lifecycle**：统一走 `src/server/proposals/inbox.ts`，不再从 event 表重建 pending 判定。

## Exit criteria

- [ ] `/today` 第三格 count 与 `/api/proposals?status=pending` / `/inbox` pending rows 同源
- [ ] 第三格点击仍跳 `/inbox`
- [ ] KPI loader 有单测覆盖 breakdown 与 capped count
- [ ] route DB test 覆盖 mixed pending proposal rows
- [ ] `pnpm test:unit` / targeted DB test / typecheck / lint gate

## Implementation steps

1. 新建 `src/server/today/proposal-kpi.ts`
2. 新建 `app/api/today/proposals/route.ts`
3. `/today` 替换旧的多 query pending 计算
4. 补 `tests/core/today/proposal-kpi.test.ts`
5. 补 `app/api/today/proposals/route.test.ts`
6. 跑 targeted tests + typecheck + Biome

## Risks

| 风险 | 缓解 |
|---|---|
| pending proposals 超过 KPI limit，count 不精确 | response 暴露 `has_more`，UI 显示 `500+` |
| `/today` breakdown 文案与 proposal kind 演进不同步 | helper 返回 raw `by_kind`，UI 只做轻量分组；新增 proposal kind 时需同步分组口径 |
| route test 需要 testcontainers | 本地若无 Docker，至少跑 pure unit + typecheck；CI / 有 Docker 环境跑 DB test |
