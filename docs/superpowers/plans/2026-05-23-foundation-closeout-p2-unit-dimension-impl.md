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

- D1 confirmed: <fill at P2/0>
- D2 confirmed: <fill at P2/0>; `JudgeQuestionRow` += `metadata?: unknown` field — this is framework delta per Foundation A acid test 2 strict reading. Pre-existing 1-row delta in question-contract.ts from P1 already established precedent.
- D3 confirmed: <fill at P2/0>; spec §7.1 revision: `latency: 'sync'` → `'async'`.
- D4 confirmed: mimo-v2.5 via Claude Agent SDK.

---

## Boundaries (P2 不做)

- ❌ rating-advisor / FSRS integration (P3 deliverable)
- ❌ closeout audit + status.md flip (P4)
- ❌ schema changes (no migrations; reference data goes via metadata, not new columns)
- ❌ `unit_dimension@2` (manifest version stays 1.0.0)
- ❌ Pre-fetch LLM (no batched / cached LLM calls — each unsupported parse calls LLM live; cost mgmt is N+1)
- ❌ Refactor `JudgeRunInput` shape beyond passing reference data + metadata
- ❌ Refactor of how question-contract resolves routes (P1 routing already shipped)
- ❌ FSRS scheduler / mastery view changes
- ❌ Real R2 image upload pipeline for physics fixtures (kept text-only per P-1; image support is N+1)

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
- `src/core/capability/judges/unit_dimension.ts` — replace skeleton `run()` with accelerator → fallback → score wiring; update manifest per D3
- `src/core/capability/judges/unit_dimension.test.ts` — extend P1 skeleton test with real-runner coverage
- `src/core/schema/capability.ts` — D3 only if changes needed to LatencyClass (probably no change; existing 'async' value exists)
- `src/server/ai/judges/question-contract.ts` — D2a: add `metadata` to JudgeQuestionRow + forward in route resolution
- `src/subjects/physics/fixtures/e2e.smoke.test.ts` — add real-judging cases for each of the 5 expected_signals classes (numeric_close / numeric_off / unit_mismatch_same_dimension / dimension_mismatch / missing_unit), using physics fixtures already seeded in P-1
- `package.json` + `pnpm-lock.yaml` — `pnpm add mathjs` (D1 conditional)

### Not modified
- `src/core/capability/registry.ts` (acid test 2 hard rule)
- `src/server/ai/judges/index.ts` body (acid test 2)
- `src/subjects/*/fixtures/data.json` (P-1 already seeded; reuse)
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

