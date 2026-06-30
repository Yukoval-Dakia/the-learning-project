// Phase 1c.1 Step 9.L — final single-owner invariant audit.
//
// Pure-Node fs walker (mirrors tests/integration/session-single-owner.test.ts).
// Three assertions:
//   1. `db.insert(event)` only appears in the documented allowlist of writer
//      modules; `db.update(event)` stays confined to documented lifecycle
//      owner modules.
//   2. `db.update(learning_session)` only appears in src/server/session/.
//   3. `db.insert/update(material_fsrs_state)` only appears in
//      src/server/fsrs/state.ts (the new Step 9.A single-owner).
//   4. The 4 DROP'd tables (mistake / review_event / dreaming_proposal /
//      ingestion_session) have ZERO write-callers anywhere in src/ + app/.
//      The Step 3 migration script (scripts/migrate-phase1c1.ts) may have
//      historical references — verified separately to be comments / stub
//      only (no live `db.insert/update(<dropped>)` SQL).
//
// `artifact` table writes are documented as Phase 1c.2 pending (no AI
// generate handler exists yet); the audit notes this rather than failing.

import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const SCAN_ROOTS = ['src', 'app', 'scripts'] as const;
const SCAN_RUNTIME_ROOTS = ['src', 'app'] as const;
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', '.turbo', '.vercel']);
const SCAN_EXTS = new Set(['.ts', '.tsx']);

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await recurse(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (SCAN_EXTS.has(ext)) out.push(full);
      }
    }
  }
  await recurse(root);
  return out;
}

type Hit = string; // repo-relative path

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findWriteHits(
  tableName: string,
  opts: {
    roots?: ReadonlyArray<string>;
    includeTests?: boolean;
    ops?: ReadonlyArray<'insert' | 'update'>;
  } = {},
): Promise<Hit[]> {
  const ops = opts.ops ?? (['insert', 'update'] as const);
  const re = new RegExp(
    `\\b[\\w$]+\\s*\\.\\s*(?:${ops.join('|')})\\s*\\(\\s*${escapeRegExp(tableName)}\\s*[,)]`,
  );
  const hits: Hit[] = [];
  for (const root of opts.roots ?? SCAN_ROOTS) {
    const files = await walkFiles(path.join(REPO_ROOT, root));
    for (const file of files) {
      if (!opts.includeTests && (file.endsWith('.test.ts') || file.endsWith('.test.tsx'))) {
        continue;
      }
      // 并行测试竞态容忍（YUK-222 gate 实测；judge-gap-audit.test.ts 同款防护）：
      // serialize round-trip 等单元测试会在 src/subjects/ 下创建临时 fixture 目录，
      // walk 时 readdir 已枚举该文件、随后 read 时它的 afterAll 已 rm → ENOENT。
      // 消失的临时文件不可能是 db 写者，跳过即可；其它错误照常抛。
      let text: string;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      if (re.test(text)) {
        hits.push(path.relative(REPO_ROOT, file));
      }
    }
  }
  return hits.sort();
}

function isAllowed(relPath: string, prefixes: ReadonlyArray<string>): boolean {
  const norm = relPath.split(path.sep).join('/');
  return prefixes.some((prefix) => norm.startsWith(prefix));
}

