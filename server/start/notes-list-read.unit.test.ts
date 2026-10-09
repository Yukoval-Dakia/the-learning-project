import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/capabilities/notes/api/notes-list';
import { db } from '@/db/client';
import { buildHonoApp } from '../app';
import { runAuthenticatedStartNoteList } from './notes-list-read';
import { noteList } from './notes-list-test-fixtures';

const seams = vi.hoisted(() => ({
  domainImport: vi.fn(),
  dbImport: vi.fn(),
  parse: vi.fn(),
  resolve: vi.fn(),
  list: vi.fn(),
}));
vi.mock('@/db/client', () => ({
  get db() {
    seams.dbImport();
    return { name: 'unit-db' };
  },
}));
vi.mock('@/kernel/read-models/knowledge-tree', () => ({
  resolveSubjectKnowledgeIds: seams.resolve,
}));
vi.mock('@/capabilities/notes/server/notes-read', () => ({ listNotes: seams.list }));
vi.mock('@/capabilities/notes/public', async () => {
  seams.domainImport();
  const { NoteListQuerySchema } = await import('@/capabilities/notes/api/contracts');
  const { loadNoteList } = await import('@/capabilities/notes/server/note-list-read');
  return {
    loadNoteList,
    NoteListQuerySchema: {
      safeParse(input: unknown) {
        seams.parse(input);
        return NoteListQuerySchema.safeParse(input);
      },
    },
  };
});
const context = (runnable = true) => ({
  api: buildHonoApp([], {
    epochGate: async () =>
      runnable ? { runnable: true } : { runnable: false, reason: 'unavailable' },
  }),
});
const request = (token?: string) =>
  new Request('http://isolated.test/_serverFn/notes', {
    headers: token === undefined ? {} : { 'x-internal-token': token },
  });
async function failure(call: Promise<unknown>, status: number) {
  const result: unknown = await call.catch((error: unknown) => error);
  if (!(result instanceof Response)) throw new Error('Expected real Response');
  expect(result.status).toBe(status);
  return result.json();
}
beforeEach(() => {
  vi.stubEnv('INTERNAL_TOKEN', 'notes-token');
  vi.clearAllMocks();
  seams.resolve.mockReset().mockResolvedValue([]);
  seams.list
    .mockReset()
    .mockImplementation(async (_db, ids) => (ids?.length === 0 ? [] : noteList.rows));
});
afterEach(() => vi.unstubAllEnvs());

describe('Start notes list auth and shared HTTP orchestration', () => {
  it.each([undefined, '', 'wrong', 'notes-token-extra'])(
    'denies %s before parse/import/read',
    async (token) => {
      const epochGate = vi.fn(async () => ({ runnable: true }));
      await failure(
        runAuthenticatedStartNoteList(
          { api: buildHonoApp([], { epochGate }) },
          request(token),
          JSON.parse('null'),
        ),
        401,
      );
      for (const seam of Object.values(seams)) expect(seam).not.toHaveBeenCalled();
      expect(epochGate).not.toHaveBeenCalled();
    },
  );
  it('fences503 before parse/import/read even with malformed input', async () => {
    expect(
      await failure(
        runAuthenticatedStartNoteList(context(false), request('notes-token'), JSON.parse('null')),
        503,
      ),
    ).toMatchObject({ error: 'contract_epoch_fenced', reason: 'unavailable' });
    for (const seam of Object.values(seams)) expect(seam).not.toHaveBeenCalled();
  });
  it.each([
    { subject: '' },
    { subject: '  ' },
    { query: '' },
    { query: ' \n ' },
    { query: 'x'.repeat(201) },
  ])('preserves exact HTTP400 body for %j before DB/resolver', async (input) => {
    expect(
      await failure(runAuthenticatedStartNoteList(context(), request('notes-token'), input), 400),
    ).toEqual({ error: 'validation_error' });
    expect(seams.dbImport).not.toHaveBeenCalled();
    expect(seams.resolve).not.toHaveBeenCalled();
    expect(seams.list).not.toHaveBeenCalled();
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(input))
      if (value !== undefined) params.set(key, value);
    const response = await GET(new Request(`http://isolated.test/api/notes?${params}`));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'validation_error' });
  });
  it.each([null, [], { subject: 42 }, { query: { nested: 'bad' } }])(
    'rejects malformed %j before DB',
    async (input) => {
      expect(
        await failure(
          runAuthenticatedStartNoteList(
            context(),
            request('notes-token'),
            JSON.parse(JSON.stringify(input)),
          ),
          400,
        ),
      ).toEqual({ error: 'validation_error' });
      expect(seams.dbImport).not.toHaveBeenCalled();
      expect(seams.list).not.toHaveBeenCalled();
    },
  );
  it('retains no-filter, full ISO DTO, and the injected database', async () => {
    const database = db;
    seams.dbImport.mockClear();
    const result = await runAuthenticatedStartNoteList(
      context(),
      request('notes-token'),
      {},
      { database },
    );
    expect(result).toEqual(noteList);
    expect(seams.resolve).not.toHaveBeenCalled();
    expect(seams.list).toHaveBeenCalledExactlyOnceWith(database, undefined, undefined);
    expect(seams.dbImport).not.toHaveBeenCalled();
    expect(await (await GET(new Request('http://isolated.test/api/notes'))).text()).toBe(
      JSON.stringify(result),
    );
  });
  it.each(['unknown', 'custom-science', 'wenyan'])(
    'keeps resolver-owned subject %s and empty sets',
    async (subject) => {
      expect(
        await runAuthenticatedStartNoteList(context(), request('notes-token'), { subject }),
      ).toEqual({ rows: [] });
      expect(seams.resolve).toHaveBeenCalledWith(expect.anything(), subject);
      expect(seams.list).toHaveBeenCalledWith(expect.anything(), [], undefined);
      seams.resolve.mockResolvedValueOnce(['parent', 'inherited-child']);
      expect(
        await runAuthenticatedStartNoteList(context(), request('notes-token'), {
          subject,
          query: '  %_\\ α🙂  ',
        }),
      ).toEqual(noteList);
      expect(seams.list).toHaveBeenLastCalledWith(
        expect.anything(),
        ['parent', 'inherited-child'],
        '%_\\ α🙂',
      );
    },
  );
  it('accepts exactly200 trimmed query characters unchanged', async () => {
    const query = '🙂'.repeat(100);
    await runAuthenticatedStartNoteList(context(), request('notes-token'), {
      query: `  ${query}  `,
    });
    expect(seams.list).toHaveBeenCalledWith(expect.anything(), undefined, query);
  });
  it('shapes domain errors in the ESM reader without private SQL disclosure', async () => {
    seams.list.mockRejectedValueOnce(new Error('password=secret'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(
        await failure(runAuthenticatedStartNoteList(context(), request('notes-token'), {}), 500),
      ).toEqual({ error: 'internal_error', message: 'Internal Server Error' });
    } finally {
      log.mockRestore();
    }
  });
});
