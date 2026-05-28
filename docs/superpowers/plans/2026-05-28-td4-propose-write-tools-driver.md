# T-D4 — DomainTool Propose/Write Tools Driver

> Driver doc for Wave 3. T-D4 completes the DomainTool proposal/action surface after M2 read tools are merged, while keeping all real domain mutations behind existing owner services and accept routes.

## Context

**Project**: Foundation D — Copilot Orchestrator + DomainTool Registry
**Milestone**: M4 — DomainTool propose/write tools full coverage
**Parent issue**: YUK-107
**Depends on**: YUK-102 / PR #169 (M2 read tools)
**Wave doc**: `docs/superpowers/plans/2026-05-28-wave3-ready-to-launch.md`

Source contracts:

- `docs/superpowers/specs/2026-05-17-agent-context-tools-design.md` §Knowledge Graph Proposal Tools
- `docs/superpowers/specs/2026-05-17-agent-context-tools-design.md` §Non-Graph Proposal And Action Tools
- `docs/superpowers/specs/2026-05-17-agent-context-tools-design.md` §Task Allowlist Defaults
- `docs/superpowers/specs/2026-05-17-agent-context-tools-design.md` §Engineering Sequence step 6
- `src/server/ai/tools/types.ts`
- `src/server/ai/tools/registry.ts`
- `src/server/ai/tools/bootstrap.ts`

## Tool inventory

| Tool | Lane | Effect | Primary owner rule | Default allowlist |
|---|---|---|---|---|
| `propose_knowledge_edge` | YUK-108 | propose | Write proposal event; do not insert `knowledge_edge`. | KnowledgeReview, Maintenance; Copilot edge-only when user-visible. |
| `propose_knowledge_mutation` | YUK-108 | propose | Proposal-only tree maintenance; accept route owns real mutation. | KnowledgeReview, Maintenance. |
| `attribute_mistake` | YUK-109 | write | Run existing attribution path; append judge event only when valid. | Copilot only on user suggestion. |
| `propose_variant` | YUK-109 | write/propose | Reuse variant generation owner; cap MVP count at 1. | Copilot only on user suggestion. |
| `propose_learning_item_completion` | YUK-110 | propose | Proposal-only; accept route creates completion evidence and guarded transition. | Dreaming, Coach, Maintenance. |
| `propose_learning_item_relearn` | YUK-110 | propose | Proposal-only transition suggestion. | Dreaming, Coach, Maintenance. |
| `propose_record_links` | YUK-111 | propose | Proposal-only links from LearningRecord to domain targets. | Dreaming, Maintenance. |
| `propose_record_promotion` | YUK-111 | propose | Proposal-only stronger learning object draft. | Dreaming, Maintenance. |

## Invariants

- Every tool has zod input/output schemas, `summarize()` output under roughly 120 chars, and registry/bootstrap coverage.
- `effect` is `propose` unless the existing domain model already treats the operation as an append-only evidence write (`attribute_mistake`, current variant draft generation). If in doubt, choose `propose`.
- Tools must not directly perform destructive graph, record, artifact, or LearningItem mutation. They either write proposal events or call an existing owner service with its own idempotency and validation rules.
- All tool calls write `tool_call_log`; mirror `experimental:tool_use` only when user-visible, causal for a proposal/write, part of a displayed Dreaming/Maintenance trace, or failure drives a corrective chip.
- Tool allowlists stay narrow. Do not broaden Copilot from `propose_knowledge_edge` to structural mutation without an explicit product decision.
- Keep external filesystem/network/MCP tools out of the learning runtime.

## Lane A — YUK-108 graph proposal tools

Implement:

- `propose_knowledge_edge`
- `propose_knowledge_mutation`

Acceptance:

- Validate node existence, same-subject boundary, self-edge rejection, duplicate live-edge rejection, and parent-edge semantic duplication for `propose_knowledge_edge`.
- `propose_knowledge_edge` writes `event(action='propose', subject_kind='knowledge_edge', actor_kind='agent')` or the current proposal payload equivalent; `related_to` and `contrasts_with` dedupe both directions for live and pending edges.
- `propose_knowledge_mutation` accepts `propose_new | reparent | merge | split | archive` and writes proposal-only payloads; `merge.from_ids` must all have `expected_versions` entries before a proposal is written.
- Registry tests prove both tools register and summarize.
- Allowed for Maintenance / KnowledgeReview; Copilot gets edge proposals only unless the open policy question is resolved.

Validation:

```bash
pnpm exec vitest run src/server/ai/tools/registry.test.ts src/server/ai/tools/*proposal*.test.ts
pnpm exec vitest run src/server/ai/tools/proposal-tools.test.ts
pnpm exec vitest run src/server/ai/tools/mcp-bridge.test.ts
```

## Lane B — YUK-109 mistake attribution and variant tools

Implement:

- `attribute_mistake`
- `propose_variant`

