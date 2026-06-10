// GET /api/agents/notes — unfiltered agent-notes feed (YUK-294, read-only board).

import { writeAgentNote } from '@/capabilities/agent-notes/server/notes';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './route';

async function getNotes(qs = ''): Promise<Response> {
  return GET(
    new Request(`http://localhost/api/agents/notes${qs ? `?${qs}` : ''}`, { method: 'GET' }),
  );
}

describe('GET /api/agents/notes', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns every un-expired note (no for_agent filter), newest-first', async () => {
    const db = testDb();
    await writeAgentNote(db, {
      target_agents: ['coach'],
      source_task_kind: 'quiz_verify',
      refs: [],
      summary_md: 'first',
      signal_kind: 'question_pool_gap',
    });
    await writeAgentNote(db, {
      target_agents: ['dreaming', 'maintenance'],
      source_task_kind: 'attribution',
      refs: [],
      summary_md: 'second',
      signal_kind: 'pattern_hint',
    });

    const res = await getNotes();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ summary_md: string }> };
    expect(body.rows.map((r) => r.summary_md)).toEqual(['second', 'first']);
  });

  it('honours the limit query param', async () => {
    const db = testDb();
    for (const summary of ['a', 'b', 'c']) {
      await writeAgentNote(db, {
        target_agents: ['coach'],
        source_task_kind: 'quiz_verify',
        refs: [],
        summary_md: summary,
        signal_kind: 'question_pool_gap',
      });
    }
    const res = await getNotes('limit=2');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(2);
  });

  it('400s on a non-numeric limit', async () => {
    const res = await getNotes('limit=banana');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('400s on a non-positive limit', async () => {
    const res = await getNotes('limit=0');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('returns an empty rows array when there are no notes', async () => {
    const res = await getNotes();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });
});
