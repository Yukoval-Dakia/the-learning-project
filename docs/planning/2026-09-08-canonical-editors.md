# YUK983 — Canonical editors

1. Extend existing deployment preparation to Artifact/QuestionBlock, rejecting
   incomplete histories, dangling index anchors and symmetric drift atomically.
2. Remove the two direct-write fallback branches and flags. Preserve row locks,
   version conflicts, event history, backlinks, and genuine retraction semantics.
3. Scoped DB migration/edit/concurrency/revert gates, typecheck/lint/build,
   independent review and exact-head CI. Then fresh backup/clone verification and
   authorized Mac-local deployment with writers stopped. No paid call or UI change.

Status: implementation in progress; no deployment or completion claim.

The initial independent review found two P1 gaps: merge/figure editor bypasses,
and absent secondary blocks omitted by the migration's live-only scan. Both were
fixed; the one verification review passes. All six structured edit operations now
use event-first projection writes; missing bases abort before publishing any event.
The migration checks payload-only secondary IDs, not merely event subject IDs.

PR1368 implementation5dd7e8ed merged main's documentation conflicts as841a7605;
both have exact tree `eee7f54fe4a2baf6089c55896fc46066cd0d440b`. CI34220204444
is running (static/migration/build/usability green, unit/DB pending), not delivered.
Final scoped follow-up:18 migration DB,9 oracle DB and61 unit pass. Image
`the-learning-project-app:5dd7e8ed` SHA
`210f719ac543392b483b9886a5d3e704b26ab96ebe1b74819766ca6343b73909`
also passes migration on the restored clone,7 LearningItems/8 artifacts/zero new
anchors. Production remains appf707ca5c/worker8bce5f0a until CI permits cutover.

Five scoped DB suites pass68 cases (migration, editor parity/concurrency, Notes
route, Ingestion edit/structure tools); verifier independently passes5 structure
cases. Typecheck/lint/build, strict fold writers and architecture audits pass.
Dependency ratchet tightens435→433 because the two business flag imports vanish,
not because of a new allowlist. Existing named lifecycle/create row writers remain
event-native and are not claimed to have been migrated to projection-only execution.
The oracle's old three-kind expectation is being updated to the five canonical
kinds; knowledge/edge remain switchable and calibration remains anchor-only.

Fresh production snapshot:8 artifacts/0 question blocks/454 events, empty queue.
Actual restore `loom_before_983_verify` passes the bundled new migration:7 existing
LearningItems and8 artifacts checked, zero new anchors or trait/schema changes.
Private dump SHA256 `c955544d87d4e4985287ef060c748908115e8d30eb4e743f09fdd652d429fefa`;
migration bundle SHA256 `de89f69b23ea6accbb2f03c37ba42a4baa434ae813b568b000029a3e5a80fc61`.
The first container used the wrong network and was stopped before DB access.
The next clone run caught a migration false positive: an unaccepted learning-intent
proposal has an artifact subject ID but has never created artifact state. Root
fixed classification using the artifact reducer's shared state-action set, added
a focused regression, and reran the clone successfully. No snapshot over missing
history, no live rebuild, no production writes and no paid call. Review budget
is exhausted (initial + verification); this final bounded correction is root-verified.
