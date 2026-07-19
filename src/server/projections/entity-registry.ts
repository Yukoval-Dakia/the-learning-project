// YUK-548 (worklist #5, Q2/Q3) — the ProjectionAdapter registry: ONE exhaustive
// Record<ProjectionKind, ProjectionAdapter> replacing the five hand-written per-entity branch sets
// (parity.ts / gather.ts / audit-projection.ts / rebuild-projection.ts / b3-gate.ts). tsc enforces
// exhaustiveness (a missing kind = compile error), which is Q3's "readiness checklist" leg made
// mechanical: an entity that is not registered here cannot be rebuilt / gated / swept.
//
// Each adapter reuses the ALREADY-LANDED per-entity primitives (the guarded write-through shells +
// the parity.ts batch anchor helpers); it adds NO new fold/reducer logic. The rebuild / b3-gate /
// oracle sweep consume this registry so a new entity is wired by adding ONE adapter, not by editing
// five call sites.

import { eq } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import {
  artifact,
  event,
  goal,
  knowledge,
  knowledge_edge,
  learning_item,
  materialized_id_index,
  mistake_variant,
  question_block,
} from '@/db/schema';
import { projectArtifactGuarded } from './artifact';
import {
  edgeRowToSnapshot,
  gatherAndFoldArtifact,
  gatherAndFoldGoal,
  gatherAndFoldKnowledgeEdgeWithMesh,
  gatherAndFoldKnowledgeNode,
  gatherAndFoldLearningItem,
  gatherAndFoldMistakeVariant,
  gatherAndFoldQuestionBlock,
  prefetchKnowledgeMergeEvents,
  prefetchKnowledgeRates,
  prefetchLearningItemMergeEvents,
} from './gather';
import { projectGoalGuarded } from './goal';
import { projectKnowledgeNode } from './knowledge';
import { projectKnowledgeEdge } from './knowledge_edge';
import { projectLearningItemGuarded } from './learning_item';
import { projectMistakeVariantGuarded } from './mistake_variant';
import {
  artifactsWithGenesisAnchor,
  goalLiveRowToSnapshot,
  goalsWithGenesisAnchor,
  knowledgeEdgesWithGenesisAnchor,
  knowledgeLiveRowToSnapshot,
  knowledgeNodesWithGenesisAnchor,
  learningItemLiveRowToSnapshot,
  learningItemsWithGenesisAnchor,
  mistakeVariantLiveRowToSnapshot,
  mistakeVariantsWithGenesisAnchor,
  questionBlocksWithGenesisAnchor,
} from './parity';
import { PROJECTION_FOLDS, type PureFold } from './projection-folds';
import { projectQuestionBlockGuarded } from './question_block';
import { artifactRowToSnapshot, questionBlockRowToSnapshot } from './snapshot-mappers';
import type { ProjectionEntity } from './sot-flag';

type DbLike = Db | Tx;

// ── Structural read columns (K10 — moved here from audit-kind.ts so the per-kind read lives in the
// registry) ──────────────────────────────────────────────────────────────────────────────────────
// The knowledge / learning_item scans SELECT only the structural snapshot columns, NOT the large
// embed_* vectors (knowledge) or the non-fold-owned derived columns (learning_item:
// child_learning_item_ids / ai_score / due_at / reviewed_at — design §3①). The column sets must
// satisfy the corresponding Live-row mapper's inline param type — tsc enforces the sync at the
// gatherWithContext call site (review K9/O8).
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
  | 'question_block';

export const ALL_PROJECTION_KINDS = [
  'knowledge',
  'knowledge_edge',
  'goal',
  'mistake_variant',
  'learning_item',
  'artifact',
  'question_block',
] as const satisfies readonly ProjectionKind[];

/**
 * FK-forced tx clusters (Lens B m7). Kinds within one cluster share a SINGLE rebuild transaction
 * (a topology/FK reject rolls the cluster back together), applied IN ARRAY ORDER (FK parent before
 * child). The ONLY real inter-projection FK is `knowledge_edge.from/to_knowledge_id → knowledge.id`
 * (verified src/db/schema.ts:1302-1307; learning_item.primary_artifact_id has NO DB FK — ADR-0027
 * dropped it, schema.ts:406-412), so knowledge + knowledge_edge are one cluster (knowledge first)
 * and every other kind is an INDEPENDENT singleton cluster — a single kind's reject never balloons
 * into an all-7 rollback.
 *
 * EXHAUSTIVENESS (review O12): unlike PROJECTION_ENTITIES (whose Record<ProjectionKind, …> makes a
 * missing kind a compile error), a plain array literal has NO such guarantee — a kind absent here
 * would be silently unreachable from rebuild-projection / the b3-gate CLI. Two guards close that:
 * the `satisfies` keeps element types literal so MissingClusterKind (below) is a COMPILE error when
 * a kind is missing, and the module-load assert catches duplicates/mismatch at runtime.
 */
export const PROJECTION_FK_CLUSTERS = [
  ['knowledge', 'knowledge_edge'],
  ['goal'],
  ['mistake_variant'],
  ['learning_item'],
  ['artifact'],
  ['question_block'],
] as const satisfies readonly (readonly ProjectionKind[])[];

