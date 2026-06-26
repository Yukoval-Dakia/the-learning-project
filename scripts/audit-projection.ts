// YUK-471 W1 PR-A2a — audit:projection: the event-sourcing drift auditor.
//
// WHAT. For every live `knowledge` row (then every `knowledge_edge` row), re-derive the
// EXPECTED structural snapshot by folding that id's events IN MEMORY (via the SAME shared
// gather helpers the IO shells use — gather.ts), and DEEP-DIFF it against the live row's
// structural columns. A live row that differs from fold(events) is DRIFT: the projection and
// its source-of-truth event log disagree. Drifted ids are printed and the process exits 1;
// a clean run exits 0.
//
// WHY a SEPARATE re-derivation, not the shell. The shell WRITES the fold through; the auditor
// must re-derive WITHOUT writing and compare. Both call the identical gather.ts read→fold, so
// the auditor reconstructs a row exactly as the SoT path does — it cannot be blind to a gather
// bug that also corrupts the live write.
//
// DECISION — NOT in the `pnpm test` chain (do NOT wire it in). It needs a POPULATED DB:
//   - against the empty CI testcontainer it is meaningless (zero rows → trivially clean), and
//   - against imperatively-created test rows (no genesis events / no double-write yet) it
//     would FALSE-POSITIVE every row as drift (fold(no events)=null ≠ the live row).
// It is a STANDALONE tool the owner runs against a PROD-CLONE for PR-B's B3 gate (genesis-
// backfill + rebuild the clone, then audit:projection must report CLEAN). Its CI coverage is
// the DB test (audit-projection.db.test.ts), which seeds a coherent genesis+index fixture and
// asserts CLEAN, then mutates a live row out-of-band and asserts DRIFT — testing the
// auditProjection FUNCTION, not the process exit.
//
// ALLOWLIST. scripts/audit-projection-allowlist.json (mirror audit-schema-allowlist.json):
// id → { reason, resolves_when{kind,ref,expected_by} }. An allowlisted drifted id is reported
// as ALLOWED (not a failure). Empty by default — pre-flip a freshly backfilled+rebuilt clone
// has zero drift.
//
// CLI:
//   pnpm audit:projection          # drift report; exit 1 if any non-allowlisted drift
//   pnpm audit:projection --json   # JSON output

// Load `.env` BEFORE importing `@/db/client`. Must be first (see backfill-genesis-events.ts).
import './load-env';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  GoalRowSnapshotT,
  KnowledgeRowSnapshotT,
  LearningItemRowSnapshotT,
  MistakeVariantRowSnapshotT,
} from '@/core/schema/event/genesis';
import { type Db, type Tx, db } from '@/db/client';
import {
  artifact,
  goal,
  knowledge,
  knowledge_edge,
  learning_item,
  mistake_variant,
  question_block,
} from '@/db/schema';
import {
  edgeRowToSnapshot,
  gatherAndFoldArtifact,
  gatherAndFoldGoal,
  gatherAndFoldKnowledgeEdgeWithMesh,
  gatherAndFoldKnowledgeNode,
  gatherAndFoldLearningItem,
  gatherAndFoldMistakeVariant,
  gatherAndFoldQuestionBlock,
} from '@/server/projections/gather';
// SHARED structural deep-diff — the B3 audit MUST use the same equality as the in-tx accept
// assert (src/server/projections/parity.ts), or it would be blind to the drift it gates. (#580)
import { diffSnapshots } from '@/server/projections/snapshot-diff';
// SHARED artifact / question_block row→snapshot mappers (W3-C3 review) — the audit, the genesis
// backfill, and the parity assert all pick the SAME fields here, so a schema change can't drift the
// audit snapshot shape (esp. the question_block extracted_prompt_md strip) out from under the fold.
import {
  artifactRowToSnapshot,
  questionBlockRowToSnapshot,
} from '@/server/projections/snapshot-mappers';

type DbLike = Db | Tx;
type KnowledgeRow = typeof knowledge.$inferSelect;
// The auditor reads ONLY the structural snapshot columns — NOT the large embed_* vectors
// (embedding / embed_model / embed_version / embed_content_hash). A narrow-column read keeps the
// full-table scan from pulling every node's embedding into memory at prod-clone scale.
type KnowledgeStructuralRow = Pick<
  KnowledgeRow,
  | 'id'
  | 'name'
  | 'domain'
  | 'parent_id'
  | 'merged_from'
  | 'archived_at'
  | 'proposed_by_ai'
  | 'approval_status'
  | 'created_at'
  | 'updated_at'
  | 'version'
