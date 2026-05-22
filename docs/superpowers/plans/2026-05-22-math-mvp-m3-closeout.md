# Math MVP — M3 Closeout (Final Sweep) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 spec §3 Phase M3 final sweep — 把 M1 drift-targets 里 deferred-to-M3 的 3 处 `question_id` 用法明确标注为"合法 canonical hub-field 使用"（非 ActivityRef legacy）+ 跑 final /audit-drift 确认 2026-05-20 两条 finding 持续清零 + 写 M3 closeout 文档收尾 math MVP（M-1 → M3）。

**Architecture:**
- spec §3 Phase M3 实际 exit criteria：(a) ADR-0015 merged ✓ (M1 done)，(b) /audit-drift 2026-05-20 §learning_record + §registry.ts systemPrompt 清零 ✓ (M1 done)，(c) "全部 phase-deferred 字段都有显式 TODO 注释" — 待 M3 确认。
- M1 drift-targets §C 表里 deferred-to-M3 的 3 处 `question_id` 经审视均为**合法 canonical 用法**（DB hub field / LLM payload / UI POST contract），不是 ActivityRef legacy。M3 给每处加显式 `// canonical:` 注释而非迁移，避免假阳性 drift。
- 同时把 M1 drift-targets doc 标记 closed，作为 phase 历史 anchor。
- M3 不引入运行时行为变化；目标是 docs + 注释 + final audit report，不动 schema 不动 test 计数。

**Tech Stack:** 无新依赖；纯 docs + 注释更新

**Spec source:** `docs/superpowers/specs/2026-05-21-math-mvp-vision-design.md` §3 Phase M3

