# YUK-741 misconception-recurrence batch audit

> Date: 2026-07-31
> Base: `origin/main@4f18044b`
> Scope: read-path batching and enablement evidence only.
> Runtime decision: `MISCONCEPTION_RECURRENCE_ENABLED` remains `false`.

## 1. Consumer and query-shape census

`misconceptionRecurrence` has one producer boundary and one semantic consumer. Three request paths
call the shared producer:

| Request path | Producer call | What consumes the value | Pre-YUK-741 recurrence shape |
| --- | --- | --- | --- |
| Daily/recomposed non-due stream | `composeSoftmaxStream → collectCandidateSignals` | `selection-orchestrator.ts::projectCandidate` buckets it into the LLM advisory prompt; the signal snapshot is also persisted with selected stream rows | one aggregate per question candidate, serially |
| Post-answer re-rank | `reRankAfterAnswer → collectCandidateSignals` | persisted signal/selection-observation snapshot only; statistical re-rank still weights by information score | one aggregate per eligible question candidate, serially |
| Placement selection | `selectNextPlacementItem → collectCandidateSignals` | placement still chooses by information score; recurrence is not a ranking key | one aggregate per candidate, up to the 200-row placement cap |

There is no profile reader and no second recurrence implementation. The scalar's only direct
runtime read is `selection-orchestrator.ts::projectCandidate`; it never enters mastery, p(L), FSRS,
or deterministic recall routing.

Before this change, each flag-on candidate ran:

1. `question.knowledge_ids @> [kc]` OR predicates for that candidate;
2. `mistake_variant JOIN question`;
3. `status='active'`, non-null `cause_category` filtering;
4. `GROUP BY cause_category`, then `MAX(count)`.

YUK-741 replaces only that N+1 portion. One request now performs one `@>` query over the union of
all candidate KCs, grouped by `(parent question, cause category)`. An in-memory reverse index maps
each grouped evidence row back to every intersecting candidate KC set and then applies the same
per-cause sum and maximum. The query keeps the `question.id → knowledge_ids → cause_category`
linkage. A question matching two KCs in one candidate is routed through a `Set` and counted once,
preserving the old boolean-OR semantics rather than duplicating evidence via an unnest join.

## 2. Frozen equivalence and query budget

`candidate-signals.db.test.ts` keeps the pre-YUK-741 SQL as a test-only reference and compares it
with the batch boundary on frozen fixtures covering:

- overlapping multi-KC questions (the same evidence must count once);
- reordered and duplicate candidate KCs;
- distinct cause families and MAX-not-SUM behavior;
- unrelated KCs, null cause, draft/dismissed/broken rows;
- empty, sparse, no-data, duplicate-set, and 200-candidate high-cardinality inputs;
- mixed request wiring and the flag-off no-query path.

The deterministic budget is:

| Input | Recurrence aggregate queries |
| --- | ---: |
| empty or all-empty KC sets | 0 |
| any non-empty request/job batch | 1 |
| flag OFF | 0 |

The regression test compares total `collectCandidateSignals` selects with the flag OFF and ON; ON
must add exactly one select for a 12-candidate request. A separate 200-candidate boundary test pins
the aggregate itself to one select and checks all 200 aligned results.

## 3. Representative latency evidence

One local Testcontainers/Postgres run on 2026-07-31 used 200 candidate KCs, 200 parent questions,
and 200 active mistake rows. The production-old reference was executed serially, matching the old
`for ... await` request shape; then the batch boundary was executed against the same warm database.

| Path | Queries | Observed wall time |
| --- | ---: | ---: |
| frozen per-candidate reference | 200 | 1091.65 ms |
| YUK-741 batch | 1 | 6.44 ms |

This is a representative engineering sample, not a production SLO or statistically stable
benchmark. It demonstrates direction and order of magnitude only; correctness and the one-query
budget are the CI-enforced gates.

## 4. Explicit flag go/no-go gate

The flag stays OFF in this change. A later, flag-only rollout is **GO** only when all rows below have
fresh evidence; otherwise it is **NO-GO**.

| Gate | GO evidence | Current verdict |
| --- | --- | --- |
| Batch correctness | exact-head GitHub `CI Gate` green; frozen-reference equivalence, empty/sparse/high-cardinality, provenance-overlap, and query-budget tests pass | pending this PR's exact-head CI |
| Prod-like latency | at least 30 warm runs at the 200-candidate bound: recurrence query count remains 1, batch p95 is below serial-reference p50, and whole-request p95 regresses no more than 10% versus flag-OFF | local directional sample only; **NO-GO** |
| Judge health | contrastive (not same-lane) calibration headline and every route feeding these mistakes report `status='ok'`; bit agreement is at least 80%; recent runs have zero errors | not established for this rollout; **NO-GO** |
| Cause-label data calibration | owner-blind review of at least 20 recent `status='active'` mistake rows covering every enabled subject: primary `cause_category` grounded at least 80%, false-confirmed/dropped-evidence redlines = 0 | not collected; **NO-GO** |
| Owner decision and rollback | owner records explicit GO after reviewing the above; enablement occurs in a separate flag-only PR/canary, with immediate revert on any redline or latency gate failure | not granted; **NO-GO** |

The 80%/zero-redline shape follows the repository's existing grounding release boundary. Judge
agreement is necessary but not sufficient: agreement is not accuracy, and the recurrence reader
consumes `cause_category`, so the owner-blind cause-label sample is an independent required gate.
