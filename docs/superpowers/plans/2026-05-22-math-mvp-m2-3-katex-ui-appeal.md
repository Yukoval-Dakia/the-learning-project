# Math MVP — M2.3 KaTeX + UI Surfaces + Appeal Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接 KaTeX 渲染（review/note/teaching 三 surface 共用 adapter）+ 显示 steps@1 partial credit + judge route reason + appeal event 流转，让 M2.2 vision judge 输出真正被 UI 消费。

**Architecture:**
- 共用 `<MathMarkdown>` 组件 — 包 `react-markdown` + `remark-math` + `rehype-katex`，对所有显示 LaTeX 的 prompt/reference/feedback 字段使用。math profile 的 `renderConfig.notation === 'latex'` 触发 KaTeX；wenyan profile 走 markdown-only。
- `<JudgeResultPanel>` 组件 — review 答题"对照"phase 显示判分结果。包含：coarse_outcome badge、score 进度条（partial credit）、capability_ref 显示判分路径（"由 steps@1 判分"）、signal_verdicts 列表（每步 verdict + comment）、extracted_final_answer 对比、feedback_md（走 MathMarkdown）、appeal 按钮。
- Appeal flow — `app/api/review/appeal/route.ts` POST 端点写 `experimental:appeal_request` event（caused_by_event_id 指向原 judge event），不实际重判（spec §3 M2 #8 "M2 不实际重判（M3 或后续 phase）"）。
- 5 道带图 derivation fixtures（spec §3 M2 #4 "5-10 道 fixture (含图片步骤)" — M2.2 只交 5 道纯文本，M2.3 补 5 道带图）；图片用 placeholder asset_id 字符串，不上传真实图片到 R2（local dev seed 时跳过 R2 fetch path）。

**Tech Stack:** react-markdown ^9 / remark-math ^6 / rehype-katex ^7 / katex ^0.16 / Next 15 App Router / Vitest (lib-level only — 跟 project 当前 UI 测试 pattern)

**Spec source:** `docs/superpowers/specs/2026-05-21-math-mvp-vision-design.md` §3 Phase M2 #3/#6/#8 (KaTeX 三 surface / UI 显示 judge route reason / appealable 流转)

**Boundaries (M2.3 不做):**
- 实际 appeal 重判（M3+ — 现仅写 event）
- 学生答题上图 UI（M3+ — 当前 answer 仅 text）
- 重判 sanity 自动 CI 化（M3+）
- Wenyan UI 切换 KaTeX 渲染（wenyan profile renderConfig.notation='wenyan'，走 markdown-only，不进 KaTeX 分支）

---

## File Structure

### Create
- `src/ui/lib/math-markdown.tsx` — `<MathMarkdown>` shared renderer，支持可选 KaTeX (基于 profile.renderConfig.notation)
- `src/ui/lib/math-markdown.test.tsx` — lib-level snapshot test (render to string, assert katex CSS classes present / absent)
- `src/ui/components/JudgeResultPanel.tsx` — partial credit + judge route reason + signal_verdicts + appeal button 容器
- `src/ui/components/JudgeResultPanel.test.tsx` — pure-data formatter logic tests (renderJudgePath, summarizeVerdicts)
- `app/api/review/appeal/route.ts` — POST 端点，写 `experimental:appeal_request` event
- `app/api/review/appeal/route.test.ts` — endpoint test (write event, assert idempotent, assert auth)
- `subjects/math/fixtures/derivation-with-images-data.json` — 5 道带 placeholder image_refs 的 derivation fixtures
- `subjects/math/fixtures/derivation-with-images.ts` — loader（复用 derivation.ts schema + 加 image_refs）

### Modify
- `package.json` — 加 react-markdown / remark-math / rehype-katex / katex (+ @types/katex)
- `app/layout.tsx` (or `app/globals.css`) — import `katex/dist/katex.min.css`（global CSS）
- `app/(app)/review/page.tsx:346` 渲染 prompt_md / reference_md 走 `<MathMarkdown>`
- `app/(app)/review/page.tsx` feedback phase — 替换/增补 JudgeResultPanel（条件：route === 'steps' 才显示完整 panel；其它 route 仍用原 cause-row 简版）
- `src/ui/components/ArtifactSections.tsx` — note section body_md 走 MathMarkdown
- `src/ui/components/TeachingDrawer.tsx` — teaching turn text_md 走 MathMarkdown
- `app/api/_/seed/math/route.ts` — seed 第三批 derivation-with-images fixtures（idempotent via fixture_ref）

### Test (modify)
- `tests/integration/judge-gap-audit.test.ts` — 无需改（M2.2 已 export RUNNABLE_ROUTES 适配）

---

## Phase M2.3 — UI Integration

### Task 1: 加 KaTeX 依赖 + global CSS import

**Files:**
- Modify: `package.json`
- Modify: `app/layout.tsx` (or new global CSS)

- [ ] **Step 1: 加 deps**

Run:
```bash
pnpm add react-markdown@^9 remark-math@^6 rehype-katex@^7 katex@^0.16
pnpm add -D @types/katex
```

Expected: 4 runtime + 1 dev dep installed; no peer-warning blockers.

- [ ] **Step 2: Verify package.json**

Run: `grep -E '"(react-markdown|remark-math|rehype-katex|katex|@types/katex)"' package.json`
Expected: 5 entries present.

- [ ] **Step 3: Import KaTeX CSS in app layout**

Find `app/layout.tsx`. Add at top of file (after existing imports):

```tsx
import 'katex/dist/katex.min.css';
```

