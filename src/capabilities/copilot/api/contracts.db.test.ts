import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { event, learning_session } from '@/db/schema';
import { writeJobEvent } from '@/server/events/writer';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { writeCopilotUserAsk } from '../server/chat';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from '../server/copilot-run-status';
import { POST as acceptChip } from './accept-chip';
import {
  AcceptTeachingChipResponseSchema,
  CopilotCheckpointRevertErrorSchema,
  CopilotCheckpointRevertSuccessSchema,
  CopilotCreateSessionResponseSchema,
  CopilotSessionsResponseSchema,
  CopilotSummaryResponseSchema,
  CopilotTurnsResponseSchema,
} from './contracts';
import { GET as getCopilotSummary } from './copilot-summary';
import { POST as createCopilotSession, GET as getCopilotSessions } from './sessions';
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
    // E3 (TeA-6) — the discriminated union makes `reverted` STRUCTURALLY required for a fresh 'reverted'
    // (the old flat schema's `reverted?.optional()` let it be omitted). A 'reverted' body without the
    // counters is now rejected.
    expect(() =>
      CopilotCheckpointRevertSuccessSchema.parse({
        ok: true,
        status: 'reverted',
        checkpoint_event_id: 'ask_1',
        compensation_event_ids: ['c1'],
      }),
    ).toThrow();
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

  it('restores accepted work from the server without a browser run handle, ordered and session-scoped', async () => {
    const { session } = CopilotCreateSessionResponseSchema.parse(
      await (await createCopilotSession()).json(),
    );
    const { session: foreign } = CopilotCreateSessionResponseSchema.parse(
      await (await createCopilotSession()).json(),
    );
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      const sessionId = index === 4 ? foreign.id : session.id;
      const runId = await writeCopilotUserAsk(testDb(), {
        sessionId,
        userMessage: `第${index + 1}条：比较近期复习与延迟探针，区分已掌握和未验证的知识点；保持前一条执行，不要重复修改目标。`,
        // Deliberately reverse timestamps: acceptance order is dispatch_seq.
        now: new Date(Date.now() - index * 1000),
      });
      ids.push(runId);
      await writeJobEvent(testDb(), {
        business_table: COPILOT_RUN_TABLE,
        business_id: runId,
        event_type: COPILOT_RUN_EVENTS.QUEUED,
        payload: { session_id: sessionId, internal_evidence: 'private dispatch metadata' },
      });
    }
    for (const [index, eventType, payload] of [
      [0, COPILOT_RUN_EVENTS.DONE, {}],
      [1, COPILOT_RUN_EVENTS.EXECUTION_STARTED, {}],
      [1, COPILOT_RUN_EVENTS.FAILED, { reason: 'error' }],
      [2, COPILOT_RUN_EVENTS.CANCEL_REQUESTED, {}],
    ] as const) {
      await writeJobEvent(testDb(), {
        business_table: COPILOT_RUN_TABLE,
        business_id: ids[index],
        event_type: eventType,
        payload,
      });
    }
    const response = await getCopilotTurns(
      new Request(`http://test/api/copilot/turns?session_id=${session.id}`),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const snapshot = CopilotTurnsResponseSchema.parse(body);
    expect(snapshot.session_id).toBe(session.id);
    expect(snapshot.active_runs).toEqual([
      {
        run_id: ids[1],
        session_id: session.id,
        status: 'running',
        events_url: `/api/jobs/copilot_run/${ids[1]}/events`,
      },
      {
        run_id: ids[2],
        session_id: session.id,
        status: 'cancel_requested',
        events_url: `/api/jobs/copilot_run/${ids[2]}/events`,
      },
      {
        run_id: ids[3],
        session_id: session.id,
        status: 'queued',
        events_url: `/api/jobs/copilot_run/${ids[3]}/events`,
      },
    ]);
    expect(new Set(snapshot.turns.map((turn) => turn.event_id))).toEqual(new Set(ids.slice(0, 4)));
    expect(JSON.stringify(body)).not.toContain('private dispatch metadata');
    await writeJobEvent(testDb(), {
      business_table: COPILOT_RUN_TABLE,
      business_id: ids[1],
      event_type: COPILOT_RUN_EVENTS.DONE,
      payload: {},
    });
    const reopened = CopilotTurnsResponseSchema.parse(
      await (
        await getCopilotTurns(new Request(`http://test/api/copilot/turns?session_id=${session.id}`))
      ).json(),
    );
    expect(reopened.active_runs.map((run) => run.run_id)).toEqual(ids.slice(2, 4));
  });

  it('creates and lists Copilot sessions through the declared contracts', async () => {
    const createdResponse = await createCopilotSession();
    expect(createdResponse.status).toBe(201);
    const created = CopilotCreateSessionResponseSchema.parse(await createdResponse.json());

    const listedResponse = await getCopilotSessions();
    expect(listedResponse.status).toBe(200);
    const listed = CopilotSessionsResponseSchema.parse(await listedResponse.json());
    expect(listed.sessions).toContainEqual(created.session);
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
