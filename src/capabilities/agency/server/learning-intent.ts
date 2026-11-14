// Learning Intent orchestrator.
//
// User declares "我想学 X" → read the knowledge graph for X → LLM proposes a 1-hub +
// N-atomic split → persist the proposal as a `propose` event → on user accept, materialize
// the LearningItem hierarchy + paired artifact stubs + enqueue N async NoteGenerateTask jobs.
//
// Cases:
//   - 3a: topic node missing -> propose root + starter children, materialize on accept.
//   - 3b: topic exists but child nodes missing -> propose starter children.
//   - 3c: topic + children exist -> propose 1 hub + N atomic outline over existing nodes.
// Root and child ids share one namespace and must be unique; each child has exactly one
// atomic, and longs only cite that graph. Accept locks referenced knowledge rows and
// refuses the proposal when archive, merge, or reparent has moved them.
// Notes default source_tier='llm_only'; no NoteVerifyTask; no Search-grounded. Embedded
// check is a placeholder (empty question_ids); hub status aggregation and living-note
// triggers remain out of scope.

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import type { ProposalAcceptEffectContext } from '@/kernel/proposals/decision-protocol';
import { learnerSummaryIfAllowed } from '@/kernel/proposals/learner-summary';
import { writeLearningItemProposal } from '@/kernel/proposals/producers';
import { createKnowledgeNodeFromEvents } from '@/kernel/records/knowledge-node-birth';
import type { CreateLearningIntentNoteFn } from '@/kernel/records/learning-intent-note-birth';
import { createPendingLearningItem } from '@/kernel/records/learning-items';
import {
  getDefaultSubjectRegistry,
  resolveSelectableSubjectId,
  resolveSubjectProfile,
  sanitizeProposedNodeDomain,
} from '@/subjects/profile';
// The outline output contract is owned by the agency TaskSpec module; this orchestrator
// re-exports it so existing consumers keep their import paths.
import { LearningIntentError, parseLearningIntentOutline } from '../tasks/learning-intent';
import { type TaskTextRunFn, costUsdToMicroUsd } from './ai-runtime';
import {
  type GraphFault,
  type ProposalGraph,
  checkProposalGraph,
  checkProposalPrerequisites,
  graphFaultDetail,
} from './learning-intent-graph-validation';
import {
  readAtomics as readProposalAtomics,
  readExistingItems as readProposalExistingItems,
  readLongs as readProposalLongs,
  readPrerequisiteEdges as readProposalPrerequisiteEdges,
  readStringId as readProposalStringId,
} from './learning-intent-proposal-read';
import {
  type ExistingLearningIntentItemSnapshot,
  normalizeLearningIntentTopic,
  readExistingItemReference,
  readExistingItemSnapshots,
  readPrerequisiteEdges as readStoredPrerequisiteEdges,
} from './learning-intent-reuse';

export type { LearningIntentOutline } from '../tasks/learning-intent';
export { LearningIntentError, parseLearningIntentOutline };

export type LearningIntentDomainOutcome = 'outline_rejected' | 'proposal_failed';

/** Domain rejection after the provider attempt already finished. The task run stays as the provider wrote it. */
export interface LearningIntentFailureFact {
  readonly taskRunId: string | null;
  readonly costBasis: 'reported' | 'estimated' | 'unknown';
  readonly domainOutcome: LearningIntentDomainOutcome;
  readonly code: string;
  readonly message: string;
}

const failureFacts = new WeakMap<object, LearningIntentFailureFact>();

export function learningIntentFailureFact(err: unknown): LearningIntentFailureFact | null {
  if (typeof err === 'object' && err !== null && failureFacts.has(err)) {
    return failureFacts.get(err) ?? null;
  }
  return null;
}

function noteLearningIntentFailure(err: object, fact: LearningIntentFailureFact): void {
  failureFacts.set(err, fact);
}

// ---------- Public types ----------

export interface HubProposal {
  title: string;
  summary_md: string;
}

export interface AtomicProposal {
  knowledge_id: string;
  title: string;
  one_line_intent: string;
  prerequisite_knowledge_ids: string[];
}

export interface LongProposal {
  knowledge_ids: string[];
  title: string;
  one_line_intent: string;
  prerequisite_knowledge_ids: string[];
}

export type LearningIntentPlanCase =
  | '3a_topic_missing'
  | '3b_children_missing'
  | '3c_existing_graph';

export interface ProposedKnowledgeNode {
  /** Temporary id used inside the proposal and by atomics before accept. */
  temp_id: string;
  name: string;
  domain: string | null;
}

export interface ProposedKnowledgeGraph {
  root?: ProposedKnowledgeNode;
  children: ProposedKnowledgeNode[];
}

export interface LearningIntentProposal {
  /** Event id of the propose event — used as accept handle. */
  proposal_id: string;
  topic: string;
  plan_case: LearningIntentPlanCase;
  knowledge_node: { id: string; name: string; domain: string | null };
  proposed_knowledge?: ProposedKnowledgeGraph;
  existing_items: ExistingLearningIntentItem[];
  mastered_knowledge_ids: string[];
  prerequisite_edges: readonly LearningIntentPrerequisiteEdge[];
  hub: HubProposal;
  atomics: AtomicProposal[];
  longs: LongProposal[];
}

export interface ExistingLearningIntentItem {
  knowledge_id: string;
  item_id: string;
  note_id: string;
  title: string;
}

export interface LearningIntentPrerequisiteEdge {
  prerequisite_knowledge_id: string;
  dependent_knowledge_id: string;
}

export interface LearningIntentMaterializeResult {
  hub_learning_item_id: string;
  atomic_learning_item_ids: string[];
  long_learning_item_ids: string[];
  hub_artifact_id: string;
  atomic_artifact_ids: string[];
  long_artifact_ids: string[];
  enqueued_note_generate_jobs: number;
  root_knowledge_id: string;
  created_knowledge_ids: string[];
  actions: LearningIntentMaterializeAction[];
}

export interface LearningIntentMaterializeAction {
  kind: 'hub' | 'atomic' | 'long';
  proposal_item_id: string | null;
  knowledge_ids: string[];
  action: 'create' | 'skip' | 'reuse';
  reason: 'new' | 'mastered' | 'existing_item';
  learning_item_id: string | null;
  note_id: string | null;
}

export type RunTaskFn = TaskTextRunFn;

export interface PlanLearningIntentParams {
  db: Db;
  topic: string;
  runTaskFn: RunTaskFn;
}

interface LearningIntentExistingContext {
  readonly existingSnapshots: Map<string, ExistingItemSnapshot>;
  readonly prerequisiteEdges: readonly {
    prerequisite_knowledge_id: string;
    dependent_knowledge_id: string;
  }[];
}

