import { event, learning_session } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST as acceptChip } from './accept-chip';
import {
  AcceptTeachingChipResponseSchema,
  CopilotSummaryResponseSchema,
  CopilotTurnsResponseSchema,
} from './contracts';
import { GET as getCopilotSummary } from './copilot-summary';
import { GET as getCopilotTurns } from './turns';

describe('Copilot declared route response contracts', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('parses the real turns and today-summary route envelopes', async () => {
    const now = new Date();
    await testDb().insert(learning_session).values({
      id: 'copilot_session_1',
      type: 'conversation',
      status: 'active',
      entrypoint: 'copilot',
      updated_at: now,
    });
    await testDb()
      .insert(event)
      .values([
        {
          id: 'turn_user_1',
          session_id: 'copilot_session_1',
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'experimental:copilot_user_ask',
          subject_kind: 'query',
          subject_id: 'turn_user_1',
          payload: { user_message: '讲讲这道题' },
          created_at: new Date(now.getTime() - 1000),
        },
        {
          id: 'turn_reply_1',
          session_id: 'copilot_session_1',
          actor_kind: 'agent',
          actor_ref: 'agent:copilot',
          action: 'experimental:copilot_reply',
          subject_kind: 'query',
          subject_id: 'turn_reply_1',
          payload: {
            reply_md: '先看这个知识点。',
            skill_turn: {
              kind: 'ask_check',
              structured_question: {
                id: 'question_1',
                kind: 'single_choice',
                prompt_md: '选哪一个？',
                choices_md: ['A', 'B'],
              },
            },
            skill_context: { skill: 'teaching', ref: { kind: 'question', id: 'question_1' } },
            primary_view: {
              source: 'artifact',
              ref: { kind: 'question', id: 'question_1' },
            },
          },
          created_at: now,
        },
      ]);

    const turnsResponse = await getCopilotTurns(
      new Request('http://test/api/copilot/turns?limit=not-a-number'),
    );
    expect(turnsResponse.status).toBe(200);
    const turns = CopilotTurnsResponseSchema.parse(await turnsResponse.json());
    expect(turns.turns).toHaveLength(2);
    expect(turns.turns[1]).toMatchObject({
      role: 'ai',
      session_id: 'copilot_session_1',
      primary_view: { source: 'artifact' },
    });

    const summaryResponse = await getCopilotSummary();
    expect(summaryResponse.status).toBe(200);
    expect(CopilotSummaryResponseSchema.parse(await summaryResponse.json())).toMatchObject({
      daily_focus: expect.any(String),
      dreaming_preview: [],
      pending_proposals_total: 0,
    });
  });

  it('keeps the accept-chip anchor gate and parses its real success response', async () => {
    await testDb().insert(learning_session).values({
      id: 'session_1',
      type: 'conversation',
      status: 'active',
    });
    await testDb()
      .insert(event)
      .values({
        id: 'reply_1',
        session_id: 'session_1',
        actor_kind: 'agent',
        actor_ref: 'agent:copilot',
        action: 'experimental:copilot_reply',
        subject_kind: 'query',
        subject_id: 'reply_1',
        outcome: 'success',
        payload: { reply_md: '继续' },
      });

    const response = await acceptChip(
      new Request('http://test/api/teaching-sessions/session_1/accept-chip', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          suggestion_kind: 'proactive',
          chip_label: '继续',
          source_event_id: 'reply_1',
        }),
      }),
      { id: 'session_1' },
    );

    expect(response.status).toBe(200);
    const body = AcceptTeachingChipResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ ok: true, event_id: expect.any(String) });
    const rows = await testDb()
      .select({ id: event.id })
      .from(event)
      .where(eq(event.action, 'accept_suggestion'));
    expect(rows).toEqual([{ id: body.event_id }]);
  });
});
