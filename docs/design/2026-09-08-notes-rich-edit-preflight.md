# YUK981 — Notes rich-edit preflight

## Existing design and surface

Verbatim design source: `docs/design/loom-refresh/project/note-editor.jsx:1`:

> // Loom · block-tree note editor (G). Readonly renderer + editable shell.

Verbatim invariant: `docs/adr/0020-block-tree-note-rebuild.md:51`:

> - **In-place edit**（改文本 / 加 mark）：id 不变

Component type: **other — block editor inside the existing Notes reader route**.
No new drawer, route or modal. Preserve the current block gutters, reorder/remove,
link/question atom behavior, save/cancel, editing presence and optimistic locking.
Do not restore the retired embedded quiz experience.

## Evidence and decision

The current NoteEditor.withText replaces a rich block's entire content with one
paragraph. A public rendered-component test changing the first line observed the
nested list disappear. This behavior predates YUK981 (NoteEditor is unchanged in
the PR; the old generation prompt already allowed rich PM nodes), but conflicts
with the requested end state and must not be presented as lossless editing.

LIGHT: keep a text-only content model and make generation match it. Not recommended:
that abandons existing rich block-tree capability and the owner's desired outcome.
FULL (recommended): use the already-installed TipTap/ProseMirror dependencies in
the existing per-block editing area, preserving PM nodes/marks/anchor IDs. Derive
the source mirror from PM via the same pure Notes-owned projection used by generation.
No new provider, editor dependency, standalone editor framework or UI redesign.

## Exact planned files (pending owner approval)

Modify:
- `src/capabilities/notes/ui/NoteEditor.tsx`
- `src/capabilities/notes/ui/note-reader.css`
- `src/capabilities/notes/ui/NoteEditor.a11y.unit.test.tsx`
- `src/capabilities/notes/server/generated-body-blocks.ts` (extract pure source projection)

Create:
- `src/capabilities/notes/ui/RichNoteBlockEditor.tsx`
- `src/capabilities/notes/ui/RichNoteBlockEditor.unit.test.tsx`
- `src/capabilities/notes/shared/note-block-source.ts`

UI implementation waits for owner approval. The existing component reproduction
is test-only; no UI production code has been changed. Backend cross-link context
and validation can proceed independently in YUK981 while this approval is pending.

## Acceptance

One-character edit plus save/reload preserves nested lists, marks, heading/code
structure, links and block ID. Undo restores prior content; presence/save/version
conflict behavior and existing block controls remain. Use existing tokens/classes,
scoped component tests and a shipped browser scenario. Do not claim a backend
materializer test alone proves editing is safe.
