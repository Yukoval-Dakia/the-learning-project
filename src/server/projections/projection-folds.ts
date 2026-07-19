// YUK-549 (worklist #5, K10/K13) — the PURE per-kind reducer registry. One exhaustive
// Record<ProjectionKind, PureFold> replacing the golden-reaudit `foldGoldenRow` switch (and the
// source of the DB-side ProjectionAdapter.fold field). Its ONLY runtime imports are the seven
// @/core/projections reducers — the exact edges golden-reaudit already had — so importing it never
// pulls a DB module. This keeps golden-reaudit's "PURE — no DB" property intact (it folds a golden's
// own captured events in memory, with no @/db/client connection); a value import of the DB-heavy
// PROJECTION_ENTITIES would have broken that.
//
// `ProjectionKind` is a TYPE-only import from entity-registry (erased at runtime), so this module has
// NO runtime dependency on the DB registry even though the registry imports THIS module for its `fold`
// field. tsc still enforces exhaustiveness via the Record<ProjectionKind, …> shape.

import { foldArtifact } from '@/core/projections/artifact';
import type { FoldEvent } from '@/core/projections/fold-event';
import { foldGoal } from '@/core/projections/goal';
import { foldKnowledgeNode } from '@/core/projections/knowledge';
import { foldKnowledgeEdge } from '@/core/projections/knowledge_edge';
import { foldLearningItem } from '@/core/projections/learning_item';
import { foldMistakeVariant } from '@/core/projections/mistake_variant';
import { foldQuestionBlock } from '@/core/projections/question_block';
import type { KnowledgeEdgeRowSnapshotT } from '@/core/schema/event/genesis';
import type { ProjectionKind } from './entity-registry';

/**
 * Re-derive one row from its events with the CURRENT reducer. `mesh` (the live archived_at IS NULL
 * edge set) is load-bearing ONLY for `knowledge_edge` (ADR-0034 topology); every other reducer ignores
 * it. Returns the projected snapshot (as an opaque record for the diff layer) or null.
 */
export type PureFold = (
  id: string,
  events: FoldEvent[],
  mesh: KnowledgeEdgeRowSnapshotT[],
) => Record<string, unknown> | null;

export const PROJECTION_FOLDS: Record<ProjectionKind, PureFold> = {
  knowledge: (id, events) => foldKnowledgeNode(id, events) as Record<string, unknown> | null,
  knowledge_edge: (id, events, mesh) =>
    foldKnowledgeEdge(id, events, mesh) as Record<string, unknown> | null,
  goal: (id, events) => foldGoal(id, events) as Record<string, unknown> | null,
  mistake_variant: (id, events) => foldMistakeVariant(id, events) as Record<string, unknown> | null,
  learning_item: (id, events) => foldLearningItem(id, events) as Record<string, unknown> | null,
  artifact: (id, events) => foldArtifact(id, events) as Record<string, unknown> | null,
  question_block: (id, events) => foldQuestionBlock(id, events) as Record<string, unknown> | null,
};
