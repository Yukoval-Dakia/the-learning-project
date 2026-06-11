// Phase 2B — Learning Intent Orchestrator.
//
// User declares "我想学 X" → orchestrator reads the knowledge graph for X,
// asks LLM to propose a 1-hub + N-atomic split, persists the proposal as a
// `propose` event, awaits user accept, then materializes the LearningItem
// hierarchy + paired artifact stubs + enqueues N async NoteGenerateTask jobs.
//
// Case coverage:
//   - 3a: topic node missing -> propose root + starter children, materialize on accept.
//   - 3b: topic exists but child nodes missing -> propose starter children, materialize on accept.
//   - 3c: topic + children already exist -> propose 1 hub + N atomic outline over existing nodes.
// Notes default source_tier='llm_only'; no NoteVerifyTask; no Search-grounded.
// Embedded check is a placeholder (empty question_ids).
// Hub status auto-aggregation, living-note triggers, ai_propose completion
// remain out of scope.

import { newId } from '@/core/ids';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { summaryBodyBlocks } from '@/capabilities/notes/server/body-blocks';
import type { Db } from '@/db/client';
import { artifact, knowledge, learning_item } from '@/db/schema';
import { type TaskTextRunFn, aiAgentRef, costUsdToMicroUsd } from '@/server/ai/provenance';
import { writeEvent } from '@/server/events/queries';
import { writeLearningItemProposal } from '@/server/proposals/producers';
import { resolveSubjectProfile } from '@/subjects/profile';

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

// ---------- Errors ----------

export class LearningIntentError extends Error {
  constructor(
    public code:
      | 'topic_not_found'
      | 'topic_no_children'
      | 'llm_parse_failed'
      | 'invalid_atomic_knowledge_id'
      | 'proposal_not_found'
      | 'proposal_already_rated',
    message: string,
  ) {
    super(message);
    this.name = 'LearningIntentError';
  }
}

// ---------- LLM output schema ----------

const HubProposalSchema = z.object({
  title: z.string().min(1).max(80),
  summary_md: z.string().min(1).max(500),
});

const AtomicProposalSchema = z.object({
  knowledge_id: z.string().min(1),
  title: z.string().min(1).max(80),
  one_line_intent: z.string().min(1).max(200),
});

const LongProposalSchema = z.object({
  knowledge_ids: z.array(z.string().min(1)).min(1).max(12),
  title: z.string().min(1).max(80),
  one_line_intent: z.string().min(1).max(200),
});

const ProposedKnowledgeNodeSchema = z.object({
  temp_id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  domain: z.string().min(1).nullable().optional(),
});

const OutlineSchema = z.object({
  knowledge: z
    .object({
      root: ProposedKnowledgeNodeSchema.optional(),
      children: z.array(ProposedKnowledgeNodeSchema).optional(),
    })
    .optional(),
  hub: HubProposalSchema,
  atomics: z.array(AtomicProposalSchema).min(1),
  longs: z.array(LongProposalSchema).default([]),
});

