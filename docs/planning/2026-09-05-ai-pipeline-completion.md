# AI pipeline completion — execution plan

Owner instruction: finish the AI pipeline refactor before discussing whole-project structure.
Base: main `090e882c` (foreground turn-context slice, PR #1324 / YUK-939).

## Outcome and constraints

- Lower repeated model/context cost; capability-owned execution with advanced native agents.
- Preserve deterministic learning features, propose/accept permissions, cancellation, attempt/cost audit,
  and explicit durable work. Do not deploy or delete production data.
- Keep public UI contracts compatible; whole-project layout optimization is deferred.
- Replace tests of retired implementation with meaningful interface scenarios, not a parallel test layer.
- Linear capture attempted: installed connector returns `Unknown tool`; repository records remain the
  temporary handoff, not a claim of tracker synchronization.

## Active plan

1. [complete] Trace current evidence finalization, native/durable execution, and live legacy consumers.
2. [in progress] Decide and implement capability-owned finalization and eliminate redundant model chains,
   preserving semantic validation where it is genuinely required.
3. [in progress] Converge native child execution and explicit durable work; retire overlapping dispatch paths
   only after all live consumers and pending-work compatibility are accounted for.
4. [in progress] Consolidate shared attempt execution/catalog ownership and remove obsolete tests/docs.
5. [pending] Run scoped unit/DB checks, static gates/build, independent review, and actual-provider
   acceptance with revision/input/output/task-run/provider/model/token/cost evidence.
6. [pending] Commit, push, exact-head CI, merge if green; synchronize board/handoff and retry tracker
   capture if the installed connector becomes callable. Report production and measurement boundaries.

## Evidence

- No completion or token-reduction claims yet for this phase.
- Original main checkout has unrelated user changes; all implementation uses an isolated worktree.
- Attempt core: integrated `d286dcbd` from isolated `a6886a4f`; source diff inspected by root.
  Four focused runner files: 88 tests passed; typecheck and Biome passed. One SDK consumption loop now
  serves the three existing public entry points, preserving their separate settlement policies.
- Baseline context/native guard check: 3 files / 14 tests passed.
- Finalization decision: `2026-09-05-pipeline-finalization-design.md`. Structural provenance is explicitly
  not independent semantic truth; dedicated generated-learning-content validators stay.
- Historical mailbox/operation recovery is a compatibility obligation, not an active second execution
  architecture. Removal of drain handlers requires deployed zero-pending evidence; no deployment assumed.
