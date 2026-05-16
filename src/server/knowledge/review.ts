// Phase 1c.1 Step 7 — KnowledgeReviewTask write_proposal tool dispatch.
//
// Step 4 switched the input data source to the event stream. Step 7 extends the
// `write_proposal` tool to dispatch on mutation kind:
//
//   - Tree-shape mutations (propose_new / reparent / merge / split / archive) →
//     unchanged — writeDreamingProposal as before.
//   - Mesh-shape mutation (propose_knowledge_edge per ADR-0010/0011) → writes a
//     ProposeKnowledgeEdge event via writeEvent (Step 4 single-owner write path).
//
// Discrimination: payload.mutation === 'propose_knowledge_edge' is the
// discriminator; absent that, fall through to tree-mutation legacy path.

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';
import type { LanguageModel, ToolSet } from 'ai';
import { streamText } from 'ai';
import { z } from 'zod';
import { getFailureAttempts, writeEvent } from '../events/queries';
import { type KnowledgeMutationPayload, writeDreamingProposal } from './proposals';

const RECENT_MISTAKES_LIMIT = 100;

/**
 * Builds the input payload (tree + recent mistakes) for KnowledgeReviewTask.
 * recent_mistakes is now projected from the event stream (attempt + chained
 * judge) but keeps the same shape the prompt expects:
 *   { id, question_id, knowledge_ids, cause }
 * `id` is the attempt event id, `knowledge_ids` is the attempt payload's
 * referenced_knowledge_ids, `cause` is the chained judge's cause (or null when
 * attribution hasn't run yet).
 */
async function buildReviewInput(db: Db) {
  const tree = await db
    .select({
      id: knowledge.id,
      name: knowledge.name,
      domain: knowledge.domain,
      parent_id: knowledge.parent_id,
      archived_at: knowledge.archived_at,
      version: knowledge.version,
      merged_from: knowledge.merged_from,
    })
    .from(knowledge)
    .orderBy(knowledge.created_at);

  const attempts = await getFailureAttempts(db, { limit: RECENT_MISTAKES_LIMIT });
  const recent_mistakes = attempts.map((fa) => ({
    id: fa.attempt_event_id,
    question_id: fa.question_id,
    knowledge_ids: fa.referenced_knowledge_ids,
    cause: fa.judge?.cause ?? null,
  }));

  return {
    tree,
    recent_mistakes,
  };
}

export interface StreamReviewTaskCtx {
  db: Db;
  model?: LanguageModel;
}

/**
 * Stream KnowledgeReviewTask with a single tool — write_proposal — that the LLM
 * calls once per mutation it wants to propose. Each call writes a dreaming_proposal
 * row with kind='knowledge' and status='pending'. Returns the streamText Response
 * (caller pipes to client).
 */