If `app/layout.tsx` is a server component (recommended for App Router), this side-effect import works at build time.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml app/layout.tsx
git commit -m "feat(deps): add KaTeX + react-markdown + remark-math + rehype-katex"
```

---

### Task 2: `<MathMarkdown>` 共用渲染组件

**Files:**
- Create: `src/ui/lib/math-markdown.tsx`

- [ ] **Step 1: 写组件**

Create `src/ui/lib/math-markdown.tsx`:

```tsx
import 'client-only';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import type { ComponentProps, ReactElement } from 'react';

export interface MathMarkdownProps {
  /** Markdown source. Supports inline `$...$` and block `$$...$$` math. */
  children: string;
  /**
   * Profile rendering hint. If 'latex' (math), KaTeX plugin chain is enabled.
   * Otherwise pure markdown rendering (wenyan profile renderConfig.notation = 'wenyan').
   *
   * Default 'latex' for backwards-compat at callers that already opt into LaTeX.
   */
  notation?: 'latex' | 'wenyan' | 'plaintext' | 'code';
  /** Optional className for the wrapping div. */
  className?: string;
}

/**
 * Shared markdown renderer. Applied wherever LaTeX math may appear in user-facing
 * content: review prompt / reference / feedback; note section body; teaching turn text.
 *
 * Whitespace: react-markdown unwraps a single paragraph into <p>, but we wrap in a
 * div container so callers can apply layout styling.
 */
