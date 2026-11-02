# Wave 8 — Lane C: 2026-05-29 deep-review fixes

Written against fresh wave8 base `0d53eeda`. Branch `fix/wave8-review-2026-05-29`.

Scope: 3 review findings (coordinator-located). No scope expansion — P2.1 re-scatter is out of lane (= YUK-153).

## Fix 1 [P1 real bug] undo does not resync the L2 cross_link index

`undoNoteRefineApplyEvent` (`src/server/artifacts/note-refine-apply.ts`) restores
`previous_body_blocks` into the artifact but, unlike the apply path
(`persistNoteRefineApply`, which calls `syncBlockRefsForArtifact` after the
update), never resynced the `artifact_block_ref` L2 backlink index. Restoring a
doc that adds/removes `crossLinkBlock` nodes left the index lagging the live
document.

- Fix: after the optimistic-lock guard (`restored.length === 0 → version_conflict`)
  and before `writeEvent`, call
  `await syncBlockRefsForArtifact(tx, artifactId, payload.previous_body_blocks)`
  in the same tx (mirrors the apply-path resync). `syncBlockRefsForArtifact` was
  already imported; `payload.previous_body_blocks` was already guarded non-null.
- Tests: new `describe('undoNoteRefineApplyEvent → block-ref resync in the same tx')`
  in `block-refs.test.ts`, both directions:
  - apply appends a crossLinkBlock → ref written → undo restores pre-link doc →
    assert ref row deleted by resync.
  - seed a doc WITH a crossLinkBlock (+ seed its ref) → apply deletes it → ref
    dropped → undo restores → assert ref row re-added.
  - Red/green proof: with the fix stashed, both fail (lagging index = 1 row when 0
    expected, and 0 rows when 1 expected); with the fix, both pass.

## Fix 2 [feature-level, Closes YUK-146] derived_from meaning direction (AI-facing)

`DEFAULT_RELATIONS.derived_from.meaning` in `knowledge-readers.ts` read
`'target concept extends source'`, the inverse of ADR-0010 (`docs/adr/0010-knowledge-mesh.md`
L41: `from` 派生自 `to`). This string flows through the Overview tool's
`relation_types` output to the AI, which proposes edge direction from it.

- Fix: `meaning: 'from concept is derived from / builds on the to concept'`
  (from→to phrasing matching `prerequisite`'s style; direction now matches ADR-0010:
  from is the derivative, to is the source). No test asserted the old string.

## Fix 3 [minor] cross_links_total semantic mislabel

`hub_auto_sync_nightly.ts` incremented `result.cross_links_total += curated.length`
before the patch no-op / version_conflict branches, so it counted *desired* curated
links, not actually-written ones.

- Decision: RENAME to `cross_links_desired_total` (chosen over add-comment).
  Rationale: only 6 references total, all in the handler module + its two direct
  consumer tests (`hub_auto_sync_nightly.test.ts`, `dismiss-link/route.test.ts`) —
  no stable external/log-parsing consumer, so the rename ripple is small and the
  name itself becomes self-documenting. Kept a clarifying comment on the field too.

## Gate
- `pnpm typecheck` — pass
- `pnpm lint` — pass (635 files)
- `pnpm audit:partition` — pass (pre-existing unrelated P1 WARN on copilot/chat.test.ts)
- DB tests (block-refs, hub_auto_sync_nightly, read-tools-m2, dismiss-link route) —
  31 passed; new undo-resync tests proven via red/green stash check.
