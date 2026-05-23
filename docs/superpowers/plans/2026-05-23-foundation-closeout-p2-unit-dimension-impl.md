# Foundation 真 Closeout — P2 `unit_dimension@1` Real Implementation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** P2 phase — replace `unit_dimension@1` P1 skeleton with real implementation: deterministic accelerator (mathjs unit lib) + LLM fallback (mimo-v2.5 for non-parseable inputs) + 4 错误路径 score 合成；physics fixture 端到端跑通各错误路径并通过 mock + real LLM 测试。**3-4 day workload per spec.**

**Architecture:**

```
   student_answer + question
        │
        ▼
  ┌───────────────────────────────────────────┐
  │  unit_dimension@1.run()  (src/core/cap…)  │
  └───────────────┬───────────────────────────┘
                  │
       ┌──────────┴──────────┐
       ▼                     ▼
  Deterministic         LLM Fallback
   Accelerator        (mimo-v2.5 vision)
   (mathjs.unit)         async, mock-able
       │                     │
       └──────────┬──────────┘
                  ▼
        Score Composition (4 paths)
                  │
                  ▼
         JudgeResultV2 with:
           - score: 0.0 / 0.3 / 0.4 / 0.7 / 1.0 / null
           - coarse_outcome
           - signal (numeric_close / numeric_off / unit_mismatch /
                     dimension_mismatch / missing_unit / etc.)
           - score_meaning: 'unit_dimension_v1'
           - capability_ref: { id: 'unit_dimension', version: '1.0.0' }
```

**Tech Stack:** mathjs (D1 confirm) / Claude Agent SDK (for mimo-v2.5 fallback via existing `runTask` pattern in steps-judge.ts) / Zod / Vitest.

**Spec source:** `docs/superpowers/specs/2026-05-22-foundation-true-closeout-design.md` §3 Phase P2 (line 133-156) + §7 `unit_dimension@1` Capability (line 360-413) + §8.1 Risks (line 416-424). Outline `docs/superpowers/plans/2026-05-22-foundation-true-closeout-phases.md` P2 row.

**Predecessor**: P1 ship via PR #97 `558a8c6` — registry skeleton + routing + acid test 2 passed.

---

## Decision points (must confirm BEFORE Task 1; treat as P2/0 issue)

These 4 decisions shape the implementation surface. Plan currently picks the recommended option for each but must be confirmed by user / agent at P2 startup. Once decided, append note to "Spec deltas observed" section.

### D1: mathjs adoption (Option A vs B)

| Option | Per P-1 audit `docs/audit/2026-05-22-partial-credit-trace.md` §3 |
|---|---|
| **A. mathjs@15.2.0** | ⭐ recommended — Apache-2.0, active (2026-04-07 last release), `math.unit('30 km/h').to('m/s').toNumber()` ✓; +~8 MB to server bundle (server-only, acceptable per audit) |
| B. self-written SI base-7 | ~2-3 day effort eats P2 budget; long tail unit-alias coverage |

**Confirm**: A. Trigger rollback condition (per audit doc): A fails if Next standalone build size +>10 MB, or mathjs goes >6mo without release, or unit module not tree-shakeable. Verify in Task 1 before committing dep.

### D2: reference value / unit plumbing

P1 physics fixtures already carry `reference_value: 8.33`, `reference_unit: "m/s"`, `tolerance: 0.05` in `src/subjects/physics/fixtures/data.json` (per P-1 work). But the framework `JudgeQuestionRow` (`src/server/ai/judges/question-contract.ts`) does NOT expose `metadata` to judges. P2 needs reference data inside the judge.

| Option | Pros | Cons |
|---|---|---|
| (D2a) **Add `metadata` pass-through to `JudgeQuestionRow`** + 1 row in `resolveQuestionJudgeRoute` to forward | minimal framework touch (1 type field + 1 line) | counts as P2 framework diff — must record in spec deltas; P1 already broke strict zero-diff (1 router branch); precedent set |
| (D2b) Add structured `reference_value` / `reference_unit` / `reference_tolerance` columns to `question` table | clean schema | schema change = DB migration + breaks acid test 1 ex-post; over scope |
| (D2c) Parse `reference_md` string for value+unit (e.g. "8.33 m/s") | no framework / schema change | brittle — `reference_md` is human markdown not structured; physics fixtures vary format |

**Confirm**: (D2a). Reasoning: P1 already added 3 lines to question-contract.ts; one more for metadata pass-through is in spirit of "small diff per phase". Record both in spec deltas as Foundation A acid test caveat (acid test 2 specifically said "0 行 diff in src/core/capability/registry.ts + src/server/ai/judges/index.ts main body"; question-contract.ts is the explicit allowed exception per audit doc baseline §2 notes table).

### D3: `latency_class` for the runner manifest

Spec §7.1 says `latency: 'sync'` with footnote "accelerator sync；fallback async（runner 内部决定）". But `LatencyClass` enum (`src/core/schema/capability.ts:9`) is `['sync', 'async']` — single value. Can't say "depends".

| Option | Implication |
|---|---|
| (D3a) Keep `sync` | misleading when LLM fallback fires (sync caller blocks on async LLM call internally — works in JS but ABI-lies) |
| (D3b) **Change to `async`** ⭐ | accurate; consumers can plan around async; matches steps@1 which is async |

**Confirm**: (D3b). Note spec deltas: revise §7.1 from `latency: 'sync'` to `latency: 'async'`. Trivial change — P1 skeleton currently has `latency_class: 'sync'`; update.

### D4: LLM model for fallback

Project convention (steps-judge.ts / math vision judge) uses **mimo-v2.5** via Claude Agent SDK `runTask`. Same model for unit_dimension fallback unless project moves to mimo-v2.5-pro for higher accuracy (not now).

**Confirm**: mimo-v2.5. Use existing `runTask`-style injection (steps-judge pattern), with `runTaskFn` / mock injection for tests.

---

## Spec deltas observed (after D1-D4 confirmed, fill in actual deviations)

- D1 confirmed: Option A, `mathjs@15.2.0`. Rationale: Context7/current docs confirm `math.unit(...)`, `.to(...)`, `.toNumber(...)`, and `.equalBase(...)` cover the deterministic accelerator needs; `pnpm build` passed after adding the dependency. Standalone output was 74M before any `mathjs` import was traced, so final imported-size impact is rechecked in Task 7.
- D2 confirmed: D2a, metadata pass-through; `JudgeQuestionRow` += `metadata?: unknown` field — this is framework delta per Foundation A acid test 2 strict reading. Pre-existing 1-row delta in question-contract.ts from P1 already established precedent.
- D3 confirmed: D3b, manifest `latency_class: 'async'`; **scope expanded** per codex review #98 round 2 (line 922): D3 is not just a manifest `latency_class` string change. To support async LLM fallback inside the runner, the framework runner contract must allow async return:
  - `src/core/capability/types.ts`: `JudgeCapabilityRunner.run()` signature relaxed to `JudgeResultV2T | Promise<JudgeResultV2T>` (1-line type change)
  - `src/server/ai/judges/index.ts`: `judgeRouterV2` becomes `async` + `await runner.run(...)` + return type `Promise<JudgeResultV2T>` (3-line change)
  - `src/server/ai/judges/question-contract.ts`: any path calling `judgeRouterV2` adds `await` (1-3 lines)
  - This counts as Foundation A acid test 2 deltas — explicit in 验证 step (Task 7). Trade-off vs alternatives: dropping LLM fallback (P2 spec violation) / pre-computing fallback async outside runner (queue infra超 P2 scope). The 5-line framework contract widening is the smallest viable change.
- D4 confirmed: mimo-v2.5 via Claude Agent SDK.

### Spec §7.4 reclassification (codex review #98 round 2, line 575)