// ---------- Knowledge graph lookup ----------

interface KnowledgeNodeRow {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  version: number;
}

interface ReviewedKnowledgeNode {
  readonly id: string;
  readonly parent_id: string | null;
  readonly version: number;
}

interface ReviewedKnowledge {
  readonly root: ReviewedKnowledgeNode;
  readonly children?: readonly ReviewedKnowledgeNode[];
}

/** What accept must still see on a locked knowledge row. */
interface KnowledgeCompatibility {
  readonly id: string;
  /** Absent when the proposal did not record a parent. Null is a recorded root. */
  readonly parentId?: string | null;
  readonly version?: number;
  /** The proposal stored this row at review time, so a missing row is stale. */
  readonly recorded: boolean;
}

export class LearningIntentStaleError extends Error {
  readonly code = 'stale' as const;

  constructor(readonly knowledgeId: string) {
    super(`stale: knowledge ${knowledgeId} no longer matches the reviewed proposal`);
    this.name = 'LearningIntentStaleError';
  }
}

interface ProposedKnowledgeNodeRaw {
  temp_id: string;
  name: string;
  domain?: string | null;
}

function failInvalidOutline(message: string): never {
  throw new LearningIntentError('llm_parse_failed', message);
}

function normalizeProposedNode(
  node: ProposedKnowledgeNodeRaw,
  fallbackDomain: string | null,
): ProposedKnowledgeNode {
  return {
    temp_id: node.temp_id,
    name: node.name,
    // A proposed domain is sanitised to storage shape: selectable → canonical id,
    // 'general' (the fallback identity, never a node domain) → null/inherit,
    // unresolvable → verbatim. A sanitised-out value degrades to the parent fallback
    // instead of persisting into knowledge.domain.
    domain: sanitizeProposedNodeDomain(node.domain) ?? fallbackDomain,
  };
}

function rejectGraphFault(fault: GraphFault, source: 'outline' | 'proposal'): never {
  const who = source === 'outline' ? 'LLM proposed' : 'proposal contains';
  throw new LearningIntentError('invalid_atomic_knowledge_id', `${who} ${graphFaultDetail(fault)}`);
}

function rejectPrerequisiteFault(result: ReturnType<typeof checkProposalPrerequisites>): void {
  if (result.type === 'ok') return;
  if (result.type === 'unknown')
    rejectGraphFault({ type: 'unknown_long', id: result.id }, 'proposal');
  if (result.type === 'self')
    throw new LearningIntentError(
      'invalid_atomic_knowledge_id',
      `proposal prerequisite ${result.id} is self-referential`,
    );
  if (result.type === 'order')
    throw new LearningIntentError(
      'invalid_atomic_knowledge_id',
      `proposal orders dependent ${result.dependent} before prerequisite ${result.prerequisite}`,
    );
  throw new LearningIntentError(
    'invalid_atomic_knowledge_id',
    `proposal prerequisite ${result.prerequisite} -> ${result.dependent} has no recorded graph edge`,
  );
}

function reviewNode(node: KnowledgeNodeRow): ReviewedKnowledgeNode {
  return { id: node.id, parent_id: node.parent_id, version: node.version };
}

function bindKnowledgeId(bindings: Map<string, string>, key: string, realId: string): void {
  if (bindings.has(key)) {
    throw new LearningIntentError(
      'invalid_atomic_knowledge_id',
      `proposal contains a repeated knowledge id ${key}`,
    );
  }
  bindings.set(key, realId);
}

function boundKnowledgeId(
  bindings: ReadonlyMap<string, string>,
  key: string,
  kind: 'atomic' | 'long',
): string {
  const realId = bindings.get(key);
  if (realId === undefined) {
    throw new LearningIntentError(
      'invalid_atomic_knowledge_id',
      `proposal ${kind} references unknown knowledge id ${key}`,
    );
  }
  return realId;
}

interface LockedKnowledgeRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly version: number;
  readonly archived_at: Date | null;
}

async function lockKnowledgeRows(
  tx: Tx,
  ids: readonly string[],
): Promise<Map<string, LockedKnowledgeRow>> {
  if (ids.length === 0) return new Map();
  // Archive, merge, and reparent take this same id-sorted FOR UPDATE inside their
  // accept transaction. Holding it here, after the proposal decision lock, means
  // this accept either sees that commit or waits and then refuses the moved base.
  const rows = await tx
    .select({
      id: knowledge.id,
      parent_id: knowledge.parent_id,
      version: knowledge.version,
      archived_at: knowledge.archived_at,
    })
    .from(knowledge)
    .where(inArray(knowledge.id, [...ids].sort()))
    .orderBy(knowledge.id)
    .for('update');
  const locked = new Map<string, LockedKnowledgeRow>();
  for (const row of rows) locked.set(row.id, row);
  return locked;
}

type Citation =
  | { readonly state: 'in_graph' }
  | { readonly state: 'stale'; readonly id: string }
  | { readonly state: 'outside' };

function classifyCitation(
  id: string,
  role: 'atomic' | 'long',
  rootId: string,
  row: LockedKnowledgeRow | undefined,
): Citation {
  if (role === 'long' && id === rootId) return { state: 'in_graph' };
  if (!row || id === rootId) return { state: 'outside' };
  if (row.archived_at === null && row.parent_id === rootId) return { state: 'in_graph' };
  return { state: 'stale', id };
}

function citedKnowledgeIds(spec: AcceptSpec): string[] {
  return [
    ...new Set([
      ...spec.atomics.map((atomic) => atomic.knowledge_id),
      ...spec.longs.flatMap((long) => long.knowledge_ids),
    ]),
  ];
}

async function lockLegacyKnowledge(
  tx: Tx,
  rootId: string,
  citedIds: readonly string[],
): Promise<LockedKnowledgeRow[]> {
  const cited = citedIds.filter((id) => id !== rootId);
  const activeChildren = and(eq(knowledge.parent_id, rootId), isNull(knowledge.archived_at));
  return tx
    .select({
      id: knowledge.id,
      parent_id: knowledge.parent_id,
      version: knowledge.version,
      archived_at: knowledge.archived_at,
    })
    .from(knowledge)
    .where(
      cited.length === 0
        ? or(eq(knowledge.id, rootId), activeChildren)
        : or(eq(knowledge.id, rootId), activeChildren, inArray(knowledge.id, cited)),
    )
    .orderBy(knowledge.id)
    .for('update');
}

