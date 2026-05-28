# Wave 3 Ready-to-Launch — DomainTool Propose/Write Tools

> 状态：ready-to-launch draft as of 2026-05-28。Wave 2 已通过 PR #169 merge 到 `main`；Wave 3 的目标是集中 ship T-D4，完成 DomainTool proposal/action surface，为 Wave 4 的 T-DR // YUK-88 P3 并行扫清 registry conflict。

## Source of truth

- `docs/superpowers/status.md` 当前 Phase 行：Wave 2 implementation complete，下一站为 Wave 3 DomainTool propose tools / YUK-88 P3+P4 准备。
- `docs/superpowers/plans/2026-05-27-master-roadmap.md` §5.1 Wave 3：T-D4 propose/write tools full + T-PD gap filler。
- `docs/superpowers/specs/2026-05-17-agent-context-tools-design.md` §Knowledge Graph Proposal Tools、§Non-Graph Proposal And Action Tools、§Task Allowlist Defaults、§Engineering Sequence step 6。
- `docs/superpowers/plans/2026-05-28-td4-propose-write-tools-driver.md`：T-D4 lane driver。
- Linear milestone：Foundation D — Copilot Orchestrator + DomainTool Registry / `M4 — DomainTool propose/write tools full coverage`。

## Preflight state

| Item | State | Evidence / action |
|---|---|---|
| `origin/main` | ✅ current enough for Wave 3 prep | `709152e6` = PR #169 "Wave 2: block tree schema, editor, and read tools" merged 2026-05-27 23:58Z. |
| Local main checkout | ⚠️ dirty / behind | Main worktree has unrelated local planning docs. Do not launch Wave 3 lanes there; use clean worktrees from `origin/main`. |
| Wave 2 | ✅ implementation complete | YUK-91 / YUK-92 / YUK-102 merged through PR #169. |
| YUK-101 outbox follow-up | ✅ Done | Linear YUK-101 completed; PR #168 / commit `72d77555` in `origin/main`. Older roadmap text claiming it is open was stale and is corrected by this prep. |
| T-D4 Linear | ✅ prepared | Parent YUK-107, sub-issues YUK-108 through YUK-112, milestone M4 target 2026-07-02. |
| T-D4 code | ⬜ not started | No proposal/action tools beyond existing M1/M2 read-tool surface. |

## Wave 3 scope

| Lane | Linear | Branch intent | Worktree | Driver |
|---|---|---|---|---|
| T-D4/A graph proposal tools | YUK-108 | `yuk-108-td4-graph-proposal-tools` | `/private/tmp/tlp-wave3-yuk108` | `2026-05-28-td4-propose-write-tools-driver.md` |
| T-D4/B mistake attribution + variant tools | YUK-109 | `yuk-109-td4-mistake-action-tools` | `/private/tmp/tlp-wave3-yuk109` | same |
| T-D4/C learning item proposal tools | YUK-110 | `yuk-110-td4-learning-item-proposals` | `/private/tmp/tlp-wave3-yuk110` | same |
| T-D4/D record link + promotion proposal tools | YUK-111 | `yuk-111-td4-record-proposal-tools` | `/private/tmp/tlp-wave3-yuk111` | same |
| T-D4/E closeout policies/docs/gate | YUK-112 | `yuk-112-td4-closeout` | `/private/tmp/tlp-wave3-yuk112` | same |

## Chain order

1. Start from `origin/main` and re-check no newer Wave 2 follow-up PR is open.
2. Run YUK-108 first. It establishes the proposal-event writer pattern for T-D4.
3. Run YUK-109, YUK-110, and YUK-111 after YUK-108 lands. Prefer sequential chain-merge if they touch shared `src/server/ai/tools/bootstrap.ts`, registry tests, or proposal event helpers.
4. Run YUK-112 last. It owns allowlist/doc/status closeout and the full Wave gate.
5. Do not start T-DR or YUK-88 P3 against the same tool/AI registry files until T-D4 has chain-merged; Wave 3 intentionally freezes registry churn before Wave 4.

## Wave gate

Before declaring Wave 3 complete:

```bash
CODEX_FULL_GATE=1 pnpm typecheck
CODEX_FULL_GATE=1 pnpm lint
CODEX_FULL_GATE=1 pnpm audit:schema
CODEX_FULL_GATE=1 pnpm audit:partition
CODEX_FULL_GATE=1 pnpm audit:profile
CODEX_FULL_GATE=1 pnpm test
CODEX_FULL_GATE=1 pnpm build
```

Then run `/audit-drift` or the current equivalent drift scan, update `docs/superpowers/status.md`, refresh `docs/superpowers/plans/2026-05-27-master-roadmap.md`, and reconcile Linear states.

## Human decision points

- Full 8-tool scope is intentional. The roadmap Q6.a says T-D4 full 8 propose tools stays in Scenario A; do not trim to only `propose_knowledge_edge` / `propose_knowledge_mutation`.
- `docs/superpowers/specs/2026-05-17-agent-context-tools-design.md` still asks whether Copilot should get `propose_knowledge_mutation`. Default for Wave 3: Copilot gets `propose_knowledge_edge` only; mutation tools stay Maintenance / KnowledgeReview unless the user explicitly changes that policy.
- If a target owner service is missing, implement the thinnest owner-bound proposal/event wrapper required by the spec. Do not let an LLM tool perform hidden direct DB mutation as a shortcut.

## Ready lane state

| Lane | Status | Blocked by | Notes |
|---|---|---|---|
| YUK-108 | ready | none | Establishes proposal-event pattern. |
| YUK-109 | ready after YUK-108 pattern | YUK-108 preferred | Reuses attribution / variant generation owners. |
| YUK-110 | ready after YUK-108 pattern | YUK-108 preferred | Proposal-only LearningItem transitions. |
| YUK-111 | ready after YUK-108 pattern | YUK-108 preferred | Proposal-only record link / promotion path. |
| YUK-112 | blocked | YUK-108 / YUK-109 / YUK-110 / YUK-111 | Closeout, docs, and full gate only. |
