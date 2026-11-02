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
// Notes default source_tier='llm_only'; no NoteVerifyTask; no Search-grounded. Embedded
// check is a placeholder (empty question_ids); hub status aggregation and living-note
// triggers remain out of scope.

import { and, eq, isNull } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
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

export type { LearningIntentOutline } from '../tasks/learning-intent';
export { LearningIntentError, parseLearningIntentOutline };

// ---------- Public types ----------

export interface HubProposal {
  title: string;
  summary_md: string;
}

export interface AtomicProposal {
  knowledge_id: string;
  title: string;
  one_line_intent: string;
}

export interface LongProposal {
  knowledge_ids: string[];
  title: string;
  one_line_intent: string;
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
  hub: HubProposal;
  atomics: AtomicProposal[];
  longs: LongProposal[];
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
}

export type RunTaskFn = TaskTextRunFn;

export interface PlanLearningIntentParams {
  db: Db;
  topic: string;
  runTaskFn: RunTaskFn;
}

// ---------- Knowledge graph lookup ----------

interface KnowledgeNodeRow {
  id: string;
  name: string;
  domain: string | null;
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

function validateAtomicKnowledgeIds(
  allowedIds: Set<string>,
  atomics: AtomicProposal[],
  message: string,
) {
  for (const atomic of atomics) {
    if (!allowedIds.has(atomic.knowledge_id)) {
      throw new LearningIntentError(
        'invalid_atomic_knowledge_id',
        `${message}: ${atomic.knowledge_id}`,
      );
    }
  }
}

function validateLongKnowledgeIds(allowedIds: Set<string>, longs: LongProposal[], message: string) {
  for (const long of longs) {
    for (const knowledgeId of long.knowledge_ids) {
      if (!allowedIds.has(knowledgeId)) {
        throw new LearningIntentError('invalid_atomic_knowledge_id', `${message}: ${knowledgeId}`);
      }
    }
  }
}

async function findTopicNode(db: Db, topic: string): Promise<KnowledgeNodeRow | null> {
  const normalized = topic.trim().toLowerCase();
  if (!normalized) return null;
  // Case-insensitive exact match on knowledge.name first; if multiple match, the
  // first by created_at wins (user must disambiguate at /knowledge).
  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
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
    .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
    .from(knowledge)
    .where(and(eq(knowledge.parent_id, parentId), isNull(knowledge.archived_at)));
}

// ---------- planLearningIntent ----------

/**
 * Locate the topic in the knowledge graph, decide whether the graph needs bootstrapping,
 * ask the LLM for a 1-hub + N-atomic outline, then persist it as a `propose` event.
 *
 * Throws LearningIntentError for llm_parse_failed (output violates the outline schema) and
 * invalid_atomic_knowledge_id (hallucinated ids outside child_nodes / proposed children).
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

  const input = {
    topic,
    plan_case: planCase,
    knowledge_node: node ? { id: node.id, name: node.name, domain: node.domain } : null,
    child_nodes: children.map((c) => ({ id: c.id, name: c.name })),
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
  const outline = parseLearningIntentOutline(result.text);

  let knowledgeNode: LearningIntentProposal['knowledge_node'];
  let proposedKnowledge: ProposedKnowledgeGraph | undefined;

  if (planCase === '3c_existing_graph') {
    if (!node) {
      throw new LearningIntentError('topic_not_found', `knowledge topic vanished: ${topic}`);
    }
    const childIds = new Set(children.map((c) => c.id));
    validateAtomicKnowledgeIds(
      childIds,
      outline.atomics,
      "LLM proposed knowledge_id that is not in the topic's child nodes",
    );
    validateLongKnowledgeIds(
      new Set([node.id, ...children.map((c) => c.id)]),
      outline.longs,
      'LLM proposed long.knowledge_ids entry that is not in the topic graph',
    );
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
    validateAtomicKnowledgeIds(
      new Set(proposedChildren.map((child) => child.temp_id)),
      outline.atomics,
      'LLM proposed knowledge_id that is not in proposed knowledge.children',
    );
    validateLongKnowledgeIds(
      new Set([
        ...(root ? [root.temp_id] : []),
        ...(node ? [node.id] : []),
        ...proposedChildren.map((child) => child.temp_id),
      ]),
      outline.longs,
      'LLM proposed long.knowledge_ids entry that is not in proposed knowledge graph',
    );

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
    task_run_id: result.task_run_id ?? null,
    cost_micro_usd: costUsdToMicroUsd(result.cost_usd),
    hub: outline.hub,
    atomics: outline.atomics,
    longs: outline.longs,
  };
  const proposalId = await writeLearningItemProposal(db, {
    topic,
    plan_case: planCase,
    knowledge_node: knowledgeNode,
    proposed_knowledge: proposedKnowledge,
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
  db: Db;
  proposalId: string;
  createKnowledgeNode: CreateLearningIntentKnowledgeNodeFn;
  createNote: CreateLearningIntentNoteFn;
}

interface ProposalEventRow {
  id: string;
  payload: {
    topic: string;
    plan_case?: LearningIntentPlanCase;
    knowledge_node_id: string | null;
    knowledge_node?: { id: string; name: string; domain: string | null };
    proposed_knowledge?: ProposedKnowledgeGraph;
    task_run_id?: string | null;
    cost_micro_usd?: number | null;
    hub: HubProposal;
    atomics: AtomicProposal[];
    longs?: LongProposal[];
  };
}

async function readProposal(db: Db, proposalId: string): Promise<ProposalEventRow> {
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

async function assertNotAlreadyRated(db: Db, proposalId: string): Promise<void> {
  const { event } = await import('@/db/schema');
  const rows = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, 'rate'),
        eq(event.subject_kind, 'event'),
        eq(event.caused_by_event_id, proposalId),
      ),
    )
    .limit(1);
  if (rows.length > 0) {
    throw new LearningIntentError(
      'proposal_already_rated',
      `proposal ${proposalId} has already been accepted or dismissed`,
    );
  }
}

/**
 * Materializes a proposal: 1 hub LearningItem + N atomic LearningItems (parent-linked) +
 * paired hub artifact + N atomic artifact stubs (body_blocks=null, generation_status='pending'),
 * then writes a rate event chained to the proposal. Caller enqueues note_generate jobs after
 * this returns. All DB writes happen in a single transaction.
 */
export async function acceptLearningIntent(
  params: AcceptLearningIntentParams,
): Promise<LearningIntentMaterializeResult> {
  const { createKnowledgeNode, createNote, db, proposalId } = params;
  const proposal = await readProposal(db, proposalId);
  await assertNotAlreadyRated(db, proposalId);

  const {
    hub,
    atomics,
    topic,
    knowledge_node_id,
    plan_case: planCase = '3c_existing_graph',
    proposed_knowledge: proposedKnowledge,
    task_run_id: proposalTaskRunId,
    cost_micro_usd: proposalCostMicroUsd,
    longs = [],
  } = proposal.payload;
  const now = new Date();
  // Mint the RATE event id up-front so the same-tx artifact_create events can chain caused_by
  // to it (the accept is what materializes these artifacts). caused_by has no FK, so emitting
  // the create events BEFORE the rate row exists in the tx is safe.
  const rateEventId = newId();

  return db.transaction(async (tx) => {
    const createdKnowledgeIds: string[] = [];
    const tempIdToRealId = new Map<string, string>();
    let rootKnowledgeId = knowledge_node_id;

    if (planCase === '3a_topic_missing') {
      const root = proposedKnowledge?.root;
      if (!root) {
        throw new LearningIntentError('llm_parse_failed', '3a proposal missing proposed root');
      }
      const rootDomain = resolveSelectableSubjectId(root.domain);
      if (!rootDomain) {
        throw new LearningIntentError(
          'llm_parse_failed',
          '3a proposal root.domain is not a registered selectable subject',
        );
      }
      rootKnowledgeId = newId();
      tempIdToRealId.set(root.temp_id, rootKnowledgeId);
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
    }

    if (!rootKnowledgeId) {
      throw new LearningIntentError(
        'llm_parse_failed',
        `${planCase} proposal missing knowledge_node_id`,
      );
    }

    if (planCase === '3a_topic_missing' || planCase === '3b_children_missing') {
      const children = proposedKnowledge?.children ?? [];
      if (children.length === 0) {
        throw new LearningIntentError(
          'llm_parse_failed',
          `${planCase} proposal missing proposed children`,
        );
      }
      // Sanitise every persisted domain so a stale proposal carrying 'general' cannot leak
      // into knowledge.domain at accept time either; legitimately unresolvable domains keep
      // the same verbatim passthrough the write seam applies.
      const fallbackDomain =
        sanitizeProposedNodeDomain(proposedKnowledge?.root?.domain) ??
        sanitizeProposedNodeDomain(proposal.payload.knowledge_node?.domain) ??
        null;
      for (const child of children) {
        const childId = newId();
        tempIdToRealId.set(child.temp_id, childId);
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

    const resolvedAtomics = atomics.map((atomic) => {
      const resolvedKnowledgeId = tempIdToRealId.get(atomic.knowledge_id) ?? atomic.knowledge_id;
      if (
        (planCase === '3a_topic_missing' || planCase === '3b_children_missing') &&
        !tempIdToRealId.has(atomic.knowledge_id)
      ) {
        throw new LearningIntentError(
          'invalid_atomic_knowledge_id',
          `proposal atomic references unknown proposed knowledge_id=${atomic.knowledge_id}`,
        );
      }
      return { ...atomic, knowledge_id: resolvedKnowledgeId };
    });
    const resolvedLongs = longs.map((long) => {
      const resolvedKnowledgeIds = long.knowledge_ids.map((knowledgeId) => {
        const resolvedKnowledgeId = tempIdToRealId.get(knowledgeId) ?? knowledgeId;
        if (
          (planCase === '3a_topic_missing' || planCase === '3b_children_missing') &&
          !tempIdToRealId.has(knowledgeId) &&
          knowledgeId !== rootKnowledgeId
        ) {
          throw new LearningIntentError(
            'invalid_atomic_knowledge_id',
            `proposal long note references unknown proposed knowledge_id=${knowledgeId}`,
          );
        }
        return resolvedKnowledgeId;
      });
      return { ...long, knowledge_ids: resolvedKnowledgeIds };
    });

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

    // Atomic LearningItems
    const atomicLiIds: string[] = [];
    const atomicArtifactIds: string[] = [];
    for (const atomic of resolvedAtomics) {
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
    }

    // Long LearningItems
    const longLiIds: string[] = [];
    const longArtifactIds: string[] = [];
    for (const long of resolvedLongs) {
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
      linkedArtifactIds: [...atomicArtifactIds, ...longArtifactIds],
      atomicArtifactIds,
      longArtifactIds,
      createdAt: now,
    });

    for (let i = 0; i < resolvedAtomics.length; i++) {
      const atomicNode = resolvedAtomics[i];
      await createNote(tx, {
        kind: 'atomic',
        id: atomicArtifactIds[i],
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
      await createNote(tx, {
        kind: 'long',
        id: longArtifactIds[i],
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
    await writeEvent(tx, {
      id: rateEventId,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'success',
      payload: { rating: 'accept' },
      caused_by_event_id: proposalId,
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
    };
  });
}