export async function streamReviewTask(ctx: StreamReviewTaskCtx): Promise<Response> {
  const input = await buildReviewInput(ctx.db);

  // Inline streamText (no task registry dependency in Next.js port).
  //
  // The `write_proposal` tool dispatches by payload.mutation:
  //   - 'propose_knowledge_edge' → writeEvent (Lane B ProposeKnowledgeEdge).
  //   - anything else → writeDreamingProposal (existing tree-mutation path).
  // Codex P1-C — the prompt instructs the LLM to call
  // `write_proposal({mutation, payload, reasoning})` with `mutation` at the top
  // level. The previous inputSchema only declared `payload + reasoning`, so a
  // top-level `mutation` was silently dropped — propose_knowledge_edge fell
  // back to writeDreamingProposal. Accept `mutation` optionally for compat
  // with the prompt + retain isKnowledgeEdgeMutation(payload) for the legacy
  // case where the LLM puts the discriminator inside the payload.
  const tools: ToolSet = {
    write_proposal: {
      description:
        'Propose one knowledge graph mutation. Call once per mutation. mutation discriminates: tree-shape (propose_new / reparent / merge / split / archive) writes to dreaming_proposal; mesh-shape (propose_knowledge_edge) writes a ProposeKnowledgeEdge event with payload={from_knowledge_id, to_knowledge_id, relation_type}. reasoning must be concrete.',
      inputSchema: z.object({
        mutation: z.string().optional(),
        payload: z.unknown(),
        reasoning: z.string(),
      }),
      execute: async ({
        mutation,
        payload,
        reasoning,
      }: {
        mutation?: string;
        payload: unknown;
        reasoning: string;
      }) => {
        const isEdgeProposal =
          mutation === 'propose_knowledge_edge' || isKnowledgeEdgeMutation(payload);
        if (isEdgeProposal) {
          // Edge fields may arrive on `payload` (top-level mutation case) OR
          // baked into payload alongside the legacy `payload.mutation` field.
          const edgePayload = extractEdgePayload(payload);
          if (!edgePayload) {
            // Malformed edge proposal — fall through to dreaming path so we
            // don't silently swallow it; writeDreamingProposal will surface
            // a clearer error.
            const id = await writeDreamingProposal(ctx.db, {
              payload: payload as KnowledgeMutationPayload,
              reasoning,
            });
            return { proposal_id: id, kind: 'tree_mutation' };
          }
          const eventId = newId();
          await writeEvent(ctx.db, {
            id: eventId,
            // subject_id is the synthetic id of the proposed edge — the edge row
            // doesn't exist yet (it's a *proposal*); a future user rate=accept
            // would promote it. Per Lane B ProposeKnowledgeEdge.subject_kind =
            // 'knowledge_edge'.
            subject_id: newId(),
            actor_kind: 'agent',
            actor_ref: 'dreaming',
            action: 'propose',
            subject_kind: 'knowledge_edge',
            outcome: 'success',
            payload: {
              from_knowledge_id: edgePayload.from_knowledge_id,
              to_knowledge_id: edgePayload.to_knowledge_id,
              relation_type: edgePayload.relation_type,
              reasoning,
            },
            created_at: new Date(),
          });
          return { event_id: eventId, kind: 'knowledge_edge_propose' };
        }
        const id = await writeDreamingProposal(ctx.db, {
          payload: payload as KnowledgeMutationPayload,
          reasoning,
        });
        return { proposal_id: id, kind: 'tree_mutation' };
      },
    },
  };

  if (!ctx.model) {
    throw new Error('streamReviewTask: model is required (no default in Next.js port)');
  }

  const result = streamText({
    model: ctx.model,
    prompt: JSON.stringify(input),
    tools,
  });

  return result.toTextStreamResponse();
}

// ---------- mutation discriminator ----------
//
// LLM emits one of two payload shapes via the `write_proposal` tool. Tree-shape
// payloads (propose_new / reparent / merge / split / archive) keep the legacy
// dreaming_proposal path. Mesh-shape (propose_knowledge_edge) takes the new
// event-write path. Discriminate explicitly so malformed/ambiguous payloads
// default to the tree path (current behaviour — no silent edge writes).

interface KnowledgeEdgeMutationShape {
  mutation: 'propose_knowledge_edge';
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: string;
}

function isKnowledgeEdgeMutation(payload: unknown): payload is KnowledgeEdgeMutationShape {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    p.mutation === 'propose_knowledge_edge' &&
    typeof p.from_knowledge_id === 'string' &&
    typeof p.to_knowledge_id === 'string' &&
    typeof p.relation_type === 'string'
  );
}

/**
 * Extracts edge fields from either shape:
 *   1) top-level mutation case: payload = { from_knowledge_id, to_knowledge_id, relation_type }
 *   2) legacy case: payload = { mutation: 'propose_knowledge_edge', from_knowledge_id, ... }
 */
function extractEdgePayload(
  payload: unknown,
): { from_knowledge_id: string; to_knowledge_id: string; relation_type: string } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.from_knowledge_id === 'string' &&
    typeof p.to_knowledge_id === 'string' &&
    typeof p.relation_type === 'string'
  ) {
    return {
      from_knowledge_id: p.from_knowledge_id,
      to_knowledge_id: p.to_knowledge_id,
      relation_type: p.relation_type,
    };
  }
  return null;
}
