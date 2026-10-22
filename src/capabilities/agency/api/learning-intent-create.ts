// Learner-declared "我想学 X" command: creates a learning_item proposal that the owner
// reviews and accepts through the canonical proposal inbox decision route.

import type { Db } from '@/db/client';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { listProposalInboxRows } from '@/kernel/proposals/inbox';
import { checkRateLimit } from '@/server/http/rate-limit';
import { makeRunTaskFn } from '../server/ai-runtime';
import { LearningIntentError, type RunTaskFn, planLearningIntent } from '../server/learning-intent';
import { CreateLearningIntentBodySchema, LearningIntentProposalResponseSchema } from './contracts';

export interface CreateLearningIntentHandlerDeps {
  database?: Db;
  runTaskFn?: RunTaskFn;
}

export function buildCreateLearningIntentHandler(deps: CreateLearningIntentHandlerDeps = {}) {
  return async function createLearningIntent(req: Request): Promise<Response> {
    try {
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        throw new ApiError('validation_error', 'request body must be valid JSON', 400);
      }
      const parsed = CreateLearningIntentBodySchema.safeParse(raw);
      if (!parsed.success) {
        throw new ApiError(
          'validation_error',
          parsed.error.issues.map((issue) => issue.message).join('; '),
          400,
        );
      }

      try {
        const database = deps.database ?? db;
        // UI disables repeat submits, but the API also reuses an already-pending proposal
        // for the same topic to avoid another paid outline run after a reload or retry.
        // A malformed legacy row is skipped individually so one bad row cannot force a
        // fresh paid run when a valid same-topic proposal exists.
        const pending = await listProposalInboxRows(database, {
          status: 'pending',
          kind: 'learning_item',
        });
        const cooldownKey = `learning_item:intent:${parsed.data.topic}`;
        for (const candidate of pending) {
          if (candidate.payload.cooldown_key !== cooldownKey) continue;
          const restored = LearningIntentProposalResponseSchema.safeParse({
            proposal_id: candidate.id,
            ...candidate.payload.proposed_change,
          });
          if (restored.success) return Response.json(restored.data);
        }

        // Charge the global AI-funnel budget only when this request is actually about to
        // dispatch a paid outline run; same-topic replays above stay free.
        checkRateLimit();
        const proposal = await planLearningIntent({
          db: database,
          topic: parsed.data.topic,
          runTaskFn: deps.runTaskFn ?? makeRunTaskFn(database),
        });
        return Response.json(proposal);
      } catch (err) {
        if (err instanceof LearningIntentError) {
          // topic_not_found = topic isn't in the tree (client-correctable → 422).
          // llm_parse_failed / invalid_atomic_knowledge_id are upstream AI-quality faults,
          // not server bugs → 502 so monitoring doesn't page on model hiccups.
          const status =
            err.code === 'topic_not_found'
              ? 422
              : err.code === 'llm_parse_failed' || err.code === 'invalid_atomic_knowledge_id'
                ? 502
                : 500;
          return Response.json({ error: err.code, message: err.message }, { status });
        }
        throw err;
      }
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export const POST = buildCreateLearningIntentHandler();
