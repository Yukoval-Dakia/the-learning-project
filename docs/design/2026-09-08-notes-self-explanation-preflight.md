# YUK982 — Restore check prose, not embedded grading

## Existing design (verbatim)

`docs/adr/0040-notes-domain-rethink-living-note-contract.md:26`:

> check 段的「判分自测」用途已被 **D6（删内嵌自测）+ B1（开放题自测无法机判）双杀**。降级为 **self-explanation 反思提示**（不判分 / 不喂 mastery / 不 enroll）——**落地 GPT `self_explained` pedagogy**（Chi 自我解释，主 rethink + GPT 对账 deferred 到此）。verify 五段软门保留（atomic 缺段 needs_review）。

`docs/adr/0020-block-tree-note-rebuild.md:51`:

> - **In-place edit**（改文本 / 加 mark）：id 不变

## Surface and bounded decision

Type: **other — existing Notes reader/editor**, no route/modal/drawer addition.
The generator/verifier intentionally retain check prose, while the reader shows
only a D6 tombstone and the editor cannot edit its content. Restore existing
prose using the same renderer/editor as other semantic blocks, labelled 自解释.
Keep block anchors, source projection, optimistic lock, presence and undo.
No answer field, submit/score button, new model call, mastery/FSRS write, enrollment,
quiz generation or embedded-check route is introduced or restored.

LIGHT: readonly prose only; it leaves an arbitrary edit restriction.
FULL (recommended): readable and editable prose through existing components.

## Exact files (owner approved 2026-09-08)

- `src/capabilities/notes/ui/notes-api.ts` — one shared five-kind label map.
- `src/capabilities/notes/ui/NoteBlocks.tsx` — replace blanket check tombstone with prose rendering.
- `src/capabilities/notes/ui/NoteEditor.tsx` — existing check blocks use rich editing; no new grading UI.
- `src/capabilities/notes/ui/NoteReaderPage.tsx` — visible self-explanation section heading.
- `src/capabilities/notes/ui/NoteReaderPage.unit.test.tsx` — visible prose, no quiz controls.
- `src/capabilities/notes/ui/NoteReaderPage.nrb.unit.test.tsx` — section/anchor integration.
- `src/capabilities/notes/ui/NoteEditor.a11y.unit.test.tsx` — edit/identity preservation.

## Acceptance

Read an existing/generated check block and see its actual text and title; edit,
save/reload and undo preserve rich structure and id. No hidden self-test endpoint
or paid request is called. Existing grading/FSRS workflow stays unchanged.
Use scoped tests and real browser interaction on desktop/mobile. Owner approved
this seven-file FULL plan with “批准”; no additional paid acceptance is authorized.

## Task plan

1. Restore prose rendering and rich editing through existing components.
2. Verify scoped regressions, typecheck/lint/build, desktop/mobile browser behavior.
3. Independent review, exact-head CI and authorized Mac-local delivery; reconcile tracker.
