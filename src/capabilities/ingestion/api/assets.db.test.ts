import { source_asset } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { memR2 } from '../../../../tests/helpers/r2';
import { POST } from './assets';

// Inject in-memory R2 for all tests
const r2 = memR2();
vi.mock('@/server/r2', () => ({
  getR2: () => r2,
  createR2Client: () => r2,
}));

function makeFormData(file: File) {
  const fd = new FormData();
  fd.set('file', file);
  return fd;
}

function postRequest(formData: FormData) {
  return new Request('http://localhost/api/assets', {
    method: 'POST',
    body: formData,
  });
}

function pngFile(name = 'test.png', sizeBytes = 4) {
  return new File([new Uint8Array(sizeBytes).fill(0x89)], name, { type: 'image/png' });
}

describe('POST /api/assets', () => {
  beforeEach(async () => {
    r2._store.clear();
    await resetDb();
  });

  it('uploads PNG and writes source_asset row', async () => {
    const file = pngFile();
    const res = await POST(postRequest(makeFormData(file)));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      asset: {
        id: string;
        storage_key: string;
        mime_type: string;
        sha256: string;
        byte_size: number;
      };
    };
    expect(body.asset.id).toBeTruthy();
    expect(body.asset.storage_key).toMatch(/^assets\/[0-9a-f]{64}$/);
    expect(body.asset.mime_type).toBe('image/png');
    expect(body.asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.asset.byte_size).toBe(4);
    // R2 should have the object
    expect(r2._store.has(body.asset.storage_key)).toBe(true);
    // DB row exists
    const db = testDb();
    const rows = await db.select().from(source_asset).where(eq(source_asset.id, body.asset.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].sha256).toBe(body.asset.sha256);
  });

  it('returns 400 when file field is missing', async () => {
    const res = await POST(postRequest(new FormData()));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('returns 400 for unsupported mime type', async () => {
    const fd = new FormData();
    fd.set('file', new File(['text'], 'note.txt', { type: 'text/plain' }));
    const res = await POST(postRequest(fd));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/unsupported mime_type/);
  });

  it('returns 400 for oversized file', async () => {
    const big = new Uint8Array(9_000_000);
    const fd = new FormData();
    fd.set('file', new File([big], 'huge.png', { type: 'image/png' }));
    const res = await POST(postRequest(fd));
    expect(res.status).toBe(400);
  });

  it('accepts image/jpeg and image/webp', async () => {
    for (const mime of ['image/jpeg', 'image/webp']) {
      r2._store.clear();
      await resetDb();
      const fd = new FormData();
      fd.set('file', new File([new Uint8Array(4)], 'img', { type: mime }));
      const res = await POST(postRequest(fd));
      expect(res.status).toBe(201);
      const body = (await res.json()) as { asset: { mime_type: string } };
      expect(body.asset.mime_type).toBe(mime);
    }
  });

  it('storage key is content-addressed (same bytes same key)', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fd1 = new FormData();
    fd1.set('file', new File([bytes], 'a.png', { type: 'image/png' }));
    const res1 = await POST(postRequest(fd1));
    const body1 = (await res1.json()) as { asset: { storage_key: string } };

    await resetDb();
    r2._store.clear();

    const fd2 = new FormData();
    fd2.set('file', new File([bytes], 'b.png', { type: 'image/png' }));
    const res2 = await POST(postRequest(fd2));
    const body2 = (await res2.json()) as { asset: { storage_key: string } };

    expect(body1.asset.storage_key).toBe(body2.asset.storage_key);
  });
});
