# YUK-61 — Review answer markdown/math preview

**Goal:** math subject 的 review answer 输入提供 markdown / LaTeX live preview；非 math subject 保持原 textarea，避免文言文输入区变复杂。

## Design Pre-Flight

- Preview 只在 `subject_profile.renderConfig.notation === 'latex'` 时出现。
- Layout 使用 split view：textarea 左、preview 右；窄屏单列。
- Preview 通过 `MathMarkdown` 渲染，继续复用 KaTeX gating。
- Preview 内容通过 180ms debounce 更新；输入即时保留在 textarea。
- Preview 区提供折叠按钮，窄屏用户可以收起。

## Scope

- Add `src/ui/components/ReviewAnswerPreview.tsx`.
- Wire it into `app/(app)/review/page.tsx` answering phase.
- Add SSR tests for math/non-math rendering and helper behavior.
- Add CSS under `/review` stage styles.

## Out of Scope

- Rich markdown editor / syntax toolbar.
- Preview for non-LaTeX subjects.
- Persisting draft answers.

## Tasks

1. **Red:** add `ReviewAnswerPreview` tests for latex-only rendering, KaTeX output, and debounce constant.
2. **Green:** implement component and page split layout.
3. **Verify:** run component tests, adjacent review tests, Biome, typecheck.

## Exit

- [x] Math subject answer input shows live preview.
- [x] Non-math subject answer input does not show preview.
- [x] Preview update path is debounced.
- [x] Preview can be collapsed and remains mobile-safe.
