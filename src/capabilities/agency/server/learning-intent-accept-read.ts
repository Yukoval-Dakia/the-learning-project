import type {
  AtomicProposal,
  ExistingLearningIntentItem,
  HubProposal,
  LearningIntentPlanCase,
  LearningIntentPrerequisiteEdge,
  LongProposal,
  ProposedKnowledgeGraph,
  ProposedKnowledgeNode,
} from './learning-intent';

interface ProposalPayload {
  topic?: unknown;
  plan_case?: unknown;
  knowledge_node_id: unknown;
  proposed_knowledge?: unknown;
  reviewed_knowledge?: unknown;
  existing_items?: ExistingLearningIntentItem[] | unknown;
  mastered_knowledge_ids?: string[] | unknown;
  prerequisite_edges?: LearningIntentPrerequisiteEdge[] | unknown;
  hub: HubProposal;
  atomics: AtomicProposal[];
  longs?: LongProposal[];
}

export interface ReviewedKnowledgeNode {
  id: string;
  parent_id: string | null;
  version: number;
}

export interface ReviewedKnowledge {
  root: ReviewedKnowledgeNode;
  children?: readonly ReviewedKnowledgeNode[];
}

export interface KnowledgeCompatibility {
  id: string;
  parentId?: string | null;
  version?: number;
  recorded: boolean;
}

export interface AcceptSpec {
  planCase: LearningIntentPlanCase;
  graph: { rootKey: string; childKeys: readonly string[] };
  rootToMint: ProposedKnowledgeNode | null;
  childrenToMint: readonly ProposedKnowledgeNode[];
  existing: readonly KnowledgeCompatibility[];
  existingRootId: string | null;
  atomics: readonly AtomicProposal[];
  longs: readonly LongProposal[];
  hub: HubProposal;
  topic: string;
  knowledgeNodeDomain: string | null;
  taskRunId: string | null;
  costMicroUsd: number | null;
  resolveActiveChildren: boolean;
  existingItems: readonly ExistingLearningIntentItem[];
  masteredKnowledgeIds: readonly string[];
  prerequisiteEdges: readonly LearningIntentPrerequisiteEdge[];
}

function invalid(message: string): never {
  throw new Error(message);
}

function readStringId(value: unknown, label: string): string {
  return typeof value === 'string' && value.length > 0 ? value : invalid(`${label} is missing`);
}

function readStringArray(value: unknown, label: string): string[] {
  return Array.isArray(value)
    ? value.map((id, index) => readStringId(id, `${label} ${index}`))
    : [];
}

function readAtomics(value: unknown): AtomicProposal[] {
  return Array.isArray(value)
    ? value.map((item, index) => {
        const row = item as AtomicProposal;
        return {
          ...row,
          knowledge_id: readStringId(row.knowledge_id, `atomic ${index}`),
          prerequisite_knowledge_ids: readStringArray(
            row.prerequisite_knowledge_ids,
            `atomic ${index} prerequisite`,
          ),
        };
      })
    : invalid('proposal is missing atomics');
}

function readLongs(value: unknown): LongProposal[] {
  return Array.isArray(value)
    ? value.map((item, index) => {
        const row = item as LongProposal;
        return {
          ...row,
          knowledge_ids: readStringArray(row.knowledge_ids, `long ${index} knowledge`),
          prerequisite_knowledge_ids: readStringArray(
            row.prerequisite_knowledge_ids,
            `long ${index} prerequisite`,
          ),
        };
      })
    : [];
}

function readProposedNode(value: unknown, label: string): ProposedKnowledgeNode {
  const row = value as { temp_id?: unknown; name?: unknown; domain?: unknown } | null;
  return {
    temp_id: readStringId(row?.temp_id, `${label} temp_id`),
    name: typeof row?.name === 'string' ? row.name : '',
    domain: typeof row?.domain === 'string' || row?.domain === null ? row.domain : null,
  };
}

function readProposedChildren(value: unknown, label: string): ProposedKnowledgeNode[] {
  return Array.isArray(value) && value.length > 0
    ? value.map((item, index) => readProposedNode(item, `${label} ${index}`))
    : invalid(`${label} is missing`);
}

function readReviewedNode(value: unknown): ReviewedKnowledgeNode | null {
  const row = value as { id?: unknown; parent_id?: unknown; version?: unknown } | null;
  return row &&
    typeof row.id === 'string' &&
    row.id.length > 0 &&
    (typeof row.parent_id === 'string' || row.parent_id === null) &&
    typeof row.version === 'number' &&
    Number.isInteger(row.version)
    ? { id: row.id, parent_id: row.parent_id, version: row.version }
    : null;
}

