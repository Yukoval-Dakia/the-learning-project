import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memR2 } from '../../../../tests/helpers/r2';
import { POST } from './backup-import';

// Inject in-memory R2 for all tests
const r2 = memR2();
vi.mock('@/server/r2', () => ({
  getR2: () => r2,
  createR2Client: () => r2,
}));

// Track DB calls: DELETE and INSERT statements
const deleteCalls: string[] = [];
const insertCalls: Array<{ table: string; rows: unknown[] }> = [];
const setvalCalls: string[] = [];

type QueryChunk = { value?: string[] } | { queryChunks?: QueryChunk[] };

function extractFullSql(query: unknown): string {
  if (typeof query === 'object' && query !== null) {
    const q = query as { queryChunks?: QueryChunk[] };
    if (Array.isArray(q.queryChunks)) {
      return q.queryChunks
        .map((chunk) => {
          if (!chunk || typeof chunk !== 'object') return '';
          const c = chunk as { value?: string[]; queryChunks?: QueryChunk[] };
          if (Array.isArray(c.value)) return c.value.join('');
          if (c.queryChunks) return extractFullSql(c);
          return '';
        })
        .join('');
    }
  }
  return String(query);
}

vi.mock('@/db/client', () => {
  // Single execute implementation shared by the outer `db` AND the `tx` handed to
  // db.transaction(cb). restoreFromArchive runs its entire wipe+insert sequence inside
  // `await db.transaction(async (tx) => {...})` using `tx.execute`, so the mock must
  // expose `transaction` (else `db.transaction is not a function` throws and restore
  // returns 500). Routing tx.execute through the SAME spy keeps the DELETE/INSERT
  // tracking arrays populated for the assertions below (YUK-355 atomicity follow-up).
  const execute = vi.fn(async (query: unknown) => {
    const sqlStr = extractFullSql(query);
    if (/delete from/i.test(sqlStr)) {
      deleteCalls.push(sqlStr.trim());
    } else if (/insert into/i.test(sqlStr)) {
      insertCalls.push({ table: sqlStr, rows: [] });
    } else if (/setval/i.test(sqlStr)) {
      setvalCalls.push(sqlStr.trim());
    }
    return [];
  });
  return {
    db: {
      execute,
      transaction: vi.fn(async (cb: (tx: { execute: typeof execute }) => unknown) =>
        cb({ execute }),
      ),
    },
  };
});

function makePostRequest(body: Uint8Array, qs = '') {
  return new Request(`http://localhost/api/_/import${qs}`, {
    method: 'POST',
    body: body.buffer as ArrayBuffer,
    headers: { 'content-type': 'application/zip' },
  });
}

describe('POST /api/_/import — guards', () => {
  beforeEach(() => {
    deleteCalls.length = 0;
    insertCalls.length = 0;
    r2._store.clear();
  });

  it('returns 400 when ?confirm is missing', async () => {
    const res = await POST(makePostRequest(new Uint8Array()));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('confirm_required');
  });

  it('returns 400 when ?confirm has wrong value', async () => {
    const res = await POST(makePostRequest(new Uint8Array(), '?confirm=please'));
    expect(res.status).toBe(400);
  });
});
