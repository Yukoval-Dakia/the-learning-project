import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentNotesResponseSchema } from '@/capabilities/agency/api/contracts';
import { GET } from '@/capabilities/agency/api/notes';
import {
  type AgentNoteBoardQuery,
  AgentNotesQuerySchema,
  loadAgentNoteBoard as canonicalLoadBoard,
} from '@/capabilities/agency/public';
import { readAgentNoteBoardRows } from '@/capabilities/agency/server/notes';
import type { Db, Tx } from '@/db/client';
import { event, knowledge, question } from '@/db/schema';
import { resetDb, testDb } from '../../tests/helpers/db';
import { buildHonoApp } from '../app';
import { runAuthenticatedStartAgentNoteBoard } from './agent-note-read';

// PREPARED ONLY. Parent must authorize DB execution under the runtime mutex.
// The real HTTP handler and Start reader receive the same caller database/transaction.
// These are in-process Request/Response tests, not live-network acceptance.
const scope = vi.hoisted((): { database?: Db | Tx } => ({}));
vi.mock('@/db/client', async () => {
  const { testDb } = await import('../../tests/helpers/db');
  return {
    get db() {
      return scope.database ?? testDb();
    },
  };
});

const now = new Date('2026-10-09T12:34:56.789Z');
const longText = '# 观察原文\n缺少条件 ≠ 已证实错误。α🙂\n'.repeat(200);
const provenance = {
  source: { run_id: 'run_distinct', original_event_id: 'event_original', excerpts: [longText] },
  alternatives: [null, false, { confidence: 0, reason: '歧义未决' }],
};
const rawRefs = [
  { kind: 'knowledge', id: 'k_resolved', provenance },
  { kind: 'knowledge', id: 'k_open' },
  { kind: 'knowledge', id: 'k_draft_only' },
  { kind: 'knowledge', id: 'k_missing' },
  { kind: 'question', id: 'q_active' },
  { kind: 'question', id: 'q_null' },
  { kind: 'question', id: 'q_future' },
  { kind: 'question', id: 'q_draft' },
  { kind: 'question', id: 'q_blank' },
  { kind: 'question', id: 'q_missing' },
  { kind: 'event', id: 'event_original' },
  { kind: 'note', id: 'note_missing' },
  { kind: 'artifact', id: 'artifact_missing' },
  { kind: 'future_ref', id: 'ref_unknown', extra: { nested: [null, '原件'] } },
];

function note(
  id: string,
  overrides: Partial<typeof event.$inferInsert> = {},
): typeof event.$inferInsert {
  return {
    id,
    actor_kind: 'agent',
    actor_ref: 'actor_fallback',
    action: 'experimental:agent_note',
    subject_kind: 'query',
    subject_id: id,
    created_at: now,
    payload: {
      target_agents: ['maintenance', 'research_meeting'],
      refs: rawRefs,
      summary_md: longText,
      signal_kind: 'future_signal',
      source_task_kind: 'source_distinct',
      source_task_run_id: 'run_distinct',
      confidence: 0,
      expires_at: new Date(now.getTime() + 1).toISOString(),
      caused_by_event_id: 'payload_cause_must_not_win',
      provenance,
    },
    caused_by_event_id: 'column_cause',
    task_run_id: 'run_distinct',
    ...overrides,
  };
}

async function fixture(database: Db | Tx) {
  await database.insert(knowledge).values(
    ['k_resolved', 'k_open', 'k_draft_only'].map((id) => ({
      id,
      name: `知识点 ${id}：条件与歧义`,
      domain: 'math',
      created_at: now,
      updated_at: now,
    })),
  );
  const questions: (typeof question.$inferInsert)[] = [
    { id: 'q_active', draft_status: 'active', knowledge_ids: ['k_resolved'] },
    { id: 'q_null', draft_status: null, knowledge_ids: ['k_resolved'] },
    { id: 'q_future', draft_status: 'future_status', knowledge_ids: ['k_resolved', 'k_missing'] },
    { id: 'q_draft', draft_status: 'draft', knowledge_ids: ['k_resolved', 'k_draft_only'] },
    { id: 'q_blank', draft_status: 'active', knowledge_ids: [], prompt_md: ' \n ' },
  ].map((row) => ({
    kind: 'calculation',
    prompt_md: `  ${longText}  `,
    difficulty: 3,
    source: 'test',
    created_at: now,
    updated_at: now,
    ...row,
  }));
  await database.insert(question).values(questions);
  await database.insert(event).values(note('rich_note'));
}

