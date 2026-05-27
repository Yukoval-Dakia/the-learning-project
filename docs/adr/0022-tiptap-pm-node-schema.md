# ADR-0022: TipTap PM Node Schema for Block Tree Notes

**Status**: Accepted for P2-basic
**Date**: 2026-05-27
**Depends on**: ADR-0020

## Context

ADR-0020 made `artifact.body_blocks` the source of truth for `note_hub`, `note_atomic`,
and `note_long`. P2-basic adds the first real TipTap editor path, so the JSON node
names, attrs, read renderer mapping, and block-id semantics need a concrete contract.

## Decision

`body_blocks` stores TipTap / ProseMirror JSON:

```ts
type ArtifactBodyBlocks = {
  type: 'doc'
  content: TipTapNodeJson[]
}
```

P2-basic ships these custom node names:

| Node | Kind | Basic attrs | Purpose |
| --- | --- | --- | --- |
| `semanticBlock` | block, editable content | `id`, `semantic_kind`, `source_tier`, `user_verified`, `embedded_check`, `version`, optional `derived_from_block_id` | Main note body block. Atomic notes keep the five semantic kinds from ADR-0020. |
| `crossLinkBlock` | block atom | `id`, `artifact_id`, optional `block_id`, optional `title` | Block-level cross-link placeholder. Picker UI is P2-polish. |
| `artifactRefBlock` | block atom | `id`, `artifact_id`, optional `title`, optional `artifact_type` | Embedded artifact reference, used later by quiz/check artifacts. |
| `calloutBlock` | block, editable content | `id`, `tone`, optional `title` | Basic callout container. |
| `autoLinksContainer` | block container | `id`, optional `title` | System-generated related links container. |

The read path uses `BlockTreeRenderer`, which renders JSON directly and does not import
`@tiptap/react`, `useEditor`, or `EditorContent`. The editor path is behind a dynamic
client boundary in `ArtifactBlockTree`, so the read surface does not eagerly load the
editor component.

## Split / Merge

Block ids are stable semantic anchors, not array indexes.

- Split keeps the left block id unchanged.
- Split mints a new right block id and records `derived_from_block_id`.
- Merge keeps the previous / left block id and discards the merged-away id.
- `mark_wrong` and future Living Note patches target `block_id`; they must not target
  position.

P2-basic exposes this as JSON transaction wrappers in `src/ui/block-tree/pm.ts`.
Later richer ProseMirror commands must preserve the same observable semantics.

## Save Contract

The editor saves the whole `body_blocks` document through:

```http
PATCH /api/artifacts/:id/body-blocks
```

with optimistic concurrency:

```json
{
  "artifact_version": 0,
  "body_blocks": { "type": "doc", "content": [] }
}
```

The route validates `ArtifactBodyBlocks`, updates `artifact.version`, appends a
`body_blocks_edit` history entry, and writes `experimental:artifact_body_blocks_edit`.

## Basic vs Polish

P2-basic includes:

- TipTap StarterKit + Link integration.
- Minimal React NodeViews for the five custom nodes.
- JSON read renderer.
- Whole-document save.
- Undo/redo and inline bold / italic / code controls.
- Markdown paste import into valid `semanticBlock` JSON.

P2-polish owns slash commands, drag-drop, mention picker, cross-link picker UI, and
fine-grained ProseMirror selection commands beyond the P2-basic wrappers.

## Consequences

P3 / P4 producers must emit these node names and attrs. Legacy compatibility bridges may
still expose `sections` for old UI/tests, but new artifact consumers should read and write
`body_blocks` directly.
