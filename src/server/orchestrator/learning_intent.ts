// Phase 2B — Learning Intent Orchestrator.
//
// User declares "我想学 X" → orchestrator reads the knowledge graph for X,
// asks LLM to propose a 1-hub + N-atomic split, persists the proposal as a
// `propose` event, awaits user accept, then materializes the LearningItem
// hierarchy + paired artifact stubs + enqueues N async NoteGenerateTask jobs.
//
// MVP scope per docs/superpowers/brainstorms/2026-05-17-phase2b-learning-intent.md.
// Hard scope fences:
//   - Only case 3c (topic node + child nodes already exist) is supported.
//     case 3a (node doesn't exist) / 3b (children missing) → reject with 422
//     and instruct user to seed the graph at /knowledge first.
//   - Notes default source_tier='llm_only'; no NoteVerifyTask; no Search-grounded.
//   - Embedded check is a placeholder (empty question_ids).
//   - Hub status auto-aggregation, living-note triggers, ai_propose completion
//     all explicitly out of scope.

import { newId } from '@/core/ids';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '@/db/client';
import { artifact, knowledge, learning_item } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';

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

export interface LearningIntentProposal {
  /** Event id of the propose event — used as accept handle. */
  proposal_id: string;
  topic: string;
  knowledge_node: { id: string; name: string; domain: string | null };
  hub: HubProposal;
  atomics: AtomicProposal[];
}

export interface LearningIntentMaterializeResult {
  hub_learning_item_id: string;
  atomic_learning_item_ids: string[];
  hub_artifact_id: string;
  atomic_artifact_ids: string[];
  enqueued_note_generate_jobs: number;
}

export type RunTaskFn = (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;

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

const OutlineSchema = z.object({
  hub: z.object({
    title: z.string().min(1).max(80),
    summary_md: z.string().min(1).max(500),
  }),
  atomics: z
    .array(
      z.object({
        knowledge_id: z.string().min(1),
        title: z.string().min(1).max(80),
        one_line_intent: z.string().min(1).max(200),
      }),
    )
    .min(1),
});

function parseOutlineOutput(text: string): z.infer<typeof OutlineSchema> {
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
 * Locate the topic in the knowledge graph; load child nodes; ask LLM for a
 * 1-hub + N-atomic outline; persist as a `propose` event. Returns the
 * proposal ready for user accept.
 *
 * Throws LearningIntentError on:
 *   - topic_not_found: no knowledge node matches the topic string
 *   - topic_no_children: topic node has no child nodes (MVP requires existing
 *     mesh structure; user must add children at /knowledge first)
 *   - llm_parse_failed: LLM output didn't match OutlineSchema
 *   - invalid_atomic_knowledge_id: LLM hallucinated a knowledge_id not in
 *     child_nodes
 */
export async function planLearningIntent(
  params: PlanLearningIntentParams,
): Promise<LearningIntentProposal> {
  const { db, topic, runTaskFn } = params;

  const node = await findTopicNode(db, topic);
  if (!node) {
    throw new LearningIntentError(
      'topic_not_found',
      `没有找到匹配「${topic}」的知识点。先去 /knowledge 创建这个节点 + 子节点再回来。`,
    );
  }

  const children = await loadChildren(db, node.id);
  if (children.length === 0) {
    throw new LearningIntentError(
      'topic_no_children',
      `知识点「${node.name}」没有子节点。Phase 2B MVP 需要预先在 /knowledge 把子节点结构搭好；先去那里加几个子节点再回来。`,
    );
  }

  const input = {
    topic,
    knowledge_node: { id: node.id, name: node.name, domain: node.domain },
    child_nodes: children.map((c) => ({ id: c.id, name: c.name })),
    existing_descendants_count: children.length,
  };

  const result = await runTaskFn('LearningIntentOutlineTask', input, { db });
  const outline = parseOutlineOutput(result.text);

  // Validate LLM didn't hallucinate child knowledge_ids
  const childIds = new Set(children.map((c) => c.id));
  for (const atomic of outline.atomics) {
    if (!childIds.has(atomic.knowledge_id)) {
      throw new LearningIntentError(
        'invalid_atomic_knowledge_id',
        `LLM proposed knowledge_id=${atomic.knowledge_id} which is not in the topic's child nodes`,
      );
    }
  }

  // Persist as propose event. We use action='propose', subject_kind='artifact'
  // because the proposal's ultimate output is an artifact hierarchy
  // (note_hub + note_atomic); knowledge structure isn't being mutated.
  // experimental: namespace because Lane B ProposeArtifact isn't defined yet.
  const proposalId = newId();
  await writeEvent(db, {
    id: proposalId,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:propose_learning_intent',
    subject_kind: 'artifact',
    subject_id: newId(), // synthetic — hub artifact id assigned at accept
    outcome: 'partial',
    payload: {
      topic,
      knowledge_node_id: node.id,
      hub: outline.hub,
      atomics: outline.atomics,
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(),
  });

  return {
    proposal_id: proposalId,
    topic,
    knowledge_node: { id: node.id, name: node.name, domain: node.domain },
    hub: outline.hub,
    atomics: outline.atomics,
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
    knowledge_node_id: string;
    hub: HubProposal;
    atomics: AtomicProposal[];
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
 * stubs (sections=null, generation_status='pending'), then writes a rate
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

  const { hub, atomics, topic, knowledge_node_id } = proposal.payload;
  const now = new Date();

  return db.transaction(async (tx) => {
    // Hub LearningItem
    const hubLiId = newId();
    const hubArtifactId = newId();

    await tx.insert(learning_item).values({
      id: hubLiId,
      source: 'learning_intent',
      source_ref: proposalId,
      title: hub.title,
      content: hub.summary_md,
      knowledge_ids: [knowledge_node_id],
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
    for (const atomic of atomics) {
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

    // Hub artifact (synchronous summary; no async generation needed)
    await tx.insert(artifact).values({
      id: hubArtifactId,
      type: 'note_hub',
      title: hub.title,
      knowledge_id: knowledge_node_id,
      parent_artifact_id: null,
      child_artifact_ids: atomicArtifactIds,
      intent_source: 'learning_intent',
      source: 'ai_generated',
      source_ref: proposalId,
      outline_json: { topic, summary_md: hub.summary_md } as never,
      sections: null,
      tool_kind: null,
      tool_state: null,
      generation_status: 'ready', // hub is outline-only; ready immediately
      generated_by: {
        by: 'ai',
        task_kind: 'LearningIntentOutlineTask',
      } as never,
      history: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });

    // Atomic artifact stubs (pending; worker fills sections)
    for (let i = 0; i < atomics.length; i++) {
      const atomicNode = atomics[i];
      await tx.insert(artifact).values({
        id: atomicArtifactIds[i],
        type: 'note_atomic',
        title: atomicNode.title,
        knowledge_id: atomicNode.knowledge_id,
        parent_artifact_id: hubArtifactId,
        child_artifact_ids: [],
        intent_source: 'learning_intent',
        source: 'ai_generated',
        source_ref: proposalId,
        outline_json: { one_line_intent: atomicNode.one_line_intent } as never,
        sections: null,
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
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(),
    });

    return {
      hub_learning_item_id: hubLiId,
      atomic_learning_item_ids: atomicLiIds,
      hub_artifact_id: hubArtifactId,
      atomic_artifact_ids: atomicArtifactIds,
      enqueued_note_generate_jobs: 0, // caller enqueues
    };
  });
}

// suppress unused-import lint
void inArray;
