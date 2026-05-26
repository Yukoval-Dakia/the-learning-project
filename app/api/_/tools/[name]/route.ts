// YUK-80 / Foundation D M1 Lane B
//
// Debug endpoint that exercises one DomainTool end-to-end without going
// through the Claude Agent SDK. Used by curl smoke + the route test
// fixture; gives Lane C+D a known-good call site to build the in-process
// MCP bridge on top of.
//
// Lives under `app/api/_/*` so it stays internal (the `_` prefix marker
// excludes the route from prod build per status.md tech-debt note) and
// behind the `x-internal-token` middleware gate.

import { db } from '@/db/client';
import { writeToolCallLog } from '@/server/ai/log';
import { registerCoreTools } from '@/server/ai/tools/bootstrap';
import { getTool } from '@/server/ai/tools/registry';
import { errorResponse } from '@/server/http/errors';
import { createId } from '@paralleldrive/cuid2';

type RouteParams = { name: string };
type DebugToolBody = {
  input?: unknown;
  taskRunId?: string;
  callerActor?: { kind?: string; ref?: string };
};

export async function POST(req: Request, { params }: { params: Promise<RouteParams> }) {
  try {
    const { name } = await params;
    registerCoreTools();
    const tool = getTool(name);
    if (!tool) {
      return Response.json(
        { error: 'tool_not_found', message: `No DomainTool registered as '${name}'.` },
        { status: 404 },
      );
    }

    let body: DebugToolBody = {};
    const rawBody = await req.text();
    if (rawBody.trim().length > 0) {
      try {
        const parsed = JSON.parse(rawBody);
        body =
          parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as DebugToolBody)
            : {};
      } catch (err) {
        return Response.json(
          {
            error: 'invalid_json',
            message: err instanceof Error ? err.message : 'Malformed JSON request body',
          },
          { status: 400 },
        );
      }
    }

    const parsedInput = tool.inputSchema.safeParse(body.input ?? {});
    if (!parsedInput.success) {
      return Response.json(
        {
          error: 'invalid_input',
          message: 'Input failed Zod schema',
          issues: parsedInput.error.issues,
        },
        { status: 400 },
      );
    }

    const taskRunId = body.taskRunId ?? createId();
    const callerKind = body.callerActor?.kind === 'agent' ? 'agent' : 'user';
    const callerRef = body.callerActor?.ref ?? 'debug:_/tools';

    const startedAt = Date.now();
    let output: unknown = null;
    let errorReason: string | undefined;
    try {
      output = await tool.execute(
        {
          db,
          taskRunId,
          callerActor: { kind: callerKind, ref: callerRef },
        },
        parsedInput.data,
      );
    } catch (err) {
      errorReason = err instanceof Error ? err.message : String(err);
    }
    const latencyMs = Date.now() - startedAt;

    const summary =
      errorReason !== undefined
        ? `error: ${errorReason}`
        : tool.summarize(parsedInput.data, output as never);

    await writeToolCallLog(db, {
      task_run_id: taskRunId,
      task_kind: 'DebugToolEndpoint',
      tool_name: tool.name,
      effect: tool.effect,
      input_json: parsedInput.data,
      output_json: errorReason ? { error: errorReason } : (output as object | null),
      error_reason: errorReason,
      iteration: 0,
      latency_ms: latencyMs,
      cost: 0,
    });

    if (errorReason !== undefined) {
      return Response.json(
        { error: 'tool_execute_failed', message: errorReason, summary, task_run_id: taskRunId },
        { status: 500 },
      );
    }

    return Response.json({
      tool_name: tool.name,
      effect: tool.effect,
      task_run_id: taskRunId,
      latency_ms: latencyMs,
      summary,
      output,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
