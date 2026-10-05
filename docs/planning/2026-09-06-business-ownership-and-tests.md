# Business ownership and test simplification

Owner authorized implementation on 2026-09-06 based on the architecture report at `1e61da8d`.
This extends, not replaces, the AI pipeline completion. Production operations are not authorized.

## Acceptance, not proxies

For ingestion completion, judging completion, knowledge merge and a Copilot turn, record:
the public business command, the single owner of each rule, transaction/recovery owner, and a
behavior test proving rollback/retry/cancellation. File moves, SCC counts and passing audits
are supporting checks, not completion. Deterministic learning features and semantic validation stay.

## Ordered implementation

1. **AI pipeline closeout**: same-input read, native child completion, bound correction, durable
   settlement, unsafe-learning-content rejection and cancellation. Named synthetic gates passed
   at `1e61da8d`; `7d456998` fixes stale retired-tool tests. PR #1326 merged as `dda46441`
   after exact-head CI; Goal PR #1327 merged as `8a1b06d1` after exact-head CI and independent review.
2. **Goal — YUK-952**: one typed mutation command owns lock/read/event/materialization/parity.
   Creation callers must not construct both genesis snapshots and row state. Historical no-anchor
   compatibility remains inside the owner, never as repeated business-entry branches. Demonstrate
   concurrent writes preserve both events and versions, and failures roll back event + row together.
3. **Knowledge merge — YUK-953**: Practice/Agency/state owners implement attribution transitions;
   Knowledge owns the atomic merge transaction and receipt. Keep one rich nine-surface integration
   test, owner-specific collision/idempotence tests and append-only history. No generic event bus.
   Resolve ingestion → knowledge → ingestion naming into one-direction dependency and one actual
   implementation; provider failure must still preserve draft/review instead of auto-enrolling.
4. **Ingestion/judging completion — YUK-955/YUK-956**: inspect real completion and recovery consumers, encapsulate
   duplicated completion rules at the existing behavior owner. Preserve source snapshots, late
   arrival fences, version checks and interrupted-worker recovery. Do not create an inert framework.
5. **Copilot execution owner**: root chat and durable worker choose lifecycle; one internal service
   owns shared learning-content validation, tool correlation/permissions, trace finalization and
   nested cancellation. Its input is business intent and lifecycle policy, not another SDK Options bag.
6. **Product state**: backend explicitly reports whether the active mode continues/ends. Frontend
   and durable transport share message projection. No visual/layout change. UI file preflight was
   sent to owner; no UI code until approved.
7. **Cross-project tests**: replace retired implementation assertions rather than layer new tests.
   Keep one source of contract inventory and real loader/behavior verification. Preserve security,
   accounting, concurrency, recovery, provenance and genuinely distinct parser edge cases.

## First test-deletion proof

| Removed assertion | Retained evidence |
| --- | --- |
| Copilot worker old/new file locations and import spelling | capability-boundary/deepening audit; worker and reconcile DB behavior suites; heartbeat/singleton declaration contract |
| Ingestion worker file locations and central-book string absence | central registration audit; OCR/auto-enroll handler tests; exact metadata declarations |
| Runner entire SDK Options key list | structured-output/fallback/turn-limit tests; settings isolation/title test; cancellation and settlement tests |

Do not collapse distinct test scenarios merely to report fewer test cases. No entire behavior suite
has been deleted by this batch. Further retirement follows the replacement owner's interface tests.

## State-authority boundary

### Knowledge merge implementation evidence

- Knowledge retains the merge transaction and audit receipt; Practice owns question/item attribution
  (including post-accept item parity), Agency owns scope attribution, and misconception edges own
  collision handling. Ordered row locks prevent rewriting stale arrays. No-version-bump attribution
  semantics and historical repair idempotence stay unchanged.
- One rich late-owner-failure test proves earlier question/item/goal/mastery writes all roll back;
  the existing nine-surface/collision/tombstone/backfill suites remain. The combined focused DB
  run passed 182 cases; prior merge/state/backfill run passed 90.
- Ingestion supplies the naming adapter; Knowledge no longer imports Ingestion at runtime.
  The adapter preserves the old pinned registry subject, fallback ID, exact question and caller
  context; four unit cases prove one call and fail-closed malformed/cross-subject output.
- Retention reads return a semantic map from the FSRS owner, not raw card rows interpreted by
  Knowledge. Missing cards remain unknown, not zero. Shared scheduler math is unchanged.
- Variant verification now uses its existing entity projection gateway instead of assembling
  three generic projection imports. Ratchets tighten to 444/0/47; no threshold is raised.
  The five-capability SCC still exists: this is not claimed as elimination of all command cycles.

Repo flags/configuration do not establish live production settings or data readiness. The final
removal of per-entity migration switches needs an authorized production clone, backfill/audit/rebuild
and retained-golden survival evidence. Until then, centralized legacy compatibility is a named
residual, not an excuse to keep duplicated business rules. No runtime flag switch or implicit genesis
backfill is part of these code refactors.

## Delivery

Isolated branches/worktrees for concurrent writers; root inspects every diff. Scoped unit/DB tests,
typecheck, lint, build and one independent review (+ one P0/P1 verification if needed) per PR;
exact-head GitHub CI is the full-test gate. Merge only after green. No production deployment,
historical deletion or drain-handler retirement is implied. Linear and PLAN reflect actual status.
