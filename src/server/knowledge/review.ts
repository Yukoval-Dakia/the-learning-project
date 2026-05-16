// Phase 1c.1 Step 4 — KnowledgeReviewTask input rewrite.
//
// PREVIOUSLY: buildReviewInput read mistake table (latest 100). NOW: reads
// failure attempts via getFailureAttempts (single-owner read API per ADR-0005)
// and projects each FailureAttempt to mistake-shape so the prompt stays stable.
//
// Step 7 will rewrite the AI prompt to natively speak event-stream language;
// Step 4 only switches the data source.

import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';
import type { LanguageModel, ToolSet } from 'ai';
import { streamText } from 'ai';
import { z } from 'zod';
import { getFailureAttempts } from '../events/queries';
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

  // Inline streamText (no task registry dependency in Next.js port)
  const tools: ToolSet = {
    write_proposal: {
      description:
        'Propose one knowledge tree mutation. Call once per mutation. payload.mutation distinguishes the kind (propose_new / reparent / merge / split / archive). reasoning must be concrete.',
      inputSchema: z.object({
        payload: z.unknown(),
        reasoning: z.string(),
      }),
      execute: async ({
        payload,
        reasoning,
      }: {
        payload: KnowledgeMutationPayload;
        reasoning: string;
      }) => {
        const id = await writeDreamingProposal(ctx.db, { payload, reasoning });
        return { proposal_id: id };
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