function readReviewedKnowledge(value: unknown): ReviewedKnowledge | null {
  const root = readReviewedNode((value as { root?: unknown } | null)?.root);
  if (!root) return null;
  const rawChildren = (value as { children?: unknown } | null)?.children;
  if (rawChildren === undefined) return { root };
  if (!Array.isArray(rawChildren)) return null;
  const children = rawChildren.map(readReviewedNode);
  return children.every(Boolean) ? { root, children: children as ReviewedKnowledgeNode[] } : null;
}

function readOptionalReviewed(
  value: unknown,
  shape: 'root' | 'children',
): ReviewedKnowledge | null {
  if (value === undefined || value === null) return null;
  const reviewed = readReviewedKnowledge(value);
  if (!reviewed || (shape === 'children' && !reviewed.children))
    throw new Error('proposal reviewed knowledge is unreadable');
  return reviewed;
}

export function compatibilityFor(
  id: string,
  role: 'root' | 'child',
  rootId: string,
  reviewed: ReviewedKnowledge | null,
): KnowledgeCompatibility {
  const recorded =
    role === 'root' ? reviewed?.root : reviewed?.children?.find((child) => child.id === id);
  return recorded && recorded.id === id
    ? { id, parentId: recorded.parent_id, version: recorded.version, recorded: true }
    : role === 'child'
      ? { id, parentId: rootId, recorded: false }
      : { id, recorded: false };
}

export function readAcceptSpec(payload: ProposalPayload): AcceptSpec {
  const planCase = payload.plan_case === undefined ? '3c_existing_graph' : payload.plan_case;
  if (
    !['3a_topic_missing', '3b_children_missing', '3c_existing_graph'].includes(planCase as string)
  )
    throw new Error('proposal plan_case is not a learning intent case');
  const graphPayload = payload.proposed_knowledge as ProposedKnowledgeGraph | undefined;
  const shared = {
    planCase: planCase as LearningIntentPlanCase,
    atomics: readAtomics(payload.atomics),
    longs: readLongs(payload.longs),
    hub: payload.hub,
    topic: typeof payload.topic === 'string' ? payload.topic : '',
    knowledgeNodeDomain: null,
    taskRunId: (payload as { task_run_id?: unknown }).task_run_id as string | null,
    costMicroUsd: (payload as { cost_micro_usd?: unknown }).cost_micro_usd as number | null,
    resolveActiveChildren: false,
    existingItems: (payload.existing_items ?? []) as ExistingLearningIntentItem[],
    masteredKnowledgeIds: (payload.mastered_knowledge_ids ?? []) as string[],
    prerequisiteEdges: (payload.prerequisite_edges ?? []) as LearningIntentPrerequisiteEdge[],
  };
  if (planCase === '3a_topic_missing') {
    const root = readProposedNode(graphPayload?.root, '3a proposal root');
    const children = readProposedChildren(graphPayload?.children, '3a proposal children');
    return {
      ...shared,
      graph: { rootKey: root.temp_id, childKeys: children.map((c) => c.temp_id) },
      rootToMint: root,
      childrenToMint: children,
      existing: [],
      existingRootId: null,
    };
  }
  const rootId = readStringId(payload.knowledge_node_id, `${planCase} knowledge_node_id`);
  const children =
    planCase === '3b_children_missing' || graphPayload?.children
      ? readProposedChildren(graphPayload?.children, `${planCase} proposal children`)
      : [];
  const reviewed = readOptionalReviewed(
    payload.reviewed_knowledge,
    planCase === '3b_children_missing' ? 'root' : 'children',
  );
  if (reviewed && reviewed.root.id !== rootId)
    throw new Error('proposal reviewed root does not match knowledge_node_id');
  const childIds =
    planCase === '3c_existing_graph'
      ? (reviewed?.children?.map((child) => child.id) ?? [
          ...new Set(payload.atomics.map((item) => item.knowledge_id)),
        ])
      : children.map((child) => child.temp_id);
  return {
    ...shared,
    graph: { rootKey: rootId, childKeys: childIds },
    rootToMint: null,
    childrenToMint: planCase === '3b_children_missing' ? children : [],
    existing: [
      compatibilityFor(rootId, 'root', rootId, reviewed),
      ...childIds.map((id) => compatibilityFor(id, 'child', rootId, reviewed)),
    ],
    existingRootId: rootId,
    resolveActiveChildren: planCase === '3c_existing_graph' && !reviewed?.children,
  };
}
