# AI pipeline actual acceptance — synthetic gates passed; CI release gate pending

Runtime candidate: `5c2bdcad` (first successful read), `86ff83c8` (journey).
Final missing-case retest: `1e61da8d` (production code unchanged during test/doc-only CI repairs).
Provider/model: Xiaomi / mimo-v2.5-pro. Synthetic knowledge only, private pgvector Testcontainer.
Credential values are never recorded. Direct durable execution is not pg-boss queue E2E.

## Same-input read comparison

Both runs ask query_knowledge for yuwen / actual:classical-root / children / limit 10 and report
the returned names. Generated session IDs differ; the query and seeded knowledge are identical.

| Measurement | Old chain `914a378e` | New `5c2bdcad` |
| --- | --- | --- |
| Known input tokens | at least 57,817 | 28,464 |
| Known output tokens | at least 2,457 | 215 |
| Known reported USD | at least 0.201614 | 0.076271 |
| Outcome | comparator timeout; degraded reply | correct two nodes, sealed exact reply |
| Root / follow-on | root + blind + timed-out comparator | one root, no reviewer task |

Input reduction is at least 50.8%, reported-cost reduction at least 62.2% for this sample only.
Old comparator usage/cost is unavailable: its totals are lower bounds, not complete baseline billing.
This is not a production-wide quality, latency or savings claim.

New root ID: `copilot_task_i1tv4g37pqufzbgvx1mui6al`.
Terminal/reply SHA-256: `4323502dc3a00b512ce7c3fdaebd6d091038a312efa0137656c2a3a04f8362e2`.
Observed successful root tool ID: `call_b0d9d5f6cfa841fb83f8e967`.
Receipt: execution_trace_bound; no factual-entailment attestation.
Artifact: `.tmp/actual-provider-acceptance/1788612800494-a3b56c78-d250-4509-ba57-dffa615eea34.json`.

## Journey evidence

| Case | Observed result |
| --- | --- |
| Cold | correct reply; cold codec; SDK session established |
| Resume | same SDK session; resume codec; exact persisted/delivered bytes |
| Ambient change | same session; changed compiled prompt hash; not a learner-state invalidation test |
| Correction | retest passed: bound prior assistant turn, corrected receipt, transformed reply invalidates SDK cursor |
| Read | actual query and both correct seeded names |
| Proposal | actual proposal only; knowledge IDs/names/parent/version/archive state unchanged |
| Native child | retest passed: one synchronous Agent child succeeded, result returned to root, no continuation |
| Durable | real dispatch + direct handler passed, DONE and persisted reply; not queue E2E |
| Cancel | separate actual route test passed, zero provider attempts |
| Semantic rejection | actual unsafe 17×19=324 candidate rejected by retained real validators; only safe fallback delivered |

Journey artifact: `.tmp/actual-provider-acceptance/1788612942178-5c96f28f-5f78-4ab3-830f-9a6e6d9615e3.json`.
Cancel artifact: `.tmp/actual-provider-acceptance/1788613455779-ab989fc4-9764-4bbb-8e2a-d2bcd678db4a.json`.
All artifacts include exact head, dirty diff/input/output digests, run IDs and reported costs.

## Fixes driven by actual evidence

Two earlier attempts returned correct prose but failed the intermediate model-JSON protocol
($0.103107 + $0.091226). That protocol was removed entirely, not softened into a parallel fallback.
The product now finalizes SDK terminal Markdown and constructs observed trace IDs on the server.

Skill-enabled SDK calls now load only an isolated user config mirror, excluding project/local
developer instructions. A real SDK 0.3.220 initialize-only probe found the intended skill with zero
prompt messages. The final native fix (`87d7b990`, `8eaf6c0d`) guards Agent and Task aliases, forces
contract-managed foreground input/definitions, and disables SDK auto-background only for explicitly
foreground agent definitions. Generic background-capable callers are preserved. Actual retest passed.

## 2026-09-06 missing-case closeout

Versioned exact inputs/outputs/digests/run IDs/usage/receipts:
[`evidence/2026-09-06-pipeline-actual.json`](evidence/2026-09-06-pipeline-actual.json).
Original records retain their historical `phase: running` field; successful process exit and
case assertions establish completion (the harness did not update that cosmetic field).

| Case | Reported USD | Evidence |
| --- | ---: | --- |
| Native child | 0.129296 | one succeeded child, observed Agent + real query, no continuation |
| Cold + correction | 0.028107 | prior-turn binding; receipt corrected; visible/persisted bytes match |
| Durable | 0.014379 | final reply persisted, no foreground SDK cursor |
| Semantic rejection | 0.077014 | QuizVerify, SolutionGenerate, TeachingQuality and SemanticJudge actual attempts |

New campaign total: **$0.248796** of the continued maximum $1 allowance. No further paid runs needed
for these named gates. The negative fixture actually emitted the wrong answer; independent validators
rejected it before presentation. This is one fixture, not a broad factual-accuracy benchmark.
Previous cold/resume/ambient/read/proposal/cancel evidence remains applicable.

## Spend and release boundary

The separately approved $2 campaign has $0.503605 known reported spend, plus an unpriced interrupted
native-child attempt (5,988 observed input tokens, no complete terminal usage/cost). Further paid calls
were stopped; owner subsequently said continue after the request for at most $1 additional.
The continued campaign above reports $0.248796. Combined known new spend is $0.752401, plus the prior
unpriced child. The old baseline also remains incomplete; no unknown cost is counted as zero.

Independent review used its initial + one verification budget, approving core `5c2bdcad` after the
durable false-DONE fix. Root inspected subsequent correction and SDK-compatibility diffs and source
proof; no third independent round was started. Latest root checks: 162 scoped unit, 76 scoped DB,
typecheck and all four build outputs passed. Earlier targeted owner/runner/recovery suites also passed;
overlapping test counts are not summed. Three stale CI tool-retirement assertions were corrected:
33 focused DB tests passed, typecheck/lint/build passed. Exact-head CI remains required.

No production deployment, historical data deletion or legacy drain completion is included.
Whole-project restructuring is now separately authorized, starting with YUK-952; it is not claimed
complete by this pipeline PR. Named actual gates are resolved; merge still requires exact-head CI.

## Tracker handoff draft

Linear workspace/get/save recovered on 2026-09-06; some list calls still intermittently fail transport.
YUK-939 has been updated and YUK-952 created. Search existing mailbox / ToolOperations drain issues first.
If no duplicate exists, use this draft:

- Title: Verify legacy Copilot work is drained before retiring compatibility handlers.
- Project: 领域模型重构 (YUK-203); priority: 3; labels: area:copilot, needs-info.
- Scope: `src/capabilities/copilot/jobs/copilot_subagent_*`, `copilot_continuation`,
  `src/kernel/tools/tool-operations.ts`, historical `copilot_evidence_checkpoint` retention and their
  replay/recovery consumers. Its 16 retired writer fields have explicit schema-audit exceptions with
  owner retention signoff as the removal condition and 2026-10-05 review date.
- Acceptance: after owner-authorized deployment, prove zero nonterminal legacy rows and zero
  queued/active jobs across the maximum deadline/retry window; remove only dead handlers/tests,
  preserving historical reads, schema and migrations. No deployment or deletion before authorization.

The reviewer's stale UI partial-text comments are non-blocking copy hygiene, not a separate nit issue.
