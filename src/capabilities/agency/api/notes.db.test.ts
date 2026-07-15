// GET /api/agents/notes — unfiltered agent-notes feed (YUK-294, read-only board).

import { knowledge, question } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { writeAgentNote } from '../server/notes';
import { AgentNotesResponseSchema } from './contracts';
import { GET } from './notes';

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
    expect(() => AgentNotesResponseSchema.parse(body)).not.toThrow();
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

  it('adds human reference labels and current resolution without changing stored refs', async () => {
    const db = testDb();
    const now = new Date('2026-07-13T08:00:00Z');
    await db.insert(knowledge).values([
      {
        id: 'k_resolved',
        name: '二次函数·图像与性质',
        domain: 'math',
        created_at: now,
        updated_at: now,
      },
      {
        id: 'k_open',
        name: '现代文阅读·论证方法辨析',
        domain: 'yuwen',
        created_at: now,
        updated_at: now,
      },
    ]);
    await db.insert(question).values({
      id: 'q_active',
      kind: 'calculation',
      prompt_md: '求函数的顶点。',
      knowledge_ids: ['k_resolved'],
      difficulty: 3,
      source: 'test',
      draft_status: 'active',
      created_at: now,
      updated_at: now,
    });
    const resolvedNoteId = await writeAgentNote(db, {
      target_agents: ['coach'],
      source_task_kind: 'quiz_verify',
      refs: [{ kind: 'knowledge', id: 'k_resolved' }],
      summary_md: 'machine template',
      signal_kind: 'question_pool_gap',
    });
    const openNoteId = await writeAgentNote(db, {
      target_agents: ['coach'],
      source_task_kind: 'quiz_verify',
      refs: [{ kind: 'knowledge', id: 'k_open' }],
      summary_md: 'machine template',
      signal_kind: 'question_pool_gap',
    });

    const res = await getNotes();
    const body = (await res.json()) as {
      rows: Array<{
        id: string;
        refs: Array<{
          id: string;
          label: string;
          resolution_state: string;
          usable_question_count: number;
        }>;
      }>;
    };
    const resolved = body.rows.find((row) => row.id === resolvedNoteId)?.refs[0];
    const open = body.rows.find((row) => row.id === openNoteId)?.refs[0];
    expect(resolved).toMatchObject({
      id: 'k_resolved',
      label: '二次函数·图像与性质',
      resolution_state: 'resolved',
      usable_question_count: 1,
    });
    expect(open).toMatchObject({
      id: 'k_open',
      label: '现代文阅读·论证方法辨析',
      resolution_state: 'open',
      usable_question_count: 0,
    });
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
