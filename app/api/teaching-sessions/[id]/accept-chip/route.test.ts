// P5.6 / YUK-178 — AC-5: POST .../accept-chip writes AcceptSuggestionChip with
// source_event_id per ADR-0011 §2.1; the event-table chip-KPI reader excludes
// corrective and counts proactive; the endpoint returns 409 when the session
// has ended.

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { event } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { getChipAcceptKpi } from '@/server/proposals/chip-signals';
import { Conversation } from '@/server/session';

import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { POST } from './route';

function chipReq(id: string, body: unknown) {
  return new Request(`http://localhost/api/teaching-sessions/${id}/accept-chip`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

async function paramsFor(id: string) {
  return Promise.resolve({ id });
}

// Seed an agent teach_message so resolveSourceEventId has an anchor (ADR-0011
// §2.1: explain for proactive, ask_check/tool_use for corrective).
async function seedAgentMessage(
  sessionId: string,
  turnKind: 'explain' | 'ask_check',
): Promise<string> {
  const db = testDb();
  const id = createId();
  await writeEvent(db, {
    id,
    session_id: sessionId,
    actor_kind: 'agent',
    actor_ref: 'TeachingTurnTask',
    action: 'experimental:teach_message',
    subject_kind: 'event',
    subject_id: id,
    outcome: 'success',
    payload: { role: 'agent', text_md: 'hi', turn_kind: turnKind },
  });
  return id;
}

describe('POST /api/teaching-sessions/[id]/accept-chip (AC-5, §5.2)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes a proactive AcceptSuggestionChip; KPI reader counts it', async () => {
    const db = testDb();
    const { sessionId } = await Conversation.startConversation(db, { learningItemId: 'li_chip_a' });
    const explainId = await seedAgentMessage(sessionId, 'explain');

    const res = await POST(
      chipReq(sessionId, { suggestion_kind: 'proactive', chip_label: '出题考我' }),
      { params: paramsFor(sessionId) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; event_id: string };
    expect(json.ok).toBe(true);

    const rows = await db.select().from(event).where(eq(event.id, json.event_id));
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('accept_suggestion');
    expect(rows[0].subject_kind).toBe('chip');
    expect(rows[0].payload).toMatchObject({
      suggestion_kind: 'proactive',
      chip_label: '出题考我',
      source_event_id: explainId, // ADR-0011 §2.1 — explain event for proactive
    });

    const kpi = await getChipAcceptKpi(db);
    expect(kpi.proactive_accept_count).toBe(1);
  });

  it('writes a corrective AcceptSuggestionChip anchored to the tool_use/ask_check event; KPI reader EXCLUDES it', async () => {
    const db = testDb();
    const { sessionId } = await Conversation.startConversation(db, { learningItemId: 'li_chip_b' });
    // both kinds present: corrective must anchor to the ask_check (tool_use) one
    await seedAgentMessage(sessionId, 'explain');
    const askId = await seedAgentMessage(sessionId, 'ask_check');

    const res = await POST(
      chipReq(sessionId, { suggestion_kind: 'corrective', chip_label: '重做 / 回看前置' }),
      { params: paramsFor(sessionId) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { event_id: string };

    const rows = await db.select().from(event).where(eq(event.id, json.event_id));
    expect(rows[0].payload).toMatchObject({
      suggestion_kind: 'corrective',
      source_event_id: askId, // ADR-0011 §2.1 — tool_use event for corrective
    });

    // ND-SK-3: the corrective chip-accept IS a full event...
    expect(rows[0].action).toBe('accept_suggestion');
    // ...but §5.2 / LD-1: it is excluded from the acceptance KPI.
    const kpi = await getChipAcceptKpi(db);
    expect(kpi.proactive_accept_count).toBe(0);
    const corrective = kpi.by_kind.find((k) => k.suggestion_kind === 'corrective');
    expect(corrective?.count).toBe(1);
  });

  it('mixed proactive + corrective: only proactive counts toward the metric', async () => {
    const db = testDb();
    const { sessionId } = await Conversation.startConversation(db, { learningItemId: 'li_chip_c' });
    await seedAgentMessage(sessionId, 'explain');
    await seedAgentMessage(sessionId, 'ask_check');

    await POST(chipReq(sessionId, { suggestion_kind: 'proactive', chip_label: 'p1' }), {
      params: paramsFor(sessionId),
    });
    await POST(chipReq(sessionId, { suggestion_kind: 'proactive', chip_label: 'p2' }), {
      params: paramsFor(sessionId),
    });
    await POST(chipReq(sessionId, { suggestion_kind: 'corrective', chip_label: 'c1' }), {
      params: paramsFor(sessionId),
    });

    const kpi = await getChipAcceptKpi(db);
    expect(kpi.proactive_accept_count).toBe(2);
  });

  it('folds a missing suggestion_kind into the single proactive by_kind bucket (P5.6 regression)', async () => {
    // A legacy / raw-inserted accept_suggestion row may lack suggestion_kind. It
    // must collapse into the SAME proactive bucket as explicit-proactive rows —
    // before the COALESCE-in-GROUP-BY fix, by_kind surfaced two distinct
    // 'proactive' entries (the NULL group + the 'proactive' group).
    const db = testDb();
    const baseRow = (payload: Record<string, unknown>) => ({
      id: createId(),
      actor_kind: 'user' as const,
      actor_ref: 'self',
      action: 'accept_suggestion',
      subject_kind: 'chip',
      subject_id: createId(),
      outcome: 'success',
      payload,
    });
    await db
      .insert(event)
      .values(
        baseRow({ suggestion_kind: 'proactive', chip_label: 'explicit', source_event_id: 'e1' }),
      );
    await db.insert(event).values(baseRow({ chip_label: 'legacy', source_event_id: 'e2' }));

    const kpi = await getChipAcceptKpi(db);
    const proactiveEntries = kpi.by_kind.filter((k) => k.suggestion_kind === 'proactive');
    expect(proactiveEntries).toHaveLength(1);
    expect(proactiveEntries[0].count).toBe(2);
    expect(kpi.proactive_accept_count).toBe(2);
  });

  it('honors an explicit source_event_id when it is a valid agent teach_message in the session', async () => {
    const db = testDb();
    const { sessionId } = await Conversation.startConversation(db, { learningItemId: 'li_chip_d' });
    const explicitId = await seedAgentMessage(sessionId, 'explain');

    const res = await POST(
      chipReq(sessionId, {
        suggestion_kind: 'proactive',
        chip_label: '我懂了',
        source_event_id: explicitId,
      }),
      { params: paramsFor(sessionId) },
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { event_id: string };
    const rows = await db.select().from(event).where(eq(event.id, json.event_id));
    expect(rows[0].payload).toMatchObject({ source_event_id: explicitId });
  });

  it('rejects an explicit source_event_id from a different session (P5.6 regression)', async () => {
    // foreignId is a valid agent teach_message, but in ANOTHER session — a stale
    // client must not be able to anchor a counted accept_suggestion to it.
    const db = testDb();
    const { sessionId: otherSession } = await Conversation.startConversation(db, {
      learningItemId: 'li_chip_foreign',
    });
    const foreignId = await seedAgentMessage(otherSession, 'explain');
    const { sessionId } = await Conversation.startConversation(db, {
      learningItemId: 'li_chip_d2',
    });
    await seedAgentMessage(sessionId, 'explain');

    const res = await POST(
      chipReq(sessionId, {
        suggestion_kind: 'proactive',
        chip_label: '我懂了',
        source_event_id: foreignId,
      }),
      { params: paramsFor(sessionId) },
    );
    expect(res.status).toBe(400);

    const rows = await db.select().from(event).where(eq(event.session_id, sessionId));
    expect(rows.filter((r) => r.action === 'accept_suggestion')).toHaveLength(0);
  });

  it('does not write the chip event when the materialized proposal accept fails (P5.6 regression)', async () => {
    // Seed a VALID anchor so isValidAnchorEvent passes and execution actually
    // reaches the accept→write ordering (a bogus source_event_id would 400 first
    // and never exercise the reorder). proposal_id points at a nonexistent
    // proposal → acceptAiProposal throws BEFORE writeEvent (P0-B order). The chip
    // event must NOT be persisted (and so must not reach getChipAcceptKpi),
    // otherwise a failing accept + client retry double-counts the §5.1 KPI.
    // Reverting the reorder to writeEvent-first makes this test fail.
    const db = testDb();
    const { sessionId } = await Conversation.startConversation(db, {
      learningItemId: 'li_chip_atomic',
    });
    const explainId = await seedAgentMessage(sessionId, 'explain');

    const res = await POST(
      chipReq(sessionId, {
        suggestion_kind: 'proactive',
        chip_label: '出题考我',
        source_event_id: explainId,
        proposal_id: 'prop_does_not_exist',
      }),
      { params: paramsFor(sessionId) },
    );
    expect(res.status).not.toBe(200);

    const rows = await db.select().from(event).where(eq(event.session_id, sessionId));
    const chipEvents = rows.filter((r) => r.action === 'accept_suggestion');
    expect(chipEvents).toHaveLength(0);
  });

  it('returns 409 when the session has ended (assertActive, no resume side-effect — PIN 9)', async () => {
    const db = testDb();
    const { sessionId } = await Conversation.startConversation(db, { learningItemId: 'li_chip_e' });
    await seedAgentMessage(sessionId, 'explain');
    await Conversation.endConversation(db, sessionId);

    const res = await POST(
      chipReq(sessionId, { suggestion_kind: 'proactive', chip_label: '出题考我' }),
      { params: paramsFor(sessionId) },
    );
    expect(res.status).toBe(409);
  });

  it('returns 404 for a nonexistent session', async () => {
    const res = await POST(
      chipReq('no_such_session', { suggestion_kind: 'proactive', chip_label: 'x' }),
      { params: paramsFor('no_such_session') },
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 on an invalid suggestion_kind', async () => {
    const db = testDb();
    const { sessionId } = await Conversation.startConversation(db, { learningItemId: 'li_chip_f' });
    const res = await POST(chipReq(sessionId, { suggestion_kind: 'mystery', chip_label: 'x' }), {
      params: paramsFor(sessionId),
    });
    expect(res.status).toBe(400);
  });
});
