# Partial Credit Trace + Framework Diff Baseline — P-1

**Date**: 2026-05-22
**Scope**: P-1 Phase of Foundation 真 Closeout（spec `docs/superpowers/specs/2026-05-22-foundation-true-closeout-design.md`）
**Run by**: P-1 plan agent (Claude Code, inline execution)
**Purpose**: (1) 列 `JudgeResultV2.score` / `coarse_outcome` 在判分链路各层的流向 + 标"断点"；(2) snapshot framework LOC + git SHA 作为 P0 / P1 / P2 / P3 / P4 acid test baseline；(3) `mathjs` 依赖评估笔记（spec §9 Q1）。

## §1 Partial Credit 各层现状

来源：spec §4.1（2026-05-22 verify 记录）。本表把 spec 表 transcribe + 加 actual file:line 引用，固化为 P-1 baseline，供 P3 acid test 3 对照"score 真贯穿"。

| 层 | 现在消费什么 | partial 信号 | 实现位置 |
|---|---|---|---|
| Judge (`judgeAnswer`) | 算出 `JudgeResultV2 { score, coarse_outcome, capabilityRef }` | ✅ 算出来 | `src/server/ai/judges/question-contract.ts`（route 入口）；steps@1 见 `src/server/ai/judges/steps-judge.ts` |
| Event log | event.payload.judge 含 score + coarse_outcome | ✅ 留痕完整 | `src/server/events/queries.ts:579` (`writeEvent`) |
| Review UI 显示 | `JudgeResultPanel` 显示 score + capability label + appeal 按钮 | ✅ 显示 | `src/ui/components/JudgeResultPanel.tsx` |
| Review submit route | `body.rating: FsrsRating` — UI 4 按钮点击 | ❌ **rating 由用户手点，judge.score 不参与映射** | `app/api/review/submit/route.ts:53` (`POST`) |
| `outcome` 推断 | `body.rating === 'again' ? 'failure' : 'success'` | ❌ **二元，partial 信号丢** | `app/api/review/submit/route.ts:88` |
| FSRS scheduler | `scheduleReview(prevState, body.rating, now)` | ❌ **接收 rating 不接收 score** | `src/server/review/fsrs.ts:35` |
| Mastery view | 读 event.payload.outcome（二元） | ❌ **partial 不进 mastery 计算** | PG view `knowledge_mastery`（DDL 在 `drizzle/0005_phase1c1_event_payload_gin_and_mastery_view.sql`；设计 ADR-0012；smoke test `tests/integration/mastery-view.test.ts`）—— **180d hard window + 30d 指数衰减 + 二元 outcome 聚合**；partial credit 不接入是预期行为，spec §1 已声明"partial → mastery view 这一段是 N+1" |

**结论**：判分 → 留痕 → 显示链路通；判分 → 调度链路在 review submit 那里断了。**P3 修这一段**（rating advisor + UI advisory + submit event payload `judge_advice` 字段）；mastery view 这一段（partial → mastery）是 N+1 / 后续 closeout。

## §2 Framework LOC Baseline

**Baseline SHA**: `4b8ae51aead2ce6113bf0b9586cd01700b7e0c47` (P-1 working baseline; merge 后更新为 main HEAD)
**Date frozen**: 2026-05-22

后续 P0 / P1 / P2 / P3 acid test 与本表对比；`framework diff = 0` 判定基于以下文件 LOC 不变（除下方"允许差异"表明确允许的几行变化）。

