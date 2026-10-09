import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { AgentNotesQuerySchema, AgentNotesResponseSchema } from '../api/contracts';
import { GET } from '../api/notes';
import { loadAgentNoteBoard } from './note-board-read';
import type { AgentNoteBoardRow } from './notes';

const mocks = vi.hoisted(() => ({
  read: vi.fn<typeof import('./notes').readAgentNoteBoardRows>(),
}));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('./notes', () => ({ readAgentNoteBoardRows: mocks.read }));

const now = new Date('2026-10-09T12:34:56.789Z');
const ref = {
  kind: 'future-evidence-kind',
  id: '证据/α',
  label: '相关证据',
  resolution_state: 'unknown' as const,
  provenance: { excerpts: ['保留原文、歧义与换行。\n'.repeat(200)], alternatives: [null, false] },
};
const row = {
  id: 'note_α',
  created_at: new Date('2026-10-08T23:59:59.001Z'),
  target_agents: ['maintenance', 'research_meeting'],
  source_task_kind: 'verification/中文',
  source_task_run_id: 'run_original',
  refs: [ref],
  summary_md: '# 观察\n条件不足 ≠ 错误，保留混合语言 α🙂。\n'.repeat(200),
  signal_kind: 'future_signal',
  confidence: 0,
  expires_at: new Date(now.getTime() + 1).toISOString(),
  caused_by_event_id: 'event_original',
  future_optional: { raw: [null, 0, { text: '不可丢失' }] },
} satisfies AgentNoteBoardRow & { future_optional: unknown };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  mocks.read.mockReset().mockResolvedValue([row]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function getNotes(limit?: string) {
  const query = limit === undefined ? '' : `?limit=${encodeURIComponent(limit)}`;
  return GET(new Request(`http://localhost/api/agents/notes${query}`));
}

describe('shared learner board read and HTTP handler', () => {
  it('uses the supplied database and clock, preserves all fields and matches original JSON bytes', async () => {
    const supplied = new Proxy(db, {});
    const board = await loadAgentNoteBoard(supplied, {}, now);
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(supplied, { now, limit: undefined });
    expect(board).toEqual({ rows: [{ ...row, created_at: row.created_at.toISOString() }] });
    expect(JSON.stringify(board)).toBe(JSON.stringify({ rows: [row] }));
    expect(board.rows[0].refs).toEqual([ref]);
    expect(row.created_at).toBeInstanceOf(Date);
    expect(AgentNotesResponseSchema.parse(board)).toEqual(board);
    mocks.read.mockClear();
    const response = await getNotes();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify(board));
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(db, { now, limit: undefined });
  });

  it.each([20, 50, 200])(
    'accepts limit %i through the same public and HTTP boundary',
    async (limit) => {
      await loadAgentNoteBoard(db, { limit }, now);
      expect(mocks.read).toHaveBeenLastCalledWith(db, { now, limit });
      const response = await getNotes(String(limit));
      expect(response.status).toBe(200);
      expect(mocks.read).toHaveBeenLastCalledWith(db, { now, limit });
    },
  );

  it.each(['0', '-1', '201', '1.5', 'banana', ''])(
    'rejects %j before any read and keeps the original validation body',
    async (limit) => {
      const result = AgentNotesQuerySchema.safeParse({ limit });
      if (result.success) throw new Error('invalid test input accepted');
      const message = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      await expect(loadAgentNoteBoard(db, { limit }, now)).rejects.toMatchObject({
        code: 'validation_error',
        status: 400,
        message,
      });
      const response = await getNotes(limit);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'validation_error', message });
      expect(mocks.read).not.toHaveBeenCalled();
    },
  );

  it('returns empty rows and samples the HTTP clock before an asynchronous read', async () => {
    mocks.read.mockImplementation(async () => {
      vi.setSystemTime(new Date(now.getTime() + 60_000));
      return [];
    });
    const response = await getNotes();
    expect(await response.json()).toEqual({ rows: [] });
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(db, { now, limit: undefined });
  });

  it('propagates reader failures and keeps HTTP error sanitization', async () => {
    const failure = new Error('private SQL and credentials');
    mocks.read.mockRejectedValue(failure);
    await expect(loadAgentNoteBoard(db, {}, now)).rejects.toBe(failure);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await getNotes();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'internal_error',
      message: 'Internal Server Error',
    });
    expect(log).toHaveBeenCalledOnce();
  });

  it('preserves typed reader errors and their headers', async () => {
    mocks.read.mockRejectedValue(
      new ApiError('read_unavailable', 'Try later', 503, { 'Retry-After': '30' }),
    );
    const response = await getNotes();
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('30');
    expect(await response.json()).toEqual({ error: 'read_unavailable', message: 'Try later' });
  });
});