// Every public table, including outboxes and projections outside the source tables.
async function publicSnapshot(database: Db | Tx) {
  const tables = await database.execute<{ table_name: string }>(sql`
    select tablename as table_name from pg_tables where schemaname = 'public' order by tablename
  `);
  const snapshot: Record<string, { count: string; digest: string }> = {};
  for (const { table_name } of tables) {
    const rows = await database.execute<{ count: string; digest: string }>(sql`
      select count(*)::text as count,
        md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text, '[]')) as digest
      from ${sql.identifier(table_name)} t
    `);
    snapshot[table_name] = rows[0];
  }
  return snapshot;
}

function getNotes(limit?: string) {
  const query = limit === undefined ? '' : `?limit=${encodeURIComponent(limit)}`;
  return GET(new Request(`http://localhost/api/agents/notes${query}`));
}

async function loadAgentNoteBoard(database: Db | Tx, input: AgentNoteBoardQuery, clock: Date) {
  const context = { api: buildHonoApp([], { epochGate: async () => ({ runnable: true }) }) };
  const request = new Request('http://isolated.test/_serverFn/agent-note', {
    headers: { 'x-internal-token': 'isolated-agent-note-token' },
  });
  const result = await runAuthenticatedStartAgentNoteBoard(context, request, input, {
    database,
    now: clock,
  });
  expect(result).toEqual(await canonicalLoadBoard(database, input, clock));
  return result;
}

beforeEach(async () => {
  vi.stubEnv('INTERNAL_TOKEN', 'isolated-agent-note-token');
  scope.database = undefined;
  await resetDb();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.unstubAllEnvs();
  scope.database = undefined;
  vi.useRealTimers();
});

