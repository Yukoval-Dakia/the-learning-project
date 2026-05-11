import type { Db } from '@/db/client';
import { knowledge, mistake } from '@/db/schema';
import type { LanguageModel, ToolSet } from 'ai';
import { streamText } from 'ai';
import { desc, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { type KnowledgeMutationPayload, writeDreamingProposal } from './proposals';

const RECENT_MISTAKES_LIMIT = 100;

/**
 * Builds the input payload (tree + recent mistakes) for KnowledgeReviewTask.
 * Pre-fetches both so the LLM has full context as input rather than via tool calls.
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
  const mistakes = await db
    .select({
      id: mistake.id,
      question_id: mistake.question_id,
      knowledge_ids: mistake.knowledge_ids,
      cause: mistake.cause,
    })
    .from(mistake)
    .orderBy(desc(mistake.created_at))
    .limit(RECENT_MISTAKES_LIMIT);
  return {
    tree,
    recent_mistakes: mistakes,
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
