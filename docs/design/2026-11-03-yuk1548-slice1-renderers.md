# YUK-1548 slice 1 — chat block renderers: UI pre-flight

Stage: 帮助靠谱. Outcome: 「对话里出流程图 + 装置图 + 化学式」. UI line only; the server half is
`feat/yuk-1548-slice1-blocks` (#2452). Wire contract:
`tlp-docs/design/2026-11-03-yuk1548-slice1-wire.md`.

## 1. Design text implemented (verbatim)

Source: `/Volumes/YukovalSBak/yukoval-projects/tlp-docs/design/2026-11-03-yuk1548-generative-ui.md`.

§2.2, lines 223, 228–229:

> Every Markdown surface reaches it through one `code` override for info string `tlp-block` in the shared `MarkdownRenderer` (`src/ui/lib/markdown-renderer.tsx:17-37`).
>
> During streaming only, an `img` with `src` `block:<ref>` resolves through the run's `block_ready` frames (§5). This needs a `urlTransform` that allows the `block:` scheme.
>
> `figure` and `diagram` share one display primitive, `SvgImage`: bytes → `Blob('image/svg+xml')` → `<img>`, with intrinsic size from `viewBox`.

§3.1 client render, lines 326–330:

> - `mermaid.initialize({ startOnLoad:false, securityLevel:'strict', htmlLabels:false, flowchart:{htmlLabels:false}, theme:'base', themeVariables: <design tokens> })`.
> - `mermaid.render()` produces an SVG string, which is shown through `SvgImage`.
> - Labels are SVG `<text>`, never `foreignObject`.
> - Use a **system** CJK font stack for diagrams. A webfont would be measured in the page but missing inside the `<img>`.
> - Re-render on theme change.

§3.2 figure, lines 349, 370–371:

> **Choice: sanitise by allowlist rebuild, then show through `<img>`.** Not inline DOM, not an iframe.
>
> | Accessibility | `alt` is required. `long_desc` is exposed with `aria-describedby` as visually hidden text. … |
> | Dark mode | A figure is drawn on a paper-white card, like a textbook figure. CSS variables do not reach into an `<img>`. Diagrams get dark mode by re-rendering. |

§3.3 mhchem, line 379:

> UI line: in `loadMathPlugins` (`math-markdown.tsx:38-56`), add `import('katex/contrib/mhchem')` to the same `Promise.all`. It must register into the **same** katex instance rehype-katex uses.

§5 client behaviour, lines 591–600:

> 2. **`block_draft`** places a skeleton card at its stream position: 「正在绘制：<title>」 with byte progress. It stays a skeleton while incomplete, which is the LIGHT choice in §9.
> 3. **`block_ready`** turns the skeleton into the real block.
>    - `figure`: asset fetch, then `<img>`.
>    - `diagram`: lazy mermaid render, then `<img>`.
>    - Until render, the card shows `alt`. On render failure it shows `alt` + 「图无法显示」 + the source in a collapsed code block (never executed).
> 4. **`![alt](block:<ref>)` in the draft text** moves the block to that position, resolved from the `block_ready` map. A ref not yet ready shows a skeleton with `alt`.
> 5. **REPLY** carries `reply_md` with canonical `tlp-block` fences substituted by the server, so the final render needs no STEP data. Reload and replay read `reply_md` only.

§5 line 589:

> An `invalid` attempt reuses the existing `tool_finished` step, with summary `invalid (diagram_parse_error)`. The skeleton shows 「正在修正」.

§7 slice 1 UI write set, lines 703–712 (new `src/ui/components/blocks/{BlockView,DiagramBlock,FigureBlock,SvgImage,BlockSkeleton}.tsx`; a mermaid loader with the module-memo + `useSyncExternalStore` pattern of `math-markdown.tsx`, no `useEffect`; modified `markdown-renderer.tsx`, `math-markdown.tsx`, `ConversationMarkdown`, `MessageRow`, `subtask-events.ts`, `message-projection.ts`, `tool-labels.ts` 「画图」).

§8 line 813: the UI line owns `src/ui/**`, `src/ui-next/**`, `src/capabilities/*/ui/**` and CSS, including the client reducers.

v2 (`2026-11-03-yuk1548-generative-ui-v2.md`) §7.3: later, `BlockView` renders a `partial` tree through the
same component. Slice 1 keeps `BlockView` a single switch on `kind` so a recursive child renderer can
be added without changing callers.

## 2. Component type

- **other**: inline content cards inside Markdown (chat reply body; any surface that uses the shared
  `MarkdownRenderer`). No route, drawer, modal or page.

## 3. Files

Create:

- `src/ui/components/blocks/BlockView.tsx` — switch on `kind`; quiet fallback for unknown or invalid.
- `src/ui/components/blocks/DiagramBlock.tsx` — mermaid render through `SvgImage`; failure view.
- `src/ui/components/blocks/FigureBlock.tsx` — authenticated `svf_` asset through `SvgImage`.
- `src/ui/components/blocks/SvgImage.tsx` — the one `<img>` display primitive.
- `src/ui/components/blocks/BlockSkeleton.tsx` — 「正在绘制：…」 / 「正在修正：…」.
- `src/ui/components/blocks/diagram-render.ts` — lazy mermaid loader, theme store, render cache
  (module memo + `useSyncExternalStore`).
- `src/ui/components/blocks/BlockFrame.tsx` — the card, plus the waiting, failed and quiet states.
- `src/ui/components/blocks/block-fence.ts` — the UI-only streaming draft fence.
- `src/ui/components/blocks/blocks.css` — card styles (`--un-*` tokens only).

Modify:

- `src/ui/lib/markdown-renderer.tsx` — `tlp-block` fence → `BlockView`; `block:` urlTransform.
- `src/ui/lib/math-markdown.tsx` — `katex/contrib/mhchem` in `loadMathPlugins` and the SSR warm-up.
- `src/capabilities/copilot/ui/subtask-events.ts` — fold `block_draft` / `block_ready` / invalid
  `compose_block` into `CopilotRunView.blocks`.
- `src/capabilities/copilot/ui/message-projection.ts` — carry stream blocks on the live message;
  compose the streaming Markdown with block placeholders.
- `src/capabilities/copilot/ui/companion/MessageRow.tsx` — streaming body goes through the composer.
- `src/capabilities/copilot/ui/companion/tool-labels.ts` — `compose_block`: 「画图」 / 「正在画图」.
- `src/ui/katex-mhchem.d.ts` (new) — module declaration; katex ships none for mhchem.

## 4. Notes

- The barrel `@/core/schema/blocks` is browser-safe since the feature line moved the digest helpers
  to `src/kernel/blocks/digest.ts` (v2 §1.1 must-fix 1), so the UI imports it directly.
- The Markdown typography is not restyled; only block cards get styles.
- A diagram whose source sets its own `style … fill:` / `classDef … fill:` keeps the light palette on a
  paper card in both themes. Its colours were chosen for paper, and dark-theme ink on them is unreadable
  (seen in a real reply).
- The streaming draft fence's info string is random per page load, so stored or model-written text
  can never draw a skeleton.
