// Exhaustive projection adapter registry: one record per kind, replacing the former
// per-entity branch sets in the audit, rebuild, and gate scripts. A missing kind is a
// compile error, so an entity cannot be silently omitted from rebuild or gating.
//
// Adapters reuse the existing write-through shells and anchor helpers; they add no fold
// logic. A new entity is wired by adding one adapter.

import { and, eq, inArray } from 'drizzle-orm';
import { ARTIFACT_STATE_ACTIONS } from '@/core/projections/artifact';
import type { Db, Tx } from '@/db/client';
import {
  artifact,
  event,
  goal,
  item_calibration,
  knowledge,
  knowledge_edge,
  learning_item,
  materialized_id_index,
  mistake_variant,
  question_block,
} from '@/db/schema';
import {
  artifactRowToSnapshot,
  artifactsWithGenesisAnchor,
  gatherAndFoldArtifact,
  projectArtifactGuarded,
} from '@/kernel/records/artifact-history';
import { projectKnowledgeEdge } from '@/kernel/records/knowledge-edge-facts';
import {
  gatherAndFoldKnowledgeNode,
  knowledgeLiveRowToSnapshot,
  knowledgeNodesWithGenesisAnchor,
  prefetchKnowledgeMergeEvents,
  prefetchKnowledgeRates,
} from '@/kernel/records/knowledge-node-history';
import { projectKnowledgeNode } from '@/kernel/records/knowledge-node-materialization';
import {
  gatherAndFoldLearningItem,
  learningItemsWithGenesisAnchor,
  prefetchLearningItemMergeEvents,
  projectLearningItemGuarded,
} from '@/kernel/records/learning-items';
import {
  gatherAndFoldMistakeVariant,
  mistakeVariantLiveRowToSnapshot,
  mistakeVariantsWithGenesisAnchor,
  projectMistakeVariantGuarded,
} from '@/kernel/records/mistake-variant-facts';
import {
  edgeRowToSnapshot,
  gatherAndFoldGoal,
  gatherAndFoldItemCalibration,
  gatherAndFoldKnowledgeEdgeWithMesh,
  gatherAndFoldQuestionBlock,
} from './gather';
import { projectGoalGuarded } from './goal';
import { projectItemCalibrationGuarded } from './item_calibration';
import {
  goalLiveRowToSnapshot,
  goalsWithGenesisAnchor,
  itemCalibrationsWithGenesisAnchor,
  knowledgeEdgesWithGenesisAnchor,
  learningItemLiveRowToSnapshot,
  questionBlocksWithGenesisAnchor,
} from './parity';
import { PROJECTION_FOLDS, type PureFold } from './projection-folds';
import { projectQuestionBlockGuarded } from './question_block';
import { itemCalibrationRowToSnapshot, questionBlockRowToSnapshot } from './snapshot-mappers';
import type { ProjectionEntity } from './sot-flag';

type DbLike = Db | Tx;

// Structural read columns: the knowledge scan omits embed_*; the learning_item scan omits
// derived columns the fold does not own. tsc ties each set to its mapper at the
// gatherWithContext call site.
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

export type ProjectionKind =
  | 'knowledge'
  | 'knowledge_edge'
  | 'goal'
  | 'mistake_variant'
  | 'learning_item'
  | 'artifact'
  | 'question_block'
  | 'item_calibration';

export const ALL_PROJECTION_KINDS = [
  'knowledge',
  'knowledge_edge',
  'goal',
  'mistake_variant',
  'learning_item',
  'artifact',
  'question_block',
  'item_calibration',
] as const satisfies readonly ProjectionKind[];

/**
 * FK-forced transaction clusters for rebuild. Kinds in one cluster share a single
 * transaction and are applied in array order (parent before child), so a reject rolls
 * back only that cluster. `knowledge_edge` references `knowledge`, so those two form one
 * cluster; every other kind is independent.
 *
 * The `satisfies` plus the compile-time coverage check make a missing kind a type error;
 * the module-load check catches duplicates.
 */
export const PROJECTION_FK_CLUSTERS = [
  ['knowledge', 'knowledge_edge'],
  ['goal'],
  ['mistake_variant'],
  ['learning_item'],
  ['artifact'],
  ['question_block'],
  ['item_calibration'],
] as const satisfies readonly (readonly ProjectionKind[])[];

// Compile-time: every ProjectionKind must appear in the clusters.
type ClusterCoveredKind = (typeof PROJECTION_FK_CLUSTERS)[number][number];
type AssertNever<T extends never> = T;
export type _AssertClustersCoverEveryKind = AssertNever<
  Exclude<ProjectionKind, ClusterCoveredKind>