`JudgeResultV2` schema (`src/core/schema/capability.ts:70-91`) imposes hard constraints:
- `incorrect` → score **literal 0**
- `partial` → score `(0, 0.85)`
- `correct` → score `[0.85, 1]`
- `unsupported` → score `null`, confidence **literal 0**

Spec §7.4 line 411 says `numeric_off` → score `0.3` + `incorrect` — **conflicts** with schema. Plan reclassifies:

| signal | spec §7.4 outcome | revised outcome (schema-compliant) | score |
|---|---|---|---|
| (correct) | correct | correct | 1.0 |
| numeric_close | partial | partial | 0.7 |
| **numeric_off** | ~~incorrect~~ | **partial** | 0.3 |
| **unit_mismatch_same_dimension** | partial | partial | 0.4 |
| dimension_mismatch | incorrect | **incorrect** | **0** |
| missing_unit | incorrect | **incorrect** | **0** |
| unparseable + fallback OK | (per branch) | (per fallback细分) | (per fallback细分) |
| unparseable + fallback fails | unsupported | unsupported | null, confidence=0 |

Pedagogy preserved: signal still surfaced in `evidence_json.signal`; `coarse_outcome=partial` for "partially understood" cases (numeric error, wrong unit but right dim) gives a clearer FSRS / UX signal than the schema-illegal score=0.3 incorrect.

### Task 7 regression note (2026-05-23)

`pnpm test:unit` surfaced two baseline test-expectation drifts unrelated to `unit_dimension`: `origin/main`'s `mathProfile` already includes `time_pressure`, while `src/core/schema/schema.test.ts` and `src/ui/lib/cause-options.test.ts` still expected `time_pressure` to be outside math cause options. P2 updates those tests only to match the implemented profile; no runtime cause/profile code changes.

Task 7 acid-test-2 observed deltas against `9191c160a20d8e5afabf11503c6851f510bd2182`:
- `src/core/capability/registry.ts`: empty diff (hard zero satisfied).
- `src/core/capability/types.ts`: numstat `1 insert / 1 delete` — `JudgeCapabilityRunner.run()` sync return widened to sync-or-Promise.
- `src/server/ai/judges/index.ts`: numstat `5 insert / 4 delete` — P1 `unit_dimension` kind addition plus P2 `judgeRouterV2` / `judgeRouter` async widening.
- `src/server/ai/judges/question-contract.ts`: numstat `20 insert / 2 delete` — P1 runnable route + physics route branch plus P2 `metadata` pass-through and `await judgeRouterV2`.

Final D1 build-size sanity after the real runner import: `pnpm build` passed; `.next/standalone` remained 74M and no `mathjs` package path was traced into standalone output. The +10M rollback threshold did not trigger.

---

## Boundaries (P2 不做)

- ❌ rating-advisor / FSRS integration (P3 deliverable)
- ❌ closeout audit + status.md flip (P4)
- ❌ DB schema changes (no migrations; reference data goes via metadata, not new columns)
- ❌ `unit_dimension@2` (manifest version stays 1.0.0)
- ❌ Pre-fetch LLM (no batched / cached LLM calls — each unsupported parse calls LLM live; cost mgmt is N+1)
- ❌ Refactor of how question-contract resolves routes (P1 routing already shipped; P2 only adds metadata field + await)
- ❌ FSRS scheduler / mastery view changes
- ❌ Real R2 image upload pipeline for physics fixtures (kept text-only per P-1; image support is N+1)

### Now DOES change (per codex review round 2)

- ⚠️ `JudgeCapabilityRunner.run()` signature widened to allow Promise return (`src/core/capability/types.ts`)
- ⚠️ `judgeRouterV2` becomes async (`src/server/ai/judges/index.ts`)
- ⚠️ Callers of `judgeRouterV2` add `await` (`src/server/ai/judges/question-contract.ts`, maybe handful elsewhere)

These are framework deltas — explicitly out of P2's original strict "0 row outside subject" goal, but unavoidable for async LLM fallback. Each commit documents the line count + which acid-test-2 baseline file is touched.

---

## File structure

### Create
- `src/core/capability/judges/unit_dimension/accelerator.ts` — deterministic mathjs wrapper
- `src/core/capability/judges/unit_dimension/llm-fallback.ts` — mimo-v2.5 fallback (with `runTaskFn` injection for tests)
- `src/core/capability/judges/unit_dimension/score.ts` — 4 错误路径 score composition (pure fn)
- `src/core/capability/judges/unit_dimension/types.ts` — shared types + Zod schemas (UnitDimensionJudgeInput / LlmFallbackOutput / SignalKind enum)
- `src/core/capability/judges/unit_dimension/accelerator.test.ts` — mathjs accelerator unit tests
- `src/core/capability/judges/unit_dimension/llm-fallback.test.ts` — LLM mock tests
- `src/core/capability/judges/unit_dimension/score.test.ts` — pure score-composition coverage

### Modify
- `src/core/capability/judges/unit_dimension.ts` — replace skeleton `run()` with accelerator → fallback → score wiring; **runner becomes async** per D3 contract change; manifest `latency_class: 'async'`
- `src/core/capability/judges/unit_dimension.test.ts` — extend P1 skeleton test with real-runner coverage (await results)
- **`src/core/capability/types.ts`** — `JudgeCapabilityRunner.run` return type widened to `JudgeResultV2T | Promise<JudgeResultV2T>` (1 line) — **framework delta**
- **`src/server/ai/judges/index.ts`** — `judgeRouterV2` declared `async`, `await runner.run(...)`, return type `Promise<JudgeResultV2T>`; same for `judgeRouter` wrapper (3-5 lines) — **framework delta**
- `src/server/ai/judges/question-contract.ts` — D2a: add `metadata` to JudgeQuestionRow + forward in route resolution; also `await` for now-async judgeRouterV2 callers (count lines in Task 1)
- `src/subjects/physics/fixtures/e2e.smoke.test.ts` — add real-judging cases per fixture `expected_signals`
- `src/subjects/physics/fixtures/data.json` — fixture-label tweaks where strict signal assertion surfaces mislabels (per Task 6 guidance)
- `package.json` + `pnpm-lock.yaml` — `pnpm add mathjs` (D1 conditional)

### Not modified
- `src/core/capability/registry.ts` (acid test 2 hard rule — registry shape unchanged, only the runner contract widens)
- `src/subjects/*/fixtures/data.json` for wenyan/math (no domain content change)
- DB schema / migrations (no schema change)
- React UI (P3 / not P2)

---

## Tasks

### Task 0: Confirm 4 decision points D1-D4 + log spec deltas

**Files:**
- Read: P-1 audit doc + spec §7 + this plan's "Decision points" section
- Modify: this plan's "Spec deltas observed" section (fill in confirmed choices)

- [ ] **Step 1**: Read this plan's "Decision points" section in full.
- [ ] **Step 2**: For each of D1-D4, agent reviews recommended option and either accepts or proposes alternative. If alternative: document why in spec deltas + update downstream tasks accordingly.
- [ ] **Step 3**: For D1 specifically, run mathjs build-size sanity check before committing dep:
  ```bash
  pnpm add mathjs
  pnpm build 2>&1 | tail -20    # capture standalone build size
  # if Next standalone bundle increases > 10 MB → rollback per audit doc trigger
  # if increase acceptable → proceed; commit package.json + pnpm-lock.yaml
  ```
  If rollback triggered: `pnpm remove mathjs`, switch to D1.B (self-written), revise plan.
- [ ] **Step 4**: Update "Spec deltas observed" section with confirmed choices + rationale.
- [ ] **Step 5**: Commit (the package.json / lock changes from D1, the plan doc deltas update):
  ```bash
  git commit -m "chore(p2): confirm decision points + add mathjs dep (YUK-XX)"
  ```

---

### Task 1: UnitDimensionJudgeInput + metadata plumbing (D2a)

**Files:**
- Create: `src/core/capability/judges/unit_dimension/types.ts`
- Modify: `src/server/ai/judges/question-contract.ts`

