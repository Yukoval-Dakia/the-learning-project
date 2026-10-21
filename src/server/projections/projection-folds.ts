// Pure per-kind reducer registry. `Record<ProjectionKind, PureFold>` makes a missing
// reducer a compile error. Only @/core reducers are imported at runtime, so
// golden-reaudit can fold offline without pulling in the DB registry; the
// ProjectionKind import is type-only.

import { foldArtifact } from '@/core/projections/artifact';
import type { FoldEvent } from '@/core/projections/fold-event';
import { foldGoal } from '@/core/projections/goal';
import { foldItemCalibration } from '@/core/projections/item_calibration';
import { foldKnowledgeNode } from '@/core/projections/knowledge';
import { foldKnowledgeEdge } from '@/core/projections/knowledge_edge';
import { foldLearningItem } from '@/core/projections/learning_item';
import { foldMistakeVariant } from '@/core/projections/mistake_variant';
import { foldQuestionBlock } from '@/core/projections/question_block';
import type { KnowledgeEdgeRowSnapshotT } from '@/core/schema/event/genesis';
import type { ProjectionKind } from './entity-registry';

/**
 * Re-derive one row from its events with the current reducer. `mesh` is used only by
 * `knowledge_edge` for its topology checks.
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
  item_calibration: (id, events) =>
    foldItemCalibration(id, events) as Record<string, unknown> | null,
};