>;

// The structural columns to SELECT for the node scan (skips embed_*). Mirrors the
// KnowledgeStructuralRow field set above — keep the two in sync.
const KNOWLEDGE_STRUCTURAL_COLUMNS = {
  id: knowledge.id,
  name: knowledge.name,
  domain: knowledge.domain,
  parent_id: knowledge.parent_id,
  merged_from: knowledge.merged_from,
  archived_at: knowledge.archived_at,
  proposed_by_ai: knowledge.proposed_by_ai,
  approval_status: knowledge.approval_status,
  created_at: knowledge.created_at,
  updated_at: knowledge.updated_at,
  version: knowledge.version,
} as const;

// ── Allowlist shape (mirror audit-schema-allowlist.json) ──────────────────────────────
export interface AllowlistEntry {
  reason: string;
  resolves_when: {
    kind: 'pr' | 'phase' | 'manual';
    ref: string;
    expected_by: string;
  };
}
export type ProjectionAllowlist = Record<string, AllowlistEntry>;

const ALLOWLIST_PATH = resolve(
  fileURLToPath(new URL('./audit-projection-allowlist.json', import.meta.url)),
);

export function loadAllowlist(path: string = ALLOWLIST_PATH): ProjectionAllowlist {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const out: ProjectionAllowlist = {};
  for (const [id, val] of Object.entries(raw)) {
    if (id.startsWith('_comment')) continue; // skip doc keys
    out[id] = val as AllowlistEntry;
  }
  return out;
}

// ── Drift representation ──────────────────────────────────────────────────────────────
export interface DriftRecord {
  id: string;
  subject_kind:
    | 'knowledge'
    | 'knowledge_edge'
    | 'goal'
    | 'mistake_variant'
    | 'learning_item'
    | 'artifact'
    | 'question_block';
  // human-readable field-level differences (column: live → expected).
  diffs: string[];
}

export interface AuditResult {
  ok: boolean; // true iff zero NON-allowlisted drift
  checkedNodes: number;
  checkedEdges: number;
  checkedGoals: number;
  checkedMistakeVariants: number;
  checkedLearningItems: number;
  checkedArtifacts: number;
  checkedQuestionBlocks: number;
  drift: DriftRecord[]; // non-allowlisted drift (the failures)
  allowed: DriftRecord[]; // drifted ids covered by the allowlist (reported, not failures)
}

// Map a live `goal` row to its snapshot so the deep-diff compares like-for-like against the goal
// fold output. goal has NO derived/embed columns — the full row IS the snapshot.
function goalRowToSnapshot(row: typeof goal.$inferSelect): GoalRowSnapshotT {
  return {
    id: row.id,
    title: row.title,
    subject_id: row.subject_id,
    scope_knowledge_ids: row.scope_knowledge_ids ?? [],
    sequence_hint: row.sequence_hint,
    status: row.status,
    source: row.source,
    source_ref: row.source_ref,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
  };
}

