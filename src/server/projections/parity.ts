// Accept-time projection parity assert. After a live write, the caller gathers and folds
// the same id read-only and compares the result with the row just written, inside the
// same transaction.
//
// Severity is environment-switched: production logs structured field names and returns so
// a projection bug never breaks a user's accept; dev and test throw so drift fails loudly.
// The diff helper is shared with the offline audit so both agree on what "fold == row" means.

import { and, eq, inArray, or } from 'drizzle-orm';
import type {
  ArtifactRowSnapshotT,
  GoalRowSnapshotT,
  KnowledgeEdgeRowSnapshotT,
  KnowledgeRowSnapshotT,
  LearningItemRowSnapshotT,
  MistakeVariantRowSnapshotT,
  QuestionBlockRowSnapshotT,
} from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { event, materialized_id_index } from '@/db/schema';
import { gatherAndFoldArtifact } from '@/kernel/records/artifact-history';
import { gatherAndFoldLearningItem } from '@/kernel/records/learning-items';
import { gatherAndFoldMistakeVariant } from '@/kernel/records/mistake-variant-facts';
import {
  gatherAndFoldGoal,
  gatherAndFoldKnowledgeEdge,
  gatherAndFoldKnowledgeNode,
  gatherAndFoldQuestionBlock,
} from './gather';
import { diffSnapshots } from './snapshot-diff';

export { knowledgeLiveRowToSnapshot } from '@/kernel/records/knowledge-node-history';
export { hasLearningItemGenesisAnchor } from '@/kernel/records/learning-items';
// Canonical implementation; retained for the retract-clock DB consumer.
export { mistakeVariantLiveRowToSnapshot } from '@/kernel/records/mistake-variant-facts';

type DbLike = Db | Tx;

/** Which fold the mismatch came from (for the structured warn / thrown message). */
type ParitySubjectKind =
  | 'knowledge'
  | 'knowledge_edge'
  | 'goal'
  | 'mistake_variant'
  | 'learning_item'
  | 'artifact'
  | 'question_block';

// Value-free field name (or whole-row sentinel) from one diff line, for the prod warn.
// Whole-row sentinels are angle-bracketed and may contain their own colon, so match the
// whole `<...>` token. Column names never contain '<'.
function diffFieldName(line: string): string {
  if (line.startsWith('<')) {
    const end = line.indexOf('>');
    if (end !== -1) return line.slice(0, end + 1);
  }
  return line.split(':', 1)[0] ?? line;
}

// Dev/test throw; production logs and returns (see file header).
function onParityMismatch(subjectKind: ParitySubjectKind, id: string, diff: string[]): void {
  const diffText = diff.join('; ');
  if (process.env.NODE_ENV === 'production') {
    // Log field names and count only; values are user content. Full detail stays in the
    // dev/test message and the offline audit.
    console.warn('[projection-parity] fold != live row', {
      subject_kind: subjectKind,
      id,
      diff_fields: diff.map(diffFieldName),
      diff_count: diff.length,
    });
    return;
  }
  throw new Error(
    `[projection-parity] ${subjectKind} ${id}: fold(events) != live row — ${diffText}`,
  );
}

// The only edge actions that can seed a row: generate create/archive and the genesis
// backfill. Must stay in step with the backfill skip predicate and the fold.
const KNOWLEDGE_EDGE_ANCHOR_ACTIONS = ['generate', 'experimental:genesis'] as const;

/**
 * Batch anchor gate for edges: an anchor-action event or an index anchor. A live edge with
 * neither is an out-of-band insert, so the audit skips it instead of reporting a false
 * GHOST/MISSING. The action filter matters: an unanchored legacy edge with only a propose
 * event is still fold-blind.
 */
export async function knowledgeEdgesWithGenesisAnchor(
  db: DbLike,
  edgeIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (edgeIds.length === 0) return out;
  const evRows = await db
    .select({ subject_id: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'knowledge_edge'),
        inArray(event.subject_id, edgeIds),
        inArray(event.action, [...KNOWLEDGE_EDGE_ANCHOR_ACTIONS]),
      ),
    );
  for (const r of evRows) out.add(r.subject_id);
  const idxRows = await db
    .select({ materialized_id: materialized_id_index.materialized_id })
    .from(materialized_id_index)
    .where(
      and(
        inArray(materialized_id_index.materialized_id, edgeIds),
        eq(materialized_id_index.subject_kind, 'knowledge_edge'),
      ),
    );
  for (const r of idxRows) out.add(r.materialized_id);
  return out;
}