function staleCitedId(spec: AcceptSpec, locked: readonly LockedKnowledgeRow[]): string | null {
  const rootId = spec.existingRootId;
  if (!rootId) return null;
  const byId = new Map(locked.map((row) => [row.id, row]));
  const refs = [
    ...spec.atomics.map((atomic) => ({ id: atomic.knowledge_id, role: 'atomic' as const })),
    ...spec.longs.flatMap((long) =>
      long.knowledge_ids.map((id) => ({ id, role: 'long' as const })),
    ),
  ];
  for (const ref of refs) {
    const citation = classifyCitation(ref.id, ref.role, rootId, byId.get(ref.id));
    if (citation.state === 'stale') return citation.id;
  }
  return null;
}

async function assertKnowledgeCompatible(
  tx: Tx,
  expectedNodes: readonly KnowledgeCompatibility[],
): Promise<void> {
  const locked = await lockKnowledgeRows(
    tx,
    expectedNodes.map((node) => node.id),
  );
  const ordered = [...expectedNodes].sort((left, right) => left.id.localeCompare(right.id));
  for (const expected of ordered) {
    const row = locked.get(expected.id);
    if (!row) {
      if (expected.recorded) throw new LearningIntentStaleError(expected.id);
      throw new LearningIntentError(
        'invalid_atomic_knowledge_id',
        `proposal references unknown knowledge id ${expected.id}`,
      );
    }
    const parentMismatch = expected.parentId !== undefined && row.parent_id !== expected.parentId;
    const versionMismatch = expected.version !== undefined && row.version !== expected.version;
    if (row.archived_at !== null || parentMismatch || versionMismatch) {
      throw new LearningIntentStaleError(expected.id);
    }
  }
}

async function findTopicNode(db: Db, topic: string): Promise<KnowledgeNodeRow | null> {
  const normalized = topic.trim().toLowerCase();
  if (!normalized) return null;
  // Case-insensitive exact match on knowledge.name first; if multiple match, the
  // first by created_at wins (user must disambiguate at /knowledge).
  const rows = await db
    .select({
      id: knowledge.id,
      name: knowledge.name,
      domain: knowledge.domain,
      parent_id: knowledge.parent_id,
      version: knowledge.version,
    })
    .from(knowledge)
    .where(isNull(knowledge.archived_at));
  for (const r of rows) {
    if (r.name.toLowerCase() === normalized) return r;
  }
  // Fallback: substring match
  for (const r of rows) {
    if (r.name.toLowerCase().includes(normalized)) return r;
  }
  return null;
}

async function loadChildren(db: Db, parentId: string): Promise<KnowledgeNodeRow[]> {
  return db
    .select({
      id: knowledge.id,
      name: knowledge.name,
      domain: knowledge.domain,
      parent_id: knowledge.parent_id,
      version: knowledge.version,
    })
    .from(knowledge)
    .where(and(eq(knowledge.parent_id, parentId), isNull(knowledge.archived_at)));
}

type ExistingItemSnapshot = ExistingLearningIntentItemSnapshot;

// ---------- planLearningIntent ----------

/**
 * Locate the topic in the knowledge graph, decide whether the graph needs bootstrapping,
 * ask the LLM for a 1-hub + N-atomic outline, then persist it as a `propose` event.
 *
 * Throws LearningIntentError for llm_parse_failed (output violates the outline schema),
 * invalid_atomic_knowledge_id (repeated ids, a child with no atomic, or a long/atomic id
 * outside the root and children), and proposal_failed when the outline was usable but the
 * proposal row did not commit. Nothing is written when the graph check fails. A failure
 * after the provider returns is stamped with that attempt's task run and cost basis; the
 * task run's provider outcome is left as recorded.
 */
export async function planLearningIntent(
  params: PlanLearningIntentParams,
): Promise<LearningIntentProposal> {
  const { db, topic, runTaskFn } = params;

  const node = await findTopicNode(db, topic);
  const children = node ? await loadChildren(db, node.id) : [];
  const planCase: LearningIntentPlanCase =
    node === null
      ? '3a_topic_missing'
      : children.length === 0
        ? '3b_children_missing'
        : '3c_existing_graph';

  const existingSnapshots = await readExistingItemSnapshots(db, node, children);
  const prerequisiteEdges = await readStoredPrerequisiteEdges(db, node, children);
  const input = {
    topic: normalizeLearningIntentTopic(topic),
    plan_case: planCase,
    knowledge_node: node ? { id: node.id, name: node.name, domain: node.domain } : null,
    child_nodes: children.map((c) => ({ id: c.id, name: c.name })),
    existing_items: [...existingSnapshots.entries()].map(([knowledgeId, snapshot]) => ({
      knowledge_id: knowledgeId,
      item_id: snapshot.item.id,
      note_id: snapshot.note.id,
      title: snapshot.item.title,
    })),
    mastered_knowledge_ids: children
      .filter((child) => existingSnapshots.get(child.id)?.item.status === 'done')
      .map((child) => child.id),
    prerequisite_edges: [...prerequisiteEdges],
    existing_descendants_count: children.length,
    // The prompt contract points domain values at this list; 'general' is deliberately
    // absent (fallback identity, never a node domain).
    valid_domains: getDefaultSubjectRegistry().getSelectableSubjectIds(),
    output_contract:
      planCase === '3c_existing_graph'
        ? 'Return hub + atomics. Each atomic.knowledge_id must be one of child_nodes[].id.'
        : 'Return knowledge plus hub + atomics. knowledge.children temp_id values are the only valid atomic.knowledge_id values.',
  };

  const result = await runTaskFn('LearningIntentOutlineTask', input, {
    subjectProfile: resolveSubjectProfile(node?.domain),
  });
  try {
    return await persistLearningIntentOutline(db, topic, planCase, node, children, result, {
      existingSnapshots,
      prerequisiteEdges,
    });
  } catch (err) {
    const costBasis = result.cost_basis ?? 'unknown';
    const taskRunId = result.task_run_id ?? null;
    if (err instanceof LearningIntentError) {
      noteLearningIntentFailure(err, {
        taskRunId,
        costBasis,
        domainOutcome: 'outline_rejected',
        code: err.code,
        message: err.message,
      });
      throw err;
    }
    const message = err instanceof Error ? err.message : 'proposal persist failed';
    const wrapped = new LearningIntentError('proposal_failed', message);
    noteLearningIntentFailure(wrapped, {
      taskRunId,
      costBasis,
      domainOutcome: 'proposal_failed',
      code: 'proposal_failed',
      message,
    });
    throw wrapped;
  }
}

