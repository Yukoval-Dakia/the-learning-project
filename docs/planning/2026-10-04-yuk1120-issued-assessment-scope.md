# YUK-1120: issued-scope scoring and settlement

Base: main0ab54920 after #1556 merge; branch fix/yuk-1120-issued-assessment-scope. One implementation line.

## Problem and behavior
Core evaluates only units whose answer/evidence slots are issued, but consumers divide by the complete revision maximum. Frozen issued p1 worth1 correct receives1/4 rather than1/1; weighted2/17 instead of2/2. Settlement also schedules KC cards unique to unissued physical parts. Real Postgres probe reproduces incorrect rating/card write plus effective/original projection errors. Baseline69unit/40DB passes, four new semantic assertionsRED.

## Implementation boundaries
- Reuse existing core scope semantics, export a pure projection in core/schema/assessment/evaluation.ts. Filter all answer+evidence refs, exclude table layout slots, retain group-only units under existing semantics. Unknown/empty issuance must not silently become full scope. Preserve sum/weighted; capped/threshold subset remains fail-closed; full units retain original basis without mutation.
- evaluateSubmission returns scoped basis on normal/conflict replay branches; core and return must share same projection. No changes to immutable revision/response/evaluation rows or cost/model execution.
- kernel/read-models/assessment-verdict loads frozen revision response/structure and issuance in bounded batches, projects each submission's basis. Missing/mismatched/unprojectable scope must return honest unsupported (or explicit contract refusal), never whole-basis fallback. Effective and original use their own submission coordinates.
- server/assessment/settle uses input.issuance already supplied/validated under activation locks. Load only issued physical part rows; virtual/no-local-tag fallback retains group KC semantics. Group-only evidence keeps documented localization. Full issuance retains current scope semantics. New settlement scope version; old replay_inputs stay frozen on ordinary replay. No historical production repair in this PR.
- Correct invalid part_ids=[] fixtures to actual published parts; empty issuance is not legacy shorthand.

## Validation matrix
- Pure projection: sum, weighted; all-full, zero/wrong, partial score; omitted vs explicit all; evidence-only refs and cross-part unit exclusion; group-only unit; table slots; zero/unknown parts; no mutation; capped/threshold guard and full-scope preservation.
- Persisted seam: 2-part revision, only first part issued, nontrivial full maxima/weights; scoped unit IDs and JudgeResult correct1; all-issued remains partial1/4; repeat/new attempt retainsscope; protected replay return uses same basis.
- Read model: effective/original both correct for subset; different frozen issuance in groups cannot reuse basis cache by revision alone; missing/invalid scope unavailable rather than grade.
- Settlement: real published physical group distinctKC; only p1 answer correct => good onKC_a, KC_b absent, one theta/global observation; full/mixed unchanged. Virtual/group-tag fallback coverage. Regrade preserves occurrence count. Frozen v1 replay remainsv1; new scopev2 persisted.
- Scope unit/DB; typecheck/lint/build/10audits; independent frozen initial review; exacthead CI;17minwindow.

No UI/API/schema/dependency/prod/paid operation. Historical scope repair remains separate, not silently performed.

## Author validation

- Existing69unit/40DB baseline PASS. Formal downstream regressions:3fail/27pass before runtime change (sum subset, weighted subset, settlement subset); readonly probe also reproduced effective/original errors.
- Final scoped76unit/50DB, typecheck, lint299 unchanged, build and ten local audits PASS. Capability baseline450/0/48 unchanged. Independent initial review PASS:61unit/50DB, no P0/P1 or substantive P2; frozen patch049a9205025edd6928997a59616299f09103f5327ccac7783ff487183c7f49f7 plus whitespace-only fixture formatting.
- Shared projection returned by both automatic/manual core and normal/conflict-replay persistence paths; read model batches frozen issuance/revision and caches by submission. Missing/invalid scope reports unsupported/issuance_scope_unavailable.
- New settlement scope version2; partial physical parts use local tags (root union does not leak unissued labels), virtual/untagged parts and true group-evidence units retain documented root fallback. Full issuance preserves previous virtual-part/anchor mapping. Old v1 replay_inputs kept unchanged.
- Fixture corrections: affected solo issuances now contain published qid instead of invalid empty list; a negative fixture attempted frozen-binding UPDATE and was correctly rejected, then rewritten to seed invalid stored records at INSERT without weakening guards.
- SQL trigger test exercises existing defensive INSERT-conflict replay with exact persisted payload (in isolated transaction, dropped afterward); zero model calls.
- No UI/schema/route/dependency changes, no historical event rewrite outside isolated fixtures, no production or paid calls. No automatic repair of historical deployed learning-state rows; any production re-settlement requires a separate scoped inventory/ops decision.
