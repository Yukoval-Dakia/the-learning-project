# Wave 2 Ready-to-Launch — Schema + Editor Basic + DomainTool M2

> 状态：ready-to-launch draft as of 2026-05-27。按 master roadmap §5.1，Wave 2 是两条 active track 上限内的并行 wave：T-88 在 worktree A 顺序跑 P1 → P2-basic；T-D2 在 worktree B 跑 DomainTool read tools M2。

## Source of truth

- `docs/superpowers/status.md` 当前 Phase 行：Wave 1 已收口，下一站候选为 Wave 2。
- `docs/superpowers/plans/2026-05-27-master-roadmap.md` §5.1 Wave 2：T-88 P1/P2-basic + T-D2 + T-PD gap filler。
- `docs/superpowers/plans/2026-05-26-yuk88-block-tree-rebuild-phase.md`：YUK-88 phase index。
- `docs/superpowers/plans/2026-05-26-yuk88-autonomous-driver.md`：YUK-88 autonomous driver。
- `docs/superpowers/specs/2026-05-17-agent-context-tools-design.md` §Engineering Sequence step 5：T-D2 reader source spec。

## Preflight state

| Item | State | Evidence / action |
|---|---|---|
| `main` upstream | ✅ current local tracking says `main...origin/main` | Re-fetch before actual branch/worktree launch. |
| Local main cleanliness | ⚠️ dirty | Existing hook/AGENTS changes + archive zip files are present. Do not mix Wave 2 commits into this worktree; launch lanes in clean worktrees. |
| YUK-88 P0 | ✅ done | Linear YUK-90 Done; spike commit `719c2b7` on `spike/yuk-90-tiptap-block-tree`; PR #162 is intentionally not merged. |
| YUK-88 ultragoal | ✅ P0 checkpointed | `.omc/ultragoal` now has G001 complete; G002/G003 pending. |
| YUK-91 / YUK-92 | ✅ exist, not started | Keep Backlog/Todo until implementation starts. |
| T-D2 Linear | ✅ prepared | Foundation D M2 milestone + YUK-102 parent + YUK-103/YUK-104/YUK-105/YUK-106 lanes. |
| Context7 / docs | ⚠️ Context7 tool unavailable in this runtime | Official TipTap docs were checked instead for Node API, React NodeViews, and Static Renderer. |

## Wave 2 scope

| Track | Lane / phase | Linear | Branch intent | Worktree | Driver |
|---|---|---|---|---|---|
| T-88 | P1 Schema + ADR-0020 | YUK-91 | `yuk-91-p1-schema-adr-0020` | `worktrees/yuk88-p1-schema/` | `2026-05-26-yuk88-p1-schema.md` |
| T-88 | P2-basic editor | YUK-92 | `yuk-92-p2-basic-tiptap-editor` | `worktrees/yuk88-p2-basic/` | `2026-05-26-yuk88-p2-basic.md` |
| T-D2 | Read tools M2 | YUK-102 parent; YUK-103/YUK-104/YUK-105/YUK-106 lanes | `yuk-<id>-td2-*` per lane | `worktrees/track-d2/` or lane worktrees | `2026-05-27-td2-read-tools-driver.md` |
| T-PD | doc sweep gap filler | create only if selected during a capacity gap | doc-only | only if capacity gap | not required before first launch |

## Chain order

1. Launch T-88 P1 first. It mutates DB schema and event schema; no other YUK-88 code should start before it lands.
2. Launch T-D2 in parallel only after confirming the T-D2 lanes avoid `src/db/schema.ts`, `drizzle/`, and artifact/correction schemas.
3. Launch T-88 P2-basic only after P1 chain-merges and the full phase gate passes.
4. Do not launch P2-polish in this wave. It remains a later follow-up after P2-basic proves the editor path.

## Wave gate

Before declaring Wave 2 complete:

```bash
CODEX_FULL_GATE=1 pnpm typecheck
CODEX_FULL_GATE=1 pnpm lint
CODEX_FULL_GATE=1 pnpm audit:schema
CODEX_FULL_GATE=1 pnpm audit:partition
CODEX_FULL_GATE=1 pnpm audit:profile
CODEX_FULL_GATE=1 pnpm test
CODEX_FULL_GATE=1 pnpm build
```

Then run `/audit-drift`, update `docs/superpowers/status.md`, and reconcile Linear states.

## Human decision points

- P1 should apply the P0 spike recommendation: ADR-0020 must explicitly require split command wrappers to preserve the left block id. If the implementation proves that generic ProseMirror split behavior cannot be made stable without a custom command, stop before P2.
- T-D2 is 25 points. If review bandwidth is low, run T-88 P1 alone first, then start T-D2 while P2-basic is being planned.
- Existing dirty files in main look unrelated to Wave 2. Do not clean or revert them without user instruction.
