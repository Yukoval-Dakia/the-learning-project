# T-DR — Dreaming Lane Driver

> Linear: YUK-114. Scope source: master roadmap Card T-DR, v0.4 P0.3, `docs/superpowers/specs/2026-05-09-learning-orchestrator-long-term-design.md`, and `docs/superpowers/specs/2026-05-17-agent-context-tools-design.md`.

## Goal

Ship Dreaming as the proactive proposal producer that wakes on a schedule, gathers bounded evidence through DomainTools/memory, and writes inbox-visible AI proposals. This unblocks T-D6 Global Coach and closes the Layer 7 brief-refresh consumer loop.

## Non-goals

- No `/today` Drawer MVP or Global Coach implementation.
- No direct DB mutation by LLM output.
- No accept/dismiss/retract automation; users still own proposal decisions.
- No separate `dreaming_proposal` table.
- No hidden refresh of memory brief outside `src/server/memory` ownership.

## Architecture

Dreaming uses the generic DomainTool MCP bridge:

- Server: `buildMcpServerFromRegistry`.
- Allowlist: `resolveMcpAllowedTools('dreaming')`.
- Caller actor: `{ kind: 'agent', ref: 'dreaming' }`.
- Event visibility: DomainTool mirror policy writes `experimental:tool_use` for Dreaming read/propose/write calls.
- Proposal visibility: all proposed user-visible work goes through existing proposal writers/DomainTools and appears in `/inbox`.

## Lane Order

| Lane | Ownership | Files | Acceptance |
|---|---|---|---|
| A. Runtime entrypoint | Dreaming task module | New `src/server/dreaming/*` or equivalent, `src/ai/registry.ts`, `src/ai/task-prompts.ts` | Dreaming can run with the dreaming allowlist and bounded input; no custom one-off write tool. |
| B. pg-boss schedule | Handler registration | `src/server/boss/handlers/dreaming_nightly.ts`, `src/server/boss/handlers.ts`, tests | Queue is registered/scheduled; handler throws on task failure and reports proposal counts. |
| C. Proposal/memory integration | Existing DomainTools/proposals/memory | Tests around proposal inbox and tool-call log | Dreaming-created proposals have `actor_ref='dreaming'`; tool calls mirror where policy says. |
| D. Docs/status closeout | Project docs | status/master roadmap/Wave 4 outcome | Docs say Dreaming is shipped only after evidence exists. |

## Test Commands

Focused during implementation:

```bash
pnpm test src/server/boss/handlers/dreaming_nightly.test.ts
pnpm test src/server/ai/tools/mcp-bridge.test.ts
pnpm test src/server/ai/tools/allowlists.test.ts
pnpm test src/server/proposals/inbox.test.ts
```

Closeout:

```bash
CODEX_FULL_GATE=1 pnpm typecheck
CODEX_FULL_GATE=1 pnpm lint
CODEX_FULL_GATE=1 pnpm test
```

## Stop Conditions

- Need to give Dreaming write powers outside the existing DomainTool/proposal policy.
- Need to create a new proposal table or bypass `/inbox`.
- Runtime credentials or Claude Agent SDK/MCP tooling are unavailable for verification and cannot be stubbed in focused tests.
- Dreaming needs Wave 5 Coach/Drawer product decisions.

## Exit Evidence

- ✅ A handler test proves failures throw rather than silently succeeding.
- ✅ Tool/allowlist tests prove only Dreaming-approved tools are exposed through the MCP bridge.
- ✅ Proposal visibility is exercised through the existing DomainTool/proposal inbox delta path instead of a separate Dreaming table.
- ✅ Linear YUK-114 can be moved to In Review with commit/PR evidence once the branch is published.

## Implementation Evidence

- Added `DreamingTask` to the AI task registry and pass-through prompt surface.
- Added `dreaming_nightly` pg-boss handler/schedule at BJT 03:15.
- Runtime uses `buildMcpServerFromRegistry`, `resolveDomainToolNames('dreaming')`, and `resolveMcpAllowedTools('dreaming')`.
- Handler writes trigger/success/failure experimental events, counts proposal inbox deltas, and rethrows task failure.
- Validation: focused Vitest set, MCP bridge/allowlist regressions, Biome check on touched implementation files, and `git diff --check` passed; full typecheck is environment-blocked by missing local `@tiptap/*` packages.