async function persistLearningIntentOutline(
  db: Db,
  topic: string,
  planCase: LearningIntentPlanCase,
  node: KnowledgeNodeRow | null,
  children: KnowledgeNodeRow[],
  result: Awaited<ReturnType<RunTaskFn>>,
  context: LearningIntentExistingContext,
): Promise<LearningIntentProposal> {
  const outline = parseLearningIntentOutline(result.text);
  const { existingSnapshots, prerequisiteEdges } = context;
  const completedKnowledgeIds = children
    .filter((child) => existingSnapshots.get(child.id)?.item.status === 'done')
    .map((child) => child.id);
  const existingItems = [...existingSnapshots.entries()].map(([knowledgeId, snapshot]) => ({
    knowledge_id: knowledgeId,
    item_id: snapshot.item.id,
    note_id: snapshot.note.id,
    title: snapshot.item.title,
  }));

  let knowledgeNode: LearningIntentProposal['knowledge_node'];
  let proposedKnowledge: ProposedKnowledgeGraph | undefined;
  let reviewedKnowledge: ReviewedKnowledge | undefined;

  if (planCase === '3c_existing_graph') {
    if (!node) {
      throw new LearningIntentError('topic_not_found', `knowledge topic vanished: ${topic}`);
    }
    const fault = checkProposalGraph(
      { rootKey: node.id, childKeys: children.map((child) => child.id) },
      outline.atomics,
      outline.longs,
      prerequisiteEdges,
    );
    if (fault) rejectGraphFault(fault, 'outline');
    rejectPrerequisiteFault(
      checkProposalPrerequisites(
        { rootKey: node.id, childKeys: children.map((child) => child.id) },
        outline.atomics,
        outline.longs,
        prerequisiteEdges,
      ),
    );
    reviewedKnowledge = {
      root: reviewNode(node),
      children: children.map(reviewNode),
    };
    knowledgeNode = { id: node.id, name: node.name, domain: node.domain };
  } else {
    const knowledgeSpec = outline.knowledge;
    if (!knowledgeSpec) {
      failInvalidOutline(`${planCase} outline must include knowledge`);
    }
    const root =
      planCase === '3a_topic_missing'
        ? (() => {
            const raw =
              knowledgeSpec.root ?? failInvalidOutline('3a outline must include knowledge.root');
            // A NEW topic root must carry a real selectable subject: 'general' and any
            // unresolvable string fail closed rather than materialising an invisible or
            // orphan-domain root. Children get sanitise-then-inherit via normalizeProposedNode.
            return {
              temp_id: raw.temp_id,
              name: raw.name,
              domain: resolveSelectableSubjectId(raw.domain),
            };
          })()
        : undefined;
    if (planCase === '3a_topic_missing' && !root?.domain) {
      failInvalidOutline(
        '3a knowledge.root.domain must resolve to a selectable subject id (see input.valid_domains)',
      );
    }
    // root?.domain is already canonicalised; an existing node's stored domain goes through
    // the same sanitiser so a corrupt 'general' can't leak into proposed children while
    // legacy unresolvable domains keep their verbatim storage.
    const rootDomain = root?.domain ?? sanitizeProposedNodeDomain(node?.domain) ?? null;
    const proposedChildren = (knowledgeSpec.children ?? []).map((child) =>
      normalizeProposedNode(child, rootDomain),
    );
    if (proposedChildren.length === 0) {
      failInvalidOutline(`${planCase} outline must include at least one knowledge.children entry`);
    }
    const rootKey =
      planCase === '3a_topic_missing'
        ? (root?.temp_id ?? failInvalidOutline('3a outline must include knowledge.root'))
        : (node?.id ?? failInvalidOutline(`${planCase} outline is missing the topic node`));
    const fault = checkProposalGraph(
      { rootKey, childKeys: proposedChildren.map((child) => child.temp_id) },
      outline.atomics,
      outline.longs,
      [],
    );
    if (fault) rejectGraphFault(fault, 'outline');
    rejectPrerequisiteFault(
      checkProposalPrerequisites(
        { rootKey, childKeys: proposedChildren.map((child) => child.temp_id) },
        outline.atomics,
        outline.longs,
        [],
      ),
    );
    if (planCase === '3b_children_missing' && node) {
      reviewedKnowledge = { root: reviewNode(node) };
    }

    proposedKnowledge = {
      ...(root ? { root } : {}),
      children: proposedChildren,
    };
    knowledgeNode = node
      ? { id: node.id, name: node.name, domain: node.domain }
      : { id: root?.temp_id ?? 'root', name: root?.name ?? topic, domain: root?.domain ?? null };
  }

  const legacyPayload = {
    topic,
    plan_case: planCase,
    knowledge_node_id: node?.id ?? null,
    knowledge_node: knowledgeNode,
    proposed_knowledge: proposedKnowledge,
    existing_items: existingItems,
    mastered_knowledge_ids: completedKnowledgeIds,
    prerequisite_edges: [...prerequisiteEdges],
    task_run_id: result.task_run_id ?? null,
    cost_micro_usd: costUsdToMicroUsd(result.cost_usd),
    hub: outline.hub,
    atomics: outline.atomics,
    longs: outline.longs,
    ...(reviewedKnowledge ? { reviewed_knowledge: reviewedKnowledge } : {}),
  };
  // 3c is the only auto-applied case; reuse the learner's own topic instead of
  // the technical reason line. A topic that trips the learner-copy gate falls
  // back to the fixed kind sentence at anchor write time.
  const learnerSummary =
    planCase === '3c_existing_graph'
      ? learnerSummaryIfAllowed(`为你把「${topic.replace(/\s+/g, ' ').trim()}」整理成一条学习路径`)
      : undefined;
  const proposalId = await writeLearningItemProposal(db, {
    topic,
    plan_case: planCase,
    ...(learnerSummary !== undefined ? { learner_summary: learnerSummary } : {}),
    // 3a/3b mint knowledge nodes on accept, but the learning_item retract lane only
    // archives items/artifacts. Keep them human-reviewed rather than auto-applied;
    // 3c writes no knowledge and is the only fully retractable case.
    auto_apply_eligible: planCase === '3c_existing_graph',
    knowledge_node: knowledgeNode,
    proposed_knowledge: proposedKnowledge,
    existing_items: existingItems,
    mastered_knowledge_ids: completedKnowledgeIds,
    prerequisite_edges: prerequisiteEdges,
    hub: outline.hub,
    atomics: outline.atomics,
    longs: outline.longs,
    reason_md: `学习路径提议：${topic}`,
    legacy_subject_id: newId(), // synthetic — hub artifact id assigned at accept
    legacy_event_payload: legacyPayload,
    task_run_id: result.task_run_id ?? null,
    cost_usd: result.cost_usd,
    created_at: new Date(),
  });

  return {
    proposal_id: proposalId,
    topic,
    plan_case: planCase,
    knowledge_node: knowledgeNode,
    ...(proposedKnowledge ? { proposed_knowledge: proposedKnowledge } : {}),
    existing_items: existingItems,
    mastered_knowledge_ids: completedKnowledgeIds,
    prerequisite_edges: prerequisiteEdges,
    hub: outline.hub,
    atomics: outline.atomics,
    longs: outline.longs,
  };
}