describe('Phase 1c.1 Step 9.L — invariant audit', () => {
  it('db.insert(event) appears only inside documented writer modules', async () => {
    const ALLOWED_EVENT_WRITERS = [
      // Single-owner INSERT path (ADR-0005)
      'src/server/events/queries.ts',
      // session → event mapper (delegates to writeEvent)
      'src/server/session/events.ts',
      // knowledge tree mutation propose events
      'src/capabilities/knowledge/server/proposals.ts',
      // knowledge edges direct writers (Lane B GenerateKnowledgeEdge / ProposeKnowledgeEdge)
      'src/capabilities/knowledge/server/edges.ts',
      // knowledge attribute (judge event writer)
      'src/capabilities/knowledge/server/attribute.ts',
      // knowledge review stream task tool
      'src/capabilities/knowledge/server/review.ts',
      // Test fixture helpers
      'tests/helpers/',
    ] as const;
    const hits = await findWriteHits('event', { ops: ['insert'] });
    const violations = hits.filter((h) => !isAllowed(h, ALLOWED_EVENT_WRITERS));
    expect(
      violations,
      `Disallowed writers of \`event\` table found:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('db.update(event) appears only inside documented lifecycle owner modules', async () => {
    const ALLOWED_EVENT_UPDATERS = [
      // ADR-0021 transactional outbox stamp (`ingest_at`) owner.
      'src/server/memory/triggers.ts',
    ] as const;
    const hits = await findWriteHits('event', { ops: ['update'] });
    const violations = hits.filter((h) => !isAllowed(h, ALLOWED_EVENT_UPDATERS));
    expect(
      violations,
      `Disallowed updaters of \`event\` table found:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('db.{insert,update}(learning_session) appears only inside src/server/session/* (extended by scripts/migrate-phase1c1.ts historical)', async () => {
    const ALLOWED_LEARNING_SESSION_WRITERS = [
      'src/server/session/',
      'scripts/migrate-phase1c1.ts',
    ] as const;
    const hits = await findWriteHits('learning_session');
    const violations = hits.filter((h) => !isAllowed(h, ALLOWED_LEARNING_SESSION_WRITERS));
    expect(
      violations,
      `Disallowed writers of \`learning_session\` table found:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('db.{insert,update}(material_fsrs_state) appears only in src/server/fsrs/state.ts (extended by scripts/migrate-phase1c1.ts historical)', async () => {
    const ALLOWED_FSRS_WRITERS = ['src/server/fsrs/', 'scripts/migrate-phase1c1.ts'] as const;
    const hits = await findWriteHits('material_fsrs_state');
    const violations = hits.filter((h) => !isAllowed(h, ALLOWED_FSRS_WRITERS));
    expect(
      violations,
      `Disallowed writers of \`material_fsrs_state\` found:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  // B1-W1 (ADR-0035) — mastery_state is the p(L) diagnostic projection; its only
  // allowed writer is the single-owner src/server/mastery/. The hot paths
  // (submit.ts / paper-submit.ts) only CALL updateThetaForAttempt — they never
  // db.insert/update(mastery_state) directly, so this assertion stays clean.
  it('db.{insert,update}(mastery_state) appears only in src/server/mastery/', async () => {
    const ALLOWED_MASTERY_WRITERS = ['src/server/mastery/'] as const;
    const hits = await findWriteHits('mastery_state');
    const violations = hits.filter((h) => !isAllowed(h, ALLOWED_MASTERY_WRITERS));
    expect(
      violations,
      `Disallowed writers of \`mastery_state\` found:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  // B1-W1 (ADR-0035) — item_calibration is the item difficulty anchor (item-half
  // locked, G4). Its only writer is the applier in src/server/mastery/
  // (item-calibration.ts). The θ̂ update path only READS item_calibration.b.
  it('db.{insert,update}(item_calibration) appears only in src/server/mastery/', async () => {
    const ALLOWED_CALIBRATION_WRITERS = ['src/server/mastery/'] as const;
    const hits = await findWriteHits('item_calibration');
    const violations = hits.filter((h) => !isAllowed(h, ALLOWED_CALIBRATION_WRITERS));
    expect(
      violations,
      `Disallowed writers of \`item_calibration\` found:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  // YUK-361 Phase 5 (ADR-0043 §家族级 b_personalized) — item_family_calibration is the
  // family-level b_delta adjustment layer (独立调整层，永不回写 item_calibration.b——
  // 不变量①). Its only writer is updateFamilyCalibration in src/server/mastery/
  // (personalized-difficulty.ts). The hot paths (submit.ts / paper-submit.ts) only
  // CALL recordFamilyObservationForAttempt best-effort — they never db.insert/update
  // (item_family_calibration) directly, so this assertion stays clean.
  it('db.{insert,update}(item_family_calibration) appears only in src/server/mastery/', async () => {
    const ALLOWED_FAMILY_CALIBRATION_WRITERS = ['src/server/mastery/'] as const;
    const hits = await findWriteHits('item_family_calibration');
    const violations = hits.filter((h) => !isAllowed(h, ALLOWED_FAMILY_CALIBRATION_WRITERS));
    expect(
      violations,
      `Disallowed writers of \`item_family_calibration\` found:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  // YUK-531 PR-3 (A5 S4 / ADR-0036 RT1) — misconception's L1 DORMANCY HAS ENDED. The
  // conjecture→misconception promotion flow is now the FIRST (and single) writer of the
  // `misconception` table: promoteConjectureToMisconception
  // (src/capabilities/agency/server/misconception-promote.ts) upserts the soft-track
  // node when the owner accepts a conjecture. It is GATED behind the dark flag
  // MISCONCEPTION_PROMOTE_ENABLED (default OFF), so production stays byte-identical to
  // the dormant era until the ADR-0034 consistency gate flips it on — but the writer now
  // EXISTS in source, so the old ZERO-writer invariant (YUK-454 inc-1) is obsolete. This
  // flips it to a single-owner invariant, mirroring the mastery_state / item_calibration
  // blocks above: the promote module is the SOLE allowed writer (any other is a violation),
  // AND the writer must be present (a silent revert that re-dormants the table also fails).
  it('db.{insert,update}(misconception) has exactly ONE writer — the dark-gated YUK-531 PR-3 promotion flow', async () => {
    const ALLOWED_MISCONCEPTION_WRITERS = [
      'src/capabilities/agency/server/misconception-promote.ts',
    ] as const;
    const hits = await findWriteHits('misconception');
    const violations = hits.filter((h) => !isAllowed(h, ALLOWED_MISCONCEPTION_WRITERS));
    expect(
      violations,
      `\`misconception\` is single-owner (YUK-531 PR-3): only the dark-gated promotion flow (misconception-promote.ts) may write it. Found extra writers:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
    // Positive lock — the promotion writer MUST be present. This is the inverse of the
    // retired ZERO-writer guard: it catches a silent revert that drops the writer and
    // re-dormants the table (which the violations-only check above would pass).
    expect(
      hits.some((h) => isAllowed(h, ALLOWED_MISCONCEPTION_WRITERS)),
      'expected the YUK-531 PR-3 promotion writer (misconception-promote.ts) to write `misconception` — has the promotion flow been reverted?',
    ).toBe(true);
  });

  // YUK-454 inc-1 — REVERSE red line (ADR-0035 SOFT track). The misconception
  // identity module must contain NONE of the soft-track engine markers. This
  // locks the soft-track invariant at the source level BEFORE any writer exists:
  // a misconception must never grow a write path into θ̂/p(L)/mastery_state/
  // item_calibration/FSRS.
  it('src/core/schema/misconception.ts references NO soft-track engine markers (ADR-0035)', async () => {
    const SOFT_TRACK_MARKERS = [
      'updateThetaForAttempt',
      'mastery_state',
      'item_calibration',
      'item_family_calibration',
      'material_fsrs_state',
      'theta_hat',
      'effectiveB',
    ] as const;
    const src = await fs.readFile(path.join(REPO_ROOT, 'src/core/schema/misconception.ts'), 'utf8');
    const present = SOFT_TRACK_MARKERS.filter((marker) => src.includes(marker));
    expect(
      present,
      `misconception identity module leaks soft-track engine markers (ADR-0035 SOFT track violation):\n  ${present.join('\n  ')}`,
    ).toEqual([]);
  });

  // YUK-471 Wave 0 (ADR-0044 §3) — REVERSE invariant: each A-class attempt tx (solo
  // submit.ts + paper paper-submit.ts) MUST append exactly one
  // `experimental:state_snapshot` event anchored to the attempt event, so the θ̂/FSRS
  // in-place overwrite it performs is always bracketed (A-class snapshot reversibility).
  // This is the source-level companion to the DB tests (submit-snapshot.db.test.ts /
  // paper-submit-snapshot.db.test.ts): those prove the runtime behaviour against the
  // live rows; this static walker proves the WRITER exists in each attempt path's source
  // (and would catch a future edit that silently drops the append). We assert on the
  // source text because the step9 audit is a pure-Node fs walker, not a DB harness.
  it('each attempt tx (solo + paper) appends exactly one experimental:state_snapshot anchored to the attempt event', async () => {
    const ATTEMPT_PATHS = [
      'src/capabilities/practice/api/submit.ts',
      'src/capabilities/practice/server/paper-submit.ts',
    ] as const;
    for (const rel of ATTEMPT_PATHS) {
      const src = await fs.readFile(path.join(REPO_ROOT, rel), 'utf8');
      // Exactly one snapshot writeEvent literal per attempt path (the single append
      // site). More than one would mean a duplicate (double snapshot per attempt);
      // zero would mean the A-class invariant is unestablished for that path.
      const actionRe = /action:\s*'experimental:state_snapshot'/;
      const actionLiterals = src.match(new RegExp(actionRe, 'g')) ?? [];
      expect(
        actionLiterals.length,
        `${rel} must contain EXACTLY one experimental:state_snapshot append (found ${actionLiterals.length})`,
      ).toBe(1);

      // SCOPE the field assertions to the snapshot writeEvent block. The whole-file
      // regexes used previously could match a `caused_by_event_id: eventId` /
      // `ingest_at: now` field in ANY other event block (e.g. the attempt event
      // itself), letting the invariant pass without truly covering the snapshot
      // writeEvent. We slice from the `action: 'experimental:state_snapshot'`
      // literal through the close of its enclosing writeEvent call (`});`), then
      // run the field regexes against that scoped substring.
      const actionIdx = src.search(actionRe);
      expect(
        actionIdx,
        `${rel} must contain an experimental:state_snapshot action literal`,
      ).toBeGreaterThanOrEqual(0);
      const writeEventOpenIdx = src.lastIndexOf('writeEvent(', actionIdx);
      expect(
        writeEventOpenIdx,
        `${rel} snapshot action literal must live inside a writeEvent( call`,
      ).toBeGreaterThanOrEqual(0);
      // The block ends at the matching `});` that closes the writeEvent call that
      // opens at/before the action literal. Find the first `});` at or after the
      // action literal — that is the tail of this writeEvent argument object.
      const closeIdx = src.indexOf('});', actionIdx);
      expect(
        closeIdx,
        `${rel} snapshot writeEvent call must be terminated by '});'`,
      ).toBeGreaterThanOrEqual(0);
      const snapshotBlock = src.slice(writeEventOpenIdx, closeIdx + '});'.length);

      // The append must back-link to the attempt event via caused_by_event_id (the
      // cascade CTE chain edge). submit.ts uses `eventId`; paper-submit.ts uses
      // `attemptEventId` — accept either attempt-event identifier.
      expect(
        /caused_by_event_id:\s*(eventId|attemptEventId)\b/.test(snapshotBlock),
        `${rel} snapshot append must set caused_by_event_id to the attempt event id (inside the snapshot writeEvent block)`,
      ).toBe(true);
      // HARD REQ 2 — the snapshot opts out of the memory outbox (ingest_at non-NULL).
      expect(
        /ingest_at:\s*now/.test(snapshotBlock),
        `${rel} snapshot append must stamp ingest_at: now (HARD REQ 2 — skip the memory outbox; inside the snapshot writeEvent block)`,
      ).toBe(true);
    }
  });

  for (const dropped of ['mistake', 'review_event', 'dreaming_proposal', 'ingestion_session']) {
    it(`legacy \`${dropped}\` table has ZERO write-callers in src/ + app/ (DROPped in 9.J)`, async () => {
      const hits = await findWriteHits(dropped, { roots: SCAN_RUNTIME_ROOTS });
      expect(
        hits,
        `Stale writers of dropped table \`${dropped}\` found:\n  ${hits.join('\n  ')}`,
      ).toEqual([]);
    });
  }

  it('artifact table writes: confined to Phase 2B + note lifecycle handlers (Pass 2 + embedded check)', async () => {
    // 'artifact' is the C-tier AI production landing point per ADR-0006 v2.
    // Phase 2B (Learning Intent Orchestrator) activated the write path with
    // the accept handler + the `note_generate` pg-boss handler. The note
    // lifecycle later grew two more single-owner writers, each touching a
    // distinct status axis on the artifact row:
    //   - `note_verify`: writes `verification_status` / `verification_summary` /
    //     `verified_by` after the Pass 2 verifier judges generated sections.
    //   - `embedded_check_generate`: writes `embedded_check_status` and
    //     mirrors the generated question ids back onto the `check` section
    //     after Judge v2 light's question contract is satisfied.
    //   - YUK-203 P2 `src/server/boss/handlers/quiz_gen.ts`: writes the
    //     standalone `tool_quiz` artifact that groups QuizGenTask draft
    //     questions through `tool_state.question_ids[]`.
    //   - YUK-19 `src/server/proposals/actions.ts`: retracting a learning_intent
    //     proposal tombstones the paired artifact stubs alongside the materialized
    //     hub + atomic learning_items (archived_at + version+1 only — no semantic
    //     content rewrite). Mirrors the variant_question retract tombstone policy.
    //   - YUK-54 `src/capabilities/notes/server/sections.ts`: the single owner-service for
    //     user section edits. Routes must call this service so sections/history
    //     updates and `experimental:artifact_section_edit` stay atomic.
    //   - YUK-92 `src/capabilities/notes/server/body-blocks-edit.ts`: the single owner-service
    //     for whole-document block tree edits, keeping artifact.version, history,
    //     and `experimental:artifact_body_blocks_edit` in one transaction.
    //   - YUK-127 (T-88 P4-A) `src/capabilities/notes/server/note-refine-apply.ts`: the
    //     single owner-service for AI-side Living Note block-level patch
    //     application — applies a NotePatch to body_blocks + bumps version +
    //     writes `experimental:note_refine_apply` in one transaction.
    //   - YUK-203 U4 (D5 / CO §7.1) `src/server/ai/tools/review-plan-tools.ts`:
    //     write_review_plan emits the review-plan `tool_quiz` artifact (the
    //     paper) — the ReviewPlanTask planner's only write.
    //   - YUK-95 (P5 Lane-D) `src/capabilities/notes/server/hub-dismiss.ts`: the single
    //     owner-service for dismissing a hub auto-link — appends
    //     `attrs.suppressed_block_refs` (no version bump) alongside the paired
    //     suppress event + the immediate-removal `note_refine_apply`, all atomic
    //     in one transaction. The route only validates input + opens the tx.
    //   - YUK-214 (Strategy D S1) `src/capabilities/ingestion/server/make-paper.ts`:
    //     createIngestionPaper packs an imported ingestion session's questions
    //     into an `ingestion_paper` tool_quiz artifact (ingest→practice
    //     bridge). Single INSERT, idempotent by source_ref=sessionId.
    //   - ADR-0032 RP-2 / YUK-304 (lane B) `src/server/ai/tools/tool-quiz-core.ts`:
    //     the SHARED tool_quiz artifact INSERT core. write_review_plan
    //     (review-plan-tools.ts) and write_quiz (write-quiz.ts) both delegate
    //     their single INSERT here (the wrappers own validation / idempotency /
    //     semantics; the core owns the constant skeleton + the ToolState Zod
    //     barrier). The YUK-262 quiz-skill writer is RETIRED (quiz C→A): its
    //     /practice paper capability moved to the write_quiz DomainTool.
    // Anything else writing `artifact` should still be reviewed.
    const hits = await findWriteHits('artifact', { roots: SCAN_RUNTIME_ROOTS });
    const ALLOWED = [
      'src/server/orchestrator/learning_intent.ts',
      'src/capabilities/notes/jobs/note_generate.ts',
      'src/capabilities/notes/jobs/note_verify.ts',
      'src/server/boss/handlers/embedded_check_generate.ts',
      'src/server/boss/handlers/quiz_gen.ts',
      'src/server/proposals/actions.ts',
      // M4-T4 (YUK-319) — D11 墓碑：record_links / record_promotion appliers 从
      // actions.ts 等价平移至此（搬迁不改逻辑）；record_promotion 物化 target 为
      // artifact 时的单 INSERT 随代码迁入。无活 producer，旧学习记录域退役时一并删。
      'src/server/proposals/legacy-record-appliers.ts',
      'src/capabilities/notes/server/sections.ts',
      'src/capabilities/notes/server/body-blocks-edit.ts',
      'src/capabilities/notes/server/note-refine-apply.ts',
      'src/capabilities/notes/server/hub-dismiss.ts',
      // ADR-0032 RP-2 / YUK-304 (lane B) — the shared tool_quiz artifact INSERT
      // core. write_review_plan (review-plan-tools.ts) + write_quiz
      // (write-quiz.ts) delegate their single INSERT here; review-plan-tools.ts
      // itself no longer contains a raw artifact insert. The YUK-262 quiz-skill
      // writer (src/server/copilot/skills/quiz-skill.ts) is retired (quiz C→A).
      'src/server/ai/tools/tool-quiz-core.ts',
      // YUK-214 (Strategy D S1) — createIngestionPaper packs an imported
      // ingestion session's questions into an `ingestion_paper` tool_quiz
      // artifact (the ingest→practice bridge). Single INSERT, idempotent
      // by source_ref=sessionId; the make-paper route's only write.
      'src/capabilities/ingestion/server/make-paper.ts',
      // ADR-0033 D6 / YUK-306 (lane D) — author_artifact INSERT + update_artifact
      // version-bump UPDATE for type='interactive' rows (opaque to the note
      // block-tree mesh, body_blocks=null; the render-side sandbox owns
      // security, the backend stores attrs.html opaquely).
      'src/server/ai/tools/author-artifact.ts',
      // YUK-471 Wave 3 (W3-B1) — projectArtifact / projectArtifactGuarded: the fold→row
      // write-back (upsert/delete the materialized artifact row recomputed from the event fold).
      // INERT until PROJECTION_IS_WRITER_ARTIFACT flips (W3-D); mirrors the W1/W2 projection
      // writers (src/server/projections/{knowledge,goal,mistake_variant,learning_item}.ts).
      'src/server/projections/artifact.ts',
    ];
    const unexpected = hits.filter((h) => !ALLOWED.includes(h.split(path.sep).join('/')));
    expect(
      unexpected,
      `Unexpected artifact writers. Expected only ${ALLOWED.join(' + ')}. Found:\n  ${unexpected.join('\n  ')}`,
    ).toEqual([]);
  });

  // YUK-503 (YUK-471 W3-D) — symmetric to the `artifact` writer audit above. Every module that writes
  // (INSERT or UPDATE) a `question_block` row must ALSO emit the canonical event that lets the W3-B fold
  // (foldQuestionBlock) reproduce that row from the event log — a `experimental:question_block_create`
  // BASE for creation/rescue, or a `experimental:question_block_lifecycle` for the set_status /
  // reassign_figures fold-truth mutators — OR be the projection writer itself. Without this audit, the
  // 5 formerly-eventless fold-truth mutators stayed invisible until the W3-C3 review; it is the
  // checkpoint that catches them earlier: a NEW file that mutates question_block but is not in this
  // allowlist fails here, forcing the author to either wire the event seam or consciously add the file
  // (and explain its event-sourcing story), exactly the review gate that was missing.
  it('question_block writes: confined to event-sourcing-aware writer modules (YUK-503)', async () => {
    const hits = await findWriteHits('question_block', { roots: SCAN_RUNTIME_ROOTS });
    const ALLOWED = [
      // OCR ingestion: the creation INSERT + the rescue UPDATE, each paired with a
      // `experimental:question_block_create` event (writeQuestionBlockCreateEvent) — rescue emits a
      // create-event overwrite (FIRST-BASE-WINS is bypassed for rescue by design).
      'src/server/session/ingestion.ts',
      // docx ingestion: the creation INSERT + its `experimental:question_block_create` event.
      'src/server/session/docx-ingestion.ts',
      // import POST: the virtual (merged/split) card INSERT + create event; the enroll/ignore status
      // UPDATEs each emit `experimental:question_block_lifecycle` (op='set_status').
      'src/capabilities/ingestion/api/import.ts',
      // auto-enroll: the status UPDATE → `experimental:question_block_lifecycle` (op='set_status',
      // status='auto_enrolled' + imported_*).
      'src/capabilities/ingestion/server/auto-enroll.ts',
      // structured edits + figure reassignment: each UPDATE emits its matching structured-edit event or
      // `experimental:question_block_lifecycle` (op='reassign_figures').
      'src/capabilities/ingestion/server/block-structured-edit.ts',
      // revert: the reset UPDATE → `experimental:question_block_lifecycle` (op='set_status',
      // status='draft', imported_* cleared).
      'src/capabilities/ingestion/server/revert-auto-enroll.ts',
      // YUK-471 W3-B — projectQuestionBlock / projectQuestionBlockGuarded: the fold→row write-back
      // (upsert recomputed from the event fold). INERT until PROJECTION_IS_WRITER_QUESTION_BLOCK flips;
      // mirrors the artifact projection writer (src/server/projections/artifact.ts) above.
      'src/server/projections/question_block.ts',
    ];
    const unexpected = hits.filter((h) => !ALLOWED.includes(h.split(path.sep).join('/')));
    expect(
      unexpected,
      `Unexpected question_block writers. Every writer must pair its row mutation with the canonical event-source seam (question_block_create / question_block_lifecycle) or be the projection writer — see YUK-471 W3-D. Expected only ${ALLOWED.join(' + ')}. Found:\n  ${unexpected.join('\n  ')}`,
    ).toEqual([]);
  });
});
