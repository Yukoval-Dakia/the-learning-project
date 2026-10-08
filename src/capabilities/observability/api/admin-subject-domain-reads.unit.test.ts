import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import type { AdminSubjectListRow, TraitJournalRow } from '../public';
import { GET as subjectTraitsGet } from './admin-subject-traits';
import { getSubject, GET as subjectsGet } from './admin-subjects';
import { GET as journalGet } from './admin-trait-journal';
import { GET as traitsGet } from './admin-traits';

const reads = vi.hoisted(() => ({
  listAdminSubjects: vi.fn<typeof import('../public').listAdminSubjects>(),
  getAdminSubjectTraits: vi.fn<typeof import('../public').getAdminSubjectTraits>(),
  listAdminTraits: vi.fn<typeof import('../public').listAdminTraits>(),
  getTraitJournalPage: vi.fn<typeof import('../public').getTraitJournalPage>(),
}));
vi.mock('@/db/client', () => ({ db: { fixture: 'HTTP singleton handle' } }));
vi.mock('../public', () => reads);

const subject: AdminSubjectListRow = {
  id: 'retired',
  displayName: '化学与条件歧义',
  origin: 'custom',
  retiredAt: '2026-10-08T12:34:56.789Z',
  isGeneralFallback: false,
  version: 'jt:assembled',
  subjectRevision: 41,
  notation: 'latex',
  capabilityCount: 3,
};
const journal: TraitJournalRow = {
  revision: 7,
  action: 'rollback',
  actor: 'owner',
  payloadSchemaVersion: 2,
  seedVersion: null,
  sourceTraitId: 'source',
  sourceRevision: 3,
  rolledBackFrom: 9,
  changeSeq: 203,
  createdAt: '2026-10-08T12:34:56.789Z',
};

beforeEach(() => {
  vi.resetAllMocks();
  reads.listAdminSubjects.mockResolvedValue([subject]);
  reads.getAdminSubjectTraits.mockResolvedValue({ subjectRevision: 41, bindings: [] });
  reads.listAdminTraits.mockResolvedValue([]);
  reads.getTraitJournalPage.mockResolvedValue({ rows: [journal], next_cursor: 'bound-cursor' });
});
afterEach(() => vi.restoreAllMocks());

