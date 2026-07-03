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

import { and, eq, inArray } from 'drizzle-orm';

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
import { projectGoalGuarded } from './goal';
import { projectKnowledgeNode } from './knowledge';
import { projectKnowledgeEdge } from './knowledge_edge';
import { projectLearningItemGuarded } from './learning_item';
import { projectMistakeVariantGuarded } from './mistake_variant';
import {
  artifactsWithGenesisAnchor,
  goalsWithGenesisAnchor,
  knowledgeEdgesWithGenesisAnchor,
  knowledgeNodesWithGenesisAnchor,
  learningItemsWithGenesisAnchor,
  mistakeVariantsWithGenesisAnchor,
  questionBlocksWithGenesisAnchor,
} from './parity';
import { projectQuestionBlockGuarded } from './question_block';
import type { ProjectionEntity } from './sot-flag';

type DbLike = Db | Tx;

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
 */
export const PROJECTION_FK_CLUSTERS: readonly (readonly ProjectionKind[])[] = [
  ['knowledge', 'knowledge_edge'],
  ['goal'],
  ['mistake_variant'],
  ['learning_item'],
  ['artifact'],
  ['question_block'],
] as const;

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
}

// event.subject_id set for `kind`, optionally unioned with the materialized_id_index anchors when
// the kind writes the index. Shared by every adapter's eventSubjectIds.
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

export const PROJECTION_ENTITIES: Record<ProjectionKind, ProjectionAdapter> = {
  knowledge: {
    kind: 'knowledge',
    flagEntity: undefined, // bare global PROJECTION_IS_WRITER (W1)
    liveIds: async (db) =>
      new Set((await db.select({ id: knowledge.id }).from(knowledge)).map((r) => r.id)),
    eventSubjectIds: (db) => eventSubjectIdSet(db, 'knowledge', true),
    project: projectKnowledgeNode,
    withGenesisAnchor: knowledgeNodesWithGenesisAnchor,
  },
  knowledge_edge: {
    kind: 'knowledge_edge',
    flagEntity: undefined, // bare global PROJECTION_IS_WRITER (W1)
    liveIds: async (db) =>
      new Set((await db.select({ id: knowledge_edge.id }).from(knowledge_edge)).map((r) => r.id)),
    eventSubjectIds: (db) => eventSubjectIdSet(db, 'knowledge_edge', true),
    project: projectKnowledgeEdge,
    withGenesisAnchor: knowledgeEdgesWithGenesisAnchor,
  },
  goal: {
    kind: 'goal',
    flagEntity: 'goal',
    liveIds: async (db) => new Set((await db.select({ id: goal.id }).from(goal)).map((r) => r.id)),
    eventSubjectIds: (db) => eventSubjectIdSet(db, 'goal', true),
    project: projectGoalGuarded,
    withGenesisAnchor: goalsWithGenesisAnchor,
  },
  mistake_variant: {
    kind: 'mistake_variant',
    flagEntity: 'mistake_variant',
    liveIds: async (db) =>
      new Set((await db.select({ id: mistake_variant.id }).from(mistake_variant)).map((r) => r.id)),
    eventSubjectIds: (db) => eventSubjectIdSet(db, 'mistake_variant', true),
    project: projectMistakeVariantGuarded,
    withGenesisAnchor: mistakeVariantsWithGenesisAnchor,
  },
  learning_item: {
    kind: 'learning_item',
    flagEntity: 'learning_item',
    liveIds: async (db) =>
      new Set((await db.select({ id: learning_item.id }).from(learning_item)).map((r) => r.id)),
    eventSubjectIds: (db) => eventSubjectIdSet(db, 'learning_item', true),
    project: projectLearningItemGuarded,
    withGenesisAnchor: learningItemsWithGenesisAnchor,
  },
  artifact: {
    kind: 'artifact',
    flagEntity: 'artifact',
    liveIds: async (db) =>
      new Set((await db.select({ id: artifact.id }).from(artifact)).map((r) => r.id)),
    eventSubjectIds: (db) => eventSubjectIdSet(db, 'artifact', true),
    project: projectArtifactGuarded,
    withGenesisAnchor: artifactsWithGenesisAnchor,
  },
  question_block: {
    kind: 'question_block',
    flagEntity: 'question_block',
    liveIds: async (db) =>
      new Set((await db.select({ id: question_block.id }).from(question_block)).map((r) => r.id)),
    // question_block does NOT enter materialized_id_index (design §5.3) → event-subject-only.
    eventSubjectIds: (db) => eventSubjectIdSet(db, 'question_block', false),
    project: projectQuestionBlockGuarded,
    withGenesisAnchor: questionBlocksWithGenesisAnchor,
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