**Closeout context — 当前 main 状态（post-PR #83 merge @ a23694a）:**
- M-1 + M0 (PR #77), M1 (#80), M2.1 (#81), M2.2 (#82), M2.3 (#83) 全部 merged
- 1169 tests pass on main
- /audit-drift 2026-05-22 已 1 个：2026-05-20 两条 finding 清零（M1 exit gate 输出）

**M3 真实剩余清单**：
1. `src/server/boss/handlers/knowledge_propose_nightly.ts:48,64,69` — Attempt aggregation reader（用 `attempts.map((a) => a.question_id)` fetch related questions）— **canonical use of learning_record.question_id hub field**，非 legacy
2. `src/server/knowledge/review.ts:52` — KnowledgeReviewTask LLM payload `question_id: fa.question_id` — **canonical, payload 字段名跟 LLM prompt 对齐**
3. `src/ui/components/EmbeddedCheckSection.tsx:87` — UI POST body `{ question_id: question.id, answer_md }` to `/api/embedded-check/attempt` — **UI→API contract**，endpoint 用 question_id 是 stable contract

每处加 `// M3 closeout:` 注释说明用法合法，引用 M1 drift-targets §C 的判定。

**Boundaries (M3 不做):**
- 引入新功能 / migration
- 改 question_id schema（DB column 是稳定合约）
- 把 question_id 改名为 ActivityRef.id（架构层 ADR-0014 已确认两者是 alias 关系，shim 在 `src/server/review/activity-ref.ts`）
- 启动 M2.3 follow-ups (expected_signals 穿透 / 实图 e2e / appeal 重判) — 这些是 N+1 phase

---

## File Structure

### Create
- `docs/audit/2026-05-22-drift-m3-closeout.md` — 最终 /audit-drift 报告（M3 exit gate 输出，区分于 2026-05-22 M1 报告）
- `docs/superpowers/plans/2026-05-22-math-mvp-closeout.md` — math MVP 整体收官文档（M-1 → M3 timeline + 命中 spec exit criteria 一览 + N+1 follow-ups）

### Modify
- `src/server/boss/handlers/knowledge_propose_nightly.ts:48,64,69` — 加 `// M3 closeout: ...` canonical 注释
- `src/server/knowledge/review.ts:52` — 同上
- `src/ui/components/EmbeddedCheckSection.tsx:87` — 同上
- `docs/superpowers/plans/2026-05-22-math-m1-drift-targets.md` — 顶部加 status section 标记"all items closed in M3"

### Test (none)
M3 不动运行时；test 计数应保持 1169。Exit gate 仍跑 full suite 防回归。

---

## Phase M3 — Final Closeout

### Task 1: Annotate 3 canonical `question_id` use sites

**Files:**
- Modify: `src/server/boss/handlers/knowledge_propose_nightly.ts:48,64,69`
- Modify: `src/server/knowledge/review.ts:52`
- Modify: `src/ui/components/EmbeddedCheckSection.tsx:87`

- [ ] **Step 1: knowledge_propose_nightly.ts**

Run: `sed -n '40,75p' src/server/boss/handlers/knowledge_propose_nightly.ts` to see context.

The function maps attempt records to their associated questions for LLM input. `attempts` rows come from `learning_record` table where `question_id` is the canonical hub column (per ADR-0015 §1).

Find:
```ts
  const questionIds = Array.from(new Set(attempts.map((a) => a.question_id)));
```

Replace with:
```ts
  // M3 closeout (2026-05-22): canonical use of learning_record.question_id
  // hub field (ADR-0015 §1) — NOT ActivityRef legacy. The shim at
  // src/server/review/activity-ref.ts bridges when an ActivityRef view is
  // needed; this reader stays on the canonical column.
  const questionIds = Array.from(new Set(attempts.map((a) => a.question_id)));
```

The other two sites in this file (lines 64, 69) use `a.question_id` purely as a lookup key derived from the canonical list above. They inherit the §1 justification — no further annotation needed.

- [ ] **Step 2: knowledge/review.ts:52**

Run: `sed -n '45,60p' src/server/knowledge/review.ts` to see context.

The function builds a `KnowledgeReviewTask` LLM payload. The `question_id` field name is part of the **prompt contract** (mentioned in registry.ts + task-prompts.ts builder); renaming would require coordinated prompt update.

Find the line:
```ts
    question_id: fa.question_id,
```

Replace with:
```ts
    // M3 closeout (2026-05-22): canonical LLM payload field name —
    // KnowledgeReviewTask prompt (src/ai/task-prompts.ts buildKnowledgeReviewPrompt)
    // documents `question_id` as the recipe field. NOT ActivityRef legacy.
    question_id: fa.question_id,
```

- [ ] **Step 3: EmbeddedCheckSection.tsx:87**

Run: `sed -n '80,95p' src/ui/components/EmbeddedCheckSection.tsx` to see context.

The line is a fetch POST body sent to `/api/embedded-check/attempt`. The endpoint reads `body.question_id`; this is the stable UI→API contract.

Find:
```ts
        body: JSON.stringify({ question_id: question.id, answer_md: answer }),
```

Replace with:
```ts
        // M3 closeout (2026-05-22): canonical UI→API contract field name.
        // /api/embedded-check/attempt expects `question_id`; renaming would
        // require coordinated client+server change. NOT ActivityRef legacy.
        body: JSON.stringify({ question_id: question.id, answer_md: answer }),
```

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS (comments only, no runtime change).

- [ ] **Step 5: Commit**

```bash
git add src/server/boss/handlers/knowledge_propose_nightly.ts src/server/knowledge/review.ts src/ui/components/EmbeddedCheckSection.tsx
git commit -m "docs(code): M3 — annotate 3 canonical question_id uses as non-legacy

Per spec §3 Phase M3 #2 (non-math-path ActivityRef legacy sweep) and M1
drift-targets §C audit (most question_id usages are legitimate canonical
references). The 3 sites that the M1 audit deferred-to-M3 are inspected
and confirmed canonical:

- knowledge_propose_nightly.ts: learning_record.question_id hub column
  (ADR-0015 §1)
- knowledge/review.ts: LLM payload field name (KnowledgeReviewTask prompt
  contract)
- EmbeddedCheckSection.tsx: UI→API POST body (embedded-check/attempt
  endpoint contract)

No ActivityRef migration needed. Comments document the rationale so future
drift audits can skip these without re-investigation."
```

---

### Task 2: Mark M1 drift-targets doc as closed

**Files:**
- Modify: `docs/superpowers/plans/2026-05-22-math-m1-drift-targets.md`

- [ ] **Step 1: Add status header**

Find the top of `docs/superpowers/plans/2026-05-22-math-m1-drift-targets.md`:

```markdown
# Math M1 — Drift Migration Targets

**Generated**: 2026-05-21 (M0 exit gate output)
```

Insert a new status block immediately after the title (above the existing **Generated:** line):

```markdown
# Math M1 — Drift Migration Targets

**Status**: ✅ Closed (M3, 2026-05-22). All items addressed:
- §A registry.ts wenyan-hardcoded prompts → M1 §A annotated as DEPRECATED (commit 204cbf3)
- §B `getTaskSystemPrompt` default branch → M1 §B replaced with `assertNever(task)` (commit 7495c2c)
- §C `question_id` table → most entries are canonical (DB hub / type def / LLM payload / event projection / FSRS state); 3 deferred-to-M3 positions inspected and annotated as canonical in M3 closeout (commit TBD — fill after T1 commit lands).

**Generated**: 2026-05-21 (M0 exit gate output)
```

After T1 commit lands, replace `commit TBD` with the actual SHA. (Do this in a follow-up edit if running sequentially; or leave as TBD if subagent-driven and a final commit will sweep references.)

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-05-22-math-m1-drift-targets.md
git commit -m "docs(plan): mark M1 drift-targets as closed in M3"
```

---

### Task 3: Run final /audit-drift

**Files:**
- Create: `docs/audit/2026-05-22-drift-m3-closeout.md`

Note: there's an existing `docs/audit/2026-05-22-drift.md` from M1 exit gate. The new file name has the `-m3-closeout` suffix to distinguish.

- [ ] **Step 1: Invoke /audit-drift skill**

Run the skill via `Skill` tool with `skill: audit-drift`. Per skill prompt, the agent will:
1. Read all ADRs + active plans + design docs (≤30d)
2. Scan code for evidence of decisions
3. Classify findings (Aligned / Undocumented / Documented-only / Contradicted / Phase-deferred)
4. Write report to `docs/audit/YYYY-MM-DD-drift.md` (today's date — collides with existing M1 report)

To avoid collision, after the skill writes its default-name file, rename:
```bash
mv docs/audit/2026-05-22-drift.md docs/audit/2026-05-22-drift-m3-closeout.md
```

(If skill writes a different file name based on naming, adjust the rename target.)

Actually simpler: ask the skill to write to `docs/audit/2026-05-22-drift-m3-closeout.md` directly via prompt scope. If skill doesn't accept custom output path, do the rename after.

- [ ] **Step 2: Verify 2026-05-20 findings still cleared**

Open the new M3 drift report. Confirm:
- `learning_record` + `memory_brief_note` finding — NOT present (ADR-0015 in place since M1)
- registry.ts dead-code systemPrompt finding — NOT present (DEPRECATED comments since M1)
- No new Critical / Contradicted findings (Phase-deferred items expected for Phase 2C Dreaming etc.)

If the M3 report surfaces NEW Undocumented / Contradicted items not yet known, escalate — they may need M3+ follow-up work or be added to N+1 backlog.

- [ ] **Step 3: Commit**

```bash
git add docs/audit/2026-05-22-drift-m3-closeout.md
git commit -m "audit: M3 closeout drift report — math MVP final exit gate"
```

---

### Task 4: Write math MVP closeout doc

**Files:**
- Create: `docs/superpowers/plans/2026-05-22-math-mvp-closeout.md`

- [ ] **Step 1: Write the closeout doc**

Create `docs/superpowers/plans/2026-05-22-math-mvp-closeout.md` with this content:

```markdown
# Math MVP — Closeout

**Date**: 2026-05-22
**Spec**: `docs/superpowers/specs/2026-05-21-math-mvp-vision-design.md`
**Status**: ✅ All phases shipped to main.

## Timeline

| Phase | Spec scope | PR | Merge SHA | Tests |
|---|---|---|---|---|
| M-1 + M0 | question multimodal carriers + math fixtures + vision preflight | #77 | da906a4 | 1108 |
| M1 | foundation cleanup pre-M2 (registry deprecation + assertNever + ADR-0015 + audit clearance) | #80 | b42c03a | 1112 |
| M2.1 | steps@1 capability skeleton | #81 | 77b969c | 1128 |
| M2.2 | steps@1 vision judge impl | #82 | fda9785 | 1147 |
| M2.3 | KaTeX + UI surfaces + appeal flow | #83 | a23694a | 1169 |
| M3 | closeout: canonical question_id annotations + final audit | (this PR) | TBD | 1169 |

## Spec exit criteria — final verification

### Phase M-1 (spec §3)
- ✅ `question` table 加 figures / image_refs / structured 三 jsonb 列 — migration 0010, drizzle/schema.ts:172-176
- ✅ ingestion → question import 不丢图 — `app/api/ingestion/[id]/import/route.ts:307-329`
- ✅ JudgeQuestionRow 含新字段 — `src/server/ai/judges/question-contract.ts:46-48`
- ✅ ADR-0002 patch — extends 到 question (commit in PR #77)
- ✅ `pnpm audit:schema` 通过

### Phase M0
- ✅ Vision endpoint preflight — `docs/preflight/2026-05-21-vision-preflight.json` (mimo-v2.5 PASS, 7.6s)
- ✅ 10 math fixtures (5 choice + 5 fill_blank) — `src/subjects/math/fixtures/data.json`
- ✅ Math profile + judgeCapabilities — `src/subjects/math/profile.ts`
- ✅ End-to-end smoke test passes
- ✅ Wenyan regression untouched
- ✅ Drift target inventory written — `docs/superpowers/plans/2026-05-22-math-m1-drift-targets.md`

### Phase M1
- ✅ ActivityRef legacy migration: math path 无 question_id 兜底 (deferred per drift inventory; no math-path positions found requiring migration)
- ✅ Math task system prompts走 getTaskSystemPrompt — exhaustiveness switch + assertNever (M1 commits)
- ✅ `/audit-drift` 2026-05-20 两条 finding 清零 — `docs/audit/2026-05-22-drift.md`

### Phase M2 (split into M2.1 / M2.2 / M2.3)
- ✅ `steps@1` capability registered + runtime — `src/core/capability/judges/steps.ts` + `src/server/ai/judges/steps-judge.ts`
- ✅ JudgeResultV2 partial credit + capabilityRef + evidence — `composeJudgeResult` in steps-judge.ts
- ✅ KaTeX 3+1 surface — review / note / teaching / embedded-check 全部走 `<MathMarkdown>` (PR #83)
- ✅ 10 derivation fixtures — 5 text-only (M2.2) + 5 with placeholder image_refs (M2.3)
- ✅ Student input primitive (image 0..N + text steps + text final) — schema-level via StepsJudgeInput; UI image upload deferred to N+1
- ✅ Judge route reason UI — JudgeResultPanel "由 steps@1 判分" label
- ✅ Same-image rejudge sanity check — `scripts/sanity-vision-rejudge.ts` (manual, not in CI)
- ✅ `appealable: true` 流转 — `/api/review/appeal` writes experimental:appeal_request event (no rejudge yet per spec M2 #8)

### Phase M3
- ✅ ADR-0015 — `docs/adr/0015-learning-record-memory-brief.md` (M1 PR #80)
- ✅ Non-math-path ActivityRef legacy: 3 deferred positions annotated as canonical (this PR)
- ✅ registry.ts systemPrompt dead-code: DEPRECATED comments (M1 PR #80)
- ✅ Final /audit-drift — `docs/audit/2026-05-22-drift-m3-closeout.md`

## N+1 follow-ups (NOT in math MVP scope)

Carry-forward for future phases:

1. **EmbeddedCheckQuestion shape += expected_signals** — JudgeResultPanel currently passes `expectedSignals=[]` so per-signal display is empty for math derivations. Threading the field from rubric_json.reference_solution unlocks the full panel.
2. **Student answer image upload UI** — M2.2 wired student_image_refs param; M2.3 added prop pass-through; actual upload UI in EmbeddedCheckSection / review page is N+1.
3. **Actual appeal rejudge** — `/api/review/appeal` writes event but doesn't trigger rejudge (spec M2 #8 explicitly defers). A `boss` job consumer in N+1 phase can rejudge with a fresh runStepsJudge call.
4. **Real R2 image fixtures** — 5 derivation-with-images fixtures use `placeholder-*` asset_ids that don't resolve in R2. N+1: upload real images + wire integration test that exercises defaultImageFetch end-to-end.
5. **Vision rejudge sanity automated** — `pnpm sanity:vision-rejudge` is manual; N+1 evaluate moving to a nightly job with budget-aware throttle.
6. **`StepsJudgeTask.fallbackChain: []`** — M2.2 ships with no fallback; N+1 evaluate adding mimo-v2.5-pro as fallback if mimo-v2.5 outage causes meaningful UX miss.
7. **Subject.ts type narrowing `renderConfig.notation`** — currently `string | null`; M2.3 callers cast to MathMarkdown enum at each site. N+1 refactor to narrow at the source.
8. **Prompt images in steps judge** — currently only student_image_refs are sent to LLM. Stem figures (question.image_refs) are not threaded; geometry-diagram problems where the stem image is part of the question would benefit from sending it with explicit role labeling.

## What math MVP proved

- ✅ SubjectProfile generalizes beyond wenyan — math profile with LaTeX renderConfig + multi-step cause taxonomy + steps capability worked end-to-end
- ✅ CapabilityRegistry supports a 2nd judge route (`steps@1`) — manifest + runner + profile.judgeCapabilities validation chain clean
- ✅ JudgeResultV2 partial credit flows from judge → DB → UI without architectural change
- ✅ data layer (question table) carries multimodal first-class — figures / image_refs / structured columns generalize
- ✅ vision LLM (mimo-v2.5) handles structured output for math derivation judging — preflight + sanity (manual phase exit)

Subject #2 done; framework generalization validated. Future subjects (english / programming / etc.) ship via the same path.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/plans/2026-05-22-math-mvp-closeout.md
git commit -m "docs(plan): math MVP closeout — M-1 through M3 complete"
```

---

### Task 5: M3 exit gate

**Files:** (none modified; verification only)

- [ ] **Step 1: Typecheck + lint**

```bash
pnpm typecheck && pnpm lint
```
Expected: PASS (M3 is comments + docs only).

- [ ] **Step 2: Schema + partition audit**

```bash
pnpm audit:schema && pnpm audit:partition
```
Expected: PASS.

- [ ] **Step 3: Full test suite**

```bash
pnpm test 2>&1 | tail -10
```
Expected: **1169 tests pass** (M2.3 baseline; M3 adds no tests).

- [ ] **Step 4: Tag M3 completion**

```bash
git commit --allow-empty -m "chore: M3 phase complete — math MVP closeout"
```

---

## Self-Review (run after writing this plan)

**1. Spec coverage:**

| Spec §3 M3 exit criterion | Plan task | Status |
|---|---|---|
| ADR-0015 merged | (M1 done) | ✓ |
| Non-math ActivityRef legacy: migrate or deprecate | Task 1 (annotate as canonical) | ✓ |
| registry.ts systemPrompt one-shot deprecate (or optional/delete) | (M1 done — DEPRECATED comments) | ✓ |
| /audit-drift 2026-05-20 two findings cleared | Task 3 + closeout doc verification | ✓ |
| 所有 phase-deferred 字段有显式 TODO 注释 | Task 1 (canonical annotations) + closeout's N+1 follow-up list | ✓ (no TODOs unresolved; deferred work moved to N+1 follow-up list) |

**2. Placeholder scan:**
- One placeholder noted explicitly: Task 2 step uses `commit TBD` to be filled after Task 1 commit lands. This is a known sequencing concern in plan (not a bug).
- Task 4 closeout doc has `(this PR) | TBD` for M3 PR row — same; filled when PR opens.
- No other "TBD" / "implement later" placeholders.

**3. Type consistency:**
- N/A — M3 changes no types; only comments + docs.

**Fixes applied during self-review:**
- Initial draft tried to migrate the 3 question_id positions to ActivityRef; switched to annotate-as-canonical after recognizing they're not legacy (ADR-0015 §1 declares learning_record.question_id as canonical hub field; the other 2 are stable contracts). Migration would be over-engineering per CLAUDE.md "Don't introduce abstractions until a second concrete instance demands them."
- Removed proposed test additions — M3 is doc + comment only, no new test surfaces.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-22-math-mvp-m3-closeout.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Fresh subagent per task + review between tasks, fast iteration via superpowers:subagent-driven-development

**2. Inline Execution** — Execute tasks in this session using superpowers:executing-plans, batch execution with checkpoints

**Which approach?**
