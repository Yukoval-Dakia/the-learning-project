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
2. [complete] Decide and implement capability-owned finalization and eliminate redundant model chains,
   preserving semantic validation where it is genuinely required.
3. [complete] Converge native child execution and explicit durable work; retire overlapping dispatch paths
   only after all live consumers and pending-work compatibility are accounted for.
4. [complete] Consolidate shared attempt execution/catalog ownership and remove obsolete tests/docs.
5. [in progress] Run scoped unit/DB checks, static gates/build, independent review, and actual-provider
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
- Owned generation tools: integrated `51f7c0c8`, corrected to existing owner ports in `e707a753`;
  root verification: 4 files / 85 tests, typecheck, Biome errors-only and capability audit passed.
- Native research: integrated `593d2aea` with both generation denies and legacy-control filtering;
  root verification: 4 files / 28 tests and typecheck passed. Type ownership cleanup `7cd5890d` lowers
  capability-to-server edges to 462; no ratchet was relaxed.
- Actual acceptance script integrated through `fb4e245e`. Two pre-provider setup failures exposed missing
  local Docker socket discovery and missing synthetic conversation bootstrap. Both had zero task-run
  rows/no paid attempts; setup correction is in progress. These are not product success/failure results.
- Bootstrap corrected in `b004b0b5`; isolated real cancel route passed with zero provider attempts.
- Old read-chain actual baseline at `914a378e`: root `copilot_task_ail1c7jlr5vq393tz00p9yty`
  used 34,847 input / 185 output tokens ($0.102252); blind reference `lkxc685zj36514bkcfysjr1e`
  used 22,970 input / 2,272 output tokens ($0.099362). Comparator `vbehvzje16deeysrim6icvk0`
  timed out with unavailable usage/cost. Reply was timeout-degraded. Confirmed total is a lower bound:
  57,817 input / 2,457 output tokens and $0.201614, NOT a complete cost or token total.
  Evidence: isolated acceptance worktree `.tmp/actual-provider-acceptance/1788607564405-9bc922a5-3d0a-44b8-99ed-f81c8e77e015.json`.
- Further paid calls stopped on unknown cost; async owner choice requested for up to $2 additional
  new-chain actual acceptance. Code/static/scoped verification continues; no production deployment.
- Owner explicitly approved up to $2 ADDITIONAL for the new-chain acceptance campaign. The old baseline
  cost remains a lower bound; new test invocations must share that new $2 allowance, not reset it per run.
- Finalization integrated `fe71227b`; root verified 232 + 238 scoped unit tests (disjoint invocations),
  51 durable DB tests, typecheck, lint (exit 0 with existing warnings), build and architecture/census gates.
  Task census is 50 registered / 49 invoked / 1 compatibility; capability-to-server edges are 453.
- New-chain first read at `fe71227b` spent $0.103107 (33,652 input / 343 output); no reviewer calls.
  It is NOT an accepted read: actual model terminal repeated prose before a matching fenced envelope,
  which strict parsing rejected. Narrow deterministic transport correction is in progress.
  New allowance remaining: $1.896893; no unknown costs in this new campaign so far.
  Evidence: `.tmp/actual-provider-acceptance/1788611012778-406b4b3d-d33a-491f-97ff-18c626f00373.json`.
- Independent initial review found one P1: durable unsealed terminal was marked DONE. Fix/one verification
  round pending. P2 UI partial-text comment drift is non-blocking and remains outside this backend scope.
- `5eb1cdc6` fixes durable FAILED and narrow terminal wrappers, but a second actual read returned correct
  plain prose without JSON. Cost $0.091226; cumulative new spend $0.194333, remaining $1.805667.
  Evidence: `.tmp/actual-provider-acceptance/1788611872008-684d1dc4-7d19-401a-9fc0-b026b1509d9a.json`.
  Root accepted architecture reassessment: explicit terminal Markdown, server-observed trace IDs and
  execution_trace_bound assurance replace the fragile model envelope (not a raw-text fallback).
  Skill-enabled SDK calls were isolated to user-only settings in `d09a1557`; zero-prompt SDK init preserved skills.
- Successful actual read `5c2bdcad`: 28,464 input / 215 output / $0.076271; sample input reduction >=50.8%,
  cost reduction >=62.2% against the old lower bound. Full evidence and limitations are in
  `2026-09-05-ai-pipeline-actual-acceptance.md`.
- Whole journey passed cold/resume/ambient/read/proposal, but correction clarified rather than completed
  and native SDK returned asynchronously. Correction field types/acceptance tightened in `12f77867`.
  Agent/Task aliases + explicit synchronous policy fixed in `87d7b990` / `8eaf6c0d`; free checks passed.
  Known new spend $0.503605 plus unpriced interrupted child. Paid tests stopped; owner extra-$1 choice pending.
- Draft PR #1326 is open; exact-head GitHub CI is the full test authority. No merge/deploy while actual correction/native/durable/
  semantic gates remain. Two-round review budget is exhausted; root inspected the subsequent SDK fix.
- CI integration fixes: historical checkpoint fields explicitly classified with retention-review expiry;
  the actual harness moved to `tests/acceptance/ai-pipeline.ts` (not server configuration), and Agency's
  migrated-tool contract check now accounts for its new generation tool. Focused regressions and zero-paid
  Testcontainers preflight passed; server schema/production audit coverage was not weakened.