| File | LOC | Notes |
|---|---|---|
| `src/core/capability/registry.ts` | 26 | acid test 2: P1 LOC change = 0（主体） |
| `src/core/capability/types.ts` | 13 | |
| `src/core/capability/validate-profile.ts` | 136 | |
| `src/core/capability/judges/exact.ts` | 87 | |
| `src/core/capability/judges/keyword.ts` | 104 | |
| `src/core/capability/judges/semantic.ts` | 33 | |
| `src/core/capability/judges/steps.ts` | 122 | |
| `src/core/capability/judges/index.ts` | 31 | acid test 2: P1 允许 +1 行 registerJudge(unitDimensionV1) |
| `src/core/schema/activity.ts` | 23 | |
| `src/core/schema/capability.ts` | 89 | P1 允许 ScoreMeaning enum +1 项 `'unit_dimension_v1'` |
| `src/core/schema/event/**.ts` (dir total) | 707 | |
| `src/server/ai/judges/index.ts` | 53 | acid test 2: P1 LOC change = 0（主体） |
| `src/server/ai/judges/question-contract.ts` | 306 | P1 允许 +1 行 route 分支（physics + calculation → 'unit_dimension'） |
| `src/server/ai/judges/router.ts` | (not found) | spec §3 P-1 #2 列了此路径但代码中不存在；router 逻辑在 `question-contract.ts` 内 `resolveQuestionJudgeRoute`。**N+1 verify**：是否需要后续抽出独立 router 文件 |
| `src/server/ai/judges/steps-judge.ts` | 285 | |
| `src/server/review/fsrs.ts` | 77 | acid test 3: P3 LOC change = 0（FSRS 内核 / scheduleReview ABI 不变） |
| `src/server/review/activity-ref.ts` | 54 | |
| `src/ui/lib/subject.ts` | 123 | |
| `src/ui/lib/math-markdown.tsx` | 45 | |
| `src/subjects/profile.ts` | 173 | P0 允许 `this.register(physicsProfile)` + DEFAULT_ALIASES 加 `'physics' / 'physical'` 几行 |
| `app/api/review/submit/route.ts` | 188 | P3 允许 +1 optional body 字段 + event payload `judge_advice` |
| `app/api/review/plan/route.ts` | 48 | |
| `app/api/review/due/route.ts` | 166 | |
| `app/api/review/appeal/route.ts` | 71 | |

### Notes / 允许的 phase 差异

| File | Allowed delta | 来自哪个 phase |
|---|---|---|
| `src/core/capability/judges/index.ts` | +1 行 `registry.registerJudge(unitDimensionV1Capability)` | P1 |
| `src/core/schema/capability.ts` | ScoreMeaning enum +1 项 `'unit_dimension_v1'` | P1 |
| `src/server/ai/judges/question-contract.ts` | +1 行 route 分支（physics + calculation → 'unit_dimension'） | P1 |
| `src/subjects/profile.ts` | `this.register(physicsProfile)` + DEFAULT_ALIASES 加 `'physics' / 'physical'` 几行 | P0 |
| `app/api/review/submit/route.ts` | +1 optional body 字段 + event payload `judge_advice` | P3 |
| `app/(app)/review/page.tsx` | +1 `<RatingAdvisor>` 组件 (路径不在本 baseline 表，记录在此) | P3 |

其余文件 P0 / P1 / P2 / P3 LOC change **= 0**。任何超出本表的 framework diff 触发 phase 回退 + spec deltas 文档。

### Acid Test Reference

- **Acid Test 1 (P0 Foundation B)**: `git diff <BASELINE_SHA> -- src/core src/server/ai src/server/review src/ui app/api`（subject 子目录除外）应当为空
- **Acid Test 2 (P1 Foundation A)**: `src/core/capability/registry.ts` + `src/server/ai/judges/index.ts`（主体）LOC change = 0；只允许上表列出的 3 项 framework diff
- **Acid Test 3 (P3 Foundation C)**: `src/server/review/fsrs.ts` / `scheduleReview` ABI 不变；FSRS 内核 LOC change = 0；UI / submit route 按上表 P3 行允许

## §3 Capability Path Notes — `unit_dimension@1` 实现选型

P-1 评估 P2 实现路径，**不引依赖**。决策推迟到 P2 plan 启动时由 user / agent 在 P2 task 1 确认。

<填入 mathjs 评估表，Task 3 跑完时更新>

---

## P-1 commits

(在 P-1 各 Task commit 后回填 commit SHA + 一句话 changelog)