Acceptance:

- `attribute_mistake` rejects non-failure attempts, skips when an active judge already exists, invokes the existing attribution path, and writes through the event owner path; if owner-path idempotency observes a concurrent judge, the tool reports `skipped:existing_judge`, not `written`.
- The tool never accepts `cause` from the calling agent; the LLM cannot smuggle its own attribution into storage.
- `propose_variant` reuses existing variant generation rules, caps count at 1, respects non-targetable causes, max depth, and "already has variant" guards.
- User-authored cause remains preferred in reader tools.
- Tool-call logs and mirrored traces are covered where user-visible.

Validation:

```bash
pnpm exec vitest run src/server/ai/tools/*mistake*.test.ts src/server/ai/tools/*variant*.test.ts
pnpm exec vitest run src/server/ai/tools/proposal-tools.test.ts
pnpm exec vitest run src/server/boss/handlers/variant_gen.test.ts src/server/boss/handlers/variant_verify.test.ts
```

## Lane C — YUK-110 learning item proposal tools

Implement:

- `propose_learning_item_completion`
- `propose_learning_item_relearn`

Acceptance:

- Completion proposal records `triggering_signals`, evidence event ids, and reasoning without changing `learning_item.status`.
- Accept route remains the only path that creates `completion_evidence(path='ai_propose')` and performs the optimistic-lock status transition.
- Relearn proposal handles `resting | done -> in_progress` as a proposal only.
- Dismiss/cooldown signal prevents immediate repeat proposal.
- Invalid/stale item states are tested.

Validation:

```bash
pnpm exec vitest run src/server/ai/tools/*learning*.test.ts app/api/learning-items/[id]/route.test.ts
pnpm exec vitest run app/api/proposals/[id]/accept/route.test.ts src/server/proposals/actions.test.ts
```

## Lane D — YUK-111 record link and promotion proposal tools

Implement:

- `propose_record_links`
- `propose_record_promotion`

Acceptance:

- `propose_record_links` validates target kinds (`knowledge`, `question`, `learning_item`, `artifact`) and bounded confidence/reasoning payloads.
- `propose_record_promotion` supports `question`, `learning_item`, and `artifact` targets as proposal drafts only.
- Accept routes / owner services validate the source `record_id`, perform actual record link updates or object creation, and write the proposal rate/signal.
- Tests cover invalid targets, duplicate proposal behavior, summary output, and event/proposal payload shape.

Validation:

```bash
pnpm exec vitest run src/server/ai/tools/*record*.test.ts
pnpm exec vitest run src/server/proposals/actions.test.ts app/api/proposals/[id]/accept/route.test.ts
```

## Lane E — YUK-112 closeout

Closeout only after YUK-108 through YUK-111 merge. PR #170 implements all four code lanes in one focused worktree, then applies the closeout lane in the same PR.

Acceptance:

- Registry/bootstrap tests prove all 8 T-D4 tools exist.
- Allowlist policy matches the spec task/surface matrix.
- `docs/superpowers/status.md` and `docs/superpowers/plans/2026-05-27-master-roadmap.md` reflect T-D4 shipped.
- `/audit-drift` or equivalent drift scan has no new T-D4 finding.
- Full Wave gate passes.

Validation:

```bash
CODEX_FULL_GATE=1 pnpm typecheck
CODEX_FULL_GATE=1 pnpm lint
CODEX_FULL_GATE=1 pnpm audit:schema
CODEX_FULL_GATE=1 pnpm audit:partition
CODEX_FULL_GATE=1 pnpm audit:profile
CODEX_FULL_GATE=1 pnpm test
CODEX_FULL_GATE=1 pnpm build
```

Closeout evidence as of 2026-05-28:

- Registry/bootstrap: `src/server/ai/tools/proposal-tools.test.ts` proves all 8 T-D4 tools register; `src/server/ai/tools/bootstrap.ts` exposes them with the M1/M2 read tools.
- Allowlist policy: `src/server/ai/tools/allowlists.ts` pins KnowledgeReview, Copilot, Copilot user-suggested mistake action, Dreaming, Coach, and Maintenance surfaces; `allowlists.test.ts` keeps Copilot narrower than Maintenance.
- Proposal lifecycle: `src/core/schema/proposal.ts`, `/inbox`, and `/today` know `record_links` and `record_promotion`; proposal writer/inbox/accept regressions cover the expanded union.
- Drift scan equivalent: status and roadmap now point to PR #170 as Wave 3 T-D4 ship outcome and keep Wave 4 as the next registry consumer.

## Notes for implementation agents

- Work in the lane worktree only. Do not touch the main checkout.
- Do not start from stale `main`; always branch from latest `origin/main`.
- If a proposed validation command has no matching test file yet, create the focused test next to the tool implementation instead of weakening the acceptance.
- Commit with `Closes YUK-<lane>` and include `Part of YUK-107`.
