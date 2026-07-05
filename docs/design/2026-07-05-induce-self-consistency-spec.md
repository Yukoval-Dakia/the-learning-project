# Design Spec: #12 induce-self-consistency — Semantic Clustering Fix

**Date:** 2026-07-05  
**Status:** Implemented (PR #706)  
**Linear:** parent YUK-538  
**Files:** `src/server/agency/conjecture/induce.ts`, `src/ai/registry.ts`, `src/ai/task-prompts.ts`

---

## Problem Statement

`claimKey` in `induce.ts` normalises only whitespace and case. When Opus runs `MindModelInductionTask` N=3 times at temperature > 0, it produces semantically equivalent but lexically distinct paraphrases. All produce distinct `claimKey` strings. The clustering step sees three singleton buckets. `dominant.length = 1`, `confidence = 1/3 ≈ 0.333`. The correct `confidence` is `1.0`.

**Example:**
- Sample 1: "你把链式法则当成导数相乘"
- Sample 2: "你误以为链式法则就是把各层导数相乘"  
- Sample 3: "你认为链式法则等价于将每层求导结果连乘"

All three express the same misconception. `claimKey` produces 3 distinct keys → `confidence = 0.333` instead of `1.0`.

**Root cause of the v1 approach gap:** A consolidation call reusing `MindModelInductionTask` with a `prompt_override` field was initially considered. This field does not exist in the task's input schema (`registry.ts` hardcodes `{ evidence_cells, prior_claim_md? }`). The fix requires a dedicated `ClaimGroupingTask`.

---

## Severity Assessment

**P2** (downgraded from register P1).

`induceConjecture` is LIVE — called unconditionally from `runResearchMeetingNightly`. No boolean gate on the induction job itself. Dark boundary sits one layer downstream: `MISCONCEPTION_PROMOTE_ENABLED === '1'` gates the conjecture→misconception hop.

Blast radius with `MISCONCEPTION_PROMOTE_ENABLED=0` (current default): proposals accumulate with miscalibrated confidence values. No misconception nodes are created, so diagnostic/recommendation weights are unaffected today.

Upgrade-trigger to P1: any plan to enable `MISCONCEPTION_PROMOTE_ENABLED` without this fix first.

---

## Literature Verdict

- Wang et al. 2022 (ICLR 2023, 4000+ citations): exact-string majority vote — correct for math/MCQ, known to fail for free text.
- Universal Self-Consistency (USC, arXiv 2311.17311, Google DeepMind 2023): LLM-as-judge selects the most consistent candidate — production-proven for free-text.
- DSPy `majority()`: string exact-match with pluggable normalize hook; `MultiChainComparison` for free-text.
- Embeddings NOT recommended: generic SBERT trained for retrieval, not equivalence; antonym confusion up to 99.9% (arXiv 2509.09714).

---

## Fix: `ClaimGroupingTask` post-collection consolidation

### New task in `src/ai/registry.ts`

`ClaimGroupingTask`: structured grouping task with CJK-aware system prompt. Input: `{ claims: string[] }`. Output: `{ groups: number[][] }`. Default provider: mimo (not Opus). `needsToolCall: false`, `maxIterations: 1`.

### `deduplicateClaims` function in `induce.ts`

Added after `claimKey`. Calls `ClaimGroupingTask` via `runTaskFn`. Returns `{ groups, cost_usd, task_run_id }`.

Fallback chain on any failure (throw, parse error, coverage mismatch): returns all-singletons (restores original `claimKey` behaviour — graceful degradation).

Coverage guard: `groups.flat().length !== claims.length` (flat count, not set size — catches duplicate indices from LLM output).

### Trigger condition in `induceConjecture`

```
if (dominant.length < drafts.length && drafts.length > 1)
```

Fires whenever samples are not byte-identical unanimous. At temperature > 0 with N=3 on Opus, this fires on essentially every nightly invocation. `claimKey` fast-path remains as O(1) short-circuit for byte-identical strings.

### Cost

+1 ClaimGroupingTask (mimo default, not Opus) per conjecture per nightly run = +3 mimo calls per nightly run total.

### Interface

`InduceConjectureInput`, `InduceConjectureResult`, `ConjectureDraft` schema: **all unchanged**. Non-breaking.

---

## Adversarial Review Findings (accepted)

| ID | Finding | Resolution |
|---|---|---|
| A-C1 | `seen.size !== N` Set-based coverage check passed for duplicate indices | Changed to `groups.flat().length !== N` |
| A-C2/A-H1 | Trigger `dominant.length < Math.ceil(drafts.length / 2)` had dead zones | Changed to `dominant.length < drafts.length` |
| A-H3/B-C1 | `prompt_override` on `MindModelInductionTask` is a no-op | Hard blocker resolved via dedicated `ClaimGroupingTask` |
| A-M1 | Dominant group tie-break non-deterministic | Secondary sort by minimum group index |
| B-H1 | Missing try/catch around dedup call | Added; falls back to singletons |
| B-H3 | Dedup cost/provenance not accumulated | `deduplicateClaims` returns `{ groups, cost_usd, task_run_id }` |
| B-H4 | "Fallback" framing — dedup is primary post-fast-path | Reframed in comments |
| B-M1 | ClaimGroupingTask must not use anthropic-sub override | No override passed; tested |

---

## Independent Review Verdict

**APPROVE.** 3 LOW findings (all spec-acknowledged, no fix required):
- FINDING-1: Out-of-range group indices — B-L1 spec-acknowledged gap; follow-up hardening
- FINDING-2: Within-group representative ordering non-deterministic — spec gap, no false negative
- FINDING-3: Missing call count assertion in one existing test — minor

---

## Tests

8 new tests in `src/server/agency/conjecture/induce.test.ts` + 1 existing test updated:

| Test | Scenario |
|---|---|
| T1 | Three paraphrase claims → confidence 1.0, agreement_count 3 |
| T2 | 2-of-3 semantic agreement → confidence 0.667 |
| T3 | Byte-identical unanimous → dedup NOT called |
| T4 | Dedup returns unparseable output → graceful degradation to 1/3 |
| T5 | Dedup throws → graceful degradation to 1/3 |
| T6 | confidence_capped applies after dedup-elevated confidence |
| T7 | 1-of-3 samples fails parse, dedup fires on 2 survivors |
| T8 | Duplicate indices in LLM output → coverage guard rejects, singleton fallback |

---

## Non-goals

- No change to N=3 induction samples
- No change to `JUDGE_ONLY_CONFIDENCE_CAP` logic
- No retroactive correction of stored proposals (pre-fix `confidence ≈ 0.33` rows remain as-is)
- No CJK-specific string normalization of `claimKey`
- Grouping call is non-deterministic; confidence is expected-value calibration, not stable per-run

---

## Follow-up Issues

| Title | Priority |
|---|---|
| `ClaimGroupingTask`: add integration test at task-runner boundary | Low |
| Add out-of-range index guard to `deduplicateClaims` (B-L1 hardening) | Low |
| Evaluate `temperature: 0` on `ClaimGroupingTask` for determinism | Low |
| Document `confidence` as expected-value in MISCONCEPTION_PROMOTE runbook | Low |
| `task_run_ids[0]` drops dedup call's ID — store full array for provenance | Low |
