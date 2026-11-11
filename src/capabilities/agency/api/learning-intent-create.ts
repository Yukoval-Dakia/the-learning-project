// Learner-declared "我想学 X" command: creates a learning_item proposal that the owner
// reviews and accepts through the canonical proposal inbox decision route.

import type { Db } from '@/db/client';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { makeRunTaskFn } from '../server/ai-runtime';
import { LearningIntentError, type RunTaskFn } from '../server/learning-intent';
import { runLearningIntentRequest } from '../server/learning-intent-request';
import { CreateLearningIntentBodySchema } from './contracts';

export interface CreateLearningIntentHandlerDeps {
  database?: Db;
  runTaskFn?: RunTaskFn;
}

/** Own the complete learning-intent request: validation, then one in-flight dispatch. */
export async function requestLearningIntent(
  database: Db,
  loadBody: () => Promise<unknown>,
  runTaskFn?: RunTaskFn,
) {
  let raw: unknown;
  try {
    raw = await loadBody();
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

  return runLearningIntentRequest(
    database,
    parsed.data.topic,
    runTaskFn ?? makeRunTaskFn(database),
  );
}

export function learningIntentErrorResponse(err: unknown): Response {
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
  return errorResponse(err);
}

export function buildCreateLearningIntentHandler(deps: CreateLearningIntentHandlerDeps = {}) {
  return async function createLearningIntent(req: Request): Promise<Response> {
    try {
      return Response.json(
        await requestLearningIntent(deps.database ?? db, () => req.json(), deps.runTaskFn),
      );
    } catch (err) {
      return learningIntentErrorResponse(err);
    }
  };
}

export const POST = buildCreateLearningIntentHandler();
