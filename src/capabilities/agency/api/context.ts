import { and, eq } from 'drizzle-orm';
import { piDomainMount, piToolWireName } from '@/ai/pi-tool-mount';
import { resolveTaskBudget } from '@/capabilities/task-registry';
import { classifyCrisisExpression, crisisTemplateForClass } from '@/core/crisis/classify';
import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError, errorResponse } from '@/kernel/http';
import { DOMAIN_TOOL_MCP_SERVER_NAME } from '@/kernel/tools/allowlists';
import { runAgentTask } from '@/server/ai/runner';
import {
  CONTEXT_CHANGE,
  ChangeReceipt,
  ChangeResult,
  LEARNER_EDIT_RULES,
} from '../context/topic-contract';
import { changeTopics, readTopics, topicBoard } from '../context/topics';
import { ContextActionRequest, ContextEditRequest, ContextEditResponse } from '../context/wire';

export async function GET() {
  try {
    const board = await topicBoard(db);
    return Response.json({
      ...board,
      changes: board.changes.map((c) => {
        const p = c.payload as {
          before: { topics: unknown[] };
          after: { topics: unknown[] };
          undo_of?: string | null;
        };
        if (c.restricted)
          return {
            id: c.id,
            at: c.at.toISOString(),
            removed: true,
            before: [],
            after: [],
            undo_of: null,
          };
        return {
          id: c.id,
          at: c.at.toISOString(),
          removed: false,
          before: p.before.topics,
          after: p.after.topics,
          undo_of: p.undo_of ?? null,
        };
      }),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
export async function ACTION(req: Request) {
  try {
    const parsed = ContextActionRequest.safeParse(await req.json());
    if (!parsed.success)
      throw new ApiError('context_action_invalid', 'invalid action request', 400);
    const input = parsed.data;
    if (
      (input.op === 'undo' && !input.change_id) ||
      (input.op === 'withdraw_topic' && !input.topic_key)
    )
      throw new ApiError('context_action_invalid', 'action target missing', 400);
    return Response.json(
      await changeTopics(db, {
        expectedVersion: input.expected_version,
        actor: 'learner',
        taskRunId: newId(),
        sourceIds: [],
        ...(input.op === 'undo' ? { undoId: input.change_id } : { withdrawKey: input.topic_key }),
      }),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
export async function EDIT(req: Request) {
  try {
    const input = ContextEditRequest.parse(await req.json());
    const crisis = classifyCrisisExpression(input.instruction);
    if (crisis !== 'none')
      return Response.json({
        status: 'unchanged',
        reply: crisisTemplateForClass(crisis).text_md,
        changes: [],
        remaining_changes: [],
      });
    if (input.derivation_policy !== 'allow')
      return Response.json({
        status: 'unchanged',
        reply: '这句话不会存入长期记忆。',
        changes: [],
        remaining_changes: [],
      });
    const current = await readTopics(db);
    if (input.expected_version !== current.version)
      return Response.json({ error: 'context_version_conflict' }, { status: 409 });
    const id = newId();
    await writeEvent(db, {
      id,
      action: 'experimental:context_edit_request',
      actor_kind: 'user',
      actor_ref: 'self',
      subject_kind: 'query',
      subject_id: id,
      payload: input,
      affected_scopes: [],
      ingest_at: new Date(),
    });
    let writeFailure = false;
    let writeCommitted = false;
    let scopeRejections = 0;
    let repairAttempts = 0;
    let remainingChanges: string[] = [];
    try {
      await runAgentTask(
        'DreamingTask',
        {
          ...current,
          instruction: input.instruction,
          topic_key: input.topic_key,
          mode: 'learner_correction',
          contract: `立即执行学习者修改，写 correction；不要只回复建议。${LEARNER_EDIT_RULES}回复只说改了什么。`,
        },
        {
          db,
          taskRunId: id,
          allowedTools: [piToolWireName(DOMAIN_TOOL_MCP_SERVER_NAME, 'curate_context')],
          piToolMounts: [
            piDomainMount({
              serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
              taskKind: 'DreamingTask',
              toolNames: ['curate_context'],
              beforeExecute: () =>
                writeFailure || writeCommitted
                  ? 'Finish this turn without further writes.'
                  : undefined,
              onResult: (observation) => {
                // The write tool answers with a receipt, never a digest echo.
                const change = ChangeReceipt.safeParse(observation.output);
                if (observation.error_reason || !observation.executed || !change.success) {
                  writeFailure = true;
                  return;
                }
                if (change.data.status === 'changed') {
                  writeCommitted = true;
                  remainingChanges = change.data.remaining_changes;
                } else {
                  if (change.data.issues.some((i) => i.kind === 'edit_scope_exceeded'))
                    scopeRejections++;
                  if (
                    change.data.status === 'issue' &&
                    change.data.issues.every(
                      (i) => i.kind === 'edit_scope_exceeded' || i.kind === 'unmergeable',
                    ) &&
                    repairAttempts++ === 0
                  ) {
                    // Rejected batches are atomic; allow one corrected proposal, never a second commit.
                    return;
                  }
                  writeFailure = true;
                }
              },
              ctx: {
                db,
                taskRunId: id,
                providerAttemptCaller: 'api',
                // Same budget as the DreamingTask run; a fixed shorter window
                // fails deep query_context reads while the run continues.
                providerSessionDeadlineAt: Date.now() + resolveTaskBudget('DreamingTask').timeout,
                callerActor: { kind: 'agent', ref: 'dreaming' },
                causedByEventId: id,
                derivationPolicy: 'allow',
              },
            }),
          ],
        },
      );
    } catch {
      // A provider/report failure cannot erase a tool commit. The ledger decides the response.
      writeFailure = true;
    }
    const rows = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, CONTEXT_CHANGE),
          // The tool and runner share this server-issued run id.
          eq(event.actor_ref, 'learner'),
        ),
      );
    const changes = rows
      .filter((r) => (r.payload as { task_run_id?: string }).task_run_id === id)
      .map((r) => {
        const p = r.payload as {
          before: { topics: unknown[] };
          after: { topics: unknown[] };
          version: number;
          remaining_changes?: string[];
          request_complete?: boolean;
        };
        return ChangeResult.parse({
          status: 'changed',
          change_id: r.id,
          version: p.version,
          before: p.before.topics,
          after: p.after.topics,
          issues: [],
          remaining_changes: p.remaining_changes ?? [],
          request_complete: p.request_complete ?? false,
        });
      });
    if (!changes.length && !scopeRejections)
      throw new ApiError(
        'context_edit_not_committed',
        '更正未完成，请重新读取当前画像后再试。',
        409,
        undefined,
        { version: (await readTopics(db)).version, changes },
      );
    remainingChanges = [
      ...new Set([...remainingChanges, ...changes.flatMap((c) => c.remaining_changes)]),
    ];
    const partial =
      writeFailure ||
      scopeRejections > 0 ||
      remainingChanges.length > 0 ||
      !changes.length ||
      !changes.every((change) => change.request_complete);
    const applied = changes.flatMap((change) =>
      change.after.flatMap((topic) => {
        const before = change.before.find((old) => old.key === topic.key);
        return topic.facts
          .filter(
            (fact) => !before?.facts.some((old) => old.id === fact.id && old.body === fact.body),
          )
          .map((fact) => `${topic.name}：${fact.body}`);
      }),
    );
    const reply = [
      !changes.length
        ? '这次没有保存更正。'
        : partial
          ? '这次仅保存了以下更正：'
          : '已保存以下更正：',
      ...applied,
      ...(partial ? ['其余要求尚未保存或未确认，请对照改动记录。'] : []),
      ...remainingChanges.map((item) => `尚未保存：${item}`),
    ].join('\n');
    return Response.json(
      ContextEditResponse.parse({
        status: partial ? 'partial' : 'changed',
        reply,
        changes,
        remaining_changes: remainingChanges,
      }),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