// Compile-time: every ProjectionKind must appear in the clusters. If one is missing,
// MissingClusterKind is non-never and the AssertNever instantiation fails to typecheck.
type ClusterCoveredKind = (typeof PROJECTION_FK_CLUSTERS)[number][number];
type AssertNever<T extends never> = T;
export type _AssertClustersCoverEveryKind = AssertNever<
  Exclude<ProjectionKind, ClusterCoveredKind>
>;

// Runtime (module load): no duplicates across clusters + exact coverage (belt to the type-level
// suspenders — the type check cannot catch a kind listed twice).
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
  /**
   * sot-flag entry for `projectionIsWriter(flagEntity)`. knowledge / knowledge_edge ride the BARE
   * global `PROJECTION_IS_WRITER` (no per-entity env), so their flagEntity is `undefined` — the
   * oracle sweep's tracked-flag check special-cases that.
   */
  flagEntity: ProjectionEntity | undefined;
  /** live row ids (the materialized table). */
  liveIds(db: DbLike): Promise<Set<string>>;
  /**
   * The GHOST-detection id universe beyond the live rows: `event.subject_id` for this kind, UNION
   * the materialized_id_index anchors for kinds that WRITE the index (M8 id-universe: knowledge has
   * the propose_new/split reverse-index mint whose id is never an event subject_id; goal /
   * mistake_variant / learning_item / artifact write index anchors too, folded in for symmetry;
   * question_block does NOT enter the index — design §5.3 — so it is event-subject-only).
   */
  eventSubjectIds(db: DbLike): Promise<Set<string>>;
  /** the ALREADY-LANDED write-through shell (knowledge/edge: the unchanged W1 unguarded rebuild
   * shells; the 5 W2/W3 entities: their guarded SoT-flip shells). Reused verbatim. */
  project(db: DbLike, id: string): Promise<void>;
  /** batch applicability gate — the subset of `ids` that are EVENT-SOURCED (foldable). Reuses the
   * parity.ts batch anchor helper. The Q4a symmetric audit skips un-anchored live rows with this. */
  withGenesisAnchor(db: DbLike, ids: string[]): Promise<Set<string>>;
  /** K10/K13 — live row → structural snapshot (the field-pick the accept-time parity assert, the
   * value/symmetric audit, and the golden capture all share). Row type is erased to the uniform
   * adapter shape; the concrete read↔mapper tie is enforced per entry by `defineScan`'s generic
   * (review K9/O8). */
  toSnapshot(row: unknown): Record<string, unknown>;
  /** K10/K13 — the PURE @/core reducer for this kind, sourced from the DB-free PROJECTION_FOLDS
   * registry (the SAME reducer gatherWithContext folds with). It surfaces the pure fold on the adapter
   * so the per-kind operation catalog is complete; golden-reaudit imports PROJECTION_FOLDS DIRECTLY
   * (never this DB-heavy adapter) to keep its offline re-fold free of a DB connection. */
  fold: PureFold;
  /** K10/K13 — the ONE per-kind DB read+fold context that the four ex-switches now share: every live
   * row → snapshot map, plus a prefetch-primed per-id `foldOne` (the YUK-547 learning_item merge
   * prefetch, the YUK-549 knowledge merge/rate prefetch, and the edge topology mesh). Consumed by
   * auditProjectionKind, auditProjectionKindSymmetric, and capture-golden. */
  gatherWithContext(db: DbLike): Promise<KindScanData>;
}

/** The per-kind read+fold context (K10) — every live row → its imperative snapshot, plus a per-id fold
 * closure primed with any prefetch/mesh context. `foldOne` runs the SAME gather the write-through shell
 * uses; it PROPAGATES a reducer throw (the edge fold's ADR-0034 topology reject) so the value audit can
 * model it as a NO-GO — the symmetric audit isolates the throw per id at its own call site. */
export interface KindScanData {
  liveSnapshots: Map<string, Record<string, unknown>>;
  foldOne: (id: string) => Promise<Record<string, unknown> | null>;
}

type FoldOne = (id: string) => Promise<Record<string, unknown> | null>;

