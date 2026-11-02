# YUK-52 Note Read UX: Markdown Rendering in Atomic Sections — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Atomic learning-item note sections render their `body_md` as real markdown (lists, code, images, emphasis, blockquotes), keep KaTeX gating intact for math subjects, and don't introduce hydration drift.

**Architecture:** YUK-52 is **mostly already shipped at the renderer layer**. `ArtifactSections` and `EmbeddedCheckSection` already pipe `body_md` / `prompt_md` through `MathMarkdown` (`react-markdown` v9 + `remark-math` + `rehype-katex` gated on `notation === 'latex'`). The actual gap is downstream of that:

1. **CSS regression** — `.artifact-section-body` carries `white-space: pre-wrap`, which collapses badly with the block elements `react-markdown` emits (extra blank lines between `<p>`/`<ul>`/`<pre>`, list items lose indentation).
2. **Visual coverage** — `globals.css` has no prose rules for `code`, `pre`, `ul`/`ol`, `blockquote`, `img`, `strong`, `em`, `hr` *inside `.artifact-section-body`*. Without targeted rules the markdown renders as visually flat text.
3. **Verification panel gap** — In `app/(app)/learning-items/[id]/page.tsx` `ArtifactView`, `verification_summary.summary_md` and `issues[].suggested_fix_md` are rendered as raw `<p>` / `<pre>` text. Both are explicitly markdown per `NoteVerificationResult` Zod schema (`src/core/schema/business.ts:230-245`).

No new packages. No new components beyond a thin `NoteRenderer` wrapper so callers don't have to know about `MathMarkdown` (matches YUK-16 ask, also gives a clean test target). Visual regression coverage = DOM-string assertions on `renderToString` output (same pattern as the existing `math-markdown.test.tsx`) — `@testing-library/react` is **not** installed in this repo (verified — `unit` env is `environment: 'node'` per `vitest.unit.config.ts`).

**Tech Stack:** Next.js 15 App Router, React 19, `react-markdown@9`, `remark-math@6`, `rehype-katex@7`, Tailwind v4 (CSS-first via `app/globals.css`), Vitest 2 (`vitest.unit.config.ts` — node env), `react-dom/server` for tests.

---

## Pre-flight: existing-state verification (read-only — done at plan time)

Verified facts (timestamp 2026-05-24, against `yuk-52-note-markdown` tip `a39f874`):