- [ ] **Step 1**: Write `src/core/capability/judges/unit_dimension/types.ts`:

```ts
import { z } from 'zod';

export const SignalKind = z.enum([
  'numeric_close',
  'numeric_off',
  'unit_mismatch_same_dimension',
  'dimension_mismatch',
  'missing_unit',
  'unparseable',
]);
export type SignalKindT = z.infer<typeof SignalKind>;

export const UnitDimensionJudgeInput = z.object({
  student_answer: z.string().min(1),
  reference: z.object({
    value: z.number(),
    unit: z.string(),                    // SI form preferred, e.g. "m/s"
    tolerance: z.number().min(0).default(0.05),
  }),
  question_context_md: z.string().optional(),
});
export type UnitDimensionJudgeInputT = z.infer<typeof UnitDimensionJudgeInput>;

export const LlmFallbackOutput = z.object({
  student_value_si: z.number().nullable(),
  student_unit_si: z.string().nullable(),
  equivalent_to_reference: z.boolean(),
  dimension_mismatch_reason: z.string().optional(),
  parser_confidence: z.number().min(0).max(1),
});
export type LlmFallbackOutputT = z.infer<typeof LlmFallbackOutput>;
```

- [ ] **Step 2**: Modify `src/server/ai/judges/question-contract.ts` to add metadata pass-through.

Find `JudgeQuestionRow` type definition (search `export interface JudgeQuestionRow` or `export type JudgeQuestionRow`); add:

```ts
metadata?: Record<string, unknown> | null;
```

In `resolveQuestionJudgeRoute` / `judgeAnswer` (whichever assembles the runner input), forward `question.metadata` for unit_dimension route. Reference reading from metadata:

```ts
const refValue = (q.metadata as { reference_value?: number } | null)?.reference_value;
const refUnit = (q.metadata as { reference_unit?: string } | null)?.reference_unit;
const refTolerance = (q.metadata as { reference_tolerance?: number } | null)?.reference_tolerance ?? 0.05;
```