// ---------- acceptLearningIntent ----------

export interface CreateLearningIntentKnowledgeNodeInput {
  id: string;
  name: string;
  domain: string | null;
  parentId: string | null;
  createdAt: Date;
  causedByEventId: string;
  /**
   * The topic root is a learning goal, not a testable KC: it must not carry
   * θ/PFA/FSRS readings or enter supply candidates. Absent means the default 'kc'.
   */
  role?: 'goal' | 'container';
}

export type CreateLearningIntentKnowledgeNodeFn = (
  tx: Tx,
  input: CreateLearningIntentKnowledgeNodeInput,
) => Promise<void>;

/** Approved node birth for one learning-intent accept. Provenance stays with the caller. */
export const createLearningIntentKnowledgeNode: CreateLearningIntentKnowledgeNodeFn = async (
  tx,
  input,
) => {
  await createKnowledgeNodeFromEvents(
    tx,
    {
      id: input.id,
      name: input.name,
      domain: input.domain,
      parent_id: input.parentId,
      proposed_by_ai: true,
      role: input.role,
      created_at: input.createdAt,
    },
    { actorRef: 'learning-intent-accept', causedByEventId: input.causedByEventId },
  );
};

export interface AcceptLearningIntentParams {
  /** The proposal decision transaction; the kernel already holds the lock and re-checked the rate. */
  tx: Tx;
  proposalId: string;
  createKnowledgeNode: CreateLearningIntentKnowledgeNodeFn;
  createNote: CreateLearningIntentNoteFn;
  writeRate: ProposalAcceptEffectContext['writeRate'];
}

interface ProposalEventRow {
  id: string;
  payload: {
    topic: string;
    plan_case?: LearningIntentPlanCase;
    knowledge_node_id: string | null;
    knowledge_node?: { id: string; name: string; domain: string | null };
    proposed_knowledge?: ProposedKnowledgeGraph;
    existing_items?: ExistingLearningIntentItem[];
    mastered_knowledge_ids?: string[];
    prerequisite_edges?: LearningIntentPrerequisiteEdge[];
    reviewed_knowledge?: ReviewedKnowledge;
    task_run_id?: string | null;
    cost_micro_usd?: number | null;
    hub: HubProposal;
    atomics: AtomicProposal[];
    longs?: LongProposal[];
  };
}

async function readProposal(db: Db | Tx, proposalId: string): Promise<ProposalEventRow> {
  const { event } = await import('@/db/schema');
  const rows = await db
    .select({
      id: event.id,
      action: event.action,
      payload: event.payload,
    })
    .from(event)
    .where(eq(event.id, proposalId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new LearningIntentError('proposal_not_found', `proposal ${proposalId} not found`);
  }
  if (row.action !== 'experimental:propose_learning_intent') {
    throw new LearningIntentError(
      'proposal_not_found',
      `event ${proposalId} is not a learning intent proposal (action=${row.action})`,
    );
  }
  return { id: row.id, payload: row.payload as ProposalEventRow['payload'] };
}

function requirePlanCase(value: unknown): LearningIntentPlanCase {
  if (
    value === '3a_topic_missing' ||
    value === '3b_children_missing' ||
    value === '3c_existing_graph'
  ) {
    return value;
  }
  if (value === undefined) return '3c_existing_graph';
  throw new LearningIntentError(
    'llm_parse_failed',
    'proposal plan_case is not a learning intent case',
  );
}

function requireTempId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LearningIntentError('llm_parse_failed', `${label} is missing temp_id`);
  }
  return value;
}

function readStringId(value: unknown, label: string): string {
  try {
    return readProposalStringId(value, label);
  } catch (err) {
    throw new LearningIntentError('invalid_atomic_knowledge_id', (err as Error).message);
  }
}

function readProposedNode(value: unknown, label: string): ProposedKnowledgeNode {
  if (!value || typeof value !== 'object') {
    throw new LearningIntentError('llm_parse_failed', `${label} is missing`);
  }
  const row = value as { temp_id?: unknown; name?: unknown; domain?: string | null };
  return {
    temp_id: requireTempId(row.temp_id, label),
    name: typeof row.name === 'string' ? row.name : '',
    domain: typeof row.domain === 'string' || row.domain === null ? row.domain : null,
  };
}

function readProposedChildren(
  value: unknown,
  planCase: LearningIntentPlanCase,
): ProposedKnowledgeNode[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new LearningIntentError(
      'llm_parse_failed',
      `${planCase} proposal missing proposed children`,
    );
  }
  return value.map((child, index) => readProposedNode(child, `${planCase} child ${index}`));
}

function readAtomics(value: unknown): AtomicProposal[] {
  try {
    return readProposalAtomics(value);
  } catch (err) {
    throw new LearningIntentError('llm_parse_failed', (err as Error).message);
  }
}

function readLongs(value: unknown): LongProposal[] {
  try {
    return readProposalLongs(value);
  } catch (err) {
    throw new LearningIntentError('llm_parse_failed', (err as Error).message);
  }
}

function readExistingItems(value: unknown): ExistingLearningIntentItem[] {
  try {
    return readProposalExistingItems(value);
  } catch (err) {
    throw new LearningIntentError('llm_parse_failed', (err as Error).message);
  }
}

function readPrerequisiteEdges(value: unknown): LearningIntentPrerequisiteEdge[] {
  try {
    return readProposalPrerequisiteEdges(value);
  } catch (err) {
    throw new LearningIntentError('llm_parse_failed', (err as Error).message);
  }
}

function readReviewedNode(value: unknown): ReviewedKnowledgeNode | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as { id?: unknown; parent_id?: unknown; version?: unknown };
  if (typeof row.id !== 'string' || row.id.length === 0) return null;
  if (typeof row.parent_id !== 'string' && row.parent_id !== null) return null;
  if (typeof row.version !== 'number' || !Number.isInteger(row.version)) return null;
  return { id: row.id, parent_id: row.parent_id, version: row.version };
}

function readReviewedKnowledge(value: unknown): ReviewedKnowledge | null {
  if (!value || typeof value !== 'object') return null;
  const root = readReviewedNode((value as { root?: unknown }).root);
  if (!root) return null;
  const rawChildren = (value as { children?: unknown }).children;
  if (rawChildren === undefined) return { root };
  if (!Array.isArray(rawChildren)) return null;
  const children: ReviewedKnowledgeNode[] = [];
  for (const item of rawChildren) {
    const child = readReviewedNode(item);
    if (!child) return null;
    children.push(child);
  }
  return { root, children };
}