describe('authenticated Start board reader on a real caller database', () => {
  it('reads nonzero uncommitted notes and every enrichment through Tx, writes nothing, then rolls back', async () => {
    const database = testDb();
    const initial = await publicSnapshot(database);
    const rollback = new Error('intentional fixture rollback');
    await expect(
      database.transaction(async (tx) => {
        await fixture(tx);
        scope.database = tx;
        const before = await publicSnapshot(tx);
        expect(before.event.count).toBe('1');
        expect(before.knowledge.count).toBe('3');
        expect(before.question.count).toBe('5');
        expect(await loadAgentNoteBoard(database, {}, now)).toEqual({ rows: [] });
        expect(await database.select().from(knowledge)).toEqual([]);
        expect(await database.select().from(question)).toEqual([]);

        const board = await loadAgentNoteBoard(tx, {}, now);
        expect(board.rows).toHaveLength(1);
        expect(board.rows[0]).toMatchObject({
          id: 'rich_note',
          created_at: now.toISOString(),
          target_agents: ['maintenance', 'research_meeting'],
          source_task_kind: 'source_distinct',
          source_task_run_id: 'run_distinct',
          caused_by_event_id: 'column_cause',
          confidence: 0,
          expires_at: new Date(now.getTime() + 1).toISOString(),
          summary_md: longText,
          signal_kind: 'future_signal',
        });
        const refs = new Map(board.rows[0].refs.map((ref) => [ref.id, ref]));
        expect(refs.get('k_resolved')).toEqual({
          ...rawRefs[0],
          label: '知识点 k_resolved：条件与歧义',
          resolution_state: 'resolved',
          usable_question_count: 3,
        });
        for (const id of ['k_open', 'k_draft_only'])
          expect(refs.get(id)).toMatchObject({
            label: `知识点 ${id}：条件与歧义`,
            resolution_state: 'open',
            usable_question_count: 0,
          });
        expect(refs.get('k_missing')).toMatchObject({
          label: '未命名知识点',
          resolution_state: 'unknown',
          usable_question_count: 0,
        });
        for (const id of ['q_active', 'q_null', 'q_future'])
          expect(refs.get(id)).toMatchObject({
            label: longText.trim().slice(0, 48),
            resolution_state: 'resolved',
          });
        expect(refs.get('q_draft')?.resolution_state).toBe('open');
        expect(refs.get('q_blank')).toMatchObject({
          label: '相关题目',
          resolution_state: 'resolved',
        });
        expect(refs.get('q_missing')).toMatchObject({
          label: '相关题目',
          resolution_state: 'unknown',
        });
        for (const id of ['event_original', 'note_missing', 'artifact_missing', 'ref_unknown']) {
          expect(refs.get(id)?.resolution_state).toBe('unknown');
        }
        expect(refs.get('event_original')?.label).toBe('事件证据');
        expect(refs.get('note_missing')?.label).toBe('相关笔记');
        expect(refs.get('artifact_missing')?.label).toBe('相关笔记');
        expect(refs.get('ref_unknown')).toEqual({
          ...rawRefs[13],
          label: '相关证据',
          resolution_state: 'unknown',
        });
        const raw = await readAgentNoteBoardRows(tx, { now });
        expect(JSON.stringify(board)).toBe(JSON.stringify({ rows: raw }));
        expect(AgentNotesResponseSchema.parse(board)).toEqual(board);
        const response = await getNotes();
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(JSON.stringify(board));
        expect((await tx.select().from(event))[0].payload).toEqual(note('rich_note').payload);
        expect(await publicSnapshot(tx)).toEqual(before);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    scope.database = undefined;
    expect(await database.select().from(event).where(eq(event.id, 'rich_note'))).toEqual([]);
    expect(await database.select().from(knowledge)).toEqual([]);
    expect(await database.select().from(question)).toEqual([]);
    expect(await loadAgentNoteBoard(database, {}, now)).toEqual({ rows: [] });
    expect(await publicSnapshot(database)).toEqual(initial);
  });

  it('keeps strict expiry, source fallbacks, no-expiry optional keys and stable created_at/id ordering', async () => {
    const database = testDb();
    const payload = { target_agents: [], refs: [], summary_md: longText };
    await database.insert(event).values([
      note('a_forever', { payload, caused_by_event_id: null }),
      note('z_future', {
        payload: { ...payload, expires_at: new Date(now.getTime() + 1).toISOString() },
      }),
      note('newest', { payload, created_at: new Date(now.getTime() + 1) }),
      note('expired', {
        payload: { ...payload, expires_at: new Date(now.getTime() - 1).toISOString() },
      }),
      note('at_boundary', { payload: { ...payload, expires_at: now.toISOString() } }),
      note('wrong_action', { payload, action: 'experimental:other' }),
      note('wrong_subject', { payload, subject_kind: 'question' }),
    ]);
    const before = await publicSnapshot(database);
    const board = await loadAgentNoteBoard(database, {}, now);
    expect(board.rows.map((row) => row.id)).toEqual(['newest', 'z_future', 'a_forever']);
    expect(board.rows[2]).toEqual({
      id: 'a_forever',
      created_at: now.toISOString(),
      target_agents: [],
      refs: [],
      source_task_kind: 'actor_fallback',
      summary_md: longText,
      signal_kind: 'unknown',
    });
    expect(await (await getNotes()).text()).toBe(JSON.stringify(board));
    expect(
      (await loadAgentNoteBoard(database, {}, new Date(now.getTime() + 1))).rows.map(
        (row) => row.id,
      ),
    ).toEqual(['newest', 'a_forever']);
    expect(await publicSnapshot(database)).toEqual(before);
  });

  it('retains default 20, Today 20, agency 50 and maximum 200 without clamping', async () => {
    const database = testDb();
    await database.insert(event).values(
      Array.from({ length: 205 }, (_, index) =>
        note(`note_${String(index).padStart(3, '0')}`, {
          payload: {
            target_agents: index % 2 ? ['coach'] : ['maintenance'],
            refs: [],
            summary_md: `${index}:${longText}`,
          },
        }),
      ),
    );
    const before = await publicSnapshot(database);
    for (const limit of [undefined, 20, 50, 200]) {
      const board = await loadAgentNoteBoard(database, { limit }, now);
      const expected = limit ?? 20;
      expect(board.rows.map((row) => row.id)).toEqual(
        Array.from(
          { length: expected },
          (_, index) => `note_${String(204 - index).padStart(3, '0')}`,
        ),
      );
      const response = await getNotes(limit === undefined ? undefined : String(limit));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(JSON.stringify(board));
    }
    for (const limit of ['0', '-1', '201', '1.5', 'text']) {
      const parsed = AgentNotesQuerySchema.safeParse({ limit });
      if (parsed.success) throw new Error('invalid test input accepted');
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      const denied: unknown = await loadAgentNoteBoard(database, { limit }, now).catch(
        (error: unknown) => error,
      );
      if (!(denied instanceof Response)) throw new Error('Expected shaped validation response');
      expect(denied.status).toBe(400);
      expect(await denied.json()).toEqual({ error: 'validation_error', message });
      const response = await getNotes(limit);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'validation_error', message });
    }
    expect(await publicSnapshot(database)).toEqual(before);
  });

  it('returns the same empty DTO for the public entry and real handler', async () => {
    const database = testDb();
    const before = await publicSnapshot(database);
    expect(await loadAgentNoteBoard(database, {}, now)).toEqual({ rows: [] });
    const response = await getNotes();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rows: [] });
    expect(await publicSnapshot(database)).toEqual(before);
  });
});