// ── goal genesis-anchor helpers ────────────────────────────────────────────────────────────────
//
// A goal is event-sourced when it has a genesis seed, a goal_scope proposal, or an index
// anchor. Status/scope updates are deliberately not anchors: the fold applies them only to
// an existing row, so counting them would let the guarded writer delete a live goal and the
// backfill skip it.
const GOAL_ANCHOR_ACTIONS = ['experimental:genesis', 'experimental:proposal'] as const;

/** Whether a goal has an anchor the fold can reproduce. */
export async function hasGoalGenesisAnchor(db: DbLike, goalId: string): Promise<boolean> {
  const ev = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'goal'),
        eq(event.subject_id, goalId),
        inArray(event.action, [...GOAL_ANCHOR_ACTIONS]),
      ),
    )
    .limit(1);
  if (ev.length > 0) return true;
  const indexed = await db
    .select({ id: materialized_id_index.materialized_id })
    .from(materialized_id_index)
    .where(
      and(
        eq(materialized_id_index.materialized_id, goalId),
        eq(materialized_id_index.subject_kind, 'goal'),
      ),
    )
    .limit(1);
  return indexed.length > 0;
}

/** Batch form; also serves as the backfill's idempotency pre-scan. */
export async function goalsWithGenesisAnchor(db: DbLike, goalIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (goalIds.length === 0) return out;
  const evRows = await db
    .select({ subject_id: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'goal'),
        inArray(event.subject_id, goalIds),
        inArray(event.action, [...GOAL_ANCHOR_ACTIONS]),
      ),
    );
  for (const r of evRows) out.add(r.subject_id);
  const idxRows = await db
    .select({ materialized_id: materialized_id_index.materialized_id })
    .from(materialized_id_index)
    .where(
      and(
        inArray(materialized_id_index.materialized_id, goalIds),
        eq(materialized_id_index.subject_kind, 'goal'),
      ),
    );
  for (const r of idxRows) out.add(r.materialized_id);
  return out;
}

/**
 * Assert that the node fold reproduces the live row. The gather is wrapped so a reducer
 * throw follows the same dev-throw/prod-log path as a mismatch instead of aborting a live
 * accept. Pass the transaction that performed the write.
 */
export async function assertKnowledgeNodeParity(
  db: DbLike,
  nodeId: string,
  liveRow: KnowledgeRowSnapshotT | null,
): Promise<void> {
  let folded: KnowledgeRowSnapshotT | null;
  try {
    folded = await gatherAndFoldKnowledgeNode(db, nodeId);
  } catch (err) {
    // Route reducer/gather throws through the same switch as a mismatch.
    onParityMismatch('knowledge', nodeId, [
      `<fold-threw>: ${err instanceof Error ? err.message : String(err)}`,
    ]);
    return;
  }
  const diff = diffSnapshots(
    liveRow as Record<string, unknown> | null,
    folded as Record<string, unknown> | null,
  );
  if (diff.length > 0) onParityMismatch('knowledge', nodeId, diff);
}

/**
 * Assert that the edge fold reproduces the live row. The imperative edge path does not gate
 * topology, so a topology reject from the fold follows the same dev-throw/prod-log path as
 * a mismatch instead of aborting the accept.
 */
export async function assertKnowledgeEdgeParity(
  db: DbLike,
  edgeId: string,
  liveRow: KnowledgeEdgeRowSnapshotT | null,
): Promise<void> {
  let folded: KnowledgeEdgeRowSnapshotT | null;
  try {
    folded = await gatherAndFoldKnowledgeEdge(db, edgeId);
  } catch (err) {
    // Tag a topology reject distinctly from a generic reducer throw: production only warns,
    // and an operator needs to tell a data-integrity gap from a projection bug.
    const msg = err instanceof Error ? err.message : String(err);
    const isTopologyReject = /topology|cycle|prerequisite|direction/i.test(msg);
    onParityMismatch('knowledge_edge', edgeId, [
      `<fold-threw${isTopologyReject ? ':topology' : ''}>: ${msg}`,
    ]);
    return;
  }
  const diff = diffSnapshots(
    liveRow as Record<string, unknown> | null,
    folded as Record<string, unknown> | null,
  );
  if (diff.length > 0) onParityMismatch('knowledge_edge', edgeId, diff);
}

