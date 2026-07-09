-- YUK-249 — subject-identity data migration: canonical id `wenyan` → `yuwen`.
--
-- The subject registry now registers the profile as `yuwen` (displayName 语文) and
-- DEMOTES the old canonical `wenyan` to an ALIAS (profile.ts register aliases
-- ['wenyan','classical_chinese','chinese_classics']). That alias is the backward-
-- compat spine: any legacy row / backup / event payload that still carries the
-- literal 'wenyan' normalizes to yuwen on READ via resolveKnownSubjectId. This
-- migration additionally rewrites the STORED identity keys in the mutable
-- projection tables so fresh writes and historical rows agree on 'yuwen'.
--
-- SCOPE (data-only; no DDL, no schema-model change → NO meta snapshot, mirrors
-- 0059/0060/0061 precedent). Every statement is idempotent (LIKE-guarded replace /
-- equality-guarded set) so re-running the migrate chain is safe.
--
-- The append-only `event` table is intentionally LEFT UNTOUCHED (append-only
-- ledger ruling). The read path relies on the wenyan→yuwen alias to normalize
-- historical event payloads. KNOWN ITEM: re-importing an OLD backup will bring
-- back 'wenyan' literals into these projection tables; correctness is preserved
-- because the alias read-path still resolves them to yuwen (they are simply not
-- re-normalized in-place until this migration is re-applied).
--
-- Blast-radius notes for reviewers:
--   * knowledge.id is renamed (seed:wenyan: / synthetic:wenyan: prefixes). The only
--     FK onto knowledge.id is knowledge_edge.{from,to}_knowledge_id (ON UPDATE NO
--     ACTION). Prod knowledge_edge has 0 rows, and test:migration runs on an empty
--     DB, so the rename raises no FK violation. If a non-prod DB has knowledge_edge
--     rows referencing a seed:wenyan:* node, this migration must be extended to
--     cascade those columns first.
--   * Four projection tables key subject_id/node refs on knowledge NODE IDS with
--     no formal FK and no alias-read fallback (the registry alias normalizes
--     subject/domain identity strings, not node ids): mastery_state ('knowledge'-
--     kind rows), kc_typed_state, learner_axis_state, material_fsrs_state. All
--     four are empty in prod (zero learning activity at migration time), so the
--     knowledge.id renames in 1a/2 strand nothing. In-place migration of a
--     POPULATED non-prod DB (e.g. synthetic-seeded dev) is NOT supported by this
--     file — those node-id refs would dangle and would need a backfill pass.
--     Statement 3 below migrates only the ability-global per-domain row (bare
--     subject_id 'wenyan'); knowledge-kind subject_id backfill is out of scope.

-- 1a. knowledge nodes: rename the seed:wenyan: id prefix and flip the domain axis.
--     Broad WHERE catches the seed root AND any user-uploaded child KC on the
--     wenyan domain. (prod: the 3 seed roots; wenyan root among them.)
UPDATE "knowledge"
SET "id" = replace("id", 'seed:wenyan:', 'seed:yuwen:'),
    "domain" = 'yuwen'
WHERE "id" LIKE 'seed:wenyan:%' OR "domain" = 'wenyan';

-- 1b. subject-identity: the wenyan seed ROOT node's display name 文言文 → 语文
--     (YUK-249 §身份 — subject-root seed node name migrates; a fresh seed already
--     writes 语文 via subjectProfiles[id].displayName). Narrow to the root id and
--     guard on the old name so child KCs (their own names) and any owner-renamed
--     root are never clobbered; runs AFTER 1a so the id is already seed:yuwen:root.
UPDATE "knowledge"
SET "name" = '语文'
WHERE "id" = 'seed:yuwen:root' AND "name" = '文言文';

-- 2. synthetic knowledge nodes: rename the synthetic:wenyan: id prefix (domain was
--    already handled by 1a's `OR domain = 'wenyan'`). Source generator kept in sync
--    (scripts/seed-synthetic.ts → synthetic:yuwen:).
UPDATE "knowledge"
SET "id" = replace("id", 'synthetic:wenyan:', 'synthetic:yuwen:')
WHERE "id" LIKE 'synthetic:wenyan:%';

-- 3. mastery_state: the ability-global per-domain θ_global row keys subject_id on
--    the bare domain and subject_kind on ABILITY_GLOBAL_KIND = 'ability_global'
--    (src/server/mastery/state.ts, stored verbatim — plain text column, no enum/
--    CHECK/remap). Only ability_global rows carry a bare 'wenyan' subject_id
--    (knowledge-kind rows use node ids), so this uniquely targets the domain row.
--    NOTE: the read path (globalThetaForDomain) queries on the already-resolved
--    'yuwen' domain with no alias fallback, so without this UPDATE a legacy row
--    would silently become invisible (θ_global reset) once mastery rows exist.
UPDATE "mastery_state"
SET "subject_id" = 'yuwen'
WHERE "subject_kind" = 'ability_global' AND "subject_id" = 'wenyan';

-- 4. memory_brief_note: subject-scoped brief keys on scope_key `subject:wenyan`,
--    id `memory_brief:subject:wenyan`, subject_id `wenyan`. Rewrite all three.
--    (uniqueIndex on scope_key: prod has ≤1 subject brief per subject, no collision.)
UPDATE "memory_brief_note"
SET "scope_key" = replace("scope_key", 'subject:wenyan', 'subject:yuwen'),
    "id" = replace("id", 'subject:wenyan', 'subject:yuwen'),
    "subject_id" = 'yuwen'
WHERE "scope_key" LIKE '%subject:wenyan%' OR "subject_id" = 'wenyan';

-- 5. item_family_calibration: family_key = `${subject}:${pk}:${kind}:${source}`, so
--    the leading segment is the subject. A global replace of 'wenyan:' also rewrites
--    the embedded seed:wenyan:/synthetic:wenyan: pk segment, keeping it consistent
--    with statements 1a/2. (uniqueIndex on family_key; prod has 0 calibration rows,
--    so no collision — this is pure insurance for dev/backup DBs.)
UPDATE "item_family_calibration"
SET "family_key" = replace("family_key", 'wenyan:', 'yuwen:')
WHERE "family_key" LIKE 'wenyan:%';