- [ ] **Step 1**: Write `score.ts` (revised 2026-05-23 per codex review #98 P1 line 539 + P2 line 522 — unit_mismatch lives under dim_match=true; fallback non-equivalent細分):

```ts
import type { AcceleratorResult } from './accelerator';
import type { LlmFallbackOutputT, SignalKindT } from './types';
import type { JudgeResultV2T } from '@/core/schema/capability';

const CAPABILITY_REF = { id: 'unit_dimension', version: '1.0.0' };

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
      return mk(0.0, 'incorrect', 'dimension_mismatch', 0.85, '量纲错', evidence);
    }
    // dim_match=true; unit_exact takes precedence over value
    if (!accelerator.unit_exact_match) {
      return mk(
        0.4, 'partial', 'unit_mismatch_same_dimension', 0.85,
        '单位写错（量纲对，单位非 SI 形式或同 family 异单位）', evidence,
      );
    }
    // dim_match + unit_exact: classify by value band
    if (accelerator.value_match) {
      return mk(1.0, 'correct', null, 0.95, '单位 + 数值全对', evidence);
    }
    if (accelerator.value_close) {
      return mk(
        0.7, 'partial', 'numeric_close', 0.9,
        '单位对，数值偏差 5-50%', evidence,
      );
    }
    return mk(
      0.3, 'incorrect', 'numeric_off', 0.85,
      '单位对，数值偏差 >50%', evidence,
    );
  }

  // ----- accelerator NOT parsed -----
  if (accelerator.signal === 'missing_unit') {
    return mk(0.0, 'incorrect', 'missing_unit', 0.8, '只有数值，缺单位', evidence);
  }

  // unparseable → fallback should have been called
  if (!fallback) {
    return unsupported('accelerator unparseable, fallback not invoked', { ...evidence });
  }
  if (fallback.equivalent_to_reference) {
    return mk(
      1.0, 'correct', null, fallback.parser_confidence,
      'LLM fallback 判等价 (含中文 / 复合形式)', { ...evidence, fallback },
    );
  }
  // fallback parsed but not equivalent —细分 per codex P1 finding line 539:
  // - if fallback explicitly flagged dimension mismatch → dimension_mismatch
  // - else compute numeric / unit relation from fallback's si values
  if (fallback.dimension_mismatch_reason) {
    return mk(
      0.0, 'incorrect', 'dimension_mismatch', fallback.parser_confidence,
      `LLM fallback 判量纲不一致: ${fallback.dimension_mismatch_reason}`,
      { ...evidence, fallback },
    );
  }
  if (fallback.student_value_si !== null && fallback.student_unit_si !== null && reference) {
    // dim assumed OK (no dim_mismatch_reason). Decide by numeric band + unit literal.
    const tol = reference.tolerance;
    const rel = Math.abs(fallback.student_value_si - reference.value) / Math.abs(reference.value || 1);
    const valueMatch = rel < tol;
    const valueClose = !valueMatch && rel < tol * 10;
    const unitExactMatch = fallback.student_unit_si === reference.unit;
    if (!unitExactMatch) {
      return mk(
        0.4, 'partial', 'unit_mismatch_same_dimension', fallback.parser_confidence,
        `LLM fallback 解析单位 ${fallback.student_unit_si} ≠ ref ${reference.unit}`,
        { ...evidence, fallback },
      );
    }
    if (valueClose) {
      return mk(
        0.7, 'partial', 'numeric_close', fallback.parser_confidence,
        'LLM fallback 解析数值偏差 5-50%', { ...evidence, fallback },
      );
    }
    return mk(
      0.3, 'incorrect', 'numeric_off', fallback.parser_confidence,
      'LLM fallback 解析数值偏差 >50%', { ...evidence, fallback },
    );
  }
  // fallback couldn't parse either
  return unsupported('accelerator + LLM fallback 均不能解析', { ...evidence, fallback });
}

function mk(
  score: number,
  outcome: 'correct' | 'partial' | 'incorrect',
  signal: SignalKindT | null,
  confidence: number,
  feedback_md: string,
  evidence: Record<string, unknown>,
): JudgeResultV2T {
  return {
    score,
    score_meaning: 'unit_dimension_v1',
    coarse_outcome: outcome,
    confidence,
    capability_ref: CAPABILITY_REF,
    feedback_md,
    evidence_json: { ...evidence, signal },
  };
}

function unsupported(reason: string, evidence: Record<string, unknown>): JudgeResultV2T {
  return {
    score: null,
    score_meaning: 'unit_dimension_v1',
    coarse_outcome: 'unsupported',
    confidence: 0.1,
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

  it('numeric_off: dim_match + unit_exact + neither match nor close → 0.3 incorrect', () => {
    const r = composeScore({
      accelerator: {
        value_si: 50, unit_si: 'm/s',
        parsed: true, dimension_match: true, unit_exact_match: true,
        value_match: false, value_close: false, signal: 'numeric_off',
      },
      reference: ref, evidence: {},
    });
    expect(r.score).toBe(0.3);
    expect(r.coarse_outcome).toBe('incorrect');
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

  it('dimension_mismatch: dim_match=false → 0.0 incorrect', () => {
    const r = composeScore({
      accelerator: {
        value_si: 30, unit_si: 'm',
        parsed: true, dimension_match: false, unit_exact_match: false,
        value_match: false, value_close: false, signal: 'dimension_mismatch',
      },
      reference: ref, evidence: {},
    });
    expect(r.score).toBe(0.0);
    expect((r.evidence_json as { signal?: string }).signal).toBe('dimension_mismatch');
  });

  it('missing_unit: parsed=false, signal=missing_unit → 0.0 incorrect', () => {
    const r = composeScore({
      accelerator: {
        value_si: 30, unit_si: null,
        parsed: false, dimension_match: false, unit_exact_match: false,
        value_match: false, value_close: false, signal: 'missing_unit',
      },
      reference: ref, evidence: {},
    });
    expect(r.score).toBe(0.0);
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

  it('fallback non-equiv + dim_mismatch_reason → dimension_mismatch 0.0', () => {
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
    expect(r.score).toBe(0.0);
    expect((r.evidence_json as { signal?: string }).signal).toBe('dimension_mismatch');
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

  it('fallback non-equiv + unit matches + value 67% off → numeric_off 0.3', () => {
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
    expect((r.evidence_json as { signal?: string }).signal).toBe('numeric_off');
  });

  it('unparseable + fallback also fails (null values) → unsupported', () => {
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
  });

  it('unparseable + no fallback called → unsupported', () => {
    const r = composeScore({
      accelerator: {
        value_si: null, unit_si: null,
        parsed: false, dimension_match: false, unit_exact_match: false,
        value_match: false, value_close: false, signal: 'unparseable',
      },
      reference: ref, evidence: {},
    });
    expect(r.coarse_outcome).toBe('unsupported');
  });
});
```

- [ ] **Step 3**: Run:

```bash
pnpm vitest run --config vitest.unit.config.ts src/core/capability/judges/unit_dimension/score.test.ts
```

Expected: 13/13 PASS (expanded from 9; added 3 fallback非等价細分 cases + 1 dim_match=true + unit_mismatch case for the signal-outranks-value path).

- [ ] **Step 4**: Defer commit.

---

### Task 5: Wire accelerator + fallback + score into unit_dimension.ts main runner

**Files:**
- Modify: `src/core/capability/judges/unit_dimension.ts`

- [ ] **Step 1**: Replace P1 skeleton `run()` with real runner:

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

async function run(input: JudgeRunInput, deps: RunDeps = {}): Promise<JudgeResultV2T> {
  const student = input.answer_md;
  const refValue = (input.question.metadata as { reference_value?: number } | null)?.reference_value;
  const refUnit = (input.question.metadata as { reference_unit?: string } | null)?.reference_unit;
  const refTolerance = (input.question.metadata as { reference_tolerance?: number } | null)?.reference_tolerance ?? 0.05;

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
        question_context_md: input.question.prompt_md,
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

- [ ] **Step 2**: Update existing `unit_dimension.test.ts` (P1 skeleton tests) to cover real runner:

Either remove skeleton-only assertions or expand. New assertion examples:

```ts
it('exact correct via accelerator', async () => {
  const result = await unitDimensionV1Capability.run({
    answer_md: '30 m/s',
    question: { metadata: { reference_value: 30, reference_unit: 'm/s' } } as any,
    subjectProfile: {} as any,
  });
  expect(result.score).toBe(1.0);
  expect(result.coarse_outcome).toBe('correct');
});

it('LLM fallback called when accelerator unparseable', async () => {
  let llmCalled = false;
  const result = await unitDimensionV1Capability.run({
    answer_md: '三十米每秒',
    question: { metadata: { reference_value: 30, reference_unit: 'm/s' } } as any,
    subjectProfile: {} as any,
  }, {
    runTaskFn: async () => {
      llmCalled = true;
      return { text: JSON.stringify({
        student_value_si: 30, student_unit_si: 'm/s', equivalent_to_reference: true, parser_confidence: 0.92,
      })};
    },
  });
  expect(llmCalled).toBe(true);
  expect(result.coarse_outcome).toBe('correct');
});
```

Note: this requires `JudgeCapabilityRunner.run` to accept a second `deps` arg. If current type doesn't allow, the runner can read deps from a closure or the test can use module-level injection. Pick whichever matches existing steps-judge pattern.

- [ ] **Step 3**: Run + typecheck:

```bash
pnpm typecheck
pnpm vitest run --config vitest.unit.config.ts src/core/capability/judges/unit_dimension.test.ts
```

- [ ] **Step 4**: Commit Tasks 1-5 together:

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
        const result = await unitDimensionV1Capability.run({
          answer_md: tc.student_answer,
          question: {
            metadata: {
              reference_value: fixture.reference_value,
              reference_unit: fixture.reference_unit,
              reference_tolerance: fixture.tolerance,
            },
          } as any,
          subjectProfile: {} as any,
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

- [ ] **Step 2**: Foundation A acid test 2 verify:

```bash
git diff 9191c160a20d8e5afabf11503c6851f510bd2182 -- src/core/capability/registry.ts
git diff 9191c160a20d8e5afabf11503c6851f510bd2182 -- src/server/ai/judges/index.ts
# Both should be EMPTY (acid test 2 hard requirement)

git diff 9191c160a20d8e5afabf11503c6851f510bd2182 -- src/server/ai/judges/question-contract.ts
# Should be just the P1 metadata pass-through line(s) + P2 metadata field
# Captured in spec deltas
```

Expected: registry.ts + judges/index.ts EMPTY; question-contract.ts shows only the documented small delta from P1 + P2.

If non-EMPTY → phase rollback per spec §3 P2 exit criterion 4 ("框架代码 LOC change = 0 (不在 unit_dimension.ts / physics 子目录之外)").

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