When routing to unit_dimension, if refValue / refUnit missing → return `unsupported` JudgeResultV2 (don't crash; physics fixtures all have these; runtime questions may not).

- [ ] **Step 3**: typecheck + run existing test:

```bash
pnpm typecheck
pnpm vitest run --config vitest.unit.config.ts src/server/ai/judges/question-contract.test.ts
```

- [ ] **Step 4**: Commit (combined with Task 2 to avoid intermediate broken state):
defer to Task 2 commit.

---

### Task 2: Deterministic accelerator (mathjs wrapper)

**Files:**
- Create: `src/core/capability/judges/unit_dimension/accelerator.ts`
- Create: `src/core/capability/judges/unit_dimension/accelerator.test.ts`

- [ ] **Step 1**: Write `accelerator.ts`:

```ts
import { create, all } from 'mathjs';
import type { SignalKindT } from './types';

const math = create(all);

export interface AcceleratorResult {
  parsed: boolean;                           // false = unparseable → trigger LLM fallback
  value_si: number | null;
  unit_si: string | null;
  dimension_match: boolean;
  unit_exact_match: boolean;                 // student unit == reference unit literal
  value_match: boolean;                      // within tolerance
  value_close: boolean;                      // 5%-50% off
  signal: SignalKindT | null;
}

export function runAccelerator(input: {
  student_answer: string;
  reference: { value: number; unit: string; tolerance: number };
}): AcceleratorResult {
  // 1. parse student_answer with math.unit(); handle exceptions → parsed=false
  // 2. normalize to reference's SI form via .to()
  // 3. compare value within tolerance; check dimension equivalence
  // 4. emit signal: full impl per §7.4 table
  // ... (~60 lines)
}
```

Implementation guide (per spec §7.4 table) — **revised 2026-05-23 per codex review #98 P1 finding line 284**:

Semantics clarified:
- `dimension_match`: true iff student's physical dimension equals reference's dimension family (velocity == velocity even if `km/h` vs `m/s`). Unit conversion irrelevant — same family is what counts.
- `unit_exact_match`: true iff student's literal unit string equals reference's literal unit string (`m/s` == `m/s`, but `km/h` != `m/s` even if SI-equivalent).
- `value_match`: true iff `|student_si − reference_si| / |reference_si| < tolerance` (default 0.05 = 5%). Only meaningful when `dimension_match=true`.
- `value_close`: true iff value_match=false AND error ∈ [tolerance, 10×tolerance) ≈ [5%, 50%).
- Signal derivation priority **(unit mismatch outranks numeric closeness when dim matches)**:

```
parsed=true & dimension_match=true & unit_exact_match=true:
  if value_match:                       signal = null         (caller composes correct, score=1.0)
  elif value_close:                     signal = numeric_close (5-50% off — partial 0.7)
  else:                                 signal = numeric_off   (>50% off — incorrect 0.3)

parsed=true & dimension_match=true & unit_exact_match=false:
  signal = unit_mismatch_same_dimension                       (partial 0.4, REGARDLESS of value match)
  # Educational concept: writing wrong unit IS the error to surface, even if numerically equivalent.
  # Per spec §7.4 example: '30 km/h' vs ref '30 m/s' is dimension_match=true (both velocity),
  # unit_exact_match=false, and result is unit_mismatch (not numeric_off after conversion).

parsed=true & dimension_match=false:
  signal = dimension_mismatch                                 (incorrect 0.0)

parsed=false & student answer purely numeric (no unit text):
  signal = missing_unit                                       (incorrect 0.0)

parsed=false (Chinese / compound / unrecognized form):
  signal = unparseable                                        (→ LLM fallback)
```

Tolerance semantics: `tolerance: 0.05` = 5% relative. `|student − reference| / |reference| < 0.05` ⇒ value_match. Within `[0.05, 0.50)` ⇒ value_close. ≥ 0.50 ⇒ neither.

- [ ] **Step 2**: Write `accelerator.test.ts` — pure-function tests:

```ts
import { describe, expect, it } from 'vitest';
import { runAccelerator } from './accelerator';

describe('unit_dimension accelerator', () => {
  const reference = { value: 30, unit: 'm/s', tolerance: 0.05 };

  it('exact match', () => {
    const r = runAccelerator({ student_answer: '30 m/s', reference });
    expect(r.parsed).toBe(true);
    expect(r.value_match).toBe(true);
    expect(r.dimension_match).toBe(true);
    expect(r.unit_exact_match).toBe(true);
    expect(r.signal).toBe(null);
  });

  it('value_match within tolerance (3% off → correct)', () => {
    // 29.1 vs 30 → 3% off → within 5% tolerance → value_match=true, signal=null
    const r = runAccelerator({ student_answer: '29.1 m/s', reference });
    expect(r.value_match).toBe(true);
    expect(r.signal).toBe(null);
  });

  it('numeric_close (16.7% off — in [5%, 50%) band)', () => {
    // 25 vs 30 → 16.7% off → outside tolerance, within close band
    const r = runAccelerator({ student_answer: '25 m/s', reference });
    expect(r.value_match).toBe(false);
    expect(r.value_close).toBe(true);
    expect(r.signal).toBe('numeric_close');
  });

  it('numeric_off (>50% off)', () => {
    // 50 vs 30 → 66.7% off → outside both bands
    const r = runAccelerator({ student_answer: '50 m/s', reference });
    expect(r.value_match).toBe(false);
    expect(r.value_close).toBe(false);
    expect(r.signal).toBe('numeric_off');
  });

  it('unit_mismatch_same_dimension (km/h vs m/s; signal outranks value match)', () => {
    // 108 km/h = 30 m/s after SI conversion. But student literally wrote km/h ≠ m/s.
    // Per revised semantics: dimension_match=true (both velocity), unit_exact_match=false
    // → signal = unit_mismatch_same_dimension, irrespective of post-conversion value.
    // Educational concept: surface the unit-conversion habit, not the (post-conv) numeric accuracy.
    const r = runAccelerator({ student_answer: '108 km/h', reference });
    expect(r.parsed).toBe(true);
    expect(r.dimension_match).toBe(true);
    expect(r.unit_exact_match).toBe(false);
    expect(r.signal).toBe('unit_mismatch_same_dimension');
  });

  it('dimension_mismatch (m vs m/s — different dimension family)', () => {
    const r = runAccelerator({ student_answer: '30 m', reference });
    expect(r.parsed).toBe(true);
    expect(r.dimension_match).toBe(false);
    expect(r.signal).toBe('dimension_mismatch');
  });

  it('missing_unit (numeric only, no unit text)', () => {
    const r = runAccelerator({ student_answer: '30', reference });
    expect(r.parsed).toBe(false);
    expect(r.signal).toBe('missing_unit');
  });

  it('unparseable (Chinese / non-numeric → LLM fallback)', () => {
    const r = runAccelerator({ student_answer: '忘了', reference });
    expect(r.parsed).toBe(false);
    expect(r.signal).toBe('unparseable');
  });
});
```

- [ ] **Step 3**: Run tests:

```bash
pnpm vitest run --config vitest.unit.config.ts src/core/capability/judges/unit_dimension/accelerator.test.ts
```

Expected: 8/8 PASS (was 7; added `value_match within tolerance` for the band-boundary case).

- [ ] **Step 4**: Defer commit to Task 3 / 4 (atomic with full runner).

---

### Task 3: LLM fallback (mimo-v2.5 + structured output + mock)

**Files:**
- Create: `src/core/capability/judges/unit_dimension/llm-fallback.ts`
- Create: `src/core/capability/judges/unit_dimension/llm-fallback.test.ts`

- [ ] **Step 1**: Write `llm-fallback.ts` (mirror steps-judge.ts pattern):

```ts
import type { LlmFallbackOutputT } from './types';
import { LlmFallbackOutput } from './types';

export type RunTaskFn = (
  kind: string,
  input: { text: string },
  ctx: unknown,
) => Promise<{ text: string }>;

export interface LlmFallbackParams {
  student_answer: string;
  reference: { value: number; unit: string };
  question_context_md?: string;
  runTaskFn?: RunTaskFn;
}

const PROMPT_TEMPLATE = `你是物理单位与量纲分析助手。给定学生答案 + 参考答案，输出 JSON：
\`\`\`
{
  "student_value_si": number | null,
  "student_unit_si": string | null,
  "equivalent_to_reference": boolean,
  "dimension_mismatch_reason": string | undefined,
  "parser_confidence": number (0-1)
}
\`\`\`
学生答案: "{{student_answer}}"
参考: {{reference_value}} {{reference_unit}}
{{?context: 题面: {{context}}}}
仅返回 JSON，无其它文字。`;

export async function runLlmFallback(
  params: LlmFallbackParams,
): Promise<LlmFallbackOutputT> {
  const runTask = params.runTaskFn ?? (await import('@/server/ai/runner')).runTask;
  const prompt = PROMPT_TEMPLATE
    .replace('{{student_answer}}', params.student_answer)
    .replace('{{reference_value}}', String(params.reference.value))
    .replace('{{reference_unit}}', params.reference.unit)
    .replace('{{?context: 题面: {{context}}}}',
      params.question_context_md ? `题面: ${params.question_context_md}` : '');

  const result = await runTask('UnitDimensionFallback', { text: prompt }, {});
  const parsed = LlmFallbackOutput.parse(JSON.parse(result.text));
  return parsed;
}
```

- [ ] **Step 2**: Write `llm-fallback.test.ts` with mocked `runTaskFn`:

```ts
import { describe, expect, it } from 'vitest';
import { runLlmFallback } from './llm-fallback';

describe('unit_dimension LLM fallback', () => {
  it('parses Chinese unit "三十米每秒" → 30 m/s', async () => {
    const mockTask = async () => ({
      text: JSON.stringify({
        student_value_si: 30,
        student_unit_si: 'm/s',
        equivalent_to_reference: true,
        parser_confidence: 0.95,
      }),
    });
    const r = await runLlmFallback({
      student_answer: '三十米每秒',
      reference: { value: 30, unit: 'm/s' },
      runTaskFn: mockTask,
    });
    expect(r.equivalent_to_reference).toBe(true);
    expect(r.student_value_si).toBe(30);
  });

  it('flags dimension mismatch', async () => {
    const mockTask = async () => ({
      text: JSON.stringify({
        student_value_si: 30,
        student_unit_si: 'm',
        equivalent_to_reference: false,
        dimension_mismatch_reason: 'length (m) vs velocity (m/s)',
        parser_confidence: 0.92,
      }),
    });
    const r = await runLlmFallback({
      student_answer: '30 米',
      reference: { value: 30, unit: 'm/s' },
      runTaskFn: mockTask,
    });
    expect(r.equivalent_to_reference).toBe(false);
    expect(r.dimension_mismatch_reason).toContain('length');
  });

  it('returns null fields when LLM cannot parse', async () => {
    const mockTask = async () => ({
      text: JSON.stringify({
        student_value_si: null,
        student_unit_si: null,
        equivalent_to_reference: false,
        parser_confidence: 0.0,
      }),
    });
    const r = await runLlmFallback({
      student_answer: '不知道',
      reference: { value: 30, unit: 'm/s' },
      runTaskFn: mockTask,
    });
    expect(r.student_value_si).toBeNull();
    expect(r.parser_confidence).toBe(0);
  });
});
```

- [ ] **Step 3**: Run:

```bash
pnpm vitest run --config vitest.unit.config.ts src/core/capability/judges/unit_dimension/llm-fallback.test.ts
```

Expected: 3/3 PASS.

- [ ] **Step 4**: Defer commit.

---

### Task 4: Score composition (4 错误路径 mapping pure fn)

**Files:**
- Create: `src/core/capability/judges/unit_dimension/score.ts`
- Create: `src/core/capability/judges/unit_dimension/score.test.ts`

- [ ] **Step 1**: Write `score.ts` (revised 2026-05-23 per codex review #98 round 2 — incorrect score literal 0 / unsupported confidence literal 0 / valueMatch in fallback / ref.value=0 div-by-zero):

```ts
import type { AcceleratorResult } from './accelerator';
import type { LlmFallbackOutputT, SignalKindT } from './types';
import type { JudgeResultV2T } from '@/core/schema/capability';

const CAPABILITY_REF = { id: 'unit_dimension', version: '1.0.0' };

/**
 * Schema-compliant outcome buckets (per src/core/schema/capability.ts:70-91):
 *   correct:     score ∈ [0.85, 1]
 *   partial:     score ∈ (0, 0.85)
 *   incorrect:   score literal 0
 *   unsupported: score null, confidence literal 0
 *
 * Spec §7.4 line 411 originally classified numeric_off (>50% off) as
 * 'incorrect' with score 0.3 — schema-illegal. Plan reclassifies
 * numeric_off and unit_mismatch_same_dimension as 'partial' (still
 * carrying signal in evidence_json for downstream FSRS / UX use).
 */

export function composeScore(input: {
  accelerator: AcceleratorResult;
  fallback?: LlmFallbackOutputT;
  /** Reference value/unit needed for fallback numeric/unit comparison when accelerator unparseable */
  reference?: { value: number; unit: string; tolerance: number };
  evidence: Record<string, unknown>;
}): JudgeResultV2T {
  const { accelerator, fallback, reference, evidence } = input;

  // ----- accelerator parsed successfully -----
  if (accelerator.parsed) {
    if (!accelerator.dimension_match) {
      return mkIncorrect('dimension_mismatch', 0.85, '量纲错', evidence);
    }
    // dim_match=true; unit_exact takes precedence over value
    if (!accelerator.unit_exact_match) {
      return mkPartial(
        0.4, 'unit_mismatch_same_dimension', 0.85,
        '单位写错（量纲对，单位非 SI 形式或同 family 异单位）', evidence,
      );
    }
    // dim_match + unit_exact: classify by value band
    if (accelerator.value_match) {
      return mkCorrect(1.0, 0.95, '单位 + 数值全对', evidence);
    }
    if (accelerator.value_close) {
      return mkPartial(0.7, 'numeric_close', 0.9, '单位对，数值偏差 5-50%', evidence);
    }
    // numeric_off — reclassified as 'partial' per schema constraint; signal
    // preserved in evidence_json. Pedagogy: >50% wrong still keeps partial
    // credit if unit was right — better than schema-illegal incorrect/0.3.
    return mkPartial(0.3, 'numeric_off', 0.85, '单位对，数值偏差 >50%', evidence);
  }

  // ----- accelerator NOT parsed -----
  if (accelerator.signal === 'missing_unit') {
    return mkIncorrect('missing_unit', 0.8, '只有数值，缺单位', evidence);
  }

  // unparseable → fallback should have been called
  if (!fallback) {
    return unsupported('accelerator unparseable, fallback not invoked', evidence);
  }
  if (fallback.equivalent_to_reference) {
    return mkCorrect(
      1.0, fallback.parser_confidence,
      'LLM fallback 判等价 (含中文 / 复合形式)', { ...evidence, fallback },
    );
  }
  // fallback parsed but not equivalent: dim mismatch reason wins; else use SI fields
  if (fallback.dimension_mismatch_reason) {
    return mkIncorrect(
      'dimension_mismatch', fallback.parser_confidence,
      `LLM fallback 判量纲不一致: ${fallback.dimension_mismatch_reason}`,
      { ...evidence, fallback },
    );
  }
  if (fallback.student_value_si !== null && fallback.student_unit_si !== null && reference) {
    const tol = reference.tolerance;
    // Handle ref.value === 0 explicitly: relative error is undefined; use
    // absolute residual against tolerance (caller is responsible for
    // ensuring tolerance is sensible for the unit's scale when ref is 0).
    const diff = Math.abs(fallback.student_value_si - reference.value);
    const rel = reference.value === 0 ? diff : diff / Math.abs(reference.value);
    const valueMatch = rel < tol;
    const valueClose = !valueMatch && rel < tol * 10;
    const unitExactMatch = fallback.student_unit_si === reference.unit;

    if (!unitExactMatch) {
      return mkPartial(
        0.4, 'unit_mismatch_same_dimension', fallback.parser_confidence,
        `LLM fallback 解析单位 ${fallback.student_unit_si} ≠ ref ${reference.unit}`,
        { ...evidence, fallback },
      );
    }
    // valueMatch path — explicit per codex review #98 round 2 line 625:
    // do not skip to numeric_off when value is actually within tolerance.
    if (valueMatch) {
      return mkCorrect(
        1.0, fallback.parser_confidence,
        'LLM fallback 解析后单位对、数值在容差内', { ...evidence, fallback },
      );
    }
    if (valueClose) {
      return mkPartial(
        0.7, 'numeric_close', fallback.parser_confidence,
        'LLM fallback 解析后数值偏差 5-50%', { ...evidence, fallback },
      );
    }
    return mkPartial(
      0.3, 'numeric_off', fallback.parser_confidence,
      'LLM fallback 解析后数值偏差 >50%', { ...evidence, fallback },
    );
  }
  // fallback couldn't parse either
  return unsupported('accelerator + LLM fallback 均不能解析', { ...evidence, fallback });
}

// ---- schema-compliant builders (one per discriminated-union arm) ----

function mkCorrect(
  score: number, confidence: number, feedback_md: string, evidence: Record<string, unknown>,
): JudgeResultV2T {
  return {
    coarse_outcome: 'correct',
    score,            // must be ≥ 0.85
    score_meaning: 'unit_dimension_v1',
    confidence,
    capability_ref: CAPABILITY_REF,
    feedback_md,
    evidence_json: { ...evidence, signal: null },
  };
}

function mkPartial(
  score: number, signal: SignalKindT, confidence: number, feedback_md: string, evidence: Record<string, unknown>,
): JudgeResultV2T {
  return {
    coarse_outcome: 'partial',
    score,            // must be > 0 and < 0.85
    score_meaning: 'unit_dimension_v1',
    confidence,
    capability_ref: CAPABILITY_REF,
    feedback_md,
    evidence_json: { ...evidence, signal },
  };
}

function mkIncorrect(
  signal: SignalKindT, confidence: number, feedback_md: string, evidence: Record<string, unknown>,
): JudgeResultV2T {
  return {
    coarse_outcome: 'incorrect',
    score: 0,         // schema requires literal 0
    score_meaning: 'unit_dimension_v1',
    confidence,
    capability_ref: CAPABILITY_REF,
    feedback_md,
    evidence_json: { ...evidence, signal },
  };
}

function unsupported(reason: string, evidence: Record<string, unknown>): JudgeResultV2T {
  return {
    coarse_outcome: 'unsupported',
    score: null,
    score_meaning: 'unit_dimension_v1',
    confidence: 0,    // schema requires literal 0
    capability_ref: CAPABILITY_REF,
    feedback_md: reason,
    evidence_json: evidence,
  };
}
```

- [ ] **Step 2**: Write `score.test.ts` covering all branches (revised 2026-05-23 per codex review #98 — added fallback non-equivalent細分 cases):

```ts
import { describe, expect, it } from 'vitest';
import { composeScore } from './score';

const ref = { value: 30, unit: 'm/s', tolerance: 0.05 };

describe('unit_dimension score composition', () => {
  // ---- accelerator parsed paths ----
  it('correct: dim_match + unit_exact + value_match → 1.0', () => {
    const r = composeScore({
      accelerator: {
        value_si: 30, unit_si: 'm/s',
        parsed: true, dimension_match: true, unit_exact_match: true,
        value_match: true, value_close: false, signal: null,
      },
      reference: ref,
      evidence: {},
    });
    expect(r.score).toBe(1.0);
    expect(r.coarse_outcome).toBe('correct');
  });

  it('numeric_close: dim_match + unit_exact + value_close → 0.7 partial', () => {
    const r = composeScore({
      accelerator: {
        value_si: 25, unit_si: 'm/s',
        parsed: true, dimension_match: true, unit_exact_match: true,
        value_match: false, value_close: true, signal: 'numeric_close',
      },
      reference: ref, evidence: {},
    });
    expect(r.score).toBe(0.7);
    expect(r.coarse_outcome).toBe('partial');
    expect((r.evidence_json as { signal?: string }).signal).toBe('numeric_close');
  });

  it('numeric_off: dim_match + unit_exact + neither match nor close → 0.3 partial (reclassified per schema)', () => {
    // Per codex review #98 round 2: JudgeResultV2 schema requires incorrect
    // → score literal 0. 0.3 belongs in partial (signal still in evidence).
    const r = composeScore({
      accelerator: {
        value_si: 50, unit_si: 'm/s',
        parsed: true, dimension_match: true, unit_exact_match: true,
        value_match: false, value_close: false, signal: 'numeric_off',
      },
      reference: ref, evidence: {},
    });
    expect(r.score).toBe(0.3);
    expect(r.coarse_outcome).toBe('partial');
    expect((r.evidence_json as { signal?: string }).signal).toBe('numeric_off');
  });

  it('unit_mismatch_same_dimension: dim_match=true + unit_exact=false → 0.4 partial (signal outranks value)', () => {
    // km/h vs m/s: same dimension family, but literal unit differs.
    // Even if SI-converted value matches, signal is unit_mismatch_same_dimension.
    const r = composeScore({
      accelerator: {
        value_si: 30, unit_si: 'm/s',  // post-conv value happens to match
        parsed: true, dimension_match: true, unit_exact_match: false,
        value_match: true, value_close: false, signal: 'unit_mismatch_same_dimension',
      },
      reference: ref, evidence: {},
    });
    expect(r.score).toBe(0.4);
    expect(r.coarse_outcome).toBe('partial');
    expect((r.evidence_json as { signal?: string }).signal).toBe('unit_mismatch_same_dimension');
  });

  it('dimension_mismatch: dim_match=false → score literal 0, incorrect', () => {
    const r = composeScore({
      accelerator: {
        value_si: 30, unit_si: 'm',
        parsed: true, dimension_match: false, unit_exact_match: false,
        value_match: false, value_close: false, signal: 'dimension_mismatch',
      },
      reference: ref, evidence: {},
    });
    expect(r.score).toBe(0);
    expect(r.coarse_outcome).toBe('incorrect');
    expect((r.evidence_json as { signal?: string }).signal).toBe('dimension_mismatch');
  });

  it('missing_unit: parsed=false, signal=missing_unit → score literal 0, incorrect', () => {
    const r = composeScore({
      accelerator: {
        value_si: 30, unit_si: null,
        parsed: false, dimension_match: false, unit_exact_match: false,
        value_match: false, value_close: false, signal: 'missing_unit',
      },
      reference: ref, evidence: {},
    });
    expect(r.score).toBe(0);
    expect(r.coarse_outcome).toBe('incorrect');
    expect((r.evidence_json as { signal?: string }).signal).toBe('missing_unit');
  });

  // ---- fallback paths ----
  it('unparseable + fallback equivalent → 1.0 correct', () => {
    const r = composeScore({
      accelerator: {
        value_si: null, unit_si: null,
        parsed: false, dimension_match: false, unit_exact_match: false,
        value_match: false, value_close: false, signal: 'unparseable',
      },
      fallback: {
        student_value_si: 30, student_unit_si: 'm/s',
        equivalent_to_reference: true, parser_confidence: 0.92,
      },
      reference: ref, evidence: {},
    });
    expect(r.score).toBe(1.0);
    expect(r.coarse_outcome).toBe('correct');
  });

  it('fallback non-equiv + dim_mismatch_reason → dimension_mismatch, score literal 0', () => {
    const r = composeScore({
      accelerator: {
        value_si: null, unit_si: null,
        parsed: false, dimension_match: false, unit_exact_match: false,
        value_match: false, value_close: false, signal: 'unparseable',
      },
      fallback: {
        student_value_si: 30, student_unit_si: 'm',
        equivalent_to_reference: false,
        dimension_mismatch_reason: 'length (m) vs velocity (m/s)',
        parser_confidence: 0.88,
      },
      reference: ref, evidence: {},
    });
    expect(r.score).toBe(0);
    expect(r.coarse_outcome).toBe('incorrect');
    expect((r.evidence_json as { signal?: string }).signal).toBe('dimension_mismatch');
  });

  it('fallback unit-matches + value within tolerance → 1.0 correct (per codex review round 2 line 625)', () => {
    // Chinese fallback resolves to 29.5 m/s — same unit, 1.7% off (within 5% tol).
    // Previous version skipped this case and went straight to numeric_off.
    const r = composeScore({
      accelerator: {
        value_si: null, unit_si: null,
        parsed: false, dimension_match: false, unit_exact_match: false,
        value_match: false, value_close: false, signal: 'unparseable',
      },
      fallback: {
        student_value_si: 29.5, student_unit_si: 'm/s',
        equivalent_to_reference: false, parser_confidence: 0.9,
      },
      reference: ref, evidence: {},
    });
    expect(r.coarse_outcome).toBe('correct');
    expect(r.score).toBeGreaterThanOrEqual(0.85);
  });

  it('fallback with reference.value === 0 — absolute residual (per codex review round 2 line 607)', () => {
    // Baseline-temperature-style problem: ref=0 K shift. student=0.01 ≤ tol=0.05 (absolute) → correct.
    const refZero = { value: 0, unit: 'K', tolerance: 0.05 };
    const r = composeScore({
      accelerator: {
        value_si: null, unit_si: null,
        parsed: false, dimension_match: false, unit_exact_match: false,
        value_match: false, value_close: false, signal: 'unparseable',
      },
      fallback: {
        student_value_si: 0.01, student_unit_si: 'K',
        equivalent_to_reference: false, parser_confidence: 0.9,
      },
      reference: refZero, evidence: {},
    });
    expect(r.coarse_outcome).toBe('correct');
    expect(r.score).toBeGreaterThanOrEqual(0.85);
  });

  it('fallback non-equiv + no dim_reason + unit differs → unit_mismatch 0.4 (per codex P1 finding)', () => {
    // Chinese fallback parses to '50 km/h' (same dim as m/s but different unit literal).
    const r = composeScore({
      accelerator: {
        value_si: null, unit_si: null,
        parsed: false, dimension_match: false, unit_exact_match: false,
        value_match: false, value_close: false, signal: 'unparseable',
      },
      fallback: {
        student_value_si: 50, student_unit_si: 'km/h',
        equivalent_to_reference: false, parser_confidence: 0.85,
      },
      reference: ref, evidence: {},
    });
    expect(r.score).toBe(0.4);
    expect((r.evidence_json as { signal?: string }).signal).toBe('unit_mismatch_same_dimension');
  });

  it('fallback non-equiv + unit matches + value 16% off → numeric_close 0.7 (per codex P1 finding)', () => {
    // Chinese fallback resolves to '25 m/s' — same unit as ref, 16% off → numeric_close
    const r = composeScore({
      accelerator: {
        value_si: null, unit_si: null,
        parsed: false, dimension_match: false, unit_exact_match: false,
        value_match: false, value_close: false, signal: 'unparseable',
      },
      fallback: {
        student_value_si: 25, student_unit_si: 'm/s',
        equivalent_to_reference: false, parser_confidence: 0.85,
      },
      reference: ref, evidence: {},
    });
    expect(r.score).toBe(0.7);
    expect((r.evidence_json as { signal?: string }).signal).toBe('numeric_close');
  });

  it('fallback non-equiv + unit matches + value 67% off → numeric_off 0.3 partial (reclassified)', () => {
    const r = composeScore({
      accelerator: {
        value_si: null, unit_si: null,
        parsed: false, dimension_match: false, unit_exact_match: false,
        value_match: false, value_close: false, signal: 'unparseable',
      },
      fallback: {
        student_value_si: 50, student_unit_si: 'm/s',
        equivalent_to_reference: false, parser_confidence: 0.82,
      },
      reference: ref, evidence: {},
    });
    expect(r.score).toBe(0.3);
    expect(r.coarse_outcome).toBe('partial');
    expect((r.evidence_json as { signal?: string }).signal).toBe('numeric_off');
  });

  it('unparseable + fallback also fails → unsupported with confidence literal 0 (per codex P1 finding line 657)', () => {
    const r = composeScore({
      accelerator: {
        value_si: null, unit_si: null,
        parsed: false, dimension_match: false, unit_exact_match: false,
        value_match: false, value_close: false, signal: 'unparseable',
      },
      fallback: {
        student_value_si: null, student_unit_si: null,
        equivalent_to_reference: false, parser_confidence: 0,
      },
      reference: ref, evidence: {},
    });
    expect(r.coarse_outcome).toBe('unsupported');
    expect(r.score).toBeNull();
    expect(r.confidence).toBe(0);  // schema literal
  });

  it('unparseable + no fallback called → unsupported with confidence literal 0', () => {
    const r = composeScore({
      accelerator: {
        value_si: null, unit_si: null,
        parsed: false, dimension_match: false, unit_exact_match: false,
        value_match: false, value_close: false, signal: 'unparseable',
      },
      reference: ref, evidence: {},
    });
    expect(r.coarse_outcome).toBe('unsupported');
    expect(r.confidence).toBe(0);
  });
});
```

- [ ] **Step 3**: Run:

```bash
pnpm vitest run --config vitest.unit.config.ts src/core/capability/judges/unit_dimension/score.test.ts
```

Expected: 15/15 PASS — original 13 + 2 new tests from round 2 review (fallback valueMatch hit + ref.value=0 absolute residual).

- [ ] **Step 4**: Defer commit.

- [ ] **Step 4**: Defer commit.

---

### Task 5: Wire accelerator + fallback + score into unit_dimension.ts main runner

**Files:**
- Modify: `src/core/capability/judges/unit_dimension.ts`

- [ ] **Step 1**: First, widen the framework runner contract to allow async. Edit `src/core/capability/types.ts`:

```ts
// Existing:
//   run(input: JudgeRunInput): JudgeResultV2T;
// New (1-line widening; backward-compatible — sync runners still satisfy the union):
import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';

export interface JudgeRunInput {
  activity_ref?: ActivityRefT;
  question: Record<string, unknown>;
  answer: { content: string };
}

export interface JudgeCapabilityRunner {
  readonly manifest: CapabilityManifestT;
  run(input: JudgeRunInput): JudgeResultV2T | Promise<JudgeResultV2T>;
}
```

Then edit `src/server/ai/judges/index.ts`:

```ts
// Existing judgeRouterV2 was sync; widen to async:
export async function judgeRouterV2(input: JudgeRouterInput): Promise<JudgeResultV2T> {
  const registry = getDefaultRegistry();
  const runner = registry.resolveJudge(input.kind);
  if (!runner) {
    throw new Error(
      `Judge kind '${input.kind}' not found in capability registry (not implemented)`,
    );
  }
  // Result may be sync or Promise — await covers both.
  return await runner.run({ question: input.question, answer: input.answer });
}

// judgeRouter wrapper also becomes async to await judgeRouterV2:
export async function judgeRouter(input: JudgeRouterInput): Promise<JudgeResult> {
  return downgradeToV1(await judgeRouterV2(input));
}
```

Then in `src/server/ai/judges/question-contract.ts`, every call site of `judgeRouterV2` / `judgeRouter` adds `await` and the surrounding function becomes async (typecheck will surface remaining sites; should be 1-3 call sites).

- [ ] **Step 2**: Replace P1 skeleton `run()` with real runner:

```ts
import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';
import type { JudgeCapabilityRunner, JudgeRunInput } from '../types';
import { runAccelerator } from './unit_dimension/accelerator';
import { runLlmFallback, type RunTaskFn } from './unit_dimension/llm-fallback';
import { composeScore } from './unit_dimension/score';

const VERSION = '1.0.0';
const manifest: CapabilityManifestT = {
  id: 'unit_dimension',
  kind: 'judge',
  version: VERSION,
  input_schema: 'UnitDimensionJudgeInput',
  output_schema: 'JudgeResultV2 (score_meaning=unit_dimension_v1)',
  cost_class: 'local',                    // primary path; fallback is occasional LLM
  latency_class: 'async',                 // D3 confirmed: LLM fallback makes it async
  stability: 'experimental',
};

interface RunDeps {
  runTaskFn?: RunTaskFn;
}

// IMPORTANT: input.answer.content (NOT answer_md) per JudgeRunInput contract
// (src/core/capability/types.ts:7). question may have metadata as a known
// optional jsonb — narrow to typed access.
async function run(input: JudgeRunInput, deps: RunDeps = {}): Promise<JudgeResultV2T> {
  const student = input.answer.content;
  const meta = (input.question as { metadata?: unknown }).metadata as
    | { reference_value?: number; reference_unit?: string; reference_tolerance?: number }
    | undefined;
  const refValue = meta?.reference_value;
  const refUnit = meta?.reference_unit;
  const refTolerance = meta?.reference_tolerance ?? 0.05;

  if (typeof refValue !== 'number' || typeof refUnit !== 'string') {
    return unsupported('question.metadata 缺 reference_value/reference_unit', { question: input.question });
  }

  const accelerator = runAccelerator({
    student_answer: student,
    reference: { value: refValue, unit: refUnit, tolerance: refTolerance },
  });

  let fallback;
  if (!accelerator.parsed && accelerator.signal === 'unparseable') {
    try {
      fallback = await runLlmFallback({
        student_answer: student,
        reference: { value: refValue, unit: refUnit },
        question_context_md: typeof (input.question as { prompt_md?: unknown }).prompt_md === 'string'
          ? (input.question as { prompt_md: string }).prompt_md
          : undefined,
        runTaskFn: deps.runTaskFn,
      });
    } catch (err) {
      // LLM error → fall through to unsupported via composeScore (fallback undefined)
    }
  }

  return composeScore({
    accelerator,
    fallback,
    reference: { value: refValue, unit: refUnit, tolerance: refTolerance },
    evidence: { input_summary: { student, refValue, refUnit } },
  });
}

function unsupported(reason: string, evidence: Record<string, unknown>): JudgeResultV2T {
  return {
    score: null,
    score_meaning: 'unit_dimension_v1',
    coarse_outcome: 'unsupported',
    confidence: 0,
    capability_ref: { id: manifest.id, version: VERSION },
    feedback_md: `unit_dimension@1: ${reason}`,
    evidence_json: evidence,
  };
}

export const unitDimensionV1Capability: JudgeCapabilityRunner = { manifest, run };
```

- [ ] **Step 3**: Update existing `unit_dimension.test.ts` (P1 skeleton tests) to cover real runner:

```ts
it('exact correct via accelerator', async () => {
  const result = await unitDimensionV1Capability.run({
    answer: { content: '30 m/s' },                         // not answer_md
    question: { metadata: { reference_value: 30, reference_unit: 'm/s' } },
  });
  expect(result.score).toBe(1.0);
  expect(result.coarse_outcome).toBe('correct');
});

it('LLM fallback called when accelerator unparseable', async () => {
  let llmCalled = false;
  // deps param NOT in standard JudgeCapabilityRunner.run interface — use
  // module-level injection or test-only direct call. Match the pattern
  // used in steps-judge.ts (which exposes a runStepsJudge function distinct
  // from the registered capability runner).
  const result = await unitDimensionV1Capability.run({
    answer: { content: '三十米每秒' },
    question: { metadata: { reference_value: 30, reference_unit: 'm/s' } },
  });
  // Without explicit injection, fallback may invoke real LLM in non-test env
  // OR resolve to unsupported when runtask not available. Prefer testing
  // accelerator + composeScore + injectable fallback separately (Tasks 2-4
  // already cover that); reserve this for one round-trip smoke.
  expect(['unsupported', 'correct']).toContain(result.coarse_outcome);
});
```

**Note on injection**: `JudgeCapabilityRunner.run(input)` interface has no `deps` second arg. Pattern options:
- (a) Add module-level `setRunTaskFn(fn)` getter/setter for test injection (matches `defaultImageFetch` swap in steps-judge.ts)
- (b) Test direct `runLlmFallback` (Task 3) rather than through `unitDimensionV1Capability.run`; trust composeScore tests (Task 4) for wiring
- (c) Internally read `runTask` from `@/server/ai/runner` at call time (already what plan code does); tests mock the module

Recommended: (c) — keep registered runner signature pure, test fallback via Task 3 mocked tests, accept that the round-trip test through `unitDimensionV1Capability.run` either uses real LLM (in env) or returns unsupported (test env without LLM stub).

- [ ] **Step 4**: Run + typecheck:

```bash
pnpm typecheck
pnpm vitest run --config vitest.unit.config.ts src/core/capability/judges/unit_dimension.test.ts
```

- [ ] **Step 5**: Commit Tasks 1-5 together:

```bash
git add src/core/capability/judges/unit_dimension* src/server/ai/judges/question-contract.ts
git commit -F /tmp/p2-commit-msg-impl.txt    # message describes accelerator + fallback + score wiring + JudgeQuestionRow metadata
```

(Use `-F file` per session pattern to avoid commit-msg containing trigger keywords.)

---

### Task 6: Extend physics e2e smoke with real judging per signal

**Files:**
- Modify: `src/subjects/physics/fixtures/e2e.smoke.test.ts`

P-1 fixtures (`data.json`) already declare `expected_signals` arrays — each fixture lists `{ case, student_answer, expected_signal }` triples. Use these as test inputs.

- [ ] **Step 1**: Add real-judging cases. Per fixture's `expected_signals`, assert that judging student_answer produces the expected signal. **Always strict-assert signal match** (per codex review #98 P2 line 844: weakening assertion masks signal-mapping regressions). If a fixture's `expected_signal` doesn't reflect new logic (e.g. '全对' cases mislabeled as `numeric_close`), **fix the fixture data**, not the test. Same applies to the `reference_value == null` filter (per codex review #98 P2 line 826: use explicit nullish check, not falsy — physics 中合法的 `0` 参考值会被 `!fixture.reference_value` 误过滤):

```ts
import { loadPhysicsFixtures } from './index';
import { unitDimensionV1Capability } from '@/core/capability/judges/unit_dimension';

describe('physics fixture real judging — expected_signals validation', () => {
  for (const fixture of loadPhysicsFixtures()) {
    // Use explicit nullish check, NOT `!fixture.reference_value`. A fixture
    // with reference_value=0 is legitimate (e.g. baseline-temperature problem)
    // and should still get unit_dimension judging.
    if (fixture.reference_value == null || fixture.reference_unit == null) continue;

    for (const tc of fixture.expected_signals) {
      it(`${fixture.ref} :: ${tc.case} → ${tc.expected_signal}`, async () => {
        // JudgeRunInput per src/core/capability/types.ts: answer.content (not answer_md).
        const result = await unitDimensionV1Capability.run({
          answer: { content: tc.student_answer },
          question: {
            metadata: {
              reference_value: fixture.reference_value,
              reference_unit: fixture.reference_unit,
              reference_tolerance: fixture.tolerance,
            },
          },
        });
        const signal = (result.evidence_json as { signal?: string }).signal ?? null;

        // Map the fixture's expected_signal to either signal-strict or
        // coarse_outcome assertion. Spec rule: numeric_close = partial 0.7;
        // null signal = correct 1.0. If fixture says numeric_close but our
        // accelerator scored 1.0, the FIXTURE is wrong (case='全对' shouldn't
        // be labeled numeric_close). Fix the data.json, not the test.
        expect(signal).toBe(tc.expected_signal);
      });
    }
  }
});
```

This is data-driven: each fixture's expected_signals → one test case each. With P-1's 10 fixtures × ~3-4 signals each, this generates ~30 test cases automatically.

**Expected fixture-data churn**: with strict signal assertion (post codex review #98 P2 fix), some P-1 fixture entries may surface as mislabeled. For example, `physics-unit-001` has `{case: "数值近", student_answer: "8.30 m/s", expected_signal: "numeric_close"}` but with `tolerance: 0.05`, 8.30 vs 8.33 is 0.36% off → within tolerance → actually `value_match=true` (signal=null, correct). Options when a fixture row fails:

| Fix | Apply when |
|---|---|
| Update fixture `case` label + `expected_signal` to match what current tolerance + answer actually produces | The student_answer is the canonical exemplar; tolerance is right |
| Tighten the fixture's `tolerance` so the answer falls outside `value_match` band | The "近" intent is real but tolerance was too loose |
| Change `student_answer` to be further off (e.g. `7.0 m/s` for ~16% off) | The "近" intent is real, tolerance is right, answer was too close |

Pick per fixture's pedagogical intent. **Do not weaken the test** to accept ambiguity (per codex review #98 P2 line 844). Capture each fixture tweak in the commit.

- [ ] **Step 2**: Run via DB config:

```bash
pnpm test:db src/subjects/physics/fixtures/e2e.smoke.test.ts
```

Expected: existing 5 P0 tests + ~25-30 new real-judging tests all PASS (after fixture relabels). Each failure indicates either (a) fixture mislabel — fix data.json; (b) accelerator edge case — extend unit tests + accelerator.

- [ ] **Step 3**: Commit (fixture changes + test additions atomic):

```bash
git add src/subjects/physics/fixtures/e2e.smoke.test.ts src/subjects/physics/fixtures/data.json
git commit -m "test(physics): e2e real judging per expected_signals + fixture relabels (P2 YUK-XX)"
```

---

### Task 7: Regression + acid test 2 verify

**Files:** read-only

- [ ] **Step 1**: Full regression:

```bash
pnpm typecheck
pnpm test:unit
pnpm test:db src/subjects/physics/fixtures/e2e.smoke.test.ts src/subjects/math/fixtures/e2e.smoke.test.ts
pnpm audit:schema
pnpm audit:partition
pnpm exec biome check --no-errors-on-unmatched src/core/capability/judges/unit_dimension src/server/ai/judges/question-contract.ts
```

- [ ] **Step 2**: Foundation A acid test 2 verify (revised — see Spec deltas section):

```bash
# Hard zero: registry shape unchanged
git diff 9191c160a20d8e5afabf11503c6851f510bd2182 -- src/core/capability/registry.ts
# Expect EMPTY

# Soft / documented deltas: types.ts + index.ts + question-contract.ts
# all widened to support async runner contract.
git diff 9191c160a20d8e5afabf11503c6851f510bd2182 -- src/core/capability/types.ts
# Expect: 1 line — return type widening JudgeResultV2T → JudgeResultV2T | Promise<JudgeResultV2T>

git diff 9191c160a20d8e5afabf11503c6851f510bd2182 -- src/server/ai/judges/index.ts
# Expect: judgeRouterV2 + judgeRouter become async + await runner.run(...); 3-5 lines

git diff 9191c160a20d8e5afabf11503c6851f510bd2182 -- src/server/ai/judges/question-contract.ts
# Expect: P1 metadata field + P2 await + (if any) further async propagation; record exact line count
```

Each delta must match what's listed in plan's "Spec deltas observed" section. Count lines per file; if any framework file exceeds expected delta, **stop and update plan + Linear spec deltas** before continuing.

If a delta is **unexpected** (file not in allowed list) → phase rollback per spec §3 P2 exit criterion 4. Document delta + decide:
- Acceptable widening → add to spec deltas, continue
- Unacceptable → revert and choose alternative path (drop LLM fallback / restructure)

---

### Task 8: PR + merge

- [ ] **Step 1**: Push:

```bash
git push -u origin yuk-XX-unit-dimension-impl
```

- [ ] **Step 2**: Open PR with body file (avoid trigger keywords):

```bash
gh pr create --title "YUK-XX feat: foundation closeout P2 — unit_dimension@1 real impl" --body-file /tmp/p2-pr-body.md
```

PR body should include:
- 4 decision points (D1-D4) with confirmed choices
- Spec deltas observed
- Boundaries verified
- Test plan results (typecheck / unit / db / regression / acid test 2)
- Next phase pointer (P3)

- [ ] **Step 3**: Wait CI + merge:

```bash
gh pr merge XX --squash --delete-branch
git checkout main && git pull --ff-only
```

Integration auto-transitions YUK-XX → Done (per linear-workflow.md confirmed pattern from P1).

---

## Phase Exit Criterion 验收 (spec §3 P2 line 152-156)

- [ ] **10 道 physics fixture 4 类错误路径各 ≥ 1 命中** (Task 6 data-driven tests)
- [ ] **LLM fallback 样本路径有 mock 测试覆盖** (Task 3 + Task 5)
- [ ] **wenyan + math regression 通过** (Task 7)
- [ ] **框架代码 LOC change = 0 outside unit_dimension/ + physics/** — except documented question-contract.ts delta (Task 7 acid test 2)

下一 phase (P3) 启动条件：本 PR merge + acid test 2 通过 + N+1 follow-ups (per spec §3 P4 line 207-210: LLM fallback cost monitoring) 入 closeout doc。