export function parseLearningIntentOutline(text: string): z.infer<typeof OutlineSchema> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new LearningIntentError('llm_parse_failed', 'no JSON object found in outline output');
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new LearningIntentError('llm_parse_failed', `JSON.parse failed: ${(e as Error).message}`);
  }
  const parsed = OutlineSchema.safeParse(json);
  if (!parsed.success) {
    throw new LearningIntentError(
      'llm_parse_failed',
      `outline schema invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return parsed.data;
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
    domain: node.domain ?? fallbackDomain,
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
  // Case-insensitive exact match on knowledge.name first; if multiple match the
  // first by created_at wins (user must disambiguate at /knowledge if they
  // really have collisions).
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
 * Locate the topic in the knowledge graph, determine whether the graph needs
 * bootstrapping, ask LLM for a 1-hub + N-atomic outline, then persist as a
 * `propose` event. Returns the proposal ready for user accept.
 *
 * Throws LearningIntentError on:
 *   - llm_parse_failed: LLM output didn't match OutlineSchema
 *   - invalid_atomic_knowledge_id: LLM hallucinated a knowledge_id not in
 *     child_nodes / proposed child nodes
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
    output_contract:
      planCase === '3c_existing_graph'
        ? 'Return hub + atomics. Each atomic.knowledge_id must be one of child_nodes[].id.'
        : 'Return knowledge plus hub + atomics. knowledge.children temp_id values are the only valid atomic.knowledge_id values.',
  };

  const result = await runTaskFn('LearningIntentOutlineTask', input, {
    db,
    subjectProfile: resolveSubjectProfile(node?.domain),
  });
  const outline = parseLearningIntentOutline(result.text);

  let knowledgeNode: LearningIntentProposal['knowledge_node'];
  let proposedKnowledge: ProposedKnowledgeGraph | undefined;

  if (planCase === '3c_existing_graph') {
    if (!node) {
      throw new LearningIntentError('topic_not_found', `knowledge topic vanished: ${topic}`);
    }
    // Validate LLM didn't hallucinate child knowledge_ids
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
        ? normalizeProposedNode(
            knowledgeSpec.root ?? failInvalidOutline('3a outline must include knowledge.root'),
            null,
          )
        : undefined;
    if (planCase === '3a_topic_missing' && !root?.domain) {
      failInvalidOutline('3a knowledge.root.domain is required to create a new root node');
    }
    const rootDomain = root?.domain ?? node?.domain ?? null;
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

export interface AcceptLearningIntentParams {
  db: Db;
  proposalId: string;
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
 * Materializes a proposal: creates 1 hub LearningItem + N atomic LearningItems
 * (parent_learning_item_id linked) + paired hub artifact + N atomic artifact
 * stubs (body_blocks=null, generation_status='pending'), then writes a rate
 * event chained to the proposal. Caller is responsible for enqueueing
 * note_generate jobs after this returns.
 *
 * All DB writes happen in a single transaction.
 */
export async function acceptLearningIntent(
  params: AcceptLearningIntentParams,
): Promise<LearningIntentMaterializeResult> {
  const { db, proposalId } = params;
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

  return db.transaction(async (tx) => {
    const createdKnowledgeIds: string[] = [];
    const tempIdToRealId = new Map<string, string>();
    let rootKnowledgeId = knowledge_node_id;

    if (planCase === '3a_topic_missing') {
      const root = proposedKnowledge?.root;
      if (!root) {
        throw new LearningIntentError('llm_parse_failed', '3a proposal missing proposed root');
      }
      if (!root.domain) {
        throw new LearningIntentError('llm_parse_failed', '3a proposal root missing domain');
      }
      rootKnowledgeId = newId();
      tempIdToRealId.set(root.temp_id, rootKnowledgeId);
      createdKnowledgeIds.push(rootKnowledgeId);

      await tx.insert(knowledge).values({
        id: rootKnowledgeId,
        name: root.name,
        domain: root.domain,
        parent_id: null,
        merged_from: [],
        proposed_by_ai: true,
        approval_status: 'approved',
        created_at: now,
        updated_at: now,
        version: 0,
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
      const fallbackDomain =
        proposedKnowledge?.root?.domain ?? proposal.payload.knowledge_node?.domain ?? null;
      for (const child of children) {
        const childId = newId();
        tempIdToRealId.set(child.temp_id, childId);
        createdKnowledgeIds.push(childId);
        await tx.insert(knowledge).values({
          id: childId,
          name: child.name,
          domain: child.domain ?? fallbackDomain,
          parent_id: rootKnowledgeId,
          merged_from: [],
          proposed_by_ai: true,
          approval_status: 'approved',
          created_at: now,
          updated_at: now,
          version: 0,
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

    await tx.insert(learning_item).values({
      id: hubLiId,
      source: 'learning_intent',
      source_ref: proposalId,
      title: hub.title,
      content: hub.summary_md,
      knowledge_ids: [rootKnowledgeId],
      primary_artifact_id: hubArtifactId,
      parent_learning_item_id: null,
      child_learning_item_ids: [],
      status: 'pending',
      created_at: now,
      updated_at: now,
      version: 0,
    });

    // Atomic LearningItems
    const atomicLiIds: string[] = [];
    const atomicArtifactIds: string[] = [];
    for (const atomic of resolvedAtomics) {
      const atomicLiId = newId();
      const atomicArtifactId = newId();
      atomicLiIds.push(atomicLiId);
      atomicArtifactIds.push(atomicArtifactId);

      await tx.insert(learning_item).values({
        id: atomicLiId,
        source: 'learning_intent',
        source_ref: proposalId,
        title: atomic.title,
        content: atomic.one_line_intent,
        knowledge_ids: [atomic.knowledge_id],
        primary_artifact_id: atomicArtifactId,
        parent_learning_item_id: hubLiId,
        child_learning_item_ids: [],
        status: 'pending',
        created_at: now,
        updated_at: now,
        version: 0,
      });
    }

    // Long LearningItems
    const longLiIds: string[] = [];
    const longArtifactIds: string[] = [];
    for (const long of resolvedLongs) {
      const longLiId = newId();
      const longArtifactId = newId();
      longLiIds.push(longLiId);
      longArtifactIds.push(longArtifactId);

      await tx.insert(learning_item).values({
        id: longLiId,
        source: 'learning_intent',
        source_ref: proposalId,
        title: long.title,
        content: long.one_line_intent,
        knowledge_ids: long.knowledge_ids,
        primary_artifact_id: longArtifactId,
        parent_learning_item_id: hubLiId,
        child_learning_item_ids: [],
        status: 'pending',
        created_at: now,
        updated_at: now,
        version: 0,
      });
    }

    // Hub artifact (synchronous summary; no async generation needed)
    await tx.insert(artifact).values({
      id: hubArtifactId,
      type: 'note_hub',
      title: hub.title,
      parent_artifact_id: null,
      knowledge_ids: [rootKnowledgeId],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      source_ref: proposalId,
      body_blocks: summaryBodyBlocks(`${hubArtifactId}_summary`, hub.summary_md) as never,
      attrs: {
        topic,
        summary_md: hub.summary_md,
        linked_artifact_ids: [...atomicArtifactIds, ...longArtifactIds],
        atomic_artifact_ids: atomicArtifactIds,
        long_artifact_ids: longArtifactIds,
      } as never,
      tool_kind: null,
      tool_state: null,
      generation_status: 'ready', // hub is outline-only; ready immediately
      generated_by: {
        ...aiAgentRef('LearningIntentOutlineTask', {
          text: '',
          ...(proposalTaskRunId ? { task_run_id: proposalTaskRunId } : {}),
        }),
      } as never,
      history: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });

    // Atomic artifact stubs (pending; worker fills sections)
    for (let i = 0; i < resolvedAtomics.length; i++) {
      const atomicNode = resolvedAtomics[i];
      await tx.insert(artifact).values({
        id: atomicArtifactIds[i],
        type: 'note_atomic',
        title: atomicNode.title,
        parent_artifact_id: hubArtifactId,
        knowledge_ids: [atomicNode.knowledge_id],
        intent_source: 'learning_intent',
        source: 'ai_generated',
        source_ref: proposalId,
        body_blocks: null,
        attrs: { one_line_intent: atomicNode.one_line_intent } as never,
        tool_kind: null,
        tool_state: null,
        generation_status: 'pending',
        generated_by: null,
        history: [],
        created_at: now,
        updated_at: now,
        version: 0,
      });
    }

    // Long artifact stubs (pending; worker fills body_blocks with free-form rich notes)
    for (let i = 0; i < resolvedLongs.length; i++) {
      const longNode = resolvedLongs[i];
      await tx.insert(artifact).values({
        id: longArtifactIds[i],
        type: 'note_long',
        title: longNode.title,
        parent_artifact_id: hubArtifactId,
        knowledge_ids: longNode.knowledge_ids,
        intent_source: 'learning_intent',
        source: 'ai_generated',
        source_ref: proposalId,
        body_blocks: null,
        attrs: { one_line_intent: longNode.one_line_intent } as never,
        tool_kind: null,
        tool_state: null,
        generation_status: 'pending',
        generated_by: null,
        history: [],
        created_at: now,
        updated_at: now,
        version: 0,
      });
    }

    // Rate event: marks proposal accepted, chains via caused_by_event_id
    await writeEvent(tx, {
      id: newId(),
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
      created_at: new Date(),
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
