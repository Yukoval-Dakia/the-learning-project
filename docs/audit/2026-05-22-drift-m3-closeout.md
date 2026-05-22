# Drift Audit — 2026-05-22 (M3 Closeout)

**Scope**: ADR-0001..ADR-0016, plans/2026-05-{18..22}-*, CLAUDE.md
**Run by**: Claude Code (manual /audit-drift)
**Trigger**: Math MVP M3 closeout — final exit gate after M-1/M0/M1/M2.1/M2.2/M2.3 ship.
**Companion**: `docs/audit/2026-05-22-drift.md` (M1 exit gate, 5 hours earlier today)

## Summary

- Aligned: 28（不展开）
- Documented-only: 0
- Undocumented: 0
- Contradicted: 0
- Phase-deferred: 6（informational — all explicitly phase-tagged in spec / N+1 follow-ups in closeout doc）

## Findings

### ✅ 2026-05-20 两条 finding — 持续清零（自 M1 起）

#### [Plan 2026-05-18] `learning_record` + `memory_brief_note` 无 ADR — **CLEARED since M1**
- ADR-0015（`docs/adr/0015-learning-record-memory-brief.md`，commit 2116be8 in PR #80）继续 in place。
- Schema 引用 `src/db/schema.ts:223` (learning_record) + `:257` (memory_brief_note) 与 ADR 声明 1:1 对齐。

#### [ADR-0003/0014 §profile-migration] registry.ts 死代码 `systemPrompt` — **CLEARED since M1**
- `src/ai/registry.ts` 12 处 `DEPRECATED (2026-05-22 M1)` 注释 in place。
- `getTaskSystemPrompt` switch exhaustive + `assertNever(task)` (src/ai/task-prompts.ts:329 vicinity)。

### ✅ M2/M3 新决策核验（自上次 audit 后落地）

#### ADR-0002 2026-05-21 修订 — question 多模态承载
- 三列 `figures` / `image_refs` / `structured` 持续在 `src/db/schema.ts:172-176`。Aligned ✓

#### ADR-0014 §M2 — `steps@1` capability
- Capability skeleton: `src/core/capability/judges/steps.ts`（stepsV1Capability manifest 注册到 createDefaultRegistry）— M2.1 ✓
- Runtime: `src/server/ai/judges/steps-judge.ts`（runStepsJudge async + accelerator + LLM + score 合成 + 4 错误路径）— M2.2 ✓
- Profile validator: mathProfile.judgeCapabilities += 'steps'，validateProfile 通过 ✓

#### Spec §3 M2 #3 — KaTeX 3+1 surface
- `<MathMarkdown>` profile-gated（notation === 'latex' 才走 remark-math + rehype-katex；undefined / 'wenyan' / 其它跳过）— `src/ui/lib/math-markdown.tsx`
- 4 surfaces 接入：review page (prompt/reference) / ArtifactSections (note body) / TeachingDrawer (turn text) / EmbeddedCheckSection (prompt + JudgeResultPanel 内 feedback/signals)
- 1 surface 默认无 notation prop（EmbeddedCheckSection 父链 ArtifactSections 决定）— 验通过 ✓

#### Spec §3 M2 #6 + #8 — UI judge route reason + appeal flow
- `JudgeResultPanel` 显示 "由 steps@1 判分" 标签 + appeal 按钮 — `src/ui/components/JudgeResultPanel.tsx` ✓
- `/api/review/appeal` 写 `experimental:appeal_request` event 经 writeEvent helper（ADR-0005 single-owner）— `app/api/review/appeal/route.ts` ✓
- 不实际重判 — spec §3 M2 #8 deferred 行为，N+1 closeout doc 已记录 ✓

#### Spec §3 M3 #2 — 非 math 路径 ActivityRef legacy
- 3 处 deferred-to-M3 `question_id` 用法（knowledge_propose_nightly.ts:53 / knowledge/review.ts:52 / EmbeddedCheckSection.tsx:88）已注释为 canonical（commit b2dac68 in this PR）— 非 ActivityRef legacy。
- 其它 ~30 处 `question_id` 引用在 M1 drift-targets §C 已分类为 legitimate（DB hub / type def / event projection / FSRS state alias / variant lineage） — Aligned ✓

### ✅ ADR-0006 v2 → ADR-0015 → 四张主表 chain
- event (ADR-0006 v2) → session_id / origin_event_id / attempt_event_id 关联完整。
- learning_record (ADR-0015 §1) → 写路径单一所有者 `src/server/records/queries.ts:74,149,174` 持续 in place。
- memory_brief_note (ADR-0015 §2) → 写路径仍 forward-locked（Dreaming agent 未落地）— Phase-deferred per ADR.

---

## Phase-deferred（informational，不计入 finding 数）

| ADR / Plan | 条目 | 推迟状态 |
|---|---|---|
| ADR-0014 §Phase N+1 | profile-driven `causeCategories` — math profile 已 100% migrated，wenyan profile 仍部分 | 仍在 incremental migration |
| ADR-0004 §第二类 | User Copilot (agent_sessions 双表) | Phase 2 未启动 |
| ADR-0006 v2 §场景3 | Dreaming agent 完整事件流 / `memory_brief_note` writer | ADR-0015 §2 显式 forward-lock；Phase 2C 范围 |
| ADR-0014 §Phase N+2 | `semantic@1` ✓ (M1 PR #76)、`steps@1` ✓ (M2.2 PR #82)、`external_judge@1`、`question_part` ActivityKind | M2 deliver 完毕；剩 2 项 N+2+ |
| M2.3 closeout 8 follow-ups | expected_signals 穿透 / 实图 e2e / appeal 重判 / 真 R2 fixtures / sanity 自动化 / fallbackChain / 类型 narrowing / prompt images role labeling | 全部入 N+1 closeout 记录 |

---

## Method Notes

- 本次检查面：M2.1 / M2.2 / M2.3 / M3 引入的所有决策（前次 M1 exit audit @ 5h 前已 cover M-1/M0/M1）。
- 抽样轮换面：ADR-0001/0004-0008/0010-0013 信任前次审计标 Aligned，本次仅 spot-check 与 M2.3 新增 surface 相关的边界。
- N+1 follow-ups 列表已固化到 `docs/superpowers/plans/2026-05-22-math-mvp-closeout.md` §"N+1 follow-ups"；后续 audit 跑只关心新代码不关心已记 follow-ups。
- 假阳性自评：本次 0 false positive。所有 M2/M3 落地决策都在 spec §3 + ADR 体系内，没有 documented-only / undocumented gap。

---

## Closing — Math MVP exit verification

Math MVP spec §3 五个 phase（M-1 / M0 / M1 / M2 / M3）全部 exit criteria 命中。详 `docs/superpowers/plans/2026-05-22-math-mvp-closeout.md`。
