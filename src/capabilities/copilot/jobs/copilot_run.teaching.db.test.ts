import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeCopilotInputEvent } from '@/capabilities/copilot/server/conversation-writes';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
} from '@/capabilities/copilot/server/copilot-run-status';
import type { TeachingSkillResult } from '@/capabilities/copilot/server/skills/teaching-skill';
import { event, learning_item, question } from '@/db/schema';
import { computeReplay } from '@/server/events/sse_replay';
import { writeJobEvent } from '@/server/events/writer';
import { Conversation } from '@/server/session';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runCopilotRun, writeSuccessfulTerminalProjection } from './copilot_run';

const db = testDb();

async function acceptedTeachingTurn(kind: TeachingSkillResult['kind']) {
  const { sessionId } = await Conversation.findOrCreateCopilotConversation(db);
  const learningItemId = `teaching_item_${kind}`;
  await db.insert(learning_item).values({
    id: learningItemId,
    source: 'manual',
    title: '相似句式中的语法差异',
    content: '结合上下文区分“之”的动词、代词和结构助词用法，解释证据而不是只记译文。',
    knowledge_ids: [],
    child_learning_item_ids: [],
    status: 'pending',
    created_at: new Date(),
    updated_at: new Date(),
  });
  const message = '继续讲解这组含义不同的句子，保留语境；检查时请让我解释推理。';
  const runId = await writeCopilotInputEvent(db, {
    sessionId,
    userMessage: message,
    now: new Date(),
  });
  const text = '比较“送孟浩然之广陵”和“人之立志”中“之”的作用，说明判断依据。';
  const result: TeachingSkillResult = {
    kind,
    text_md: text,
    task_run_id: `teaching_attempt_${kind}`,
    suggested_next: kind === 'end' ? 'end' : 'continue',
    ...(kind === 'ask_check'
      ? {
          pendingQuestion: {
            sessionId,
            learningItemId,
            fallbackPromptMd: text,
            structured_question: {
              kind: 'short_answer' as const,
              prompt_md: text,
              reference_md: '前句是动词，后句是结构助词；结合后接成分和主谓关系说明。',
            },
          },
        }
      : {}),
  };
  return {
    result,
    data: {
      run_id: runId,
      session_id: sessionId,
      user_message: message,
      triggered_by: 'chat' as const,
      skill_context: {
        skill: 'teaching' as const,
        ref: { kind: 'learning_item', id: learningItemId },
      },
    },
  };
}

describe('unified worker teaching lifecycle', () => {
  beforeEach(resetDb);

  it.each(['explain', 'ask_check', 'end'] as const)(
    'preserves %s through commit, failed projection, repair and terminal replay',
    async (kind) => {
      const { data, result } = await acceptedTeachingTurn(kind);
      const teaching = vi.fn(async () => result);
      const freeForm = vi.fn(async () => {
        throw new Error('teaching must not enter free-form agent');
      });
      const projection = vi
        .fn()
        .mockRejectedValueOnce(new Error('lost terminal projection'))
        .mockImplementation(writeSuccessfulTerminalProjection);
      const params = {
        db,
        data,
        runTeachingSkillFn: teaching,
        executeCopilotTurnFn: freeForm,
        writeSuccessfulTerminalProjectionFn: projection,
      };
      await expect(runCopilotRun(params)).rejects.toThrow('terminal projection failed');
      const [reply] = await db
        .select()
        .from(event)
        .where(eq(event.caused_by_event_id, data.run_id));
      expect(reply).toMatchObject({ outcome: 'success', task_run_id: result.task_run_id });
      expect(reply.payload).toMatchObject({
        turn_kind: kind,
        skill_turn: { kind, suggested_next: result.suggested_next },
        skill_context: data.skill_context,
      });
      const materialized = await db.select().from(question);
      expect(materialized).toHaveLength(kind === 'ask_check' ? 1 : 0);
      if (kind === 'ask_check') expect(materialized[0].source_ref).toBe(reply.id);
      const repaired = await runCopilotRun(params);
      expect(repaired).toMatchObject({
        status: 'done',
        task_run_id: result.task_run_id,
        reply: result.text_md,
        skill_turn: { kind },
      });
      expect(await runCopilotRun(params)).toEqual(repaired);
      expect(teaching).toHaveBeenCalledTimes(1);
      expect(teaching).toHaveBeenCalledWith(
        expect.objectContaining({
          taskRunId: expect.stringContaining(data.run_id),
          signal: expect.any(AbortSignal),
        }),
      );
      expect(freeForm).not.toHaveBeenCalled();
      expect(await db.select().from(question)).toHaveLength(materialized.length);
      const events = await computeReplay(db, {
        businessTable: COPILOT_RUN_TABLE,
        businessId: data.run_id,
        lastEventId: 0,
      });
      const terminalReply = events.find((item) => item.event_type === COPILOT_RUN_EVENTS.REPLY);
      expect(terminalReply?.payload).toMatchObject({
        skill_turn: { kind },
        skill_context: data.skill_context,
      });
      if (kind === 'ask_check')
        expect(terminalReply?.payload).not.toHaveProperty('checkpoint_event_id');
    },
  );

  it('honors explicit Stop before a completed assessment can materialize', async () => {
    const { data, result } = await acceptedTeachingTurn('ask_check');
    const teaching = vi.fn(async () => {
      await writeJobEvent(db, {
        business_table: COPILOT_RUN_TABLE,
        business_id: data.run_id,
        event_type: COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
        payload: { by: 'user' },
      });
      return result;
    });
    const params = { db, data, runTeachingSkillFn: teaching };
    expect(await runCopilotRun(params)).toEqual({ status: 'cancelled' });
    expect(await runCopilotRun(params)).toEqual({ status: 'cancelled' });
    expect(teaching).toHaveBeenCalledTimes(1);
    expect(await db.select().from(question)).toHaveLength(0);
  });
});
