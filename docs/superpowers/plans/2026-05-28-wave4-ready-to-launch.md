# Wave 4 Ready-to-Launch — YUK-88 P3 + T-DR Dreaming

> 状态：implementation complete / final gate pending as of 2026-05-28。Wave 3 已通过 PR #170 + YUK-113 review-fix merge 到 `origin/main@5cee0213`。Wave 4 已在 `/private/tmp/tlp-wave4` 落地两条 critical-path lane：YUK-88 P3 AI pipeline rewrite 与 T-DR Dreaming Lane。

## Source of truth

- `docs/superpowers/status.md` 当前 Phase 行：Wave 3 T-D4 implementation complete，下一站为 Wave 4 T-DR // YUK-88 P3。
- `docs/superpowers/plans/2026-05-27-master-roadmap.md` §5.1 Wave 4：T-88 P3 + T-DR + T-PD gap filler。
- `docs/superpowers/plans/2026-05-26-yuk88-block-tree-rebuild-phase.md`：YUK-88 phase index。
- `docs/planning/2026-05-26-note-rich-doc.md` §0.5 P3：YUK-88 P3 scope。
- `docs/superpowers/specs/2026-05-09-learning-orchestrator-long-term-design.md` §Phase 3 and `docs/superpowers/specs/2026-05-17-agent-context-tools-design.md` Dreaming/DomainTool policy.
- Linear:
  - YUK-93 — P3 AI pipeline rewrite.
  - YUK-114 — T-DR Dreaming Lane.

## Preflight state

| Item | State | Evidence / action |
|---|---|---|
| Execution base | ✅ clean worktree | `/private/tmp/tlp-wave4` on `yuk-114-yuk-93-wave4-autopilot`, tracking `origin/main@5cee0213`. |
| Main worktree | ⚠️ dirty / behind | Do not edit or reconcile from this Wave branch. |
| Wave 3 | ✅ shipped | `docs/superpowers/status.md` and PR #170/YUK-113 show T-D4 complete. |
| YUK-93 | ✅ Linear exists | Parent YUK-88; status Backlog at launch. |
| YUK-114 | ✅ Linear exists | Foundation D project; status Todo, ready-for-agent. |
| Driver docs | ✅ this launch doc + lane drivers | P3 and T-DR drivers were created before implementation. |

## Wave 4 scope

| Track | Lane / phase | Linear | Branch intent | Worktree | Driver |
|---|---|---|---|---|---|
| T-88 | P3 AI pipeline rewrite | YUK-93 | `yuk-114-yuk-93-wave4-autopilot` | `/private/tmp/tlp-wave4` | `2026-05-26-yuk88-p3-ai-pipeline.md` |
| T-DR | Dreaming Lane | YUK-114 | same Wave branch unless split is needed | `/private/tmp/tlp-wave4` | `2026-05-28-tdr-dreaming-lane-driver.md` |
| T-PD | doc sweep gap filler | create only if drift is found | doc-only | same | this launch doc / closeout notes |

## Chain order

1. Land G001 driver docs.
2. Implement YUK-93 first. It changes note artifact/pipeline semantics that Dreaming may inspect or cite.
3. Implement YUK-114 after YUK-93 focused tests pass.
4. Run cross-lane integration tests and update status/roadmap.
5. Run full Wave gate and code-review/QA gates.

Do not start Wave 5 (`/today` drawer / Coach) in this branch.

## Wave gate

Before declaring Wave 4 complete:

```bash
CODEX_FULL_GATE=1 pnpm typecheck
CODEX_FULL_GATE=1 pnpm lint
CODEX_FULL_GATE=1 pnpm audit:schema
CODEX_FULL_GATE=1 pnpm audit:partition
CODEX_FULL_GATE=1 pnpm audit:profile
CODEX_FULL_GATE=1 pnpm test
CODEX_FULL_GATE=1 pnpm build
```

Then run the current drift audit equivalent, update `docs/superpowers/status.md`, refresh `docs/superpowers/plans/2026-05-27-master-roadmap.md`, and reconcile Linear states.

## Human decision points

- Stop if YUK-93 requires an ADR-0020/ADR-0022 contradiction rather than an implementation detail.
- Stop if Dreaming needs a product-policy expansion beyond inbox-visible proposals through existing DomainTools.
- Stop before any destructive git rollback, force push, non-fast-forward merge, or production deployment.

## Final lane state

| Lane | Status | Blocked by | Notes |
|---|---|---|---|
| YUK-93 | implementation complete | final gate / PR closeout | Canonical `body_blocks`, NoteGenerate type switch, NoteVerify structural verifier, LearningIntent long artifacts, and embedded `tool_quiz` refs landed. |
| YUK-114 | implementation complete | final gate / PR closeout | `DreamingTask` + `dreaming_nightly` pg-boss producer, DomainTool MCP bridge, dreaming allowlist, and success/failure event writes landed. |

## Implementation outcome

```text
✅  G001 driver docs
✅  G002 YUK-93 AI pipeline rewrite
✅  G003 YUK-114 Dreaming lane
✅  G004 status/roadmap/Linear reconciliation
⏳  G005 final review + full Wave gate
```

Validation evidence so far:

- Focused Vitest set passed for body-block helpers, NoteGenerate output parsing, NoteVerify structural checks, LearningIntent outline long artifacts, Dreaming handler, task prompts, MCP bridge, and allowlist policy.
- Biome check passed on touched implementation files.
- `git diff --check` passed.
- `tsc --noEmit` is blocked in the current worktree because reused `node_modules` lacks `@tiptap/*`; no Wave 4-specific TypeScript errors remain after fixes.
