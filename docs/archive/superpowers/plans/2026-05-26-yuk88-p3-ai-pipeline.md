# YUK-88 P3 — AI Pipeline Rewrite Driver

> Linear: YUK-93. Scope source: `docs/planning/2026-05-26-note-rich-doc.md` §0.5 P3 and ADR-0020 §7. This driver owns only P3. It must not drift into P4 Living Note mutator-mode.

## Goal

Move note-producing AI paths onto the ADR-0020 body-block contract:

- `NoteGenerateTask` supports artifact type switching for `note_atomic`, `note_long`, and `note_hub`.
- `NoteVerifyTask` verifies `body_blocks` by artifact type.
- Learning Intent produces 1 hub + N atomic + 0-M long.
- Embedded checks become quiz artifacts referenced from body blocks instead of stale section-only state.

## Non-goals

- No Living Note `NoteRefineTask`, idle mutation, undo timeline, hub auto-sync, backlinks panel, or knowledge node page.
- No schema migration unless a missing P1/P2 contract is discovered and documented as blocker.
- No UI redesign beyond preserving existing pages/tests that consume these artifact rows.

## Lane Order

| Lane | Ownership | Files | Acceptance |
|---|---|---|---|
| A. Body-block contracts | Helper/schema utilities | `src/core/schema/business.ts`, `src/server/artifacts/body-blocks.ts`, focused tests | Helpers can inspect semantic kinds, block ids, artifact refs, and cross-links without treating old sections as storage SoT. |
| B. NoteGenerate type switch | Generate runner + prompts | `src/server/boss/handlers/note_generate.ts`, `src/ai/task-prompts.ts`, `src/ai/registry.ts`, tests | Atomic/long/hub generation parses body-block JSON and persists `generation_status='ready'`. |
| C. NoteVerify body-block verifier | Verify runner + schema | `src/server/boss/handlers/note_verify.ts`, `src/core/schema/business.ts`, tests | Atomic requires 5 semantic kinds; long/hub verification reports block-level issues and does not require `sections[]`. |
| D. LearningIntent 1 hub + N atomic + 0-M long | Proposal/materialization | `src/server/orchestrator/learning_intent.ts`, proposal tests, route tests if needed | Proposal and accept paths materialize long artifacts when present and enqueue generation jobs only for generated artifact types. |
| E. Embedded check as tool_quiz ref | Embedded check producer | `src/server/boss/handlers/embedded_check_generate.ts`, artifact helpers, tests | Generated quiz content lands in a `tool_quiz` artifact or compatible ref block while current review/question behavior remains covered. |

## Test Commands

Focused during implementation:

```bash
pnpm test src/server/boss/handlers/note_generate.test.ts
pnpm test src/server/boss/handlers/note_verify.test.ts
pnpm test src/server/orchestrator/learning_intent.test.ts
pnpm test src/server/boss/handlers/embedded_check_generate.test.ts
pnpm test src/server/artifacts
```

Closeout:

```bash
CODEX_FULL_GATE=1 pnpm typecheck
CODEX_FULL_GATE=1 pnpm lint
CODEX_FULL_GATE=1 pnpm test
```

## Stop Conditions

- Any need to revise ADR-0020/0022 semantics.
- Any implementation path that would resurrect physical `sections[]`, `outline_json`, or `child_artifact_ids`.
- Any P4-only feature becoming required for P3 tests.

## Exit Evidence

- ✅ Focused tests cover all five lanes: body-block helpers, NoteGenerate output parsing, NoteVerify structural checks, LearningIntent outline long artifacts, and EmbeddedCheck `tool_quiz` refs.
- ✅ Docs/status mention YUK-93 as implementation-complete in Wave 4 and reserve final closeout for the Wave gate / PR.
- ✅ Linear YUK-93 can be moved to In Review with commit/PR evidence once the branch is published.

## Implementation Evidence

- `NoteGenerateTask` now writes canonical `body_blocks` and keeps legacy `sections` compatibility.
- `NoteVerifyTask` validates atomic note semantic-kind coverage before spending an LLM call and reports block-level issues.
- Learning Intent materializes 1 hub + N atomic + 0-M long LearningItems/artifacts and enqueues generated note artifacts.
- Embedded checks create standalone `tool_quiz` artifacts and insert `artifact_block_ref` blocks while preserving legacy question metadata.
- Validation: focused Vitest set, Biome check on touched implementation files, and `git diff --check` passed; full typecheck is environment-blocked by missing local `@tiptap/*` packages.
