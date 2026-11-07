import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memR2 } from '../../../../tests/helpers/r2';
import { setBackupConfigHydrator } from '../server/backup/config-hydrator';
import { POST } from './backup-import';

// The route fails closed without a hydrator; the guard cases below never reach the call.
setBackupConfigHydrator(async () => {});

// Inject in-memory R2 for all tests
const r2 = memR2();
vi.mock('@/kernel/object-storage', () => ({
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
    vi.unstubAllEnvs();
  });

  it('returns 400 when ?confirm is missing', async () => {
    const res = await POST(makePostRequest(new Uint8Array()));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('confirm_required');
  });

  // @invariant security: uploads above BACKUP_IMPORT_MAX_BYTES are refused before any byte is
  //   restored, so a giant or hostile archive cannot reach the destructive wipe path
  // @fails-if the declared-length pre-check or the mid-stream byte counter were dropped; a
  //   2 MB body under a 1 MB cap would stream into staging and the 413 assertion fails
  it('returns 413 for an oversized declared Content-Length without consuming the body', async () => {
    vi.stubEnv('BACKUP_IMPORT_MAX_BYTES', '1000000');
    const oversized = new Uint8Array(2_000_000);
    const req = new Request('http://localhost/api/_/import?confirm=wipe-and-reload', {
      method: 'POST',
      body: oversized.buffer as ArrayBuffer,
      headers: {
        'content-type': 'application/zip',
        'content-length': String(oversized.byteLength),
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('payload_too_large');
    expect(deleteCalls).toHaveLength(0);
  });

  // @invariant security: a chunked upload with no Content-Length is cut off the moment its
  //   counted bytes cross the cap, so smuggling size past the declared-length check fails
  // @fails-if the stream counter trusted the missing header and let the whole body through;
  //   the staged extractor would consume the oversized stream and the 413 assertion fails
  it('returns 413 mid-stream for an oversized chunked body', async () => {
    vi.stubEnv('BACKUP_IMPORT_MAX_BYTES', '1000000');
    const chunk = new Uint8Array(600_000);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 4; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const req = new Request('http://localhost/api/_/import?confirm=wipe-and-reload', {
      method: 'POST',
      body: stream,
      headers: { 'content-type': 'application/zip' },
      ...{ duplex: 'half' as const },
    });
    const res = await POST(req);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('payload_too_large');
    expect(deleteCalls).toHaveLength(0);
  });
});
