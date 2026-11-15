// Learner-declared "我想学 X" command: creates a learning_item proposal that the owner
// reviews and accepts through the canonical proposal inbox decision route.

import type { Db } from '@/db/client';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { makeRunTaskFn } from '../server/ai-runtime';
import { runGoalIntentRequest } from '../server/goal-intent-request';
import { parseGoalIntent } from '../server/goal-intent-parse';
import {
  LearningIntentError,
  type RunTaskFn,
  findTopicNodeForIntent,
} from '../server/learning-intent';
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

  const topic = parsed.data.topic;
  const runner = runTaskFn ?? makeRunTaskFn(database);

  // Deterministic lane: the learner's words decide whether this is a North-Star
  // goal (goal_scope proposal via the canonical runGoalScopeAndWrite owner) or
  // an atomic learning-item plan (the existing learning_item outline path).
  // A bare topic that resolves to a live knowledge node stays on the atomic
  // lane so the learning_item feature keeps working; words that do not match a
  // node — 「我想把三角函数学好」 — are goal semantics.
  const atomicNode = await findTopicNodeForIntent(database, topic);
  if (atomicNode === null) {
    const intent = await parseGoalIntent(database, topic);
    if (intent) {
      // A goal frame was recognized but no subject could be resolved. Do NOT
      // silently pick a domain — surface an honest clarify and never claim a
      // paid send, so the learner re-specifies the subject rather than getting
      // a goal proposed over a guessed subtree.
      if (intent.subjectId === null) {
        throw new ApiError(
          'clarify_goal_subject',
          '想学的这个目标还没对应到具体科目，先说说想学哪一门？',
          422,
        );
      }
      const proposal = await runGoalIntentRequest(
        database,
        topic,
        intent.title,
        intent.subjectId,
        runner,
      );
      return {
        kind: 'goal_scope' as const,
        proposal_id: proposal.proposal_id,
        goal_id: proposal.goal_id,
        scope_count: proposal.scope_count,
      };
    }
    // Unparseable words that also name no node: fall through to the atomic
    // planner, which reports topic_not_found rather than manufacturing a goal.
  }

  const atomic = await runLearningIntentRequest(database, topic, runner);
  return { kind: 'learning_item' as const, ...atomic };
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