// ── goal parity assert ────────────────────────────────────────────────────────────────────────
//
// Write-time fold==row guard for the goal sites, mirroring the node assert. Callers must
// only assert event-sourced goals; a pre-event goal folds to null and would false-mismatch.

/** Pick snapshot fields from a live goal row without Zod parsing. */
export function goalLiveRowToSnapshot(row: {
  id: string;
  title: string;
  subject_id: string | null;
  scope_knowledge_ids: string[] | null;
  scope_mode: 'explicit' | 'subject_live';
  sequence_hint: number;
  declared_stage: 'middle_school' | 'high_school' | 'university' | 'custom' | null;
  status: 'active' | 'dormant' | 'done';
  source: string;
  source_ref: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
}): GoalRowSnapshotT {
  return {
    id: row.id,
    title: row.title,
    subject_id: row.subject_id,
    scope_knowledge_ids: row.scope_knowledge_ids ?? [],
    // NOT NULL with a default; the fold materializes the same value for legacy payloads.
    scope_mode: row.scope_mode,
    sequence_hint: row.sequence_hint,
    // Nullable; the fold materializes NULL for legacy payloads too, so surface it verbatim.
    declared_stage: row.declared_stage,
    status: row.status,
    source: row.source,
    source_ref: row.source_ref,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
  };
}

/** Assert that the goal fold reproduces the live row; see the node assert for throw handling. */
export async function assertGoalParity(
  db: DbLike,
  goalId: string,
  liveRow: GoalRowSnapshotT | null,
): Promise<void> {
  let folded: GoalRowSnapshotT | null;
  try {
    folded = await gatherAndFoldGoal(db, goalId);
  } catch (err) {
    onParityMismatch('goal', goalId, [
      `<fold-threw>: ${err instanceof Error ? err.message : String(err)}`,
    ]);
    return;
  }
  const diff = diffSnapshots(
    liveRow as Record<string, unknown> | null,
    folded as Record<string, unknown> | null,
  );
  if (diff.length > 0) onParityMismatch('goal', goalId, diff);
}

// ── mistake_variant parity assert ─────────────────────────────────────────────────────────────
//
// Write-time fold==row guard for the variant sites, especially the fold-blind
// cause_category, which must be on the base event. Callers only assert anchored variants.

/** Assert that the variant fold reproduces the live row; see the node assert for throw handling. */
export async function assertMistakeVariantParity(
  db: DbLike,
  mvId: string,
  liveRow: MistakeVariantRowSnapshotT | null,
): Promise<void> {
  let folded: MistakeVariantRowSnapshotT | null;
  try {
    folded = await gatherAndFoldMistakeVariant(db, mvId);
  } catch (err) {
    onParityMismatch('mistake_variant', mvId, [
      `<fold-threw>: ${err instanceof Error ? err.message : String(err)}`,
    ]);
    return;
  }
  const diff = diffSnapshots(
    liveRow as Record<string, unknown> | null,
    folded as Record<string, unknown> | null,
  );
  if (diff.length > 0) onParityMismatch('mistake_variant', mvId, diff);
}

// ── learning_item parity assert ────────────────────────────────────────────────────────────────
//
// Write-time fold==row guard for the item sites. Callers assert only anchored items; the
// excluded derived columns are absent from the snapshot, so they never enter the diff.

/**
 * Pick snapshot fields from a live item row without Zod parsing; excludes the derived
 * columns the fold does not own.
 */
