import { tasks } from '@/ai/registry';
import { db } from '@/db/client';
import { runTask } from '@/server/ai/runner';
import { errorResponse } from '@/server/http/errors';
import { getR2 } from '@/server/r2';

export const runtime = 'nodejs';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ task: string }> },
): Promise<Response> {
  try {
    const { task } = await params;
    const def = (tasks as Record<string, { needsToolCall: boolean }>)[task];
    if (!def) return Response.json({ error: 'unknown_task', task }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as { input?: unknown };

    if (def.needsToolCall) {
      return Response.json(
        {
          error: 'tool_task_requires_domain_route',
          task,
          message:
            'Tool-calling tasks require a domain route that injects the correct MCP server and allowed tools.',
          domain_route: task === 'KnowledgeReviewTask' ? '/api/knowledge/review' : null,
        },
        { status: 400 },
      );
    }
    const result = await runTask(task, body.input ?? {}, { db, r2: getR2() });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
