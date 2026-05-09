import { z } from 'zod';
import type { LanguageModel } from 'ai';
import type { D1Database } from '@cloudflare/workers-types';
import { streamTask } from '../ai/runner';
import {
  writeDreamingProposal,
  type KnowledgeMutationPayload,
} from './proposals';
import type { Bindings } from '../types';

interface KnowledgeNode {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  archived_at: number | null;
  version: number;
  merged_from: string;
}

interface MistakeRow {
  id: string;
  question_id: string;
  knowledge_ids: string;
  cause: string | null;
}

const RECENT_MISTAKES_LIMIT = 100;

/**
 * Builds the input payload (tree + recent mistakes) for KnowledgeReviewTask.
 * Pre-fetches both so the LLM has full context as input rather than via tool calls.
 */
async function buildReviewInput(db: D1Database) {
  const tree = await db
    .prepare(
      `select id, name, domain, parent_id, archived_at, version, merged_from from knowledge order by created_at`,
    )
    .bind()
    .all<KnowledgeNode>();
  const mistakes = await db
    .prepare(
      `select id, question_id, knowledge_ids, cause from mistake order by created_at desc limit ?`,
    )
    .bind(RECENT_MISTAKES_LIMIT)
    .all<MistakeRow>();
  return {
    tree: tree.results,
    recent_mistakes: mistakes.results,
  };
}

/**
 * Stream KnowledgeReviewTask with a single tool — write_proposal — that the LLM
 * calls once per mutation it wants to propose. Each call writes a dreaming_proposal
 * row with kind='knowledge' and status='pending'. Returns the streamText Response
 * (caller pipes to client).
 */
export async function streamReviewTask(ctx: {
  env: Bindings;
  model?: LanguageModel;
}): Promise<Response> {
  const input = await buildReviewInput(ctx.env.DB);
  return streamTask(
    'KnowledgeReviewTask',
    input,
    {
      env: ctx.env,
      model: ctx.model,
      tools: {
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
            const id = await writeDreamingProposal(ctx.env.DB, { payload, reasoning });
            return { proposal_id: id };
          },
        },
      },
    },
  );
}
