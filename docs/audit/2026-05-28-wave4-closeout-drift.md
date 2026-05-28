# Drift Audit — 2026-05-28 (Wave 4 closeout)

**Scope**: ADR-0011 / ADR-0014 / ADR-0015 / ADR-0017 / ADR-0018 / ADR-0020 / ADR-0021 / ADR-0022; active plans in `docs/superpowers/plans/` (master roadmap §5.1, Wave 2-4 ready-to-launch, T-DR / T-D2 / T-D4 driver docs); CLAUDE.md Architecture / Layering sections.
**Run by**: Claude Code (manual `/audit-drift`, post Wave 4 `d99c3bb1` ship).
**Gate state**: typecheck / lint / audit:schema / audit:partition / audit:profile / `pnpm test` (1052 + 11 migration) / `pnpm build` all green this run.

## Summary

- Aligned: 24 decision points across ADR-0011 / 0014 / 0015 / 0017 / 0018 / 0020 / 0021 / 0022 (not expanded)
- Documented-only: 0
- Undocumented: 2
- Contradicted: 0
- Phase-deferred: 2 (informational, both explicitly mapped to later Waves in master-roadmap §5.1)

## Findings

### ⚠️ Undocumented

#### [ADR-0020 §4 ↔ src/core/schema/business.ts:256-263 + app/(app)/learning-items/[id]/page.tsx:56]  NoteVerificationIssue still requires `section_id`, ADR-0020 said "整体废止"

- **声明**: ADR-0020 §4 "correction event payload `section_id?: string` → `block_id?: string`（schema rewrite，无数据 backfill）" + §Consequences "src/core/schema/event/known.ts CorrectArtifactEvent.payload.section_id → block_id".
- **代码**:
  - `src/core/schema/event/known.ts:242` ✅ `block_id` only — event payload migrated.
  - `src/core/schema/business.ts:257` `NoteVerificationIssue.section_id: z.string().nullable()` (required field), with `block_id: z.string().nullable().optional()` added secondarily.
  - `src/server/boss/handlers/note_verify.ts:109` still emits `{ section_id: null, block_id: null, ... }` in fail-out coverage issue.
  - `app/(app)/learning-items/[id]/page.tsx:56` UI type duplicates `NoteVerificationIssue` and only declares `section_id: string | null`; `block_id` is missing entirely.