// Map a live `mistake_variant` row to its snapshot so the deep-diff compares like-for-like against
// the mistake_variant fold output. No derived/embed/version columns — the full row IS the snapshot
// (incl. the fold-blind cause_category the base event reproduces, critic A4).
function mistakeVariantRowToSnapshot(
  row: typeof mistake_variant.$inferSelect,
): MistakeVariantRowSnapshotT {
  return {
    id: row.id,
    parent_question_id: row.parent_question_id,
    variant_question_id: row.variant_question_id,
    proposal_event_id: row.proposal_event_id,
    status: row.status as MistakeVariantRowSnapshotT['status'],
    failure_reasons: row.failure_reasons ?? [],
    cause_category: row.cause_category,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── learning_item structural read (YUK-471 W2) ── the auditor reads ONLY the snapshot columns,
// EXCLUDING the non-structural / derived columns the fold does not own (child_learning_item_ids /
// ai_score / due_at / reviewed_at — design §3①). Excluding them from BOTH the SELECT and the
// snapshot keeps them out of the deep-diff (a row differing only in those columns folds clean).
const LEARNING_ITEM_STRUCTURAL_COLUMNS = {
  id: learning_item.id,
  source: learning_item.source,
  source_ref: learning_item.source_ref,
  title: learning_item.title,
  content: learning_item.content,
  knowledge_ids: learning_item.knowledge_ids,
  primary_artifact_id: learning_item.primary_artifact_id,
  parent_learning_item_id: learning_item.parent_learning_item_id,
  status: learning_item.status,
  user_pinned: learning_item.user_pinned,
  completed_at: learning_item.completed_at,
  dismissed_at: learning_item.dismissed_at,
  archived_at: learning_item.archived_at,
  archived_reason: learning_item.archived_reason,
  created_at: learning_item.created_at,
  updated_at: learning_item.updated_at,
  version: learning_item.version,
} as const;

// Derive the structural row from the schema (mirror KnowledgeStructuralRow) so it stays in sync
// with learning_item.$inferSelect — a hand-redefined type could silently drift from the columns.
// The excluded columns (child_learning_item_ids / ai_score / due_at / reviewed_at) are simply not
// picked, matching the LEARNING_ITEM_STRUCTURAL_COLUMNS select above.
type LearningItemStructuralRow = Pick<
  typeof learning_item.$inferSelect,
  | 'id'
  | 'source'
  | 'source_ref'
  | 'title'
  | 'content'
  | 'knowledge_ids'
  | 'primary_artifact_id'
  | 'parent_learning_item_id'
  | 'status'
  | 'user_pinned'
  | 'completed_at'
  | 'dismissed_at'
  | 'archived_at'
  | 'archived_reason'
  | 'created_at'
  | 'updated_at'
  | 'version'
>;

// Map a live learning_item row (narrow structural read) to its snapshot so the deep-diff compares
// like-for-like against the fold output. The excluded columns are dropped from the SELECT too.
function learningItemRowToSnapshot(row: LearningItemStructuralRow): LearningItemRowSnapshotT {
  return {
    id: row.id,
    source: row.source,
    source_ref: row.source_ref,
    title: row.title,
    content: row.content,
    knowledge_ids: row.knowledge_ids ?? [],
    primary_artifact_id: row.primary_artifact_id,
    parent_learning_item_id: row.parent_learning_item_id,
    status: row.status,
    user_pinned: row.user_pinned,
    completed_at: row.completed_at,
    dismissed_at: row.dismissed_at,
    archived_at: row.archived_at,
    archived_reason: row.archived_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
  };
}

// Map a live knowledge row (narrow structural read) to its snapshot so the deep-diff compares
// like-for-like against the fold output. embed_* are excluded both here AND from the SELECT.
function knowledgeRowToSnapshot(row: KnowledgeStructuralRow): KnowledgeRowSnapshotT {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    parent_id: row.parent_id,
    merged_from: row.merged_from,
    archived_at: row.archived_at,
    proposed_by_ai: row.proposed_by_ai,
    approval_status: row.approval_status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
  };
}

// artifactRowToSnapshot / questionBlockRowToSnapshot (YUK-471 W3-C3) are imported from the shared
// ./snapshot-mappers module above — the audit, the genesis backfill, and the parity assert all map
// through the SAME field-pick so the snapshot shape can't drift (esp. the question_block
// extracted_prompt_md strip, design §5.2).

// NOTE: the live-edge → snapshot mapper is the one EXPORTED from gather.ts (imported above), so
// the auditor maps the live edge row + builds the topology mesh through the EXACT same function
// the per-edge gather uses — a second local copy could drift and make the audit compare a
// different shape than the fold produced.

/**
 * Re-derive fold(events) for every live knowledge + knowledge_edge id and deep-diff against
 * the live row. Returns the AuditResult (non-allowlisted drift makes ok=false). READ-ONLY —
 * writes nothing. Importable so the DB test drives it against the testcontainer.
 *
 * NOTE: this checks every LIVE row. A fold that produces a row with NO live counterpart (a
 * projection that should exist but doesn't) is out of scope for the live-row scan — the
 * rebuild path covers materialization; the auditor's job is "does each live row match its
 * log". (The allowlist + DB test exercise both present→null and value drift.)
 */
export async function auditProjection(
  db: DbLike,
  allowlist: ProjectionAllowlist = {},
): Promise<AuditResult> {
  const drift: DriftRecord[] = [];
  const allowed: DriftRecord[] = [];

  // ── nodes ── narrow-column read (no embed_* vectors). The per-node gather still issues its
  // own Q1/Q2/Q3 + rate queries (O(N) round-trips); node-side batching is a future optimization
  // — the named full-table hotspot this pass eliminates is the edge mesh re-fetch (below).
  const nodes = await db.select(KNOWLEDGE_STRUCTURAL_COLUMNS).from(knowledge);
  for (const row of nodes) {
    const expected = await gatherAndFoldKnowledgeNode(db, row.id);
    const diffs = diffSnapshots(
      knowledgeRowToSnapshot(row),
      expected as Record<string, unknown> | null,
    );
    if (diffs.length > 0) {
      const rec: DriftRecord = { id: row.id, subject_kind: 'knowledge', diffs };
      (allowlist[row.id] ? allowed : drift).push(rec);
    }
  }

  // ── edges ── fetch the live topology mesh ONCE for the whole scan, not once per edge. The
  // per-edge gatherAndFoldKnowledgeEdge re-queries the ENTIRE live edge set on every call, so
  // folding all E edges was O(E²). In a READ-ONLY scan the live mesh is constant, so building it
  // once + gatherAndFoldKnowledgeEdgeWithMesh is byte-identical and O(E). The mesh is the live
  // (archived_at IS NULL) edges mapped via the SAME edgeRowToSnapshot the per-edge path uses;
  // checkEdgeTopology treats the mesh as a SET (graph reachability), so row order is irrelevant.
  const edges = await db.select().from(knowledge_edge);
  const liveMesh = edges.filter((e) => e.archived_at === null).map(edgeRowToSnapshot);
  for (const row of edges) {
    const expected = await gatherAndFoldKnowledgeEdgeWithMesh(db, row.id, liveMesh);
    const diffs = diffSnapshots(edgeRowToSnapshot(row), expected as Record<string, unknown> | null);
    if (diffs.length > 0) {
      const rec: DriftRecord = { id: row.id, subject_kind: 'knowledge_edge', diffs };
      (allowlist[row.id] ? allowed : drift).push(rec);
    }
  }

  // ── goals (YUK-471 W2) ── full-table fold-diff. goal has no derived columns, so the full row
  // is read + compared. The per-goal gatherAndFoldGoal issues its own Q1 + caused_by chain (no
  // mesh / reverse-index needed — goalId == proposal subject_id).
  const goals = await db.select().from(goal);
  for (const row of goals) {
    const expected = await gatherAndFoldGoal(db, row.id);
    const diffs = diffSnapshots(goalRowToSnapshot(row), expected as Record<string, unknown> | null);
    if (diffs.length > 0) {
      const rec: DriftRecord = { id: row.id, subject_kind: 'goal', diffs };
      (allowlist[row.id] ? allowed : drift).push(rec);
    }
  }

  // ── mistake_variant (YUK-471 W2) ── full-table fold-diff. No derived columns, so the full row is
  // read + compared. The per-variant gatherAndFoldMistakeVariant issues its own Q1 (base) + the
  // caused_by chain (no mesh / reverse-index — mvId == subject_id). The fold-blind cause_category is
  // reproduced from the base event; a row whose cause_category drifts from its base seed is DRIFT.
  const mistakeVariants = await db.select().from(mistake_variant);
  for (const row of mistakeVariants) {
    const expected = await gatherAndFoldMistakeVariant(db, row.id);
    const diffs = diffSnapshots(
      mistakeVariantRowToSnapshot(row),
      expected as Record<string, unknown> | null,
    );
    if (diffs.length > 0) {
      const rec: DriftRecord = { id: row.id, subject_kind: 'mistake_variant', diffs };
      (allowlist[row.id] ? allowed : drift).push(rec);
    }
  }

  // ── learning_item (YUK-471 W2) ── narrow-column read (excludes child_learning_item_ids / ai_score
  // / due_at / reviewed_at — design §3①). The per-item gatherAndFoldLearningItem issues a single Q1
  // (subject-keyed: genesis + the complete/relearn/archive action events; no mesh/reverse-index/
  // caused_by — itemId == subject_id and each item folds independently). A row that differs from
  // fold(events) on a snapshot column is DRIFT; a difference only in an excluded column never enters
  // the diff (those columns are absent from both the SELECT and the snapshot).
  const learningItems = await db.select(LEARNING_ITEM_STRUCTURAL_COLUMNS).from(learning_item);
  for (const row of learningItems) {
    const expected = await gatherAndFoldLearningItem(db, row.id);
    const diffs = diffSnapshots(
      learningItemRowToSnapshot(row),
      expected as Record<string, unknown> | null,
    );
    if (diffs.length > 0) {
      const rec: DriftRecord = { id: row.id, subject_kind: 'learning_item', diffs };
      (allowlist[row.id] ? allowed : drift).push(rec);
    }
  }

  // ── artifact (YUK-471 W3-C3) ── full-table fold-diff. artifact has NO derived/embed columns
  // (design §5.1), so the FULL row is read + compared. The per-artifact gatherAndFoldArtifact issues a
  // single Q1 (subject-keyed: genesis / artifact_create base + body_blocks_edit / artifact_lifecycle /
  // note_refine_apply|undo mutations — every artifact event keys on the artifact's own id; no mesh /
  // reverse-index / caused_by, design §5.3). A row that differs from fold(events) is DRIFT.
  const artifacts = await db.select().from(artifact);
  for (const row of artifacts) {
    const expected = await gatherAndFoldArtifact(db, row.id);
    const diffs = diffSnapshots(
      artifactRowToSnapshot(row),
      expected as Record<string, unknown> | null,
    );
    if (diffs.length > 0) {
      const rec: DriftRecord = { id: row.id, subject_kind: 'artifact', diffs };
      (allowlist[row.id] ? allowed : drift).push(rec);
    }
  }

  // ── question_block (YUK-471 W3-C3) ── full-table fold-diff, EXCLUDING the legacy extracted_prompt_md
  // column (design §5.2 — not fold truth). The per-block gatherAndFoldQuestionBlock issues Q1 (genesis /
  // question_block_create base + edit-as-primary) + Q2 (the merge reverse query: an edit keyed on the
  // PRIMARY block absorbs this block as a merged_source via the top-level payload @> containment that
  // hits the W3-C0 event_payload_idx GIN). A row that differs from fold(events) on a fold-truth column
  // is DRIFT; a difference only in extracted_prompt_md never enters the diff (absent from the snapshot).
  const questionBlocks = await db.select().from(question_block);
  for (const row of questionBlocks) {
    const expected = await gatherAndFoldQuestionBlock(db, row.id);
    const diffs = diffSnapshots(
      questionBlockRowToSnapshot(row),
      expected as Record<string, unknown> | null,
    );
    if (diffs.length > 0) {
      const rec: DriftRecord = { id: row.id, subject_kind: 'question_block', diffs };
      (allowlist[row.id] ? allowed : drift).push(rec);
    }
  }

  return {
    ok: drift.length === 0,
    checkedNodes: nodes.length,
    checkedEdges: edges.length,
    checkedGoals: goals.length,
    checkedMistakeVariants: mistakeVariants.length,
    checkedLearningItems: learningItems.length,
    checkedArtifacts: artifacts.length,
    checkedQuestionBlocks: questionBlocks.length,
    drift,
    allowed,
  };
}

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json');
  const allowlist = loadAllowlist();
  const result = await auditProjection(db, allowlist);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `audit:projection — checked ${result.checkedNodes} node(s) + ${result.checkedEdges} edge(s) + ${result.checkedGoals} goal(s) + ${result.checkedMistakeVariants} mistake_variant(s) + ${result.checkedLearningItems} learning_item(s) + ${result.checkedArtifacts} artifact(s) + ${result.checkedQuestionBlocks} question_block(s).`,
    );
    if (result.allowed.length > 0) {
      console.log(`\nALLOWED drift (covered by allowlist):  ${result.allowed.length}`);
      for (const r of result.allowed) {
        console.log(`  - ${r.subject_kind} ${r.id}: ${r.diffs.join('; ')}`);
      }
    }
    if (result.drift.length === 0) {
      console.log('\nDRIFT (live row != fold(events)):  (none) — projection in sync.');
    } else {
      console.log(`\nDRIFT (live row != fold(events)):  ${result.drift.length}`);
      for (const r of result.drift) {
        console.log(`  - ${r.subject_kind} ${r.id}:`);
        for (const d of r.diffs) console.log(`      ${d}`);
      }
      console.log(
        '\nA drifted row means the live projection disagrees with its source-of-truth event ' +
          'log. Either an out-of-band write bypassed the projection (rebuild it: ' +
          'pnpm rebuild:projection) or a gather/fold bug is dropping a mutation. If the drift ' +
          'is intentional, add the id to scripts/audit-projection-allowlist.json with a ' +
          'reason + resolves_when.',
      );
    }
  }

  if (!result.ok) process.exit(1);
}

// CLI-gate: only run + exit as the CLI entry point so the DB test can import auditProjection
// without the top-level scan firing.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[audit-projection] failed:', err);
      process.exit(1);
    });
}