describe('HTTP delegation to the public subject/trait seam (mocked reads)', () => {
  it('uses list then find for subject detail and preserves the complete list/detail DTO', async () => {
    const list = await subjectsGet();
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ subjects: [subject] });
    const detail = await getSubject(new Request('http://x'), { id: 'retired' });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(subject);
    expect(reads.listAdminSubjects.mock.calls).toEqual([[db], [db]]);
    const missing = await getSubject(new Request('http://x'), { id: 'missing' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: 'not_found',
      message: 'subject missing not found',
    });
  });

  it('preserves empty collections and existing empty bindings', async () => {
    reads.listAdminSubjects.mockResolvedValue([]);
    reads.getTraitJournalPage.mockResolvedValue({ rows: [], next_cursor: null });
    expect(await (await subjectsGet()).json()).toEqual({ subjects: [] });
    const bindings = await subjectTraitsGet(new Request('http://x'), { id: '  existing  ' });
    expect(bindings.status).toBe(200);
    expect(await bindings.json()).toEqual({ subjectRevision: 41, bindings: [] });
    expect(reads.getAdminSubjectTraits).toHaveBeenCalledWith(db, 'existing');
    const traits = await traitsGet(new Request('http://x?kind=charter'));
    expect(traits.status).toBe(200);
    expect(await traits.json()).toEqual({ traits: [] });
    expect(reads.listAdminTraits).toHaveBeenCalledWith(db, 'charter');
    const page = await journalGet(new Request('http://x'), { id: 'empty' });
    expect(page.status).toBe(200);
    expect(await page.json()).toEqual({
      journal: [],
      next_cursor: null,
      data: [],
      page: { limit: 100, next_cursor: null },
    });
  });

  it.each(['', ' ', 'missing'])(
    'preserves subject params validation/missing contract for %j',
    async (id) => {
      reads.getAdminSubjectTraits.mockResolvedValue(null);
      const response = await subjectTraitsGet(new Request('http://x'), { id });
      expect(response.status).toBe(id === 'missing' ? 404 : 400);
      expect(await response.json()).toEqual({
        error: id === 'missing' ? 'unknown subject "missing"' : 'subject id is required',
      });
      expect(reads.getAdminSubjectTraits).toHaveBeenCalledTimes(id === 'missing' ? 1 : 0);
    },
  );

  it.each(['', ' ', 'missing'])(
    'preserves journal params validation/missing contract for %j',
    async (id) => {
      reads.getTraitJournalPage.mockResolvedValue(null);
      const response = await journalGet(new Request('http://x'), { id });
      expect(response.status).toBe(id === 'missing' ? 404 : 400);
      expect(await response.json()).toEqual({
        error: id === 'missing' ? 'unknown trait "missing"' : 'trait id is required',
      });
      expect(reads.getTraitJournalPage).toHaveBeenCalledTimes(id === 'missing' ? 1 : 0);
    },
  );

  it.each(['', '?kind=nope', '?kind=%20charter%20'])(
    'rejects invalid kind query %j before the read',
    async (query) => {
      const response = await traitsGet(new Request(`http://x${query}`));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error:
          'kind query is required (one of: charter, judge_policy, cause_taxonomy, source_policy, render_theme, scheduling)',
      });
      expect(reads.listAdminTraits).not.toHaveBeenCalled();
    },
  );

  it.each(['0', '-1', '1.5', 'nope', '', 'Infinity'])(
    'rejects invalid limit %j before the read',
    async (limit) => {
      const response = await journalGet(new Request(`http://x?limit=${limit}`), { id: 'trait' });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'limit must be a positive integer' });
      expect(reads.getTraitJournalPage).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['', 100, undefined],
    ['?limit=1&cursor=abc', 1, 'abc'],
    ['?limit=999', 200, undefined],
  ] as const)(
    'preserves journal default/cap/cursor and both envelopes for %j',
    async (query, limit, cursor) => {
      const response = await journalGet(new Request(`http://x${query}`), { id: ' trait ' });
      expect(response.status).toBe(200);
      expect(reads.getTraitJournalPage).toHaveBeenCalledWith(db, 'trait', { limit, cursor });
      expect(await response.json()).toEqual({
        journal: [journal],
        next_cursor: 'bound-cursor',
        data: [journal],
        page: { limit, next_cursor: 'bound-cursor' },
      });
    },
  );

  const consumers = [
    ['subjects', () => subjectsGet(), reads.listAdminSubjects],
    [
      'subject detail',
      () => getSubject(new Request('http://x'), { id: 'retired' }),
      reads.listAdminSubjects,
    ],
    [
      'bindings',
      () => subjectTraitsGet(new Request('http://x'), { id: 'subject' }),
      reads.getAdminSubjectTraits,
    ],
    ['catalog', () => traitsGet(new Request('http://x?kind=charter')), reads.listAdminTraits],
    [
      'journal',
      () => journalGet(new Request('http://x'), { id: 'trait' }),
      reads.getTraitJournalPage,
    ],
  ] as const;
  it.each(consumers)(
    '%s preserves generic errors without leaking SQL details',
    async (_, get, read) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      read.mockRejectedValue(new Error('private SQL detail'));
      const response = await get();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: 'internal_error',
        message: 'Internal Server Error',
      });
      expect(log).toHaveBeenCalled();
    },
  );
  it.each(consumers)('%s preserves structured errors and headers', async (_, get, read) => {
    read.mockRejectedValue(new ApiError('unavailable', 'try later', 503, { 'Retry-After': '7' }));
    const response = await get();
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('7');
    expect(await response.json()).toEqual({ error: 'unavailable', message: 'try later' });
  });

  it('preserves invalid-cursor public rejection as HTTP 400', async () => {
    reads.getTraitJournalPage.mockRejectedValue(
      new ApiError('invalid_cursor', 'invalid trait journal cursor: bound to another trait', 400),
    );
    const response = await journalGet(new Request('http://x?cursor=other'), { id: 'trait' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'invalid_cursor',
      message: 'invalid trait journal cursor: bound to another trait',
    });
  });
});