- **冲突**: ADR-0020 scope was "schema rewrite". CorrectArtifactEvent payload migrated cleanly. The verifier-output schema kept `section_id` + added `block_id` rather than rename. No ADR or driver doc records this transitional double-anchor decision; UI type drifted further (drops `block_id`).
- **建议**: 选一个执行 — (a) finish migration: rename `NoteVerificationIssue.section_id` → `block_id` and remove the field from UI type, OR (b) add a one-line ADR-0020 / ADR-0022 errata documenting the double-anchor on verifier output as intentional compat. Either way, sync the UI type at `learning-items/[id]/page.tsx:56` so it doesn't shadow the schema.
- **Linear**: [YUK-115](https://linear.app/yukoval-studios/issue/YUK-115) (created 2026-05-28; Backlog; `drift` label; parent YUK-88; 1 pt).

#### [ADR-0020 §Schema 变更 ↔ src/server/events/artifact-corrections.ts:29-38]  Legacy `section_id` payload shim is undocumented in ADR

- **声明**: ADR-0020 §Consequences "无数据 backfill：当前项目无生产 artifact 数据；migration 任务退化为 tests rework (P7)".
- **代码**: `src/server/events/artifact-corrections.ts:29-38` `normalizeLegacyPayload()` projects rows with `payload.section_id` → `payload.block_id` at read time. Tests cover it (`artifact-corrections.test.ts:104` "projects legacy section_id correction payloads as block_id for existing rows").
- **冲突**: ADR explicitly said "无数据 backfill", but a runtime read-shim now treats legacy `section_id` rows as first-class. The shim is correct (older rows from before the migration do exist), but the ADR doesn't acknowledge that any backward-compat read path was needed. Code comment at line 7-14 cites ADR-0020 but does not flag the legacy projection.
- **建议**: Add one line to ADR-0020 §Consequences (or in an erratum block similar to ADR-0017's 2026-05-27 errata) noting that pre-ship rows with `payload.section_id` are read-projected through `normalizeLegacyPayload`. Low priority — code is correct, only the doc trail is incomplete.
- **Linear**: skip (minor doc trail; not blocking).

### ⏳ Phase-deferred (informational, not drift)

#### [ADR-0020 §9 hub auto-sync nightly worker]

- ADR-0020 §9 specifies an `AutoLinksContainer` block + iii-curated nightly maintenance worker (4-rule inclusion + `suppressed_block_refs` dismiss) running alongside `knowledge_edge_propose_nightly` at 02:30 BJT.
- Current state: `AutoLinksContainer` node ✅ exists (`src/ui/block-tree/tiptap-extensions.tsx:151`). `knowledge_edge_propose_nightly` ✅ ships at `30 2 * * *` BJT. **No separate `hub_auto_sync` handler.**
- master-roadmap §5.1 Wave 7 (~5 周) line: "T-88 P5 反链 + cross_link UI + hub auto-sync 8 pts" — explicit phase-deferral. Not drift.

#### [ADR-0020 §11 day1 编辑器 vs ADR-0022 §Basic vs Polish]

- ADR-0020 §11 originally said "day1 ship：完整 Notion-like (text edit / split / merge / drag-drop / paste markdown / undo-redo / inline marks / slash command / block cross_link / mention 输入)".
- ADR-0022 §Basic vs Polish refined this: P2-basic (now shipped) covers StarterKit + Link + 5 NodeViews + JSON renderer + whole-doc save + undo/redo + inline marks + markdown paste. **P2-polish owns slash commands / drag-drop / mention picker / cross-link picker UI.**
- Wave 2 ship was P2-basic only (per master-roadmap §5.1 Wave 2 outcome line). ADR-0022 is the authoritative impl ADR; the §11 "完整" list is now superseded by the basic/polish split. Worth a one-line note in ADR-0020 §11 saying "P2-polish features detailed in ADR-0022; see master-roadmap §5.1 Wave 6+ for ship schedule" — but not required.

## Aligned highlights (spot-checked, not exhaustive)

- ADR-0020 schema rewrite: `drizzle/0018_marvelous_northstar.sql` does the full DROP sections / outline_json / child_artifact_ids / knowledge_id + ADD body_blocks / knowledge_ids / attrs + `artifact_block_ref` table + `event_referenced_knowledge_gin`. `artifact.knowledge_id` (singular) is **fully absent** from `src/` and `app/`.
- ADR-0020 §2 block-id rules: `src/ui/block-tree/pm.ts:82-93` `splitSemanticBlockAtText` keeps left `blockId` unchanged, mints `newBlockId` for right with `derived_from_block_id`. Matches ADR-0022 §Split / Merge.
- ADR-0021 acceptance: both grep gates clean — `SKIP_BOSS_INGEST | defaultMemoryIngestEnqueuer | _setMemoryIngestEnqueuerForTests | INGEST_SINGLETON_SECONDS | memoryIngestEnqueuer\b` → 0 hits in `src/`+`scripts/`; `@/server/boss/client | @/server/memory/triggers` → 0 hits in `src/server/events/queries.ts`. `writeEvent` is pure INSERT. Outbox poll scheduled `* * * * *` UTC, recover `0 * * * *` UTC.
- ADR-0022 boundary: `src/ui/block-tree/BlockTreeRenderer` does not import `@tiptap/react` (verified by `boundary.test.ts:10`); editor is dynamic-imported in `ArtifactBlockTree.tsx:21-22`. `PATCH /api/artifacts/[id]/body-blocks/route.ts` validates `artifact_version` and writes `body_blocks_edit` history + `experimental:artifact_body_blocks_edit` event mirror.
- ADR-0011 + Wave 3: all 8 propose tools present in `src/server/ai/tools/proposal-tools.ts` (propose_knowledge_edge / propose_knowledge_mutation / attribute_mistake / propose_variant / propose_learning_item_completion / propose_learning_item_relearn / propose_record_links / propose_record_promotion); `allowlists.ts` ships the task/surface matrix.
- ADR-0017 + Wave 4 dreaming: `src/server/boss/handlers/dreaming_nightly.ts` ships, scheduled `15 3 * * *` Asia/Shanghai, uses generic `buildMcpServerFromRegistry` + `resolveMcpAllowedTools('dreaming')`. `meta:orchestrator_self` scope wired in `scope_tagger.ts` + `brief.ts`. Memory brief 3-window markdown schema preserved.

## Notes

- No `❌ Contradicted` findings — Wave 2/3/4 ship is structurally clean against ADRs accepted before each Wave.
- Both Undocumented findings sit on the same migration boundary (`section_id` → `block_id`). Cheapest fix is one ADR-0020 erratum block + one rename pass in `business.ts` + the UI type. Estimate ≤ 1 PR.
- No allowlist needed yet; report-only this round.
