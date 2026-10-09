import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { buildHonoApp } from '../app';
import { runAuthenticatedStartAgentNoteBoard } from './agent-note-read';
import { agentNoteBoard, agentNoteNow } from './agent-note-test-fixtures';

const seams = vi.hoisted(() => ({
  dbImport: vi.fn(),
  domainImport: vi.fn(),
  parse: vi.fn(),
  read: vi.fn(),
}));
vi.mock('@/db/client', () => ({
  get db() {
    seams.dbImport();
    return { name: 'injected-unit-db' };
  },
}));
vi.mock('@/capabilities/agency/public', async () => {
  seams.domainImport();
  const { AgentNotesQuerySchema } = await import('@/capabilities/agency/api/contracts');
  const { loadAgentNoteBoard } = await import('@/capabilities/agency/server/note-board-read');
  return {
    AgentNotesQuerySchema: {
      safeParse: (input: unknown) => {
        seams.parse(input);
        return AgentNotesQuerySchema.safeParse(input);
      },
    },
    loadAgentNoteBoard,
  };
});
vi.mock('@/capabilities/agency/server/notes', () => ({ readAgentNoteBoardRows: seams.read }));
const request = (token?: string) =>
  new Request('http://isolated.test/_serverFn/agent-note', {
    headers: token === undefined ? {} : { 'x-internal-token': token },
  });
const context = (runnable = true) => ({
  api: buildHonoApp([], {
    epochGate: async () =>
      runnable ? { runnable: true } : { runnable: false, reason: 'unavailable' },
  }),
});
async function denial(call: Promise<unknown>, status: number) {
  const result: unknown = await call.catch((error: unknown) => error);
  if (!(result instanceof Response)) throw new Error('Expected shaped response');
  expect(result.status).toBe(status);
  return result.json();
}
beforeEach(() => {
  vi.stubEnv('INTERNAL_TOKEN', 'unit-agent-note-token');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(agentNoteNow);
  vi.clearAllMocks();
  seams.read
    .mockReset()
    .mockResolvedValue(
      agentNoteBoard.rows.map((row) => ({ ...row, created_at: new Date(row.created_at) })),
    );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('Start agent-note read authorization and canonical reader', () => {
  it.each([undefined, '', 'wrong', 'unit-agent-note-token-extra'])(
    'denies token %s before parsing/imports/DB, including malformed input',
    async (token) => {
      const epochGate = vi.fn(async () => ({ runnable: true }));
      const ctx = { api: buildHonoApp([], { epochGate }) };
      await denial(
        runAuthenticatedStartAgentNoteBoard(ctx, request(token), { limit: 'invalid' }),
        401,
      );
      expect(epochGate).not.toHaveBeenCalled();
      expect(seams.parse).not.toHaveBeenCalled();
      expect(seams.domainImport).not.toHaveBeenCalled();
      expect(seams.dbImport).not.toHaveBeenCalled();
      expect(seams.read).not.toHaveBeenCalled();
    },
  );
  it('keeps fenced503 before parsing/imports/DB', async () => {
    expect(
      await denial(
        runAuthenticatedStartAgentNoteBoard(context(false), request('unit-agent-note-token'), {
          limit: 'invalid',
        }),
        503,
      ),
    ).toMatchObject({ error: 'contract_epoch_fenced', reason: 'unavailable' });
    expect(seams.parse).not.toHaveBeenCalled();
    expect(seams.domainImport).not.toHaveBeenCalled();
    expect(seams.dbImport).not.toHaveBeenCalled();
    expect(seams.read).not.toHaveBeenCalled();
  });
  it.each([{}, { limit: 20 }, { limit: 50 }, { limit: '200' }])(
    'uses injected Db, canonical limit and one clock for %j, preserves rich ISO DTO',
    async (input) => {
      const database = db;
      seams.dbImport.mockClear();
      const result = await runAuthenticatedStartAgentNoteBoard(
        context(),
        request('unit-agent-note-token'),
        input,
        { database, now: agentNoteNow },
      );
      expect(result).toEqual(agentNoteBoard);
      expect(JSON.stringify(result)).toBe(JSON.stringify(agentNoteBoard));
      expect(seams.read).toHaveBeenCalledExactlyOnceWith(database, {
        now: agentNoteNow,
        limit: input.limit === undefined ? undefined : Number(input.limit),
      });
      expect(seams.dbImport).not.toHaveBeenCalled();
    },
  );
  it('samples the default clock before asynchronous domain reading and preserves empty rows', async () => {
    seams.read.mockImplementation(async () => {
      vi.setSystemTime(new Date(agentNoteNow.getTime() + 60_000));
      return [];
    });
    expect(
      await runAuthenticatedStartAgentNoteBoard(context(), request('unit-agent-note-token'), {}),
    ).toEqual({ rows: [] });
    expect(seams.read.mock.calls[0][1].now).toEqual(agentNoteNow);
    expect(seams.dbImport).toHaveBeenCalledOnce();
  });
  it.each(['0', '-1', '201', '1.5', 'banana', ''])(
    'keeps canonical400 for %j before DB/selector',
    async (limit) => {
      const { AgentNotesQuerySchema } = await import('@/capabilities/agency/api/contracts');
      const parsed = AgentNotesQuerySchema.safeParse({ limit });
      if (parsed.success) throw new Error('Invalid fixture accepted');
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      expect(
        await denial(
          runAuthenticatedStartAgentNoteBoard(context(), request('unit-agent-note-token'), {
            limit,
          }),
          400,
        ),
      ).toEqual({ error: 'validation_error', message });
      expect(seams.dbImport).not.toHaveBeenCalled();
      expect(seams.read).not.toHaveBeenCalled();
    },
  );
  it('rejects a malformed object at the canonical boundary', async () => {
    const malformed = JSON.parse('null');
    expect(
      await denial(
        runAuthenticatedStartAgentNoteBoard(context(), request('unit-agent-note-token'), malformed),
        400,
      ),
    ).toMatchObject({ error: 'validation_error' });
    expect(seams.dbImport).not.toHaveBeenCalled();
    expect(seams.read).not.toHaveBeenCalled();
  });
  it('sanitizes selector failures in the Start bundle', async () => {
    seams.read.mockRejectedValueOnce(new Error('private SQL password=secret'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(
        await denial(
          runAuthenticatedStartAgentNoteBoard(context(), request('unit-agent-note-token'), {}),
          500,
        ),
      ).toEqual({ error: 'internal_error', message: 'Internal Server Error' });
    } finally {
      log.mockRestore();
    }
  });
});
