# YUK-60 — Review subject switch marker

**Goal:** 混合 subject review queue 中，当题目从一个 subject 切到另一个 subject 时，给出明确视觉 marker，避免用户忽略文体 / notation 切换。

## Design Pre-Flight

- Marker 放在 progress 行下、题卡 meta 前；只在当前题和上一题 subject id 不同时出现。
- 使用现有 design tokens：`--info-soft` / `--info` / `--coral-line` / `--ink-*`，不硬编码 subject 色值。
- 文案保持短：`下一题：数学`，附一行 `从 文言文 切换到 数学`。
- 第一题不显示 marker；同 subject 连续题不显示 marker。

## Scope

- Add `src/ui/components/ReviewSubjectSwitchMarker.tsx`.
- Wire it into `app/(app)/review/page.tsx`.
- Add unit coverage for marker visibility helper and rendered copy.
- Add CSS under review session chrome block.

## Out of Scope

- Per-subject custom color palette.
- Queue grouping / reordering.
- Persisting subject transitions in session events.

## Tasks

1. **Red:** add marker helper/render tests.
2. **Green:** implement component, CSS, and page wiring.
3. **Verify:** run marker tests, Biome, typecheck.

## Exit

- [x] Mixed-subject transitions show an explicit marker.
- [x] Same-subject consecutive questions do not show a marker.
- [x] The marker uses existing design tokens.
- [x] Touched tests and typecheck pass.