>;

// Runtime: no duplicates and exact coverage; the type check cannot catch a kind listed twice.
{
  const flat = PROJECTION_FK_CLUSTERS.flat();
  const set = new Set<ProjectionKind>(flat);
  if (flat.length !== ALL_PROJECTION_KINDS.length || set.size !== ALL_PROJECTION_KINDS.length) {
    throw new Error(
      `PROJECTION_FK_CLUSTERS must cover every ProjectionKind exactly once (got [${flat.join(', ')}])`,
    );
  }
}

export interface ProjectionAdapter {
  kind: ProjectionKind;
  /** Explicit writer policy identity; no implicit global mode. */
  flagEntity: ProjectionEntity;
  /** live row ids from the materialized table. */
  liveIds(db: DbLike): Promise<Set<string>>;
  /**
   * The extra id universe for GHOST detection: this kind's event subjects, plus index
   * anchors for kinds that write `materialized_id_index`. question_block has no minting
   * indirection, so it is event-subject-only.
   */
  eventSubjectIds(db: DbLike): Promise<Set<string>>;
  /** The existing write-through shell for this kind (guarded for canonical writers). */
  project(db: DbLike, id: string): Promise<void>;
  /** Batch applicability gate: the subset of ids that are event-sourced (foldable). */
  withGenesisAnchor(db: DbLike, ids: string[]): Promise<Set<string>>;
  /** Live row to structural snapshot, shared by parity, audits, and golden capture. */
  toSnapshot(row: unknown): Record<string, unknown>;
  /** The pure reducer for this kind, sourced from the DB-free PROJECTION_FOLDS registry. */
  fold: PureFold;
  /** One per-kind read+fold pass: live snapshots plus a prefetch-primed per-id fold. */
  gatherWithContext(db: DbLike): Promise<KindScanData>;
}

/** Per-kind read+fold context: live snapshots plus a fold closure primed with any prefetch
 * or mesh. `foldOne` propagates reducer throws; the symmetric audit isolates them per id. */
export interface KindScanData {
  liveSnapshots: Map<string, Record<string, unknown>>;
  foldOne: (id: string) => Promise<Record<string, unknown> | null>;
}

type FoldOne = (id: string) => Promise<Record<string, unknown> | null>;

// Bind a per-kind live-row read to its snapshot mapper and fold-context builder. The Row
// generic ties the read's row type to both the mapper and makeFoldOne, so a schema/column
// mismatch is a compile error. The returned gatherWithContext builds the snapshot map and
// the primed foldOne in one read pass.
function defineScan<Row extends { id: string }>(def: {
  // PromiseLike lets a drizzle select builder assign without an async wrapper; await unwraps it.
  readLiveRows: (db: DbLike) => PromiseLike<Row[]>;
  toSnapshot: (row: Row) => Record<string, unknown>;
  makeFoldOne: (db: DbLike, rows: Row[]) => Promise<FoldOne>;
}): Pick<ProjectionAdapter, 'toSnapshot' | 'gatherWithContext'> {
  // The adapter's toSnapshot is the same builder gatherWithContext uses, not a parallel copy.
  const toSnapshot = (row: unknown): Record<string, unknown> => def.toSnapshot(row as Row);
  return {
    toSnapshot,
    gatherWithContext: async (db) => {
      const rows = await def.readLiveRows(db);
      const liveSnapshots = new Map<string, Record<string, unknown>>();
      for (const row of rows) liveSnapshots.set(row.id, toSnapshot(row));
      const foldOne = await def.makeFoldOne(db, rows);
      return { liveSnapshots, foldOne };
    },
  };
}

// event.subject_id set for a kind, optionally unioned with index anchors. Deliberately
// unbounded: the id universe is the whole point, and a LIMIT would blind ghost detection.
// Boundedness comes from the single-user deployment envelope; only distinct ids are kept.
async function eventSubjectIdSet(
  db: DbLike,
  kind: ProjectionKind,
  writesIndex: boolean,
): Promise<Set<string>> {
  const out = new Set<string>();
  const evRows = await db
    .select({ subject_id: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, kind),
        kind === 'artifact' ? inArray(event.action, [...ARTIFACT_STATE_ACTIONS]) : undefined,
      ),
    );
  for (const r of evRows) out.add(r.subject_id);
  if (kind === 'question_block') {
    // A merge/edit names secondary blocks only in its payload; they still have history.
    const edits = await db
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.action, 'experimental:edit_question_block_structured'));
    for (const { payload } of edits) {
      const affected = (payload as { affected_blocks?: unknown }).affected_blocks;
      if (!Array.isArray(affected)) continue;
      for (const block of affected) {
        if (block && typeof block.block_id === 'string') out.add(block.block_id);
      }
    }
  }
  if (writesIndex) {
    const idxRows = await db
      .select({ materialized_id: materialized_id_index.materialized_id })
      .from(materialized_id_index)
      .where(eq(materialized_id_index.subject_kind, kind));
    for (const r of idxRows) out.add(r.materialized_id);
  }
  return out;
}

