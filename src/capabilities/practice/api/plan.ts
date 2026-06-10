// Phase 2A — Review Orchestrator HTTP surface.
//
// Replaces the role of `/api/review/due` for callers that want priority +
// rationale + session_intent. `/api/review/due` itself stays alive as a
// thinner shim for any back-compat consumers (it returns the same queue but
// drops the orchestrator's structured planning fields).
//
// LLM session_intent is best-effort: if XIAOMI_API_KEY (or the configured
// provider env) is missing OR the call throws, the queue still returns with
// session_intent=null and the route stays 200.

import { planReviewSession } from '@/capabilities/practice/server/review-session';
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
}

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const limitRaw = url.searchParams.get('limit');
    const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
    const limit = Number.isNaN(limitParsed) ? 20 : limitParsed;

    // Skip LLM intent when explicitly requested (?intent=skip), useful for
    // cheap polls / vitest happy-paths. Default = try LLM.
    const skipIntent = url.searchParams.get('intent') === 'skip';
    const plan = await planReviewSession({
      db,
      limit,
      runTaskFn: skipIntent ? undefined : defaultRunTaskFn,
    });

    return Response.json(plan);
  } catch (err) {
    return errorResponse(err);
  }
}
