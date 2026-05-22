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
- ✅ `question` table 加 figures / image_refs / structured 三 jsonb 列 — migration 0010, `src/db/schema.ts:172-176`
- ✅ ingestion → question import 不丢图 — `app/api/ingestion/[id]/import/route.ts:307-329`
- ✅ JudgeQuestionRow 含新字段 — `src/server/ai/judges/question-contract.ts:46-48`
- ✅ ADR-0002 patch — extends 到 question (commit in PR #77 / docs/adr/0002-…md 末尾 2026-05-21 revision)
- ✅ `pnpm audit:schema` 通过

### Phase M0
- ✅ Vision endpoint preflight — `docs/preflight/2026-05-21-vision-preflight.json` (mimo-v2.5 PASS, 7.6s elapsed)
- ✅ 10 math fixtures (5 choice + 5 fill_blank) — `src/subjects/math/fixtures/data.json`
- ✅ Math profile + judgeCapabilities — `src/subjects/math/profile.ts`
- ✅ End-to-end smoke test passes — `src/subjects/math/fixtures/e2e.smoke.test.ts`
- ✅ Wenyan regression untouched
- ✅ Drift target inventory written — `docs/superpowers/plans/2026-05-22-math-m1-drift-targets.md` (marked Closed in M3)

### Phase M1
- ✅ ActivityRef legacy migration: math path 无 question_id 兜底 (deferred per drift inventory; no math-path positions found requiring migration)
- ✅ Math task system prompts走 getTaskSystemPrompt — exhaustiveness switch + assertNever (M1 commits)
- ✅ `/audit-drift` 2026-05-20 两条 finding 清零 — `docs/audit/2026-05-22-drift.md` (M1) + persistence verified in `docs/audit/2026-05-22-drift-m3-closeout.md` (M3)

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
- ✅ Non-math-path ActivityRef legacy: 3 deferred positions annotated as canonical (this PR commit b2dac68)
- ✅ registry.ts systemPrompt dead-code: DEPRECATED comments (M1 PR #80)
- ✅ Final /audit-drift — `docs/audit/2026-05-22-drift-m3-closeout.md` (0 new findings)

## N+1 follow-ups (NOT in math MVP scope)

Carry-forward for future phases. Pre-recorded so future drift audits can skip them without re-investigation.

1. **EmbeddedCheckQuestion shape += expected_signals** — JudgeResultPanel currently passes `expectedSignals=[]` so per-signal display is empty for math derivations. Threading the field from rubric_json.reference_solution unlocks the full panel.
2. **Student answer image upload UI** — M2.2 wired `student_image_refs` param; M2.3 added prop pass-through; actual upload UI in EmbeddedCheckSection / review page is N+1.
3. **Actual appeal rejudge** — `/api/review/appeal` writes event but doesn't trigger rejudge (spec M2 #8 explicitly defers). A `boss` job consumer in N+1 phase can rejudge with a fresh runStepsJudge call.
4. **Real R2 image fixtures** — 5 derivation-with-images fixtures use `placeholder-*` asset_ids that don't resolve in R2. N+1: upload real images + wire integration test that exercises `defaultImageFetch` end-to-end.
5. **Vision rejudge sanity automated** — `pnpm sanity:vision-rejudge` is manual; N+1 evaluate moving to a nightly job with budget-aware throttle.
6. **`StepsJudgeTask.fallbackChain: []`** — M2.2 ships with no fallback; N+1 evaluate adding mimo-v2.5-pro as fallback if mimo-v2.5 outage causes meaningful UX miss.
7. **Subject.ts type narrowing `renderConfig.notation`** — currently `string | null`; M2.3 callers cast to MathMarkdown enum at each site. N+1 refactor to narrow at the source.
8. **Prompt images in steps judge** — currently only `student_image_refs` are sent to LLM. Stem figures (question.image_refs) are not threaded; geometry-diagram problems where the stem image is part of the question would benefit from sending it with explicit role labeling.

## What math MVP proved

- ✅ **SubjectProfile generalizes beyond wenyan** — math profile with LaTeX renderConfig + multi-step cause taxonomy + steps capability worked end-to-end
- ✅ **CapabilityRegistry supports a 2nd judge route** (`steps@1`) — manifest + runner + profile.judgeCapabilities validation chain clean
- ✅ **JudgeResultV2 partial credit flows from judge → DB → UI** without architectural change
- ✅ **Data layer (question table) carries multimodal first-class** — figures / image_refs / structured columns generalize
- ✅ **Vision LLM (mimo-v2.5) handles structured output for math derivation judging** — preflight + sanity (manual phase exit)
- ✅ **Spec planning model** (M-1 / M0 / M1 / M2.1 / M2.2 / M2.3 / M3 fine-split) shipped on schedule with reviewer-flagged P1/P2 caught and fixed each PR

Subject #2 done; framework generalization validated. Future subjects (english / programming / etc.) ship via the same path.
