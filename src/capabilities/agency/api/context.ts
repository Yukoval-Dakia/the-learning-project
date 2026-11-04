import { and, eq } from 'drizzle-orm';
import { piDomainMount } from '@/ai/pi-tool-mount';
import { classifyCrisisExpression } from '@/core/crisis/classify';
import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { errorResponse } from '@/kernel/http';
import { DOMAIN_TOOL_MCP_SERVER_NAME } from '@/kernel/tools/allowlists';
import { piToolWireName } from '@/ai/pi-tool-mount';
import { runAgentTask } from '@/server/ai/runner';
import { changeTopics, CONTEXT_CHANGE, readTopics, topicBoard } from '../context/topics';
import { ContextActionRequest, ContextEditRequest, ContextEditResponse } from '../context/wire';

export async function GET() {
  try {
    const board = await topicBoard(db);
    return Response.json({ ...board, changes: board.changes.map(c => {
      const p = c.payload as { before: { topics: unknown[] }; after: { topics: unknown[] } };
      return { id: c.id, at: c.at.toISOString(), before: p.before.topics, after: p.after.topics };
    }) });
  } catch (err) { return errorResponse(err); }
}
export async function ACTION(req: Request) {
  try {
    const input = ContextActionRequest.parse(await req.json());
    if (input.op === 'undo' && !input.change_id || input.op === 'withdraw_topic' && !input.topic_key)
      throw new Error('action target missing');
    return Response.json(await changeTopics(db, { expectedVersion: input.expected_version, actor: 'learner',
      taskRunId: newId(), sourceIds: [],
      ...(input.op === 'undo' ? { undoId: input.change_id } : { withdrawKey: input.topic_key }) }));
  } catch (err) { return errorResponse(err); }
}
export async function EDIT(req: Request) {
  try {
    const input = ContextEditRequest.parse(await req.json());
    if (input.derivation_policy !== 'allow' || classifyCrisisExpression(input.instruction) !== 'none')
      return Response.json({ reply: '这句话不会存入长期记忆。', changes: [] });
    const current = await readTopics(db);
    if (input.expected_version !== current.version) return Response.json({ error: 'context_version_conflict' }, { status: 409 });
    const id = newId();
    await writeEvent(db, { id, action: 'experimental:context_edit_request', actor_kind: 'user', actor_ref: 'self',
      subject_kind: 'query', subject_id: id, payload: input, affected_scopes: [], ingest_at: new Date() });
    const result = await runAgentTask('DreamingTask', { ...current, instruction: input.instruction,
      topic_key: input.topic_key, mode: 'learner_correction',
      contract: '立即执行学习者修改，写 correction；不要只回复建议。修改后停止，回复改了什么。' }, {
      db, taskRunId: id, allowedTools: [piToolWireName(DOMAIN_TOOL_MCP_SERVER_NAME, 'curate_context')],
      piToolMounts: [piDomainMount({ serverName: DOMAIN_TOOL_MCP_SERVER_NAME, taskKind: 'DreamingTask', toolNames: ['curate_context'],
        ctx: { db, taskRunId: id, providerAttemptCaller: 'api', providerSessionDeadlineAt: Date.now() + 120_000,
          callerActor: { kind: 'agent', ref: 'dreaming' }, causedByEventId: id, derivationPolicy: 'allow' } })],
    });
    const rows = await db.select().from(event).where(and(eq(event.action, CONTEXT_CHANGE),
      // The tool and runner share this server-issued run id.
      eq(event.actor_ref, 'learner')));
    const changes = rows.filter(r => (r.payload as { task_run_id?: string }).task_run_id === id).map(r => {
      const p = r.payload as { before: { topics: unknown[] }; after: { topics: unknown[] }; version: number };
      return { status: 'changed', change_id: r.id, version: p.version, before: p.before.topics, after: p.after.topics, issues: [] };
    });
    return Response.json(ContextEditResponse.parse({ reply: result.text, changes }));
  } catch (err) { return errorResponse(err); }
}