function readOptionalReviewed(
  value: unknown,
  shape: 'root' | 'children',
): ReviewedKnowledge | null {
  if (value === undefined || value === null) return null;
  const reviewed = readReviewedKnowledge(value);
  if (!reviewed) {
    throw new LearningIntentError('llm_parse_failed', 'proposal reviewed knowledge is unreadable');
  }
  if (shape === 'children' && !reviewed.children) {
    throw new LearningIntentError(
      'llm_parse_failed',
      'proposal reviewed knowledge is missing children',
    );
  }
  return reviewed;
}

function compatibilityFor(
  id: string,
  role: 'root' | 'child',
  rootId: string,
  reviewed: ReviewedKnowledge | null,
): KnowledgeCompatibility {
  const recorded =
    role === 'root' ? reviewed?.root : reviewed?.children?.find((child) => child.id === id);
  if (recorded && recorded.id === id) {
    return { id, parentId: recorded.parent_id, version: recorded.version, recorded: true };
  }
  if (role === 'child') return { id, parentId: rootId, recorded: false };
  return { id, recorded: false };
}

interface AcceptSpec {
  readonly planCase: LearningIntentPlanCase;
  readonly graph: ProposalGraph;
  readonly rootToMint: ProposedKnowledgeNode | null;
  readonly childrenToMint: readonly ProposedKnowledgeNode[];
  readonly existing: readonly KnowledgeCompatibility[];
  readonly existingRootId: string | null;
  readonly atomics: readonly AtomicProposal[];
  readonly longs: readonly LongProposal[];
  readonly hub: HubProposal;
  readonly topic: string;
  readonly knowledgeNodeDomain: string | null;
  readonly taskRunId: string | null;
  readonly costMicroUsd: number | null;
  /** Old 3c proposals did not record children. Their legal set is the locked active children. */
  readonly resolveActiveChildren: boolean;
  readonly existingItems: readonly ExistingLearningIntentItem[];
  readonly masteredKnowledgeIds: readonly string[];
  readonly prerequisiteEdges: readonly LearningIntentPrerequisiteEdge[];
}

function readAcceptSpec(payload: ProposalEventRow['payload']): AcceptSpec {
  const planCase = requirePlanCase(payload.plan_case);
  const atomics = readAtomics(payload.atomics);
  const longs = readLongs(payload.longs);
  const hub = payload.hub;
  if (!hub || typeof hub.title !== 'string' || typeof hub.summary_md !== 'string') {
    throw new LearningIntentError('llm_parse_failed', 'proposal is missing hub');
  }
  const shared = {
    planCase,
    atomics,
    longs,
    hub,
    topic: typeof payload.topic === 'string' ? payload.topic : '',
    knowledgeNodeDomain: payload.knowledge_node?.domain ?? null,
    taskRunId: payload.task_run_id ?? null,
    costMicroUsd: payload.cost_micro_usd ?? null,
    resolveActiveChildren: false,
    existingItems: readExistingItems(payload.existing_items),
    masteredKnowledgeIds: Array.isArray(payload.mastered_knowledge_ids)
      ? payload.mastered_knowledge_ids.map((id, index) =>
          readStringId(id, `mastered knowledge id ${index}`),
        )
      : [],
    prerequisiteEdges: readPrerequisiteEdges(payload.prerequisite_edges),
  };

  if (planCase === '3a_topic_missing') {
    const root = readProposedNode(payload.proposed_knowledge?.root, '3a proposal root');
    const children = readProposedChildren(payload.proposed_knowledge?.children, planCase);
    return {
      ...shared,
      graph: { rootKey: root.temp_id, childKeys: children.map((child) => child.temp_id) },
      rootToMint: root,
      childrenToMint: children,
      existing: [],
      existingRootId: null,
    };
  }

  const rootId = payload.knowledge_node_id;
  if (typeof rootId !== 'string' || rootId.length === 0) {
    throw new LearningIntentError(
      'llm_parse_failed',
      `${planCase} proposal missing knowledge_node_id`,
    );
  }

  if (planCase === '3b_children_missing') {
    const children = readProposedChildren(payload.proposed_knowledge?.children, planCase);
    const reviewed = readOptionalReviewed(payload.reviewed_knowledge, 'root');
    if (reviewed && reviewed.root.id !== rootId) {
      throw new LearningIntentError(
        'invalid_atomic_knowledge_id',
        'proposal reviewed root does not match knowledge_node_id',
      );
    }
    return {
      ...shared,
      graph: { rootKey: rootId, childKeys: children.map((child) => child.temp_id) },
      rootToMint: null,
      childrenToMint: children,
      existing: [compatibilityFor(rootId, 'root', rootId, reviewed)],
      existingRootId: rootId,
    };
  }

  const reviewed = readOptionalReviewed(payload.reviewed_knowledge, 'children');
  if (reviewed && reviewed.root.id !== rootId) {
    throw new LearningIntentError(
      'invalid_atomic_knowledge_id',
      'proposal reviewed root does not match knowledge_node_id',
    );
  }
  const childIds = reviewed?.children?.map((child) => child.id) ?? [];
  return {
    ...shared,
    graph: { rootKey: rootId, childKeys: childIds },
    rootToMint: null,
    childrenToMint: [],
    existing: [
      compatibilityFor(rootId, 'root', rootId, reviewed),
      ...childIds.map((id) => compatibilityFor(id, 'child', rootId, reviewed)),
    ],
    existingRootId: rootId,
    resolveActiveChildren: !reviewed?.children,
  };
}

function withLockedActiveChildren(
  spec: AcceptSpec,
  locked: readonly LockedKnowledgeRow[],
): AcceptSpec {
  const rootId = spec.existingRootId;
  if (!rootId) return spec;
  const childIds = locked
    .filter((row) => row.id !== rootId && row.parent_id === rootId && row.archived_at === null)
    .map((row) => row.id);
  return {
    ...spec,
    resolveActiveChildren: false,
    graph: { rootKey: rootId, childKeys: childIds },
    existing: [
      ...spec.existing.filter((node) => node.id === rootId),
      ...childIds.map((id) => compatibilityFor(id, 'child', rootId, null)),
    ],
  };
}

/**
 * Materializes a proposal: 1 hub LearningItem + N atomic LearningItems (parent-linked) +
 * paired hub artifact + N atomic artifact stubs (body_blocks=null, generation_status='pending'),
 * then writes the accept rate event chained to the proposal. Runs as the accept effect of the
 * kernel decision transaction; the caller enqueues note_generate jobs after it commits.
 *
 * The id graph is checked before any knowledge, learning-item, or note write. A referenced
 * row that was archived, merged, or reparented raises LearningIntentStaleError instead.
 */
