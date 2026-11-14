import type {
  AtomicProposal,
  LearningIntentPrerequisiteEdge,
  LongProposal,
} from './learning-intent';

export interface ProposalGraph {
  rootKey: string;
  childKeys: readonly string[];
}

export type GraphFault =
  | { type: 'duplicate_id'; id: string }
  | { type: 'missing_atomic'; id: string }
  | { type: 'duplicate_atomic'; id: string }
  | { type: 'unknown_atomic'; id: string }
  | { type: 'unknown_long'; id: string }
  | { type: 'prerequisite_order'; prerequisite: string; dependent: string };

export function checkProposalGraph(
  graph: ProposalGraph,
  atomics: readonly AtomicProposal[],
  longs: readonly LongProposal[],
  prerequisites: readonly LearningIntentPrerequisiteEdge[] = [],
): GraphFault | null {
  const seen = new Set<string>();
  if (seen.has(graph.rootKey)) return { type: 'duplicate_id', id: graph.rootKey };
  seen.add(graph.rootKey);
  for (const id of graph.childKeys) {
    if (seen.has(id)) return { type: 'duplicate_id', id };
    seen.add(id);
  }
  const atomicCount = new Map<string, number>();
  for (const atomic of atomics) {
    if (atomic.knowledge_id === graph.rootKey || !seen.has(atomic.knowledge_id))
      return { type: 'unknown_atomic', id: atomic.knowledge_id };
    const count = (atomicCount.get(atomic.knowledge_id) ?? 0) + 1;
    if (count > 1) return { type: 'duplicate_atomic', id: atomic.knowledge_id };
    atomicCount.set(atomic.knowledge_id, count);
  }
  for (const id of graph.childKeys) {
    if ((atomicCount.get(id) ?? 0) !== 1) return { type: 'missing_atomic', id };
  }
  for (const long of longs) {
    for (const id of long.knowledge_ids) {
      if (!seen.has(id)) return { type: 'unknown_long', id };
    }
  }
  const edgeKeys = new Set<string>();
  for (const edge of prerequisites) {
    const key = `${edge.prerequisite_knowledge_id}->${edge.dependent_knowledge_id}`;
    if (!seen.has(edge.prerequisite_knowledge_id) || !seen.has(edge.dependent_knowledge_id))
      return { type: 'unknown_long', id: edge.dependent_knowledge_id };
    if (edge.prerequisite_knowledge_id === edge.dependent_knowledge_id || edgeKeys.has(key))
      return { type: 'duplicate_id', id: edge.prerequisite_knowledge_id };
    edgeKeys.add(key);
  }
  return null;
}

export function checkProposalPrerequisites(
  graph: ProposalGraph,
  atomics: readonly AtomicProposal[],
  longs: readonly LongProposal[],
  prerequisites: readonly LearningIntentPrerequisiteEdge[],
):
  | { type: 'ok' }
  | { type: 'unknown'; id: string }
  | { type: 'self'; id: string }
  | { type: 'missing'; prerequisite: string; dependent: string }
  | { type: 'order'; prerequisite: string; dependent: string } {
  const known = new Set([graph.rootKey, ...graph.childKeys]);
  const order = new Map<string, number>([[graph.rootKey, 0]]);
  for (const [index, item] of atomics.entries()) {
    if (!order.has(item.knowledge_id)) order.set(item.knowledge_id, index + 1);
  }
  for (const [index, item] of longs.entries()) {
    for (const id of item.knowledge_ids) {
      if (!order.has(id)) order.set(id, atomics.length + index + 1);
    }
  }
  const edges = new Set(
    prerequisites.map(
      (edge) => `${edge.prerequisite_knowledge_id}->${edge.dependent_knowledge_id}`,
    ),
  );
  const refs = [
    ...atomics.map((item) => ({
      id: item.knowledge_id,
      prerequisites: item.prerequisite_knowledge_ids,
    })),
    ...longs.map((item) => ({
      ids: item.knowledge_ids,
      prerequisites: item.prerequisite_knowledge_ids,
    })),
  ];
  for (const ref of refs) {
    for (const prerequisiteId of ref.prerequisites) {
      if (!known.has(prerequisiteId)) return { type: 'unknown', id: prerequisiteId };
      const dependentIds = 'ids' in ref ? ref.ids : [ref.id];
      if (dependentIds.some((id) => id === prerequisiteId))
        return { type: 'self', id: prerequisiteId };
      const matches = dependentIds.filter((id) => edges.has(`${prerequisiteId}->${id}`));
      if (matches.length === 0)
        return { type: 'missing', prerequisite: prerequisiteId, dependent: dependentIds[0] };
      const ordered = matches.some((id) => {
        const prerequisiteIndex = order.get(prerequisiteId);
        const dependentIndex = order.get(id);
        return (
          prerequisiteIndex != null && dependentIndex != null && prerequisiteIndex < dependentIndex
        );
      });
      if (!ordered) return { type: 'order', prerequisite: prerequisiteId, dependent: matches[0] };
    }
  }
  return { type: 'ok' };
}

export function graphFaultDetail(fault: GraphFault): string {
  switch (fault.type) {
    case 'duplicate_id':
      return `a repeated knowledge id ${fault.id}`;
    case 'missing_atomic':
      return `knowledge id ${fault.id} with no atomic`;
    case 'duplicate_atomic':
      return `more than one atomic for knowledge id ${fault.id}`;
    case 'unknown_atomic':
      return `atomic knowledge id ${fault.id} outside the root and children`;
    case 'unknown_long':
      return `long knowledge id ${fault.id} outside the root and children`;
    case 'prerequisite_order':
      return `knowledge id ${fault.dependent} precedes its prerequisite ${fault.prerequisite}`;
  }
}
