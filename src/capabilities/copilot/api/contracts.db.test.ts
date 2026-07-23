import { event, learning_session } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST as acceptChip } from './accept-chip';
import {
  AcceptTeachingChipResponseSchema,
  CopilotCheckpointRevertErrorSchema,
  CopilotCheckpointRevertSuccessSchema,
  CopilotSummaryResponseSchema,
  CopilotTurnsResponseSchema,
} from './contracts';
import { GET as getCopilotSummary } from './copilot-summary';
import { GET as getCopilotTurns } from './turns';

describe('Copilot declared route response contracts', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('parses reverted and already-reverted checkpoint envelopes (200 = success-only)', () => {
    expect(
      CopilotCheckpointRevertSuccessSchema.parse({
        ok: true,
        status: 'already_reverted',
        checkpoint_event_id: 'ask_1',
        compensation_event_ids: [],
      }),
    ).toMatchObject({ status: 'already_reverted' });
    // YUK-497 wave-2 — the 200 schema is success-only; a refusal (ok:false) never occurs at 200 and
    // must be REJECTED by it. Refusals ride the 404/409 error schema instead (asserted below).
    expect(() =>
      CopilotCheckpointRevertSuccessSchema.parse({
        ok: false,
        refusal: 'irreversible',
        reason: 'unsupported effect',
        irreversible_event_ids: ['tool_1'],
      }),
    ).toThrow();
    expect(
      CopilotCheckpointRevertErrorSchema.parse({
        ok: false,
        refusal: 'irreversible',
        reason: 'unsupported effect',
        irreversible_event_ids: ['tool_1'],
      }),
    ).toMatchObject({ refusal: 'irreversible', irreversible_event_ids: ['tool_1'] });
  });

  it('parses the snake_case reverted sub-object and the 404/409 error union (review F3/F7)', () => {
    // F7 — the success envelope's reverted counters are snake_case on the wire.
    expect(
      CopilotCheckpointRevertSuccessSchema.parse({
        ok: true,
        status: 'reverted',
        checkpoint_event_id: 'ask_1',
        compensation_event_ids: ['c1'],
        reverted: {
          snapshots_restored: 1,
          structural_rows_archived: 0,
          event_layer_compensated: 2,
          total_nodes: 3,
        },
      }),
    ).toMatchObject({ reverted: { total_nodes: 3 } });
    // F3 — 404/409 admit BOTH the route's ApiError body and the cascade refusal envelope.
    expect(
      CopilotCheckpointRevertErrorSchema.parse({ error: 'turn_not_terminal', message: 'x' }),
    ).toMatchObject({ error: 'turn_not_terminal' });
    expect(
      CopilotCheckpointRevertErrorSchema.parse({
        ok: false,
        refusal: 'no_checkpoint',
        reason: 'nothing to revert',
      }),
    ).toMatchObject({ refusal: 'no_checkpoint' });
    // F4 — the refusal envelope's optional sub-objects are snake_case (conflict_ref.*).
    expect(
      CopilotCheckpointRevertErrorSchema.parse({
        ok: false,
        refusal: 'conflict',
        reason: 'state moved',
        conflict_ref: { kind: 'theta', subject_kind: 'knowledge', subject_id: 'kc_1' },
      }),
    ).toMatchObject({ conflict_ref: { subject_id: 'kc_1' } });
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