export async function acceptLearningIntent(
  params: AcceptLearningIntentParams,
): Promise<LearningIntentMaterializeResult> {
  const { createKnowledgeNode, createNote, tx, proposalId, writeRate } = params;
  const proposal = await readProposal(tx, proposalId);
  const read = readAcceptSpec(proposal.payload);
  let spec = read;
  if (read.resolveActiveChildren && read.existingRootId) {
    const locked = await lockLegacyKnowledge(tx, read.existingRootId, citedKnowledgeIds(read));
    // An archived or moved citation is stale. The active-child check would
    // report that same id as unknown and leave the proposal pending.
    const staleId = staleCitedId(read, locked);
    if (staleId) throw new LearningIntentStaleError(staleId);
    spec = withLockedActiveChildren(read, locked);
  }
  const fault = checkProposalGraph(spec.graph, spec.atomics, spec.longs);
  if (fault) rejectGraphFault(fault, 'proposal');
  rejectPrerequisiteFault(
    checkProposalPrerequisites(spec.graph, spec.atomics, spec.longs, spec.prerequisiteEdges),
  );
  await assertKnowledgeCompatible(tx, spec.existing);

  const now = new Date();
  // Mint the RATE event id up-front so the same-tx artifact_create events can chain caused_by
  // to it (the accept is what materializes these artifacts). caused_by has no FK, so emitting
  // the create events BEFORE the rate row exists in the tx is safe.
  const rateEventId = newId();
  const createdKnowledgeIds: string[] = [];
  const bindings = new Map<string, string>();

  let rootKnowledgeId: string;
  if (spec.rootToMint) {
    const root = spec.rootToMint;
    const rootDomain = resolveSelectableSubjectId(root.domain);
    if (!rootDomain) {
      throw new LearningIntentError(
        'llm_parse_failed',
        '3a proposal root.domain is not a registered selectable subject',
      );
    }
    rootKnowledgeId = newId();
    bindKnowledgeId(bindings, root.temp_id, rootKnowledgeId);
    createdKnowledgeIds.push(rootKnowledgeId);

    // A domain-bearing topic root parents under its subject's seed anchor (seed:<domain>:root)
    // so every content node stays transitively inside its subject tree (same convention as
    // placement-starter goal-kc). A domain without a seeded anchor (custom/unseeded identity)
    // stays a standalone root — honest, not silently re-anchored.
    const seedRootId = `seed:${rootDomain}:root`;
    const seedRoot = (
      await tx
        .select({ id: knowledge.id })
        .from(knowledge)
        .where(and(eq(knowledge.id, seedRootId), isNull(knowledge.archived_at)))
        .limit(1)
    )[0];

    await createKnowledgeNode(tx, {
      id: rootKnowledgeId,
      name: root.name,
      domain: rootDomain,
      parentId: seedRoot?.id ?? null,
      createdAt: now,
      causedByEventId: rateEventId,
      // The topic root is the learner's declared GOAL (「我想学 X」), not a testable
      // KC: the proposed children below carry the testable knowledge.
      role: 'goal',
    });
  } else if (spec.existingRootId) {
    rootKnowledgeId = spec.existingRootId;
    bindKnowledgeId(bindings, spec.graph.rootKey, rootKnowledgeId);
  } else {
    throw new LearningIntentError(
      'llm_parse_failed',
      `${spec.planCase} proposal missing knowledge_node_id`,
    );
  }

  if (spec.childrenToMint.length > 0) {
    // Sanitise every persisted domain so a stale proposal carrying 'general' cannot leak
    // into knowledge.domain at accept time either; legitimately unresolvable domains keep
    // the same verbatim passthrough the write seam applies.
    const fallbackDomain =
      sanitizeProposedNodeDomain(spec.rootToMint?.domain) ??
      sanitizeProposedNodeDomain(spec.knowledgeNodeDomain) ??
      null;
    for (const child of spec.childrenToMint) {
      const childId = newId();
      bindKnowledgeId(bindings, child.temp_id, childId);
      createdKnowledgeIds.push(childId);
      await createKnowledgeNode(tx, {
        id: childId,
        name: child.name,
        domain: sanitizeProposedNodeDomain(child.domain) ?? fallbackDomain,
        parentId: rootKnowledgeId,
        createdAt: now,
        causedByEventId: rateEventId,
      });
    }
  }

  for (const node of spec.existing) {
    if (node.id === rootKnowledgeId) continue;
    bindKnowledgeId(bindings, node.id, node.id);
  }

  const { hub, topic } = spec;
  const proposalTaskRunId = spec.taskRunId;
  const proposalCostMicroUsd = spec.costMicroUsd;
  const resolvedAtomics = spec.atomics.map((atomic, index) => ({
    ...atomic,
    proposal_item_id: `atomic:${index}`,
    knowledge_id: boundKnowledgeId(bindings, atomic.knowledge_id, 'atomic'),
  }));
  const resolvedLongs = spec.longs.map((long, index) => ({
    ...long,
    proposal_item_id: `long:${index}`,
    knowledge_ids: long.knowledge_ids.map((knowledgeId) =>
      boundKnowledgeId(bindings, knowledgeId, 'long'),
    ),
  }));
  const existingByKnowledge = new Map(
    spec.existingItems.map((entry) => [
      bindings.get(entry.knowledge_id) ?? entry.knowledge_id,
      entry,
    ]),
  );
  const currentReferences = new Map<string, { item_id: string; note_id: string }>();
  for (const entry of spec.existingItems) {
    const snapshot = await readExistingItemReference(tx, entry);
    if (snapshot) currentReferences.set(entry.item_id, entry);
  }
  const mastered = new Set(spec.masteredKnowledgeIds.map((id) => bindings.get(id) ?? id));
  const actions: LearningIntentMaterializeAction[] = [];

  // Hub LearningItem
  const hubLiId = newId();
  const hubArtifactId = newId();

  await createPendingLearningItem(
    tx,
    {
      id: hubLiId,
      source: 'learning_intent',
      source_ref: proposalId,
      title: hub.title,
      content: hub.summary_md,
      knowledge_ids: [rootKnowledgeId],
      primary_artifact_id: hubArtifactId,
      parent_learning_item_id: null,
    },
    now,
  );
  actions.push({
    kind: 'hub',
    proposal_item_id: null,
    knowledge_ids: [rootKnowledgeId],
    action: 'create',
    reason: 'new',
    learning_item_id: hubLiId,
    note_id: hubArtifactId,
  });

  // Atomic LearningItems
  const atomicLiIds: string[] = [];
  const atomicArtifactIds: string[] = [];
  for (const atomic of resolvedAtomics) {
    const existing = existingByKnowledge.get(atomic.knowledge_id);
    if (existing && currentReferences.has(existing.item_id)) {
      actions.push({
        kind: 'atomic',
        proposal_item_id: atomic.proposal_item_id,
        knowledge_ids: [atomic.knowledge_id],
        action: 'reuse',
        reason: 'existing_item',
        learning_item_id: existing.item_id,
        note_id: existing.note_id,
      });
      atomicLiIds.push(existing.item_id);
      atomicArtifactIds.push(existing.note_id);
      continue;
    }
    if (mastered.has(atomic.knowledge_id)) {
      actions.push({
        kind: 'atomic',
        proposal_item_id: atomic.proposal_item_id,
        knowledge_ids: [atomic.knowledge_id],
        action: 'skip',
        reason: 'mastered',
        learning_item_id: null,
        note_id: null,
      });
      continue;
    }
    const atomicLiId = newId();
    const atomicArtifactId = newId();
    atomicLiIds.push(atomicLiId);
    atomicArtifactIds.push(atomicArtifactId);

    await createPendingLearningItem(
      tx,
      {
        id: atomicLiId,
        source: 'learning_intent',
        source_ref: proposalId,
        title: atomic.title,
        content: atomic.one_line_intent,
        knowledge_ids: [atomic.knowledge_id],
        primary_artifact_id: atomicArtifactId,
        parent_learning_item_id: hubLiId,
      },
      now,
    );
    actions.push({
      kind: 'atomic',
      proposal_item_id: atomic.proposal_item_id,
      knowledge_ids: [atomic.knowledge_id],
      action: 'create',
      reason: 'new',
      learning_item_id: atomicLiId,
      note_id: atomicArtifactId,
    });
  }

  // Long LearningItems
  const longLiIds: string[] = [];
  const longArtifactIds: string[] = [];
  for (const long of resolvedLongs) {
    const existing = long.knowledge_ids.map((id) => existingByKnowledge.get(id)).find(Boolean);
    if (existing && currentReferences.has(existing.item_id)) {
      actions.push({
        kind: 'long',
        proposal_item_id: long.proposal_item_id,
        knowledge_ids: long.knowledge_ids,
        action: 'reuse',
        reason: 'existing_item',
        learning_item_id: existing.item_id,
        note_id: existing.note_id,
      });
      longLiIds.push(existing.item_id);
      longArtifactIds.push(existing.note_id);
      continue;
    }
    if (long.knowledge_ids.length > 0 && long.knowledge_ids.every((id) => mastered.has(id))) {
      actions.push({
        kind: 'long',
        proposal_item_id: long.proposal_item_id,
        knowledge_ids: long.knowledge_ids,
        action: 'skip',
        reason: 'mastered',
        learning_item_id: null,
        note_id: null,
      });
      continue;
    }
    const longLiId = newId();
    const longArtifactId = newId();
    longLiIds.push(longLiId);
    longArtifactIds.push(longArtifactId);

    await createPendingLearningItem(
      tx,
      {
        id: longLiId,
        source: 'learning_intent',
        source_ref: proposalId,
        title: long.title,
        content: long.one_line_intent,
        knowledge_ids: long.knowledge_ids,
        primary_artifact_id: longArtifactId,
        parent_learning_item_id: hubLiId,
      },
      now,
    );
    actions.push({
      kind: 'long',
      proposal_item_id: long.proposal_item_id,
      knowledge_ids: long.knowledge_ids,
      action: 'create',
      reason: 'new',
      learning_item_id: longLiId,
      note_id: longArtifactId,
    });
  }

  // Notes owns artifact rows, create events, and durable generation intents. Agency
  // supplies the already-minted IDs so LearningItem↔artifact pairing and atomic/long
  // ordering stay identical inside this acceptance transaction.
  await createNote(tx, {
    kind: 'hub',
    id: hubArtifactId,
    title: hub.title,
    topic,
    summaryMd: hub.summary_md,
    knowledgeIds: [rootKnowledgeId],
    parentArtifactId: null,
    proposalId,
    rateEventId,
    taskRunId: proposalTaskRunId ?? null,
    linkedArtifactIds: [
      ...actions.filter((action) => action.note_id).map((action) => action.note_id as string),
    ],
    atomicArtifactIds: actions
      .filter((action) => action.kind === 'atomic' && action.note_id)
      .map((action) => action.note_id as string),
    longArtifactIds: actions
      .filter((action) => action.kind === 'long' && action.note_id)
      .map((action) => action.note_id as string),
    createdAt: now,
  });

  for (let i = 0; i < resolvedAtomics.length; i++) {
    const atomicNode = resolvedAtomics[i];
    const action = actions.find((entry) => entry.proposal_item_id === atomicNode.proposal_item_id);
    if (action?.action !== 'create') continue;
    await createNote(tx, {
      kind: 'atomic',
      id: action.note_id ?? atomicArtifactIds[i],
      title: atomicNode.title,
      oneLineIntent: atomicNode.one_line_intent,
      knowledgeIds: [atomicNode.knowledge_id],
      parentArtifactId: hubArtifactId,
      proposalId,
      rateEventId,
      taskRunId: proposalTaskRunId ?? null,
      createdAt: now,
    });
  }

  for (let i = 0; i < resolvedLongs.length; i++) {
    const longNode = resolvedLongs[i];
    const action = actions.find((entry) => entry.proposal_item_id === longNode.proposal_item_id);
    if (action?.action !== 'create') continue;
    await createNote(tx, {
      kind: 'long',
      id: action.note_id ?? longArtifactIds[i],
      title: longNode.title,
      oneLineIntent: longNode.one_line_intent,
      knowledgeIds: longNode.knowledge_ids,
      parentArtifactId: hubArtifactId,
      proposalId,
      rateEventId,
      taskRunId: proposalTaskRunId ?? null,
      createdAt: now,
    });
  }

  // Rate event: marks proposal accepted, chains via caused_by_event_id
  await writeRate({
    id: rateEventId,
    omitUserNote: true,
    task_run_id: proposalTaskRunId ?? null,
    cost_micro_usd: proposalCostMicroUsd ?? null,
    // The RATE parent shares `now` with its artifact_create children so the caused_by
    // chain never inverts under created_at ordering.
    created_at: now,
  });

  return {
    hub_learning_item_id: hubLiId,
    atomic_learning_item_ids: atomicLiIds,
    long_learning_item_ids: longLiIds,
    hub_artifact_id: hubArtifactId,
    atomic_artifact_ids: atomicArtifactIds,
    long_artifact_ids: longArtifactIds,
    enqueued_note_generate_jobs: 0, // caller enqueues
    root_knowledge_id: rootKnowledgeId,
    created_knowledge_ids: createdKnowledgeIds,
    actions,
  };
}