export function learningItemLiveRowToSnapshot(row: {
  id: string;
  source: string;
  source_ref: string | null;
  title: string;
  content: string;
  knowledge_ids: string[] | null;
  primary_artifact_id: string | null;
  parent_learning_item_id: string | null;
  status: string;
  user_pinned: boolean;
  completed_at: Date | null;
  dismissed_at: Date | null;
  archived_at: Date | null;
  archived_reason: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
}): LearningItemRowSnapshotT {
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

/** Assert that the item fold reproduces the live row; see the node assert for throw handling. */
export async function assertLearningItemParity(
  db: DbLike,
  itemId: string,
  liveRow: LearningItemRowSnapshotT | null,
): Promise<void> {
  let folded: LearningItemRowSnapshotT | null;
  try {
    folded = await gatherAndFoldLearningItem(db, itemId);
  } catch (err) {
    onParityMismatch('learning_item', itemId, [
      `<fold-threw>: ${err instanceof Error ? err.message : String(err)}`,
    ]);
    return;
  }
  const diff = diffSnapshots(
    liveRow as Record<string, unknown> | null,
    folded as Record<string, unknown> | null,
  );
  if (diff.length > 0) onParityMismatch('learning_item', itemId, diff);
}

// ── artifact genesis-anchor helpers ───────────────────────────────────────────────────────────
//
export { artifactsWithGenesisAnchor } from '@/kernel/records/artifact-history';

export {
  hasQuestionBlockGenesisAnchor,
  questionBlocksWithGenesisAnchor,
} from '@/kernel/records/question-block-projection';

// ── item_calibration genesis-anchor helpers ───────────────────────────────────────────────────
//
// A calibration row is event-sourced only through its genesis anchor; the table has no
// runtime mutation events. It has no index anchor for the same reason as question_block.

const ITEM_CALIBRATION_ANCHOR_ACTIONS = ['experimental:genesis'] as const;

/** Whether a calibration row has a genesis anchor the fold can reproduce. */
export async function hasItemCalibrationGenesisAnchor(db: DbLike, rowId: string): Promise<boolean> {
  const ev = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'item_calibration'),
        eq(event.subject_id, rowId),
        inArray(event.action, [...ITEM_CALIBRATION_ANCHOR_ACTIONS]),
      ),
    )
    .limit(1);
  return ev.length > 0;
}

/** Batch form (event leg only); also serves as the idempotency pre-scan. */
export async function itemCalibrationsWithGenesisAnchor(
  db: DbLike,
  rowIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (rowIds.length === 0) return out;
  const evRows = await db
    .select({ subject_id: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'item_calibration'),
        inArray(event.subject_id, rowIds),
        inArray(event.action, [...ITEM_CALIBRATION_ANCHOR_ACTIONS]),
      ),
    );
  for (const r of evRows) out.add(r.subject_id);
  return out;
}

// ── artifact parity assert ───────────────────────────────────────────────────────────────────
//
// Write-time fold==row guard for the artifact sites. Callers assert only anchored artifacts;
// an edit against a pre-event artifact is skipped.

// The shared mapper lives in artifact-history so audit, backfill, and parity cannot drift.
// Re-exported under the name existing callers import.
export { artifactRowToSnapshot as artifactLiveRowToSnapshot } from '@/kernel/records/artifact-history';

/** Assert that the artifact fold reproduces the live row; see the node assert for throw handling. */
export async function assertArtifactParity(
  db: DbLike,
  artifactId: string,
  liveRow: ArtifactRowSnapshotT | null,
): Promise<void> {
  let folded: ArtifactRowSnapshotT | null;
  try {
    folded = await gatherAndFoldArtifact(db, artifactId);
  } catch (err) {
    onParityMismatch('artifact', artifactId, [
      `<fold-threw>: ${err instanceof Error ? err.message : String(err)}`,
    ]);
    return;
  }
  const diff = diffSnapshots(
    liveRow as Record<string, unknown> | null,
    folded as Record<string, unknown> | null,
  );
  if (diff.length > 0) onParityMismatch('artifact', artifactId, diff);
}

// ── question_block parity assert ──────────────────────────────────────────────────────────────
//
// Write-time fold==row guard for the block sites. The legacy extracted_prompt_md column is
// omitted from the snapshot, so a row differing only there folds clean. Callers assert only
// anchored blocks.

// The shared mapper (including the legacy column strip) lives in snapshot-mappers so audit,
// backfill, and parity cannot drift. Re-exported under the name existing callers import.
export { questionBlockRowToSnapshot as questionBlockLiveRowToSnapshot } from './snapshot-mappers';

/** Assert that the block fold reproduces the live row; see the node assert for throw handling. */
export async function assertQuestionBlockParity(
  db: DbLike,
  blockId: string,
  liveRow: QuestionBlockRowSnapshotT | null,
): Promise<void> {
  let folded: QuestionBlockRowSnapshotT | null;
  try {
    folded = await gatherAndFoldQuestionBlock(db, blockId);
  } catch (err) {
    onParityMismatch('question_block', blockId, [
      `<fold-threw>: ${err instanceof Error ? err.message : String(err)}`,
    ]);
    return;
  }
  const diff = diffSnapshots(
    liveRow as Record<string, unknown> | null,
    folded as Record<string, unknown> | null,
  );
  if (diff.length > 0) onParityMismatch('question_block', blockId, diff);
}
