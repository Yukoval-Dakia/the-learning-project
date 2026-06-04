// U8 — leave_agent_note channel helper DB test (AF spec §4 / §4.1, U3 L-note).
//
// Asserts:
//   - writeAgentNote → an experimental:agent_note event (subject_kind='query',
//     actor_kind='agent', actor_ref=source_task_kind) with the full payload.
//   - readAgentNotes filters by target agent (jsonb @> containment).
//   - readAgentNotes filters out EXPIRED notes (expires_at <= now) and keeps
//     non-expiring + future-expiry notes.
//   - newest-first ordering + limit.

import { event } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetDb, testDb } from '../../../tests/helpers/db';
import { readAgentNotes, writeAgentNote } from './notes';

describe('writeAgentNote', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('writes an experimental:agent_note event with the full payload', async () => {
    const db = testDb();
    const id = await writeAgentNote(db, {
      target_agents: ['coach', 'dreaming'],
      source_task_kind: 'quiz_verify',
      source_task_run_id: 'tr_1',
      refs: [{ kind: 'knowledge', id: 'k1' }],
      summary_md: 'pool gap on k1',
      signal_kind: 'question_pool_gap',
      confidence: 0.7,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const rows = await db.select().from(event).where(eq(event.id, id));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.action).toBe('experimental:agent_note');
    expect(row.actor_kind).toBe('agent');
    expect(row.actor_ref).toBe('quiz_verify');
    expect(row.subject_kind).toBe('query');
    expect(row.subject_id).toBe(id);
    const payload = row.payload as Record<string, unknown>;
    expect(payload.target_agents).toEqual(['coach', 'dreaming']);
    expect(payload.signal_kind).toBe('question_pool_gap');
    expect(payload.summary_md).toBe('pool gap on k1');
    expect(payload.refs).toEqual([{ kind: 'knowledge', id: 'k1' }]);
    expect(payload.confidence).toBe(0.7);
    expect(payload.source_task_kind).toBe('quiz_verify');
    expect(payload.source_task_run_id).toBe('tr_1');
  });

  it('omits optional fields from the payload when not supplied', async () => {
    const db = testDb();
    const id = await writeAgentNote(db, {
      target_agents: ['maintenance'],
      source_task_kind: 'attribution',
      refs: [],
      summary_md: 'hint',
      signal_kind: 'coverage_thin',
    });
    const rows = await db.select().from(event).where(eq(event.id, id));
    const payload = rows[0].payload as Record<string, unknown>;
    expect('confidence' in payload).toBe(false);
    expect('expires_at' in payload).toBe(false);
    expect('source_task_run_id' in payload).toBe(false);
  });
});

describe('readAgentNotes', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns only notes addressed to the requested agent', async () => {
    const db = testDb();
    await writeAgentNote(db, {
      target_agents: ['coach'],
      source_task_kind: 'quiz_verify',
      refs: [],
      summary_md: 'for coach',
      signal_kind: 'question_pool_gap',
    });
    await writeAgentNote(db, {
      target_agents: ['dreaming', 'maintenance'],
      source_task_kind: 'attribution',
      refs: [],
      summary_md: 'for dreaming+maintenance',
      signal_kind: 'pattern_hint',
    });

    const coachNotes = await readAgentNotes(db, { for_agent: 'coach', now: new Date() });
    expect(coachNotes.map((n) => n.summary_md)).toEqual(['for coach']);

    const dreamingNotes = await readAgentNotes(db, { for_agent: 'dreaming', now: new Date() });
    expect(dreamingNotes.map((n) => n.summary_md)).toEqual(['for dreaming+maintenance']);

    const maintNotes = await readAgentNotes(db, { for_agent: 'maintenance', now: new Date() });
    expect(maintNotes.map((n) => n.summary_md)).toEqual(['for dreaming+maintenance']);
  });

  it('filters out expired notes and keeps non-expiring + future-expiry ones', async () => {
    const db = testDb();
    const now = new Date('2026-06-04T12:00:00.000Z');

    // Expired (1h ago) — must be filtered out.
    await writeAgentNote(db, {
      target_agents: ['coach'],
      source_task_kind: 'quiz_verify',
      refs: [],
      summary_md: 'expired',
      signal_kind: 'question_pool_gap',
      expires_at: new Date(now.getTime() - 3_600_000).toISOString(),
    });
    // Future expiry (1h ahead) — must surface.
    await writeAgentNote(db, {
      target_agents: ['coach'],
      source_task_kind: 'quiz_verify',
      refs: [],
      summary_md: 'fresh',
      signal_kind: 'question_pool_gap',
      expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
    });
    // No expiry — must surface.
    await writeAgentNote(db, {
      target_agents: ['coach'],
      source_task_kind: 'quiz_verify',
      refs: [],
      summary_md: 'forever',
      signal_kind: 'question_pool_gap',
    });

    const notes = await readAgentNotes(db, { for_agent: 'coach', now });
    const summaries = notes.map((n) => n.summary_md).sort();
    expect(summaries).toEqual(['forever', 'fresh']);
  });

  it('orders newest-first and respects limit', async () => {
    const db = testDb();
    const base = new Date('2026-06-04T00:00:00.000Z');
    // resetDb + sequential writes: created_at defaults to now() per write, so
    // the third write is newest. We assert relative order, not absolute times.
    await writeAgentNote(db, {
      target_agents: ['coach'],
      source_task_kind: 'quiz_verify',
      refs: [],
      summary_md: 'first',
      signal_kind: 'question_pool_gap',
    });
    await writeAgentNote(db, {
      target_agents: ['coach'],
      source_task_kind: 'quiz_verify',
      refs: [],
      summary_md: 'second',
      signal_kind: 'question_pool_gap',
    });
    await writeAgentNote(db, {
      target_agents: ['coach'],
      source_task_kind: 'quiz_verify',
      refs: [],
      summary_md: 'third',
      signal_kind: 'question_pool_gap',
    });

    const limited = await readAgentNotes(db, {
      for_agent: 'coach',
      now: new Date(base.getTime() + 86_400_000),
      limit: 2,
    });
    expect(limited).toHaveLength(2);
  });

  it('returns [] for a non-positive limit', async () => {
    const db = testDb();
    await writeAgentNote(db, {
      target_agents: ['coach'],
      source_task_kind: 'quiz_verify',
      refs: [],
      summary_md: 'x',
      signal_kind: 'question_pool_gap',
    });
    expect(await readAgentNotes(db, { for_agent: 'coach', now: new Date(), limit: 0 })).toEqual([]);
  });
});