// One factory for the identical liveIds closure over the shared text id PK; the explicit
// per-kind record below keeps the exhaustiveness guarantee.
type ProjectionTable =
  | typeof knowledge
  | typeof knowledge_edge
  | typeof goal
  | typeof mistake_variant
  | typeof learning_item
  | typeof artifact
  | typeof question_block
  | typeof item_calibration;

function liveIdsFrom(table: ProjectionTable): (db: DbLike) => Promise<Set<string>> {
  return async (db) => {
    // Annotation, not a cast: a future table whose id is not text fails here at compile time.
    const rows: { id: string }[] = await db.select({ id: table.id }).from(table);
    return new Set(rows.map((r) => r.id));
  };
}

export const PROJECTION_ENTITIES: Record<ProjectionKind, ProjectionAdapter> = {
  knowledge: {
    kind: 'knowledge',
    flagEntity: 'knowledge',
    liveIds: liveIdsFrom(knowledge),
    eventSubjectIds: (db) => eventSubjectIdSet(db, 'knowledge', true),
    project: projectKnowledgeNode,
    withGenesisAnchor: knowledgeNodesWithGenesisAnchor,
    fold: PROJECTION_FOLDS.knowledge,
    ...defineScan({
      readLiveRows: (db) => db.select(KNOWLEDGE_STRUCTURAL_COLUMNS).from(knowledge),
      toSnapshot: (row) => knowledgeLiveRowToSnapshot(row) as Record<string, unknown>,
      // Prefetch the node-independent merge and rate legs once for the whole scan.
      makeFoldOne: async (db) => {
        const merges = await prefetchKnowledgeMergeEvents(db);
        const rates = await prefetchKnowledgeRates(db);
        return (id) =>
          gatherAndFoldKnowledgeNode(db, id, merges, rates) as Promise<Record<
            string,
            unknown
          > | null>;
      },
    }),
  },
  knowledge_edge: {
    kind: 'knowledge_edge',
    flagEntity: 'knowledge_edge',
    liveIds: liveIdsFrom(knowledge_edge),
    eventSubjectIds: (db) => eventSubjectIdSet(db, 'knowledge_edge', true),
    project: projectKnowledgeEdge,
    withGenesisAnchor: knowledgeEdgesWithGenesisAnchor,
    fold: PROJECTION_FOLDS.knowledge_edge,
    ...defineScan({
      readLiveRows: (db) => db.select().from(knowledge_edge),
      toSnapshot: (row) => edgeRowToSnapshot(row) as Record<string, unknown>,
      // The mesh comes from the same read as the snapshot map (O(E), not O(E²)).
      makeFoldOne: async (db, rows) => {
        const mesh = rows.filter((e) => e.archived_at === null).map(edgeRowToSnapshot);
        return (id) =>
          gatherAndFoldKnowledgeEdgeWithMesh(db, id, mesh) as Promise<Record<
            string,
            unknown
          > | null>;
      },
    }),
  },
  goal: {
    kind: 'goal',
    flagEntity: 'goal',
    liveIds: liveIdsFrom(goal),
    eventSubjectIds: (db) => eventSubjectIdSet(db, 'goal', true),
    project: projectGoalGuarded,
    withGenesisAnchor: goalsWithGenesisAnchor,
    fold: PROJECTION_FOLDS.goal,
    ...defineScan({
      readLiveRows: (db) => db.select().from(goal),
      toSnapshot: (row) => goalLiveRowToSnapshot(row) as Record<string, unknown>,
      makeFoldOne: async (db) => (id) =>
        gatherAndFoldGoal(db, id) as Promise<Record<string, unknown> | null>,
    }),
  },
  mistake_variant: {
    kind: 'mistake_variant',
    flagEntity: 'mistake_variant',
    liveIds: liveIdsFrom(mistake_variant),
    eventSubjectIds: (db) => eventSubjectIdSet(db, 'mistake_variant', true),
    project: projectMistakeVariantGuarded,
    withGenesisAnchor: mistakeVariantsWithGenesisAnchor,
    fold: PROJECTION_FOLDS.mistake_variant,
    ...defineScan({
      readLiveRows: (db) => db.select().from(mistake_variant),
      toSnapshot: (row) => mistakeVariantLiveRowToSnapshot(row) as Record<string, unknown>,
      makeFoldOne: async (db) => (id) =>
        gatherAndFoldMistakeVariant(db, id) as Promise<Record<string, unknown> | null>,
    }),
  },
  learning_item: {
    kind: 'learning_item',
    flagEntity: 'learning_item',
    liveIds: liveIdsFrom(learning_item),
    eventSubjectIds: (db) => eventSubjectIdSet(db, 'learning_item', true),
    project: projectLearningItemGuarded,
    withGenesisAnchor: learningItemsWithGenesisAnchor,
    fold: PROJECTION_FOLDS.learning_item,
    ...defineScan({
      readLiveRows: (db) => db.select(LEARNING_ITEM_STRUCTURAL_COLUMNS).from(learning_item),
      toSnapshot: (row) => learningItemLiveRowToSnapshot(row) as Record<string, unknown>,
      // Prefetch the item-independent merge legs once for the whole scan.
      makeFoldOne: async (db) => {
        const prefetched = await prefetchLearningItemMergeEvents(db);
        return (id) =>
          gatherAndFoldLearningItem(db, id, prefetched) as Promise<Record<string, unknown> | null>;
      },
    }),
  },
  artifact: {
    kind: 'artifact',
    flagEntity: 'artifact',
    liveIds: liveIdsFrom(artifact),
    eventSubjectIds: (db) => eventSubjectIdSet(db, 'artifact', true),
    project: projectArtifactGuarded,
    withGenesisAnchor: artifactsWithGenesisAnchor,
    fold: PROJECTION_FOLDS.artifact,
    ...defineScan({
      readLiveRows: (db) => db.select().from(artifact),
      toSnapshot: (row) => artifactRowToSnapshot(row) as Record<string, unknown>,
      makeFoldOne: async (db) => (id) =>
        gatherAndFoldArtifact(db, id) as Promise<Record<string, unknown> | null>,
    }),
  },
  question_block: {
    kind: 'question_block',
    flagEntity: 'question_block',
    liveIds: liveIdsFrom(question_block),
    // question_block has no minting indirection, so its universe is event-subject-only.
    eventSubjectIds: (db) => eventSubjectIdSet(db, 'question_block', false),
    project: projectQuestionBlockGuarded,
    withGenesisAnchor: questionBlocksWithGenesisAnchor,
    fold: PROJECTION_FOLDS.question_block,
    ...defineScan({
      readLiveRows: (db) => db.select().from(question_block),
      toSnapshot: (row) => questionBlockRowToSnapshot(row) as Record<string, unknown>,
      makeFoldOne: async (db) => (id) =>
        gatherAndFoldQuestionBlock(db, id) as Promise<Record<string, unknown> | null>,
    }),
  },
  // Anchor-only coverage: the fold reproduces a row from its genesis anchor, the imperative
  // writers stay authoritative, and the writer flag is off with no planned flip. Registered
  // so audits cover the table instead of leaving it an event-sourcing blind spot.
  item_calibration: {
    kind: 'item_calibration',
    flagEntity: 'item_calibration',
    liveIds: liveIdsFrom(item_calibration),
    // Same reason as question_block: no minting indirection, so event-subject-only.
    eventSubjectIds: (db) => eventSubjectIdSet(db, 'item_calibration', false),
    project: projectItemCalibrationGuarded,
    withGenesisAnchor: itemCalibrationsWithGenesisAnchor,
    fold: PROJECTION_FOLDS.item_calibration,
    ...defineScan({
      readLiveRows: (db) => db.select().from(item_calibration),
      toSnapshot: (row) => itemCalibrationRowToSnapshot(row) as Record<string, unknown>,
      makeFoldOne: async (db) => (id) =>
        gatherAndFoldItemCalibration(db, id) as Promise<Record<string, unknown> | null>,
    }),
  },
};

/** All ids to re-project for a kind: live rows plus the ghost id universe. Sequential reads
 * because the rebuild runs on one serialized tx connection. */
export async function allProjectionIds(db: DbLike, kind: ProjectionKind): Promise<string[]> {
  const adapter = PROJECTION_ENTITIES[kind];
  const live = await adapter.liveIds(db);
  const subjects = await adapter.eventSubjectIds(db);
  return [...new Set([...live, ...subjects])];
}