// Bind a per-kind live-row read to its snapshot mapper and its fold-context builder, then erase to the
// uniform adapter shape. The `Row` generic ties the read's row type to BOTH the mapper param and the
// makeFoldOne `rows` arg, so a schema/column mismatch is a COMPILE error here (review O8) — the
// compile-time safety the old typed per-file switches provided, relocated into the registry. The
// returned `toSnapshot` is the erased mapper (only ever called on rows from THIS read); the returned
// `gatherWithContext` builds the live-snapshot map + the prefetch-primed foldOne in ONE read pass.
function defineScan<Row extends { id: string }>(def: {
  // PromiseLike (not Promise): a drizzle select builder is thenable but not a real Promise, so this
  // lets `(db) => db.select(cols).from(table)` assign without an `async` wrapper. `await` unwraps it.
  readLiveRows: (db: DbLike) => PromiseLike<Row[]>;
  toSnapshot: (row: Row) => Record<string, unknown>;
  makeFoldOne: (db: DbLike, rows: Row[]) => Promise<FoldOne>;
}): Pick<ProjectionAdapter, 'toSnapshot' | 'gatherWithContext'> {
  // The adapter's `toSnapshot` field IS the snapshot builder gatherWithContext uses (not a parallel
  // copy) — the O8 read↔mapper tie holds at the `def` literal, so calling it on rows from THIS read is
  // safe despite the erased signature.
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

// event.subject_id set for `kind`, optionally unioned with the materialized_id_index anchors when
// the kind writes the index. Shared by every adapter's eventSubjectIds.
//
// UNBOUNDED-READ NOTE (review O13, deliberate): no LIMIT/pagination — the id UNIVERSE is the whole
// point of this read (ghost detection must see every id the log implies; a truncated universe is a
// blind oracle). Boundedness comes from the deployment envelope, not the query: single-user (n=1)
// tool, per-kind subject counts are 10²-10⁴ scale, and only distinct ids are retained in the Set.
// If the event table ever outgrows that envelope, the fix is a DISTINCT/keyset scan — never a LIMIT.
async function eventSubjectIdSet(
  db: DbLike,
  kind: ProjectionKind,
  writesIndex: boolean,
): Promise<Set<string>> {
  const out = new Set<string>();
  const evRows = await db
    .select({ subject_id: event.subject_id })
    .from(event)
    .where(eq(event.subject_kind, kind));
  for (const r of evRows) out.add(r.subject_id);
  if (writesIndex) {
    const idxRows = await db
      .select({ materialized_id: materialized_id_index.materialized_id })
      .from(materialized_id_index)
      .where(eq(materialized_id_index.subject_kind, kind));
    for (const r of idxRows) out.add(r.materialized_id);
  }
  return out;
}

// The 7 projection tables all share a text `id` PK — ONE factory replaces seven identical liveIds
// closures (review K12). The Record literal below stays fully explicit per kind, so the tsc
// exhaustiveness guarantee is unaffected.
type ProjectionTable =
  | typeof knowledge
  | typeof knowledge_edge
  | typeof goal
  | typeof mistake_variant
  | typeof learning_item
  | typeof artifact
  | typeof question_block;

function liveIdsFrom(table: ProjectionTable): (db: DbLike) => Promise<Set<string>> {
  return async (db) => {
    // Annotation (not a cast — review O14): assignment-checked against the drizzle-inferred result,
    // so a future table whose `id` is not a text column fails HERE at compile time.
    const rows: { id: string }[] = await db.select({ id: table.id }).from(table);
    return new Set(rows.map((r) => r.id));
  };
}

export const PROJECTION_ENTITIES: Record<ProjectionKind, ProjectionAdapter> = {
  knowledge: {
    kind: 'knowledge',
    flagEntity: undefined, // bare global PROJECTION_IS_WRITER (W1)
    liveIds: liveIdsFrom(knowledge),
    eventSubjectIds: (db) => eventSubjectIdSet(db, 'knowledge', true),
    project: projectKnowledgeNode,
    withGenesisAnchor: knowledgeNodesWithGenesisAnchor,
    fold: PROJECTION_FOLDS.knowledge,
    ...defineScan({
      readLiveRows: (db) => db.select(KNOWLEDGE_STRUCTURAL_COLUMNS).from(knowledge),
      toSnapshot: (row) => knowledgeLiveRowToSnapshot(row) as Record<string, unknown>,
      // YUK-549 (K6): prefetch the node-independent Q3 merge + rate legs ONCE for the whole scan.
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
    flagEntity: undefined, // bare global PROJECTION_IS_WRITER (W1)
    liveIds: liveIdsFrom(knowledge_edge),
    eventSubjectIds: (db) => eventSubjectIdSet(db, 'knowledge_edge', true),
    project: projectKnowledgeEdge,
    withGenesisAnchor: knowledgeEdgesWithGenesisAnchor,
    fold: PROJECTION_FOLDS.knowledge_edge,
    ...defineScan({
      readLiveRows: (db) => db.select().from(knowledge_edge),
      toSnapshot: (row) => edgeRowToSnapshot(row) as Record<string, unknown>,
      // The live topology mesh is derived from the SAME read the snapshot map uses (O(E), not O(E²)),
      // and checkEdgeTopology treats it as a SET so row order is irrelevant.
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
      // YUK-547: prefetch the item-independent merge legs ONCE for the whole scan.
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
    // question_block does NOT enter materialized_id_index (design §5.3) → event-subject-only.
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
};

/** All ids to re-project for a kind = live rows ∪ the ghost id universe (event subjects + anchors).
 * Sequential reads (NOT Promise.all) — the rebuild runs inside a single tx connection that serializes
 * queries; concurrent reads on it are avoided. */
export async function allProjectionIds(db: DbLike, kind: ProjectionKind): Promise<string[]> {
  const adapter = PROJECTION_ENTITIES[kind];
  const live = await adapter.liveIds(db);
  const subjects = await adapter.eventSubjectIds(db);
  return [...new Set([...live, ...subjects])];
}
