# YUK-150 P2-polish lane plan (Wave 8 / W8-2)

Branch `yuk-150-p2-polish` off fresh wave8 `0d53eeda`. UI/editor lane. Written on-site against the actual tree.

## Scope (W8-2 — exactly two items)

1. Slash-command (`/`) block-insert menu in the TipTap block-tree editor (semantic blocks / cross_link / callout).
2. Drag-drop block reorder inside `body_blocks`, keeping `block_id` stable.

Dropped / deferred (NOT in scope): cross_link `@`-mention picker (already shipped P5-A); generic `@` mention (deferred — conflicts with `@` cross_link trigger).

## Design pre-flight (UI lane — verbatim contract citations)

### Existing implementation studied

- `src/ui/block-tree/CrossLinkSuggestion.tsx` — the `@tiptap/suggestion` paradigm. `buildCrossLinkSuggestion()` returns `Omit<SuggestionOptions, 'editor'>` with `char`, `command`, `items`, `render`. `render()` returns `{ onStart, onUpdate, onKeyDown, onExit }` driving an imperative `PickerPopup` that mounts a React root on `document.body`, positioned `fixed` from the Suggestion `clientRect`. `createCrossLinkSuggestionExtension()` wraps it in `Extension.create({ addProseMirrorPlugins: () => [Suggestion({ editor: this.editor, ... })] })`. The slash menu reuses this exact shape.
- `src/ui/block-tree/tiptap-extensions.tsx` — node/extension registry. `blockTreeEditorExtensions(crossLink?)` returns the array (StarterKit, SemanticBlock, CrossLinkBlock, ArtifactRefBlock, CalloutBlock, AutoLinksContainer, + optional crossLink suggestion). `SemanticBlock` / `CalloutBlock` are `Node.create({ group: 'block', content: 'block+', defining: true })` with React NodeViews (`BlockNodeView`). `CrossLinkBlock` is `atom: true`.
- `src/ui/block-tree/cross-link-picker.ts` — `buildCrossLinkInsertContent(item, { id })` mints `attrs.id` via `newId()` (`@/core/ids` → cuid2). This is the mint-new-block_id paradigm to follow for slash inserts.
- `src/ui/block-tree/BlockTreeEditor.tsx` — editor shell. `useEditor({ extensions, content, immediatelyRender: false })`, toolbar of `Button`s, `save()` → `onSave(coerceBlockTreeDoc(editor.getJSON()))`.

### ADR-0022 verbatim (`docs/adr/0022-tiptap-pm-node-schema.md`)

- "Block ids are stable semantic anchors, not array indexes." (Split/Merge section)
- "`mark_wrong` and future Living Note patches target `block_id`; they must not target position."
- Node table: `semanticBlock` block editable-content `id, semantic_kind, source_tier, user_verified, embedded_check, version, derived_from_block_id`; `crossLinkBlock` block atom `id, artifact_id, block_id?, title?`; `calloutBlock` block editable-content `id, tone, title?`.
- Save Contract: "The editor saves the whole `body_blocks` document through `PATCH /api/artifacts/:id/body-blocks`" → "updates `artifact.version`, appends a `body_blocks_edit` history entry, and writes `experimental:artifact_body_blocks_edit`."
- Basic vs Polish: "P2-polish owns slash commands, drag-drop, mention picker, cross-link picker UI…" → this lane is the slash-command + drag-drop slice.

### block_id stability strategy

- **Drag-drop reorder**: implemented as ProseMirror-native node drag (`draggable: true` on the block Nodes + `data-drag-handle` in the NodeView, per TipTap v3 schema docs). ProseMirror moves the *same node instance* (with its `attrs`, including `attrs.id`) within the doc — it is a structural reorder, NOT a delete+recreate, so `block_id` is inherently preserved. We add a pure helper `reorderTopLevelBlock(doc, fromIndex, toIndex)` in `pm.ts` that splices top-level content and re-parses through `ArtifactBodyBlocks` — used for unit-testing the invariant (ids unchanged, multiset identical, order changed) and as the JSON-level contract that mirrors the editor drag.
- **Slash insert**: new blocks mint a fresh `id` via `newId()` (cuid2), exactly like `buildCrossLinkInsertContent`. Inserting does not touch any existing block's `id`.

### Component types declared

- `SlashCommandSuggestion.tsx` — **editor extension** (TipTap `Extension` wrapping `@tiptap/suggestion`) + an imperative React popup controller (mirrors `CrossLinkSuggestion`). NOT a NodeView, NOT a route/modal/drawer.
- `slash-command-items.ts` — pure, IO-free menu item registry + `buildSlashInsertContent()` (mints ids), unit-testable.
- Drag handle: small addition inside the existing `BlockNodeView` (NodeView) in `tiptap-extensions.tsx` + `draggable: true` on `SemanticBlock` / `CalloutBlock` / `CrossLinkBlock` / `ArtifactRefBlock`.

### Files: create vs modify

- CREATE `src/ui/block-tree/slash-command-items.ts` (pure registry + builders).
- CREATE `src/ui/block-tree/slash-command-items.test.ts` (unit: insert shape + minted-id uniqueness).
- CREATE `src/ui/block-tree/SlashCommandSuggestion.tsx` (extension + popup, mirrors CrossLinkSuggestion).
- MODIFY `src/ui/block-tree/pm.ts` (+ `reorderTopLevelBlock` pure helper).
- MODIFY `src/ui/block-tree/pm.test.ts` (+ reorder block_id-stability tests).
- MODIFY `src/ui/block-tree/tiptap-extensions.tsx` (`draggable: true` on block nodes; `data-drag-handle` in BlockNodeView + crosslink NodeView; register slash extension).
- MODIFY `app/globals.css` (slash menu + drag-handle tokens-only styles; reuse `.cross-link-picker*` shape).

### Save path confirmation

No new artifact writer. Editor `save()` already routes through `onSave` → `saveBodyBlocks` (ArtifactBlockTree.tsx) → `PATCH /api/artifacts/[id]/body-blocks` → `editArtifactBodyBlocks` (single owner; bumps version + history + `experimental:artifact_body_blocks_edit` + `syncBlockRefsForArtifact`). Slash insert + drag reorder only mutate the in-editor doc; persistence is the unchanged whole-document save.

## Gate

`pnpm typecheck && pnpm lint && pnpm audit:partition`; editor unit tests (pm reorder + slash items); `DATABASE_URL=postgres://x INTERNAL_TOKEN=x pnpm build`.
