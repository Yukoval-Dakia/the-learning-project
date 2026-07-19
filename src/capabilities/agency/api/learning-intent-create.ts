// YUK-604 — learner-declared "我想学 X" command.
//
// M5 removed the old Next route together with the retired /learning-items page,
// leaving planLearningIntent with no live caller. This capability-owned handler
// restores proposal creation only. The owner reviews and accepts the resulting
// learning_item proposal through the canonical proposal inbox decision route.

import { db } from '@/db/client';
import type { Db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { checkRateLimit } from '@/server/http/rate-limit';
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
        // a reload or request retry. Scan ALL same-topic pending rows and restore
        // the first that still satisfies the public contract; a malformed legacy
        // row is skipped individually (not the whole dedup) so one bad row can't
        // force a fresh paid run when a valid same-topic proposal already exists.
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

        // YUK-691 — only charge the global AI-funnel budget when this request is
        // actually about to dispatch a paid outline run. Same-topic replays above
        // remain free and do not consume the limiter.
        checkRateLimit();
        const proposal = await planLearningIntent({
          db: database,
          topic: parsed.data.topic,
          runTaskFn: deps.runTaskFn ?? defaultRunTaskFn,
        });
        return Response.json(proposal);
      } catch (err) {
        if (err instanceof LearningIntentError) {
          // topic_not_found = requested topic isn't in the tree (client-correctable → 422).
          // llm_parse_failed / invalid_atomic_knowledge_id are upstream AI-quality faults,
          // not server bugs → 502 so monitoring doesn't page on model hiccups. Anything
          // else (e.g. proposal_not_found, never thrown on the create path) → 500.
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