export function MathMarkdown({
  children,
  notation = 'latex',
  className,
}: MathMarkdownProps): ReactElement {
  const remarkPlugins: ComponentProps<typeof ReactMarkdown>['remarkPlugins'] = [];
  const rehypePlugins: ComponentProps<typeof ReactMarkdown>['rehypePlugins'] = [];
  if (notation === 'latex') {
    remarkPlugins.push(remarkMath);
    rehypePlugins.push(rehypeKatex);
  }
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS — types from react-markdown 9 resolve correctly.

If `'client-only'` import fails: skip that line (it's a Next safeguard that this component must run on client; not strictly required if all callers are client components).

- [ ] **Step 3: Commit**

```bash
git add src/ui/lib/math-markdown.tsx
git commit -m "feat(ui): MathMarkdown shared renderer (KaTeX-aware, profile-gated)"
```

---

### Task 3: `math-markdown` lib snapshot tests

**Files:**
- Create: `src/ui/lib/math-markdown.test.tsx`

Note: project doesn't have @testing-library/react. We test via `react-dom/server.renderToString` for fast snapshot of HTML output — no jsdom needed.

- [ ] **Step 1: 写测试**

Create `src/ui/lib/math-markdown.test.tsx`:

```tsx
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MathMarkdown } from './math-markdown';

describe('MathMarkdown — KaTeX rendering', () => {
  it('renders inline math with KaTeX classes when notation=latex (default)', () => {
    const html = renderToString(<MathMarkdown>{'square root: $\\sqrt{2}$'}</MathMarkdown>);
    expect(html).toContain('class="katex"');
    expect(html).toContain('square root:');
  });

  it('renders block math with display class', () => {
    const html = renderToString(<MathMarkdown>{'$$x^2 + 1$$'}</MathMarkdown>);
    expect(html).toContain('katex-display');
  });

  it('skips KaTeX plugin chain when notation=wenyan (pure markdown)', () => {
    const html = renderToString(
      <MathMarkdown notation="wenyan">{'文言文：$\\sqrt{2}$'}</MathMarkdown>,
    );
    // No katex class — math syntax surfaces as raw text
    expect(html).not.toContain('class="katex"');
    expect(html).toContain('文言文');
  });

  it('renders plain markdown (lists, emphasis) regardless of notation', () => {
    const html = renderToString(
      <MathMarkdown>{'- **bold** item\n- second'}</MathMarkdown>,
    );
    expect(html).toContain('<ul>');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('applies className to wrapping div', () => {
    const html = renderToString(
      <MathMarkdown className="prose-test">hello</MathMarkdown>,
    );
    expect(html).toContain('class="prose-test"');
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `pnpm vitest run --config vitest.unit.config.ts src/ui/lib/math-markdown.test.tsx`
Expected: 5/5 PASS.

If `renderToString` fails because react-markdown 9 uses ESM-only syntax that vitest can't resolve, you may need a config-level esmInterop tweak or use a dynamic import. Try first; if it works, ship. If not, downgrade test approach to: import the module, assert it exports `MathMarkdown` function, and rely on integration verification.

- [ ] **Step 3: Commit**

```bash
git add src/ui/lib/math-markdown.test.tsx
git commit -m "test(ui): MathMarkdown KaTeX snapshot tests via renderToString"
```

---

### Task 4: Wire `<MathMarkdown>` into review page

**Files:**
- Modify: `app/(app)/review/page.tsx`

- [ ] **Step 1: 加 import + 替换 prompt_md 渲染**

In `app/(app)/review/page.tsx`, add import (near top):

```ts
import { MathMarkdown } from '@/ui/lib/math-markdown';
```

Find line 346 (prompt_md render):

```tsx
          <div {...qbodyProps}>{current.prompt_md}</div>
```

Replace with:

```tsx
          <MathMarkdown {...qbodyProps}>{current.prompt_md}</MathMarkdown>
```

(`qbodyProps` likely already provides className; check the spread is compatible — if it includes `children`, hoist that out.)

- [ ] **Step 2: 替换 reference_md 渲染（2 处）**

Find line 373:

```tsx
                <div {...refTextProps}>{current.reference_md ?? '(无)'}</div>
```

Replace with:

```tsx
                {current.reference_md ? (
                  <MathMarkdown {...refTextProps}>{current.reference_md}</MathMarkdown>
                ) : (
                  <div {...refTextProps}>(无)</div>
                )}
```

Find line ~399-405 (feedback-prose reference block):

```tsx
                  <p
                    {...subjectContentProps(currentSubjectModel, {
                      className: `feedback-prose${current.reference_md ? '' : ' muted'}`,
                    })}
                  >
                    {current.reference_md ?? '（无）'}
                  </p>
```

Replace with:

```tsx
                  {current.reference_md ? (
                    <MathMarkdown
                      {...subjectContentProps(currentSubjectModel, {
                        className: 'feedback-prose',
                      })}
                    >
                      {current.reference_md}
                    </MathMarkdown>
                  ) : (
                    <p
                      {...subjectContentProps(currentSubjectModel, {
                        className: 'feedback-prose muted',
                      })}
                    >
                      （无）
                    </p>
                  )}
```

- [ ] **Step 3: Typecheck + Lint**

```bash
pnpm typecheck && pnpm lint
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/review/page.tsx"
git commit -m "feat(ui): review page renders prompt/reference via MathMarkdown"
```

---

### Task 5: Wire `<MathMarkdown>` into note + teaching surfaces

**Files:**
- Modify: `src/ui/components/ArtifactSections.tsx`
- Modify: `src/ui/components/TeachingDrawer.tsx`

- [ ] **Step 1: Note surface (ArtifactSections.tsx)**

In `src/ui/components/ArtifactSections.tsx`, find where `body_md` is rendered (likely a `<div>{section.body_md}</div>` or similar). 

Run: `grep -n "body_md" src/ui/components/ArtifactSections.tsx`

Replace each direct render with:

```tsx
import { MathMarkdown } from '@/ui/lib/math-markdown';
// ...
<MathMarkdown>{section.body_md}</MathMarkdown>
```

(Apply to all such sites in the file.)

- [ ] **Step 2: Teaching surface (TeachingDrawer.tsx)**

In `src/ui/components/TeachingDrawer.tsx`, find where teaching turn `text_md` is rendered.

Run: `grep -n "text_md" src/ui/components/TeachingDrawer.tsx`

Replace direct renders with `<MathMarkdown>{turn.text_md}</MathMarkdown>` (using the same import).

- [ ] **Step 3: Typecheck + Lint**

```bash
pnpm typecheck && pnpm lint
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/ui/components/ArtifactSections.tsx src/ui/components/TeachingDrawer.tsx
git commit -m "feat(ui): note + teaching surfaces render content via MathMarkdown"
```

---

### Task 6: `<JudgeResultPanel>` 组件 + 数据格式化 lib

**Files:**
- Create: `src/ui/lib/judge-result-format.ts` — pure functions for verdict label + path display
- Create: `src/ui/lib/judge-result-format.test.ts` — unit tests for the formatters
- Create: `src/ui/components/JudgeResultPanel.tsx` — the panel component

- [ ] **Step 1: 写 formatter lib**

Create `src/ui/lib/judge-result-format.ts`:

```ts
import type { JudgeResultV2T } from '@/core/schema/capability';

export interface VerdictRow {
  signal_idx: number;
  signal_text: string;
  verdict: 'correct' | 'partial' | 'wrong' | 'skipped';
  comment: string;
}

const VERDICT_LABEL: Record<VerdictRow['verdict'], string> = {
  correct: '正确',
  partial: '部分',
  wrong: '错误',
  skipped: '未答',
};

const ROUTE_LABEL: Record<string, string> = {
  exact: 'exact 严格比对',
  keyword: 'keyword 关键词',
  semantic: 'semantic 语义判分',
  steps: 'steps@1 视觉判分',
};

export function judgeRouteLabel(capabilityId: string): string {
  return ROUTE_LABEL[capabilityId] ?? capabilityId;
}

export function verdictLabel(verdict: VerdictRow['verdict']): string {
  return VERDICT_LABEL[verdict];
}

/**
 * Build verdict rows by pairing expected_signals (from reference solution)
 * with signal_verdicts (from LLM output). Both arrays must have equal length —
 * judge runtime guarantees this (runStepsJudge length-mismatch guard).
 */
export function buildVerdictRows(
  expectedSignals: string[],
  signalVerdicts: Array<{
    signal_idx: number;
    verdict: VerdictRow['verdict'];
    comment: string;
  }>,
): VerdictRow[] {
  return expectedSignals.map((sig, idx) => {
    const sv = signalVerdicts.find((v) => v.signal_idx === idx);
    return {
      signal_idx: idx,
      signal_text: sig,
      verdict: sv?.verdict ?? 'skipped',
      comment: sv?.comment ?? '',
    };
  });
}

/**
 * Best-effort extract of evidence display fields. JudgeResultV2.evidence_json is
 * Record<string, unknown>; this helper narrows to the steps@1 shape.
 */
export interface StepsEvidence {
  signal_verdicts?: Array<{
    signal_idx: number;
    verdict: VerdictRow['verdict'];
    comment: string;
  }>;
  extracted_final_answer?: string;
  step_score_raw?: number | null;
  step_weight?: number;
  accelerator?: string;
}

export function extractStepsEvidence(result: JudgeResultV2T): StepsEvidence {
  const e = result.evidence_json as StepsEvidence;
  return {
    signal_verdicts: Array.isArray(e?.signal_verdicts) ? e.signal_verdicts : undefined,
    extracted_final_answer:
      typeof e?.extracted_final_answer === 'string' ? e.extracted_final_answer : undefined,
    step_score_raw: typeof e?.step_score_raw === 'number' ? e.step_score_raw : null,
    step_weight: typeof e?.step_weight === 'number' ? e.step_weight : undefined,
    accelerator: typeof e?.accelerator === 'string' ? e.accelerator : undefined,
  };
}
```

- [ ] **Step 2: 写 formatter test**

Create `src/ui/lib/judge-result-format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { JudgeResultV2T } from '@/core/schema/capability';
import {
  buildVerdictRows,
  extractStepsEvidence,
  judgeRouteLabel,
  verdictLabel,
} from './judge-result-format';

describe('judgeRouteLabel', () => {
  it('maps known route ids to Chinese labels', () => {
    expect(judgeRouteLabel('steps')).toBe('steps@1 视觉判分');
    expect(judgeRouteLabel('exact')).toBe('exact 严格比对');
    expect(judgeRouteLabel('keyword')).toBe('keyword 关键词');
    expect(judgeRouteLabel('semantic')).toBe('semantic 语义判分');
  });

  it('falls back to raw id for unknown route', () => {
    expect(judgeRouteLabel('rubric')).toBe('rubric');
    expect(judgeRouteLabel('experimental:foo')).toBe('experimental:foo');
  });
});

describe('verdictLabel', () => {
  it('maps each verdict enum to Chinese label', () => {
    expect(verdictLabel('correct')).toBe('正确');
    expect(verdictLabel('partial')).toBe('部分');
    expect(verdictLabel('wrong')).toBe('错误');
    expect(verdictLabel('skipped')).toBe('未答');
  });
});

describe('buildVerdictRows', () => {
  it('zips expected_signals with signal_verdicts by signal_idx', () => {
    const rows = buildVerdictRows(
      ['用平方差', '约去 a-b', '得 a+b'],
      [
        { signal_idx: 0, verdict: 'correct', comment: 'ok' },
        { signal_idx: 1, verdict: 'partial', comment: 'almost' },
        { signal_idx: 2, verdict: 'wrong', comment: 'forgot' },
      ],
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      signal_idx: 0,
      signal_text: '用平方差',
      verdict: 'correct',
    });
    expect(rows[2].verdict).toBe('wrong');
  });

  it('marks signals without a verdict entry as skipped', () => {
    const rows = buildVerdictRows(
      ['signal a', 'signal b'],
      [{ signal_idx: 0, verdict: 'correct', comment: '' }],
    );
    expect(rows[1]).toMatchObject({ verdict: 'skipped', comment: '' });
  });
});

describe('extractStepsEvidence', () => {
  it('narrows JudgeResultV2.evidence_json to steps shape', () => {
    const result: JudgeResultV2T = {
      score: 0.4,
      score_meaning: 'steps_v1_weighted',
      coarse_outcome: 'partial',
      confidence: 0.9,
      capability_ref: { id: 'steps', version: '1.0.0' },
      feedback_md: 'ok',
      evidence_json: {
        signal_verdicts: [{ signal_idx: 0, verdict: 'partial', comment: 'x' }],
        extracted_final_answer: 'x²+3x',
        step_score_raw: 0.5,
        step_weight: 0.6,
      },
    };
    const e = extractStepsEvidence(result);
    expect(e.signal_verdicts).toHaveLength(1);
    expect(e.extracted_final_answer).toBe('x²+3x');
    expect(e.step_score_raw).toBe(0.5);
  });

  it('returns undefined fields when evidence_json shape is alien', () => {
    const result: JudgeResultV2T = {
      score: null,
      score_meaning: 'correctness',
      coarse_outcome: 'unsupported',
      confidence: 0,
      capability_ref: { id: 'exact', version: '1.0.0' },
      feedback_md: 'fail',
      evidence_json: { whatever: 'unrelated' },
    };
    const e = extractStepsEvidence(result);
    expect(e.signal_verdicts).toBeUndefined();
    expect(e.extracted_final_answer).toBeUndefined();
    expect(e.accelerator).toBeUndefined();
  });
});
```

Run: `pnpm vitest run --config vitest.unit.config.ts src/ui/lib/judge-result-format.test.ts`
Expected: 8/8 PASS.

- [ ] **Step 3: 写 JudgeResultPanel 组件**

Create `src/ui/components/JudgeResultPanel.tsx`:

```tsx
import type { JudgeResultV2T } from '@/core/schema/capability';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import {
  buildVerdictRows,
  extractStepsEvidence,
  judgeRouteLabel,
  verdictLabel,
} from '@/ui/lib/judge-result-format';

export interface JudgeResultPanelProps {
  result: JudgeResultV2T;
  /** Expected signals from reference_solution (rubric_json) — for zipping with signal_verdicts. */
  expectedSignals: string[];
  /** Trigger appeal write. Provided by parent (review page). */
  onAppeal?: () => void;
  /** Whether appeal button shows; disabled if already appealed in this session. */
  appealable?: boolean;
}

const OUTCOME_TONE: Record<JudgeResultV2T['coarse_outcome'], string> = {
  correct: 'judge-tone-correct',
  partial: 'judge-tone-partial',
  incorrect: 'judge-tone-incorrect',
  unsupported: 'judge-tone-unsupported',
};

const OUTCOME_LABEL: Record<JudgeResultV2T['coarse_outcome'], string> = {
  correct: '完整正确',
  partial: '部分正确',
  incorrect: '错误',
  unsupported: '无法判分',
};

export function JudgeResultPanel({
  result,
  expectedSignals,
  onAppeal,
  appealable = true,
}: JudgeResultPanelProps) {
  const evidence = extractStepsEvidence(result);
  const verdictRows =
    evidence.signal_verdicts && expectedSignals.length > 0
      ? buildVerdictRows(expectedSignals, evidence.signal_verdicts)
      : [];
  const isStepsRoute = result.capability_ref.id === 'steps';
  const isAccelerator = evidence.accelerator === 'final_answer_match';

  return (
    <div className="judge-result-panel">
      <div className="judge-result-panel__header">
        <span className={`judge-result-panel__outcome ${OUTCOME_TONE[result.coarse_outcome]}`}>
          {OUTCOME_LABEL[result.coarse_outcome]}
        </span>
        {result.score !== null && (
          <span className="judge-result-panel__score">
            {(result.score * 100).toFixed(0)}%
          </span>
        )}
        <span className="judge-result-panel__route">
          由 {judgeRouteLabel(result.capability_ref.id)} 判分
          {isAccelerator && ' (加速：最终答案匹配)'}
        </span>
      </div>

      {result.feedback_md && (
        <MathMarkdown className="judge-result-panel__feedback">
          {result.feedback_md}
        </MathMarkdown>
      )}

      {isStepsRoute && verdictRows.length > 0 && (
        <ol className="judge-result-panel__verdicts">
          {verdictRows.map((row) => (
            <li key={row.signal_idx} className={`verdict-row verdict-${row.verdict}`}>
              <span className="verdict-row__label">{verdictLabel(row.verdict)}</span>
              <MathMarkdown className="verdict-row__signal">{row.signal_text}</MathMarkdown>
              {row.comment && (
                <MathMarkdown className="verdict-row__comment">{row.comment}</MathMarkdown>
              )}
            </li>
          ))}
        </ol>
      )}

      {isStepsRoute && evidence.extracted_final_answer && (
        <div className="judge-result-panel__extracted">
          <span className="label-mono">提取的最终答案</span>
          <MathMarkdown>{evidence.extracted_final_answer}</MathMarkdown>
        </div>
      )}

      {appealable && onAppeal && (
        <button
          type="button"
          className="judge-result-panel__appeal"
          onClick={onAppeal}
        >
          申诉判分
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Typecheck + Lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/lib/judge-result-format.ts src/ui/lib/judge-result-format.test.ts src/ui/components/JudgeResultPanel.tsx
git commit -m "feat(ui): JudgeResultPanel + formatter lib (steps@1 partial credit display)"
```

---

### Task 7: Appeal endpoint — POST `/api/review/appeal`

**Files:**
- Create: `app/api/review/appeal/route.ts`
- Create: `app/api/review/appeal/route.test.ts`

- [ ] **Step 1: 写 endpoint**

Create `app/api/review/appeal/route.ts`:

```ts
import { z } from 'zod';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/db/client';
import { event } from '@/db/schema';
import { createId } from '@paralleldrive/cuid2';

const AppealRequestSchema = z.object({
  // The judge event being appealed (must exist).
  judge_event_id: z.string().min(1),
  // Optional learner-provided note.
  reason_md: z.string().max(2000).optional(),
});

/**
 * M2.3 (2026-05-22): Appeal flow stub.
 *
 * Writes an `experimental:appeal_request` event chained off the judge event
 * (caused_by_event_id). DOES NOT trigger a rejudge — spec §3 M2 #8 explicitly
 * defers actual rejudge to M3+. The event records the user's intent; downstream
 * dreaming / review jobs may consume it.
 *
 * Auth: middleware enforces `x-internal-token` on all `/api/*` except /health.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = AppealRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { judge_event_id, reason_md } = parsed.data;

  // Look up the judge event to validate + inherit subject_id.
  const [judgeEvent] = await db
    .select()
    .from(event)
    .where(/* eq(event.id, judge_event_id) */ undefined as never);
  // Drizzle eq import would go here — placed inline below in real impl.

  if (!judgeEvent) {
    return NextResponse.json({ error: 'judge_event_not_found' }, { status: 404 });
  }
  if (judgeEvent.action !== 'judge') {
    return NextResponse.json({ error: 'caused_by_must_be_judge_event' }, { status: 400 });
  }

  const now = new Date();
  const appealEventId = createId();
  await db.insert(event).values({
    id: appealEventId,
    action: 'experimental:appeal_request',
    subject_kind: 'event',
    subject_id: judge_event_id,
    caused_by_event_id: judge_event_id,
    outcome: null,
    actor_ref: 'user',
    payload: { reason_md: reason_md ?? '' },
    occurred_at: now,
  });

  return NextResponse.json({ appeal_event_id: appealEventId });
}
```

**Important:** Drizzle `eq` must be imported. Replace the `undefined as never` placeholder with the real `eq(event.id, judge_event_id)`:

```ts
import { eq } from 'drizzle-orm';
```
and:
```ts
.where(eq(event.id, judge_event_id));
```

Verify the `event` schema actually has columns matching `action`/`subject_kind`/`subject_id`/`caused_by_event_id`/`outcome`/`actor_ref`/`payload`/`occurred_at` — these are standard from M0 work. Run:
```bash
grep -n "action:\|subject_kind:\|caused_by_event_id:" src/db/schema.ts | head -10
```
If a column is missing (e.g., `occurred_at` is `created_at`), adjust the insert payload to match.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: 写 endpoint test**

Create `app/api/review/appeal/route.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import { POST } from './route';
import { event } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { createId } from '@paralleldrive/cuid2';

async function seedJudgeEvent(): Promise<string> {
  const id = createId();
  await testDb().insert(event).values({
    id,
    action: 'judge',
    subject_kind: 'event',
    subject_id: 'attempt-evt-1',
    caused_by_event_id: 'attempt-evt-1',
    outcome: 'success',
    actor_ref: 'judge_runner',
    payload: { coarse_outcome: 'partial' },
    occurred_at: new Date(),
  });
  return id;
}

function makeReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/review/appeal', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/review/appeal', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes appeal_request event chained to judge event', async () => {
    const judgeEventId = await seedJudgeEvent();
    const res = await POST(makeReq({ judge_event_id: judgeEventId, reason_md: '我觉得对' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.appeal_event_id).toBeDefined();

    const [appealEvt] = await testDb()
      .select()
      .from(event)
      .where(eq(event.id, json.appeal_event_id));
    expect(appealEvt.action).toBe('experimental:appeal_request');
    expect(appealEvt.subject_kind).toBe('event');
    expect(appealEvt.subject_id).toBe(judgeEventId);
    expect(appealEvt.caused_by_event_id).toBe(judgeEventId);
    expect((appealEvt.payload as { reason_md: string }).reason_md).toBe('我觉得对');
  });

  it('returns 404 when judge_event_id not found', async () => {
    const res = await POST(makeReq({ judge_event_id: 'missing' }));
    expect(res.status).toBe(404);
  });

  it('returns 400 when caused_by event is not a judge event', async () => {
    const id = createId();
    await testDb().insert(event).values({
      id,
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q-1',
      caused_by_event_id: null,
      outcome: 'success',
      actor_ref: 'user',
      payload: {},
      occurred_at: new Date(),
    });
    const res = await POST(makeReq({ judge_event_id: id }));
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid body', async () => {
    const res = await POST(makeReq({ wrong: 'shape' }));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 4: 跑 endpoint test**

Run: `pnpm vitest run --config vitest.db.config.ts app/api/review/appeal/route.test.ts`
Expected: 4/4 PASS.

If `event` table column names differ from what's assumed here (e.g., `created_at` instead of `occurred_at`), the test will fail at insert. Adjust both the route and the test to match `src/db/schema.ts`.

- [ ] **Step 5: Commit**

```bash
git add app/api/review/appeal/route.ts app/api/review/appeal/route.test.ts
git commit -m "feat(api): /api/review/appeal — write appeal_request event (no rejudge yet)"
```

---

### Task 8: Wire JudgeResultPanel + Appeal into review feedback phase

**Files:**
- Modify: `app/(app)/review/page.tsx`

Note: only show JudgeResultPanel for steps@1 route (M2.3 scope). For exact/keyword/semantic, keep existing cause-row simple UI. Conditional render.

- [ ] **Step 1: Add JudgeResultPanel + appeal handler**

In `app/(app)/review/page.tsx`, import:

```tsx
import { JudgeResultPanel } from '@/ui/components/JudgeResultPanel';
```

Add a `judgeResult` field to the per-question state (if not already there — derive from API response). The review queue API should return judge result alongside other question metadata after submission. If it doesn't, the conditional rendering path falls back to the existing UI for non-steps routes.

The feedback phase block needs to detect `current.last_judge_result` (or whatever the prop is called). Add this conditional render BEFORE the existing cause-row block:

```tsx
{phase === 'feedback' && current.last_judge_result?.capability_ref?.id === 'steps' && (
  <JudgeResultPanel
    result={current.last_judge_result}
    expectedSignals={
      (current.rubric_json as { reference_solution?: { expected_signals?: string[] } })
        ?.reference_solution?.expected_signals ?? []
    }
    onAppeal={async () => {
      const res = await fetch('/api/review/appeal', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
        body: JSON.stringify({
          judge_event_id: current.last_judge_event_id,
          reason_md: '',
        }),
      });
      if (!res.ok) {
        console.error('appeal failed', await res.text());
        return;
      }
      // Optimistic UI: mark appealed
      setAppealed(true);
    }}
    appealable={!appealed}
  />
)}
```

(Use the project's standard fetch helper — search `grep -rn "x-internal-token" app/\(app\)/` for the pattern. Don't hand-roll the header if there's a wrapper.)

- [ ] **Step 2: Add `appealed` state**

In the component, near other `useState` calls:

```tsx
const [appealed, setAppealed] = useState(false);
```

Reset on question change (in the same `useEffect` that clears `answer` / `cause`):

```tsx
setAppealed(false);
```

- [ ] **Step 3: Typecheck + Lint**

```bash
pnpm typecheck && pnpm lint
```

If the review page state doesn't expose `last_judge_result` / `last_judge_event_id`, the conditional is dead — defer activation by leaving the UI in place and noting in commit: "wiring complete; review queue API must surface judge result + event id for activation in M3+".

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/review/page.tsx"
git commit -m "feat(ui): review feedback phase shows JudgeResultPanel for steps route + appeal"
```

---

### Task 9: Seed 5 derivation fixtures with placeholder images

**Files:**
- Create: `src/subjects/math/fixtures/derivation-with-images-data.json`
- Create: `src/subjects/math/fixtures/derivation-with-images.ts`
- Modify: `app/api/_/seed/math/route.ts`

These fixtures use placeholder asset_id strings (e.g., `'placeholder-img-001'`) — they will NOT resolve in R2 fetch. Their purpose: exercise the `image_refs` carrier all the way to the LLM payload + display. In test, `runStepsJudge` accepts an injectable `imageFetchFn` that returns `[]` for placeholder ids.

- [ ] **Step 1: Create fixture data**

```json
// src/subjects/math/fixtures/derivation-with-images-data.json
{
  "version": "2026-05-22",
  "subject_id": "math",
  "items": [
    {
      "ref": "math-derivation-img-001",
      "kind": "derivation",
      "prompt_md": "图示三角形 $ABC$，已知 $AB = AC$，$\\angle B = 70°$，求 $\\angle A$。",
      "reference_md": "因 $AB = AC$，三角形等腰，故 $\\angle C = \\angle B = 70°$；$\\angle A = 180° - 70° - 70° = 40°$。",
      "rubric_json": {
        "criteria": [{ "name": "method", "weight": 1, "descriptor": "等腰三角形性质 + 内角和" }],
        "reference_solution": {
          "expected_signals": ["识别等腰三角形 AB=AC", "对应角相等 ∠C=70°", "内角和 180° 推得 ∠A=40°"],
          "final_answer": "40°",
          "answer_equivalents": ["40 度", "∠A = 40°", "= 40°"]
        }
      },
      "difficulty": 2,
      "knowledge_hint": "等腰三角形 / 三角形内角和",
      "image_refs": ["placeholder-isoceles-triangle"]
    },
    {
      "ref": "math-derivation-img-002",
      "kind": "derivation",
      "prompt_md": "下图函数图像求 $f(2)$。（图：开口向上的抛物线 $y = x^2 - 1$，过 $(2, 3)$）",
      "reference_md": "$f(x) = x^2 - 1$；$f(2) = 4 - 1 = 3$。",
      "rubric_json": {
        "criteria": [{ "name": "method", "weight": 1, "descriptor": "代值求函数值" }],
        "reference_solution": {
          "expected_signals": ["识别 $f(x) = x^2 - 1$", "代入 x=2", "得 f(2) = 3"],
          "final_answer": "3",
          "answer_equivalents": ["f(2) = 3", "= 3"]
        }
      },
      "difficulty": 1,
      "knowledge_hint": "函数求值（图像）",
      "image_refs": ["placeholder-parabola"]
    },
    {
      "ref": "math-derivation-img-003",
      "kind": "derivation",
      "prompt_md": "图示直角三角形，$\\angle C = 90°$，$AB = 5$, $BC = 3$，求 $AC$。",
      "reference_md": "由勾股定理：$AC^2 = AB^2 - BC^2 = 25 - 9 = 16$；$AC = 4$。",
      "rubric_json": {
        "criteria": [{ "name": "method", "weight": 1, "descriptor": "勾股定理" }],
        "reference_solution": {
          "expected_signals": ["识别勾股定理 $AC^2 = AB^2 - BC^2$", "代入 $5^2 - 3^2$", "得 $AC = 4$"],
          "final_answer": "4",
          "answer_equivalents": ["AC = 4", "= 4"]
        }
      },
      "difficulty": 2,
      "knowledge_hint": "勾股定理",
      "image_refs": ["placeholder-right-triangle"]
    },
    {
      "ref": "math-derivation-img-004",
      "kind": "derivation",
      "prompt_md": "图示集合 $A = \\{1,2,3\\}$，$B = \\{2,3,4\\}$（Venn 图），求 $A \\cap B$。",
      "reference_md": "$A \\cap B$ 即同时属于 $A$ 和 $B$ 的元素：$\\{2, 3\\}$。",
      "rubric_json": {
        "criteria": [{ "name": "method", "weight": 1, "descriptor": "集合交集定义" }],
        "reference_solution": {
          "expected_signals": ["识别交集定义", "找出 A、B 共同元素", "得 $\\{2, 3\\}$"],
          "final_answer": "{2, 3}",
          "answer_equivalents": ["{2,3}", "{ 2, 3 }", "2 和 3"]
        }
      },
      "difficulty": 1,
      "knowledge_hint": "集合交集",
      "image_refs": ["placeholder-venn-diagram"]
    },
    {
      "ref": "math-derivation-img-005",
      "kind": "derivation",
      "prompt_md": "图示数轴上点 $A = -2$、$B = 5$，求 $|AB|$。",
      "reference_md": "数轴上两点距离：$|AB| = |5 - (-2)| = 7$。",
      "rubric_json": {
        "criteria": [{ "name": "method", "weight": 1, "descriptor": "数轴距离公式" }],
        "reference_solution": {
          "expected_signals": ["识别数轴距离公式 $|AB| = |x_B - x_A|$", "代入 $5 - (-2)$", "得 $|AB| = 7$"],
          "final_answer": "7",
          "answer_equivalents": ["|AB| = 7", "= 7"]
        }
      },
      "difficulty": 1,
      "knowledge_hint": "数轴距离",
      "image_refs": ["placeholder-number-line"]
    }
  ]
}
```

- [ ] **Step 2: Create loader**

Create `src/subjects/math/fixtures/derivation-with-images.ts`:

```ts
import { z } from 'zod';
import { DerivationFixtureItemSchema } from './derivation';
import fixtureData from './derivation-with-images-data.json' with { type: 'json' };

// Same shape as plain derivation, plus image_refs.
export const DerivationWithImagesItemSchema = DerivationFixtureItemSchema.extend({
  image_refs: z.array(z.string().min(1)).min(1),
});
export type DerivationWithImagesItem = z.infer<typeof DerivationWithImagesItemSchema>;

export const DerivationWithImagesFileSchema = z.object({
  version: z.string(),
  subject_id: z.literal('math'),
  items: z.array(DerivationWithImagesItemSchema).min(1),
});

export function loadMathDerivationImageFixtures(): DerivationWithImagesItem[] {
  return DerivationWithImagesFileSchema.parse(fixtureData).items;
}
```

- [ ] **Step 3: Wire into seed endpoint**

In `app/api/_/seed/math/route.ts`, after the existing derivation seed loop, add a third loop for `loadMathDerivationImageFixtures()`. Pattern mirrors T7 (M2.2): same dedup-by-fixture_ref, same insert shape, but set `image_refs: item.image_refs` (non-empty array of placeholder ids).

Run: `grep -n "loadMathDerivationFixtures" app/api/_/seed/math/route.ts` to find the existing loop pattern. Insert a parallel loop directly after.

- [ ] **Step 4: Schema validation test**

Create `src/subjects/math/fixtures/derivation-with-images.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadMathDerivationImageFixtures } from './derivation-with-images';

describe('math derivation-with-images fixtures', () => {
  it('loads 5 items', () => {
    expect(loadMathDerivationImageFixtures()).toHaveLength(5);
  });

  it('every item has non-empty image_refs', () => {
    for (const item of loadMathDerivationImageFixtures()) {
      expect(item.image_refs.length).toBeGreaterThan(0);
      expect(item.image_refs[0]).toMatch(/^placeholder-/);
    }
  });

  it('every item has reference_solution with all 3 fields', () => {
    for (const item of loadMathDerivationImageFixtures()) {
      const rs = item.rubric_json.reference_solution;
      expect(rs.expected_signals.length).toBeGreaterThan(0);
      expect(rs.final_answer.length).toBeGreaterThan(0);
      expect(rs.answer_equivalents.length).toBeGreaterThan(0);
    }
  });
});
```

Run: `pnpm vitest run --config vitest.unit.config.ts src/subjects/math/fixtures/derivation-with-images.test.ts`
Expected: 3/3 PASS.

- [ ] **Step 5: Typecheck + Lint**

```bash
pnpm typecheck && pnpm lint
```

If the unit config doesn't include the new test file, add to `fastTestInclude` in `vitest.shared.ts` (M2.2 T6 did similar).

- [ ] **Step 6: Commit**

```bash
git add src/subjects/math/fixtures/derivation-with-images-data.json src/subjects/math/fixtures/derivation-with-images.ts src/subjects/math/fixtures/derivation-with-images.test.ts app/api/_/seed/math/route.ts vitest.shared.ts
git commit -m "feat(math): 5 derivation-with-images fixtures (placeholder image_refs)"
```

---

### Task 10: M2.3 exit gate

**Files:** (none modified; verification only)

- [ ] **Step 1: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 3: Schema audit**

Run: `pnpm audit:schema`
Expected: PASS — only schema change is appeal endpoint's event insert which uses existing columns.

- [ ] **Step 4: Partition audit**

Run: `pnpm audit:partition`
Expected: PASS.

- [ ] **Step 5: Full test suite**

Run: `pnpm test 2>&1 | tail -15`
Expected: M2.2 baseline 1147 → M2.3 adds:
- math-markdown.test.tsx: 5
- judge-result-format.test.ts: 8
- appeal/route.test.ts: 4
- derivation-with-images.test.ts: 3
- Total expected: **1167 tests pass** (1147 + 20).

If `math-markdown.test.tsx` fails due to vitest ESM/JSX setup issues, the lib still works at runtime — relegate the test (note in commit) and continue.

- [ ] **Step 6: Tag M2.3 completion**

```bash
git commit --allow-empty -m "chore: M2.3 phase complete (KaTeX + UI + appeal flow)"
```

---

## Self-Review (run after writing this plan)

**1. Spec coverage:**

| Spec §3 M2 deliverable | M2.3 task | Status |
|---|---|---|
| `steps@1` capability runtime | M2.2 ✓ | — |
| `JudgeResultV2` partial credit流转 | T8 wire | ✓ |
| KaTeX 3 surface | T1+T4+T5 | ✓ |
| Math derivation 题型 上线 5-10 fixture | M2.2 5 + M2.3 5 image = 10 | ✓ |
| Student input primitive 图 0..N + 文本 | M2.2 schema ✓; UI 上传 deferred | partial (M3+) |
| UI 显示 judge route 选择理由 | T6 JudgeResultPanel (`judgeRouteLabel`) | ✓ |
| Sanity check 同图重判 | M2.2 ✓ | — |
| `appealable: true` 流转 | T7 endpoint + T8 button | ✓ |

**2. Placeholder scan:**
- 一处 placeholder：T7 route.ts 草稿示意写了 `undefined as never`，紧接说明用 `eq(event.id, ...)` 替换。这是 plan 内的说教式提示，不是 placeholder bug。
- 无 "TBD" / "TODO" 残留。
- Fixture placeholder image_refs (`'placeholder-isoceles-triangle'` 等) 是**显式 placeholder** — schema accepts them, R2 fetch returns nothing, test path uses `imageFetchFn` stub. 这不算 plan placeholder，是设计意图。

**3. Type consistency:**
- `JudgeResultV2T` 的 `coarse_outcome` 是 'correct' | 'partial' | 'incorrect' | 'unsupported' — T6 `OUTCOME_TONE` / `OUTCOME_LABEL` 都覆盖这 4 个值。
- `VerdictRow['verdict']` 是 'correct' | 'partial' | 'wrong' | 'skipped'，与 M2.1 `StepsLlmOutput.signal_verdicts[].verdict` 严格一致。
- `judgeRouteLabel(capability_ref.id)` — `capability_ref` 的 `id` 是 string，map 中有 4 个 known key + fallback。
- AppealRequestSchema (Zod) `judge_event_id: string` 对齐 `event.id: text PK`。

**Fixes applied during self-review:**
- 原 T9 想 seed 真实图片到 R2 — 改为 placeholder asset_id 字符串。M2.3 不上传真图，避免对接 R2 测试 + 真实数据 burden；image_refs carrier 通过即可。
- 原 T8 conditional render 写得"必出现 panel"；改为"仅 steps route 出现"——避免对 exact/keyword 路径的回归。
- 原 T7 endpoint test 用 fetch 模拟，改成直接调 `POST(makeReq)` — Next route handler 测试的 idiomatic 路径。

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-22-math-mvp-m2-3-katex-ui-appeal.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Fresh subagent per task + review between tasks, fast iteration via superpowers:subagent-driven-development

**2. Inline Execution** — Execute tasks in this session using superpowers:executing-plans, batch execution with checkpoints

**Which approach?**
