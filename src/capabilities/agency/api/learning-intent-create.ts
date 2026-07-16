// YUK-604 — learner-declared "我想学 X" command.
//
// M5 removed the old Next route together with the retired /learning-items page,
// leaving planLearningIntent with no live caller. This capability-owned handler
// restores proposal creation only. The owner reviews and accepts the resulting
// learning_item proposal through the canonical proposal inbox decision route.

import { db } from '@/db/client';
import type { Db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import type { RunTaskFn } from '@/server/orchestrator/learning_intent';
import { LearningIntentError, planLearningIntent } from '@/server/orchestrator/learning_intent';
import { listProposalInboxRows } from '@/server/proposals/inbox';
import { CreateLearningIntentBodySchema, LearningIntentProposalResponseSchema } from './contracts';

export interface CreateLearningIntentHandlerDeps {
  database?: Db;
  runTaskFn?: RunTaskFn;
}

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<Awaited<ReturnType<RunTaskFn>>> {
  const { runTask } = await import('@/server/ai/runner');
  return runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
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
        // UI disables repeat submits, but the API also reuses an already-pending
        // proposal for the same topic. This avoids another paid outline run after
        // a reload or request retry. A malformed legacy proposal is ignored and a
        // fresh one is produced rather than returning an invalid public contract.
        const pending = await listProposalInboxRows(database, {
          status: 'pending',
          kind: 'learning_item',
        });
        const cooldownKey = `learning_item:intent:${parsed.data.topic}`;
        const existing = pending.find((row) => row.payload.cooldown_key === cooldownKey);
        if (existing) {
          const restored = LearningIntentProposalResponseSchema.safeParse({
            proposal_id: existing.id,
            ...existing.payload.proposed_change,
          });
          if (restored.success) return Response.json(restored.data);
        }

        const proposal = await planLearningIntent({
          db: database,
          topic: parsed.data.topic,
          runTaskFn: deps.runTaskFn ?? defaultRunTaskFn,
        });
        return Response.json(proposal);
      } catch (err) {
        if (err instanceof LearningIntentError) {
          const status =
            err.code === 'topic_not_found' || err.code === 'topic_no_children' ? 422 : 500;
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