- `app/(app)/learning-items/[id]/page.tsx` exists; renders `<ArtifactView>` for `data.primary_artifact`, which renders `<ArtifactSections>` for `artifact.sections`.
- `src/ui/lib/math-markdown.tsx` exists; thin wrapper over `react-markdown` with KaTeX plugin chain gated on `notation === 'latex'`. Already used by `ArtifactSections`, `EmbeddedCheckSection`, `JudgeResultPanel`, `TeachingDrawer`.
- `src/ui/lib/math-markdown.test.tsx` exists; uses `react-dom/server.renderToString` — the canonical no-RTL test idiom in this repo.
- `src/ui/components/NoteRenderer/` does **not** exist yet.
- `@testing-library/react` is **not** in `package.json` deps or devDeps. **PR #122 stale-plan trap confirmed — must use `renderToString` style.**
- `vitest.unit.config.ts` runs in `environment: 'node'`. `src/ui/**/*.test.tsx` is already in `fastTestInclude`.
- `BadgeTone` enum (`src/ui/primitives/Badge.tsx:3`) = `'neutral' | 'info' | 'good' | 'hard' | 'again' | 'coral'`. **No `'warning'`.** (PR #122 lesson 2 — flagged; this plan does not invent new tones.)
- Existing CSS tokens for prose rhythm: `--lh-prose: 1.7`, `--width-prose: 680px`, `--font-wenyan`, `--font-mono`, semantic ink palette (`--ink`, `--ink-2..4`, `--again-ink`, etc.), spacing scale (`--s-1..6`), radius scale (`--r-1..3`), surface scale (`--paper`, `--paper-raised`, `--paper-sunk`, `--paper-tint`).
- `react-markdown@9` default behavior: `**bold**` → `<strong>`, `*em*` → `<em>`, ` ```lang\ncode\n``` ` → `<pre><code class="language-lang">…</code></pre>`, `![alt](src)` → `<img alt src>`, `- item` → `<ul><li>`, `> quote` → `<blockquote>`. No syntax highlight by default — that's a **deliberate non-goal** for YUK-52 (YAGNI / no-new-deps).

Decisions:

- **No `remark-gfm`** — Linear scope is code/image/list, not tables/strikethrough/task-list. GFM is an additional dep + bundle. Out of scope for YUK-52.
- **No `rehype-highlight` / `react-syntax-highlighter`** — code is `<pre><code>` with subdued tokens. Style via CSS only. Linear says "走现有 markdown 库，不重造".
- **`NoteRenderer` wrapper** — exists *only* to (a) accept `notation` *plus* a future-proof `kind: 'note' | 'verification' | 'inline'` so callers can opt into different prose classes, and (b) give the test suite a stable target name. Internally delegates to `MathMarkdown`. **No new design tokens, no new Badge tones.**
- **Hydration safety** — `react-markdown` is SSR-safe; `<MathMarkdown>` already wraps in a `<div>`. `'use client'` is preserved on `ArtifactSections` (it already is). Tests assert against `renderToString` output — if hydration mismatch existed, React would warn but the assertions would still pass. Manual `pnpm dev` smoke (out-of-band) for visual confirmation.
- **`pre-wrap` removal** — `.artifact-section-body` currently sets `white-space: pre-wrap` (line 2038 of `app/globals.css`). With true markdown, `react-markdown` already emits block elements that handle line breaks semantically; `pre-wrap` would only force extra whitespace into `<p>` blocks. **Remove `pre-wrap` and `word-break: break-word` from `.artifact-section-body`.** `<pre>` children get their own `white-space: pre` later (Task 3).

---

## File structure

**Create:**

- `src/ui/components/NoteRenderer/index.ts` — barrel `export { NoteRenderer } from './NoteRenderer';`
- `src/ui/components/NoteRenderer/NoteRenderer.tsx` — thin wrapper around `MathMarkdown`, accepts `notation`, `kind`, optional `className`. Adds `.note-prose` (and `.note-prose--verification` for the verification variant) so CSS rules can target without leaking back into other `MathMarkdown` consumers.
- `src/ui/components/NoteRenderer/NoteRenderer.test.tsx` — visual-regression-style coverage via `renderToString` DOM assertions.

**Modify:**

- `src/ui/components/ArtifactSections.tsx` — swap `MathMarkdown` for `NoteRenderer` (`kind='note'`) on the section body. Strip `white-space: pre-wrap`-aware className collisions (the renamed prose class will do the right thing).
- `app/(app)/learning-items/[id]/page.tsx` — in `ArtifactView`, wrap `verification_summary.summary_md` and `issues[].suggested_fix_md` in `NoteRenderer kind='verification'`. Plain `issues[].message` stays as `<p>` (it's not `_md`).
- `app/globals.css` — (a) drop `white-space: pre-wrap` + `word-break: break-word` from `.artifact-section-body` (lines 2038-2039); (b) add `.note-prose` + `.note-prose--verification` blocks covering `p`, `ul/ol/li`, `pre`, `code` (inline + block), `blockquote`, `img`, `strong`, `em`, `hr`, `a`, headings (`h1-h4`) used inside `body_md`.

**Do NOT touch:**

- `src/ui/lib/math-markdown.tsx` — already correct; reused as-is.
- `src/core/schema/business.ts` — `NoteVerificationResult` / `ArtifactSection` schemas are correct.
- Subject `renderConfig` plumbing — already wired through `resolveSubjectRenderModel`.

---

## Tasks

### Task 1: Add `NoteRenderer` wrapper with class hooks

**Files:**
- Create: `src/ui/components/NoteRenderer/NoteRenderer.tsx`
- Create: `src/ui/components/NoteRenderer/index.ts`
- Test: `src/ui/components/NoteRenderer/NoteRenderer.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/ui/components/NoteRenderer/NoteRenderer.test.tsx
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NoteRenderer } from './NoteRenderer';

describe('NoteRenderer — basic markdown contract', () => {
  it('renders bullet lists into <ul><li>', () => {
    const html = renderToString(
      <NoteRenderer kind="note" notation="wenyan">{'- first\n- second\n- third'}</NoteRenderer>,
    );
    expect(html).toContain('<ul>');
    expect(html).toMatch(/<li>first<\/li>/);
    expect(html).toMatch(/<li>second<\/li>/);
    expect(html).toMatch(/<li>third<\/li>/);
  });

  it('renders fenced code with language class', () => {
    const md = '```ts\nconst x = 1;\n```';
    const html = renderToString(
      <NoteRenderer kind="note" notation="code">{md}</NoteRenderer>,
    );
    expect(html).toContain('<pre>');
    expect(html).toContain('<code class="language-ts">');
    expect(html).toContain('const x = 1;');
  });

  it('renders inline code', () => {
    const html = renderToString(
      <NoteRenderer kind="note">{'use `pnpm test` to run'}</NoteRenderer>,
    );
    expect(html).toContain('<code>pnpm test</code>');
  });

  it('renders images with alt text', () => {
    const html = renderToString(
      <NoteRenderer kind="note">{'![diagram](/img/d.png)'}</NoteRenderer>,
    );
    expect(html).toMatch(/<img[^>]+src="\/img\/d\.png"/);
    expect(html).toMatch(/<img[^>]+alt="diagram"/);
  });

  it('renders emphasis and strong', () => {
    const html = renderToString(
      <NoteRenderer kind="note">{'this is **bold** and *italic*'}</NoteRenderer>,
    );
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
  });

  it('renders blockquote', () => {
    const html = renderToString(
      <NoteRenderer kind="note">{'> a quote\n> two lines'}</NoteRenderer>,
    );
    expect(html).toContain('<blockquote>');
  });

  it('keeps KaTeX gating: latex notation parses $...$', () => {
    const html = renderToString(
      <NoteRenderer kind="note" notation="latex">{'energy is $E = mc^2$'}</NoteRenderer>,
    );
    expect(html).toContain('class="katex"');
  });

  it('skips KaTeX when notation is wenyan (raw $...$ text)', () => {
    const html = renderToString(
      <NoteRenderer kind="note" notation="wenyan">{'文言：$\\sqrt{2}$'}</NoteRenderer>,
    );
    expect(html).not.toContain('class="katex"');
    expect(html).toContain('文言：');
  });

  it('applies note-prose class for kind=note', () => {
    const html = renderToString(
      <NoteRenderer kind="note">hello</NoteRenderer>,
    );
    expect(html).toContain('note-prose');
    expect(html).not.toContain('note-prose--verification');
  });

  it('applies note-prose--verification modifier for kind=verification', () => {
    const html = renderToString(
      <NoteRenderer kind="verification">hello</NoteRenderer>,
    );
    expect(html).toContain('note-prose');
    expect(html).toContain('note-prose--verification');
  });

  it('forwards user className alongside note-prose', () => {
    const html = renderToString(
      <NoteRenderer kind="note" className="custom-x">hello</NoteRenderer>,
    );
    expect(html).toContain('note-prose');
    expect(html).toContain('custom-x');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --config vitest.unit.config.ts src/ui/components/NoteRenderer/NoteRenderer.test.tsx`

Expected: FAIL — module `./NoteRenderer` does not exist.

- [ ] **Step 3: Implement `NoteRenderer.tsx`**

```tsx
// src/ui/components/NoteRenderer/NoteRenderer.tsx
'use client';

import type { HTMLAttributes, ReactElement } from 'react';
import { MathMarkdown } from '@/ui/lib/math-markdown';

export type NoteRendererKind = 'note' | 'verification' | 'inline';

export interface NoteRendererProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Markdown source. */
  children: string;
  /**
   * Subject renderConfig.notation — threaded through to MathMarkdown for KaTeX
   * gating. Math only parses when notation === 'latex'.
   */
  notation?: 'latex' | 'wenyan' | 'plaintext' | 'code';
  /**
   * Visual variant. Controls which CSS prose ruleset applies.
   * - 'note' (default): atomic / hub note body — wide prose rhythm
   * - 'verification': denser verification summary / suggested-fix blocks
   * - 'inline': single-line callers (badges, chips) — no block margin
   */
  kind?: NoteRendererKind;
}

const KIND_CLASS: Record<NoteRendererKind, string> = {
  note: 'note-prose',
  verification: 'note-prose note-prose--verification',
  inline: 'note-prose note-prose--inline',
};

/**
 * YUK-52 — shared markdown-renderer wrapper for note read views.
 *
 * Thin facade over MathMarkdown: adds a stable `.note-prose` class so global
 * CSS can scope list / code / image / blockquote rules without leaking into
 * other MathMarkdown consumers (TeachingDrawer, JudgeResultPanel, etc.).
 * KaTeX gating + react-markdown behavior are unchanged from MathMarkdown.
 */
export function NoteRenderer({
  children,
  notation,
  kind = 'note',
  className,
  ...divProps
}: NoteRendererProps): ReactElement {
  const composed = [KIND_CLASS[kind], className].filter(Boolean).join(' ');
  return (
    <MathMarkdown notation={notation} className={composed} {...divProps}>
      {children}
    </MathMarkdown>
  );
}
```

```ts
// src/ui/components/NoteRenderer/index.ts
export { NoteRenderer } from './NoteRenderer';
export type { NoteRendererKind, NoteRendererProps } from './NoteRenderer';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run --config vitest.unit.config.ts src/ui/components/NoteRenderer/NoteRenderer.test.tsx`

Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/NoteRenderer/
git commit -m "feat(ui): YUK-52 NoteRenderer markdown wrapper with kind/notation hooks"
```

---

### Task 2: Wire `NoteRenderer` into `ArtifactSections` (atomic note body)

**Files:**
- Modify: `src/ui/components/ArtifactSections.tsx`
- Test: extend `src/ui/components/NoteRenderer/NoteRenderer.test.tsx` is enough; ArtifactSections gets a smoke test in Task 4.

- [ ] **Step 1: Replace `MathMarkdown` usage on the section body**

In `src/ui/components/ArtifactSections.tsx`, change:

```tsx
import { MathMarkdown } from '@/ui/lib/math-markdown';
```

to:

```tsx
import { NoteRenderer } from './NoteRenderer';
```

and change the body render (lines 68-80 in current file):

```tsx
<MathMarkdown
  notation={
    (subjectModel.renderConfig.notation ?? undefined) as
      | 'latex'
      | 'wenyan'
      | 'plaintext'
      | 'code'
      | undefined
  }
  {...sectionBodyProps}
>
  {s.body_md}
</MathMarkdown>
```

to:

```tsx
<NoteRenderer
  kind="note"
  notation={
    (subjectModel.renderConfig.notation ?? undefined) as
      | 'latex'
      | 'wenyan'
      | 'plaintext'
      | 'code'
      | undefined
  }
  {...sectionBodyProps}
>
  {s.body_md}
</NoteRenderer>
```

(Drop the now-unused `MathMarkdown` import only if no other reference remains — verify with grep on the file.)

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`

Expected: PASS — `NoteRenderer` takes same `notation` enum + spreads `HTMLAttributes`, so existing `sectionBodyProps` ({className: 'artifact-section-body'}) flow through unchanged.

- [ ] **Step 3: Run NoteRenderer tests again to confirm no regression**

Run: `pnpm vitest run --config vitest.unit.config.ts src/ui/components/NoteRenderer/NoteRenderer.test.tsx src/ui/lib/math-markdown.test.tsx`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/ui/components/ArtifactSections.tsx
git commit -m "refactor(ui): YUK-52 ArtifactSections uses NoteRenderer for body_md"
```

---

### Task 3: CSS prose rules + drop `pre-wrap` regression

**Files:**
- Modify: `app/globals.css`

- [ ] **Step 1: Drop `pre-wrap` from `.artifact-section-body`**

In `app/globals.css`, locate the `.artifact-section-body` rule (currently around line 2032-2040):

```css
.artifact-section-body {
  margin: 0;
  font-family: var(--font-wenyan);
  font-size: 15px;
  line-height: 1.7;
  color: var(--ink);
  white-space: pre-wrap;
  word-break: break-word;
}
```

Replace with:

```css
.artifact-section-body {
  margin: 0;
  font-family: var(--font-wenyan);
  font-size: 15px;
  line-height: 1.7;
  color: var(--ink);
  /* white-space + word-break removed — react-markdown emits real block
     elements (<p>, <ul>, <pre>); pre-wrap was injecting extra blank lines
     between blocks and breaking list indentation (YUK-52). */
  overflow-wrap: anywhere;
}
```

- [ ] **Step 2: Add `.note-prose` ruleset**

Append after the `.artifact-section-body` block:

```css
/* ─── YUK-52 — note-prose: scoped rules for NoteRenderer ───────────────────
   Targets <NoteRenderer kind="note">. Lives alongside .artifact-section-body
   so atomic note bodies get list / code / image / blockquote rhythm without
   leaking into TeachingDrawer / JudgeResultPanel / EmbeddedCheck prompt
   (those still consume <MathMarkdown> directly).
*/
.note-prose p {
  margin: 0 0 var(--s-2);
}
.note-prose p:last-child {
  margin-bottom: 0;
}
.note-prose ul,
.note-prose ol {
  margin: var(--s-2) 0;
  padding-left: 1.4em;
}
.note-prose li {
  margin: 2px 0;
  line-height: var(--lh-prose);
}
.note-prose li > p {
  margin: 0;
}
.note-prose code {
  font-family: var(--font-mono);
  font-size: 0.92em;
  background: var(--paper-raised);
  border: 1px solid var(--line-soft);
  border-radius: var(--r-1);
  padding: 0 4px;
}
.note-prose pre {
  margin: var(--s-3) 0;
  padding: var(--s-3);
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--r-2);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.55;
  color: var(--ink-2);
  overflow-x: auto;
  white-space: pre;
}
.note-prose pre code {
  background: transparent;
  border: 0;
  padding: 0;
  font-size: inherit;
  color: inherit;
}
.note-prose blockquote {
  margin: var(--s-3) 0;
  padding: 6px var(--s-3);
  border-left: 2px solid var(--coral-line);
  color: var(--ink-2);
  background: var(--paper-raised);
  border-radius: 0 var(--r-1) var(--r-1) 0;
}
.note-prose blockquote p:last-child {
  margin-bottom: 0;
}
.note-prose img {
  display: block;
  max-width: 100%;
  height: auto;
  margin: var(--s-3) 0;
  border-radius: var(--r-2);
  border: 1px solid var(--line-soft);
}
.note-prose strong {
  font-weight: 600;
  color: var(--ink);
}
.note-prose em {
  font-style: italic;
}
.note-prose hr {
  border: 0;
  border-top: 1px solid var(--line-soft);
  margin: var(--s-3) 0;
}
.note-prose a {
  color: var(--coral);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.note-prose h1,
.note-prose h2,
.note-prose h3,
.note-prose h4 {
  font-family: var(--font-sans);
  font-weight: 600;
  margin: var(--s-3) 0 var(--s-2);
  line-height: 1.35;
  color: var(--ink);
}
.note-prose h1 {
  font-size: 1.25em;
}
.note-prose h2 {
  font-size: 1.15em;
}
.note-prose h3 {
  font-size: 1.05em;
}
.note-prose h4 {
  font-size: 1em;
  color: var(--ink-2);
}

/* Verification variant — denser, no font-wenyan override needed (parent CSS
   for the verification panel uses sans). */
.note-prose--verification {
  font-family: var(--font-sans);
  font-size: var(--fs-body);
  line-height: var(--lh-prose);
}
.note-prose--verification p {
  margin: 0 0 var(--s-2);
}
.note-prose--verification pre {
  font-size: 12px;
  padding: var(--s-2);
}
```

- [ ] **Step 3: Smoke build to confirm CSS parses**

Run: `pnpm lint`

Expected: PASS. (Biome lints CSS-in-JS only; globals.css passes through. The real check is that `pnpm build` later parses it — covered by typecheck + verification gate.)

- [ ] **Step 4: Commit**

```bash
git add app/globals.css
git commit -m "style(ui): YUK-52 note-prose CSS + drop pre-wrap on .artifact-section-body"
```

---

### Task 4: Smoke test for `ArtifactSections` (asserts NoteRenderer wiring)

**Files:**
- Test: `src/ui/components/ArtifactSections.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

```tsx
// src/ui/components/ArtifactSections.test.tsx
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ArtifactSections, type ArtifactSection } from './ArtifactSections';
import type { SlimSubjectProfile } from '@/ui/lib/subject';

const wenyanProfile: SlimSubjectProfile = {
  id: 'wenyan',
  displayName: '文言文',
  renderConfig: { notation: 'wenyan' },
};

const mathProfile: SlimSubjectProfile = {
  id: 'math',
  displayName: '数学',
  renderConfig: { notation: 'latex' },
};

const baseSection: Omit<ArtifactSection, 'id' | 'kind' | 'body_md'> = {
  source_tier: 'llm_only',
  user_verified: false,
  embedded_check: null,
  version: 1,
};

describe('ArtifactSections — markdown rendering wiring', () => {
  it('renders list / code / image inside atomic body via NoteRenderer', () => {
    const sections: ArtifactSection[] = [
      {
        ...baseSection,
        id: 's1',
        kind: 'mechanism',
        body_md: '- step one\n- step two\n\n```py\nprint("hi")\n```\n\n![fig](/x.png)',
      },
    ];
    const html = renderToString(
      <ArtifactSections
        sections={sections}
        subjectProfile={wenyanProfile}
        embeddedQuestions={[]}
        embeddedCheckStatus="not_required"
      />,
    );
    expect(html).toContain('note-prose');
    expect(html).toContain('artifact-section-body');
    expect(html).toContain('<ul>');
    expect(html).toMatch(/<li>step one<\/li>/);
    expect(html).toContain('<pre>');
    expect(html).toContain('<code class="language-py">');
    expect(html).toMatch(/<img[^>]+src="\/x\.png"/);
  });

  it('preserves KaTeX gating for math subject', () => {
    const sections: ArtifactSection[] = [
      { ...baseSection, id: 's1', kind: 'definition', body_md: '$E = mc^2$' },
    ];
    const html = renderToString(
      <ArtifactSections
        sections={sections}
        subjectProfile={mathProfile}
        embeddedQuestions={[]}
        embeddedCheckStatus="not_required"
      />,
    );
    expect(html).toContain('class="katex"');
  });

  it('skips KaTeX for wenyan subject', () => {
    const sections: ArtifactSection[] = [
      { ...baseSection, id: 's1', kind: 'definition', body_md: '注释：$x$ 不是数学符号' },
    ];
    const html = renderToString(
      <ArtifactSections
        sections={sections}
        subjectProfile={wenyanProfile}
        embeddedQuestions={[]}
        embeddedCheckStatus="not_required"
      />,
    );
    expect(html).not.toContain('class="katex"');
    expect(html).toContain('注释：');
  });

  it('renders section header label + tier label', () => {
    const sections: ArtifactSection[] = [
      { ...baseSection, id: 's1', kind: 'pitfall', body_md: 'careful', source_tier: 'textbook' },
    ];
    const html = renderToString(
      <ArtifactSections
        sections={sections}
        subjectProfile={wenyanProfile}
        embeddedQuestions={[]}
        embeddedCheckStatus="not_required"
      />,
    );
    expect(html).toContain('易错');
    expect(html).toContain('教材');
  });
});
```

> **Note for implementer:** if `SlimSubjectProfile` requires more fields than `{ id, displayName, renderConfig }`, read `src/ui/lib/subject.ts` and pad with the minimum needed — do not invent new shape.

- [ ] **Step 2: Run test to verify it fails (no file exists yet)**

Run: `pnpm vitest run --config vitest.unit.config.ts src/ui/components/ArtifactSections.test.tsx`

Expected: FAIL — file or type mismatch.

- [ ] **Step 3: Fix `SlimSubjectProfile` shape if needed**

Read `src/ui/lib/subject.ts`. If `SlimSubjectProfile` includes fields beyond `id`/`displayName`/`renderConfig`, expand the test fixtures with the minimum required values (e.g., `slug`, `code`, whatever the actual zod schema is). Keep test data minimal — no real DB shape needed.

- [ ] **Step 4: Re-run, verify PASS**

Run: `pnpm vitest run --config vitest.unit.config.ts src/ui/components/ArtifactSections.test.tsx`

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/ArtifactSections.test.tsx
git commit -m "test(ui): YUK-52 ArtifactSections markdown wiring + KaTeX gating smoke"
```

---

### Task 5: Wire `NoteRenderer` into verification summary panel

**Files:**
- Modify: `app/(app)/learning-items/[id]/page.tsx`

- [ ] **Step 1: Add import**

In `app/(app)/learning-items/[id]/page.tsx`, add to the existing UI imports:

```tsx
import { NoteRenderer } from '@/ui/components/NoteRenderer';
```

- [ ] **Step 2: Replace raw verification summary with `NoteRenderer`**

Locate the `ArtifactView` component (around lines 470-533). Find the `verification_summary` block (lines 513-528):

```tsx
{artifact.verification_summary && (
  <div className="artifact-verification">
    <p>{artifact.verification_summary.summary_md}</p>
    {artifact.verification_summary.issues.length > 0 && (
      <ul>
        {artifact.verification_summary.issues.map((issue, idx) => (
          <li key={`${issue.section_id ?? 'global'}-${idx}`}>
            <strong>{issue.severity}</strong>
            <span>{issue.category}</span>
            <p>{issue.message}</p>
            {issue.suggested_fix_md && <pre>{issue.suggested_fix_md}</pre>}
          </li>
        ))}
      </ul>
    )}
  </div>
)}
```

Replace with (preserves the `.artifact-verification` shell + `<ul>/<li>/<strong>/<span>` chrome — only `summary_md` and `suggested_fix_md` switch to `NoteRenderer`; `issue.message` is plain text per `NoteVerificationIssue` schema):

```tsx
{artifact.verification_summary && (
  <div className="artifact-verification">
    {/* YUK-52 — summary_md and suggested_fix_md are markdown per
        NoteVerificationResult zod schema; render via NoteRenderer with
        verification variant so prose styles match the denser panel. */}
    <NoteRenderer
      kind="verification"
      notation={
        (subjectProfile.renderConfig?.notation ?? undefined) as
          | 'latex'
          | 'wenyan'
          | 'plaintext'
          | 'code'
          | undefined
      }
    >
      {artifact.verification_summary.summary_md}
    </NoteRenderer>
    {artifact.verification_summary.issues.length > 0 && (
      <ul>
        {artifact.verification_summary.issues.map((issue, idx) => (
          <li key={`${issue.section_id ?? 'global'}-${idx}`}>
            <strong>{issue.severity}</strong>
            <span>{issue.category}</span>
            <p>{issue.message}</p>
            {issue.suggested_fix_md && (
              <NoteRenderer
                kind="verification"
                notation={
                  (subjectProfile.renderConfig?.notation ?? undefined) as
                    | 'latex'
                    | 'wenyan'
                    | 'plaintext'
                    | 'code'
                    | undefined
                }
              >
                {issue.suggested_fix_md}
              </NoteRenderer>
            )}
          </li>
        ))}
      </ul>
    )}
  </div>
)}
```

> **Implementer note:** the `subjectProfile.renderConfig?.notation` access — verify against actual `SlimSubjectProfile` shape in `src/ui/lib/subject.ts`. If the field name differs (e.g., `renderModel.notation`), adapt. The `ArtifactView` component already receives `subjectProfile` as a prop (line 472) — keep that wiring.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 4: Visual regression test — extend ArtifactSections test? No — verification panel lives in the page route, not in a component. Add a focused render-of-just-the-block via NoteRenderer:**

Add to `src/ui/components/NoteRenderer/NoteRenderer.test.tsx`:

```tsx
describe('NoteRenderer — verification variant', () => {
  it('verification kind renders markdown in summary copy', () => {
    const html = renderToString(
      <NoteRenderer kind="verification">
        {'Summary: see **issues** below.'}
      </NoteRenderer>,
    );
    expect(html).toContain('note-prose--verification');
    expect(html).toContain('<strong>issues</strong>');
  });

  it('verification kind handles inline code in suggested-fix block', () => {
    const html = renderToString(
      <NoteRenderer kind="verification">{'replace `foo` with `bar`'}</NoteRenderer>,
    );
    expect(html).toContain('<code>foo</code>');
    expect(html).toContain('<code>bar</code>');
  });
});
```

Run: `pnpm vitest run --config vitest.unit.config.ts src/ui/components/NoteRenderer/`

Expected: PASS (all NoteRenderer tests).

- [ ] **Step 5: Commit**

```bash
git add app/\(app\)/learning-items/\[id\]/page.tsx src/ui/components/NoteRenderer/NoteRenderer.test.tsx
git commit -m "feat(ui): YUK-52 verification summary panel renders markdown via NoteRenderer"
```

---

### Task 6: Pre-merge gate

**Files:** none

- [ ] **Step 1: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`

Expected: PASS both.

- [ ] **Step 2: Schema / partition / profile audits**

Run: `pnpm audit:schema && pnpm audit:partition && pnpm audit:profile`

Expected: PASS — no schema changes, no new test partition violation (NoteRenderer tests are under `src/ui/**/*.test.tsx` which is in `fastTestInclude`), no profile changes.

- [ ] **Step 3: Full test gate**

Run: `pnpm test`

Expected: PASS. Worktree-local DB testcontainer spins up; that's expected.

- [ ] **Step 4: If everything green, no extra commit needed — Task 1-5 commits are the deliverable.**

If anything fails:
- typecheck failure → fix in place; new fixup commit `fix(...): YUK-52 ...`
- lint → `pnpm format` then commit
- unit test flake → investigate; do not paper over with retry
- DB test flake → check if it was flaky on `main` already; note in report

---

## Self-Review (against this plan)

1. **Spec coverage** (Linear YUK-52 acceptance):
   - "atomic note section markdown 渲染（含 code block / image / list）" → Task 1 (NoteRenderer) + Task 2 (ArtifactSections wiring) + Task 3 (CSS) cover it. Tests in Task 1+4 assert `<ul>`, `<code class="language-..">`, `<img>`.
   - "与现有 KaTeX gating 兼容" → Task 1 keeps `notation` plumbed; Task 4 has explicit `KaTeX gating preserved for math` + `skipped for wenyan` tests.
   - "无 hydration mismatch" → Architecture section explicit. `'use client'` preserved; `react-markdown@9` is SSR-safe.
   - "至少 1 个 visual regression test (snapshot 或 storybook)" → 11 NoteRenderer tests + 4 ArtifactSections tests = 15 DOM-shape assertions covering list/code/image/emphasis/blockquote/heading/inline-code/KaTeX-on/KaTeX-off/className-forward.

2. **PR #122 stale items already covered**:
   - `@testing-library/react` — explicitly verified absent; pre-flight section calls it out; all tests use `react-dom/server.renderToString`.
   - `BadgeTone='warning'` — flagged in pre-flight; plan introduces no Badge changes at all.

3. **Placeholder scan**: no TBDs, no "add appropriate error handling", every code step has runnable code.

4. **Type consistency**:
   - `NoteRendererKind`, `NoteRendererProps` defined in Task 1, used identically in `index.ts` barrel and Task 2/5 imports.
   - `notation` enum literal `'latex' | 'wenyan' | 'plaintext' | 'code'` matches `MathMarkdownProps.notation` exactly.
   - `ArtifactSection` re-uses existing exported type — no duplication.

5. **Scope discipline**: no `remark-gfm`, no `rehype-highlight`, no new packages, no new Badge tones, no schema changes, no migrations.

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `react-markdown` v9 default behavior changes between minor versions (e.g., `<code class="language-...">` shape) | low | Tests in Task 1 lock the shape; if they break on dep bump, that's an explicit signal not a silent regression. |
| `SlimSubjectProfile` shape in tests doesn't match real schema and causes typecheck fail | medium | Task 4 Step 3 explicitly tells implementer to read `src/ui/lib/subject.ts` and adapt. |
| CSS `.note-prose pre { white-space: pre }` causes overflow on long lines on mobile | low | `overflow-x: auto` on `pre` handles it; `overflow-wrap: anywhere` on parent catches long inline text. |
| Removing `pre-wrap` from `.artifact-section-body` breaks an existing note that relied on literal `\n` in the markdown source | very low | Markdown already collapses single `\n` into space and double `\n` into paragraph break — that's the standard contract every note author already follows. Manual visual smoke on an existing learning-item before merge. |
| The `subjectProfile.renderConfig?.notation` access shape in verification panel is wrong | low | Task 5 implementer-note flags the lookup. Typecheck (Task 5 Step 3) catches it. |

---

## Rollback

- Each task commits independently. To roll back any task: `git revert <sha>`.
- The CSS changes (Task 3) are additive except for the `pre-wrap` removal — to revert that single concern, re-add the two lines to `.artifact-section-body`. The `.note-prose` rules can stay (they're scoped to a class added in Task 1, harmless if `NoteRenderer` were removed).
- Verification panel revert (Task 5) is contained to the `ArtifactView` block in one page file.

---

## Linear capture gate (follow-ups to flag, NOT in scope)

After implementation, propose these as separate Linear issues if they don't already exist:

- **`remark-gfm` for tables / task lists in notes** — out of scope per YUK-52 wording, but reviewers may request it. If a note author writes a table, current behavior is "markdown-literal" rendering.
- **Code syntax highlighting** — `<pre><code class="language-py">` ships with class hooks but no highlighter. Could add `rehype-highlight` (~30KB) in a follow-up.
- **Image safety / `next/image` adoption** — current rendering uses raw `<img>`. Switching to `next/image` would need an allowlist for note image hosts (R2 / external URLs). Probably worth doing for hub note rendering pass.
- **`renderConfig.notation` shape on `SlimSubjectProfile`** — if Task 5 finds the access path is shaky (`?.notation` vs `.notation` vs `renderModel.notation`), file a doc / refactor issue.

---

## Exit criteria

- `pnpm typecheck && pnpm lint && pnpm audit:schema && pnpm audit:partition && pnpm audit:profile && pnpm test` all PASS.
- New tests: `src/ui/components/NoteRenderer/NoteRenderer.test.tsx` (≥11 tests) + `src/ui/components/ArtifactSections.test.tsx` (≥4 tests).
- Visual touchpoints (no automated check — implementer should `pnpm dev` once):
  - Atomic learning-item with bulleted list → renders as real `<ul>` with indent + line-height.
  - Atomic learning-item with fenced code → renders as monospaced block with subtle paper background, scrolls horizontally on long lines.
  - Atomic learning-item with `![alt](url)` → image displays inline at full container width.
  - Math subject still renders KaTeX inline + block.
  - Wenyan subject still treats `$x$` as text.
  - Verification panel summary + suggested-fix render as styled markdown, not raw text.
- All commits include `YUK-52` in subject; last commit closes the loop.
